import { LiveLearning, routeToTab } from './matching.mjs';

export class WindowsBridge {
  constructor(policy, { connectPort, queryTabs, resetLearning, badge, browserAPI = globalThis.chrome, extensionVersion, reload,
    learningState, saveLearning = async () => {} }) {
    Object.assign(this, { policy, connectPort, queryTabs, resetLearning, badge, browserAPI, extensionVersion, reload, saveLearning });
    this.learning = new LiveLearning(policy);
    this.learning.restore(learningState);
    this.saving = Promise.resolve();
    this.windowFocusOrder = new Map();
    this.lastError = '';
    this.serial = Promise.resolve();
    this.pending = 0;
    this.revision = 0;
    this.reconnectAttempts = 0;
    this.changed();
  }
  observe(records) { this.learning.observe(records); this.changed(); }
  changed() {
    this.revision++;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const revision = this.revision;
      void this.queryTabs().then(async tabs => {
        if (revision !== this.revision) return;
        this.learning.prune(tabs);
        await this.persist();
      }).catch(() => {});
      void this.connect().catch(() => {});
    }, 50);
  }
  connect(force = false) {
    if (this.port) return this.ready;
    if (!force && Date.now() < (this.retryAt || 0)) return Promise.reject(new Error(this.lastError));
    clearTimeout(this.reconnectTimer);
    const port = this.connectPort();
    this.port = port;
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => port.disconnect(), 5000);
      port.onMessage.addListener(message => {
        if (this.port !== port) return;
        if (message.type === 'ready') {
          clearTimeout(timeout);
          if (typeof message.extensionVersion === 'string' && this.extensionVersion && message.extensionVersion !== this.extensionVersion) {
            this.lastError = 'Loading the updated extension…';
            void Promise.resolve().then(() => this.reload(message.extensionVersion)).catch(error => {
              this.lastError = error.message;
              this.badge('!');
            });
            reject(new Error(this.lastError));
            return;
          }
          this.connected = true;
          this.reconnectAttempts = 0;
          clearTimeout(this.reconnectTimer);
          this.lastError = '';
          this.badge('');
          resolve();
        }
        if (message.type === 'open' && typeof message.id === 'string') {
          if (!this.connected) { port.postMessage({ type: 'result', id: message.id, error: this.lastError || 'The extension is still connecting.' }); return; }
          if (this.pending >= 16) { port.postMessage({ type: 'result', id: message.id, error: 'Too many links are pending. Please try again.' }); return; }
          this.pending++;
          this.serial = this.serial.then(async () => {
            if (this.port !== port) return;
            try {
              const parsed = new URL(message.url);
              if (!['http:', 'https:'].includes(parsed.protocol) || new TextEncoder().encode(message.url).length > 65536) throw new Error('Invalid web link.');
              const result = await routeToTab(message.url, this.learning, this.browserAPI, this.windowFocusOrder);
              this.changed();
              port.postMessage({ type: 'result', id: message.id, ...result });
            } catch (error) {
              if (this.port === port) port.postMessage({ type: 'result', id: message.id, error: error.message });
            }
          }).catch(() => {}).finally(() => { this.pending--; });
        }
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        clearTimeout(timeout);
        this.port = undefined;
        this.connected = false;
        const delay = Math.min(5000 * 2 ** this.reconnectAttempts, 20000);
        this.retryAt = Date.now() + delay;
        this.lastError = this.reconnectAttempts < 4 ? 'Windows helper disconnected. Reconnecting automatically…' :
          'Could not reconnect to the Windows helper. Run link-reuse --install, then open this popup again.';
        this.badge('!');
        reject(new Error(this.lastError));
        if (this.reconnectAttempts < 4) {
          this.reconnectAttempts++;
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect(true).catch(() => {});
          }, delay);
        }
      });
      port.postMessage({ type: 'hello' });
    });
    return this.ready;
  }
  persist() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      const revision = this.learning.revision;
      if (revision === this.savedRevision) return;
      await this.saveLearning(this.learning.snapshot());
      this.savedRevision = revision;
    }).then(() => {
      this.storageError = '';
    }, error => {
      this.storageError = 'Could not keep learned links for this browser session: ' + error.message;
      throw error;
    });
    return this.saving;
  }
  async clear() {
    this.revision++;
    this.learning.clear();
    this.resetLearning();
    await this.persist();
    return this.status();
  }
  focused(windowId, focusedAt) {
    if (focusedAt > (this.windowFocusOrder.get(windowId) ?? -Infinity)) this.windowFocusOrder.set(windowId, focusedAt);
    if (this.connected) this.port.postMessage({ type: 'activity' });
  }
  forgetWindow(windowId) { this.windowFocusOrder.delete(windowId); }
  async status() {
    try { await this.connect(true); } catch (error) { this.lastError = error.message; }
    const tabs = await this.queryTabs();
    this.learning.prune(tabs);
    await this.persist().catch(() => {});
    return { connected: !!this.connected, lastError: this.lastError || this.storageError, pending: this.pending, maxBytes: this.policy.maxCacheBytes,
      stats: { records: this.learning.records.size, bytes: this.learning.bytes } };
  }
}
