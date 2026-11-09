// Query names and path segments compare without case, hyphens or underscores.
const comparable = value => value.toLowerCase().replace(/[-_]/g, '');

/** Whether a URL may be learned or reused: never credentials, sign-in pages, tokens or oversized addresses. */
export function allowsLearning(value, policy) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > policy.maxURLBytes) return false;
  try {
    const url = new URL(value);
    const sensitive = text =>
      text.split(/[/?&=#!]/).some(part => policy.blockedPathSegments.includes(comparable(part)));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (policy.blockedHostPrefixes.some(prefix => url.hostname.startsWith(prefix))) return false;
    if (sensitive(decodeURIComponent(url.pathname))) return false;
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment.includes('=') || fragment.includes('?') || sensitive(fragment)) return false;
    for (const key of url.searchParams.keys()) {
      const name = comparable(key);
      if (policy.blockedQueryKeys.includes(name)) return false;
      if (policy.blockedQueryPrefixes.some(prefix => name.startsWith(prefix))) return false;
    }
    return true;
  } catch { return false; }
}
