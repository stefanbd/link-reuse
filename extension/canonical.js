// Reports the page's canonical address (rel=canonical, or og:url when there is none) whenever it changes.
(() => {
  let previous;
  let observer;

  function declared(selector, read) {
    return [...document.head.querySelectorAll(selector)].slice(0, 2).map(read);
  }

  function report() {
    if (!document.head) return;
    const canonical = declared('link[rel~="canonical" i]', link => link.href);
    const hrefs = canonical.length ? canonical : declared('meta[property="og:url" i]', meta => meta.content);
    const message = { type: 'canonical', url: location.href, referrer: document.referrer, hrefs };
    const key = JSON.stringify(message);
    if (key === previous) return;
    previous = key;
    // A script orphaned by an extension reload throws instead of sending; it stops watching then.
    try { void chrome.runtime.sendMessage(message).catch(() => {}); } catch { observer?.disconnect(); }
  }

  function observe() {
    if (!document.head) return;
    observer = new MutationObserver(report);
    observer.observe(document.head, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'rel', 'content', 'property'],
    });
    report();
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'read-canonical') report();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
  else observe();
})();
