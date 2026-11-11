// Classic script so the page-link script runs the same matching as the background (url-rules.mjs re-exports it).
globalThis.linkReuseURLRules = (() => {
  const compiledPolicies = new WeakMap();

  // Query keys compare without case, hyphens or underscores (search_id, searchId and searchid are one key).
  const queryName = key => key.toLowerCase().replace(/[-_]/g, '');

  // A URL without known tracking parameters, in a stable order. Every other parameter may choose a different page.
  function normalizedKey(value, policy) {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      const tracking = (policy.noiseQueryKeys ?? []).includes(queryName(key)) ||
        (policy.noiseQueryPrefixes ?? []).some(prefix => key.toLowerCase().startsWith(prefix));
      if (tracking) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return url.href;
  }

  // A 53-bit fingerprint of a match key (cyrb53). Pages get these instead of other tabs' addresses: a page can check a
  // link it has, but can't read which pages are open.
  function fingerprint(key) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < key.length; i++) {
      const code = key.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function ruleIdentity(url, policy) {
    let rules = compiledPolicies.get(policy);
    if (!rules) {
      rules = (policy.identityRules ?? []).flatMap(rule => {
        try {
          if (!['name', 'host', 'path', 'identity'].every(key => typeof rule[key] === 'string' && rule[key])) return [];
          const hostPattern = new RegExp('^(?:' + rule.host + ')$', 'i');
          const pathPattern = new RegExp('^(?:' + rule.path + ')$');
          return [{ ...rule, hostPattern, pathPattern }];
        }
        catch { return []; }
      });
      compiledPolicies.set(policy, rules);
    }
    for (const rule of rules) {
      if (!rule.hostPattern.test(url.hostname) || !rule.pathPattern.test(url.pathname)) continue;
      const id = url.pathname.replace(rule.pathPattern, rule.identity);
      // On a resource the rule identifies, query parameters are view state (a focused comment, a tab, tracking) unless
      // the rule names them as choosing a different resource; an anchor too, unless it is an app route (#/ or #!).
      const view = new URL(url.href);
      for (const key of [...view.searchParams.keys()]) {
        if (!(rule.meaningfulQueryKeys ?? []).includes(queryName(key))) view.searchParams.delete(key);
      }
      view.searchParams.sort();
      if (rule.ignoreAnchor === true && !view.hash.startsWith('#/') && !view.hash.startsWith('#!')) view.hash = '';
      const resource = rule.uppercase === true ? id.toUpperCase() : id;
      return JSON.stringify([rule.name, view.origin, resource, view.search, view.hash]);
    }
    return null;
  }

  function mapsPlaceIdentity(url) {
    const maps = ['google.com', 'www.google.com', 'maps.google.com'].includes(url.hostname);
    if (!maps || !url.pathname.startsWith('/maps/place/')) return null;
    const places = url.pathname.toLowerCase().matchAll(/!4m\d+!3m\d+!1s(0x[0-9a-f]+:0x[0-9a-f]+)(?=!|$)/g);
    const ids = new Set([...places].map(match => match[1]));
    return ids.size === 1 ? 'google-maps-place:' + [...ids][0] : null;
  }

  function snowflakeScope(url) {
    if (url.protocol !== 'https:') return null;
    const named = url.hostname.match(/^([a-z][a-z0-9]*)-([a-z0-9_-]+)\.snowflakecomputing\.com$/);
    const app = url.hostname === 'app.snowflake.com' &&
      url.pathname.toLowerCase().match(/^\/([a-z][a-z0-9]*)\/([a-z0-9_-]+)(?:\/|$)/);
    const match = named || app;
    return match ? 'snowflake-account:' + match[1] + '/' + match[2].replace(/_/g, '-') : null;
  }

  function snowflakeEntry(url) {
    if (url.search || !['', '#', '#/'].includes(url.hash)) return false;
    const landing = url.hostname === 'app.snowflake.com' ? /^\/[^/]+\/[^/]+\/?$/ : /^\/(?:console\/(?:login\/?)?)?$/;
    return landing.test(url.pathname);
  }

  function slackTarget(url) {
    if (url.origin !== 'https://slack.com' || url.pathname !== '/openid/connect/login_initiate_redirect') return null;
    const hints = url.searchParams.getAll('login_hint');
    if (hints.length !== 1 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(hints[0])) return null;
    const decode = part => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))));
    const [header, payload] = hints[0].split('.').slice(0, 2).map(decode);
    // This unverified claim is a lookup hint, never authentication or a replacement navigation URL.
    const target = payload['https://slack.com/target_uri'];
    return header.alg === 'RS256' && header.typ === 'JWT' && payload.iss === 'https://slack.com' &&
      typeof target === 'string' ? target : null;
  }

  function urlRules(value, policy) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password) return {};
      const scope = snowflakeScope(url);
      const bounded = typeof value === 'string' && new TextEncoder().encode(value).length <= policy.maxURLBytes;
      return {
        identity: mapsPlaceIdentity(url) || ruleIdentity(url, policy),
        scope,
        entry: scope && bounded && snowflakeEntry(url) ? scope : null,
        target: bounded ? slackTarget(url) : null,
      };
    } catch { return {}; }
  }

  return { normalizedKey, urlRules, fingerprint };
})();
