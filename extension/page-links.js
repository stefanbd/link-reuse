(() => {
  // Active from page start. Waiting for the extension to answer first let new-tab clicks through to the browser
  // whenever the browser was slow; now a slow extension only delays the tab switch. A script disconnected by an
  // extension update fails its first send synchronously and then leaves clicks to the browser.
  let enabled = true;
  const mac = /^Mac/.test(navigator.platform);
  const topFrame = window.top === window;
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
      // A plain same-tab link: the navigate handler below may switch to a tab that already shows it.
      if (topFrame && /^https?:/i.test(anchor.href) && ['', '_self', '_top', '_parent'].includes(target) &&
          !/\bnoreferrer\b/i.test(anchor.rel ?? '') && !anchor.hasAttribute('referrerpolicy')) {
        clicked = { url: anchor.href, at: event.timeStamp };
      }
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

  // The navigate event fires only once a click has really become a navigation, after the page's own handlers (so
  // client-side routing is untouched). It is cancelled while the extension checks for a tab already showing the
  // destination; without one, or without an answer within a second, the navigation resumes unchanged.
  if (!topFrame || !globalThis.navigation) return;
  navigation.addEventListener('navigate', event => {
    const link = clicked;
    clicked = null;
    if (!enabled || !link || event.timeStamp - link.at > 1000 || link.url !== event.destination.url || !event.userInitiated ||
        !event.cancelable || event.navigationType !== 'push' || event.hashChange || event.formData || event.downloadRequest) return;
    let response;
    try {
      response = chrome.runtime.sendMessage({ type: 'page-navigate', url: link.url, deadline: Date.now() + 800 });
    } catch { enabled = false; return; }
    event.preventDefault();
    let settled = false;
    const finish = reused => {
      if (settled) return;
      settled = true;
      if (!reused) location.assign(link.url);
    };
    setTimeout(() => finish(false), 1000);
    void response.then(reply => finish(reply?.result === 'focused'), () => finish(false));
  });
})();
