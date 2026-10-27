import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowsLearning, PendingObservations } from './extension/learning.mjs';

const policy = JSON.parse(readFileSync(new URL('./extension/learning-policy.json', import.meta.url)));
const vectors = JSON.parse(readFileSync(new URL('./privacy-vectors.json', import.meta.url)));
const record = i => ({ kind: 'redirect', source: `https://example.test/source/${i}`, destination: `https://example.test/destination/${i}` });

test('shared privacy vectors match the native policy', () => {
  for (const vector of vectors) assert.equal(allowsLearning(vector.url, policy), vector.allowed, vector.url);
  assert.equal(allowsLearning('https://example.test/' + 'a'.repeat(4096), policy), false);
});
test('disconnected queues stay bounded by count and encoded bytes', () => {
  const queue = new PendingObservations({ ...policy, maxPendingRecords: 4, maxPendingBytes: 500 });
  for (let i = 0; i < 1000; i++) {
    queue.add(record(i));
    assert.ok(queue.items.size <= 4);
    assert.ok(queue.bytes <= 500);
  }
  assert.ok(queue.dropped > 0);
  assert.equal(queue.batch().at(-1).record.source, record(999).source);
});
test('a late acknowledgement cannot delete a newer observation for the same URL', () => {
  const queue = new PendingObservations(policy);
  queue.add(record(1));
  const flight = queue.batch();
  queue.add({ ...record(1), destination: 'https://example.test/new' });
  queue.acknowledge(flight);
  assert.equal(queue.items.size, 1);
  assert.equal(queue.batch()[0].record.destination, 'https://example.test/new');
});
test('sensitive URLs never enter the outgoing queue; revocation and clear work', () => {
  const queue = new PendingObservations(policy);
  queue.add({ ...record(1), destination: 'https://example.test/callback?code=abc' });
  queue.add({ ...record(1), source: 'https://example.test/a?token=abc' });
  assert.equal(queue.items.size, 0);
  queue.add({ ...record(1), kind: 'canonical', destination: null });
  assert.equal(queue.items.size, 1);
  queue.clear();
  assert.equal(queue.items.size, 0);
  assert.equal(queue.bytes, 0);
});
