(() => {
  let previous;
  function report() {
    if (!document.head) return;
    const message = {
      type: 'canonical', url: location.href,
      hrefs: [...document.head.querySelectorAll('link[rel~="canonical" i]')].slice(0, 2).map(link => link.href),
    };
    const key = JSON.stringify(message);
    if (key === previous) return;
    previous = key;
    chrome.runtime.sendMessage(message).catch(() => {});
  }
  function observe() {
    if (!document.head) return;
    new MutationObserver(report).observe(document.head, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'rel'],
    });
    report();
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'read-canonical') report();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe, { once: true });
  else observe();
})();
