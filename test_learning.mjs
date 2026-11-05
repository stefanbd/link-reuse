import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allowsLearning } from './extension/learning.mjs';

const policy = JSON.parse(readFileSync(new URL('./extension/learning-policy.json', import.meta.url)));
const vectors = JSON.parse(readFileSync(new URL('./privacy-vectors.json', import.meta.url)));

test('shared privacy vectors match the browser policy on both platforms', () => {
  for (const vector of vectors) assert.equal(allowsLearning(vector.url, policy), vector.allowed, vector.url);
  assert.equal(allowsLearning('https://example.test/' + 'a'.repeat(4096), policy), false);
});
