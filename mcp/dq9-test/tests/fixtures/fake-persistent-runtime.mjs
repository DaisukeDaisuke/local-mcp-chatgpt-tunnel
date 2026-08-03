const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export class FakePersistentRuntime {
  constructor() {
    this.words = new Map();
    this.bytes = new Map();
    this.dwords = new Map();
    this.registers = new Map();
    this.exec = new Map();
    this.stateLoads = [];
    this.registrations = [];
    this.handlers = new Map();
    this.resumeCount = 0;
    this.memory = {
      readbyte: async (address) => this.bytes.get(address) ?? 0,
      readword: async (address) => { const value = this.words.get(address) ?? 0; return ((value & 0xff) << 8) | ((value >>> 8) & 0xff); },
      readdword: async (address) => { const value = this.dwords.get(address) ?? 0; return (((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >>> 8) & 0xff00) | ((value >>> 24) & 0xff)) >>> 0; },
      getregister: async (name) => this.registers.get(name) ?? 0,
      registerexec: async (address, callback, options) => {
        this.registrations.push({ kind: 'exec', address, options });
        this.exec.set(address, callback);
      }
    };
    this.emu = {
      resume: async () => { this.resumeCount += 1; },
      onStateLoad: async (callback) => {
        this.registrations.push({ kind: 'stateLoad' });
        this.stateLoads.push(callback);
      }
    };
  }

  setWord(address, value) { this.words.set(address, value >>> 0); }
  setByte(address, value) { this.bytes.set(address, value & 0xff); }
  setDword(address, value) { this.dwords.set(address, value >>> 0); }
  setRegister(name, value) { this.registers.set(name, value >>> 0); }

  async load(source, publication = 'observerPublication') {
    if (!source.includes('\nreturn [')) throw new Error(`No persistent publication array in ${publication}`);
    const published = await new AsyncFunction('memory', 'emu', source)(this.memory, this.emu);
    for (const definition of published) this.handlers.set(definition.name, definition);
    return published;
  }

  async hit(address) {
    const callback = this.exec.get(address);
    if (!callback) throw new Error(`No exec callback at 0x${address.toString(16)}`);
    await callback({ address, pc: address, cpu: 'arm9' });
  }

  async loadState() {
    for (const callback of this.stateLoads) await callback({ reason: 'fake-state-load' });
  }

  async call(name, params = {}, blocking = true) {
    const definition = this.handlers.get(name);
    if (!definition) throw new Error(`Unknown handler ${name}`);
    return definition.handler(params, { blocking });
  }
}
