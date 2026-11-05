import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LiveLearning } from './extension/matching.mjs';

const policy = JSON.parse(readFileSync(new URL('./extension/learning-policy.json', import.meta.url)));
const vectors = JSON.parse(readFileSync(new URL('./matching-vectors.json', import.meta.url)));

for (const vector of vectors) test(vector.name, () => {
  const learning = new LiveLearning(policy);
  for (const [request, candidate] of [[vector.left, vector.right], [vector.right, vector.left]]) {
    assert.equal(learning.matches(learning.resolve(request), { id: 1, url: candidate }), vector.match);
  }
});

test('invalid configured patterns cannot disable normal URL matching', () => {
  const learning = new LiveLearning({ ...policy, identityRules: [{ name: 'bad', host: '[', path: '[', identity: '$1' }] });
  const url = 'https://example.test/item';
  assert.equal(learning.matches(learning.resolve(url), { id: 1, url }), true);
});

test('learned redirect sources use the same comparison normalization as open tabs', () => {
  const learning = new LiveLearning(policy);
  const target = 'https://example.test/item';
  learning.observe([{ kind: 'redirect', source: 'https://example.test/short?utm_source=one', destination: target }]);
  assert.equal(learning.matches(learning.resolve('https://example.test/short?utm_source=two'), { id: 1, url: target }), true);
  learning.observe([{ kind: 'redirect', source: 'https://example.test/short?utm_source=two', destination: null }]);
  assert.equal(learning.records.size, 0);
});
