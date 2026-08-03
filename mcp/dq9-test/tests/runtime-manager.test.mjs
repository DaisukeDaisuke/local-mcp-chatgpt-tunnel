import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/services/config-loader.mjs';
import { RuntimeManager } from '../src/services/runtime-manager.mjs';
import { DesmumeAdapter, roleHandlers, scriptRoleOrder } from '../src/cdp/desmume-adapter.mjs';
import { fileURLToPath } from 'node:url';

const config = Object.freeze({
  chromePath: 'chrome.exe', url: 'https://example.test/', romPath: 'rom.nds', statePath: 'state.dst',
  scriptPaths: { command: 'command.js', observer: 'observer.js', incident: 'incident.js' }, profilePath: fileURLToPath(new URL('../profiles/battle-runtime-profile-v1.json', import.meta.url)),
  cdpPort: 9222, runtimeDirectory: 'C:\\worker-runtime'
});
const registry = Object.freeze(Object.fromEntries(scriptRoleOrder.map((role, index) => [role, { scriptId: index + 7, scriptName: role, handlers: roleHandlers[role] }])));

const makeRuntime = () => {
  const calls = [];
  const child = { pid: 1234, exitCode: null, killed: false, kill() { this.killed = true; } };
  const launcher = { launch: async () => ({ child, cdpPort: 9222 }), stop: async (owned) => { calls.push(['stop', owned.child.pid]); owned.child.kill(); return { stopped: true }; } };
  const adapter = {
    connect: async () => calls.push(['connect']), navigate: async () => calls.push(['navigate']), loadRom: async () => calls.push(['rom']), loadState: async () => calls.push(['state']),
    loadPersistentScripts: async (paths) => { calls.push(['scripts', Object.keys(paths)]); return registry; }, discoverScriptRoles: async () => registry,
    close: async () => calls.push(['close'])
  };
  return { calls, child, manager: new RuntimeManager({ config, launcher, adapterFactory: () => adapter, hash: async (value) => `hash:${value}` }) };
};

test('config requires three script roles/profile and runtime loads command -> observer -> incident once', async () => {
  const fs = { access: async () => {}, stat: async () => ({ isFile: () => true }) };
  const checked = await validateConfig(config, { fs });
  assert.deepEqual(Object.keys(checked.scriptPaths), scriptRoleOrder);
  await assert.rejects(validateConfig({ ...config, scriptPaths: { command: 'x' } }, { fs }), { code: 'INVALID_CONFIG' });
  const { manager, calls } = makeRuntime();
  const first = await manager.prepare(); const second = await manager.prepare();
  assert.equal(first.reused, false); assert.equal(second.reused, true);
  assert.deepEqual(calls.find(([name]) => name === 'scripts')[1], scriptRoleOrder);
  assert.deepEqual(first.handlers.command, roleHandlers.command);
});

test('runtime stop is idempotent and terminates only its owned process', async () => {
  const { manager, child, calls } = makeRuntime(); await manager.prepare();
  assert.equal((await manager.stop()).state, 'stopped'); assert.equal(child.killed, true);
  assert.deepEqual(calls.filter(([name]) => name === 'stop'), [['stop', 1234]]);
  assert.equal((await manager.stop()).alreadyStopped, true);
});

test('adapter discovers role IDs from exact handler sets and rejects running zero-handler scripts', async () => {
  const adapter = new DesmumeAdapter({ pollMs: 1 });
  const mcps = Object.entries(registry).flatMap(([, entry]) => entry.handlers.map((name) => ({ scriptId: entry.scriptId, scriptName: entry.scriptName, name })));
  adapter.call = async (name) => name === 'listScripts'
    ? { scripts: [...Object.values(registry).map((entry) => ({ id: entry.scriptId, name: entry.scriptName, running: true })), { id: 99, name: 'empty', running: true }] }
    : { mcps };
  const found = await adapter.discoverScriptRoles({ timeoutMs: 20 });
  assert.deepEqual(Object.fromEntries(Object.entries(found).map(([role, value]) => [role, value.scriptId])), { command: 7, observer: 8, incident: 9 });
});

test('paused precondition prevents command call until resume-only then independent delayed poll', async () => {
  const adapter = new DesmumeAdapter({ pollMs: 1 });
  let resumed = false; const order = [];
  adapter.call = async (name) => {
    order.push(name);
    if (name === 'resume') { resumed = true; return { ok: true, running: true, paused: false }; }
    if (name === 'status') return { running: resumed, paused: !resumed };
    if (name === 'getInputState') return { pressed: [] };
    throw new Error(name);
  };
  adapter.discoverScriptRoles = async () => registry;
  adapter.callRole = async (_registry, role, name) => {
    assert.equal(role, 'command'); assert.equal(name, 'seeUi');
    return { value: { status: 'ok', ui: { ownerState: 1 }, screen: { major: 7, detail: 4 } } };
  };
  await assert.rejects(adapter.pollCommandReady(registry, { timeoutMs: 5 }), { code: 'COMMAND_PRECONDITION_FAILED' });
  assert.equal(order.includes('confirmOption'), false);
  await adapter.resumeOnly();
  const ready = await adapter.pollCommandReady(registry, { timeoutMs: 20 });
  assert.equal(ready.status.running, true);
});

test('turn checkpoint records only a verified bounded reference and does not change State serial', async () => {
  const adapter = new DesmumeAdapter();
  let statusCalls = 0;
  adapter.status = async () => ({ stateLoadSerial: 12, romName: 'dq9_new2.nds', romSize: 268435456, running: true, paused: false, ordinal: statusCalls++ });
  adapter.call = async (name, params) => name === 'saveState' ? { ok: true, slot: params.slot } : { slots: [{ slot: 'turn-run-case-0', size: 123456 }] };
  const checkpoint = await adapter.createTurnCheckpoint('turn-run-case-0');
  assert.equal(checkpoint.reference, 'turn-run-case-0'); assert.equal(checkpoint.stateLoadSerial, 12); assert.equal(checkpoint.slot.size, 123456);
  assert.equal(Object.hasOwn(checkpoint, 'stateBody'), false);
});

test('stop uses canonical id, verifies returned target/zero handlers, and preserves other roles', async () => {
  const adapter = new DesmumeAdapter();
  let stopped = null;
  const remaining = Object.entries(registry).filter(([role]) => role !== 'incident').flatMap(([, entry]) => entry.handlers.map((name) => ({ scriptId: entry.scriptId, name })));
  adapter.call = async (name, params) => {
    if (name === 'stopScript') { stopped = params; return { ok: true, id: params.id }; }
    if (name === 'listPScriptMcp') return { mcps: remaining };
    throw new Error(name);
  };
  const result = await adapter.stopRole(registry, 'incident');
  assert.deepEqual(stopped, { id: 9 }); assert.equal(result.zeroHandlers, true);
});
