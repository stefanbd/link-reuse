import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LiveLearning, routeToTab } from '../extension/matching.mjs';
import { BrowserBridge as WindowsBridge } from '../extension/browser-bridge.mjs';
import { urlRules, fingerprint } from '../extension/url-rules.mjs';
import { reuseIndex, pageKeys } from '../extension/page-keys.mjs';

const prints = (...keys) => keys.map(fingerprint).sort((left, right) => left - right);
import { safariTransport } from './safari-support.mjs';
import { prepareNative } from '../extension/native-port.mjs';

const policy = JSON.parse(readFileSync(new URL('../extension/learning-policy.json', import.meta.url)));
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
const place = 'https://www.google.com/maps/place/Restaurant/@42,23,17z/data=!4m6!3m5!1s0x40aa8541e3d5da63:0x5353ef1753a6f43c!8m2!3d42';
const photo = 'https://www.google.com/maps/place/Restaurant/@42,23,3a/data=!3m8!1sPHOTO!4m7!3m6!1s0x40aa8541e3d5da63:0x5353ef1753a6f43c!8m2!3d42';

function slackLink(target, extra = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const hint = [encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ iss: 'https://slack.com', 'https://slack.com/target_uri': target, ...extra }), 'example'].join('.');
  return 'https://slack.com/openid/connect/login_initiate_redirect?login_hint=' + hint;
}

function browser(initial, windows = [{ id: 1, focused: true }], lastFocusedId = windows[0]?.id) {
  const tabs = initial.map((tab, index) => ({ id: index + 1, index, windowId: 1, status: 'complete', incognito: false, ...tab }));
  const calls = [];
  return { tabs, calls, api: {
    runtime: { getURL: value => 'chrome-extension://test/' + value },
    windows: {
      async getAll() { return windows; },
      async getLastFocused() { return windows.find(window => window.id === lastFocusedId); },
      async update(id, change) { calls.push(['window', id, change]); },
      async create(change) { calls.push(['create-window', change]); const tab = { id: tabs.length + 1, windowId: 1, status: 'loading', pendingUrl: change.url }; tabs.push(tab); windows.push({ id: 1, focused: true, state: 'normal' }); return { id: 1, tabs: [tab] }; },
    },
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
      async update(id, change) { calls.push(['focus', id, change]); },
      async move(id, change) { calls.push(['move', id, change]); },
      async create(change) { calls.push(['create', change]); const tab = { id: tabs.length + 1, windowId: change.windowId, status: 'loading', pendingUrl: change.url }; tabs.push(tab); return tab; },
    },
  } };
}

function nativePort(ready = { type: 'ready' }) {
  const messages = [], disconnected = [];
  return {
    sent: [],
    onMessage: { addListener(fn) { messages.push(fn); } },
    onDisconnect: { addListener(fn) { disconnected.push(fn); } },
    emit(message) { for (const listener of messages) listener(message); },
    disconnect() { for (const listener of disconnected) listener(); },
    postMessage(message) {
      this.sent.push(message);
      if (message.type === 'hello') queueMicrotask(() => ready ? this.emit(ready) : this.disconnect());
      if (message.type === 'authorize-create') queueMicrotask(() => this.emit({ type: 'create-authorized', id: message.id }));
    },
  };
}

function timers(context) {
  const pending = new Map();
  let sequence = 0;
  context.mock.method(globalThis, 'setTimeout', (fn, delay) => { const id = ++sequence; pending.set(id, { fn, delay }); return id; });
  context.mock.method(globalThis, 'clearTimeout', id => pending.delete(id));
  return pending;
}

function learningSession() {
  let state;
  return {
    read: () => structuredClone(state),
    async save(records) { state = structuredClone(records); },
  };
}

function sessionBridge(h, session, extra = {}) {
  const port = nativePort();
  const bridge = new WindowsBridge(policy, { connectPort: () => port, queryTabs: h.api.tabs.query,
    browserAPI: h.api, badge() {}, resetLearning() {}, learningState: session.read(),
    saveLearning: records => session.save(records), ...extra });
  return { bridge, port };
}

async function settleBridge(bridge) {
  await new Promise(setImmediate);
  await bridge.saving;
}

test('sleeping and unloaded tabs are selected without content scripts, reloads or replacement tabs', async () => {
  for (const state of [{ frozen: true }, { discarded: true, status: 'unloaded' },
    { discarded: true, status: 'unloaded', url: '', pendingUrl: photo }]) {
    const h = browser([{ url: photo, active: false, ...state }]);
    assert.deepEqual(await routeToTab(photo, new LiveLearning(policy), h.api), { result: 'focused' });
    assert.deepEqual(h.calls, [['focus', 1, { active: true }]]);
    assert.equal(h.tabs.length, 1);
  }
});

test('a restarted worker restores learned links and reuses sleeping redirect and canonical destinations', async () => {
  const h = browser([{ url: 'https://example.test/item', frozen: true },
    { url: 'https://shop.test/products/42/reviews', discarded: true, status: 'unloaded' }]);
  const session = learningSession();
  const first = sessionBridge(h, session).bridge;
  first.observe([{ kind: 'redirect', source: 'https://example.test/short', destination: h.tabs[0].url },
    { kind: 'canonical', source: h.tabs[1].url, destination: 'https://shop.test/products/42' }]);
  await settleBridge(first);
  assert.equal(session.read()?.length, 2);
  const second = sessionBridge(h, session);
  await second.bridge.connect();
  second.port.emit({ type: 'open', id: 'redirect', url: 'https://example.test/short' });
  second.port.emit({ type: 'open', id: 'canonical', url: 'https://shop.test/products/42' });
  await second.bridge.serial;
  assert.deepEqual(second.port.sent.filter(message => message.type === 'result').map(message => message.result), ['focused', 'focused']);
  assert.equal(h.tabs.length, 2);
  assert.equal(h.calls.some(call => call[0].startsWith('create')), false);
});

test('restored learning is pruned against current tabs before it can match', async () => {
  const h = browser([{ url: 'https://example.test/live' }]);
  const session = learningSession();
  const first = sessionBridge(h, session).bridge;
  first.observe([{ kind: 'redirect', source: 'https://example.test/short', destination: h.tabs[0].url }]);
  await settleBridge(first);
  for (const tabs of [[{ id: 1, url: 'https://example.test/elsewhere', status: 'complete' }],
    [{ id: 1, url: 'https://example.test/live', discarded: true, status: 'unloaded', incognito: true }]]) {
    const current = browser(tabs);
    const restarted = sessionBridge(current, session).bridge;
    assert.deepEqual(await routeToTab('https://example.test/short', restarted.learning, current.api), { result: 'opened' });
    assert.equal(restarted.learning.records.size, 0);
  }
});

test('learning restored before the browser has restored its windows waits for them', async () => {
  const h = browser([{ url: 'https://example.test/live' }]);
  const session = learningSession();
  const first = sessionBridge(h, session).bridge;
  first.observe([{ kind: 'redirect', source: 'https://example.test/short', destination: h.tabs[0].url }]);
  await settleBridge(first);
  for (const [restored, kept] of [['https://example.test/live', 1], ['https://example.test/elsewhere', 0]]) {
    const starting = browser([]);
    const restarted = sessionBridge(starting, session).bridge;
    await settleBridge(restarted);
    assert.equal(restarted.learning.records.size, 1);
    assert.equal(session.read().length, 1);
    starting.tabs.push({ id: 1, index: 0, windowId: 1, status: 'unloaded', discarded: true, incognito: false, url: restored });
    restarted.changed();
    await settleBridge(restarted);
    assert.equal(restarted.learning.records.size, kept);
    assert.equal(session.read().length, kept);
    if (kept) assert.deepEqual(await routeToTab('https://example.test/short', restarted.learning, starting.api), { result: 'focused' });
  }
});

test('owned sign-in tabs survive worker restarts without saving their authentication URLs', async context => {
  const pending = timers(context);
  const entry = 'https://example-production.snowflakecomputing.com/console/login#/';
  const h = browser([]);
  const session = learningSession();
  const first = sessionBridge(h, session).bridge;
  await routeToTab(entry, first.learning, h.api);
  Object.assign(h.tabs[0], { pendingUrl: undefined,
    url: 'https://example-production.snowflakecomputing.com/oauth/authorize?state=private&code_challenge=private',
    discarded: true, status: 'unloaded' });
  first.changed();
  await settleBridge(first);
  assert.deepEqual(session.read(), [{ kind: 'launch', tabId: 1, entry: 'snowflake-account:example/production' }]);
  const second = sessionBridge(h, session).bridge;
  assert.deepEqual(await routeToTab(entry, second.learning, h.api), { result: 'focused' });
  assert.equal(h.tabs.length, 1);
});

test('forgetting learned links waits for queued session writes and cannot restore a cleared alias', async () => {
  const h = browser([{ url: 'https://example.test/live' }]);
  const session = learningSession();
  let release;
  const first = sessionBridge(h, session, { saveLearning: async records => {
    await new Promise(resolve => { release = resolve; });
    await session.save(records);
  } }).bridge;
  first.observe([{ kind: 'redirect', source: 'https://example.test/short', destination: h.tabs[0].url }]);
  const saving = settleBridge(first);
  await new Promise(setImmediate);
  assert.equal(typeof release, 'function');
  first.saveLearning = records => session.save(records);
  const clearing = first.clear();
  release();
  await saving;
  await clearing;
  assert.deepEqual(session.read(), []);
  const second = sessionBridge(h, session).bridge;
  assert.deepEqual(await routeToTab('https://example.test/short', second.learning, h.api), { result: 'opened' });
});

test('restoring a session reapplies privacy and storage limits', () => {
  const learning = new LiveLearning({ ...policy, maxRecords: 2, maxCacheBytes: 500 });
  learning.restore([
    { kind: 'redirect', source: 'https://example.test/first', destination: 'https://example.test/live' },
    { kind: 'redirect', source: 'https://example.test/callback?code=private', destination: 'https://example.test/live' },
  ]);
  assert.equal(learning.records.size, 1);
  assert.equal(JSON.stringify(learning.snapshot()).includes('private'), false);
  learning.restore(Array.from({ length: 100 }, (_, i) => ({ kind: 'canonical',
    source: `https://example.test/${i}/reviews`, destination: `https://example.test/${i}` })));
  assert.ok(learning.records.size <= 2 && learning.bytes <= 500);
});

test('restoring during a pending navigation retains the committed page only until navigation settles', () => {
  const learning = new LiveLearning(policy);
  learning.restore([{ kind: 'redirect', source: 'https://example.test/short', destination: 'https://example.test/item' }]);
  learning.prune([{ id: 1, url: 'https://example.test/item', pendingUrl: 'https://example.test/other', status: 'loading' }]);
  assert.equal(learning.records.size, 1);
  learning.prune([{ id: 1, url: 'https://example.test/other', status: 'complete' }]);
  assert.equal(learning.records.size, 0);
});

test('restored learning waits for a tab list with a web page: a new tab page or a private tab is not the restored session', () => {
  const learning = new LiveLearning(policy);
  learning.restore([{ kind: 'redirect', source: 'https://example.test/short', destination: 'https://example.test/item' }]);
  learning.prune([{ id: 1, url: 'chrome://newtab/', status: 'complete' },
    { id: 2, url: 'https://example.test/other', status: 'complete', incognito: true }]);
  assert.equal(learning.records.size, 1);
  learning.prune([{ id: 1, url: 'https://example.test/other', status: 'complete' }]);
  assert.equal(learning.records.size, 0);
});

test('cache write failures are reported and retried on the next change', async () => {
  const h = browser([{ url: 'https://example.test/live' }]);
  const session = learningSession();
  const { bridge } = sessionBridge(h, session, { saveLearning: async () => { throw new Error('Storage unavailable.'); } });
  bridge.observe([{ kind: 'redirect', source: 'https://example.test/short', destination: h.tabs[0].url }]);
  await assert.rejects(settleBridge(bridge), /Storage unavailable/);
  const status = bridge.status();
  assert.match(status.storageError, /Could not save learned links/);
  bridge.saveLearning = records => session.save(records);
  bridge.changed();
  await settleBridge(bridge);
  assert.equal(bridge.status().storageError, '');
  assert.equal(session.read().length, 1);
});

test('selecting a tab runs no maintenance pass; opening an account launcher, which is remembered, does', async () => {
  const h = browser([{ url: 'https://example.test/item' }]);
  let queries = 0;
  const { bridge } = sessionBridge(h, learningSession(), { queryTabs: async () => { queries++; return h.api.tabs.query(); } });
  await settleBridge(bridge);
  const before = queries;
  assert.deepEqual(await bridge.open('https://example.test/item'), { result: 'focused' });
  await settleBridge(bridge);
  assert.equal(queries, before);
  assert.deepEqual(await bridge.open('https://example-production.snowflakecomputing.com/console/login#/'), { result: 'opened' });
  await settleBridge(bridge);
  assert.equal(queries, before + 1);
});

test('a frozen or discarded tab in front gets no list: it asks when it wakes', async () => {
  const h = browser([{ url: 'https://example.test/a', active: true, frozen: true },
    { url: 'https://example.test/b', active: true, windowId: 2, discarded: true },
    { url: 'https://example.test/c', active: true, windowId: 3 }]);
  const sent = [];
  h.api.tabs.sendMessage = async id => { sent.push(id); };
  const { bridge } = sessionBridge(h, learningSession());
  bridge.publish(h.tabs);
  await new Promise(setImmediate);
  assert.deepEqual(sent, [3]);
});

test('the greeting says whether this profile has focus, and a focus change made meanwhile follows it', async () => {
  for (const [windows, focused] of [[[{ id: 1, focused: true }], true], [[{ id: 1, focused: true, incognito: true }], false],
    [[{ id: 1, focused: false }], false]]) {
    const h = browser([], windows);
    let release;
    h.api.windows.getAll = () => new Promise(resolve => { release = resolve; });
    const port = nativePort({ type: 'ready', extensionVersion: '3.2.4' });
    const bridge = new WindowsBridge(policy, { connectPort: () => port, queryTabs: async () => [], browserAPI: h.api,
      badge() {}, resetLearning() {}, extensionVersion: '3.2.4' });
    bridge.focused(1, 1);
    await new Promise(setImmediate);
    assert.deepEqual(port.sent, []);
    release(windows);
    await bridge.ready;
    await new Promise(setImmediate);
    assert.deepEqual(port.sent.map(message => message.type), ['hello', 'activity']);
    assert.deepEqual(port.sent[0], { type: 'hello', extensionVersion: '3.2.4', focused });
  }
});

test('the popup shows learning at once while the app is still connecting', () => {
  const silent = { onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage() {}, disconnect() {} };
  const bridge = new WindowsBridge(policy, { connectPort: () => silent, queryTabs: async () => [], badge() {},
    resetLearning() {}, learningState: [{ kind: 'redirect', source: 'https://example.test/short', destination: 'https://example.test/item' }] });
  const status = bridge.status();
  assert.equal(status.connected, false);
  assert.equal(status.connecting, true);
  assert.equal(status.stats.records, 1);
});

test('why the browser could not start the helper reaches the popup', async () => {
  const disconnects = [];
  const api = { runtime: { getURL: () => 'chrome-extension://test/', connectNative: () => ({
    onMessage: { addListener() {} }, onDisconnect: { addListener: fn => disconnects.push(fn) }, postMessage() {}, disconnect() {} }) },
  windows: { async getAll() { return []; } } };
  const bridge = new WindowsBridge(policy, { connectPort: prepareNative(api), queryTabs: async () => [], browserAPI: api,
    badge() {}, resetLearning() {} });
  api.runtime.lastError = { message: 'Specified native messaging host not found.' };
  for (const fn of disconnects) fn();
  await assert.rejects(bridge.ready);
  assert.match(bridge.lastError, /\(Specified native messaging host not found\.\)/);
});

test('unchanged tab activity does not rewrite session learning', async () => {
  const h = browser([{ url: 'https://example.test/live' }]);
  const session = learningSession();
  let writes = 0;
  const { bridge } = sessionBridge(h, session, { saveLearning: async records => { writes++; await session.save(records); } });
  bridge.observe([{ kind: 'redirect', source: 'https://example.test/short', destination: h.tabs[0].url }]);
  await settleBridge(bridge);
  for (const state of [{ frozen: true }, { frozen: false, discarded: true, status: 'unloaded' }]) {
    Object.assign(h.tabs[0], state);
    bridge.changed();
    await settleBridge(bridge);
  }
  assert.equal(writes, 1);
  h.tabs.length = 0;
  bridge.changed();
  await settleBridge(bridge);
  assert.equal(writes, 2);
  assert.deepEqual(session.read(), []);
});

for (const mode of ['win', 'mac', 'safari']) test(`the ${mode} background restores local learning with an empty session store before external and webpage opens`, async context => {
  const platform = mode === 'safari' ? 'mac' : mode;
  const pending = timers(context);
  const h = browser([{ url: 'https://example.test/live', status: 'unloaded', discarded: true }]);
  const port = nativePort({ type: 'ready', extensionVersion: '3.2.4' });
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); },
    emit(...args) { for (const fn of this.listeners) fn(...args); } });
  let release;
  let saved;
  let accessLevel;
  const queries = [];
  const injected = [];
  const previousChrome = globalThis.chrome;
  const previousSocket = globalThis.WebSocket;
  const safari = mode === 'safari' ? safariTransport() : null;
  if (safari) globalThis.WebSocket = safari.Socket;
  globalThis.chrome = {
    runtime: { async getPlatformInfo() { return { os: platform }; }, getURL: value => (mode === 'safari' ? 'safari-web-extension://test/' : 'https://extension.test/') + value,
      getManifest: () => ({ version: '3.2.4', content_scripts: manifest.content_scripts }),
      connectNative: () => safari ? safari.api.runtime.connectNative() : port, onStartup: event(), onMessage: event(), onInstalled: event(),
      async sendNativeMessage(_application, message) {
        if (message.type === 'hello') return { type: 'ready' };
        if (message.type === 'claim') return { type: 'receipt', result: 'accepted' };
        port.sent.push(message); return { type: 'receipt' };
      } },
    storage: { local: { async setAccessLevel(value) { accessLevel = value.accessLevel; },
      get: () => new Promise(resolve => { release = resolve; }), async set(value) { saved = structuredClone(value); } },
      session: { async get() { return {}; }, async set() { throw new Error('Session storage must not own learned links.'); } } },
    permissions: { getAll: async () => ({ origins: ['<all_urls>'] }) },
    tabs: { ...h.api.tabs, onUpdated: event(), onRemoved: event(), onActivated: event(), onCreated: event(),
      async query(filter) { queries.push(filter); return [{ id: 7 }]; },
      sendMessage() { throw new Error('Sleeping tab content must not be contacted to match it.'); } },
    scripting: { async executeScript(details) { injected.push(details); } },
    windows: { ...h.api.windows, onFocusChanged: event(), onRemoved: event() },
    webNavigation: Object.fromEntries(['onBeforeNavigate', 'onCommitted', 'onHistoryStateUpdated',
      'onReferenceFragmentUpdated', 'onErrorOccurred'].map(name => [name, event()])),
    action: { async setBadgeText() {} },
  };
  context.mock.method(globalThis, 'fetch', async () => ({ async json() { return policy; } }));
  try {
    if (mode === 'safari') { delete chrome.webNavigation.onHistoryStateUpdated; delete chrome.webNavigation.onReferenceFragmentUpdated; }
    await import('../extension/background.mjs?session-restore=' + mode);
    await new Promise(setImmediate);
    assert.equal(accessLevel, 'TRUSTED_CONTEXTS');
    // Chromium leaves tabs open across an install or update without content scripts; Safari re-injects them itself.
    chrome.runtime.onInstalled.emit({ reason: 'chrome_update' });
    chrome.runtime.onInstalled.emit({ reason: 'update' });
    await new Promise(setImmediate);
    const chromium = mode !== 'safari';
    assert.deepEqual(queries, chromium ? manifest.content_scripts.map(({ matches }) => ({ url: matches, discarded: false })) : []);
    assert.deepEqual(injected, chromium ? manifest.content_scripts.map(script =>
      ({ target: { tabId: 7, allFrames: script.all_frames === true }, files: script.js, injectImmediately: true })) : []);
    let tabQueries = 0;
    chrome.tabs.query = (...args) => { tabQueries++; return h.api.tabs.query(...args); };
    chrome.tabs.onUpdated.emit(1, { discarded: true, status: 'unloaded' });
    chrome.runtime.onStartup.emit();
    chrome.webNavigation.onCommitted.emit({ frameId: 0, tabId: 1, url: h.tabs[0].url, documentId: 'early' });
    chrome.runtime.onMessage.emit({ type: 'canonical', url: h.tabs[0].url, hrefs: ['https://example.test/live?view=main'] },
      { tab: h.tabs[0], frameId: 0, documentId: 'early' }, () => {});
    assert.equal(pending.size, 0);
    if (mode === 'safari') chrome.runtime.getManifest = () => ({ version: '3.2.5' });
    release({ learning: [{ kind: 'redirect', source: 'https://example.test/short', destination: h.tabs[0].url }] });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    const request = { type: 'open', id: 'first-after-idle', url: 'https://example.test/short' };
    if (safari) safari.emit(request); else port.emit(request);
    // The tab isn't selected yet, so the extension asks the app's go-ahead first: one more round trip.
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.deepEqual((safari?.sent ?? port.sent).find(message => message.type === 'result' && message.id === 'first-after-idle'),
      { type: 'result', id: 'first-after-idle', result: 'focused' });
    assert.equal(h.tabs.length, 1);
    assert.equal(saved.learning.length, 2);
    const fromPage = { tab: { ...h.tabs[0] }, frameId: 2 };
    const send = message => new Promise(resolve => chrome.runtime.onMessage.emit(message, fromPage, resolve));
    assert.deepEqual(await send({ type: 'page-link', url: 'https://example.test/short', active: false }), { result: 'focused' });
    assert.equal(h.tabs.length, 1);
    h.tabs.length = 0;
    chrome.tabs.onRemoved.emit(1);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.deepEqual(saved.learning, []);
    // Sleeping, waking and starting a load run no pass; a finished load does.
    const passes = tabQueries;
    chrome.tabs.onActivated.emit({ tabId: 1 });
    chrome.tabs.onUpdated.emit(1, { discarded: true });
    chrome.tabs.onUpdated.emit(1, { frozen: true });
    chrome.tabs.onUpdated.emit(1, { status: 'loading' });
    await new Promise(setImmediate);
    assert.equal(tabQueries, passes);
    chrome.tabs.onUpdated.emit(1, { status: 'complete' });
    await new Promise(setImmediate);
    assert.equal(tabQueries, passes + 1);
  } finally {
    globalThis.WebSocket = previousSocket;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test('Windows focuses the existing deeper view without navigating or creating a tab', async () => {
  const h = browser([{ url: photo, active: true }]);
  assert.deepEqual(await routeToTab(place, new LiveLearning(policy), h.api), { result: 'focused' });
  assert.deepEqual(h.calls, []);
  assert.equal(h.tabs[0].url, photo);
});

test('repeated opens of the selected visible tab complete without redundant activation calls', async () => {
  const h = browser([{ url: photo, active: true }]);
  h.api.tabs.update = h.api.windows.update = () => { throw new Error('Redundant activation'); };
  const { bridge } = sessionBridge(h, learningSession());
  for (let i = 0; i < 3; i++) assert.deepEqual(await bridge.open(place), { result: 'focused' });
  assert.deepEqual(h.calls, []);
  assert.equal(h.tabs.length, 1);
});

test('tab lookup runs while window lookup is pending and a known focused window skips the fallback query', async () => {
  const h = browser([{ url: photo, active: true }]);
  let release, queried = false;
  h.api.windows.getAll = () => new Promise(resolve => { release = resolve; });
  h.api.windows.getLastFocused = () => { throw new Error('Unnecessary last-focused query'); };
  const query = h.api.tabs.query;
  h.api.tabs.query = async () => { queried = true; return query(); };
  const opening = routeToTab(place, new LiveLearning(policy), h.api);
  assert.equal(queried, true);
  release([{ id: 1, focused: true }]);
  assert.deepEqual(await opening, { result: 'focused' });
  assert.deepEqual(h.calls, []);
});

test('external opens need no last-focused query when only one eligible window remains', async () => {
  for (const windows of [
    [{ id: 1, focused: false, state: 'normal' }],
    [{ id: 1, focused: false, state: 'minimized' }],
    [{ id: 1, focused: false, state: 'normal' }, { id: 2, state: 'minimized' }],
    [{ id: 1, focused: false, state: 'normal' }, { id: 2, incognito: true }],
  ]) {
    const h = browser([{ url: photo, active: true }], windows);
    h.api.windows.getLastFocused = () => { throw new Error('Unnecessary last-focused query'); };
    assert.deepEqual(await routeToTab(place, new LiveLearning(policy), h.api), { result: 'focused' });
    assert.equal(h.calls.some(call => call[0] === 'create'), false);
  }
});

test('opening with no browser windows creates one without a last-focused query', async () => {
  const h = browser([], []);
  h.api.windows.getLastFocused = () => { throw new Error('No eligible windows'); };
  assert.deepEqual(await routeToTab(place, new LiveLearning(policy), h.api), { result: 'opened' });
  assert.equal(h.calls[0][0], 'create-window');
});

test('a new tab whose window will not come forward still counts as opened, so nothing invites opening it twice', async () => {
  const h = browser([{ url: 'https://example.test/other', active: true }], [{ id: 1, focused: false, state: 'normal' }]);
  h.api.windows.update = async () => { throw new Error('The window stayed behind'); };
  assert.deepEqual(await routeToTab('https://example.test/new', new LiveLearning(policy), h.api), { result: 'opened' });
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1);
});

test('a tab that navigates during concurrent window lookup still fails final revalidation', async () => {
  const h = browser([{ url: photo, active: false }]);
  let release;
  h.api.windows.getAll = () => new Promise(resolve => { release = resolve; });
  const opening = routeToTab(place, new LiveLearning(policy), h.api);
  h.tabs[0].url = 'https://unrelated.test/';
  release([{ id: 1, focused: true }]);
  await assert.rejects(opening, /matching tab changed/);
  assert.deepEqual(h.calls, []);
});

test('an app link changes nothing before the go-ahead from the app; a tab already in front needs none', async () => {
  const h = browser([]);
  let release;
  const opening = routeToTab(place, new LiveLearning(policy), h.api, new Map(), {
    beforeAct: () => new Promise(resolve => { release = resolve; }),
  });
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, []);
  release();
  assert.deepEqual(await opening, { result: 'opened' });
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  // Selecting a tab is a change too: it waits the same way.
  h.calls.length = 0;
  const selecting = routeToTab(place, new LiveLearning(policy), h.api, new Map(), {
    beforeAct: () => new Promise(resolve => { release = resolve; }),
  });
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, []);
  release();
  assert.deepEqual(await selecting, { result: 'focused' });
  assert.deepEqual(h.calls, [['focus', 1, { active: true }]]);
  // Already selected in the focused window: nothing to change, nothing to ask.
  h.tabs[0].active = true;
  h.calls.length = 0;
  assert.deepEqual(await routeToTab(place, new LiveLearning(policy), h.api, new Map(), {
    beforeAct() { throw new Error('Nothing changes, so nothing is asked'); },
  }), { result: 'focused' });
  assert.deepEqual(h.calls, []);
});

test('a Chromium helper that ends while a link waits for its go-ahead leaves the browser unchanged', async () => {
  const h = browser([]);
  const port = nativePort();
  port.postMessage = function (message) {
    this.sent.push(message);
    if (message.type === 'hello') queueMicrotask(() => this.emit({ type: 'ready' }));
    if (message.type === 'authorize-create') queueMicrotask(() => this.disconnect());
  };
  const bridge = new WindowsBridge(policy, { connectPort: () => port, queryTabs: h.api.tabs.query, browserAPI: h.api,
    badge() {}, resetLearning() {} });
  await bridge.ready;
  port.emit({ type: 'open', id: 'lost', url: 'https://example.test/new' });
  await bridge.serial;
  await new Promise(setImmediate);
  assert.deepEqual(h.calls, []);
});

test('in Safari, a link to a website the extension may not see is reported instead of opening a possible duplicate', async () => {
  const h = browser([]);
  h.api.runtime.getURL = value => 'safari-web-extension://test/' + value;
  h.api.permissions = { getAll: async () => ({ origins: ['https://allowed.test/*'] }),
    contains: async ({ origins }) => origins[0] === 'https://allowed.test/*' };
  await assert.rejects(routeToTab('https://example.test/item', new LiveLearning(policy), h.api),
    /Allow Link Reuse on example\.test in Safari Settings/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await routeToTab('https://allowed.test/item', new LiveLearning(policy), h.api), { result: 'opened' });
});

test('a tab that moves on while the go-ahead is pending is left alone', async () => {
  const h = browser([{ url: place }]);
  let release;
  const opening = routeToTab(place, new LiveLearning(policy), h.api, new Map(), {
    beforeAct: () => new Promise(resolve => { release = resolve; }),
  });
  await new Promise(setImmediate);
  h.tabs[0].url = 'https://unrelated.test/';
  release();
  await assert.rejects(opening, /matching tab changed/);
  assert.deepEqual(h.calls, []);
});

test('a refused or lost go-ahead changes nothing: no tab, window, selection or focus', async () => {
  for (const [tabs, windows] of [[[], [{ id: 1, focused: true }]], [[], []],
    [[{ url: place }], [{ id: 1, focused: false }]]]) {
    const h = browser(tabs, windows);
    await assert.rejects(routeToTab(place, new LiveLearning(policy), h.api, new Map(), {
      beforeAct() { throw new Error('Connection ended'); },
    }), /Connection ended/);
    assert.deepEqual(h.calls, []);
  }
});

test('a link behind a slow one waits its turn, however long, then opens', async context => {
  const pending = timers(context);
  const h = browser([]), original = h.api.windows.getAll;
  let release;
  h.api.windows.getAll = () => new Promise(resolve => { release = resolve; });
  const { bridge } = sessionBridge(h, learningSession());
  const first = bridge.open('https://example.test/first');
  await new Promise(setImmediate);
  h.api.windows.getAll = original;
  const second = bridge.open('https://example.test/second');
  await new Promise(setImmediate);
  assert.equal(h.tabs.length, 0);
  release(await original());
  assert.deepEqual(await first, { result: 'opened' });
  assert.deepEqual(await second, { result: 'opened' });
  assert.equal(h.tabs.length, 2);
  assert.equal(pending.size, 0);
});

test('place identity rules reject another place, conflicting identities and lookalike URLs', async () => {
  const candidates = [
    photo.replace('0x40aa8541e3d5da63:0x5353ef1753a6f43c', '0xabc:0xdef'),
    photo + '!4m6!3m5!1s0xabc:0xdef',
    photo.replace('www.google.com', 'www.google.com.example.test'),
    photo.replace('/maps/place/', '/maps/dir/'),
  ];
  for (const url of candidates) {
    const h = browser([{ url }]);
    assert.deepEqual(await routeToTab(place, new LiveLearning(policy), h.api), { result: 'opened' });
  }
});

test('external new links prefer the most recently used visible window over a last-focused minimized window', async () => {
  const windows = [
    { id: 1, focused: false, state: 'minimized' },
    { id: 2, focused: false, state: 'normal' },
    { id: 3, focused: false, state: 'maximized' },
  ];
  const h = browser([], windows, 1);
  await routeToTab('https://example.test/new', new LiveLearning(policy), h.api, new Map([[1, 30], [2, 10], [3, 20]]));
  assert.equal(h.calls.find(call => call[0] === 'create')[1].windowId, 3);
  assert.deepEqual(h.calls.find(call => call[0] === 'window'), ['window', 3, { focused: true }]);
});

test('an existing duplicate in a minimized window is restored instead of duplicated in the visible window', async () => {
  const h = browser([{ url: photo, active: true }], [
    { id: 1, focused: false, state: 'minimized' }, { id: 2, focused: false, state: 'normal' },
  ], 1);
  await routeToTab(place, new LiveLearning(policy), h.api, new Map([[2, 10], [1, 20]]));
  assert.deepEqual(h.calls, [['window', 1, { state: 'normal', focused: true }]]);
  assert.equal(h.tabs[0].url, photo);
});

test('when every window is minimized a new link restores the last-focused window', async () => {
  const h = browser([], [{ id: 1, state: 'minimized' }, { id: 2, state: 'minimized' }], 2);
  await routeToTab('https://example.test/new', new LiveLearning(policy), h.api);
  assert.equal(h.calls.find(call => call[0] === 'create')[1].windowId, 2);
  assert.deepEqual(h.calls.find(call => call[0] === 'window'), ['window', 2, { state: 'normal', focused: true }]);
});

test('learned redirects and canonicals stay only while the resource is open', () => {
  const learning = new LiveLearning(policy);
  learning.observe([{ kind: 'redirect', source: 'https://maps.test/search', destination: place }]);
  learning.prune([{ id: 1, url: photo, status: 'complete' }]);
  assert.ok(learning.equivalent('https://maps.test/search', photo));
  learning.prune([]);
  assert.equal(learning.records.size, 0);
  learning.observe([{ kind: 'canonical', source: 'https://shop.test/products/42/reviews', destination: 'https://shop.test/products/42' }]);
  assert.ok(learning.equivalent('https://shop.test/products/42', 'https://shop.test/products/42/reviews'));
  assert.equal(learning.equivalent('https://shop.test/products/43', 'https://shop.test/products/42/reviews'), false);
});

test('loading transitions keep learning until the new document settles', () => {
  const learning = new LiveLearning(policy);
  learning.observe([{ kind: 'redirect', source: 'https://example.test/short', destination: 'https://example.test/item' }]);
  learning.prune([{ id: 1, url: 'https://example.test/item', status: 'complete' }]);
  learning.prune([{ id: 1, url: 'https://example.test/item', pendingUrl: 'https://example.test/item/photos', status: 'loading' }]);
  assert.equal(learning.records.size, 1);
  learning.prune([{ id: 1, url: 'https://example.test/other', status: 'complete' }]);
  assert.equal(learning.records.size, 0);
});

test('sensitive URLs bypass reuse, private tabs are ignored, learning stays bounded', async () => {
  const learning = new LiveLearning({ ...policy, maxRecords: 3, maxCacheBytes: 600 });
  for (let i = 0; i < 100; i++) learning.observe([{ kind: 'redirect', source: `https://example.test/${i}`, destination: 'https://example.test/live' }]);
  assert.ok(learning.records.size <= 3 && learning.bytes <= 600);
  const sensitive = 'https://example.test/callback?code=secret';
  const h = browser([{ url: sensitive }, { url: 'https://example.test/private', incognito: true }]);
  await routeToTab(sensitive, learning, h.api);
  await routeToTab('https://example.test/private', learning, h.api);
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 2);
  learning.observe([{ kind: 'redirect', source: sensitive, destination: place }]);
  assert.equal([...learning.records.values()].some(value => value.source === sensitive), false);
});

test('OpenID sign-in redirects and login hints bypass learning and existing-tab reuse', async () => {
  const urls = ['https://slack.com/openid/connect/login_initiate_redirect', 'https://example.test/entry?login_hint=example'];
  const learning = new LiveLearning(policy);
  const h = browser(urls.map(url => ({ url })));
  for (const url of urls) {
    learning.observe([{ kind: 'redirect', source: url, destination: 'https://example.test/live' }]);
    await routeToTab(url, learning, h.api);
  }
  assert.equal(learning.records.size, 0);
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 2);
});

test('Slack sign-in link hints reuse the original destination without learning or navigating the token', async () => {
  const target = 'https://example.atlassian.net/browse/PROJECT-123';
  const learning = new LiveLearning(policy);
  const h = browser([{ url: target, active: true }]);
  for (const nonce of ['first-click', 'second-click']) {
    const url = slackLink(target, { nonce });
    learning.observe([{ kind: 'redirect', source: url, destination: target }]);
    assert.deepEqual(await routeToTab(url, learning, h.api), { result: 'focused' });
  }
  assert.equal(h.tabs.length, 1);
  assert.equal(h.tabs[0].url, target);
  assert.deepEqual(h.calls, []);
  assert.equal(learning.records.size, 0);
  assert.equal(learning.bytes, 0);
});

test('an unmatched Slack hint preserves the original sign-in navigation', async () => {
  const target = 'https://example.atlassian.net/browse/PROJECT-123';
  const url = slackLink(target);
  const h = browser([{ url: 'https://example.atlassian.net/browse/PROJECT-124' }]);
  assert.deepEqual(await routeToTab(url, new LiveLearning(policy), h.api), { result: 'opened' });
  assert.equal(h.calls.find(call => call[0] === 'create')[1].url, url);
});

test('Slack hint extraction rejects other endpoints, malformed data and sensitive or private targets', async () => {
  const target = 'https://example.test/item';
  const valid = slackLink(target);
  const cases = [
    valid.replace('https://slack.com/', 'http://slack.com/'),
    valid.replace('slack.com/', 'slack.com.example.test/'),
    valid.replace('slack.com/', 'someone@slack.com/'),
    valid.replace('login_initiate_redirect?', 'authorize?'),
    valid + '&login_hint=example',
    'https://slack.com/openid/connect/login_initiate_redirect?login_hint=invalid',
    slackLink(target, { iss: 'https://example.test' }),
    slackLink('https://example.test/callback?code=example'),
    slackLink('https://someone:example@example.test/item'),
    slackLink('javascript:alert(1)'),
    slackLink('https://example.test/' + 'a'.repeat(policy.maxURLBytes)),
  ];
  for (const url of cases) {
    const h = browser([{ url: target }, { url: 'https://example.test/callback?code=example' }]);
    assert.deepEqual(await routeToTab(url, new LiveLearning(policy), h.api), { result: 'opened' });
    assert.equal(h.calls.find(call => call[0] === 'create')[1].url, url);
  }
  const h = browser([{ url: target, incognito: true }]);
  assert.deepEqual(await routeToTab(valid, new LiveLearning(policy), h.api), { result: 'opened' });
});

test('window recency ignores delayed older focus observations and discards closed windows', () => {
  const bridge = new WindowsBridge(policy, { connectPort: nativePort, queryTabs: async () => [], badge() {} });
  bridge.focused(1, 30);
  bridge.focused(2, 20);
  bridge.focused(1, 10);
  assert.deepEqual([...bridge.windowFocusOrder], [[1, 30], [2, 20]]);
  bridge.forgetWindow(1);
  assert.deepEqual([...bridge.windowFocusOrder], [[2, 20]]);
});

test('a Snowflake account launcher preserves an existing Snowsight worksheet without learning the login URL', async () => {
  const launcher = 'https://example-marketing_test.snowflakecomputing.com/console/login#/';
  const view = 'https://app.snowflake.com/example/marketing_test/#/worksheets/worksheet-42';
  const learning = new LiveLearning(policy);
  const h = browser([{ url: view, active: true }]);
  assert.deepEqual(await routeToTab(launcher, learning, h.api), { result: 'focused' });
  assert.deepEqual(await routeToTab(slackLink(launcher), learning, h.api), { result: 'focused' });
  assert.deepEqual(h.calls, []);
  assert.equal(h.tabs[0].url, view);
  assert.equal(learning.records.size, 0);
});

test('final revalidation rejects a tab that changed into an unrelated authentication flow', async () => {
  const h = browser([{ url: 'https://app.snowflake.com/example/production/#/worksheets/42' }]);
  h.api.tabs.get = async id => ({ id, windowId: 1, incognito: false,
    url: 'https://example-production.snowflakecomputing.com/oauth/authorize?state=another-flow' });
  await assert.rejects(routeToTab('https://example-production.snowflakecomputing.com/console/login#/', new LiveLearning(policy), h.api), /matching tab changed/);
  assert.equal(h.calls.length, 0);
});

test('a launched Snowflake sign-in tab is reused through OAuth without retaining authentication URLs', async () => {
  const launcher = 'https://example-production.snowflakecomputing.com/console/login#/';
  const wrapper = slackLink(launcher);
  const oauth = 'https://example-production.snowflakecomputing.com/oauth/authorize?state=example&code_challenge=example';
  const learning = new LiveLearning(policy);
  const h = browser([]);
  await routeToTab(wrapper, learning, h.api);
  assert.deepEqual(await routeToTab(wrapper, learning, h.api), { result: 'focused' });
  Object.assign(h.tabs[0], { url: oauth, pendingUrl: undefined, status: 'complete' });
  assert.deepEqual(await routeToTab(launcher, learning, h.api), { result: 'focused' });
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(h.tabs[0].url, oauth);
  assert.equal(learning.settledURLs.size, 0);
  assert.deepEqual([...learning.records.values()].map(({ bytes, ...record }) => record), [{ tabId: 1, entry: 'snowflake-account:example/production' }]);
  Object.assign(h.tabs[0], { url: 'https://app.snowflake.com/example/production/#/worksheets/42' });
  assert.deepEqual(await routeToTab(launcher, learning, h.api), { result: 'focused' });
  h.tabs[0].url = 'https://example.test/unrelated';
  learning.prune(h.tabs);
  assert.equal(learning.records.size, 0);
});

test('Snowflake account matching keeps different accounts, deep links and OAuth requests separate', async () => {
  const launcher = 'https://example-production.snowflakecomputing.com/console/login#/';
  const target = 'https://app.snowflake.com/example/production/#/worksheets/42';
  const cases = [
    [launcher, 'https://app.snowflake.com/example/testing/#/worksheets/42'],
    [launcher, 'https://app.snowflake.com/another/production/'],
    [launcher, 'https://example-production.snowflakecomputing.com/oauth/authorize?state=unrelated-flow'],
    [launcher + '?state=example', target],
    ['https://example-production.snowflakecomputing.com/oauth/authorize?state=example', target],
    ['https://app.snowflake.com/example/production/#/worksheets/43', target],
    [launcher.replace('snowflakecomputing.com', 'snowflakecomputing.com.example.test'), target],
  ];
  for (const [request, open] of cases) {
    const h = browser([{ url: open }]);
    assert.deepEqual(await routeToTab(request, new LiveLearning(policy), h.api), { result: 'opened' });
    assert.equal(h.calls.find(call => call[0] === 'create')[1].url, request);
  }
  const h = browser([{ url: target, incognito: true }]);
  assert.deepEqual(await routeToTab(launcher, new LiveLearning(policy), h.api), { result: 'opened' });
});

test('Snowflake launched-tab records share storage limits and are pruned on closure or account changes', async () => {
  const learning = new LiveLearning({ ...policy, maxRecords: 2, maxCacheBytes: 600 });
  const h = browser([]);
  for (let i = 0; i < 5; i++) await routeToTab(`https://example-account${i}.snowflakecomputing.com/console/login#/`, learning, h.api);
  assert.equal(learning.records.size, 2);
  assert.ok(learning.bytes <= 600);
  h.tabs[4].pendingUrl = 'https://app.snowflake.com/example/another/';
  learning.prune(h.tabs);
  assert.equal(learning.records.size, 1);
  learning.prune([]);
  assert.equal(learning.records.size, 0);
  assert.equal(learning.bytes, 0);
});

test('a Snowflake launcher also tracks the first tab created in a new browser window', async () => {
  const launcher = 'https://example-production.snowflakecomputing.com/console/login#/';
  const h = browser([], []);
  const learning = new LiveLearning(policy);
  await routeToTab(launcher, learning, h.api);
  h.tabs[0].pendingUrl = 'https://example-production.snowflakecomputing.com/oauth/authorize?state=example';
  assert.deepEqual(await routeToTab(launcher, learning, h.api), { result: 'focused' });
  assert.equal(h.calls.filter(call => call[0] === 'create-window').length, 1);
  assert.equal(h.tabs.length, 1);
});

test('the same launch lifecycle handles a different service, including a Slack handoff, without site branches', async () => {
  const entry = 'https://login.helpdesk.test/workspaces/acme/';
  const rules = (value, policy) => {
    const result = urlRules(value, policy);
    try {
      const url = new URL(value);
      if (!['login.helpdesk.test', 'app.helpdesk.test'].includes(url.hostname)) return result;
      const workspace = url.pathname.match(/^\/workspaces\/([a-z]+)(?:\/|$)/)?.[1];
      if (workspace) {
        result.scope = 'helpdesk-workspace:' + workspace;
        if (url.href === entry) result.entry = result.scope;
      }
    } catch { }
    return result;
  };
  const learning = new LiveLearning(policy, rules);
  const h = browser([]);
  const wrapper = slackLink(entry);
  await routeToTab(wrapper, learning, h.api);
  assert.equal(h.calls.find(call => call[0] === 'create')[1].url, wrapper);
  h.tabs[0].pendingUrl = 'https://login.helpdesk.test/workspaces/acme/oauth?state=example';
  assert.deepEqual(await routeToTab(wrapper, learning, h.api), { result: 'focused' });
  Object.assign(h.tabs[0], { pendingUrl: undefined, url: 'https://app.helpdesk.test/workspaces/acme/tickets/42', status: 'complete' });
  assert.deepEqual(await routeToTab(entry, learning, h.api), { result: 'focused' });
  assert.deepEqual(await routeToTab('https://app.helpdesk.test/workspaces/acme/tickets/43', learning, h.api), { result: 'opened' });
  h.tabs[0].url = 'https://app.helpdesk.test/workspaces/other/tickets/42';
  learning.prune(h.tabs);
  assert.equal(learning.records.size, 0);
  assert.deepEqual(await routeToTab(entry, learning, h.api), { result: 'focused' });
  assert.equal(h.calls.filter(call => call[0] === 'focus').at(-1)[1], h.tabs[1].id);
  h.tabs.pop();
  assert.deepEqual(await routeToTab(entry, learning, h.api), { result: 'opened' });
});

test('resource identities are supplied by URL rules while generic matching keeps separate resources apart', async () => {
  const rules = value => {
    const url = new URL(value);
    const id = url.hostname === 'catalog.test' && url.pathname.match(/^\/items\/(\d+)(?:\/|$)/)?.[1];
    return id ? { identity: 'catalog-item:' + id } : {};
  };
  const learning = new LiveLearning(policy, rules);
  const h = browser([{ url: 'https://catalog.test/items/42/photos/9' }]);
  assert.deepEqual(await routeToTab('https://catalog.test/items/42', learning, h.api), { result: 'focused' });
  assert.deepEqual(await routeToTab('https://catalog.test/items/43', learning, h.api), { result: 'opened' });
});

test('each helper an update replaces says so and is reconnected at once, however many in a row', async context => {
  const pending = timers(context);
  const ports = [];
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {},
    connectPort: () => { const port = nativePort(); ports.push(port); return port; } });
  for (let update = 1; update <= 3; update++) {
    await bridge.ready;
    ports.at(-1).emit({ type: 'replaced' });
    ports.at(-1).disconnect();
    assert.equal(ports.length, update + 1);
  }
  await bridge.ready;
  assert.equal(bridge.connected, true);
  assert.equal(pending.size, 0);
});

test('a helper that ends by itself is retried when the user acts, never on a timer or a tab change', async context => {
  const pending = timers(context);
  const ports = [];
  let missing = false;
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {},
    connectPort: () => { const port = nativePort(missing ? null : undefined); ports.push(port); return port; } });
  const changeTabs = async () => { bridge.changed(); await settleBridge(bridge); };
  await bridge.ready;
  ports[0].disconnect();
  await changeTabs();
  assert.equal(ports.length, 1, 'a connection that ends without a replacement waits for the user');
  assert.equal(bridge.connected, false);
  bridge.activity();
  await bridge.ready;
  assert.equal(ports.length, 2);
  missing = true;
  ports[1].disconnect();
  await changeTabs();
  assert.equal(ports.length, 2);
  bridge.activity();
  await assert.rejects(bridge.ready);
  bridge.focused(1, 1);
  await assert.rejects(bridge.ready);
  await changeTabs();
  assert.equal(ports.length, 4, 'a helper that never connected is not retried by itself');
  assert.equal((await bridge.status()).connected, false);
  assert.equal(ports.length, 5);
  assert.match(bridge.lastError, /link-reuse --install, then open this popup again/);
  assert.equal(pending.size, 0);
});

test('a newer installed helper requests a reload before routing another link', async () => {
  const port = nativePort({ type: 'ready', extensionVersion: '3.1.3' });
  const reloaded = [];
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {}, connectPort: () => port,
    extensionVersion: '3.1.2', reload: async version => { reloaded.push(version); } });
  await assert.rejects(bridge.connect(), /Loading the updated extension/);
  assert.deepEqual(reloaded, ['3.1.3']);
  // The mismatched connection is left at once; nothing it carries is acted on.
  assert.equal(bridge.port, undefined);
  port.emit({ type: 'open', id: 'during-reload', url: 'https://example.test/' });
  assert.equal(port.sent.some(message => message.id === 'during-reload'), false);
});

test('a helper that states no version counts as a different one', async () => {
  const port = nativePort({ type: 'ready' });
  const reloaded = [];
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {}, connectPort: () => port,
    extensionVersion: '3.1.2', reload: async version => { reloaded.push(version); } });
  await assert.rejects(bridge.connect(), /Loading the updated extension/);
  assert.deepEqual(reloaded, [undefined]);
});

test('a reload failure is reported without disconnecting into a reload loop', async context => {
  const pending = timers(context);
  const port = nativePort({ type: 'ready', extensionVersion: '3.1.3' });
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {}, connectPort: () => port,
    extensionVersion: '3.1.2', reload: async () => { throw new Error('Load the installed current/extension folder.'); } });
  await assert.rejects(bridge.connect());
  await new Promise(setImmediate);
  assert.equal(bridge.lastError, 'Load the installed current/extension folder.');
  assert.equal(pending.size, 0);
  // Nothing reconnects by itself: the next try is the user's next action.
  assert.equal(bridge.port, undefined);
});

test('two simultaneous external requests create one tab and then reuse it', async () => {
  const h = browser([]);
  const listeners = [];
  const sent = [];
  const port = { onMessage: { addListener(fn) { listeners.push(fn); } }, onDisconnect: { addListener() {} },
    postMessage(message) {
      sent.push(message);
      if (message.type === 'hello') queueMicrotask(() => listeners.forEach(fn => fn({ type: 'ready' })));
      if (message.type === 'authorize-create') queueMicrotask(() => listeners.forEach(fn => fn({ type: 'create-authorized', id: message.id })));
    }, disconnect() {} };
  const bridge = new WindowsBridge(policy, { connectPort: () => port, queryTabs: h.api.tabs.query, badge() {}, resetLearning() {}, browserAPI: h.api });
  await bridge.connect();
  for (const id of ['one', 'two']) listeners.forEach(fn => fn({ type: 'open', id, url: 'https://example.test/new' }));
  await bridge.serial;
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  assert.deepEqual(sent.filter(value => value.type === 'result').map(value => value.result), ['opened', 'focused']);
});

test('a background webpage click moves an unloaded match next to its source without focusing it', async () => {
  const h = browser([{ url: 'https://example.test/source', active: true }, { url: 'https://example.test/other' },
    { url: 'https://example.test/item', active: false, status: 'unloaded', discarded: true }]);
  const { bridge } = sessionBridge(h, learningSession());
  assert.deepEqual(await bridge.open('https://example.test/item', { sourceTabId: 1, active: false }), { result: 'moved' });
  assert.deepEqual(h.calls, [['move', 3, { windowId: 1, index: 1 }]]);
  assert.equal(h.tabs.length, 3);
});

test('a background match already beside its source, left of it, in another window or pinned is placed without focus', async () => {
  for (const [tabs, windows, calls] of [
    [[{ url: 'https://example.test/source', active: true }, { url: 'https://example.test/item' }], undefined, []],
    [[{ url: 'https://example.test/item' }, { url: 'https://example.test/x' }, { url: 'https://example.test/source', active: true }], undefined,
      [['move', 1, { windowId: 1, index: 2 }]]],
    [[{ url: 'https://example.test/source', active: true }, { url: 'https://example.test/item', windowId: 2, index: 0 }],
      [{ id: 1, focused: true, state: 'normal' }, { id: 2, focused: false, state: 'normal' }], [['move', 2, { windowId: 1, index: 1 }]]],
    [[{ url: 'https://example.test/item', pinned: true }, { url: 'https://example.test/source', active: true }], undefined, []],
  ]) {
    const h = browser(tabs, windows);
    const source = h.tabs.find(tab => tab.url.endsWith('/source'));
    const { bridge } = sessionBridge(h, learningSession());
    assert.deepEqual(await bridge.open('https://example.test/item', { sourceTabId: source.id, active: false }), { result: 'moved' });
    assert.deepEqual(h.calls, calls);
  }
});

test('a background match that cannot be moved is focused instead of doing nothing', async () => {
  const h = browser([{ url: 'https://example.test/source', active: true }, { url: 'https://example.test/x' }, { url: 'https://example.test/item' }]);
  h.api.tabs.move = async () => { throw new Error('Unsupported'); };
  const { bridge } = sessionBridge(h, learningSession());
  assert.deepEqual(await bridge.open('https://example.test/item', { sourceTabId: 1, active: false }), { result: 'focused' });
  assert.deepEqual(h.calls, [['focus', 3, { active: true }]]);
});

test('an unmatched webpage click opens next to its source and preserves background intent', async () => {
  const h = browser([{ url: 'https://example.test/source', windowId: 2, index: 5 }], [
    { id: 1, focused: true, state: 'normal' }, { id: 2, focused: false, state: 'normal' },
  ]);
  const { bridge } = sessionBridge(h, learningSession());
  assert.deepEqual(await bridge.open('https://example.test/new', { sourceTabId: 1, active: false }), { result: 'opened' });
  assert.deepEqual(h.calls, [['create', { windowId: 2, url: 'https://example.test/new', active: false, index: 6 }]]);
});

test('an unmatched ordinary blank-target link opens a foreground tab in its source window', async () => {
  const h = browser([{ url: 'https://example.test/source', index: 3 }]);
  const { bridge } = sessionBridge(h, learningSession());
  assert.deepEqual(await bridge.open('https://example.test/new', { sourceTabId: 1, active: true }), { result: 'opened' });
  assert.deepEqual(h.calls, [['create', { windowId: 1, url: 'https://example.test/new', active: true, index: 4 }]]);
});

test('webpage clicks and external opens share one queue and cannot simultaneously create duplicates', async () => {
  const h = browser([{ url: 'https://example.test/source' }]);
  const { bridge, port } = sessionBridge(h, learningSession());
  await bridge.connect();
  const clicked = bridge.open('https://example.test/new', { sourceTabId: 1, active: false });
  port.emit({ type: 'open', id: 'external', url: 'https://example.test/new' });
  assert.deepEqual(await clicked, { result: 'opened' });
  await bridge.serial;
  await new Promise(setImmediate);
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  // The new tab isn't selected, so the external link asks the go-ahead before selecting it.
  assert.deepEqual(port.sent.filter(message => message.id === 'external').map(message => message.type),
    ['authorize-create', 'result']);
  assert.equal(port.sent.find(message => message.id === 'external' && message.type === 'result').result, 'focused');
});

test('a change starts a pass at once, and a slow browser never has more than one query in flight plus one catch-up', async () => {
  const h = browser([{ url: 'https://example.test/item' }]);
  const queries = [];
  const { bridge } = sessionBridge(h, learningSession(), { queryTabs: () => new Promise(resolve => queries.push(resolve)) });
  // No timer: the pass starts once the current task is done, so changes made together share it.
  for (let i = 0; i < 5; i++) bridge.changed();
  await new Promise(setImmediate);
  assert.equal(queries.length, 1);
  for (let i = 0; i < 5; i++) bridge.changed();
  queries[0](h.tabs.map(tab => ({ ...tab })));
  await new Promise(setImmediate);
  assert.equal(queries.length, 2);
  queries[1](h.tabs.map(tab => ({ ...tab })));
  await new Promise(setImmediate);
  assert.equal(queries.length, 2);
});

test('a pass whose tab list predates a learned change queries again instead of pruning it', async () => {
  const h = browser([]);
  const queries = [];
  const session = learningSession();
  const { bridge } = sessionBridge(h, session, { queryTabs: () => new Promise(resolve => queries.push(resolve)) });
  await new Promise(setImmediate);
  // A link opens a tab and is learned while the pass waits for its (now stale, empty) tab list.
  bridge.learning.rememberLaunch(1, { entry: 'snowflake-account:example/production' });
  h.tabs.push({ id: 1, windowId: 1, status: 'complete', url: 'https://example-production.snowflakecomputing.com/console/login#/' });
  queries[0]([]);
  await new Promise(setImmediate);
  assert.equal(queries.length, 2);
  queries[1](h.tabs.map(tab => ({ ...tab })));
  await new Promise(setImmediate);
  await bridge.saving;
  assert.deepEqual(session.read(), [{ kind: 'launch', tabId: 1, entry: 'snowflake-account:example/production' }]);
});

test('only pages that are showing get their lists, and only when their list changed', async () => {
  const [a, b, c, d, e, short] = ['https://example.test/a', 'https://example.test/b', 'https://other.test/c', 'https://example.test/d',
    'https://example.test/e', 'https://example.test/short'];
  const h = browser([{ url: a, active: true }, { url: b }, { url: c, windowId: 2, active: true }, { url: d, discarded: true }]);
  const messages = [];
  h.api.tabs.sendMessage = async (id, message, options) => { messages.push([id, message, options]); };
  let queries = 0;
  const { bridge } = sessionBridge(h, learningSession(), { queryTabs: async () => { queries++; return h.tabs.map(tab => ({ ...tab })); } });
  const settle = async () => { await new Promise(setImmediate); await bridge.saving; };
  const lists = () => messages.map(([id, message]) => [id, [...message.keys].sort((left, right) => left - right)]);
  await settle();
  // A started background sends each showing page its list, on every site; hidden and sleeping tabs are never contacted.
  assert.deepEqual(lists(), [[1, prints(b, c, d)], [3, prints(a, b, d)]]);
  assert.ok(messages.every(([, message, options]) => options.frameId === 0 && message.rules.identityRules));
  // Nothing changed: no messages, however many passes.
  messages.length = 0;
  for (let i = 0; i < 3; i++) { bridge.changed(); await settle(); }
  assert.deepEqual(messages, []);
  // A learned link to b: the showing pages get their new lists.
  bridge.observe([{ kind: 'redirect', source: short, destination: b }]);
  await settle();
  assert.deepEqual(lists(), [[1, prints(b, c, d, short)], [3, prints(a, b, d, short)]]);
  // The showing page a navigates: the other showing page's list changes; its own (the others) doesn't.
  messages.length = 0;
  h.tabs[0].url = e;
  bridge.changed(); await settle();
  assert.deepEqual(lists(), [[3, prints(b, d, e, short)]]);
  // The hidden page b is shown and asks for its list: answered from the last pass, without another tab query.
  messages.length = 0;
  const before = queries;
  await bridge.requestKeys({ id: 2, url: b });
  await settle();
  assert.equal(queries, before);
  assert.deepEqual(lists(), [[2, prints(c, d, e)]]);
});

test('a page that can\'t be reached doesn\'t stop the pass, and gets its list when it asks', async () => {
  const h = browser([{ url: 'https://example.test/a', active: true }, { url: 'https://example.test/b' }]);
  let reachable = false;
  const messages = [];
  h.api.tabs.sendMessage = async (id, message) => { if (!reachable) throw new Error('Receiving end does not exist.'); messages.push([id, message]); };
  const { bridge } = sessionBridge(h, learningSession());
  const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  await settle();
  bridge.observe([{ kind: 'redirect', source: 'https://example.test/short', destination: 'https://example.test/b' }]);
  await settle();
  assert.deepEqual(messages, []);
  reachable = true;
  await bridge.requestKeys({ id: 1, url: 'https://example.test/a' });
  await settle();
  assert.deepEqual(messages.map(([id, message]) => [id, message.keys.length]), [[1, 2]]);
});

test('a started background sends every showing page its list on its first pass, even after answering one page', async () => {
  const h = browser([{ url: 'https://example.test/a', active: true }, { url: 'https://example.test/b', windowId: 2, active: true },
    { url: 'https://example.test/c' }]);
  const messages = [];
  h.api.tabs.sendMessage = async id => { messages.push(id); };
  const queries = [];
  const { bridge } = sessionBridge(h, learningSession(), { queryTabs: () => new Promise(resolve => queries.push(resolve)) });
  await new Promise(setImmediate);
  // A page asks while the first pass waits for its tabs, and is answered first.
  const asking = bridge.requestKeys({ id: 2, url: 'https://example.test/b' });
  queries[1](h.tabs.map(tab => ({ ...tab })));
  await asking;
  await new Promise(setImmediate);
  // Pages loaded before the restart hold lists this background never sent, so asking pages alone can't bring them up to date.
  queries[0](h.tabs.map(tab => ({ ...tab })));
  await new Promise(setImmediate);
  assert.deepEqual(messages, [2, 1, 2]);
});

test('rapid repeat clicks reuse a just-created tab that Safari still lists without an address', async () => {
  const h = browser([{ url: 'https://example.test/source', active: true }]);
  // Safari: a new tab has no pendingUrl and no URL until navigation commits, so URL-filtered queries leave it out.
  const create = h.api.tabs.create;
  h.api.tabs.create = async change => { const tab = await create(change); delete tab.pendingUrl; tab.index = change.index; return tab; };
  h.api.tabs.query = async () => h.tabs.filter(tab => tab.url).map(tab => ({ ...tab }));
  const learning = new LiveLearning(policy);
  const open = active => routeToTab('https://example.test/new', learning, h.api, new Map(), { sourceTabId: 1, active }).then(value => value.result);
  const results = [];
  for (let click = 0; click < 5; click++) results.push(await open(false));
  results.push(await open(true));
  assert.deepEqual(results, ['opened', 'moved', 'moved', 'moved', 'moved', 'focused']);
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  // The stand-in ends once the browser reports the address; a tab closed before that is forgotten.
  h.tabs[1].url = 'https://example.test/new';
  assert.equal(await open(false), 'moved');
  assert.equal(learning.created.size, 0);
  assert.equal(await routeToTab('https://example.test/other', learning, h.api, new Map(), { sourceTabId: 1, active: false }).then(value => value.result), 'opened');
  h.tabs.pop();
  h.api.tabs.get = async id => { const tab = h.tabs.find(value => value.id === id); if (!tab) throw new Error('No tab'); return { ...tab }; };
  assert.equal(await routeToTab('https://example.test/other', learning, h.api, new Map(), { sourceTabId: 1, active: false }).then(value => value.result), 'opened');
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 3);
});

test('a background match moves only within its own tab group or between ungrouped tabs, otherwise it is focused', async () => {
  for (const [sourceGroup, matchGroup, expected] of [[-1, -1, 'moved'], [7, 7, 'moved'], [-1, 7, 'focused'], [7, -1, 'focused'], [7, 8, 'focused'], [undefined, undefined, 'moved']]) {
    const h = browser([{ url: 'https://example.test/source', active: true, groupId: sourceGroup }, { url: 'https://example.test/a' },
      { url: 'https://example.test/new', groupId: matchGroup }]);
    const result = await routeToTab('https://example.test/new', new LiveLearning(policy), h.api, new Map(), { sourceTabId: 1, active: false });
    assert.equal(result.result, expected, `source group ${sourceGroup}, match group ${matchGroup}`);
    assert.deepEqual(h.calls.map(call => call[0]), expected === 'moved' ? ['move'] : ['focus']);
  }
});

test('a same-tab link switches to another tab showing it where it is, and never opens a tab', async () => {
  const route = (h, url) => routeToTab(url, new LiveLearning(policy), h.api, new Map(), { sourceTabId: 1, reuseOnly: true }).then(value => value.result);
  let h = browser([{ url: 'https://example.test/source', active: true }, { url: 'https://example.test/a' }, { url: 'https://example.test/new' }]);
  assert.equal(await route(h, 'https://example.test/new'), 'focused');
  assert.deepEqual(h.calls, [['focus', 3, { active: true }]]);
  // No other tab shows it, or only the source does: the page resumes its own navigation.
  for (const url of ['https://example.test/missing', 'https://example.test/source']) {
    h = browser([{ url: 'https://example.test/source', active: true }, { url: 'https://example.test/a' }]);
    assert.equal(await route(h, url), 'none');
    assert.deepEqual(h.calls, []);
  }
  // Another tab group: focused where it is. Another window, where it is already selected: that window comes forward.
  h = browser([{ url: 'https://example.test/source', active: true, groupId: 4 }, { url: 'https://example.test/new', groupId: 5 }]);
  assert.equal(await route(h, 'https://example.test/new'), 'focused');
  assert.deepEqual(h.calls, [['focus', 2, { active: true }]]);
  h = browser([{ url: 'https://example.test/source', active: true }, { url: 'https://example.test/new', windowId: 2, active: true }],
    [{ id: 1, focused: true, state: 'normal' }, { id: 2, focused: false, state: 'normal' }]);
  assert.equal(await route(h, 'https://example.test/new'), 'focused');
  assert.deepEqual(h.calls, [['window', 2, { focused: true }]]);
});

test('pages get fingerprints of the other tabs\' match keys on every site, including learned links that lead there', async () => {
  const learning = new LiveLearning(policy);
  learning.observe([{ kind: 'redirect', source: 'https://acme.atlassian.net/l/short', destination: 'https://acme.atlassian.net/browse/OPS-7' }]);
  const tabs = [
    { id: 1, url: 'https://acme.atlassian.net/browse/OPS-1' },
    { id: 2, url: 'https://acme.atlassian.net/browse/ops-7' },
    { id: 3, url: 'https://github.com/acme/app/pull/9' },
    { id: 4, url: 'https://acme.atlassian.net/login?token=secret' },
    { id: 5, url: 'https://acme.atlassian.net/browse/OPS-9', incognito: true },
  ];
  const index = reuseIndex(tabs, learning);
  const jira = pageKeys(index, tabs[0]);
  const github = pageKeys(index, tabs[2]);
  const ops7 = ['https://acme.atlassian.net/browse/ops-7', JSON.stringify(['jira-issue', 'https://acme.atlassian.net', 'OPS-7', '', '']),
    'https://acme.atlassian.net/l/short'];
  // Only numbers reach a page: OPS-7's address, normalized address and issue identity and the learned short link, and
  // the GitHub pull request. Never the login page, the private tab or the page's own issue.
  assert.ok(jira.every(Number.isSafeInteger));
  for (const key of [...ops7, 'https://github.com/acme/app/pull/9']) assert.ok(jira.includes(fingerprint(key)), key);
  for (const key of ops7) assert.ok(github.includes(fingerprint(key)), key);
  for (const key of ['https://acme.atlassian.net/login?token=secret', 'https://acme.atlassian.net/browse/OPS-9']) {
    assert.ok(!jira.includes(fingerprint(key)) && !github.includes(fingerprint(key)), key);
  }
  assert.ok(!jira.includes(fingerprint('https://acme.atlassian.net/browse/OPS-1')));
  assert.ok(github.includes(fingerprint('https://acme.atlassian.net/browse/OPS-1')));
  assert.ok(!github.includes(fingerprint('https://github.com/acme/app/pull/9')));
  assert.equal(pageKeys(index, tabs[4]), null);
  assert.equal(pageKeys(index, { id: 6, url: 'chrome://newtab/' }), null);
  // Two tabs on one page: each page sees the other one.
  const twin = reuseIndex([{ id: 1, url: 'https://example.test/a' }, { id: 2, url: 'https://example.test/a' }], learning);
  assert.deepEqual(pageKeys(twin, { id: 1, url: 'https://example.test/a' }), prints('https://example.test/a'));
});
