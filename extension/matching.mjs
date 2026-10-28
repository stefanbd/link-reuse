import { allowsLearning } from './learning.mjs';
import { urlRules } from './url-rules.mjs';

function urlKey(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export class LiveLearning {
  constructor(policy, rules = urlRules) {
    this.policy = policy; this.rules = rules; this.records = new Map(); this.settledURLs = new Map(); this.bytes = 0;
  }
  resolve(value) {
    const original = urlKey(value);
    const direct = original ? this.rules(original, this.policy) : {};
    const target = urlKey(direct.target);
    const url = target || original;
    const format = target ? this.rules(target, this.policy) : direct;
    return { url, allowed: allowsLearning(url, this.policy), entry: format.entry, scope: format.scope, directEntry: direct.entry };
  }
  keys(value) {
    const keys = new Set();
    const pending = [urlKey(value)];
    while (pending.length && keys.size < 64) {
      const key = pending.pop();
      if (!key || keys.has(key)) continue;
      keys.add(key);
      const identity = this.rules(key, this.policy).identity;
      if (identity) keys.add(identity);
      for (const kind of ['redirect', 'canonical']) {
        const destination = this.records.get(kind + '\n' + key)?.destination;
        if (destination) pending.push(destination);
      }
    }
    return keys;
  }
  equivalent(left, right) {
    const keys = this.keys(left);
    return [...this.keys(right)].some(key => keys.has(key));
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
  observe(records) {
    for (const record of records) {
      if (!['redirect', 'canonical'].includes(record.kind) || !allowsLearning(record.source, this.policy)) continue;
      const key = record.kind + '\n' + urlKey(record.source);
      if (record.destination === null || !allowsLearning(record.destination, this.policy)) { this.remove(key); continue; }
      this.put(key, { source: urlKey(record.source), destination: urlKey(record.destination) });
    }
  }
  put(key, value) {
    this.remove(key);
    value.bytes = new TextEncoder().encode(JSON.stringify(value)).length + 32;
    this.records.set(key, value);
    this.bytes += value.bytes;
    while (this.records.size > this.policy.maxRecords || this.bytes > this.policy.maxCacheBytes) this.remove(this.records.keys().next().value);
  }
  prune(tabs) {
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
      const candidates = tab.status === 'loading' && previous ? [url, previous] : [url];
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
  remove(key) { const value = this.records.get(key); if (value) { this.bytes -= value.bytes; this.records.delete(key); } }
  clear() { this.records.clear(); this.settledURLs.clear(); this.bytes = 0; }
}

export async function routeToTab(url, learning, browser, windowFocusOrder = new Map()) {
  const windows = (await browser.windows.getAll({ windowTypes: ['normal'] })).filter(value => !value.incognito);
  const lastFocused = browser.windows.getLastFocused ? await browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null) : null;
  const visible = windows.filter(value => value.state !== 'minimized');
  const candidates = visible.length ? visible : windows;
  const window = candidates.find(value => value.focused) || candidates.find(value => value.id === lastFocused?.id) ||
    [...candidates].sort((left, right) => (windowFocusOrder.get(right.id) ?? 0) - (windowFocusOrder.get(left.id) ?? 0))[0];
  const activateWindow = id => browser.windows.update(id, {
    ...(windows.find(value => value.id === id)?.state === 'minimized' ? { state: 'normal' } : {}), focused: true,
  });
  const tabs = await browser.tabs.query({ windowType: 'normal' });
  learning.prune(tabs);
  const request = learning.resolve(url);
  const preferred = tabs.find(tab => tab.active && tab.windowId === window?.id);
  const match = (preferred && learning.matches(request, preferred) && preferred) ||
    tabs.find(tab => urlKey(tab.pendingUrl || tab.url) === request.url && learning.matches(request, tab)) ||
    tabs.find(tab => learning.matches(request, tab));
  if (match) {
    const current = await browser.tabs.get(match.id);
    if (!learning.matches(request, current)) throw new Error('The matching tab changed. Please open the link again.');
    await browser.tabs.update(match.id, { active: true });
    await activateWindow(match.windowId);
    return { result: 'focused' };
  }
  const created = window ? await browser.tabs.create({ windowId: window.id, url, active: true }) :
    (await browser.windows.create({ url, incognito: false, type: 'normal', focused: true })).tabs?.[0];
  learning.rememberLaunch(created?.id, request);
  if (window) await activateWindow(window.id);
  return { result: 'opened' };
}
