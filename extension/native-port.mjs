export function prepareNative(api) {
  if (!api.runtime.getURL('').startsWith('safari-web-extension:')) return () => connectNative(api);
  let prepared = connectNative(api);
  return () => {
    if (!prepared || prepared.closed) prepared = connectNative(api);
    return prepared;
  };
}

export function connectNative(api) {
  if (!api.runtime.getURL('').startsWith('safari-web-extension:')) {
    const port = api.runtime.connectNative('me.dichev.link_reuse');
    port.onDisconnect.addListener(() => { void api.runtime.lastError; });
    return port;
  }
  const incoming = api.runtime.connectNative('me.dichev.LinkReuse');
  const messages = new Set();
  const disconnects = new Set();
  const queued = [];
  let closed = false;
  let ready = false;
  const trace = stage => { void api.runtime.sendNativeMessage('me.dichev.LinkReuse', { type: 'trace', result: stage }).catch(() => {}); };
  function flush() {
    if (closed || !ready || !messages.size) return;
    for (const message of queued.splice(0)) {
      void api.runtime.sendNativeMessage('me.dichev.LinkReuse', { type: 'claim', id: message.id }).then(reply => {
        if (!closed && reply.result === 'accepted') for (const listener of messages) listener(message);
      }).catch(() => port.disconnect());
    }
  }
  const port = {
    get closed() { return closed; },
    onMessage: { addListener(listener) { messages.add(listener); flush(); } },
    onDisconnect: { addListener: listener => disconnects.add(listener) },
    disconnect() {
      if (closed) return;
      closed = true;
      queued.length = 0;
      trace('port-disconnected');
      incoming.disconnect();
      for (const listener of disconnects) listener();
    },
    postMessage(message) {
      if (closed) throw new Error('The Safari connection ended.');
      if (message.type === 'activity') return;
      void api.runtime.sendNativeMessage('me.dichev.LinkReuse', message).then(reply => {
        if (!closed && message.type === 'hello') {
          ready = true;
          for (const listener of messages) listener(reply);
          flush();
        }
      }).catch(() => port.disconnect());
    },
  };
  incoming.onDisconnect.addListener(() => { void api.runtime.lastError; port.disconnect(); });
  incoming.onMessage.addListener(message => {
    trace('native-message');
    if (closed || message?.type !== 'open' || typeof message.id !== 'string' || typeof message.url !== 'string') return;
    if (queued.length < 16) queued.push(message);
    flush();
  });
  trace('port-open');
  return port;
}
