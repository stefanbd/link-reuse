import { allowsLearning } from './learning.mjs';
import { fingerprint } from './url-rules.mjs';

/**
 * The fingerprints of open tabs' match keys, each with the tabs showing it. A learned redirect or canonical link counts
 * by its normalized source when its destination's keys reach an open tab, which is how the background's own key chain
 * for that source would reach it.
 */
export function reuseIndex(tabs, learning) {
  const index = new Map();
  const add = (key, ids) => {
    const print = fingerprint(key);
    let set = index.get(print);
    if (!set) index.set(print, set = new Set());
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
      for (const id of index.get(fingerprint(key)) ?? []) ids.add(id);
    }
    if (ids.size) add(name.slice(name.indexOf('\n') + 1), ids);
  }
  return index;
}

/** Whether a page's list has key: another tab shows it. */
function listed(index, key, tabId) {
  const ids = index.get(key);
  return ids !== undefined && (ids.size > 1 || !ids.has(tabId));
}

/** A page's list: the fingerprints of keys other tabs show, on any site. Null for a private tab or a non-web page. */
export function pageKeys(index, tab) {
  if (!tab || tab.incognito || !/^https?:/.test(tab.url ?? '')) return null;
  return [...index.keys()].filter(key => listed(index, key, tab.id));
}

/** Whether a page's list differs between two indexes. */
export function listChanged(previous, index, tab) {
  const differs = key => listed(previous, key, tab.id) !== listed(index, key, tab.id);
  return [...previous.keys()].some(differs) || [...index.keys()].some(differs);
}

/** What a page needs to compute a link's keys itself: the URL rules, without the learning limits. */
export const pageRules = ({ maxURLBytes, noiseQueryKeys, noiseQueryPrefixes, identityRules }) =>
  ({ maxURLBytes, noiseQueryKeys, noiseQueryPrefixes, identityRules });
