export function connectNative(api) {
  if (!api.runtime.getURL('').startsWith('safari-web-extension:')) {
    const port = api.runtime.connectNative('me.dichev.link_reuse');
    port.onDisconnect.addListener(() => { void api.runtime.lastError; });
    return port;
  }
  const incoming = api.runtime.connectNative('me.dichev.LinkReuse');
  const messages = new Set();
  const disconnects = new Set();
  let closed = false;
  const port = {
    onMessage: { addListener: listener => messages.add(listener) },
    onDisconnect: { addListener: listener => disconnects.add(listener) },
    disconnect() {
      if (closed) return;
      closed = true;
      incoming.disconnect();
      for (const listener of disconnects) listener();
    },
    postMessage(message) {
      if (closed) throw new Error('The Safari connection ended.');
      if (message.type === 'activity') return;
      void api.runtime.sendNativeMessage('me.dichev.LinkReuse', message).then(reply => {
        if (!closed && message.type === 'hello') for (const listener of messages) listener(reply);
      }).catch(() => port.disconnect());
    },
  };
  incoming.onDisconnect.addListener(() => { void api.runtime.lastError; port.disconnect(); });
  incoming.onMessage.addListener(message => {
    if (closed || message?.type !== 'open' || typeof message.id !== 'string' || typeof message.url !== 'string') return;
    void api.runtime.sendNativeMessage('me.dichev.LinkReuse', { type: 'claim', id: message.id }).then(reply => {
      if (!closed && reply.result === 'accepted') for (const listener of messages) listener(message);
    }).catch(() => port.disconnect());
  });
  return port;
}
