import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./extension/page-links.js', import.meta.url), 'utf8');
const settle = () => new Promise(setImmediate);

function harness({ platform = 'win', reply = { result: 'focused' }, baseTarget, broken = false, framed = false } = {}) {
  const listeners = new Map(), sent = [], notices = [], skips = [], assigned = [], timers = [];
  let navigateListener;
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
  const window = { addEventListener(type, fn) { listeners.set(type, fn); } };
  window.top = framed ? {} : window;
  vm.runInNewContext(source, { chrome: { runtime }, document, URL, window, navigator: { platform: platform === 'mac' ? 'MacIntel' : 'Win32' },
    navigation: { addEventListener(type, fn) { if (type === 'navigate') navigateListener = fn; } },
    location: { assign: url => assigned.push(url) }, setTimeout: fn => timers.push(fn), Date });
  const click = (attributes = {}, change = {}) => {
    const anchor = { localName: 'a', href: 'https://example.test/item', rel: attributes.rel ?? '',
      hasAttribute: name => name === 'href' || name in attributes,
      getAttribute: name => attributes[name] ?? null };
    const event = { type: 'click', button: 0, isTrusted: true, defaultPrevented: false, timeStamp: 0,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      composedPath: () => [{ localName: 'span' }, anchor],
      preventDefault() { this.cancelled = true; }, stopImmediatePropagation() { this.stopped = true; }, ...change };
    listeners.get(event.type)(event);
    return event;
  };
  // The browser's navigate event for the navigation a click started (Navigation API).
  const navigate = (change = {}) => {
    const event = { destination: { url: 'https://example.test/item' }, userInitiated: true, cancelable: true, navigationType: 'push',
      hashChange: false, formData: null, downloadRequest: null, timeStamp: 40, preventDefault() { this.cancelled = true; }, ...change };
    navigateListener?.(event);
    return event;
  };
  return { click, navigate, sent, notices, skips, assigned, timers };
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

test('a same-tab link to a page open in another tab is held while the extension switches to that tab', async () => {
  const h = harness({ reply: { result: 'focused' } });
  assert.equal(h.click().cancelled, undefined);
  const navigation = h.navigate();
  assert.equal(navigation.cancelled, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'page-navigate');
  assert.equal(h.sent[0].url, 'https://example.test/item');
  assert.ok(h.sent[0].deadline > Date.now());
  await settle();
  assert.deepEqual(h.assigned, []);
});

test('without a matching tab, on failure or without an answer within a second the navigation resumes once', async () => {
  for (const reply of [{ result: 'none' }, { error: 'Could not focus a tab.' }, new Error('Connection closed.'), new Promise(() => {})]) {
    const h = harness({ reply });
    h.click();
    assert.equal(h.navigate().cancelled, true);
    await settle();
    h.timers.forEach(fn => fn());
    await settle();
    assert.deepEqual(h.assigned, ['https://example.test/item']);
  }
});

test('navigations not started by a plain same-tab link click are left to the browser', async () => {
  for (const [attributes, click, navigation, options] of [
    [null, {}, {}], [{}, {}, { destination: { url: 'https://example.test/other' } }],
    [{}, {}, { formData: {} }], [{}, {}, { hashChange: true }], [{}, {}, { navigationType: 'replace' }], [{}, {}, { cancelable: false }],
    [{}, {}, { downloadRequest: 'file' }], [{}, {}, { timeStamp: 2000 }], [{ rel: 'noreferrer' }, {}, {}], [{ referrerpolicy: 'origin' }, {}, {}],
    [{ download: '' }, {}, {}], [{ target: 'frame' }, {}, {}], [{}, { isTrusted: false }, {}], [{}, { defaultPrevented: true }, {}],
    [{}, {}, {}, { framed: true }],
  ]) {
    const h = harness(options);
    if (attributes) h.click(attributes, click);
    assert.equal(h.navigate(navigation).cancelled, undefined, JSON.stringify([attributes, click, navigation, options]));
    assert.equal(h.sent.length, 0);
  }
});

test('Safari reports a link click navigation as not user-initiated; the recorded trusted click is what counts', async () => {
  const h = harness({ reply: { result: 'focused' } });
  h.click();
  assert.equal(h.navigate({ userInitiated: false }).cancelled, true);
  assert.equal(h.sent[0].type, 'page-navigate');
});
