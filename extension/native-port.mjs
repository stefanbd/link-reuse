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
  function enqueue(request) {
    if (request?.type === 'open' && typeof request.id === 'string' && typeof request.url === 'string' && queued.length < 16) queued.push(request);
  }
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
          for (const request of (reply.requests ?? []).slice(0, 16)) enqueue(request);
          flush();
        }
      }).catch(() => port.disconnect());
    },
  };
  incoming.onDisconnect.addListener(() => { void api.runtime.lastError; port.disconnect(); });
  incoming.onMessage.addListener(message => {
    if (closed || message?.name !== 'link-reuse') return;
    enqueue(message.userInfo);
    flush();
  });
  return port;
}
