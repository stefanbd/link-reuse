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
    // A script left behind by an extension reload cannot send, and throws instead of rejecting.
    try { void chrome.runtime.sendMessage({ type: 'interaction' }).catch(() => {}); } catch {}
  }
  window.addEventListener('pointerdown', interacted, { capture: true, passive: true });
  window.addEventListener('keydown', interacted, { capture: true, passive: true });
})();
