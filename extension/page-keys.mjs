import { allowsLearning } from './learning.mjs';
import { fingerprint } from './url-rules.mjs';

/**
 * The fingerprints of the match keys of open tabs, in a stable order, each with the tabs showing it. A learned redirect
 * or canonical link counts by its normalized source when its destination's keys reach an open tab, which is how the
 * background's own key chain for that source would reach it.
 */
export function reuseIndex(tabs, learning) {
  const shown = new Map();
  const add = (key, ids) => {
    const print = fingerprint(key);
    let set = shown.get(print);
    if (!set) shown.set(print, set = new Set());
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
    for (const key of learning.keys(record.destination)) {
      for (const id of shown.get(fingerprint(key)) ?? []) ids.add(id);
    }
    if (ids.size) add(name.slice(name.indexOf('\n') + 1), ids);
  }
  return [...shown].sort(([left], [right]) => left - right);
}

/**
 * A page's keys: the fingerprints of those other tabs show, on any site. Null for a page that gets none (private, or
 * not a web page).
 */
export function pageKeys(index, tab) {
  if (!tab || tab.incognito || !/^https?:/.test(tab.url ?? '')) return null;
  return index.filter(([, ids]) => ids.size > 1 || !ids.has(tab.id)).map(([print]) => print);
}
