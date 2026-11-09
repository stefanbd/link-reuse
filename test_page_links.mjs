import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./extension/page-links.js', import.meta.url), 'utf8');
const settle = () => new Promise(setImmediate);

function harness({ platform = 'win', reply = { result: 'focused' }, baseTarget, broken = false } = {}) {
  const listeners = new Map(), sent = [], notices = [], skips = [];
  const node = () => ({ style: {}, setAttribute() {}, addEventListener() {}, append() {}, remove() {} });
  const document = {
    querySelector: () => baseTarget ? { getAttribute: () => baseTarget } : null,
    getElementById: id => notices.find(value => value.id === id), createElement: node,
    documentElement: { append: value => notices.push(value) },
  };
  const runtime = { sendMessage(message) {
    if (message.type === 'page-skip') { skips.push(message.reason); return Promise.resolve(); }
    sent.push(message);
    if (broken) throw new Error('Extension context invalidated.');
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  } };
  vm.runInNewContext(source, { chrome: { runtime }, document, URL, navigator: { platform: platform === 'mac' ? 'MacIntel' : 'Win32' },
    window: { addEventListener(type, fn) { listeners.set(type, fn); } } });
  const click = (attributes = {}, change = {}) => {
    const anchor = { localName: 'a', href: 'https://example.test/item',
      hasAttribute: name => name === 'href' || name in attributes,
      getAttribute: name => attributes[name] ?? null };
    const event = { type: 'click', button: 0, isTrusted: true, defaultPrevented: false,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      composedPath: () => [{ localName: 'span' }, anchor],
      preventDefault() { this.cancelled = true; }, stopImmediatePropagation() { this.stopped = true; }, ...change };
    listeners.get(event.type)(event);
    return event;
  };
  return { click, sent, notices, skips };
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
