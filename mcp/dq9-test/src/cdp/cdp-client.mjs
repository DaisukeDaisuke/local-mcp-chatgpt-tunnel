import { RelayError } from '../util/errors.mjs';

const timeoutError = (method, timeoutMs) => new RelayError('CDP_TIMEOUT', `CDP request timed out: ${method}`, { method, timeoutMs });

export class CdpClient {
  constructor({ WebSocketImpl = globalThis.WebSocket, defaultTimeoutMs = 15000 } = {}) {
    if (!WebSocketImpl) throw new RelayError('CDP_UNAVAILABLE', 'Global WebSocket is unavailable in this Node runtime');
    this.WebSocketImpl = WebSocketImpl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Set();
    this.closed = false;
  }

  static async discover(port, { fetchImpl = globalThis.fetch } = {}) {
    if (!fetchImpl) throw new RelayError('CDP_UNAVAILABLE', 'Global fetch is unavailable in this Node runtime');
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) throw new RelayError('CDP_DISCOVERY_FAILED', `CDP endpoint returned HTTP ${response.status}`);
    const pages = await response.json();
    const page = pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
    if (!page) throw new RelayError('CDP_DISCOVERY_FAILED', 'No debuggable page was published by Chrome');
    return page.webSocketDebuggerUrl;
  }

  async connect(webSocketUrl, { timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.socket) return;
    const socket = new this.WebSocketImpl(webSocketUrl);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new RelayError('CDP_CONNECT_TIMEOUT', 'CDP WebSocket did not open before its deadline', { timeoutMs })); }, timeoutMs);
      const open = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new RelayError('CDP_CONNECT_FAILED', 'CDP WebSocket connection failed')); };
      const cleanup = () => { clearTimeout(timer); socket.removeEventListener?.('open', open); socket.removeEventListener?.('error', failed); };
      socket.addEventListener?.('open', open, { once: true });
      socket.addEventListener?.('error', failed, { once: true });
    });
    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => this.#close(new RelayError('CDP_SESSION_CLOSED', 'CDP session closed')));
    socket.addEventListener('error', () => this.#close(new RelayError('CDP_SESSION_CLOSED', 'CDP session failed')));
  }

  onEvent(listener) { this.events.add(listener); return () => this.events.delete(listener); }

  request(method, params = {}, { sessionId, timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.closed || !this.socket) return Promise.reject(new RelayError('CDP_SESSION_CLOSED', 'CDP session is not open'));
    const id = this.nextId++;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(timeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify(payload)); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(new RelayError('CDP_SEND_FAILED', error.message)); }
    });
  }

  close() { this.#close(new RelayError('CDP_SESSION_CLOSED', 'CDP client closed')); }

  #onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new RelayError('CDP_PROTOCOL_ERROR', message.error.message ?? 'CDP returned an error', message.error));
      else pending.resolve(message.result ?? {});
      return;
    }
    for (const listener of this.events) listener(message);
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    try { this.socket?.close(); } catch {}
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
}
