export class WsClient {
  constructor(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.listeners = new Set();
    this.intentionalSockets = new WeakSet();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* isolate subscribers */ }
    }
  }

  connect() {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) {
      return this.socket;
    }
    if (typeof this.WebSocketImpl !== 'function') {
      this.emit({ type: 'error', error: new Error('WebSocket is unavailable'), url: this.url });
      return null;
    }
    try {
      const socket = new this.WebSocketImpl(this.url);
      this.socket = socket;
      socket.addEventListener('open', () => this.emit({ type: 'open', url: this.url }));
      socket.addEventListener('message', (event) => {
        this.emit({ type: 'message', data: event.data, url: this.url });
      });
      socket.addEventListener('error', (event) => {
        this.emit({ type: 'error', error: event?.error || null, url: this.url });
      });
      socket.addEventListener('close', (event) => {
        this.emit({
          type: 'close', code: event?.code, reason: event?.reason || '',
          intentional: this.intentionalSockets.has(socket), url: this.url,
        });
      });
      return socket;
    } catch (error) {
      this.emit({ type: 'error', error, url: this.url });
      return null;
    }
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    this.socket.send(payload);
    return true;
  }

  close(code, reason) {
    if (!this.socket) return;
    this.intentionalSockets.add(this.socket);
    try { this.socket.close(code, reason); } catch { /* ignore close races */ }
  }

  setUrl(url) {
    this.url = String(url || this.url);
    return this.url;
  }

  reconnect() {
    const previous = this.socket;
    if (previous) {
      this.intentionalSockets.add(previous);
      try { previous.close(); } catch { /* ignore close races */ }
    }
    this.socket = null;
    return this.connect();
  }
}

export function createWsClient(url, options) {
  return new WsClient(url, options);
}
