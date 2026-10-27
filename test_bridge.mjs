import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeBridge } from './extension/bridge.mjs';

const policy = JSON.parse(readFileSync(new URL('./extension/learning-policy.json', import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { for (const fn of this.listeners) fn(value); } });
const record = i => ({ kind: 'redirect', source: `https://example.test/${i}`, destination: 'https://example.test/live' });

function harness(queryTabs = async () => [{ url: 'https://example.test/live', incognito: false }]) {
  const ports = [];
  let resets = 0;
  const bridge = new NativeBridge(policy, {
    queryTabs, badge() {}, resetLearning() { resets++; },
    connectPort() {
      const port = { sent: [], onMessage: event(), onDisconnect: event(),
        postMessage(message) { this.sent.push(message); }, disconnect() { this.onDisconnect.emit(); } };
      ports.push(port); return port;
    },
  });
  const reply = (port, ack, generation = 'one') => port.onMessage.emit({ ready: true, ack, generation, records: 0, bytes: 100 });
  const stop = () => { clearTimeout(bridge.timer); if (bridge.port) bridge.port.disconnect(); clearTimeout(bridge.timer); };
  return { bridge, ports, reply, stop, get resets() { return resets; } };
}

test('disconnect and reconnect resend bounded unacknowledged work once', async () => {
  const h = harness();
  try {
    h.bridge.observe([record(1)]);
    await pause(70); h.reply(h.ports[0]); await pause(70);
    assert.equal(h.ports[0].sent.filter(m => m.type === 'snapshot').length, 1);
    h.ports[0].disconnect();
    for (let i = 2; i < 500; i++) h.bridge.observe([record(i)]);
    assert.ok(h.bridge.queue.items.size <= policy.maxPendingRecords);
    assert.ok(h.bridge.queue.bytes <= policy.maxPendingBytes);
    h.bridge.retryAt = 0; h.bridge.changed();
    await pause(70); h.reply(h.ports[1]); await pause(70);
    const snapshot = h.ports[1].sent.find(m => m.type === 'snapshot');
    assert.ok(snapshot.records.length <= policy.maxBatchRecords);
    h.reply(h.ports[1], snapshot.id);
    assert.equal(h.bridge.queue.items.size, policy.maxPendingRecords - snapshot.records.length);
  } finally { h.stop(); }
});

test('clear waits for native acknowledgement and discards older in-flight work', async () => {
  const h = harness();
  try {
    h.bridge.observe([record(1)]);
    await pause(70); h.reply(h.ports[0]); await pause(70);
    const old = h.ports[0].sent.find(m => m.type === 'snapshot');
    let completed = false;
    const clearing = h.bridge.clear().then(() => { completed = true; });
    await pause(0);
    const request = h.ports[0].sent.find(m => m.type === 'clear');
    assert.equal(completed, false);
    h.reply(h.ports[0], old.id);
    assert.equal(h.bridge.queue.items.size, 0);
    h.reply(h.ports[0], request.id, 'two');
    await clearing;
    assert.equal(h.bridge.generation, 'two');
    assert.equal(h.bridge.queue.items.size, 0);
    assert.ok(h.resets > 0);
  } finally { h.stop(); }
});

test('a tab closure during a snapshot query prevents sending the stale tab list', async () => {
  let release;
  let calls = 0;
  const h = harness(() => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve([]));
  try {
    h.bridge.observe([record(1)]);
    await pause(70); h.reply(h.ports[0]); await pause(0);
    h.bridge.changed();
    release([{ url: 'https://example.test/live', incognito: false }]);
    await pause(70);
    const snapshots = h.ports[0].sent.filter(m => m.type === 'snapshot');
    assert.equal(snapshots.length, 1);
    assert.deepEqual(snapshots[0].liveURLs, []);
  } finally { h.stop(); }
});

test('only an unfinished navigation temporarily retains the previous destination', async () => {
  let tabs = [{ id: 1, url: 'https://example.test/first', status: 'complete', incognito: false }];
  const h = harness(async () => tabs);
  try {
    await pause(70); h.reply(h.ports[0]); await pause(70);
    let snapshot = h.ports[0].sent.filter(m => m.type === 'snapshot').at(-1);
    h.reply(h.ports[0], snapshot.id);
    tabs = [{ ...tabs[0], url: 'https://example.test/second', status: 'loading' }];
    h.bridge.changed(); await pause(70);
    snapshot = h.ports[0].sent.filter(m => m.type === 'snapshot').at(-1);
    assert.deepEqual(snapshot.liveURLs, ['https://example.test/second', 'https://example.test/first']);
    h.reply(h.ports[0], snapshot.id);
    tabs = [{ ...tabs[0], status: 'complete' }];
    h.bridge.changed(); await pause(70);
    snapshot = h.ports[0].sent.filter(m => m.type === 'snapshot').at(-1);
    assert.deepEqual(snapshot.liveURLs, ['https://example.test/second']);
    h.reply(h.ports[0], snapshot.id);
    tabs = [];
    h.bridge.changed(); await pause(70);
    snapshot = h.ports[0].sent.filter(m => m.type === 'snapshot').at(-1);
    assert.deepEqual(snapshot.liveURLs, []);
    assert.equal(h.bridge.settledURLs.size, 0);
  } finally { h.stop(); }
});
