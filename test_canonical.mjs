import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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

function readMetadata(canonicals, graphURLs) {
  const messages = [];
  let observed;
  vm.runInNewContext(readFileSync(new URL('./extension/canonical.js', import.meta.url), 'utf8'), {
    location: { href: 'https://shop.test/item/reviews' },
    document: { readyState: 'complete', head: { querySelectorAll: selector => selector.startsWith('link') ?
      canonicals.map(href => ({ href })) : graphURLs.map(content => ({ content })) } },
    MutationObserver: class { constructor() {} observe(_head, options) { observed = options; } },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: async message => { messages.push(message); } } },
  });
  return { hrefs: Array.from(messages[0].hrefs), observed };
}

test('the content script uses Open Graph only when no canonical is declared', () => {
  assert.deepEqual(readMetadata([], ['https://shop.test/item']).hrefs, ['https://shop.test/item']);
  assert.deepEqual(readMetadata(['https://shop.test/explicit'], ['https://shop.test/item']).hrefs, ['https://shop.test/explicit']);
  assert.equal(canonical('https://shop.test/item/reviews', readMetadata([], ['https://other.test/item']).hrefs), null);
  assert.equal(canonical('https://shop.test/item/reviews', readMetadata([], ['https://shop.test/item', 'https://shop.test/other']).hrefs), null);
  const filter = Array.from(readMetadata([], []).observed.attributeFilter);
  assert.ok(filter.includes('content') && filter.includes('property'));
});

test('page scripts left behind by an extension reload neither throw nor keep watching the page', () => {
  const invalidated = () => { throw new Error('Extension context invalidated.'); };
  let disconnected = false;
  let onMutation;
  vm.runInNewContext(readFileSync(new URL('./extension/canonical.js', import.meta.url), 'utf8'), {
    location: { href: 'https://shop.test/item' },
    document: { readyState: 'complete', head: { querySelectorAll: () => [] } },
    MutationObserver: class { constructor(fn) { onMutation = fn; } observe() {} disconnect() { disconnected = true; } },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: invalidated } },
  });
  assert.equal(disconnected, true);
  assert.doesNotThrow(() => onMutation());
  const listeners = new Map();
  vm.runInNewContext(readFileSync(new URL('./extension/interaction.js', import.meta.url), 'utf8'), {
    window: { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage: invalidated } },
  });
  assert.doesNotThrow(() => listeners.get('pointerdown')({ isTrusted: true }));
});
