export class RedirectObserver {
  constructor(maxSources = 32) {
    this.maxSources = maxSources;
    this.tabs = new Map();
    this.pending = new Map();
    this.expected = new Map();
  }

  // A same-tab navigation the extension held and resumed. Safari reports the held original as failed and does not
  // report the resumed one before it commits, so its requested URL becomes the source of the tab's next commit.
  expect(tabId, url) {
    this.expected.set(tabId, { url, at: Date.now() });
  }

  before(event) {
    if (this.expected.get(event.tabId)?.url !== event.url) this.expected.delete(event.tabId);
    this.pending.set(event.tabId, { source: event.url, previous: this.tabs.get(event.tabId), at: Date.now() });
  }

  committed(event) {
    // A failure report does not end a pending navigation: Safari reports one when a cross-site navigation moves to
    // another web process and then commits it without a new onBeforeNavigate. The next navigation replaces it anyway.
    const reported = this.pending.get(event.tabId);
    const pending = reported && Date.now() - reported.at < 30000 ? reported : undefined;
    const previous = pending?.previous;
    const expected = this.expected.get(event.tabId);
    this.expected.delete(event.tabId);
    const sources = new Set([pending?.source ?? event.url]);
    if (expected && Date.now() - expected.at < 15000) sources.add(expected.url);
    if (event.transitionQualifiers?.includes('client_redirect') && previous && !previous.interacted) {
      for (const source of previous.sources) sources.add(source);
      sources.add(previous.url);
    }
    const tab = { sources: [...sources].slice(-this.maxSources), url: event.url, documentId: event.documentId, interacted: false };
    if (!event.transitionQualifiers && previous && !previous.interacted) tab.redirectFrom = { url: previous.url, sources: previous.sources };
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

  // A failed navigation leaves the current document. Its pending start and any expected resumed navigation stay (see
  // committed), because Safari reports a cross-site process swap as a failure before the navigation commits.
  failed(tabId) {
    this.tabs.delete(tabId);
  }

  remove(tabId) {
    this.tabs.delete(tabId);
    this.pending.delete(tabId);
    this.expected.delete(tabId);
  }

  aliases(tab) {
    return tab.sources.filter(source => source !== tab.url).map(source => ({ source, destination: tab.url }));
  }
}
