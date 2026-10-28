import { allowsLearning } from './learning.mjs';

export function urlKey(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function mapsPlaceKey(value) {
  try {
    const url = new URL(value);
    if (!['google.com', 'www.google.com', 'maps.google.com'].includes(url.hostname) ||
        url.port || url.username || url.password || !url.pathname.startsWith('/maps/place/')) return null;
    const ids = new Set([...url.pathname.toLowerCase().matchAll(/!4m\d+!3m\d+!1s(0x[0-9a-f]+:0x[0-9a-f]+)(?=!|$)/g)].map(match => match[1]));
    return ids.size === 1 ? 'google-maps-place:' + [...ids][0] : null;
  } catch { return null; }
}

export function resourceKeys(value, records) {
  const keys = new Set();
  const pending = [urlKey(value)];
  while (pending.length && keys.size < 64) {
    const key = pending.pop();
    if (!key || keys.has(key)) continue;
    keys.add(key);
    const place = mapsPlaceKey(key);
    if (place) keys.add(place);
    for (const kind of ['redirect', 'canonical']) {
      const destination = records.get(kind + '\n' + key)?.destination;
      if (destination) pending.push(destination);
    }
  }
  return keys;
}

export function equivalent(left, right, records) {
  const keys = resourceKeys(left, records);
  return [...resourceKeys(right, records)].some(key => keys.has(key));
}

function snowflakeAccount(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
    const named = url.hostname.match(/^([a-z][a-z0-9]*)-([a-z0-9_-]+)\.snowflakecomputing\.com$/);
    const app = url.hostname === 'app.snowflake.com' && url.pathname.toLowerCase().match(/^\/([a-z][a-z0-9]*)\/([a-z0-9_-]+)(?:\/|$)/);
    const match = named || app;
    return match ? 'snowflake-account:' + match[1] + '/' + match[2].replace(/_/g, '-') : null;
  } catch { return null; }
}

function snowflakeLauncher(value, policy) {
  try {
    if (typeof value !== 'string' || value.length > policy.maxURLBytes) return null;
    const url = new URL(value);
    const account = snowflakeAccount(value);
    if (!account || url.search || !['', '#', '#/'].includes(url.hash)) return null;
    const landing = url.hostname === 'app.snowflake.com' ? /^\/[^/]+\/[^/]+\/?$/ : /^\/(?:console\/(?:login\/?)?)?$/;
    return landing.test(url.pathname) ? account : null;
  } catch { return null; }
}

function slackLinkTarget(value, policy) {
  try {
    if (typeof value !== 'string' || value.length > policy.maxURLBytes) return null;
    const url = new URL(value);
    if (url.origin !== 'https://slack.com' || url.username || url.password ||
        url.pathname !== '/openid/connect/login_initiate_redirect') return null;
    const hints = url.searchParams.getAll('login_hint');
    if (hints.length !== 1 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(hints[0])) return null;
    const decode = part => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))));
    const [header, payload] = hints[0].split('.').slice(0, 2).map(decode);
    // This unverified claim is only a lookup hint, never authentication or a replacement navigation URL.
    const target = payload['https://slack.com/target_uri'];
    return header.alg === 'RS256' && header.typ === 'JWT' && payload.iss === 'https://slack.com' &&
      (allowsLearning(target, policy) || snowflakeLauncher(target, policy)) ? urlKey(target) : null;
  } catch { return null; }
}

export class LiveLearning {
  constructor(policy) { this.policy = policy; this.records = new Map(); this.settledURLs = new Map(); this.bytes = 0; }
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
        for (const key of resourceKeys(candidate, this.records)) live.add(key);
      }
    }
    for (const [key, record] of this.records) {
      if (key.startsWith('launch\n')) {
        const tab = byId.get(record.tabId);
        const current = tab && (tab.pendingUrl || tab.url);
        const account = snowflakeAccount(current) || snowflakeLauncher(slackLinkTarget(current, this.policy), this.policy);
        if (!tab || tab.incognito || account !== record.account) this.remove(key);
        continue;
      }
      if (![...resourceKeys(record.destination, this.records)].some(value => live.has(value))) this.remove(key);
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
  const lookupURL = slackLinkTarget(url, learning.policy) || url;
  const account = snowflakeLauncher(lookupURL, learning.policy);
  const matches = value => account ? (snowflakeAccount(value) || snowflakeLauncher(slackLinkTarget(value, learning.policy), learning.policy)) === account :
    equivalent(lookupURL, value, learning.records);
  const available = tabs.filter(tab => !tab.incognito && (allowsLearning(tab.pendingUrl || tab.url, learning.policy) ||
    (account && snowflakeLauncher(tab.pendingUrl || tab.url, learning.policy) === account) ||
    (account && learning.records.get('launch\n' + tab.id)?.account === account && matches(tab.pendingUrl || tab.url))));
  const preferred = available.find(tab => tab.active && tab.windowId === window?.id);
  const match = (account || allowsLearning(lookupURL, learning.policy)) && (
    (preferred && matches(preferred.pendingUrl || preferred.url) && preferred) ||
    available.find(tab => urlKey(tab.pendingUrl || tab.url) === urlKey(lookupURL)) ||
    available.find(tab => matches(tab.pendingUrl || tab.url))
  );
  if (match) {
    const current = await browser.tabs.get(match.id);
    if (current.incognito || !matches(current.pendingUrl || current.url) || (!allowsLearning(current.pendingUrl || current.url, learning.policy) &&
        snowflakeLauncher(current.pendingUrl || current.url, learning.policy) !== account &&
        learning.records.get('launch\n' + current.id)?.account !== account)) throw new Error('The matching tab changed. Please open the link again.');
    await browser.tabs.update(match.id, { active: true });
    await activateWindow(match.windowId);
    return { result: 'focused' };
  }
  if (window) {
    const created = await browser.tabs.create({ windowId: window.id, url, active: true });
    if (account && Number.isInteger(created?.id)) learning.put('launch\n' + created.id, { tabId: created.id, account });
    await activateWindow(window.id);
  } else {
    const created = await browser.windows.create({ url, incognito: false, type: 'normal', focused: true });
    const tab = created.tabs?.[0];
    if (account && Number.isInteger(tab?.id)) learning.put('launch\n' + tab.id, { tabId: tab.id, account });
  }
  return { result: 'opened' };
}
