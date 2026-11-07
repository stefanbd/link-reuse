import test from 'node:test';
import assert from 'node:assert/strict';
import { connectNative, prepareNative } from './extension/native-port.mjs';
import { RedirectObserver } from './extension/observer.mjs';

function safari({ claim = 'accepted', fail = false, pending } = {}) {
  const callbacks = { message: [], disconnect: [] };
  const sent = [];
  let disconnected = 0;
  const native = {
    onMessage: { addListener: fn => callbacks.message.push(fn) },
    onDisconnect: { addListener: fn => callbacks.disconnect.push(fn) },
    disconnect() { disconnected++; for (const fn of callbacks.disconnect) fn(); },
  };
  const api = { runtime: {
    getURL: () => 'safari-web-extension://example/', connectNative: () => native,
    async sendNativeMessage(_name, message) {
      sent.push(message);
      if (fail) throw new Error('Native handler unavailable');
      return message.type === 'hello' ? { type: 'ready', extensionVersion: '3.2.3', ...(pending ? { requests: pending } : {}) } : { type: 'receipt', result: claim };
    },
  } };
  return { api, sent, get disconnected() { return disconnected; },
    emit: message => callbacks.message.forEach(fn => fn({ name: 'link-reuse', userInfo: message })),
    emitRaw: message => callbacks.message.forEach(fn => fn(message)) };
}

test('Safari translates native messaging into the same ready/open/result contract', async () => {
  const h = safari();
  const port = connectNative(h.api);
  const messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage({ type: 'hello' });
  await new Promise(setImmediate);
  assert.deepEqual(messages, [{ type: 'ready', extensionVersion: '3.2.3' }]);
  const opening = { type: 'open', id: 'request', url: 'https://example.test/item' };
  h.emit(opening);
  await new Promise(setImmediate);
  assert.deepEqual(h.sent[1], { type: 'claim', id: 'request' });
  assert.equal(messages[1], opening);
  port.postMessage({ type: 'result', id: 'request', result: 'focused' });
  port.postMessage({ type: 'activity' });
  await new Promise(setImmediate);
  assert.deepEqual(h.sent[2], { type: 'result', id: 'request', result: 'focused' });
  assert.equal(h.sent.length, 3);
  port.disconnect();
});

test('an unselected Safari profile cannot route the same external request', async () => {
  const h = safari({ claim: 'ignored' });
  const port = connectNative(h.api);
  const messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage({ type: 'hello' });
  await new Promise(setImmediate);
  messages.length = 0;
  h.emit({ type: 'open', id: 'request', url: 'https://example.test/item' });
  h.emit({ type: 'wrong', id: 'request', url: 'https://example.test/item' });
  await new Promise(setImmediate);
  assert.deepEqual(messages, []);
  assert.equal(h.sent.length, 2);
  port.disconnect();
});

test('Safari native failures disconnect once and never manufacture an opening retry', async () => {
  const h = safari({ fail: true });
  const port = connectNative(h.api);
  let disconnected = 0;
  port.onDisconnect.addListener(() => disconnected++);
  port.postMessage({ type: 'hello' });
  await new Promise(setImmediate);
  assert.equal(disconnected, 1);
  assert.equal(h.disconnected, 1);
  port.disconnect();
  assert.equal(disconnected, 1);
  assert.equal(h.sent.length, 1);
});

test('a late Safari claim cannot route after its native connection was closed', async () => {
  const h = safari();
  let release;
  const send = h.api.runtime.sendNativeMessage;
  h.api.runtime.sendNativeMessage = (application, message) => message.type === 'claim' ?
    new Promise(resolve => { release = resolve; }) : send(application, message);
  const port = connectNative(h.api);
  let opened = false;
  port.onMessage.addListener(message => { if (message.type === 'open') opened = true; });
  port.postMessage({ type: 'hello' });
  await new Promise(setImmediate);
  h.emit({ type: 'open', id: 'request', url: 'https://example.test/item' });
  port.disconnect();
  release({ result: 'accepted' });
  await new Promise(setImmediate);
  assert.equal(opened, false);
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
  const raw = safari();
  const tab = { id: 1, windowId: 1, url: a, status: 'complete', incognito: false };
  let frame = { url: a, documentId: 'current' };
  const focused = [];
  const scheduled = new Map();
  let sequence = 0;
  context.mock.method(globalThis, 'setTimeout', (fn, delay) => { const id = ++sequence; scheduled.set(id, { fn, delay }); return id; });
  context.mock.method(globalThis, 'clearTimeout', id => scheduled.delete(id));
  globalThis.chrome = {
    runtime: { ...raw.api.runtime, getPlatformInfo: async () => ({ os: 'mac' }), getManifest: () => ({ version: '3.2.3' }), onMessage: event(), onStartup: event() },
    storage: { local: { async get() { return {}; }, async set() {} } },
    tabs: { async query() { return [{ ...tab }]; }, async get() { return { ...tab }; },
      async update(id) { focused.push(id); }, async create() { throw Error('Unexpected duplicate'); },
      async sendMessage() { return { url: tab.url, referrer: '', interacted: false }; },
      onUpdated: event(), onRemoved: event(), onActivated: event() },
    windows: { async getAll() { return [{ id: 1, focused: true }]; }, async getLastFocused() { return { id: 1 }; }, async update() {}, onFocusChanged: event(), onRemoved: event() },
    webNavigation: { onBeforeNavigate: event(), onCommitted: event(), onErrorOccurred: event(), async getFrame() { return { ...frame }; } },
    action: { async setBadgeText() {} },
  };
  const policy = JSON.parse((await import('node:fs')).readFileSync(new URL('./extension/learning-policy.json', import.meta.url)));
  context.mock.method(globalThis, 'fetch', async () => ({ async json() { return policy; } }));
  try {
    await import('./extension/background.mjs?safari-history');
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
  } finally { globalThis.chrome = original; }
});

test('Safari captures an external open before asynchronous engine startup and claims it only after ready', async () => {
  const h = safari();
  const connect = prepareNative(h.api);
  h.emit({ type: 'open', id: 'early', url: 'https://example.test/item' });
  await new Promise(setImmediate);
  assert.equal(h.sent.length, 0);
  const port = connect();
  const messages = [];
  port.onMessage.addListener(message => messages.push(message));
  assert.equal(h.sent.length, 0);
  port.postMessage({ type: 'hello' });
  await new Promise(setImmediate);
  assert.deepEqual(messages.map(message => message.type), ['ready', 'open']);
  assert.equal(h.sent[1].type, 'claim');
  assert.equal(h.sent[1].id, 'early');
  port.disconnect();
});

test('Safari bounds pre-startup native deliveries and replaces a disconnected port', async () => {
  const h = safari();
  const connect = prepareNative(h.api);
  for (let i = 0; i < 100; i++) h.emit({ type: 'open', id: String(i), url: 'https://example.test/item' });
  const port = connect();
  let opens = 0;
  port.onMessage.addListener(message => { if (message.type === 'open') opens++; });
  port.postMessage({ type: 'hello' });
  await new Promise(setImmediate);
  assert.equal(opens, 16);
  port.disconnect();
  const replacement = connect();
  assert.notEqual(replacement, port);
  assert.equal(replacement.closed, false);
  replacement.disconnect();
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

test('Safari accepts the observed named native envelope and rejects unrelated messages', async () => {
  const h = safari();
  const port = connectNative(h.api);
  const messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage({ type: 'hello' });
  await new Promise(setImmediate);
  const frame = { type: 'open', id: 'request', url: 'https://example.test/item' };
  for (const value of [frame, null, { name: 'other', userInfo: frame }, { name: 'link-reuse', userInfo: { ...frame, id: 1 } }]) h.emitRaw(value);
  await new Promise(setImmediate);
  assert.equal(h.sent.length, 1);
  h.emitRaw({ name: 'link-reuse', userInfo: frame });
  await new Promise(setImmediate);
  assert.equal(messages[1], frame);
  port.disconnect();
});

test('Safari retrieves an unclaimed request when dispatch preceded the native listener', async () => {
  const frame = { type: 'open', id: 'cold', url: 'https://example.test/item' };
  const h = safari({ pending: [frame] });
  const port = connectNative(h.api);
  const messages = [];
  port.onMessage.addListener(message => messages.push(message));
  port.postMessage({ type: 'hello' });
  await new Promise(setImmediate);
  assert.deepEqual(messages.map(message => message.type), ['ready', 'open']);
  assert.equal(messages[1], frame);
  assert.deepEqual(h.sent[1], { type: 'claim', id: 'cold' });
  port.disconnect();
});
