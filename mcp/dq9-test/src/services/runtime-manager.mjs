import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { BrowserLauncher } from '../cdp/browser-launcher.mjs';
import { DesmumeAdapter } from '../cdp/desmume-adapter.mjs';
import { RelayError } from '../util/errors.mjs';
import { loadBattleRuntimeProfile, persistentProfilePayload } from '../runtime/battle-runtime-profile.mjs';

const hashFile = (path) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolve(hash.digest('hex')));
});

export class RuntimeManager {
  constructor({ config, launcher = new BrowserLauncher(), adapterFactory = () => new DesmumeAdapter(), hash = hashFile, progress = () => {}, stageTimeouts = {} } = {}) {
    this.config = config;
    this.launcher = launcher;
    this.adapterFactory = adapterFactory;
    this.hash = hash;
    this.progress = progress;
    this.stageTimeouts = { browserLaunch: 30000, browserEndpoint: 30000, navigation: 60000, romLoad: 60000, stateLoad: 60000, scriptLoad: 30000, handlerPublication: 60000, overall: 240000, ...stageTimeouts };
    this.state = 'idle';
    this.admissionOpen = false;
    this.runtime = null;
    this.stopRequested = false;
    this.provisional = null;
    this.stopListeners = new Set();
  }

  onStopping(listener) { this.stopListeners.add(listener); return () => this.stopListeners.delete(listener); }

  getStatus() {
    return {
      state: this.state,
      admissionOpen: this.admissionOpen,
      runtimeEpoch: this.runtime?.runtimeEpoch ?? null,
      cdpPort: this.runtime?.cdpPort ?? null,
      handlers: this.runtime?.handlers ?? [],
      inFlight: this.runtime?.inFlight ?? 0
    };
  }

  async prepare({ laneCount = 1, concurrency = 1 } = {}) {
    if (laneCount > 1 || concurrency > 1) throw new RelayError('ONE_LANE_ONLY', 'This milestone supports exactly one lane and one concurrent run', { laneCount, concurrency });
    if (laneCount < 1 || concurrency < 1) throw new RelayError('INVALID_LANE_REQUEST', 'laneCount and concurrency must be positive integers');
    if (this.state === 'ready' && this.runtime) return this.#metadata(true);
    if (this.state === 'preparing' || this.state === 'stopping') throw new RelayError('RUNTIME_BUSY', `Runtime is ${this.state}`);
    this.state = 'preparing';
    this.admissionOpen = false;
    this.stopRequested = false;
    try {
      const ownedBrowser = await this.#within('browserLaunch', () => this.launcher.launch(this.config));
      const adapter = this.adapterFactory();
      this.provisional = { ownedBrowser, adapter };
      await this.#within('browserEndpoint', () => adapter.connect(this.config.cdpPort));
      this.#ensurePreparing();
      await this.#within('navigation', () => adapter.navigate(this.config.url));
      this.#ensurePreparing();
      await this.#within('romLoad', () => adapter.loadRom(this.config.romPath));
      this.#ensurePreparing();
      await this.#within('stateLoad', () => adapter.loadState(this.config.statePath));
      this.#ensurePreparing();
      const profile = await loadBattleRuntimeProfile(this.config.profilePath);
      const roles = await this.#within('scriptLoad', () => adapter.loadPersistentScripts(this.config.scriptPaths));
      this.#ensurePreparing();
      const published = await this.#within('handlerPublication', () => adapter.discoverScriptRoles());
      this.#ensurePreparing();
      this.runtime = {
        runtimeEpoch: crypto.randomUUID(),
        ownedBrowser,
        adapter,
        roles: published,
        profile,
        profilePayload: persistentProfilePayload(profile),
        scriptId: published.command.scriptId,
        handlers: Object.fromEntries(Object.entries(published).map(([role, value]) => [role, value.handlers])),
        cdpPort: this.config.cdpPort,
        inFlight: 0,
        hashes: {
          rom: await this.hash(this.config.romPath),
          state: await this.hash(this.config.statePath),
          scripts: Object.fromEntries(await Promise.all(Object.entries(this.config.scriptPaths).map(async ([role, path]) => [role, await this.hash(path)]))),
          profile: await this.hash(this.config.profilePath)
        }
      };
      this.provisional = null;
      this.state = 'ready';
      this.admissionOpen = true;
      return this.#metadata(false);
    } catch (error) {
      if (!this.stopRequested) this.state = 'failed';
      this.admissionOpen = false;
      await this.#disposeAll();
      throw error;
    }
  }

  async withRuntime(work) {
    if (this.state !== 'ready' || !this.runtime || !this.admissionOpen) throw new RelayError('RUNTIME_NOT_READY', 'Prepare a ready runtime before running cases');
    if (this.runtime.inFlight !== 0) throw new RelayError('RUNTIME_BUSY', 'The single DQ9 runtime is already executing another operation');
    this.runtime.inFlight += 1;
    try { return await work(this.runtime); }
    finally { this.runtime.inFlight -= 1; }
  }

  async reloadState() {
    return this.withRuntime(async (runtime) => {
      const applied = await runtime.adapter.applyExactStateAndReset(this.config.statePath, runtime.roles);
      runtime.roles = applied.registry;
      runtime.scriptId = runtime.roles.command.scriptId;
      return applied;
    });
  }

  async resumeOnly() {
    return this.withRuntime((runtime) => runtime.adapter.resumeOnly());
  }

  async pollReady(options) {
    return this.withRuntime((runtime) => runtime.adapter.pollCommandReady(runtime.roles, options));
  }

  async callRole(role, name, params = {}, innerTimeoutMs = 90000, outerTimeoutMs = 100000) {
    return this.withRuntime((runtime) => runtime.adapter.callRole(runtime.roles, role, name, params, innerTimeoutMs, outerTimeoutMs));
  }

  async stop() {
    if (this.state === 'idle' || this.state === 'stopped') return { state: this.state, alreadyStopped: true };
    this.admissionOpen = false;
    this.stopRequested = true;
    this.state = 'stopping';
    for (const listener of this.stopListeners) listener();
    const stopped = await this.#disposeAll();
    this.state = 'stopped';
    return { state: this.state, alreadyStopped: !stopped };
  }

  async #within(stage, work) {
    const timeoutMs = this.stageTimeouts[stage];
    this.progress({ stage, event: 'start', timeoutMs });
    let timer;
    try {
      const result = await Promise.race([
        work(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new RelayError('RUNTIME_STAGE_TIMEOUT', `Runtime stage timed out: ${stage}`, { stage, timeoutMs })), timeoutMs); })
      ]);
      this.progress({ stage, event: 'complete' });
      return result;
    } catch (error) {
      error.details = { ...(error.details ?? {}), stage, timeoutMs };
      this.progress({ stage, event: 'error', code: error.code ?? 'INTERNAL_ERROR' });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  #ensurePreparing() {
    if (this.stopRequested || this.state !== 'preparing') throw new RelayError('RUNTIME_STOPPED', 'Runtime preparation was stopped');
  }

  #metadata(reused) {
    return {
      reused,
      runtimeEpoch: this.runtime.runtimeEpoch,
      laneCount: 1,
      cdpPort: this.runtime.cdpPort,
      handlers: this.runtime.handlers,
      paths: { rom: this.config.romPath, state: this.config.statePath, scripts: this.config.scriptPaths, profile: this.config.profilePath },
      hashes: this.runtime.hashes
    };
  }

  async #disposeAll() {
    const runtime = this.runtime ?? this.provisional;
    this.runtime = null;
    this.provisional = null;
    if (!runtime) return false;
    await runtime.adapter?.close();
    await this.launcher.stop(runtime.ownedBrowser);
    return true;
  }
}
