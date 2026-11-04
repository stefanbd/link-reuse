(() => {
  let enabled = false;
  chrome.runtime.sendMessage({ type: 'page-link-capability' }).then(reply => { enabled = reply?.enabled === true; }).catch(() => {});

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
    if (!enabled || !event.isTrusted || event.defaultPrevented || event.altKey) return;
    const middle = event.type === 'auxclick' && event.button === 1;
    const modified = event.ctrlKey || event.metaKey;
    if (!middle && (event.type !== 'click' || event.button !== 0)) return;
    if (event.shiftKey && !middle && !modified) return;
    const anchor = event.composedPath().find(value => value.localName === 'a' && value.hasAttribute('href'));
    if (!anchor || anchor.hasAttribute('download')) return;
    const target = (anchor.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '').toLowerCase();
    if (!middle && !modified && target !== '_blank') return;
    let url;
    try { url = new URL(anchor.href); } catch { return; }
    if (!['http:', 'https:'].includes(url.protocol)) return;
    let response;
    try {
      response = chrome.runtime.sendMessage({ type: 'page-link', url: url.href, active: event.shiftKey || (!middle && !modified) });
    } catch { enabled = false; return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    void response.then(reply => { if (!['focused', 'opened'].includes(reply?.result)) failed(); }).catch(failed);
  }
  window.addEventListener('click', open, true);
  window.addEventListener('auxclick', open, true);
})();
