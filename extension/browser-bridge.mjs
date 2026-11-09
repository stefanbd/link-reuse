import { LiveLearning, routeToTab } from './matching.mjs';

export class BrowserBridge {
  constructor(policy, { connectPort, queryTabs, resetLearning, badge, browserAPI = globalThis.chrome, extensionVersion, reload,
    learningState, saveLearning = async () => {}, platform = 'win' }) {
    Object.assign(this, { policy, connectPort, queryTabs, resetLearning, badge, browserAPI, extensionVersion, reload, saveLearning, platform });
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
    if (this.timer || this.maintaining) return;
    this.timer = setTimeout(() => void this.maintain(), 50);
  }
  /** One pass at a time: a slow browser must not pile up tab queries. Changes during a pass get one catch-up pass. */
  async maintain() {
    this.timer = undefined;
    this.maintaining = true;
    void this.connect().catch(() => {});
    const revision = this.revision;
    try {
      // Nothing learned and nothing unsaved: there is nothing to check against open tabs.
      if (!this.learning.records.size && this.learning.revision === this.savedRevision) return;
      const tabs = await this.queryTabs();
      if (revision === this.revision) {
        this.learning.prune(tabs);
        await this.persist();
      }
    } catch {} finally {
      this.maintaining = false;
    }
    if (revision !== this.revision && !this.timer) this.timer = setTimeout(() => void this.maintain(), 50);
  }
  /** User activity: reconnect if the helper connection is down, without a maintenance pass. */
  activity() { void this.connect().catch(() => {}); }
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
          if (port.transportConnected !== false) this.reconnectAttempts = 0;
          clearTimeout(this.reconnectTimer);
          this.lastError = '';
          this.badge('');
          resolve();
        }
        if (message.type === 'open' && typeof message.id === 'string') {
          this.reconnectAttempts = 0;
          if (!this.connected) { port.postMessage({ type: 'result', id: message.id, error: this.lastError || 'The extension is still connecting.' }); return; }
          void this.open(message.url, { deadline: message.deadline,
            beforeCreate: port.authorizeCreation ? () => port.authorizeCreation(message.id, message.deadline) : undefined }, port).then(result => {
            if (this.port === port) port.postMessage({ type: 'result', id: message.id, ...result });
          }, error => {
            if (this.port === port) port.postMessage({ type: 'result', id: message.id, error: error.message });
          });
        }
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        clearTimeout(timeout);
        this.port = undefined;
        this.connected = false;
        const attempt = this.reconnectAttempts - (port.authorizeCreation ? 1 : 0);
        const delay = attempt < 0 ? 0 : Math.min(5000 * 2 ** attempt, 20000);
        this.retryAt = Date.now() + delay;
        this.lastError = this.reconnectAttempts < 4 ? 'Browser helper disconnected. Reconnecting automatically…' :
          'Could not reconnect to the browser helper. ' + (this.platform === 'mac' ?
            'Run the installed Link Reuse app with --install, then open this popup again.' :
            'Run link-reuse --install, then open this popup again.');
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
  open(url, opening = {}, port) {
    if (this.pending >= 16) return Promise.reject(new Error('Too many links are pending. Please try again.'));
    this.pending++;
    const result = this.serial.then(async () => {
      if (port && this.port !== port) throw new Error('The browser connection ended.');
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || new TextEncoder().encode(url).length > 65536) throw new Error('Invalid web link.');
      const result = await routeToTab(url, this.learning, this.browserAPI, this.windowFocusOrder, opening);
      this.changed();
      return result;
    });
    this.serial = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
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
      this.storageError = 'Could not save learned links for open tabs: ' + error.message;
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
  /** URL-free page-link event, tagged with a tab ID, for the native log; only Safari's authenticated channel carries it. */
  trace(event, tabId) {
    if (this.port?.transportConnected) this.port.postMessage({ type: 'trace', result: event, id: String(Number.isInteger(tabId) ? tabId : 0) });
  }
  async status() {
    try { await this.connect(true); } catch (error) { this.lastError = error.message; }
    const tabs = await this.queryTabs();
    this.learning.prune(tabs);
    await this.persist().catch(() => {});
    return { connected: !!this.connected, transportConnected: this.port?.transportConnected ?? !!this.connected,
      lastError: this.lastError || this.storageError, pending: this.pending, maxBytes: this.policy.maxCacheBytes,
      stats: { records: this.learning.records.size, bytes: this.learning.bytes } };
  }
}
