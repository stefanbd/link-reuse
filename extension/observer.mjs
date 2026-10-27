export class RedirectObserver {
  constructor(maxSources = 32) {
    this.maxSources = maxSources;
    this.tabs = new Map();
    this.pending = new Map();
  }

  before(event) {
    this.pending.set(event.tabId, { source: event.url, previous: this.tabs.get(event.tabId) });
  }

  committed(event) {
    const pending = this.pending.get(event.tabId);
    const previous = pending?.previous;
    const sources = new Set([pending?.source ?? event.url]);
    if (event.transitionQualifiers?.includes('client_redirect') && previous && !previous.interacted) {
      for (const source of previous.sources) sources.add(source);
      sources.add(previous.url);
    }
    const tab = { sources: [...sources].slice(-this.maxSources), url: event.url, documentId: event.documentId, interacted: false };
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

  interact(tabId, documentId) {
    const tab = this.tabs.get(tabId);
    if (tab?.documentId === documentId) tab.interacted = true;
  }

  remove(tabId) {
    this.tabs.delete(tabId);
    this.pending.delete(tabId);
  }

  aliases(tab) {
    return tab.sources.filter(source => source !== tab.url).map(source => ({ source, destination: tab.url }));
  }
}
