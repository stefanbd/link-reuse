import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDestination as canonical } from './extension/canonical.mjs';

test('a declared product or article canonical groups its deeper views', () => {
  assert.equal(canonical('https://shop.test/products/42/reviews', ['https://shop.test/products/42']), 'https://shop.test/products/42');
  assert.equal(canonical('https://news.test/articles/a/gallery', ['https://news.test/articles/a']), 'https://news.test/articles/a');
});
test('canonical matching is opt-in from the page, not inferred from a path prefix', () => {
  assert.equal(canonical('https://shop.test/products/42/reviews', []), null);
  assert.equal(canonical('https://shop.test/products/42/reviews', ['https://shop.test/products/42', 'https://shop.test/products/42']), null);
});
test('unrelated items and broad homepage declarations are rejected', () => {
  assert.equal(canonical('https://shop.test/products/43', ['https://shop.test/products/42']), null);
  assert.equal(canonical('https://shop.test/products/420/reviews', ['https://shop.test/products/42']), null);
  assert.equal(canonical('https://shop.test/products/42', ['https://shop.test/']), null);
  assert.equal(canonical('https://shop.test/product?id=43', ['https://shop.test/product?id=42']), null);
});
test('cross-origin, fragment routes, credentials and malformed URLs are rejected', () => {
  for (const [page, target] of [
    ['https://shop.test/a/reviews', 'https://other.test/a'],
    ['https://shop.test/app#/item/42', 'https://shop.test/app'],
    ['https://shop.test/a/reviews', 'https://shop.test/a#photos'],
    ['https://user@shop.test/a/reviews', 'https://shop.test/a'],
    ['https://shop.test/a/reviews', 'javascript:alert(1)'],
  ]) assert.equal(canonical(page, [target]), null);
});
test('self canonical clears an old equivalence instead of creating a cycle', () => {
  assert.equal(canonical('https://shop.test/a', ['https://shop.test/a']), null);
});
