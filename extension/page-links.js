(() => {
  // Active from page start and never waiting on the extension: a slow extension only delays the switch. A script
  // disconnected by an extension update fails its first send synchronously and then leaves clicks to the browser.
  let enabled = true;
  const mac = /^Mac/.test(navigator.platform);
  const topFrame = window.top === window;
  // Match keys of the other tabs on this site, kept current by the extension, and the rules to compute a link's keys.
  let reuseKeys = new Set();
  let rules = null;

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

  // Whether another tab on this site already shows url: the link's own keys, as the background computes them.
  function shownElsewhere(url) {
    if (!rules || !reuseKeys.size) return false;
    const { normalizedKey, urlRules } = globalThis.linkReuseURLRules;
    return [url, normalizedKey(url, rules), urlRules(url, rules).identity].some(key => key && reuseKeys.has(key));
  }

  // Hands the click to the extension: it is cancelled once the request is on its way, and settle() acts on the answer,
  // however long that takes. A script disconnected by an extension update cannot send and leaves the click alone.
  function handOver(event, message, settle) {
    let response;
    try { response = chrome.runtime.sendMessage(message); } catch { enabled = false; return false; }
    event.preventDefault();
    event.stopImmediatePropagation();
    void response.then(settle, () => settle(null));
    return true;
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
      // A plain same-tab link to a page another tab on this site shows: switch there before the page or its router sees
      // the click. Should that tab be gone by then, the link loads here as an ordinary page load. Other links: untouched.
      const url = anchor.href;
      if (topFrame && ['', '_self', '_top', '_parent'].includes(target) && /^https?:/i.test(url) && shownElsewhere(url)) {
        handOver(event, { type: 'page-navigate', url }, reply => { if (reply?.result !== 'focused') location.assign(url); });
      }
      return skip('target');
    }
    let url;
    try { url = new URL(anchor.href); } catch { return skip('other'); }
    if (!['http:', 'https:'].includes(url.protocol)) return skip('other');
    if (!handOver(event, { type: 'page-link', url: url.href, active: event.shiftKey || (!middle && !modified) },
      reply => { if (!['focused', 'moved', 'opened'].includes(reply?.result)) failed(); })) return skip('disabled');
  }
  window.addEventListener('click', open, true);
  window.addEventListener('auxclick', open, true);

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
