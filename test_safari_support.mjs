export function safariTransport({ automatic = true } = {}) {
  const callbacks = { message: [], disconnect: [] }, sockets = [], sent = [], early = [];
  let disconnected = 0, nativeCalls = 0;
  const descriptor = { type: 'connect', endpoint: 'ws://127.0.0.1:32123/', token: Buffer.alloc(32, 7).toString('base64') };
  function wake(value = descriptor) { for (const fn of callbacks.message) fn({ name: 'link-reuse', userInfo: value }); }
  class Socket {
    constructor(url, protocol) {
      this.url = url; this.protocol = protocol; this.readyState = 0; sockets.push(this);
      queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); } });
    }
    send(text) {
      if (this.readyState !== 1) throw new Error('Closed socket');
      const message = JSON.parse(text); sent.push(message);
      if (message.type === 'hello') queueMicrotask(() => {
        this.emit({ type: 'ready', extensionVersion: '3.2.4' });
        for (const frame of early.splice(0)) this.emit(frame);
      });
    }
    emit(message) { this.onmessage?.({ data: JSON.stringify(message) }); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const native = {
    onMessage: { addListener: fn => callbacks.message.push(fn) },
    onDisconnect: { addListener: fn => callbacks.disconnect.push(fn) },
    disconnect() { disconnected++; for (const fn of callbacks.disconnect) fn(); },
  };
  const api = {
    windows: { async getAll() { return [{ id: 1, focused: true }]; } },
    runtime: {
      getURL: () => 'safari-web-extension://example/', getManifest: () => ({ version: '3.2.4' }),
      connectNative() { if (automatic) queueMicrotask(() => wake()); return native; },
      async sendNativeMessage() { nativeCalls++; return { type: 'ready', extensionVersion: '3.2.4' }; },
    },
  };
  return { api, Socket, sockets, sent, wake, descriptor, closeBootstrap() { for (const fn of callbacks.disconnect) fn(); }, get disconnected() { return disconnected; }, get nativeCalls() { return nativeCalls; },
    emit(message) { const current = sockets.at(-1); if (current?.readyState === 1) current.emit(message); else early.push(message); },
    emitRaw(message) { for (const fn of callbacks.message) fn(message); } };
}
