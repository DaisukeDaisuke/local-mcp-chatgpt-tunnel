import { CdpClient } from './cdp-client.mjs';
import { RelayError } from '../util/errors.mjs';
import { win32 } from 'node:path';

export const roleHandlers = Object.freeze({
  command: Object.freeze(['seeUi', 'listCommands', 'confirmCommand', 'listOptions', 'confirmOption', 'waitForNextSelection', 'backToTop', 'waitForBattleMenu'].sort()),
  observer: Object.freeze(['observerConfigure', 'observerArm', 'observerRead', 'observerReset', 'observerStatus'].sort()),
  incident: Object.freeze(['incidentConfigure', 'incidentArm', 'incidentRead', 'incidentDisarm', 'incidentReset', 'incidentStatus'].sort())
});
const requiredHandlers = new Set(roleHandlers.command);
export const scriptRoleOrder = Object.freeze(['command', 'observer', 'incident']);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class DesmumeAdapter {
  constructor({ cdpFactory = () => new CdpClient(), discover = CdpClient.discover, pollMs = 200 } = {}) {
    this.cdpFactory = cdpFactory;
    this.discover = discover;
    this.pollMs = pollMs;
  }

  async connect(port) {
    let url;
    let lastError;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { url = await this.discover(port); break; }
      catch (error) { lastError = error; await wait(this.pollMs); }
    }
    if (!url) throw lastError;
    this.cdp = this.cdpFactory();
    await this.cdp.connect(url, { timeoutMs: 15000 });
    await this.cdp.request('Runtime.enable');
    await this.cdp.request('DOM.enable');
    return this;
  }

  async navigate(url) {
    await this.cdp.request('Page.enable');
    await this.cdp.request('Page.navigate', { url });
    await this.waitFor(`document.readyState === 'complete'`, { timeoutMs: 60000, label: 'DeSmuME page load' });
    await this.waitFor(`Boolean(window.DesmumeMCP)`, { timeoutMs: 60000, label: 'DeSmuME MCP availability' });
  }

  async close() { this.cdp?.close(); }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.cdp.request('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new RelayError('PAGE_RUNTIME_ERROR', result.exceptionDetails.text ?? 'Page evaluation failed');
    return result.result?.value;
  }

  async waitFor(expression, { timeoutMs = 30000, label = 'page condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await wait(this.pollMs);
    }
    throw new RelayError('PAGE_TIMEOUT', `Timed out waiting for ${label}`, { timeoutMs });
  }

  async #backendNodeId(selector) {
    const objectResult = await this.cdp.request('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})`, returnByValue: false });
    const objectId = objectResult.result?.objectId;
    if (!objectId) throw new RelayError('PAGE_SELECTOR_MISSING', `Required page element was not found: ${selector}`);
    const described = await this.cdp.request('DOM.describeNode', { objectId });
    return described.node.backendNodeId;
  }

  async setLocalFile(selector, path) {
    const backendNodeId = await this.#backendNodeId(selector);
    await this.cdp.request('DOM.setFileInputFiles', { files: [path], backendNodeId });
    await this.evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
  }

  async status() { return this.call('status', {}); }

  async loadRom(path) {
    await this.setLocalFile('#rom-file', path);
    await this.waitFor(`window.DesmumeMCP.call('status', {}).then((status) => Boolean(status?.romLoaded) && !status?.fileTransaction?.active)`, { timeoutMs: 60000, label: 'ROM load' });
  }

  async loadState(path) {
    const before = await this.status();
    const serial = Number(before?.stateLoadSerial ?? 0);
    await this.setLocalFile('#state-file', path);
    await this.waitFor(`window.DesmumeMCP.call('status', {}).then((status) => Number(status?.stateLoadSerial ?? 0) > ${serial} && !status?.fileTransaction?.active)`, { timeoutMs: 60000, label: 'State load' });
  }

  async loadPersistentScript(path) {
    await this.setLocalFile('#script-file', path);
    const expectedName = win32.basename(path).replace(/\.[^.]+$/, '') || 'script';
    await this.waitFor(`document.querySelector('#script-name')?.value === ${JSON.stringify(expectedName)}`, { timeoutMs: 30000, label: 'persistent script source' });
    await this.evaluate(`document.querySelector('#script-async-mode').checked = false; document.querySelector('#script-run-btn').click()`);
  }

  async loadPersistentScripts(paths) {
    for (const role of scriptRoleOrder) {
      if (typeof paths?.[role] !== 'string') throw new RelayError('SCRIPT_ROLE_PATH_MISSING', `Missing ${role} script path`);
      await this.loadPersistentScript(paths[role]);
    }
    return this.discoverScriptRoles();
  }

  async call(command, params) {
    return this.evaluate(`window.DesmumeMCP.call(${JSON.stringify(command)}, ${JSON.stringify(params)})`);
  }

  async discoverBattleHandlers({ timeoutMs = 30000 } = {}) {
    const roles = await this.discoverScriptRoles({ timeoutMs, expectedRoles: ['command'] });
    return { scriptId: roles.command.scriptId, handlers: roles.command.handlers };
  }

  async discoverScriptRoles({ timeoutMs = 30000, expectedRoles = scriptRoleOrder } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastInventory = null;
    while (Date.now() < deadline) {
      const [scriptsResponse, mcpsResponse] = await Promise.all([this.call('listScripts', {}), this.call('listPScriptMcp', {})]);
      const scripts = scriptsResponse?.scripts ?? scriptsResponse?.items ?? [];
      const mcps = mcpsResponse?.mcps ?? [];
      lastInventory = { scripts, mcps };
      const resolved = {};
      let valid = true;
      for (const role of expectedRoles) {
        const expected = roleHandlers[role];
        const candidates = new Map();
        for (const item of mcps) {
          if (!expected.includes(item.name)) continue;
          const entry = candidates.get(item.scriptId) ?? { scriptId: item.scriptId, scriptName: item.scriptName, handlers: [] };
          entry.handlers.push(item.name); candidates.set(item.scriptId, entry);
        }
        const exact = [...candidates.values()].filter((entry) => {
          const names = [...new Set(entry.handlers)].sort();
          entry.handlers = names;
          return names.length === expected.length && expected.every((name, index) => name === names[index]);
        }).filter((entry) => {
          const script = scripts.find((item) => (item.id ?? item.scriptId) === entry.scriptId);
          return !script || script.running !== false;
        });
        if (exact.length !== 1) { valid = false; break; }
        resolved[role] = exact[0];
      }
      if (valid) {
        const ids = Object.values(resolved).map((entry) => entry.scriptId);
        if (new Set(ids).size === ids.length) return resolved;
      }
      await wait(this.pollMs);
    }
    throw new RelayError('SCRIPT_ROLE_DISCOVERY_FAILED', 'Expected role handler sets were not uniquely published by distinct running scripts', { expectedRoles, lastInventory });
  }

  async callBattle(scriptId, name, params = {}, timeoutMs = 70000) {
    if (!requiredHandlers.has(name)) throw new RelayError('HANDLER_NOT_ALLOWED', `Handler is not allowed: ${name}`);
    const transport = await this.call('callPScriptMcp', { scriptId, name, params, blocking: true, timeoutMs });
    if (!transport?.ok) throw new RelayError('HANDLER_TRANSPORT_ERROR', 'Persistent-script transport failed', { name, transport });
    if (!transport.value || typeof transport.value.status !== 'string') {
      throw new RelayError('HANDLER_RESULT_INVALID', 'Persistent-script handler did not return value.status', { name });
    }
    return { transport, handlerStatus: transport.value.status };
  }

  async callRole(registry, role, name, params = {}, innerTimeoutMs = 90000, outerTimeoutMs = 100000) {
    const script = registry?.[role];
    if (!script || !roleHandlers[role]?.includes(name)) throw new RelayError('HANDLER_NOT_ALLOWED', `Handler ${name} is not registered for role ${role}`);
    if (!(outerTimeoutMs > innerTimeoutMs)) throw new RelayError('INVALID_TIMEOUT_ORDER', 'Outer eval timeout must exceed the persistent handler timeout', { innerTimeoutMs, outerTimeoutMs });
    const call = this.call('callPScriptMcp', { scriptId: script.scriptId, name, params, blocking: true, timeoutMs: innerTimeoutMs });
    let timer;
    const transport = await Promise.race([
      call,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new RelayError('HANDLER_OUTER_TIMEOUT', 'Outer handler timeout expired; action result is discarded', { role, name, outerTimeoutMs })), outerTimeoutMs); })
    ]).finally(() => clearTimeout(timer));
    if (!transport?.ok) throw new RelayError('HANDLER_TRANSPORT_ERROR', 'Persistent-script transport failed', { role, name, transport });
    if (!transport.value || typeof transport.value.status !== 'string') throw new RelayError('HANDLER_RESULT_INVALID', 'Persistent-script handler did not return value.status', { role, name });
    return { transport, handlerStatus: transport.value.status, value: transport.value };
  }

  async applyExactStateAndReset(path, registry) {
    const before = await this.status();
    await this.loadState(path);
    await this.call('releaseInput', {});
    const discovered = await this.discoverScriptRoles();
    for (const role of scriptRoleOrder) if (discovered[role].scriptId !== registry[role].scriptId) throw new RelayError('SCRIPT_INVENTORY_CHANGED', `Script identity changed during State load: ${role}`);
    const observer = await this.callRole(discovered, 'observer', 'observerReset', {}, 10000, 15000);
    const incident = await this.callRole(discovered, 'incident', 'incidentReset', {}, 10000, 15000);
    const after = await this.status();
    if (!(Number(after.stateLoadSerial) > Number(before.stateLoadSerial))) throw new RelayError('STATE_SERIAL_UNCHANGED', 'Exact State did not increment stateLoadSerial');
    return { status: after, registry: discovered, hookInventory: { observer: observer.value.hookInventory, incident: incident.value.hookInventory } };
  }

  async resumeOnly() {
    const result = await this.call('resume', {});
    if (result?.ok === false) throw new RelayError('RESUME_FAILED', 'Resume-only operation failed', { result });
    return result;
  }

  async pollCommandReady(registry, { timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let consecutiveReady = 0;
    while (Date.now() < deadline) {
      const [status, input, inventory, uiResult] = await Promise.all([
        this.status(), this.call('getInputState', {}), this.discoverScriptRoles({ timeoutMs: 1000 }),
        this.callRole(registry, 'command', 'seeUi', {}, 10000, 15000)
      ]);
      const ui = uiResult.value;
      const owner = ui.ui?.ownerState ?? ui.ui?.owner?.state ?? ui.ui?.state;
      const major = ui.screen?.major ?? ui.screen?.[0];
      const detail = ui.screen?.detail ?? ui.screen?.[1];
      const neutral = input?.pressed?.length === 0 || Object.values(input?.buttons ?? {}).every((pressed) => !pressed);
      last = { status, input, ui, inventory };
      if (status?.running === true && status?.paused === false && owner === 1 && major === 7 && detail === 4 && neutral) {
        consecutiveReady += 1;
        if (consecutiveReady >= 2) return { ...last, stablePolls: consecutiveReady };
      } else consecutiveReady = 0;
      await wait(this.pollMs);
    }
    throw new RelayError('COMMAND_PRECONDITION_FAILED', 'Strict delayed poll did not reach running top battle menu with neutral input', { timeoutMs, last });
  }

  async createTurnCheckpoint(reference) {
    if (typeof reference !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(reference)) throw new RelayError('CHECKPOINT_REF_INVALID', 'Turn checkpoint reference must be path-safe');
    const before = await this.status();
    const saved = await this.call('saveState', { slot: reference });
    if (saved?.ok === false) throw new RelayError('TURN_CHECKPOINT_FAILED', 'saveState failed', { reference, saved });
    const slotsResponse = await this.call('listStateSlots', {});
    const slots = slotsResponse?.slots ?? slotsResponse?.items ?? [];
    const match = slots.find((item) => typeof item === 'string' ? item === reference : item.slot === reference || item.name === reference || item.id === reference);
    if (!match) throw new RelayError('TURN_CHECKPOINT_UNVERIFIED', 'Saved State reference was not present in bounded slot inventory', { reference });
    const after = await this.status();
    if (Number(after.stateLoadSerial) !== Number(before.stateLoadSerial)) throw new RelayError('TURN_CHECKPOINT_CHANGED_STATE', 'Saving a turn checkpoint unexpectedly changed stateLoadSerial');
    return { reference, stateLoadSerial: Number(after.stateLoadSerial), identity: { romName: after.romName ?? after.rom?.name ?? null, romSize: after.romSize ?? after.rom?.size ?? null }, slot: typeof match === 'string' ? { id: null, name: match, size: null } : { id: match.id ?? null, name: match.name ?? match.slot ?? reference, size: match.size ?? match.bytes ?? null } };
  }

  async stopRole(registry, role) {
    const target = registry?.[role];
    if (!target) throw new RelayError('SCRIPT_ROLE_UNKNOWN', `Unknown role ${role}`);
    const returned = await this.call('stopScript', { id: target.scriptId });
    const returnedId = returned?.id ?? returned?.scriptId ?? returned?.stoppedId;
    if (returned?.ok === false || returnedId !== target.scriptId) throw new RelayError('STOP_TARGET_MISMATCH', 'stopScript returned a different target', { role, target, returned });
    const remainingMcps = (await this.call('listPScriptMcp', {}))?.mcps ?? [];
    if (remainingMcps.some((item) => item.scriptId === target.scriptId)) throw new RelayError('STOP_INVENTORY_MISMATCH', 'Stopped role still publishes handlers', { role, target });
    for (const other of scriptRoleOrder.filter((name) => name !== role)) {
      const expected = roleHandlers[other];
      const actual = remainingMcps.filter((item) => item.scriptId === registry[other].scriptId).map((item) => item.name).sort();
      if (actual.length !== expected.length || !expected.every((name, index) => name === actual[index])) throw new RelayError('STOP_DAMAGED_OTHER_ROLE', `Stopping ${role} damaged ${other}`);
    }
    return { role, scriptId: target.scriptId, returned, zeroHandlers: true };
  }
}

export const documentedBattleHandlers = Object.freeze([...requiredHandlers].sort());
