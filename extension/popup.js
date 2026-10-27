const statusText = document.querySelector('#status');
const storageText = document.querySelector('#storage');
const clear = document.querySelector('#clear');

function show(status) {
  statusText.textContent = status.connected && !status.lastError ? 'Tab reuse learning is connected.' : status.lastError || 'Recorder unavailable.';
  storageText.textContent = status.stats ? `${status.stats.records} learned links · ${(status.stats.bytes / 1024).toFixed(1)} KiB / ${status.maxBytes / 1048576} MiB` : '';
  clear.disabled = !status.connected;
}

chrome.runtime.sendMessage({ type: 'status' }).then(show).catch(error => { statusText.textContent = error.message; });
clear.addEventListener('click', async () => {
  clear.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({ type: 'clear-learning' });
    show(status);
    if (status.connected && !status.lastError) statusText.textContent = 'Learned links cleared. New browsing can teach new links.';
  } catch (error) { statusText.textContent = error.message; }
});
