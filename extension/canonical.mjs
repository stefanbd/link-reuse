export function canonicalDestination(pageURL, hrefs) {
  if (!Array.isArray(hrefs) || hrefs.length !== 1 || typeof hrefs[0] !== 'string') return null;
  try {
    const page = new URL(pageURL);
    const canonical = new URL(hrefs[0]);
    if (!['http:', 'https:'].includes(page.protocol) || page.origin !== canonical.origin ||
        page.username || page.password || canonical.username || canonical.password ||
        page.hash || canonical.hash) return null;
    const path = canonical.pathname.replace(/\/$/, '');
    if (page.pathname !== canonical.pathname && (!path || !page.pathname.startsWith(path + '/'))) return null;
    for (const key of canonical.searchParams.keys()) {
      if (page.searchParams.has(key) &&
          JSON.stringify(page.searchParams.getAll(key)) !== JSON.stringify(canonical.searchParams.getAll(key))) return null;
    }
    return page.href === canonical.href ? null : canonical.href;
  } catch {
    return null;
  }
}
