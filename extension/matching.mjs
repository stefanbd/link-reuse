import { allowsLearning } from './learning.mjs';
import { urlRules, normalizedKey } from './url-rules.mjs';

function urlKey(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export async function permittedTabs(browser, query = {}) {
  if (!browser.runtime?.getURL?.('').startsWith('safari-web-extension:')) return browser.tabs.query(query);
  const { origins } = await browser.permissions.getAll();
  if (!origins.length) throw new Error('Allow Link Reuse website access in Safari Settings → Extensions to reuse tabs.');
  return browser.tabs.query({ ...query, url: origins });
}

export class LiveLearning {
  constructor(policy, rules = urlRules) {
    this.policy = policy; this.rules = rules; this.records = new Map(); this.settledURLs = new Map(); this.bytes = 0; this.revision = 0;
    // Tabs opened here whose address the browser has not reported yet: Safari lists a new tab without a URL (and has
    // no pendingUrl) until its navigation commits, so a rapid repeat would otherwise open the link again.
    this.created = new Map();
  }
  /** The tab with its requested URL standing in until the browser reports an address. */
  addressed(tab) {
    const url = tab && this.created.get(tab.id);
    return url && !urlKey(tab.pendingUrl || tab.url) ? { ...tab, pendingUrl: url } : tab;
  }
  async withCreated(tabs, browser) {
    if (!this.created.size) return tabs;
    const listed = new Set(tabs.map(tab => tab.id));
    const unlisted = await Promise.all([...this.created.keys()].filter(id => !listed.has(id)).map(id => browser.tabs.get(id).catch(() => null)));
    const all = [...tabs, ...unlisted.filter(tab => tab && !tab.incognito)];
    for (const id of this.created.keys()) {
      const tab = all.find(value => value.id === id);
      if (!tab || urlKey(tab.pendingUrl || tab.url)) this.created.delete(id);
    }
    return all.map(tab => this.addressed(tab));
  }
  rememberCreated(tabId, url) {
    if (!Number.isInteger(tabId)) return;
    this.created.set(tabId, url);
    if (this.created.size > 64) this.created.delete(this.created.keys().next().value);
  }
  resolve(value) {
    const original = urlKey(value);
    const direct = original ? this.rules(original, this.policy) : {};
    const target = urlKey(direct.target);
    const url = target || original;
    const format = target ? this.rules(target, this.policy) : direct;
    return { url, allowed: allowsLearning(url, this.policy), entry: format.entry, scope: format.scope, directEntry: direct.entry };
  }
  /**
   * A URL's match keys: its address, normalized address and identity, then those of every learned destination. They
   * depend only on the learned records, so each URL is worked out once per learning revision, however often pruning,
   * page keys and tab matching ask. Callers must not change the returned set.
   */
  keys(value) {
    if (this.keyCache?.revision !== this.revision) this.keyCache = { revision: this.revision, keys: new Map() };
    let keys = this.keyCache.keys.get(value);
    if (keys) return keys;
    keys = new Set();
    const pending = [urlKey(value)];
    while (pending.length && keys.size < 64) {
      const key = pending.pop();
      if (!key || keys.has(key)) continue;
      const normalized = normalizedKey(key, this.policy);
      keys.add(key);
      keys.add(normalized);
      const identity = this.rules(key, this.policy).identity;
      if (identity) keys.add(identity);
      for (const kind of ['redirect', 'canonical']) {
        const destination = this.records.get(kind + '\n' + normalized)?.destination;
        if (destination) pending.push(destination);
      }
    }
    this.keyCache.keys.set(value, keys);
    return keys;
  }
  equivalent(left, right) {
    const keys = this.keys(left);
    for (const key of this.keys(right)) if (keys.has(key)) return true;
    return false;
  }
  matches(request, tab) {
    if (!tab || tab.incognito || (!request.allowed && !request.entry)) return false;
    const value = tab.pendingUrl || tab.url;
    if (request.entry) {
      const current = this.resolve(value);
      return current.scope === request.entry && (allowsLearning(value, this.policy) || current.directEntry === request.entry ||
        this.records.get('launch\n' + tab.id)?.entry === request.entry);
    }
    return allowsLearning(value, this.policy) && this.equivalent(request.url, value);
  }
  rememberLaunch(tabId, request) {
    if (request.entry && Number.isInteger(tabId)) this.put('launch\n' + tabId, { tabId, entry: request.entry });
  }
  snapshot() {
    return [...this.records].map(([key, { bytes, ...record }]) => ({ kind: key.split('\n')[0], ...record }));
  }
  restore(records) {
    if (!Array.isArray(records)) return;
    for (const record of records.slice(-this.policy.maxRecords)) {
      if (!record || typeof record !== 'object') continue;
      if (record.kind === 'launch') {
        if (typeof record.entry === 'string' && record.entry.length <= this.policy.maxURLBytes) this.rememberLaunch(record.tabId, record);
      } else this.observe([record]);
    }
    this.restoredUnchecked = this.records.size > 0;
  }
  observe(records) {
    for (const record of records) {
      if (!['redirect', 'canonical'].includes(record.kind) || !allowsLearning(record.source, this.policy)) continue;
      const key = record.kind + '\n' + normalizedKey(record.source, this.policy);
      if (record.destination === null || !allowsLearning(record.destination, this.policy)) { this.remove(key); continue; }
      this.put(key, { source: urlKey(record.source), destination: urlKey(record.destination) });
    }
  }
  put(key, value) {
    this.remove(key);
    value.bytes = new TextEncoder().encode(JSON.stringify(value)).length + 32;
    this.records.set(key, value);
    this.bytes += value.bytes;
    this.revision++;
    while (this.records.size > this.policy.maxRecords || this.bytes > this.policy.maxCacheBytes) this.remove(this.records.keys().next().value);
  }
  prune(tabs) {
    this.restoredUnchecked = false;
    const live = new Set();
    const byId = new Map(tabs.map(tab => [tab.id, tab]));
    for (const id of this.settledURLs.keys()) if (!byId.has(id)) this.settledURLs.delete(id);
    for (const tab of tabs) if (!tab.incognito) {
      const url = tab.pendingUrl || tab.url;
      const previous = this.settledURLs.get(tab.id);
      if (tab.status === 'complete') {
        if (allowsLearning(url, this.policy)) this.settledURLs.set(tab.id, url);
        else this.settledURLs.delete(tab.id);
      }
      const candidates = tab.status === 'loading' ? [url, tab.url, previous] : [url];
      for (const candidate of candidates) if (allowsLearning(candidate, this.policy)) {
        for (const key of this.keys(candidate)) live.add(key);
      }
    }
    for (const [key, record] of this.records) {
      if (key.startsWith('launch\n')) {
        const tab = byId.get(record.tabId);
        if (!this.matches({ entry: record.entry }, tab)) this.remove(key);
        continue;
      }
      if (![...this.keys(record.destination)].some(value => live.has(value))) this.remove(key);
    }
  }
  remove(key) { const value = this.records.get(key); if (value) { this.bytes -= value.bytes; this.records.delete(key); this.revision++; } }
  clear() { if (this.records.size) this.revision++; this.records.clear(); this.settledURLs.clear(); this.bytes = 0; }
}

export async function routeToTab(url, learning, browser, windowFocusOrder = new Map(), opening = {}) {
  const [allWindows, source, listedTabs] = await Promise.all([
    browser.windows.getAll({ windowTypes: ['normal'] }),
    Number.isInteger(opening.sourceTabId) ? browser.tabs.get(opening.sourceTabId) : null,
    permittedTabs(browser, { windowType: 'normal' }),
  ]);
  const tabs = await learning.withCreated(listedTabs, browser);
  const windows = allWindows.filter(value => !value.incognito);
  if (source?.incognito) throw new Error('Private tab links are not supported.');
  const visible = windows.filter(value => value.state !== 'minimized');
  const candidates = visible.length ? visible : windows;
  let window = (source && windows.find(value => value.id === source.windowId)) || candidates.find(value => value.focused);
  if (!window && candidates.length === 1) window = candidates[0];
  if (!window && candidates.length > 1 && browser.windows.getLastFocused) {
    const lastFocused = await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    window = candidates.find(value => value.id === lastFocused?.id);
  }
  window ||= [...candidates].sort((left, right) => (windowFocusOrder.get(right.id) ?? 0) - (windowFocusOrder.get(left.id) ?? 0))[0];
  const activateWindow = id => windows.find(value => value.id === id)?.focused ? Promise.resolve() : browser.windows.update(id, {
    ...(windows.find(value => value.id === id)?.state === 'minimized' ? { state: 'normal' } : {}), focused: true,
  });
  // Every match is checked against a live tab, so routine pruning stays off this path (the bridge prunes
  // after each route). Restored learning is still checked against current tabs before its first match.
  if (learning.restoredUnchecked) learning.prune(tabs);
  const request = learning.resolve(url);
  // A same-tab link looks for another tab; its own tab would simply load it.
  const reusable = opening.reuseOnly ? tabs.filter(tab => tab.id !== source?.id) : tabs;
  const preferred = reusable.find(tab => tab.active && tab.windowId === window?.id);
  const match = (preferred && learning.matches(request, preferred) && preferred) ||
    reusable.find(tab => urlKey(tab.pendingUrl || tab.url) === request.url && learning.matches(request, tab)) ||
    reusable.find(tab => learning.matches(request, tab));
  if (match) {
    const current = learning.addressed(await browser.tabs.get(match.id));
    if (!learning.matches(request, current)) throw new Error('The matching tab changed. Please open the link again.');
    if (opening.deadline && opening.deadline <= Date.now()) throw new Error('The external request expired. Please open the link again.');
    // The match goes where the clicked page would have opened: beside its source, for a background click (which keeps
    // the source in front) and for a same-tab link. Chromium regroups a moved tab by its new neighbours, so it moves
    // only within its own group (or between ungrouped tabs); a pinned tab or one already in place stays. Safari has no
    // groupId.
    const beside = (opening.active === false || opening.reuseOnly) && source && current.id !== source.id &&
      (current.groupId ?? -1) === (source.groupId ?? -1);
    let place = null;
    if (beside) {
      const index = current.windowId === source.windowId && current.index < source.index ? source.index : source.index + 1;
      if (!current.pinned && !(current.windowId === source.windowId && current.index === index)) place = { windowId: source.windowId, index };
    }
    const move = () => browser.tabs.move(current.id, place).then(() => true, () => false);
    // A background click's whole action is the move; only a match that cannot move is focused instead.
    if (opening.active === false && beside && (!place || await move())) return { result: 'moved' };
    // Focus is the priority: a same-tab link's move goes out with it, never ahead of it, and the browser applies the
    // requests in order, so the selected tab still lands beside its source. A failed move never holds the focus up; a
    // match that failed to move into the source window has its own window brought forward instead.
    // For now a plain-click switch only focuses its match; moving it beside the source is to become an optional setting.
    // const moving = opening.reuseOnly && place ? move() : null;
    const moving = null;
    const windowId = moving ? place.windowId : current.windowId;
    await Promise.all([(current.active && !moving) || browser.tabs.update(match.id, { active: true }), activateWindow(windowId)]);
    if (moving && windowId !== current.windowId && !await moving) await activateWindow(current.windowId);
    return { result: 'focused' };
  }
  if (opening.reuseOnly) return { result: 'none' };
  const active = opening.active !== false;
  await opening.beforeCreate?.();
  if (opening.deadline && opening.deadline <= Date.now()) throw new Error('The external request expired. Please open the link again.');
  const created = window ? await browser.tabs.create({ windowId: window.id, url, active,
    ...(source?.windowId === window.id ? { index: source.index + 1 } : {}) }) :
    (await browser.windows.create({ url, incognito: false, type: 'normal', focused: true })).tabs?.[0];
  learning.rememberLaunch(created?.id, request);
  learning.rememberCreated(created?.id, url);
  if (window && active) await activateWindow(window.id);
  return { result: 'opened' };
}
