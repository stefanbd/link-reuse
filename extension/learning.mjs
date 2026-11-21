// Query names and path segments compare without case, hyphens or underscores.
const comparable = value => value.toLowerCase().replace(/[-_]/g, '');

/** A web address's parts as the filters read them, or null for one no filter accepts. */
function parts(value, policy) {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > policy.maxURLBytes) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // The query decodes the way the page reads it, so a stray % (?q=100%) leaves it readable.
    const query = [...url.searchParams].flat().join('&');
    return { url, path: decodeURIComponent(url.pathname), query, fragment: decodeURIComponent(url.hash.slice(1)) };
  } catch { return null; }
}

const hasSegment = (text, segments) => text.split(/[/?&=#!]/).some(part => segments.includes(comparable(part)));

/**
 * Whether a link to a URL may switch to an open tab, and a tab showing it may be switched to: any web address except
 * one whose loading is itself an action (signing out, starting a sign-in), which always loads. Matching compares
 * addresses the browser already has, keeps nothing and shows pages nothing.
 */
export function allowsReuse(value, policy) {
  const address = parts(value, policy);
  return address !== null &&
    ![address.path, address.query, address.fragment].some(text => hasSegment(text, policy.actionSegments));
}

/**
 * Whether a URL may be learned, which stores it, or fingerprinted for pages, which could test guesses at a short code
 * in it: never a sign-in or authentication page, an address carrying a credential, or one keeping state in its fragment.
 */
export function allowsLearning(value, policy) {
  if (!allowsReuse(value, policy)) return false;
  const { url, path, fragment } = parts(value, policy);
  if (policy.blockedHostPrefixes.some(prefix => url.hostname.startsWith(prefix))) return false;
  if (hasSegment(path, policy.blockedPathSegments)) return false;
  if (fragment.includes('=') || fragment.includes('?') || hasSegment(fragment, policy.blockedPathSegments)) return false;
  return ![...url.searchParams.keys()].some(key => {
    const name = comparable(key);
    return policy.blockedQueryKeys.includes(name) || policy.blockedQueryPrefixes.some(prefix => name.startsWith(prefix));
  });
}
