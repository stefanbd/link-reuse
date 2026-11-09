/**
 * Follows each tab's top-level navigations and reports which addresses led to the page it shows: server redirects,
 * automatic client-side redirects and address rewrites, until the user interacts with the page.
 */
export class RedirectObserver {
  constructor(maxSources = 32) {
    this.maxSources = maxSources;
    this.tabs = new Map();
    this.pending = new Map();
  }

  before(event) {
    this.pending.set(event.tabId, { source: event.url, previous: this.tabs.get(event.tabId), at: Date.now() });
  }

  committed(event) {
    // A start survives a failure report (see failed) for 30 seconds; the next navigation replaces it anyway.
    const reported = this.pending.get(event.tabId);
    const pending = reported && Date.now() - reported.at < 30000 ? reported : undefined;
    const previous = pending?.previous;
    const sources = new Set([pending?.source ?? event.url]);
    if (event.transitionQualifiers?.includes('client_redirect') && previous && !previous.interacted) {
      for (const source of previous.sources) sources.add(source);
      sources.add(previous.url);
    }
    const tab = {
      sources: [...sources].slice(-this.maxSources), url: event.url, documentId: event.documentId, interacted: false,
    };
    // Without transition qualifiers (Safari), the new document's referrer decides later whether this was a redirect.
    if (!event.transitionQualifiers && previous && !previous.interacted) {
      tab.redirectFrom = { url: previous.url, sources: previous.sources };
    }
    this.tabs.set(event.tabId, tab);
    this.pending.delete(event.tabId);
    return this.aliases(tab);
  }

  history(event) {
    const tab = this.tabs.get(event.tabId);
    if (!tab || tab.documentId !== event.documentId) return [];
    if (tab.interacted) {
      tab.sources = [];
      tab.url = event.url;
      return [];
    }
    tab.sources = [...new Set([...tab.sources, tab.url])].slice(-this.maxSources);
    tab.url = event.url;
    return this.aliases(tab);
  }

  document(event) {
    const tab = this.tabs.get(event.tabId);
    if (!tab || tab.documentId !== event.documentId || tab.url !== event.url) return [];
    const previous = tab.redirectFrom;
    delete tab.redirectFrom;
    tab.interacted ||= event.interacted === true;
    if (!previous || event.referrer !== previous.url) return [];
    tab.sources = [...new Set([...previous.sources, previous.url, ...tab.sources])].slice(-this.maxSources);
    return this.aliases(tab);
  }

  interact(tabId, documentId) {
    const tab = this.tabs.get(tabId);
    if (tab?.documentId === documentId) tab.interacted = true;
  }

  // The current document stays. The pending start does too: Safari reports a cross-site process swap as a failure,
  // then commits that navigation without a new onBeforeNavigate.
  failed(tabId) {
    this.tabs.delete(tabId);
  }

  remove(tabId) {
    this.tabs.delete(tabId);
    this.pending.delete(tabId);
  }

  aliases(tab) {
    return tab.sources.filter(source => source !== tab.url).map(source => ({ source, destination: tab.url }));
  }
}
