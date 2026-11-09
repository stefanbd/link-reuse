(() => {
  let previous, observer;
  function report() {
    if (!document.head) return;
    const canonical = [...document.head.querySelectorAll('link[rel~="canonical" i]')].slice(0, 2).map(link => link.href);
    const message = {
      type: 'canonical', url: location.href, referrer: document.referrer,
      hrefs: canonical.length ? canonical : [...document.head.querySelectorAll('meta[property="og:url" i]')].slice(0, 2).map(meta => meta.content),
    };
    const key = JSON.stringify(message);
    if (key === previous) return;
    previous = key;
    // A script left behind by an extension reload cannot send (it throws instead of rejecting), so it stops watching.
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
