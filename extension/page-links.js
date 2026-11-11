// Handles link clicks on web pages from the moment a page starts loading, before its own scripts can act. New-tab
// gestures go to the extension; a plain link to a page another tab shows switches to that tab.
(() => {
  const mac = /^Mac/.test(navigator.platform);
  const topFrame = window.top === window;
  // False once an extension update orphans this script; clicks are then left to the browser.
  let enabled = true;
  // Fingerprints of the other tabs' match keys, kept current by the extension, and the rules to compute a link's keys.
  let reuseKeys = new Set();
  let rules = null;

  /** A URL-free note of why a new-tab gesture was left to the browser, for the native log. */
  function skipped(reason) {
    try { void chrome.runtime.sendMessage({ type: 'page-skip', reason }).catch(() => {}); } catch {}
  }

  /** Shown when a link could not be opened; nothing retries, so a failure never opens a duplicate. */
  function failed() {
    if (document.getElementById('link-reuse-error')) return;
    const notice = document.createElement('div');
    notice.id = 'link-reuse-error';
    notice.setAttribute('role', 'alert');
    notice.textContent = 'Link Reuse could not open this link. Try again or check the extension popup. ';
    Object.assign(notice.style, {
      position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647', maxWidth: '360px', padding: '12px',
      border: '1px solid GrayText', color: 'CanvasText', background: 'Canvas', font: '14px/1.5 system-ui',
    });
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => notice.remove());
    notice.append(dismiss);
    document.documentElement.append(notice);
  }

  /** Whether another tab shows url, by the same keys the background computes. */
  function shownElsewhere(url) {
    if (!rules || !reuseKeys.size) return false;
    const { normalizedKey, urlRules, fingerprint } = globalThis.linkReuseURLRules;
    return [url, normalizedKey(url, rules), urlRules(url, rules).identity]
      .some(key => key && reuseKeys.has(fingerprint(key)));
  }

  /** Cancels the click once the extension has the request; settle() acts on the answer, however long it takes. */
  function handOver(event, message, settle) {
    let response;
    try { response = chrome.runtime.sendMessage(message); } catch { enabled = false; return false; }
    event.preventDefault();
    event.stopImmediatePropagation();
    void response.then(settle, () => settle(null));
    return true;
  }

  function linkTarget(anchor) {
    const target = anchor.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target');
    return (target ?? '').toLowerCase();
  }

  function onClick(event) {
    const middle = event.type === 'auxclick' && event.button === 1;
    const gesture = event.isTrusted && (event.metaKey || event.ctrlKey || middle);
    const skip = reason => { if (gesture) skipped(reason); };
    if (!enabled) return skip('disabled');
    if (event.defaultPrevented) return skip('prevented');
    if (!event.isTrusted || event.altKey) return skip('other');
    const modified = mac ? event.metaKey : event.ctrlKey;
    if (!middle && (event.type !== 'click' || event.button !== 0)) return skip('button');
    if (event.shiftKey && !middle && !modified) return skip('other');
    const anchor = event.composedPath().find(value => value.localName === 'a' && value.hasAttribute('href'));
    if (!anchor || anchor.hasAttribute('download')) return skip('anchor');
    const target = linkTarget(anchor);

    if (!middle && !modified && target !== '_blank') {
      // A plain link that loads in this tab. If another tab shows it, switch there before the page or its
      // router sees the click; should that tab be gone by then, the link loads here after all. Other links: untouched.
      const url = anchor.href;
      const sameTab = topFrame && ['', '_self', '_top', '_parent'].includes(target) && /^https?:/i.test(url);
      if (sameTab && shownElsewhere(url)) {
        handOver(event, { type: 'page-navigate', url }, reply => {
          if (reply?.result !== 'focused') location.assign(url);
        });
      }
      return skip('target');
    }

    let url;
    try { url = new URL(anchor.href); } catch { return skip('other'); }
    if (!['http:', 'https:'].includes(url.protocol)) return skip('other');
    const message = { type: 'page-link', url: url.href, active: event.shiftKey || (!middle && !modified) };
    const handed = handOver(event, message, reply => {
      if (!['focused', 'moved', 'opened'].includes(reply?.result)) failed();
    });
    if (!handed) return skip('disabled');
  }

  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);

  if (!topFrame) return;
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'page-keys' && Array.isArray(message.keys)) reuseKeys = new Set(message.keys);
  });
  try {
    void chrome.runtime.sendMessage({ type: 'page-keys' }).then(reply => {
      if (!reply || !Array.isArray(reply.keys)) return;
      rules = reply.rules;
      reuseKeys = new Set(reply.keys);
    }, () => {});
  } catch { enabled = false; }
})();
