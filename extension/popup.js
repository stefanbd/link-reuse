const statusText = document.querySelector('#status');
const storageText = document.querySelector('#storage');
const clear = document.querySelector('#clear');

function describe(status) {
  if (!status.connected || status.lastError) return status.lastError || 'Native connection unavailable.';
  if (status.transportConnected === false) return 'Tab reuse is ready. The external helper connects on demand.';
  return 'Tab reuse learning is connected.';
}

function show(status) {
  statusText.textContent = describe(status);
  const { stats } = status;
  storageText.textContent = stats
    ? `${stats.records} learned links · ${(stats.bytes / 1024).toFixed(1)} KiB / ${status.maxBytes / 1048576} MiB`
    : '';
  clear.disabled = !status.connected;
}

chrome.runtime.sendMessage({ type: 'status' }).then(show).catch(error => { statusText.textContent = error.message; });

clear.addEventListener('click', async () => {
  clear.disabled = true;
  try {
    const status = await chrome.runtime.sendMessage({ type: 'clear-learning' });
    show(status);
    if (status.connected && !status.lastError) {
      statusText.textContent = 'Learned links cleared. New browsing can teach new links.';
    }
  } catch (error) { statusText.textContent = error.message; }
});
