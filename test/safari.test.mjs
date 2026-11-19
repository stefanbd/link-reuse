import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prepareNative } from '../extension/native-port.mjs';
import { BrowserBridge } from '../extension/browser-bridge.mjs';
import { RedirectObserver } from '../extension/observer.mjs';
import { safariTransport } from './safari-support.mjs';
import { permittedTabs } from '../extension/matching.mjs';

const policy = JSON.parse(readFileSync(new URL('../extension/learning-policy.json', import.meta.url)));

/** A Safari browser with one focused window and no tabs, recording the tabs it creates. */
function browserTabs() {
  const tabs = [], created = [];
  return { created, api: {
    runtime: { getURL: value => 'safari-web-extension://test/' + value },
    permissions: { getAll: async () => ({ origins: ['<all_urls>'] }), contains: async () => true },
    windows: { async getAll() { return [{ id: 1, focused: true, state: 'normal' }]; }, async update() {} },
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
      async update() {},
      async create(change) { const tab = { id: tabs.length + 1, windowId: 1, status: 'loading', url: change.url }; tabs.push(tab); created.push(change); return tab; },
    },
  } };
}

test('Safari queries only granted websites without prompting for unrelated open tabs', async () => {
  const calls = [];
  const api = {
    runtime: { getURL: () => 'safari-web-extension://test/' },
    permissions: { getAll: async () => ({ origins: ['https://allowed.test/*'] }) },
    tabs: { query: async query => { calls.push(query); return [{ id: 1 }]; } },
  };
  assert.deepEqual(await permittedTabs(api, { windowType: 'normal' }), [{ id: 1 }]);
  assert.deepEqual(calls, [{ windowType: 'normal', url: ['https://allowed.test/*'] }]);
  api.permissions.getAll = async () => ({ origins: [] });
  await assert.rejects(permittedTabs(api), /Allow Link Reuse website access/);
  assert.equal(calls.length, 1);
  api.permissions.getAll = async () => ({ origins: ['<all_urls>'] });
  await permittedTabs(api);
  assert.deepEqual(calls.at(-1), { url: ['<all_urls>'] });
});

test('Chromium tab queries keep their original filters and need no extra permissions call', async () => {
  const api = { runtime: { getURL: () => 'chrome-extension://test/' }, tabs: { query: async query => query } };
  assert.deepEqual(await permittedTabs(api, { windowType: 'normal' }), { windowType: 'normal' });
});

const hello = { type: 'hello', extensionVersion: '3.2.4', focused: false };
const connectSafari = h => prepareNative(h.api, h.Socket)();

test('Safari connects once and sends opens/results over its authenticated local channel without per-open native RPCs', async () => {
  const h = safariTransport();
  const port = connectSafari(h);
  const messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage(hello);
  await new Promise(setImmediate);
  assert.equal(port.transportConnected, true);
  assert.deepEqual(messages, [{ type: 'ready', extensionVersion: '3.2.4' }]);
  assert.deepEqual(h.sent[0], { ...hello, token: h.descriptor.token });
  for (let i = 0; i < 3; i++) {
    const opening = { type: 'open', id: String(i), url: 'https://example.test/item' };
    h.emit(opening);
    assert.deepEqual(messages.at(-1), opening);
    port.postMessage({ type: 'result', id: String(i), result: 'focused' });
  }
  assert.equal(h.sockets.length, 1);
  assert.equal(h.nativeCalls, 1);
  assert.equal(h.sent.filter(message => message.type === 'hello').length, 1);
  assert.equal(h.sent.filter(message => message.type === 'result').length, 3);
  port.disconnect();
});

test('Safari greets the app only after the background has, so nothing reaches it before it listens', async () => {
  const h = safariTransport();
  const port = connectSafari(h);
  await new Promise(setImmediate);
  assert.equal(h.sockets.length, 1);
  assert.deepEqual(h.sent, []);
  assert.equal(port.transportConnected, false);
  port.postMessage(hello);
  await new Promise(setImmediate);
  assert.equal(port.transportConnected, true);
  port.disconnect();
});

test('Safari passes on the app saying an update replaced it, so the extension gets ready for the new one', async () => {
  const h = safariTransport();
  const port = connectSafari(h);
  const messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage(hello);
  await new Promise(setImmediate);
  h.emit({ type: 'replaced' });
  assert.deepEqual(messages.at(-1), { type: 'replaced' });
  port.disconnect();
});

test('a new app instance ends the connection and the next one connects to it without another bootstrap', async () => {
  const h = safariTransport({ automatic: false });
  const connect = prepareNative(h.api, h.Socket);
  const first = connect(), messages = [];
  let ended = 0;
  first.onMessage.addListener(message => messages.push(message));
  first.onDisconnect.addListener(() => ended++);
  h.wake();
  first.postMessage(hello);
  await new Promise(setImmediate);
  assert.equal(first.transportConnected, true);
  // The same address with a new token is a new app as well: a port number can be reused.
  const moved = { ...h.descriptor, token: Buffer.alloc(32, 9).toString('base64') };
  h.wake(moved);
  assert.deepEqual(messages.at(-1), { type: 'replaced' });
  assert.equal(ended, 1);
  assert.equal(first.closed, true);
  assert.deepEqual(h.sent.at(-1), { type: 'diagnostic', result: 'endpoint', error: '0' });
  const calls = h.nativeCalls;
  const second = connect();
  assert.notEqual(second, first);
  second.postMessage(hello);
  await new Promise(setImmediate);
  assert.equal(h.nativeCalls, calls);
  assert.equal(second.transportConnected, true);
  assert.equal(h.sent.at(-1).token, moved.token);
  second.disconnect();
});

test('Safari keeps a focus change made before the app accepted the connection, and sends it right after', async () => {
  const h = safariTransport();
  const port = connectSafari(h);
  port.postMessage({ type: 'activity' });
  assert.equal(port.closed, false);
  port.postMessage(hello);
  await new Promise(setImmediate);
  assert.deepEqual(h.sent.map(message => message.type), ['hello', 'activity']);
  port.disconnect();
});

test('Safari routing waits for the app; nothing else needs it', () => {
  const h = safariTransport({ automatic: false });
  const port = connectSafari(h);
  const messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage(hello);
  assert.deepEqual(messages, []);
  assert.equal(port.transportConnected, false);
  assert.equal(h.nativeCalls, 1);
  assert.equal(h.sockets.length, 0);
  port.disconnect();
});

test('a delayed bootstrap reply changes nothing about the authenticated channel', async () => {
  const h = safariTransport();
  let release;
  h.api.runtime.sendNativeMessage = () => new Promise(resolve => { release = resolve; });
  const port = connectSafari(h), messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage(hello);
  await new Promise(setImmediate);
  assert.equal(port.transportConnected, true);
  release({ type: 'ready', extensionVersion: '3.2.3' });
  await new Promise(setImmediate);
  assert.equal(port.closed, false);
  assert.deepEqual(messages, [{ type: 'ready', extensionVersion: '3.2.4' }]);
  h.emit({ type: 'open', id: 'after-late-bootstrap', url: 'https://example.test/item' });
  assert.equal(messages.at(-1).id, 'after-late-bootstrap');
  port.disconnect();
});

test('Safari retains its warm channel when the one-time native bootstrap port ends', async () => {
  const h = safariTransport(), port = connectSafari(h), messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage(hello);
  await new Promise(setImmediate);
  h.closeBootstrap();
  assert.equal(port.closed, false);
  assert.equal(port.transportConnected, true);
  h.emit({ type: 'open', id: 'after-bootstrap', url: 'https://example.test/item' });
  assert.equal(messages.at(-1).id, 'after-bootstrap');
  port.postMessage({ type: 'result', id: 'after-bootstrap', result: 'focused' });
  assert.equal(h.sent.at(-1).result, 'focused');
  port.disconnect();
});

test('Safari rejects unsafe connection descriptors and unrelated native envelopes', async () => {
  const h = safariTransport({ automatic: false });
  const port = connectSafari(h);
  h.emitRaw({ name: 'other', userInfo: h.descriptor });
  for (const endpoint of ['ws://example.test:32123/', 'wss://127.0.0.1:32123/', 'ws://127.0.0.1:32123/?secret=one', 'ws://127.0.0.1:32123/path']) h.wake({ ...h.descriptor, endpoint });
  h.wake({ ...h.descriptor, token: 'invalid' });
  assert.equal(h.sockets.length, 0);
  h.wake(); h.wake();
  await new Promise(setImmediate);
  assert.equal(h.sockets.length, 1);
  assert.equal(port.closed, false);
  port.disconnect();
});

test('Safari closes a failed channel once, discards late messages and replaces its native subscription', async () => {
  const h = safariTransport();
  const connect = prepareNative(h.api, h.Socket), port = connect(), messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage(hello);
  await new Promise(setImmediate);
  let disconnected = 0;
  port.onDisconnect.addListener(() => disconnected++);
  h.sockets[0].close();
  h.sockets[0].emit({ type: 'open', id: 'late', url: 'https://example.test/item' });
  port.disconnect();
  await new Promise(setImmediate);
  assert.equal(disconnected, 1);
  assert.equal(h.disconnected, 1);
  assert.equal(messages.some(message => message.id === 'late'), false);
  const replacement = connect();
  assert.notEqual(replacement, port);
  replacement.disconnect();
});

test('replacing the app while a link waits for its go-ahead ends that link and leaves the queue free', async () => {
  const h = safariTransport({ automatic: false, authorize: false });
  const tabs = browserTabs();
  const bridge = new BrowserBridge(policy, { connectPort: prepareNative(h.api, h.Socket), queryTabs: tabs.api.tabs.query,
    browserAPI: tabs.api, badge() {}, resetLearning() {}, extensionVersion: '3.2.4' });
  h.wake();
  await bridge.ready;
  h.emit({ type: 'open', id: 'waiting', url: 'https://example.test/new' });
  await new Promise(setImmediate);
  assert.deepEqual(h.sent.at(-1), { type: 'authorize-create', id: 'waiting' });
  // A new app instance announces itself before the old socket's end arrives.
  const moved = { ...h.descriptor, endpoint: 'ws://127.0.0.1:32124/' };
  h.wake(moved);
  await bridge.serial;
  await new Promise(setImmediate);
  assert.deepEqual(tabs.created, []);
  assert.equal(bridge.pending, 0);
  // The extension is already on the new app, and the next link goes through.
  assert.equal(h.sockets.at(-1).url, moved.endpoint);
  assert.equal(bridge.connected, true);
  h.emit({ type: 'open', id: 'next', url: 'https://example.test/new' });
  await new Promise(setImmediate);
  h.emit({ type: 'create-authorized', id: 'next' });
  await bridge.serial;
  await new Promise(setImmediate);
  assert.equal(tabs.created.length, 1);
  assert.equal(h.sent.find(message => message.type === 'result' && message.id === 'next').result, 'opened');
});

test('a go-ahead the app refuses, or that a closed connection can no longer give, changes nothing', async () => {
  for (const ending of ['refused', 'closed']) {
    const h = safariTransport({ authorize: false });
    const tabs = browserTabs();
    const bridge = new BrowserBridge(policy, { connectPort: prepareNative(h.api, h.Socket), queryTabs: tabs.api.tabs.query,
      browserAPI: tabs.api, badge() {}, resetLearning() {}, extensionVersion: '3.2.4' });
    await bridge.ready;
    h.emit({ type: 'open', id: 'link', url: 'https://example.test/new' });
    await new Promise(setImmediate);
    if (ending === 'refused') h.emit({ type: 'create-authorized', id: 'link', error: 'The external request is no longer available.' });
    else h.sockets[0].close();
    await bridge.serial;
    await new Promise(setImmediate);
    assert.deepEqual(tabs.created, [], ending);
    // A late go-ahead for it is ignored.
    h.emit({ type: 'create-authorized', id: 'link' });
    await new Promise(setImmediate);
    assert.deepEqual(tabs.created, [], ending);
  }
});

test('an app that bundles another extension version gets that version loaded, and the old connection is left', async () => {
  const h = safariTransport({ serverVersion: '3.2.5' });
  const tabs = browserTabs();
  const reloaded = [];
  const bridge = new BrowserBridge(policy, { connectPort: prepareNative(h.api, h.Socket), queryTabs: tabs.api.tabs.query,
    browserAPI: tabs.api, badge() {}, resetLearning() {}, extensionVersion: '3.2.4',
    reload: async version => { reloaded.push(version); } });
  await assert.rejects(bridge.ready, /Loading the updated extension/);
  await new Promise(setImmediate);
  assert.deepEqual(reloaded, ['3.2.5']);
  assert.equal(bridge.port, undefined);
  assert.equal(h.sent.at(-1).result, 'version');
});

test('Chromium native connections remain lazy and reconnect with a fresh browser port', () => {
  let calls = 0;
  const api = { runtime: { getURL: () => 'chrome-extension://test/', connectNative() {
    calls++; return { onDisconnect: { addListener() {} } };
  } } };
  const connect = prepareNative(api);
  assert.equal(calls, 0);
  assert.notEqual(connect(), connect());
  assert.equal(calls, 2);
});

const event = (url, documentId, extra = {}) => ({ tabId: 1, url, documentId, ...extra });
const a = 'https://example.test/source', b = 'https://example.test/item', c = 'https://example.test/view';

test('browsers without redirect qualifiers use verified document referrers for automatic redirect chains', () => {
  const observer = new RedirectObserver();
  observer.before(event(a, 'one')); observer.committed(event(b, 'one'));
  observer.before(event(c, 'two')); observer.committed(event(c, 'two'));
  assert.deepEqual(observer.document(event(c, 'two', { referrer: b })), [
    { source: a, destination: c }, { source: b, destination: c },
  ]);
});

test('referrer learning rejects address-bar navigation, user clicks and stale documents', () => {
  for (const kind of ['address-bar', 'click', 'stale']) {
    const observer = new RedirectObserver();
    observer.before(event(a, 'one')); observer.committed(event(b, 'one'));
    if (kind === 'click') observer.interact(1, 'one');
    observer.before(event(c, 'two')); observer.committed(event(c, 'two'));
    assert.deepEqual(observer.document(event(c, kind === 'stale' ? 'one' : 'two', { referrer: kind === 'address-bar' ? '' : b })), []);
  }
});

test('document handshake retains interaction even when there was no redirect', () => {
  const observer = new RedirectObserver();
  observer.committed(event(a, 'one'));
  observer.document(event(a, 'one', { referrer: '', interacted: true }));
  assert.deepEqual(observer.history(event(b, 'one')), []);
});

test('Safari URL updates and verified document messages retain automatic rewrites when frame URLs lag', async context => {
  const event = () => ({ callbacks: [], addListener(fn) { this.callbacks.push(fn); }, emit(...args) { for (const fn of this.callbacks) fn(...args); } });
  const original = globalThis.chrome;
  const raw = safariTransport();
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = raw.Socket;
  const tab = { id: 1, windowId: 1, url: a, status: 'complete', incognito: false };
  let frame = { url: a, documentId: 'current' };
  const focused = [];
  const scheduled = new Map();
  let sequence = 0;
  context.mock.method(globalThis, 'setTimeout', (fn, delay) => { const id = ++sequence; scheduled.set(id, { fn, delay }); return id; });
  context.mock.method(globalThis, 'clearTimeout', id => scheduled.delete(id));
  globalThis.chrome = {
    runtime: { ...raw.api.runtime, getPlatformInfo: async () => ({ os: 'mac' }), getManifest: () => ({ version: '3.2.4' }), onMessage: event(), onStartup: event() },
    storage: { local: { async get() { return {}; }, async set() {} } },
    permissions: { getAll: async () => ({ origins: ['<all_urls>'] }) },
    tabs: { async query() { return [{ ...tab }]; }, async get() { return { ...tab }; },
      async update(id) { focused.push(id); }, async create() { throw Error('Unexpected duplicate'); },
      async sendMessage() { return { url: tab.url, referrer: '', interacted: false }; },
      onUpdated: event(), onRemoved: event(), onActivated: event(), onCreated: event() },
    windows: { async getAll() { return [{ id: 1, focused: true }]; }, async getLastFocused() { return { id: 1 }; }, async update() {}, onFocusChanged: event(), onRemoved: event() },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), async getFrame() { return { ...frame }; } },
    action: { async setBadgeText() {} },
  };
  const policy = JSON.parse((await import('node:fs')).readFileSync(new URL('../extension/learning-policy.json', import.meta.url)));
  context.mock.method(globalThis, 'fetch', async () => ({ async json() { return policy; } }));
  try {
    await import('../extension/background.mjs?safari-history');
    await new Promise(setImmediate);
    for (const [id, timer] of [...scheduled]) if (timer.delay === 50) { scheduled.delete(id); timer.fn(); }
    await new Promise(setImmediate);
    chrome.webNavigation.onCommitted.emit({ tabId: 1, frameId: 0, url: a, documentId: 'current' });
    await new Promise(setImmediate);
    tab.url = b; frame = { url: b, documentId: 'current' };
    chrome.tabs.onUpdated.emit(1, { url: b });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    raw.emit({ type: 'open', id: 'open', url: a });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.deepEqual(focused, [1]);
    assert.deepEqual(raw.sent.find(message => message.type === 'result'), { type: 'result', id: 'open', result: 'focused' });
    tab.url = b + '/';
    chrome.tabs.onUpdated.emit(1, { url: tab.url });
    await new Promise(setImmediate);
    chrome.runtime.onMessage.emit({ type: 'canonical', url: tab.url, hrefs: [] },
      { tab: { ...tab }, frameId: 0, documentId: 'current' }, () => {});
    await new Promise(setImmediate);
    chrome.runtime.onMessage.emit({ type: 'canonical', url: b, hrefs: [] },
      { tab: { ...tab }, frameId: 0, documentId: 'current' }, () => {});
    chrome.runtime.onMessage.emit({ type: 'canonical', url: tab.url, hrefs: [b] },
      { tab: { ...tab }, frameId: 0, documentId: 'stale' }, () => {});
    await new Promise(setImmediate);
    const retained = await new Promise(resolve => chrome.runtime.onMessage.emit({ type: 'status' }, {}, resolve));
    assert.equal(retained.stats.records, 2);
    raw.emit({ type: 'open', id: 'after-rewrite', url: a });
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    assert.deepEqual(raw.sent.find(message => message.id === 'after-rewrite' && message.type === 'result'),
      { type: 'result', id: 'after-rewrite', result: 'focused' });
    assert.deepEqual(focused, [1, 1]);
    tab.url = c; frame = { url: c, documentId: 'new-document' };
    chrome.tabs.onUpdated.emit(1, { url: c });
    await new Promise(setImmediate);
    const status = await new Promise(resolve => chrome.runtime.onMessage.emit({ type: 'status' }, {}, resolve));
    assert.equal(status.stats.records, 0);
  } finally { globalThis.chrome = original; globalThis.WebSocket = originalSocket; }
});
