export class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open', {}));
  }
  addEventListener(type, listener, options = {}) {
    const entries = this.listeners.get(type) ?? [];
    entries.push({ listener, once: options.once === true });
    this.listeners.set(type, entries);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener));
  }
  emit(type, value) {
    for (const entry of [...(this.listeners.get(type) ?? [])]) {
      entry.listener(value);
      if (entry.once) this.removeEventListener(type, entry.listener);
    }
  }
  send(text) { this.sent.push(JSON.parse(text)); this.onSend?.(this.sent.at(-1)); }
  reply(id, result = {}) { this.emit('message', { data: JSON.stringify({ id, result }) }); }
  fail(id, error) { this.emit('message', { data: JSON.stringify({ id, error }) }); }
  close() { this.emit('close', {}); }
}

export const latestSocket = () => FakeWebSocket.instances.at(-1);
