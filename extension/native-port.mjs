// The connection to the native app, behind one port-like interface.
// Chromium: native messaging. Safari: native messaging only to learn the address and token of the app's local
// WebSocket, then every request and reply over that authenticated socket.

const chromiumHost = 'me.dichev.link_reuse';
const safariApp = 'me.dichev.LinkReuse';
const connectionEnded = 'The Safari connection ended before the tab operation.';
const expired = 'The external request expired. Please open the link again.';

export const isSafari = api => api.runtime.getURL('').startsWith('safari-web-extension:');

/** Returns a function that connects; Safari's first connection starts right away so it is ready for the first link. */
export function prepareNative(api, Socket = globalThis.WebSocket, extensionVersion) {
  if (!isSafari(api)) return () => connectNative(api);
  extensionVersion ??= api.runtime.getManifest().version;
  let prepared = connectNative(api, Socket, extensionVersion);
  return () => {
    if (prepared.closed) prepared = connectNative(api, Socket, extensionVersion);
    return prepared;
  };
}

export function connectNative(api, Socket = globalThis.WebSocket, extensionVersion) {
  if (!isSafari(api)) {
    const port = api.runtime.connectNative(chromiumHost);
    port.onDisconnect.addListener(() => { void api.runtime.lastError; });
    return port;
  }
  extensionVersion ??= api.runtime.getManifest().version;
  const incoming = api.runtime.connectNative(safariApp);
  const messages = new Set();
  const disconnects = new Set();
  const queued = [];
  const authorizations = new Map();
  let socket;
  let authenticated = false;
  let ready = false;
  let closed = false;
  let nativeVersion = extensionVersion;

  function emit(message) {
    for (const listener of messages) listener(message);
  }

  /** Hands queued requests to the background once it is listening and the socket is authenticated. */
  function flush() {
    if (closed || !ready || !authenticated || !messages.size) return;
    for (const message of queued.splice(0)) if (!message.deadline || message.deadline > Date.now()) emit(message);
  }

  /** Only a loopback WebSocket address and a 32-byte token are accepted. */
  function validEndpoint(message) {
    const endpoint = new URL(message.endpoint);
    const plain = !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
      endpoint.pathname === '/';
    const loopback = endpoint.protocol === 'ws:' && endpoint.hostname === '127.0.0.1' && endpoint.port;
    const token = typeof message.token === 'string' && atob(message.token).length === 32;
    return plain && loopback && token ? endpoint : null;
  }

  function receive(value) {
    if (value.type === 'ready') {
      if (value.extensionVersion !== extensionVersion) {
        nativeVersion = value.extensionVersion;
        if (ready) {
          emit(value);
          port.disconnect('version');
        }
        return;
      }
      authenticated = true;
      flush();
    } else if (authenticated && value.type === 'create-authorized' && typeof value.id === 'string') {
      const waiting = authorizations.get(value.id);
      authorizations.delete(value.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      if (value.error) waiting.reject(new Error(value.error));
      else waiting.resolve();
    } else if (authenticated && value.type === 'open' && typeof value.id === 'string' &&
        typeof value.url === 'string') {
      if (queued.length >= 16) {
        port.disconnect('queue');
        return;
      }
      queued.push(value);
      flush();
    }
  }

  function connect(message) {
    try {
      const endpoint = validEndpoint(message);
      if (!endpoint || (socket?.url === endpoint.href && socket.readyState < 2)) return;
      const previous = socket;
      const current = new Socket(endpoint.href);
      socket = current;
      authenticated = false;
      previous?.close();
      const live = () => !closed && socket === current;
      current.onopen = () => {
        if (!live() || current.readyState !== 1) return;
        current.send(JSON.stringify({ type: 'hello', token: message.token, extensionVersion }));
        // A focused normal window makes this the profile external links go to.
        void api.windows.getAll({ windowTypes: ['normal'] }).then(windows => {
          if (live() && current.readyState === 1 && windows.some(window => window.focused && !window.incognito)) {
            current.send(JSON.stringify({ type: 'activity' }));
          }
        }).catch(() => {});
      };
      current.onmessage = event => {
        if (!live()) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 1048576) throw new Error('Invalid frame');
          receive(JSON.parse(event.data));
        } catch { port.disconnect('message', typeof event.data === 'string' ? 0 : 1); }
      };
      current.onerror = () => {
        if (socket === current && nativeVersion === extensionVersion) port.disconnect('socket-error');
      };
      current.onclose = event => {
        if (socket === current && nativeVersion === extensionVersion) port.disconnect('socket-close', event.code);
      };
    } catch {}
  }

  const port = {
    get closed() { return closed; },
    get transportConnected() { return authenticated && socket?.readyState === 1; },
    onMessage: { addListener(listener) { messages.add(listener); flush(); } },
    onDisconnect: { addListener: listener => disconnects.add(listener) },

    /** Ends the connection once, reporting a URL-free reason to the app's log. */
    disconnect(reason = 'core', code = 0) {
      if (closed) return;
      closed = true;
      const report = { type: 'diagnostic', result: reason, error: String(code) };
      let diagnostic;
      if (authenticated && socket?.readyState === 1) {
        try {
          socket.send(JSON.stringify(report));
          diagnostic = Promise.resolve();
        } catch { diagnostic = api.runtime.sendNativeMessage(safariApp, report); }
      } else diagnostic = api.runtime.sendNativeMessage(safariApp, report);
      authenticated = false;
      queued.length = 0;
      for (const waiting of authorizations.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(connectionEnded));
      }
      authorizations.clear();
      socket?.close();
      void diagnostic.catch(() => {}).finally(() => incoming.disconnect());
      for (const listener of disconnects) listener();
    },

    /** Asks the app for one-time permission to create a tab, so an interrupted request is never replayed. */
    authorizeCreation(id, deadline) {
      if (closed || !authenticated || socket?.readyState !== 1) return Promise.reject(new Error(connectionEnded));
      if (!Number.isFinite(deadline) || deadline <= Date.now()) return Promise.reject(new Error(expired));
      if (authorizations.has(id) || authorizations.size >= 16) {
        return Promise.reject(new Error('The tab operation is already pending.'));
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          authorizations.delete(id);
          reject(new Error(expired));
        }, deadline - Date.now());
        authorizations.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ type: 'authorize-create', id }));
        } catch (error) {
          clearTimeout(timer);
          authorizations.delete(id);
          reject(error);
        }
      });
    },

    postMessage(message) {
      if (closed) throw new Error('The Safari connection ended.');
      if (message.type === 'hello') {
        ready = true;
        emit({ type: 'ready', extensionVersion: nativeVersion });
        if (nativeVersion !== extensionVersion) {
          port.disconnect('version');
          return;
        }
        flush();
      } else if (authenticated && socket?.readyState === 1) {
        socket.send(JSON.stringify(message));
      } else if (message.type !== 'activity') {
        port.disconnect('unavailable');
      }
    },
  };

  incoming.onDisconnect.addListener(() => {
    void api.runtime.lastError;
    if (!socket || socket.readyState >= 2) port.disconnect('bootstrap');
  });
  incoming.onMessage.addListener(message => {
    if (!closed && message?.name === 'link-reuse' && message.userInfo?.type === 'connect') connect(message.userInfo);
  });
  // A late bootstrap reply can't override the authenticated channel, which alone decides version compatibility.
  void api.runtime.sendNativeMessage(safariApp, { type: 'hello' }).catch(() => {});
  return port;
}
