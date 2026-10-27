import { RedirectObserver } from './observer.mjs';
import { canonicalDestination } from './canonical.mjs';
import { allowsLearning } from './learning.mjs';
import { NativeBridge } from './bridge.mjs';

const observer = new RedirectObserver();
const ready = fetch(chrome.runtime.getURL('learning-policy.json')).then(response => response.json()).then(policy => {
  observer.maxSources = policy.maxBatchRecords;
  const bridge = new NativeBridge(policy, {
    connectPort: () => {
      const port = chrome.runtime.connectNative('me.dichev.link_reuse');
      port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
      return port;
    },
    queryTabs: () => chrome.tabs.query({}),
    resetLearning: () => { observer.tabs.clear(); observer.pending.clear(); },
    badge: text => { void chrome.action.setBadgeText({ text }); },
  });
  return { policy, bridge };
});

function navigate(event, operation) {
  if (event.frameId !== 0 || event.documentLifecycle === 'prerender') return;
  void ready.then(({ policy, bridge }) => {
    if (!allowsLearning(event.url, policy)) { observer.remove(event.tabId); bridge.changed(); return; }
    const aliases = observer[operation](event) ?? [];
    bridge.observe(aliases.map(alias => ({ kind: 'redirect', ...alias })));
    if (operation === 'history') {
      void chrome.tabs.sendMessage(event.tabId, { type: 'read-canonical' }, { documentId: event.documentId }).catch(() => {});
    }
  });
}

chrome.webNavigation.onBeforeNavigate.addListener(event => navigate(event, 'before'));
chrome.webNavigation.onCommitted.addListener(event => navigate(event, 'committed'));
chrome.webNavigation.onHistoryStateUpdated.addListener(event => navigate(event, 'history'));
chrome.webNavigation.onReferenceFragmentUpdated.addListener(event => navigate(event, 'history'));
chrome.webNavigation.onErrorOccurred.addListener(event => {
  if (event.frameId === 0) { observer.remove(event.tabId); void ready.then(({ bridge }) => bridge.changed()); }
});
chrome.tabs.onRemoved.addListener(tabId => { observer.remove(tabId); void ready.then(({ bridge }) => bridge.changed()); });
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url || change.status === 'complete') void ready.then(({ bridge }) => bridge.changed());
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'canonical' && sender.tab && sender.frameId === 0) {
    const tab = observer.tabs.get(sender.tab.id);
    if (tab?.documentId === sender.documentId && tab.url === message.url) {
      void ready.then(({ bridge }) => bridge.observe([{ kind: 'canonical', source: message.url,
        destination: canonicalDestination(message.url, message.hrefs) }]));
    }
  }
  if (message.type === 'interaction' && sender.tab && sender.frameId === 0) observer.interact(sender.tab.id, sender.documentId);
  if (['status', 'clear-learning'].includes(message.type) && !sender.tab) {
    void ready.then(async ({ bridge }) => {
      if (message.type === 'clear-learning') await bridge.clear();
      return bridge.status();
    }).then(respond, error => respond({ connected: false, lastError: error.message }));
    return true;
  }
});
