import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./extension/page-links.js', import.meta.url), 'utf8');
const rulesSource = readFileSync(new URL('./extension/url-rules.js', import.meta.url), 'utf8');
const policy = JSON.parse(readFileSync(new URL('./extension/learning-policy.json', import.meta.url)));
const settle = () => new Promise(setImmediate);

// keys: the match keys of other tabs on this site that the extension hands the page when it starts.
function harness({ platform = 'win', reply = { result: 'focused' }, keys = [], baseTarget, broken = false, framed = false } = {}) {
  const listeners = new Map(), sent = [], notices = [], skips = [], assigned = [], requests = [];
  let messageListener;
  const node = () => ({ style: {}, setAttribute() {}, addEventListener() {}, append() {}, remove() {} });
  const document = {
    querySelector: () => baseTarget ? { getAttribute: () => baseTarget } : null,
    getElementById: id => notices.find(value => value.id === id), createElement: node,
    documentElement: { append: value => notices.push(value) },
  };
  const runtime = {
    onMessage: { addListener(fn) { messageListener = fn; } },
    sendMessage(message) {
      if (message.type === 'page-skip') { skips.push(message.reason); return Promise.resolve(); }
      if (message.type === 'page-keys') { requests.push(message); return Promise.resolve({ keys, rules: policy }); }
      sent.push(message);
      if (broken) throw new Error('Extension context invalidated.');
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  };
  const window = { addEventListener(type, fn) { listeners.set(type, fn); } };
  window.top = framed ? {} : window;
  const context = vm.createContext({ chrome: { runtime }, document, URL, TextEncoder, TextDecoder, atob, window,
    navigator: { platform: platform === 'mac' ? 'MacIntel' : 'Win32' },
    location: { assign: url => assigned.push(url) } });
  vm.runInContext(rulesSource, context);
  vm.runInContext(source, context);
  const click = (attributes = {}, change = {}) => {
    const anchor = { localName: 'a', href: attributes.href ?? 'https://example.test/item', rel: attributes.rel ?? '',
      hasAttribute: name => name === 'href' || name in attributes,
      getAttribute: name => attributes[name] ?? null };
    const event = { type: 'click', button: 0, isTrusted: true, defaultPrevented: false, timeStamp: 0,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      composedPath: () => [{ localName: 'span' }, anchor],
      preventDefault() { this.cancelled = true; }, stopImmediatePropagation() { this.stopped = true; }, ...change };
    listeners.get(event.type)(event);
    return event;
  };
  // The extension pushing new keys after tabs changed.
  const push = value => messageListener?.({ type: 'page-keys', keys: value });
  return { click, push, sent, notices, skips, assigned, requests };
}

test('new-tab webpage gestures cancel the default before requesting one shared route', async () => {
  for (const [attributes, event, active] of [
    [{ target: '_blank' }, {}, true], [{}, { ctrlKey: true }, false],
    [{}, { type: 'auxclick', button: 1 }, false], [{}, { ctrlKey: true, shiftKey: true }, true],
    [{}, { type: 'auxclick', button: 1, shiftKey: true }, true],
  ]) {
    const h = harness();
    await settle();
    const clicked = h.click(attributes, event);
    assert.equal(clicked.cancelled, true);
    assert.equal(clicked.stopped, true);
    assert.equal(h.sent.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(h.sent[0])), { type: 'page-link', url: 'https://example.test/item', active });
    await settle();
    assert.equal(h.notices.length, 0);
  }
});

test('base targets and keyboard activation of a blank-target link are supported', async () => {
  const h = harness({ baseTarget: '_blank' });
  await settle();
  assert.equal(h.click({}, { detail: 0 }).cancelled, true);
  assert.equal(h.click({ target: '_self' }).cancelled, undefined);
});

test('macOS uses Command-click for new tabs and treats Control-click as a regular click', async () => {
  const h = harness({ platform: 'mac' });
  await settle();
  assert.equal(h.click({}, { metaKey: true }).cancelled, true);
  assert.equal(h.click({}, { metaKey: true, shiftKey: true }).cancelled, true);
  assert.equal(h.click({ target: '_blank' }, { ctrlKey: true }).cancelled, true);
  assert.equal(h.click({}, { ctrlKey: true }).cancelled, undefined);
  assert.equal(h.click({ target: '_blank' }, { type: 'auxclick', button: 2 }).cancelled, undefined);
});

test('ordinary navigation, downloads, new-window gestures and synthetic clicks keep browser behavior', async () => {
  for (const [attributes, event] of [
    [{}, {}], [{ target: '_self' }, {}], [{ target: 'named-window' }, {}],
    [{ target: '_blank', download: '' }, {}], [{ target: '_blank' }, { altKey: true }],
    [{ target: '_blank' }, { shiftKey: true }], [{ target: '_blank' }, { defaultPrevented: true }],
    [{ target: '_blank' }, { isTrusted: false }], [{}, { type: 'auxclick', button: 2 }],
    [{}, { ctrlKey: true, composedPath: () => [] }],
    [{ target: '_blank' }, { composedPath: () => [{ localName: 'a', href: 'mailto:test@example.test', hasAttribute: () => true, getAttribute: () => '_blank' }] }],
  ]) {
    const h = harness();
    await settle();
    assert.equal(h.click(attributes, event).cancelled, undefined);
    assert.equal(h.sent.length, 0);
  }
});

test('links are handled from page start, before the extension has answered anything', () => {
  const h = harness({ platform: 'mac', reply: new Promise(() => {}) });
  const clicked = h.click({}, { metaKey: true });
  assert.equal(clicked.cancelled, true);
  assert.deepEqual(h.sent.map(message => message.type), ['page-link']);
  assert.equal(h.notices.length, 0);
});

test('an invalidated source script leaves the default action intact', async () => {
  const h = harness({ broken: true });
  await settle();
  assert.equal(h.click({ target: '_blank' }).cancelled, undefined);
  assert.equal(h.click({ target: '_blank' }).cancelled, undefined);
  assert.equal(h.sent.length, 1);
});

test('an uncertain response shows one local error without automatically opening a second tab', async () => {
  for (const reply of [{ error: 'Could not focus a tab.' }, null, new Error('Connection closed.')]) {
    const h = harness({ reply });
    await settle();
    h.click({ target: '_blank' });
    await settle();
    h.click({ target: '_blank' });
    await settle();
    assert.equal(h.notices.length, 1);
    assert.equal(h.sent.filter(message => message.type === 'page-link').length, 2);
  }
});

test('new-tab gestures left to the browser report a URL-free reason; ordinary clicks report nothing', async () => {
  const h = harness({ platform: 'mac' });
  await settle();
  h.click({}, { metaKey: true, composedPath: () => [] });
  h.click({ target: '_blank', download: '' }, { metaKey: true });
  h.click({}, { metaKey: true, defaultPrevented: true });
  h.click({}, {});
  h.click({ target: '_self' }, {});
  assert.deepEqual(h.skips, ['anchor', 'anchor', 'prevented']);
});

test('a plain link to a page another tab on this site shows switches at the click, before the page or its router sees it', async () => {
  const h = harness({ keys: ['https://example.test/item'] });
  assert.equal(h.requests.length, 1);
  await settle();
  const clicked = h.click();
  assert.equal(clicked.cancelled, true);
  assert.equal(clicked.stopped, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'page-navigate');
  assert.deepEqual(JSON.parse(JSON.stringify(h.sent[0])), { type: 'page-navigate', url: 'https://example.test/item' });
  await settle();
  assert.deepEqual(h.assigned, []);
});

test('a link matches by the same keys the background uses: normalized URL or identity rule', async () => {
  const issue = 'https://acme.atlassian.net/browse/OPS-7';
  const identity = JSON.stringify(['jira-issue', 'https://acme.atlassian.net', 'OPS-7', '', '']);
  for (const [href, keys] of [
    ['https://acme.atlassian.net/browse/ops-7/', [identity]],
    [issue + '?searchId=4#comment', [identity]],
    ['https://example.test/item?utm_source=mail&b=2&a=1', ['https://example.test/item?a=1&b=2']],
  ]) {
    const h = harness({ keys });
    await settle();
    assert.equal(h.click({ href }).cancelled, true, href);
  }
});

test('the switch has no time limit; if the tab is gone by then, or the extension fails, the link loads here', async () => {
  // However long a slow browser takes, nothing happens until the answer.
  let answer;
  const slow = harness({ keys: ['https://example.test/item'], reply: new Promise(resolve => { answer = resolve; }) });
  await settle();
  assert.equal(slow.click().cancelled, true);
  await settle();
  assert.deepEqual(slow.assigned, []);
  answer({ result: 'focused' });
  await settle();
  assert.deepEqual(slow.assigned, []);
  for (const reply of [{ result: 'none' }, { error: 'The matching tab changed. Please open the link again.' }, null, new Error('Connection closed.')]) {
    const h = harness({ keys: ['https://example.test/item'], reply });
    await settle();
    assert.equal(h.click().cancelled, true);
    await settle();
    assert.deepEqual(h.assigned, ['https://example.test/item'], JSON.stringify(reply));
    assert.equal(h.notices.length, 0);
  }
});

test('a plain link no other tab on this site shows is left alone, with no message at all', async () => {
  for (const keys of [[], ['https://example.test/other']]) {
    const h = harness({ keys });
    await settle();
    assert.equal(h.click().cancelled, undefined);
    assert.equal(h.sent.length, 0);
  }
});

test('before the keys arrive, a plain link is left alone; pushed keys take effect at once', async () => {
  const h = harness({ keys: [] });
  assert.equal(h.click().cancelled, undefined);
  await settle();
  h.push(['https://example.test/item']);
  assert.equal(h.click().cancelled, true);
  h.push([]);
  assert.equal(h.click().cancelled, undefined);
  assert.equal(h.sent.length, 1);
});

test('frames, other targets, downloads, modified and synthetic clicks never switch for a plain link', async () => {
  for (const [attributes, click, options] of [
    [{ target: 'frame' }, {}], [{ download: '' }, {}], [{}, { isTrusted: false }], [{}, { defaultPrevented: true }],
    [{}, { altKey: true }], [{}, { shiftKey: true }], [{ href: 'mailto:someone@example.test' }, {}], [{}, {}, { framed: true }],
  ]) {
    const h = harness({ keys: ['https://example.test/item', 'mailto:someone@example.test'], ...options });
    await settle();
    assert.equal(h.click(attributes, click).cancelled, undefined, JSON.stringify([attributes, click, options]));
    assert.equal(h.sent.filter(message => message.type === 'page-navigate').length, 0);
  }
  // A framed page never asks for keys: it cannot load a link in this tab's top frame.
  assert.equal(harness({ framed: true }).requests.length, 0);
});
