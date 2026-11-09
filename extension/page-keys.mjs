import { allowsLearning } from './learning.mjs';

const noKeys = { entries: [], signature: '[]' };

// The origin a match key belongs to: a URL's own, or the one inside an identity rule's key. Other keys have none.
function keyOrigin(key) {
  try { return key.startsWith('[') ? JSON.parse(key)[1] : new URL(key).origin; } catch { return null; }
}

/**
 * For each origin, the match keys of open tabs there and the tabs showing each, with a signature that changes exactly
 * when they do. A learned redirect or canonical link counts by its normalized source when its destination's keys reach
 * an open tab, which is how the background's own key chain for that source would reach it.
 */
export function reuseIndex(tabs, learning) {
  const shown = new Map();
  const add = (key, ids) => {
    let set = shown.get(key);
    if (!set) shown.set(key, set = new Set());
    for (const id of ids) set.add(id);
  };
  for (const tab of tabs) {
    const url = tab.pendingUrl || tab.url;
    if (!tab.incognito && Number.isInteger(tab.id) && allowsLearning(url, learning.policy)) {
      for (const key of learning.keys(url)) add(key, [tab.id]);
    }
  }
  for (const [name, record] of learning.records) {
    if (name.startsWith('launch\n')) continue;
    const ids = new Set();
    for (const key of learning.keys(record.destination)) for (const id of shown.get(key) ?? []) ids.add(id);
    if (ids.size) add(name.slice(name.indexOf('\n') + 1), ids);
  }
  const index = new Map();
  for (const key of [...shown.keys()].sort()) {
    const origin = keyOrigin(key);
    if (!origin) continue;
    if (!index.has(origin)) index.set(origin, { entries: [] });
    index.get(origin).entries.push([key, shown.get(key)]);
  }
  for (const site of index.values()) {
    site.signature = JSON.stringify(site.entries.map(([key, ids]) => [key, [...ids].sort((left, right) => left - right)]));
  }
  return index;
}

/** The site whose keys a page gets, or null for a page that gets none (private, or not a web page). */
export function siteOf(index, tab) {
  if (!tab || tab.incognito) return null;
  let origin;
  try { origin = new URL(tab.url).origin; } catch { return null; }
  return /^https?:/.test(origin) ? index.get(origin) ?? noKeys : null;
}

/** A page's keys: those its site's other tabs show. A page never learns about tabs on other sites. */
export function pageKeys(site, tab) {
  return site.entries.filter(([, ids]) => ids.size > 1 || !ids.has(tab.id)).map(([key]) => key);
}
