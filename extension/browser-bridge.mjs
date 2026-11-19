import { LiveLearning, routeToTab } from './matching.mjs';
import { reuseIndex, pageKeys, listChanged, pageRules } from './page-keys.mjs';
import { focusedHere } from './native-port.mjs';

const maxPending = 16;
const connectionEnded = 'The connection to Link Reuse ended before the tab operation.';

/**
 * The extension's background: it routes links from the native app and from pages, keeps learning current, and gives
 * each page that is showing the keys it needs to decide plain link clicks.
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
    this.pagesKnown = false;
    this.lastError = '';
    this.serial = Promise.resolve();
    this.pending = 0;
    this.revision = 0;
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
   * Sends each page that is showing its list of other tabs' keys when that list changes, so it can decide a plain link
   * click at the click. A hidden page is left asleep: it asks when it is shown.
   */
  publish(tabs) {
    const previous = this.pageIndex;
    const index = this.pageIndex = reuseIndex(tabs, this.learning);
    // A started background doesn't know what open pages hold, so its first pass sends each showing one its list.
    const known = this.pagesKnown;
    this.pagesKnown = true;
    for (const tab of tabs) {
      const showing = tab.active && !tab.discarded && !tab.frozen;
      if (showing && (!known || listChanged(previous, index, tab))) this.sendKeys(tab);
    }
  }

  /** A page asking for its list: when it loads or is shown again. */
  async requestKeys(tab) {
    if (!this.pageIndex) {
      const tabs = await this.queryTabs();
      this.pageIndex ??= reuseIndex(tabs, this.learning);
    }
    this.sendKeys(tab);
  }

  /** Every list reaches a page by this one channel, in order. A page that can't be reached asks when it is shown. */
  sendKeys(tab) {
    const keys = pageKeys(this.pageIndex, tab);
    if (!keys) return;
    const message = { type: 'page-keys', keys, rules: pageRules(this.policy) };
    void Promise.resolve()
      .then(() => this.browserAPI.tabs.sendMessage(tab.id, message, { frameId: 0 }))
      .catch(() => {});
  }

  /** The user acts: connects the native app if it isn't connected. */
  activity() {
    void this.connect().catch(() => {});
  }

  /**
   * Connects to the native app (once at a time). The greeting states this extension's version and whether this profile
   * has focus; an app that bundles another version answers with it, and the extension loads that one.
   */
  connect() {
    if (this.port) return this.ready;
    const port = this.connectPort();
    this.port = port;
    let replaced = false;
    this.ready = new Promise((resolve, reject) => {
      port.onMessage.addListener(message => {
        if (this.port !== port) return;
        if (message.type === 'replaced') replaced = true;
        if (message.type === 'create-authorized') this.answerGrant(port, message);
        if (message.type === 'ready') {
          if (message.extensionVersion !== this.extensionVersion) {
            // Leave this connection, so its end changes nothing, and load the version the app bundles.
            this.port = undefined;
            this.lastError = 'Loading the updated extension…';
            port.disconnect('version');
            void Promise.resolve().then(() => this.reload(message.extensionVersion)).catch(error => {
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
        if (this.grant?.port === port) {
          this.grant.reject(new Error(connectionEnded));
          this.grant = undefined;
        }
        if (this.port !== port) return;
        this.port = undefined;
        this.connected = false;
        this.lastError = 'The browser helper is not connected' + (port.error ? ` (${port.error})` : '') + '. ' +
          (this.platform === 'mac'
            ? 'Run the installed Link Reuse app with --install, then open this popup again.'
            : 'Run link-reuse --install, then open this popup again.');
        this.badge('!');
        reject(new Error(this.lastError));
        // An update stopped the helper and it said so: connect to the new one at once. A helper that ends by itself
        // waits for the user's next action, so one that keeps failing can't spin.
        if (replaced) void this.connect().catch(() => {});
      });
    });
    // The greeting is the first message; focus changes before it is out follow it.
    this.greeted = focusedHere(this.browserAPI).catch(() => false).then(focused => {
      if (this.port === port) port.postMessage({ type: 'hello', extensionVersion: this.extensionVersion, focused });
    }).catch(() => {});
    return this.ready;
  }

  /**
   * Asks the app for its one-time go-ahead before an app link changes anything, so a link it may hand to another
   * profile is never acted on twice. Links run one at a time, so one grant is outstanding at most; the connection
   * ending refuses it.
   */
  authorize(port, id) {
    if (this.port !== port || !this.connected) return Promise.reject(new Error(connectionEnded));
    return new Promise((resolve, reject) => {
      port.postMessage({ type: 'authorize-create', id });
      this.grant = { port, id, resolve, reject };
    });
  }

  answerGrant(port, message) {
    const grant = this.grant;
    if (grant?.port !== port || grant.id !== message.id) return;
    this.grant = undefined;
    if (message.error) grant.reject(new Error(message.error));
    else grant.resolve();
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
    void this.open(message.url, { beforeAct: () => this.authorize(port, message.id) }, port)
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
      const learned = this.learning.revision;
      try {
        return await routeToTab(url, this.learning, this.browserAPI, this.windowFocusOrder, opening);
      } finally {
        // A tab opened here is remembered for a sign-in round trip; that change is saved. Selecting a tab changes
        // nothing the tab events don't already report.
        if (this.learning.revision !== learned) this.changed();
      }
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
    const port = this.port;
    void this.greeted.then(() => { if (this.port === port) port.postMessage({ type: 'activity' }); }).catch(() => {});
  }

  forgetWindow(windowId) {
    this.windowFocusOrder.delete(windowId);
  }

  /** A URL-free page-link event for the native log; only Safari's authenticated channel carries it. */
  trace(event, tabId) {
    if (!this.port?.transportConnected) return;
    this.port.postMessage({ type: 'trace', result: event, id: String(Number.isInteger(tabId) ? tabId : 0) });
  }

  /** What the popup shows. It never waits for the app, which may not answer until it starts. */
  status() {
    this.activity();
    return {
      connected: !!this.connected,
      connecting: !!this.port && !this.connected,
      lastError: this.lastError,
      storageError: this.storageError,
      pending: this.pending,
      maxBytes: this.policy.maxCacheBytes,
      stats: { records: this.learning.records.size, bytes: this.learning.bytes },
    };
  }
}
