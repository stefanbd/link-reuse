import test from 'node:test';
import assert from 'node:assert/strict';
import { RedirectObserver } from './extension/observer.mjs';

const A = 'https://example.test/source';
const B = 'https://example.test/destination';
const C = 'https://example.test/next-page';
const event = (url, documentId = 'one', transitionQualifiers = []) => ({ tabId: 1, url, documentId, transitionQualifiers });

test('server redirects preserve the requested URL', () => {
  const observer = new RedirectObserver();
  observer.before(event(A));
  assert.deepEqual(observer.committed(event(B)), [{ source: A, destination: B }]);
});

test('client redirect chains preserve earlier source URLs', () => {
  const observer = new RedirectObserver();
  observer.before(event(A)); observer.committed(event(B));
  observer.before(event(C, 'two'));
  assert.deepEqual(observer.committed(event(C, 'two', ['client_redirect'])), [
    { source: A, destination: C }, { source: B, destination: C },
  ]);
});

test('automatic History API rewrites are learned', () => {
  const observer = new RedirectObserver();
  observer.before(event(A)); observer.committed(event(A));
  assert.deepEqual(observer.history(event(B)), [{ source: A, destination: B }]);
});

test('user navigation inside an SPA is not treated as a redirect', () => {
  const observer = new RedirectObserver();
  observer.before(event(A)); observer.committed(event(A));
  observer.interact(1, 'one');
  assert.deepEqual(observer.history(event(B)), []);
});

test('ordinary new navigation does not inherit the previous page', () => {
  const observer = new RedirectObserver();
  observer.before(event(A)); observer.committed(event(A));
  observer.before(event(B, 'two'));
  assert.deepEqual(observer.committed(event(B, 'two')), []);
});

test('stale document events cannot alter the current chain', () => {
  const observer = new RedirectObserver();
  observer.before(event(A)); observer.committed(event(A));
  assert.deepEqual(observer.history(event(B, 'old')), []);
  observer.interact(1, 'old');
  assert.deepEqual(observer.history(event(B)), [{ source: A, destination: B }]);
});

test('closed tabs discard navigation state', () => {
  const observer = new RedirectObserver();
  observer.before(event(A)); observer.committed(event(A)); observer.remove(1);
  assert.deepEqual(observer.history(event(B)), []);
});
