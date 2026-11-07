(() => {
  let interaction = false;
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type === 'document-context') respond({ url: location.href, referrer: document.referrer, interacted: interaction });
  });
  function interacted(event) {
    if (!event.isTrusted) return;
    interaction = true;
    window.removeEventListener('pointerdown', interacted, true);
    window.removeEventListener('keydown', interacted, true);
    chrome.runtime.sendMessage({ type: 'interaction' }).catch(() => {});
  }
  window.addEventListener('pointerdown', interacted, { capture: true, passive: true });
  window.addEventListener('keydown', interacted, { capture: true, passive: true });
})();
