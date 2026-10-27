import { allowsLearning, PendingObservations } from './learning.mjs';

export class NativeBridge {
  constructor(policy, { connectPort, queryTabs, resetLearning, badge }) {
    Object.assign(this, { policy, connectPort, queryTabs, resetLearning, badge });
    this.queue = new PendingObservations(policy);
    this.controls = new Map();
    this.settledURLs = new Map();
    this.sequence = 0;
    this.revision = 0;
    this.retryAt = 0;
    this.dirty = true;
    this.lastError = '';
    this.changed();
  }
  observe(records) {
    if (!this.clearing) for (const record of records) this.queue.add(record);
    this.changed();
  }
  changed() { this.revision++; this.dirty = true; this.kick(); }
  kick() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 50);
  }
  connect(force = false) {
    if (this.port) return this.connectionReady;
    if (!force && Date.now() < this.retryAt) return Promise.reject(new Error('Recorder reconnect is cooling down.'));
    const port = this.connectPort();
    this.port = port;
    this.connected = false;
    this.connectionReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => port.disconnect(), 5000);
      port.onMessage.addListener(message => {
        if (this.port !== port || typeof message.generation !== 'string') return;
        clearTimeout(timeout);
        if (this.generation && this.generation !== message.generation) {
          this.queue.clear();
          this.resetLearning();
          clearTimeout(this.flight?.timeout);
          this.flight = undefined;
        }
        this.generation = message.generation;
        this.stats = message;
        this.connected = true;
        this.lastError = '';
        this.badge('');
        resolve();
        if (this.flight && this.flight.id === message.ack) {
          clearTimeout(this.flight.timeout);
          this.queue.acknowledge(this.flight.items);
          this.flight = undefined;
        }
        const control = this.controls.get(message.ack);
        if (control) { clearTimeout(control.timeout); this.controls.delete(message.ack); control.resolve(message); }
        if (this.dirty || this.queue.items.size) this.kick();
      });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        clearTimeout(timeout);
        clearTimeout(this.flight?.timeout);
        this.flight = undefined;
        this.port = undefined;
        this.connected = false;
        this.retryAt = Date.now() + 5000;
        this.lastError = 'The local recorder disconnected. Open this popup or navigate again to reconnect.';
        this.badge('!');
        reject(new Error(this.lastError));
        for (const control of this.controls.values()) { clearTimeout(control.timeout); control.reject(new Error(this.lastError)); }
        this.controls.clear();
      });
      port.postMessage({ type: 'hello' });
    });
    return this.connectionReady;
  }
  async flush() {
    if (this.flight || this.querying || this.clearing || (!this.dirty && !this.queue.items.size)) return;
    this.querying = true;
    try {
      await this.connect();
      const revision = this.revision;
      const tabs = await this.queryTabs();
      if (revision !== this.revision || this.clearing || !this.connected) return;
      let bytes = 2;
      const liveURLs = [];
      const existingTabs = new Set(tabs.map(tab => tab.id));
      for (const id of this.settledURLs.keys()) if (!existingTabs.has(id)) this.settledURLs.delete(id);
      for (const tab of tabs) {
        if (tab.incognito) continue;
        const previous = this.settledURLs.get(tab.id);
        if (tab.status === 'complete') this.settledURLs.set(tab.id, tab.url);
        const candidates = tab.status === 'loading' && previous ? [tab.url, previous] : [tab.url];
        for (const url of candidates) {
          if (!allowsLearning(url, this.policy)) continue;
          const size = new TextEncoder().encode(JSON.stringify(url)).length + 1;
          if (bytes + size > this.policy.maxSnapshotBytes) break;
          bytes += size;
          liveURLs.push(url);
        }
      }
      const items = this.queue.batch();
      const id = ++this.sequence;
      const port = this.port;
      this.flight = { id, items, timeout: setTimeout(() => port.disconnect(), 5000) };
      this.dirty = false;
      port.postMessage({ type: 'snapshot', id, generation: this.generation, liveURLs, records: items.map(item => item.record) });
    } catch (error) {
      this.lastError = error.message;
      if (this.port) this.port.disconnect();
    }
    finally {
      this.querying = false;
      if (this.connected && !this.flight && this.dirty && !this.clearing) this.kick();
    }
  }
  async request(type) {
    await this.connect(true);
    if (this.controls.size >= 4) throw new Error('Another recorder request is still pending.');
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const port = this.port;
      const timeout = setTimeout(() => port.disconnect(), 5000);
      this.controls.set(id, { resolve, reject, timeout });
      port.postMessage({ type, id });
    });
  }
  async clear() {
    this.clearing = true;
    this.revision++;
    this.queue.clear();
    this.settledURLs.clear();
    this.resetLearning();
    try { return await this.request('clear'); }
    finally { this.clearing = false; this.changed(); }
  }
  async status() {
    try { await this.request('status'); } catch (error) { this.lastError = error.message; }
    return { connected: this.connected, lastError: this.lastError, stats: this.stats,
      pending: this.queue.items.size, dropped: this.queue.dropped, maxBytes: this.policy.maxCacheBytes };
  }
}
