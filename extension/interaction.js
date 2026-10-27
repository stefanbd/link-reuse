(() => {
  function interacted(event) {
    if (!event.isTrusted) return;
    window.removeEventListener('pointerdown', interacted, true);
    window.removeEventListener('keydown', interacted, true);
    chrome.runtime.sendMessage({ type: 'interaction' }).catch(() => {});
  }
  window.addEventListener('pointerdown', interacted, { capture: true, passive: true });
  window.addEventListener('keydown', interacted, { capture: true, passive: true });
})();
