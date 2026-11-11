import { RedirectObserver } from './observer.mjs';
import { canonicalDestination } from './canonical.mjs';
import { allowsLearning } from './learning.mjs';
import { BrowserBridge } from './browser-bridge.mjs';
import { isSafari, prepareNative } from './native-port.mjs';
import { permittedTabs } from './matching.mjs';

const observer = new RedirectObserver();
// Read once at startup: Safari can update the manifest on disk before this background reloads.
const extensionVersion = chrome.runtime.getManifest().version;
const connectPort = prepareNative(chrome, undefined, extensionVersion);
const ready = start();
// Safari has no history-state events; its tab URL updates stand in for them.
const withoutHistoryEvents = !chrome.webNavigation.onHistoryStateUpdated;

async function start() {
  const [policy, platform] = await Promise.all([
    fetch(chrome.runtime.getURL('learning-policy.json')).then(response => response.json()),
    chrome.runtime.getPlatformInfo(),
  ]);
  observer.maxSources = policy.maxRedirectSources;
  await chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  const saved = await chrome.storage.local.get('learning');
  const bridge = new BrowserBridge(policy, {
    platform: platform.os,
    connectPort,
    queryTabs: () => permittedTabs(chrome),
    learningState: saved.learning,
    saveLearning: learning => chrome.storage.local.set({ learning }),
    resetLearning: () => { observer.tabs.clear(); observer.pending.clear(); },
    badge: text => { void (chrome.action ?? chrome.browserAction).setBadgeText({ text }); },
    extensionVersion,
    reload: async version => {
      const installed = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
      const manifest = await installed.json();
      if (manifest.version !== version) {
        throw new Error('Load Link Reuse from the installed ' + (platform.os === 'win'
          ? 'scoop/apps/link-reuse/current/extension'
          : 'Link Reuse.app/Contents/Resources/extension') + ' folder to receive updates.');
      }
      chrome.runtime.reload();
    },
  });
  return { policy, bridge };
}

/**
 * Chromium adds content scripts only to pages that load after an install or update, so a page left open across an update
 * would hand its links straight to the browser. Add them to the open tabs; the scripts an update orphaned there can no
 * longer reach the extension and leave each click to the new ones. Safari re-injects the scripts itself.
 */
async function injectOpenTabs() {
  for (const { matches, js, all_frames: allFrames = false } of chrome.runtime.getManifest().content_scripts) {
    for (const tab of await chrome.tabs.query({ url: matches, discarded: false })) {
      void chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames }, files: js, injectImmediately: true })
        .catch(() => {});
    }
  }
}
if (!isSafari(chrome)) {
  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install' || reason === 'update') void injectOpenTabs();
  });
}

const changed = () => void ready.then(({ bridge }) => bridge.changed());
const redirects = aliases => aliases.map(alias => ({ kind: 'redirect', ...alias }));

// Learning from navigation

/** Learns from a top-level navigation event; operation is 'before', 'committed' or 'history'. */
function navigate(event, operation) {
  if (event.frameId !== 0 || event.documentLifecycle === 'prerender') return;
  void ready.then(({ policy, bridge }) => {
    if (!allowsLearning(event.url, policy)) {
      observer.remove(event.tabId);
      bridge.changed();
      return;
    }
    bridge.observe(redirects(observer[operation](event) ?? []));
    const sameDocument = { documentId: event.documentId };
    // Without transition qualifiers, the new document's referrer is what confirms a client-side redirect.
    if (operation === 'committed' && withoutHistoryEvents && observer.tabs.get(event.tabId)?.redirectFrom) {
      void chrome.tabs.sendMessage(event.tabId, { type: 'document-context' }, sameDocument)
        .then(info => bridge.observe(redirects(observer.document({ ...event, ...info }))))
        .catch(() => {});
    }
    if (operation === 'history') {
      void chrome.tabs.sendMessage(event.tabId, { type: 'read-canonical' }, sameDocument).catch(() => {});
    }
  });
}

chrome.webNavigation.onBeforeNavigate.addListener(event => navigate(event, 'before'));
chrome.webNavigation.onCommitted.addListener(event => navigate(event, 'committed'));
chrome.webNavigation.onHistoryStateUpdated?.addListener(event => navigate(event, 'history'));
chrome.webNavigation.onReferenceFragmentUpdated?.addListener(event => navigate(event, 'history'));
chrome.webNavigation.onErrorOccurred.addListener(event => {
  if (event.frameId !== 0) return;
  observer.failed(event.tabId);
  changed();
});

// Tabs and windows

chrome.tabs.onRemoved.addListener(tabId => {
  observer.remove(tabId);
  changed();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  // Only a new address or a finished load can make learning stale; sleeping, waking and starting a load cannot.
  if (change.url || change.status === 'complete') changed();
  if (change.url && withoutHistoryEvents) {
    void chrome.webNavigation.getFrame({ tabId, frameId: 0 }).then(frame => {
      if (frame?.documentId && frame.url === change.url) navigate({ ...frame, tabId, frameId: 0 }, 'history');
    }).catch(() => {});
  }
});
chrome.tabs.onActivated.addListener(() => { void ready.then(({ bridge }) => bridge.activity()); });
chrome.runtime.onStartup.addListener(changed);
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId < 0) return;
  const focusedAt = performance.now();
  void ready.then(async ({ bridge }) => {
    const window = await chrome.windows.get(windowId);
    if (!window.incognito && window.type === 'normal') bridge.focused(windowId, focusedAt);
  }).catch(() => {});
});
chrome.windows.onRemoved.addListener(windowId => { void ready.then(({ bridge }) => bridge.forgetWindow(windowId)); });

// Messages from pages and the popup

const skipReasons = new Set(['disabled', 'prevented', 'other', 'button', 'anchor', 'target']);

/** What a page needs to compute a link's keys itself: the URL rules, without the learning limits. */
const pageRules = ({ maxURLBytes, noiseQueryKeys, noiseQueryPrefixes, identityRules }) =>
  ({ maxURLBytes, noiseQueryKeys, noiseQueryPrefixes, identityRules });

/** A page's request: its keys when it starts, or a link to route. */
async function answerPage(message, sender, { bridge, policy }) {
  const topFrame = sender.frameId === 0;
  if (message.type === 'page-keys') {
    return topFrame ? { keys: await bridge.keysFor(sender.tab), rules: pageRules(policy) } : null;
  }
  // A same-tab link only ever switches to another tab; otherwise the page loads it itself.
  const sameTab = message.type === 'page-navigate';
  if (sameTab && !topFrame) return { result: 'none' };
  const opening = sameTab
    ? { sourceTabId: sender.tab.id, reuseOnly: true }
    : { sourceTabId: sender.tab.id, active: message.active !== false };
  try {
    const reply = await bridge.open(message.url, opening);
    if (reply.result !== 'none') bridge.trace('page-' + reply.result, sender.tab.id);
    return reply;
  } catch (error) {
    bridge.trace('page-failed', sender.tab.id);
    throw error;
  }
}

/** A page's canonical report, which also catches an address rewrite or redirect the navigation events missed. */
function learnFromPage(message, sender, bridge) {
  const tab = observer.tabs.get(sender.tab.id);
  if (tab?.documentId !== sender.documentId || sender.tab.url !== message.url) return;
  const page = { tabId: sender.tab.id, documentId: sender.documentId, url: message.url };
  if (tab.url !== message.url) bridge.observe(redirects(observer.history(page)));
  bridge.observe(redirects(observer.document({ ...page, referrer: message.referrer })));
  const destination = canonicalDestination(message.url, message.hrefs);
  bridge.observe([{ kind: 'canonical', source: message.url, destination }]);
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const tab = sender.tab;
  const topFrame = tab && sender.frameId === 0;
  switch (message.type) {
    case 'page-link':
    case 'page-navigate':
    case 'page-keys':
      if (!tab || tab.incognito) return;
      void ready.then(context => answerPage(message, sender, context))
        .then(respond, error => respond({ error: error.message }));
      return true;
    case 'page-skip':
      if (!tab || !skipReasons.has(message.reason)) return;
      void ready.then(({ bridge }) => bridge.trace('page-skip-' + message.reason, tab.id));
      return;
    case 'canonical':
      if (topFrame) void ready.then(({ bridge }) => learnFromPage(message, sender, bridge));
      return;
    case 'interaction':
      if (topFrame) void ready.then(() => observer.interact(tab.id, sender.documentId));
      return;
    case 'status':
    case 'clear-learning':
      if (tab) return;
      void ready.then(async ({ bridge }) => {
        if (message.type === 'clear-learning') await bridge.clear();
        return bridge.status();
      }).then(respond, error => respond({ connected: false, lastError: error.message }));
      return true;
  }
});
