(() => {
  // Active from page start. Waiting for the extension to answer first let new-tab clicks through to the browser
  // whenever the browser was slow; now a slow extension only delays the tab switch. A script disconnected by an
  // extension update fails its first send synchronously and then leaves clicks to the browser.
  let enabled = true;
  const mac = /^Mac/.test(navigator.platform);
  const topFrame = window.top === window;
  let probe = null;
  let clicked = null;

  // URL-free note of why a new-tab gesture was left to the browser, for the native diagnostics log.
  function skipped(reason) {
    try { void chrome.runtime.sendMessage({ type: 'page-skip', reason }).catch(() => {}); } catch {}
  }

  function failed() {
    if (document.getElementById('link-reuse-error')) return;
    const notice = document.createElement('div');
    notice.id = 'link-reuse-error';
    notice.setAttribute('role', 'alert');
    notice.textContent = 'Link Reuse could not open this link. Try again or check the extension popup. ';
    Object.assign(notice.style, { position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
      maxWidth: '360px', padding: '12px', border: '1px solid GrayText', color: 'CanvasText', background: 'Canvas', font: '14px/1.5 system-ui' });
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => notice.remove());
    notice.append(dismiss);
    document.documentElement.append(notice);
  }

  // A plain left click on a link that loads in this tab (top frame only), as the URL it loads, or null.
  function sameTabLink(event, anchor) {
    if (!topFrame || !enabled || !event.isTrusted || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
    anchor ??= event.composedPath().find(value => value.localName === 'a' && value.hasAttribute('href'));
    if (!anchor || anchor.hasAttribute('download') || !/^https?:/i.test(anchor.href)) return null;
    const target = (anchor.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '').toLowerCase();
    if (!['', '_self', '_top', '_parent'].includes(target) || /\bnoreferrer\b/i.test(anchor.rel ?? '') || anchor.hasAttribute('referrerpolicy')) return null;
    return anchor.href;
  }

  // Selects the other tab that shows url; otherwise (no tab, failure, no answer within a second) resume() runs once.
  function reuse(url, resume, resuming = false) {
    let response;
    try {
      response = chrome.runtime.sendMessage({ type: 'page-navigate', url, deadline: Date.now() + 800, resuming });
    } catch { enabled = false; return false; }
    let settled = false;
    const finish = reused => {
      if (settled) return;
      settled = true;
      if (!reused) resume();
    };
    setTimeout(() => finish(false), 1000);
    void response.then(reply => finish(reply?.result === 'focused'), () => finish(false));
    return true;
  }

  // Pressing a same-tab link asks whether another tab already shows it; the answer normally arrives before the click.
  function pressed(event) {
    const url = sameTabLink(event);
    if (!url) return;
    const current = probe = { url };
    try {
      void chrome.runtime.sendMessage({ type: 'page-probe', url }).then(reply => { current.answer = reply?.result; }, () => {});
    } catch { enabled = false; }
  }

  function open(event) {
    const gesture = event.isTrusted && (event.metaKey || event.ctrlKey || (event.type === 'auxclick' && event.button === 1));
    const skip = reason => { if (gesture) skipped(reason); };
    if (!enabled) return skip('disabled');
    if (!event.isTrusted || event.defaultPrevented || event.altKey) return skip(event.defaultPrevented ? 'prevented' : 'other');
    const middle = event.type === 'auxclick' && event.button === 1;
    const modified = mac ? event.metaKey : event.ctrlKey;
    if (!middle && (event.type !== 'click' || event.button !== 0)) return skip('button');
    if (event.shiftKey && !middle && !modified) return skip('other');
    const anchor = event.composedPath().find(value => value.localName === 'a' && value.hasAttribute('href'));
    if (!anchor || anchor.hasAttribute('download')) return skip('anchor');
    const target = (anchor.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '').toLowerCase();
    if (!middle && !modified && target !== '_blank') {
      // A plain same-tab link. Another tab already shows it: switch there before the page (or its router) sees the
      // click, replaying the click if that fails. No other tab: leave the click alone. Not known yet: the navigate
      // handler below decides once the click has become a real page load.
      const url = sameTabLink(event, anchor);
      const answer = url && probe?.url === url ? probe.answer : undefined;
      probe = null;
      if (answer === 'match' && reuse(url, () => anchor.isConnected ? anchor.click() : location.assign(url))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (url && answer === undefined) clicked = { url, at: event.timeStamp, event };
      return skip('target');
    }
    let url;
    try { url = new URL(anchor.href); } catch { return skip('other'); }
    if (!['http:', 'https:'].includes(url.protocol)) return skip('other');
    let response;
    try {
      response = chrome.runtime.sendMessage({ type: 'page-link', url: url.href, active: event.shiftKey || (!middle && !modified) });
    } catch { enabled = false; return skip('disabled'); }
    event.preventDefault();
    event.stopImmediatePropagation();
    void response.then(reply => { if (!['focused', 'moved', 'opened'].includes(reply?.result)) failed(); }).catch(failed);
  }
  window.addEventListener('click', open, true);
  window.addEventListener('auxclick', open, true);

  window.addEventListener('pointerdown', pressed, { capture: true, passive: true });

  // Fallback when the click came before the answer (a fast click or the keyboard): the navigate event fires once a
  // click has really become a navigation. It is held while the extension checks, then resumes unchanged.
  if (!topFrame || !globalThis.navigation) return;
  navigation.addEventListener('navigate', event => {
    const link = clicked;
    clicked = null;
    // The recorded trusted click identifies the user's link (Safari reports userInitiated false even for it). A link's
    // own navigation starts after that click has finished dispatching, uncancelled, and leaves the document. A router's
    // pushState does not: it runs inside a click handler, after the page cancelled the click, or within the document.
    if (!link || event.timeStamp - link.at > 1000 || link.url !== event.destination.url ||
        link.event.eventPhase || link.event.defaultPrevented || event.destination.sameDocument ||
        !event.cancelable || event.navigationType !== 'push' || event.hashChange || event.formData || event.downloadRequest) return;
    if (reuse(link.url, () => location.assign(link.url), true)) event.preventDefault();
  });
})();
