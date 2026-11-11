import { LiveLearning, routeToTab } from './matching.mjs';
import { reuseIndex, pageKeys, changedKeys, pageChanges, pageRules } from './page-keys.mjs';

const maxPending = 16;

/**
 * The extension's background: it routes links from the native app and from pages, keeps learning current, and gives
 * each page the keys it needs to decide plain link clicks.
 */
export class BrowserBridge {
  constructor(policy, {
    connectPort, queryTabs, resetLearning, badge, browserAPI = globalThis.chrome, extensionVersion, reload,
    learningState, saveLearning = async () => {}, platform = 'win',
  }) {
    Object.assign(this, {
      policy, connectPort, queryTabs, resetLearning, badge, browserAPI,
      extensionVersion, reload, saveLearning, platform,
    });
    this.learning = new LiveLearning(policy);
    this.learning.restore(learningState);
    this.saving = Promise.resolve();
    this.windowFocusOrder = new Map();
    this.sentKeys = new Map(); // the version of the list each page holds
    this.keysVersion = 0;
    this.pagesKnown = false;
    this.lastError = '';
    this.serial = Promise.resolve();
    this.pending = 0;
    this.revision = 0;
    this.reconnected = false; // a lost connection was reconnected since the user last acted
    this.changed();
    void this.connect().catch(() => {});
  }

  observe(records) {
    this.learning.observe(records);
    this.changed();
  }

  /** Starts a maintenance pass for a change in tabs or learning, or one more after the pass in progress. */
  changed() {
    this.revision++;
    if (this.maintaining) return;
    this.maintaining = true;
    // After the current task, so changes made together share one pass.
    queueMicrotask(() => void this.maintain());
  }

  /** One pass at a time, so a slow browser can't pile up tab queries. */
  async maintain() {
    let revision;
    while (revision !== this.revision) {
      revision = this.revision;
      const learned = this.learning.revision;
      try {
        const tabs = await this.queryTabs();
        // A tab list from before a change in tabs or learning could prune what was just learned: query again.
        if (revision !== this.revision || learned !== this.learning.revision) {
          revision = undefined;
          continue;
        }
        this.learning.prune(tabs);
        this.publish(tabs);
        await this.persist();
      } catch {}
    }
    this.maintaining = false;
  }

  /**
   * Keeps each page's list of other tabs' keys current, so it can decide a plain link click at the click. A page gets
   * its full list when it asks; after that only what changed, and only when something did.
   */
  publish(tabs) {
    const previous = this.pageIndex;
    const index = this.pageIndex = reuseIndex(tabs, this.learning);
    const live = new Set(tabs.map(tab => tab.id));
    for (const id of this.sentKeys.keys()) if (!live.has(id)) this.sentKeys.delete(id);
    // A started background doesn't know what open pages hold, so its first pass sends each one its full list.
    const changed = this.pagesKnown ? changedKeys(previous, index) : null;
    this.pagesKnown = true;
    if (changed?.length === 0) return;
    this.keysVersion++;
    for (const tab of tabs) {
      if (tab.discarded) continue;
      const base = this.sentKeys.get(tab.id);
      if (!changed) this.sendKeys(tab);
      else if (base !== undefined) {
        const { added, removed } = pageChanges(changed, previous, index, tab);
        if (added.length || removed.length) {
          this.deliver(tab.id, { type: 'page-keys', base, version: this.keysVersion, added, removed });
        }
      }
    }
  }

  /** A page asking for its full list: when it loads, or when it missed a change. */
  async requestKeys(tab) {
    if (!this.pageIndex) {
      const tabs = await this.queryTabs();
      this.pageIndex ??= reuseIndex(tabs, this.learning);
    }
    this.sendKeys(tab);
  }

  sendKeys(tab) {
    const keys = pageKeys(this.pageIndex, tab);
    if (keys) {
      this.deliver(tab.id, { type: 'page-keys', version: this.keysVersion, keys, rules: pageRules(this.policy) });
    }
  }

  /** Every list reaches a page by this one channel, in order. A page that can't be reached asks when it loads. */
  deliver(tabId, message) {
    this.sentKeys.set(tabId, message.version);
    void Promise.resolve()
      .then(() => this.browserAPI.tabs.sendMessage(tabId, message, { frameId: 0 }))
      .catch(() => { if (this.sentKeys.get(tabId) === message.version) this.sentKeys.delete(tabId); });
  }

  /** The user acts: connects the native app if it isn't connected, and lets a lost connection reconnect at once. */
  activity() {
    this.reconnected = false;
    void this.connect().catch(() => {});
  }

  /** Connects to the native app (once at a time), reloading the extension if the app brings a newer one. */
  connect() {
    if (this.port) return this.ready;
    const port = this.connectPort();
    this.port = port;
    this.ready = new Promise((resolve, reject) => {
      port.onMessage.addListener(message => {
        if (this.port !== port) return;
        if (message.type === 'ready') {
          const version = message.extensionVersion;
          if (typeof version === 'string' && this.extensionVersion && version !== this.extensionVersion) {
            this.lastError = 'Loading the updated extension…';
            void Promise.resolve().then(() => this.reload(version)).catch(error => {
              this.lastError = error.message;
              this.badge('!');
            });
            reject(new Error(this.lastError));
            return;
          }
          this.connected = true;
          this.lastError = '';
          this.badge('');
          resolve();
        }
        if (message.type === 'open' && typeof message.id === 'string') this.serveOpen(port, message);
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        const lost = this.connected;
        this.port = undefined;
        this.connected = false;
        this.lastError = 'The browser helper is not connected. ' + (this.platform === 'mac'
          ? 'Run the installed Link Reuse app with --install, then open this popup again.'
          : 'Run link-reuse --install, then open this popup again.');
        this.badge('!');
        reject(new Error(this.lastError));
        // A working connection ends when an update replaces the helper: connect again at once. Only once until the
        // user acts, so a helper that keeps failing can't spin; a helper that never connected waits for them too.
        if (lost && !this.reconnected) {
          this.reconnected = true;
          void this.connect().catch(() => {});
        }
      });
      port.postMessage({ type: 'hello' });
    });
    return this.ready;
  }

  /** A link from the native app; the reply goes back over the same connection. */
  serveOpen(port, message) {
    const reply = result => {
      if (this.port === port) port.postMessage({ type: 'result', id: message.id, ...result });
    };
    if (!this.connected) {
      reply({ error: this.lastError || 'The extension is still connecting.' });
      return;
    }
    const beforeCreate = port.authorizeCreation && (() => port.authorizeCreation(message.id, message.deadline));
    void this.open(message.url, { deadline: message.deadline, beforeCreate }, port)
      .then(reply, error => reply({ error: error.message }));
  }

  /** Routes one link. Links from the app and from pages share one queue, so two can never open the same tab twice. */
  open(url, opening = {}, port) {
    if (this.pending >= maxPending) return Promise.reject(new Error('Too many links are pending. Please try again.'));
    this.pending++;
    const result = this.serial.then(async () => {
      if (port && this.port !== port) throw new Error('The browser connection ended.');
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || new TextEncoder().encode(url).length > 65536) {
        throw new Error('Invalid web link.');
      }
      const routed = await routeToTab(url, this.learning, this.browserAPI, this.windowFocusOrder, opening);
      this.changed();
      return routed;
    });
    this.serial = result.catch(() => {}).finally(() => { this.pending--; });
    return result;
  }

  /** Saves learning when it changed; writes are queued so they never overlap. */
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
    this.activity();
    if (this.connected) this.port.postMessage({ type: 'activity' });
  }

  forgetWindow(windowId) {
    this.windowFocusOrder.delete(windowId);
  }

  /** A URL-free page-link event for the native log; only Safari's authenticated channel carries it. */
  trace(event, tabId) {
    if (!this.port?.transportConnected) return;
    this.port.postMessage({ type: 'trace', result: event, id: String(Number.isInteger(tabId) ? tabId : 0) });
  }

  async status() {
    this.activity();
    await this.ready.catch(() => {});
    this.learning.prune(await this.queryTabs());
    await this.persist().catch(() => {});
    return {
      connected: !!this.connected,
      transportConnected: this.port?.transportConnected ?? !!this.connected,
      lastError: this.lastError || this.storageError,
      pending: this.pending,
      maxBytes: this.policy.maxCacheBytes,
      stats: { records: this.learning.records.size, bytes: this.learning.bytes },
    };
  }
}
