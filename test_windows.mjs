import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LiveLearning, equivalent, routeToTab } from './extension/matching.mjs';
import { WindowsBridge } from './extension/windows-bridge.mjs';

const policy = JSON.parse(readFileSync(new URL('./extension/learning-policy.json', import.meta.url)));
const place = 'https://www.google.com/maps/place/Restaurant/@42,23,17z/data=!4m6!3m5!1s0x40aa8541e3d5da63:0x5353ef1753a6f43c!8m2!3d42';
const photo = 'https://www.google.com/maps/place/Restaurant/@42,23,3a/data=!3m8!1sPHOTO!4m7!3m6!1s0x40aa8541e3d5da63:0x5353ef1753a6f43c!8m2!3d42';

function slackLink(target, extra = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const hint = [encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ iss: 'https://slack.com', 'https://slack.com/target_uri': target, ...extra }), 'example'].join('.');
  return 'https://slack.com/openid/connect/login_initiate_redirect?login_hint=' + hint;
}

function browser(initial, windows = [{ id: 1, focused: true }], lastFocusedId = windows[0]?.id) {
  const tabs = initial.map((tab, index) => ({ id: index + 1, windowId: 1, status: 'complete', incognito: false, ...tab }));
  const calls = [];
  return { tabs, calls, api: {
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

test('Windows focuses the existing deeper view without navigating or creating a tab', async () => {
  const h = browser([{ url: photo, active: true }]);
  assert.deepEqual(await routeToTab(place, new LiveLearning(policy), h.api), { result: 'focused' });
  assert.deepEqual(h.calls.map(call => call[0]), ['focus', 'window']);
  assert.equal(h.tabs[0].url, photo);
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
  assert.deepEqual(h.calls.map(call => call[0]), ['focus', 'window']);
  assert.deepEqual(h.calls[1], ['window', 1, { state: 'normal', focused: true }]);
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
  assert.ok(equivalent('https://maps.test/search', photo, learning.records));
  learning.prune([]);
  assert.equal(learning.records.size, 0);
  learning.observe([{ kind: 'canonical', source: 'https://shop.test/products/42/reviews', destination: 'https://shop.test/products/42' }]);
  assert.ok(equivalent('https://shop.test/products/42', 'https://shop.test/products/42/reviews', learning.records));
  assert.equal(equivalent('https://shop.test/products/43', 'https://shop.test/products/42/reviews', learning.records), false);
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
  assert.deepEqual(h.calls.map(call => call[0]), ['focus', 'window', 'focus', 'window']);
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
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {} });
  clearTimeout(bridge.timer);
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
  assert.deepEqual(h.calls.map(call => call[0]), ['focus', 'window', 'focus', 'window']);
  assert.equal(h.tabs[0].url, view);
  assert.equal(learning.records.size, 0);
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
  assert.deepEqual([...learning.records.values()].map(({ bytes, ...record }) => record), [{ tabId: 1, account: 'snowflake-account:example/production' }]);
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

test('the extension reconnects automatically after an installed helper is replaced', async context => {
  const pending = timers(context);
  const ports = [];
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {},
    connectPort: () => { const port = nativePort(); ports.push(port); return port; } });
  clearTimeout(bridge.timer);
  await bridge.connect();
  ports[0].disconnect();
  assert.equal(bridge.connected, false);
  const [[id, retry]] = pending;
  assert.equal(retry.delay, 5000);
  pending.delete(id);
  retry.fn();
  await new Promise(setImmediate);
  assert.equal(ports.length, 2);
  assert.equal(bridge.connected, true);
  assert.equal(bridge.reconnectAttempts, 0);
  assert.equal(pending.size, 0);
});

test('a missing helper has four bounded reconnect attempts without permanent polling', async context => {
  const pending = timers(context);
  let connections = 0;
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {},
    connectPort: () => { connections++; return nativePort(null); } });
  clearTimeout(bridge.timer);
  await assert.rejects(bridge.connect());
  for (const delay of [5000, 10000, 20000, 20000]) {
    assert.equal(pending.size, 1);
    const [[id, retry]] = pending;
    assert.equal(retry.delay, delay);
    pending.delete(id);
    retry.fn();
    await new Promise(setImmediate);
  }
  assert.equal(connections, 5);
  assert.equal(pending.size, 0);
  assert.match(bridge.lastError, /Could not reconnect/);
});

test('a newer installed helper requests a reload before routing another link', async () => {
  const port = nativePort({ type: 'ready', extensionVersion: '3.1.3' });
  const reloaded = [];
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {}, connectPort: () => port,
    extensionVersion: '3.1.2', reload: async version => { reloaded.push(version); } });
  clearTimeout(bridge.timer);
  await assert.rejects(bridge.connect(), /Loading the updated extension/);
  assert.deepEqual(reloaded, ['3.1.3']);
  port.emit({ type: 'open', id: 'during-reload', url: 'https://example.test/' });
  assert.equal(port.sent.find(message => message.id === 'during-reload').error, bridge.lastError);
});

test('a reload failure is reported without disconnecting into a reload loop', async context => {
  const pending = timers(context);
  const port = nativePort({ type: 'ready', extensionVersion: '3.1.3' });
  const bridge = new WindowsBridge(policy, { queryTabs: async () => [], badge() {}, connectPort: () => port,
    extensionVersion: '3.1.2', reload: async () => { throw new Error('Load the installed current/extension folder.'); } });
  clearTimeout(bridge.timer);
  await assert.rejects(bridge.connect());
  await new Promise(setImmediate);
  assert.equal(bridge.lastError, 'Load the installed current/extension folder.');
  assert.equal(pending.size, 0);
  assert.equal(bridge.port, port);
});

test('two simultaneous external requests create one tab and then reuse it', async () => {
  const h = browser([]);
  const listeners = [];
  const sent = [];
  const port = { onMessage: { addListener(fn) { listeners.push(fn); } }, onDisconnect: { addListener() {} },
    postMessage(message) { sent.push(message); if (message.type === 'hello') queueMicrotask(() => listeners.forEach(fn => fn({ type: 'ready' }))); }, disconnect() {} };
  const bridge = new WindowsBridge(policy, { connectPort: () => port, queryTabs: h.api.tabs.query, badge() {}, resetLearning() {}, browserAPI: h.api });
  clearTimeout(bridge.timer);
  await bridge.connect();
  for (const id of ['one', 'two']) listeners.forEach(fn => fn({ type: 'open', id, url: 'https://example.test/new' }));
  await bridge.serial;
  assert.equal(h.calls.filter(call => call[0] === 'create').length, 1);
  assert.deepEqual(sent.filter(value => value.type === 'result').map(value => value.result), ['opened', 'focused']);
});
