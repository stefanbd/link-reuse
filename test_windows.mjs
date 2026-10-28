import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LiveLearning, equivalent, routeToTab } from './extension/matching.mjs';
import { WindowsBridge } from './extension/windows-bridge.mjs';

const policy = JSON.parse(readFileSync(new URL('./extension/learning-policy.json', import.meta.url)));
const place = 'https://www.google.com/maps/place/Restaurant/@42,23,17z/data=!4m6!3m5!1s0x40aa8541e3d5da63:0x5353ef1753a6f43c!8m2!3d42';
const photo = 'https://www.google.com/maps/place/Restaurant/@42,23,3a/data=!3m8!1sPHOTO!4m7!3m6!1s0x40aa8541e3d5da63:0x5353ef1753a6f43c!8m2!3d42';

function browser(initial) {
  const tabs = initial.map((tab, index) => ({ id: index + 1, windowId: 1, status: 'complete', incognito: false, ...tab }));
  const calls = [];
  return { tabs, calls, api: {
    windows: { async getAll() { return [{ id: 1, focused: true }]; }, async update(id, change) { calls.push(['window', id, change]); } },
    tabs: {
      async query() { return tabs.map(tab => ({ ...tab })); },
      async get(id) { return { ...tabs.find(tab => tab.id === id) }; },
      async update(id, change) { calls.push(['focus', id, change]); },
      async create(change) { calls.push(['create', change]); tabs.push({ id: tabs.length + 1, windowId: 1, status: 'loading', pendingUrl: change.url }); },
    },
  } };
}

test('Windows focuses the existing deeper view without navigating or creating a tab', async () => {
  const h = browser([{ url: photo, active: true }]);
  assert.deepEqual(await routeToTab(place, new LiveLearning(policy), h.api), { result: 'focused' });
  assert.deepEqual(h.calls.map(call => call[0]), ['focus', 'window']);
  assert.equal(h.tabs[0].url, photo);
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
