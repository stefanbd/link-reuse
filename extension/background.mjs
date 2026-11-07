import { RedirectObserver } from './observer.mjs';
import { canonicalDestination } from './canonical.mjs';
import { allowsLearning } from './learning.mjs';
import { BrowserBridge } from './browser-bridge.mjs';
import { prepareNative } from './native-port.mjs';

const observer = new RedirectObserver();
const connectPort = prepareNative(chrome);
const ready = Promise.all([
  fetch(chrome.runtime.getURL('learning-policy.json')).then(response => response.json()),
  chrome.runtime.getPlatformInfo(),
]).then(async ([policy, platform]) => {
  observer.maxSources = policy.maxRedirectSources;
  const saved = await chrome.storage.session.get('learning');
  const bridge = new BrowserBridge(policy, {
    platform: platform.os,
    connectPort,
    queryTabs: () => chrome.tabs.query({}),
    learningState: saved.learning,
    saveLearning: learning => chrome.storage.session.set({ learning }),
    resetLearning: () => { observer.tabs.clear(); observer.pending.clear(); },
    badge: text => { void (chrome.action ?? chrome.browserAction).setBadgeText({ text }); },
    extensionVersion: chrome.runtime.getManifest().version,
    reload: async version => {
      const manifest = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }).then(response => response.json());
      if (manifest.version !== version) throw new Error(platform.os === 'win' ?
        'Load Link Reuse from the installed scoop/apps/link-reuse/current/extension folder to receive updates.' :
        'Load Link Reuse from the installed Link Reuse.app/Contents/Resources/extension folder to receive updates.');
      chrome.runtime.reload();
    },
  });
  return { policy, bridge, platform: platform.os };
});

function navigate(event, operation) {
  if (event.frameId !== 0 || event.documentLifecycle === 'prerender') return;
  void ready.then(({ policy, bridge }) => {
    if (!allowsLearning(event.url, policy)) { observer.remove(event.tabId); bridge.changed(); return; }
    const aliases = observer[operation](event) ?? [];
    bridge.observe(aliases.map(alias => ({ kind: 'redirect', ...alias })));
    if (operation === 'committed' && !chrome.webNavigation.onHistoryStateUpdated && observer.tabs.get(event.tabId)?.redirectFrom) {
      void chrome.tabs.sendMessage(event.tabId, { type: 'document-context' }, { documentId: event.documentId }).then(info => {
        bridge.observe(observer.document({ ...event, ...info }).map(alias => ({ kind: 'redirect', ...alias })));
      }).catch(() => {});
    }
    if (operation === 'history') {
      void chrome.tabs.sendMessage(event.tabId, { type: 'read-canonical' }, { documentId: event.documentId }).catch(() => {});
    }
  });
}

chrome.webNavigation.onBeforeNavigate.addListener(event => navigate(event, 'before'));
chrome.webNavigation.onCommitted.addListener(event => navigate(event, 'committed'));
chrome.webNavigation.onHistoryStateUpdated?.addListener(event => navigate(event, 'history'));
chrome.webNavigation.onReferenceFragmentUpdated?.addListener(event => navigate(event, 'history'));
chrome.webNavigation.onErrorOccurred.addListener(event => {
  if (event.frameId === 0) { observer.remove(event.tabId); void ready.then(({ bridge }) => bridge.changed()); }
});
chrome.tabs.onRemoved.addListener(tabId => { observer.remove(tabId); void ready.then(({ bridge }) => bridge.changed()); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status || 'discarded' in change || 'frozen' in change) void ready.then(({ bridge }) => bridge.changed());
  if (change.url && !chrome.webNavigation.onHistoryStateUpdated) {
    void chrome.webNavigation.getFrame({ tabId, frameId: 0 }).then(frame => {
      if (frame?.documentId && frame.url === change.url) navigate({ ...frame, tabId, frameId: 0 }, 'history');
    }).catch(() => {});
  }
});
chrome.tabs.onActivated.addListener(() => { void ready.then(({ bridge }) => bridge.changed()); });
chrome.runtime.onStartup.addListener(() => { void ready.then(({ bridge }) => bridge.changed()); });
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId < 0) return;
  const focusedAt = performance.now();
  void ready.then(async ({ bridge }) => {
    const window = await chrome.windows.get(windowId);
    if (!window.incognito && window.type === 'normal') bridge.focused?.(windowId, focusedAt);
  }).catch(() => {});
});
chrome.windows.onRemoved.addListener(windowId => { void ready.then(({ bridge }) => bridge.forgetWindow?.(windowId)); });
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (['page-link-capability', 'page-link'].includes(message.type) && sender.tab && !sender.tab.incognito) {
    void ready.then(({ bridge, platform }) => {
      if (message.type === 'page-link-capability') return { enabled: true, platform };
      if (!bridge.open) throw new Error('Webpage link reuse is unavailable in this browser.');
      return bridge.open(message.url, { sourceTabId: sender.tab.id, active: message.active !== false });
    }).then(respond, error => respond({ error: error.message }));
    return true;
  }
  if (message.type === 'canonical' && sender.tab && sender.frameId === 0) {
    void ready.then(({ bridge }) => {
      const tab = observer.tabs.get(sender.tab.id);
      if (tab?.documentId === sender.documentId && tab.url === message.url) {
        bridge.observe(observer.document({ tabId: sender.tab.id, documentId: sender.documentId, url: message.url,
          referrer: message.referrer }).map(alias => ({ kind: 'redirect', ...alias })));
        bridge.observe([{ kind: 'canonical', source: message.url, destination: canonicalDestination(message.url, message.hrefs) }]);
      }
    });
  }
  if (message.type === 'interaction' && sender.tab && sender.frameId === 0) void ready.then(() => observer.interact(sender.tab.id, sender.documentId));
  if (['status', 'clear-learning'].includes(message.type) && !sender.tab) {
    void ready.then(async ({ bridge }) => {
      if (message.type === 'clear-learning') await bridge.clear();
      return bridge.status();
    }).then(respond, error => respond({ connected: false, lastError: error.message }));
    return true;
  }
});
