function mapsPlaceIdentity(url) {
  if (!['google.com', 'www.google.com', 'maps.google.com'].includes(url.hostname) || !url.pathname.startsWith('/maps/place/')) return null;
  const ids = new Set([...url.pathname.toLowerCase().matchAll(/!4m\d+!3m\d+!1s(0x[0-9a-f]+:0x[0-9a-f]+)(?=!|$)/g)].map(match => match[1]));
  return ids.size === 1 ? 'google-maps-place:' + [...ids][0] : null;
}

function snowflakeScope(url) {
  if (url.protocol !== 'https:') return null;
  const named = url.hostname.match(/^([a-z][a-z0-9]*)-([a-z0-9_-]+)\.snowflakecomputing\.com$/);
  const app = url.hostname === 'app.snowflake.com' && url.pathname.toLowerCase().match(/^\/([a-z][a-z0-9]*)\/([a-z0-9_-]+)(?:\/|$)/);
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

export function urlRules(value, policy) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password) return {};
    const scope = snowflakeScope(url);
    const bounded = typeof value === 'string' && new TextEncoder().encode(value).length <= policy.maxURLBytes;
    return {
      identity: mapsPlaceIdentity(url),
      scope,
      entry: scope && bounded && snowflakeEntry(url) ? scope : null,
      target: bounded ? slackTarget(url) : null,
    };
  } catch { return {}; }
}
