import { allowsLearning } from './learning.mjs';
import { urlRules, normalizedKey } from './url-rules.mjs';
import { isSafari } from './native-port.mjs';

function urlKey(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** Open tabs the extension may read. Safari lists only tabs on websites the user has granted. */
export async function permittedTabs(browser, query = {}) {
  if (!isSafari(browser)) return browser.tabs.query(query);
  const { origins } = await browser.permissions.getAll();
  if (!origins.length) {
    throw new Error('Allow Link Reuse website access in Safari Settings → Extensions to reuse tabs.');
  }
  return browser.tabs.query({ ...query, url: origins });
}

/** What the extension knows about URLs: learned redirects and canonical links, and the tabs it opened. */
export class LiveLearning {
  constructor(policy, rules = urlRules) {
    this.policy = policy;
    this.rules = rules;
    this.records = new Map();
    this.settledURLs = new Map();
    this.bytes = 0;
    this.revision = 0;
    this.keyCache = { revision: 0, keys: new Map() };
    // Tabs opened here that the browser still lists without an address (Safari, until navigation commits).
    this.created = new Map();
  }

  /** The tab, with the URL it was opened with standing in until the browser reports an address. */
  addressed(tab) {
    const url = tab && this.created.get(tab.id);
    return url && !urlKey(tab.pendingUrl || tab.url) ? { ...tab, pendingUrl: url } : tab;
  }

  async withCreated(tabs, browser) {
    if (!this.created.size) return tabs;
    const listed = new Set(tabs.map(tab => tab.id));
    const unlisted = await Promise.all([...this.created.keys()]
      .filter(id => !listed.has(id))
      .map(id => browser.tabs.get(id).catch(() => null)));
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
    return {
      url, allowed: allowsLearning(url, this.policy),
      entry: format.entry, scope: format.scope, directEntry: direct.entry,
    };
  }

  /**
   * A URL's match keys: its address, normalized address and identity, then those of every learned destination.
   * Cached per learning revision (and bounded); callers must not change the returned set.
   */
  keys(value) {
    if (this.keyCache.revision !== this.revision || this.keyCache.keys.size >= this.policy.maxRecords) {
      this.keyCache = { revision: this.revision, keys: new Map() };
    }
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
      return current.scope === request.entry && (allowsLearning(value, this.policy) ||
        current.directEntry === request.entry || this.records.get('launch\n' + tab.id)?.entry === request.entry);
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
      if (record.kind !== 'launch') this.observe([record]);
      else if (typeof record.entry === 'string' && record.entry.length <= this.policy.maxURLBytes) {
        this.rememberLaunch(record.tabId, record);
      }
    }
    this.restoredUnchecked = this.records.size > 0;
  }

  observe(records) {
    for (const record of records) {
      if (!['redirect', 'canonical'].includes(record.kind) || !allowsLearning(record.source, this.policy)) continue;
      const key = record.kind + '\n' + normalizedKey(record.source, this.policy);
      if (record.destination === null || !allowsLearning(record.destination, this.policy)) this.remove(key);
      else this.put(key, { source: urlKey(record.source), destination: urlKey(record.destination) });
    }
  }

  put(key, value) {
    this.remove(key);
    value.bytes = new TextEncoder().encode(JSON.stringify(value)).length + 32;
    this.records.set(key, value);
    this.bytes += value.bytes;
    this.revision++;
    while (this.records.size > this.policy.maxRecords || this.bytes > this.policy.maxCacheBytes) {
      this.remove(this.records.keys().next().value);
    }
  }

  /** Drops records no open tab needs any more. */
  prune(tabs) {
    this.restoredUnchecked = false;
    const live = new Set();
    const byId = new Map(tabs.map(tab => [tab.id, tab]));
    for (const id of this.settledURLs.keys()) if (!byId.has(id)) this.settledURLs.delete(id);
    for (const tab of tabs) {
      if (tab.incognito) continue;
      const url = tab.pendingUrl || tab.url;
      const previous = this.settledURLs.get(tab.id);
      if (tab.status === 'complete') {
        if (allowsLearning(url, this.policy)) this.settledURLs.set(tab.id, url);
        else this.settledURLs.delete(tab.id);
      }
      // A loading tab still counts for the page it is leaving.
      const candidates = tab.status === 'loading' ? [url, tab.url, previous] : [url];
      for (const candidate of candidates) {
        if (allowsLearning(candidate, this.policy)) for (const key of this.keys(candidate)) live.add(key);
      }
    }
    for (const [key, record] of this.records) {
      if (key.startsWith('launch\n')) {
        if (!this.matches({ entry: record.entry }, byId.get(record.tabId))) this.remove(key);
      } else if (![...this.keys(record.destination)].some(value => live.has(value))) {
        this.remove(key);
      }
    }
  }

  remove(key) {
    const value = this.records.get(key);
    if (!value) return;
    this.bytes -= value.bytes;
    this.records.delete(key);
    this.revision++;
  }

  clear() {
    if (this.records.size) this.revision++;
    this.records.clear();
    this.settledURLs.clear();
    this.bytes = 0;
  }
}

/**
 * Opens url in the tab that already shows it, or in one new tab. A background click (active: false) moves the match
 * beside its source instead; a same-tab link (reuseOnly) only ever switches to another tab.
 */
export async function routeToTab(url, learning, browser, windowFocusOrder = new Map(), opening = {}) {
  const [allWindows, source, listedTabs] = await Promise.all([
    browser.windows.getAll({ windowTypes: ['normal'] }),
    Number.isInteger(opening.sourceTabId) ? browser.tabs.get(opening.sourceTabId) : null,
    permittedTabs(browser, { windowType: 'normal' }),
  ]);
  if (source?.incognito) throw new Error('Private tab links are not supported.');
  const tabs = await learning.withCreated(listedTabs, browser);
  const windows = allWindows.filter(value => !value.incognito);
  const window = await targetWindow(browser, windows, source, windowFocusOrder);
  const activateWindow = id => {
    const target = windows.find(value => value.id === id);
    if (target?.focused) return Promise.resolve();
    return browser.windows.update(id, { ...(target?.state === 'minimized' ? { state: 'normal' } : {}), focused: true });
  };

  // Matches are checked against live tabs, so pruning stays off this path, except for learning restored at startup.
  if (learning.restoredUnchecked) learning.prune(tabs);
  const request = learning.resolve(url);
  const reusable = opening.reuseOnly ? tabs.filter(tab => tab.id !== source?.id) : tabs;
  const preferred = reusable.find(tab => tab.active && tab.windowId === window?.id);
  const match = (preferred && learning.matches(request, preferred) && preferred) ||
    reusable.find(tab => urlKey(tab.pendingUrl || tab.url) === request.url && learning.matches(request, tab)) ||
    reusable.find(tab => learning.matches(request, tab));

  if (match) {
    const current = learning.addressed(await browser.tabs.get(match.id));
    if (!learning.matches(request, current)) throw new Error('The matching tab changed. Please open the link again.');
    // A background click keeps its page in front and moves the match beside it. Chromium regroups a moved tab by its
    // new neighbours, so the move stays within the tab's group; otherwise (or if it can't move) the match is selected.
    const sameGroup = (current.groupId ?? -1) === (source?.groupId ?? -1);
    if (opening.active === false && source && current.id !== source.id && sameGroup) {
      const sameWindow = current.windowId === source.windowId;
      const index = sameWindow && current.index < source.index ? source.index : source.index + 1;
      const inPlace = current.pinned || (sameWindow && current.index === index);
      const moved = inPlace ||
        await browser.tabs.move(current.id, { windowId: source.windowId, index }).then(() => true, () => false);
      if (moved) return { result: 'moved' };
    }
    // Both requests go out at once; the browser applies them in order.
    await Promise.all([
      current.active || browser.tabs.update(match.id, { active: true }),
      activateWindow(current.windowId),
    ]);
    return { result: 'focused' };
  }

  if (opening.reuseOnly) return { result: 'none' };
  const active = opening.active !== false;
  await opening.beforeCreate?.();
  const beside = window && source?.windowId === window.id ? { index: source.index + 1 } : {};
  const created = window
    ? await browser.tabs.create({ windowId: window.id, url, active, ...beside })
    : (await browser.windows.create({ url, incognito: false, type: 'normal', focused: true })).tabs?.[0];
  learning.rememberLaunch(created?.id, request);
  learning.rememberCreated(created?.id, url);
  if (window && active) await activateWindow(window.id);
  return { result: 'opened' };
}

/** The window a new tab opens in: the source's, else the focused, last-focused or most recently used visible one. */
async function targetWindow(browser, windows, source, windowFocusOrder) {
  const visible = windows.filter(value => value.state !== 'minimized');
  const candidates = visible.length ? visible : windows;
  const known = (source && windows.find(value => value.id === source.windowId)) ||
    candidates.find(value => value.focused);
  if (known) return known;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1 && browser.windows.getLastFocused) {
    const lastFocused = await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    const window = candidates.find(value => value.id === lastFocused?.id);
    if (window) return window;
  }
  const recency = value => windowFocusOrder.get(value.id) ?? 0;
  return [...candidates].sort((left, right) => recency(right) - recency(left))[0];
}
