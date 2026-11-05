export function allowsLearning(value, policy) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > policy.maxURLBytes) return false;
  try {
    const url = new URL(value);
    const normalized = value => value.toLowerCase().replace(/[-_]/g, '');
    const sensitivePath = value => value.split(/[/?&=#!]/).some(part => policy.blockedPathSegments.includes(normalized(part)));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        policy.blockedHostPrefixes.some(prefix => url.hostname.startsWith(prefix)) || sensitivePath(decodeURIComponent(url.pathname))) return false;
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment.includes('=') || fragment.includes('?') || sensitivePath(fragment)) return false;
    for (const key of url.searchParams.keys()) {
      const name = normalized(key);
      if (policy.blockedQueryKeys.includes(name) || policy.blockedQueryPrefixes.some(prefix => name.startsWith(prefix))) return false;
    }
    return true;
  } catch { return false; }
}
