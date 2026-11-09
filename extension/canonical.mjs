/**
 * The canonical address a page declares, if it can be trusted: exactly one declaration, same origin, the same or a
 * parent path, no conflicting query values and no fragments. Null otherwise, or when it is the page itself.
 */
export function canonicalDestination(pageURL, hrefs) {
  if (!Array.isArray(hrefs) || hrefs.length !== 1 || typeof hrefs[0] !== 'string') return null;
  try {
    const page = new URL(pageURL);
    const canonical = new URL(hrefs[0]);
    if (!['http:', 'https:'].includes(page.protocol) || page.origin !== canonical.origin) return null;
    const credentials = page.username || page.password || canonical.username || canonical.password;
    if (credentials || page.hash || canonical.hash) return null;
    const path = canonical.pathname.replace(/\/$/, '');
    if (page.pathname !== canonical.pathname && (!path || !page.pathname.startsWith(path + '/'))) return null;
    for (const key of canonical.searchParams.keys()) {
      const values = params => JSON.stringify(params.getAll(key));
      const differs = values(page.searchParams) !== values(canonical.searchParams);
      if (page.searchParams.has(key) && differs) return null;
    }
    return page.href === canonical.href ? null : canonical.href;
  } catch {
    return null;
  }
}
