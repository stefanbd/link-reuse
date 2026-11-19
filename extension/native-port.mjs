// The connection to the native app, behind one port-like interface.
// Chromium: native messaging. Safari: native messaging only to learn the address and token of the app's local
// WebSocket, then every message over that authenticated socket. A Safari port is exactly one socket: when the socket
// ends, or the app announces a different one, the port ends and everything it carried ends with it.

const chromiumHost = 'me.dichev.link_reuse';
const safariApp = 'me.dichev.LinkReuse';

export const isSafari = api => api.runtime.getURL('').startsWith('safari-web-extension:');

/** Whether a normal, non-private window of this profile has focus: what makes it the profile external links go to. */
export async function focusedHere(api) {
  const windows = await api.windows.getAll({ windowTypes: ['normal'] });
  return windows.some(window => window.focused && !window.incognito);
}

/**
 * Returns a function that connects. Safari's first connection starts at once, so it is ready for the first link, and a
 * connection that ends because the app moved hands the new address to the next one.
 */
export function prepareNative(api, Socket = globalThis.WebSocket) {
  if (!isSafari(api)) {
    return () => {
      const port = api.runtime.connectNative(chromiumHost);
      // Why the helper couldn't start or ended, for the popup.
      port.onDisconnect.addListener(() => { port.error = api.runtime.lastError?.message; });
      return port;
    };
  }
  const handover = {};
  let prepared = connectSafari(api, Socket, handover);
  return () => {
    if (prepared.closed) prepared = connectSafari(api, Socket, handover);
    return prepared;
  };
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

function connectSafari(api, Socket, handover) {
  const incoming = api.runtime.connectNative(safariApp);
  const messages = new Set();
  const disconnects = new Set();
  let descriptor;
  let socket;
  let greeting;
  let authenticated = false;
  let closed = false;
  // A focus change the app hasn't heard about yet, sent once it has accepted this connection.
  let activity = false;

  const open = () => socket?.readyState === 1;
  const send = message => socket.send(JSON.stringify(message));

  /** The socket greets once it is open and the background has greeted, so nothing arrives before it listens. */
  function greet() {
    if (closed || !greeting || !open() || socket.greeted) return;
    socket.greeted = true;
    send({ ...greeting, token: descriptor.token });
  }

  function receive(value) {
    if (value.type === 'ready') {
      authenticated = true;
      for (const listener of messages) listener(value);
      if (activity && !closed) {
        activity = false;
        send({ type: 'activity' });
      }
    } else if (authenticated && ['open', 'create-authorized', 'replaced'].includes(value.type)) {
      for (const listener of messages) listener(value);
    }
  }

  function connect(message) {
    const endpoint = validEndpoint(message);
    if (!endpoint) return;
    if (descriptor) {
      if (descriptor.endpoint === message.endpoint && descriptor.token === message.token) return;
      // A new app instance: this connection ends with the old one, and the next connects to the new one at once.
      handover.descriptor = message;
      for (const listener of messages) listener({ type: 'replaced' });
      port.disconnect('endpoint');
      return;
    }
    socket = new Socket(endpoint.href);
    descriptor = message;
    socket.onopen = greet;
    socket.onmessage = event => {
      if (closed) return;
      try {
        if (typeof event.data !== 'string' || event.data.length > 1048576) throw new Error('Invalid frame');
        receive(JSON.parse(event.data));
      } catch { port.disconnect('message', typeof event.data === 'string' ? 0 : 1); }
    };
    socket.onerror = () => port.disconnect('socket-error');
    socket.onclose = event => port.disconnect('socket-close', event.code);
  }

  const port = {
    get closed() { return closed; },
    get transportConnected() { return authenticated && open(); },
    onMessage: { addListener: listener => messages.add(listener) },
    onDisconnect: { addListener: listener => disconnects.add(listener) },

    /** Ends the connection once, reporting a URL-free reason to the app's log. */
    disconnect(reason = 'core', code = 0) {
      if (closed) return;
      closed = true;
      const report = { type: 'diagnostic', result: reason, error: String(code) };
      let diagnostic;
      try {
        if (!authenticated || !open()) throw new Error('No channel');
        send(report);
        diagnostic = Promise.resolve();
      } catch { diagnostic = api.runtime.sendNativeMessage(safariApp, report); }
      socket?.close();
      void diagnostic.catch(() => {}).finally(() => incoming.disconnect());
      for (const listener of disconnects) listener();
    },

    postMessage(message) {
      if (closed) throw new Error('The Safari connection ended.');
      if (message.type === 'hello') {
        greeting = message;
        greet();
      } else if (authenticated && open()) {
        send(message);
      } else if (message.type === 'activity') {
        activity = true;
      } else {
        port.disconnect('unavailable');
      }
    },
  };

  incoming.onDisconnect.addListener(() => {
    void api.runtime.lastError;
    if (!socket || socket.readyState >= 2) port.disconnect('bootstrap');
  });
  incoming.onMessage.addListener(message => {
    if (closed || message?.name !== 'link-reuse' || message.userInfo?.type !== 'connect') return;
    try { connect(message.userInfo); } catch {}
  });
  const known = handover.descriptor;
  handover.descriptor = undefined;
  if (known) connect(known);
  // Otherwise the extension's native handler starts the app if it isn't running, and the app sends its address.
  else void api.runtime.sendNativeMessage(safariApp, { type: 'hello' }).catch(() => {});
  return port;
}
