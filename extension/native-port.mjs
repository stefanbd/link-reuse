export function prepareNative(api, Socket = globalThis.WebSocket) {
  if (!api.runtime.getURL('').startsWith('safari-web-extension:')) return () => connectNative(api);
  let prepared = connectNative(api, Socket);
  return () => {
    if (prepared.closed) prepared = connectNative(api, Socket);
    return prepared;
  };
}

export function connectNative(api, Socket = globalThis.WebSocket) {
  if (!api.runtime.getURL('').startsWith('safari-web-extension:')) {
    const port = api.runtime.connectNative('me.dichev.link_reuse');
    port.onDisconnect.addListener(() => { void api.runtime.lastError; });
    return port;
  }
  const incoming = api.runtime.connectNative('me.dichev.LinkReuse');
  const messages = new Set(), disconnects = new Set(), queued = [];
  let socket, authenticated = false, ready = false, closed = false;
  function emit(message) { for (const listener of messages) listener(message); }
  function flush() {
    if (closed || !ready || !authenticated || !messages.size) return;
    for (const message of queued.splice(0)) if (!message.deadline || message.deadline > Date.now()) emit(message);
  }
  function connect(message) {
    try {
      const endpoint = new URL(message.endpoint);
      if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
          endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
          typeof message.token !== 'string' || atob(message.token).length !== 32) return;
      if (socket?.url === endpoint.href && socket.readyState < 2) return;
      const previous = socket;
      const current = new Socket(endpoint.href, 'link-reuse');
      socket = current;
      authenticated = false;
      previous?.close();
      current.onopen = () => {
        if (closed || socket !== current || current.readyState !== 1) return;
        current.send(JSON.stringify({ type: 'hello', token: message.token }));
        void api.windows.getAll({ windowTypes: ['normal'] }).then(windows => {
          if (!closed && socket === current && current.readyState === 1 && windows.some(window => window.focused && !window.incognito)) {
            current.send(JSON.stringify({ type: 'activity' }));
          }
        }).catch(() => {});
      };
      current.onmessage = event => {
        if (closed || socket !== current) return;
        try {
          if (typeof event.data !== 'string' || event.data.length > 1048576) throw new Error('Invalid frame');
          const value = JSON.parse(event.data);
          if (value.type === 'ready') {
            if (value.extensionVersion !== api.runtime.getManifest().version) { emit(value); port.disconnect(); return; }
            authenticated = true;
            flush();
          } else if (authenticated && value.type === 'open' && typeof value.id === 'string' && typeof value.url === 'string') {
            if (queued.length >= 16) { port.disconnect(); return; }
            queued.push(value);
            flush();
          }
        } catch { port.disconnect(); }
      };
      current.onerror = current.onclose = () => { if (socket === current) port.disconnect(); };
    } catch {}
  }
  const port = {
    get closed() { return closed; },
    get transportConnected() { return authenticated && socket?.readyState === 1; },
    onMessage: { addListener(listener) { messages.add(listener); flush(); } },
    onDisconnect: { addListener: listener => disconnects.add(listener) },
    disconnect() {
      if (closed) return;
      closed = true;
      authenticated = false;
      queued.length = 0;
      socket?.close();
      incoming.disconnect();
      for (const listener of disconnects) listener();
    },
    postMessage(message) {
      if (closed) throw new Error('The Safari connection ended.');
      if (message.type === 'hello') {
        ready = true;
        emit({ type: 'ready', extensionVersion: api.runtime.getManifest().version });
        flush();
      } else if (authenticated && socket?.readyState === 1) {
        socket.send(JSON.stringify(message));
      } else if (message.type !== 'activity') { port.disconnect(); }
    },
  };
  incoming.onDisconnect.addListener(() => { void api.runtime.lastError; port.disconnect(); });
  incoming.onMessage.addListener(message => {
    if (!closed && message?.name === 'link-reuse' && message.userInfo?.type === 'connect') connect(message.userInfo);
  });
  return port;
}
