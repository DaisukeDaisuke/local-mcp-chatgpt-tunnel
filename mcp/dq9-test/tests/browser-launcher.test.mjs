import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserLauncher } from '../src/cdp/browser-launcher.mjs';
import { parseHoldMs, soakEndpoints } from '../scripts/run-multi-browser-smoke.mjs';

const makeChild = (pid, { emitOnKill = true } = {}) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; if (emitOnKill) { child.exitCode = 0; child.emit('exit', 0); } };
  return child;
};

const configFor = (index) => ({
  chromePath: 'chrome.exe',
  runtimeDirectory: 'C:\\multi-browser-smoke',
  profileDirectory: `C:\\multi-browser-smoke\\profile-${index}`,
  cdpPort: 12000 + index,
  url: 'about:blank'
});

test('launcher supports five concurrent unique owned browser reservations', async () => {
  const calls = [];
  let nextPid = 1;
  const launcher = new BrowserLauncher({ spawnImpl: (_path, args) => { calls.push(args); return makeChild(nextPid++); }, mkdirImpl: async () => {} });
  const owned = await Promise.all([1, 2, 3, 4, 5].map((index) => launcher.launch(configFor(index))));
  assert.equal(calls.length, 5);
  assert.equal(new Set(owned.map((item) => item.cdpPort)).size, 5);
  assert.equal(new Set(owned.map((item) => item.profileDirectory)).size, 5);
  assert.ok(calls.every((args) => args.includes('--remote-debugging-address=127.0.0.1')));
});

test('launcher rejects duplicate port and profile before an unsafe second spawn', async () => {
  let calls = 0;
  const launcher = new BrowserLauncher({ spawnImpl: () => { calls += 1; return makeChild(calls); }, mkdirImpl: async () => {} });
  await launcher.launch(configFor(1));
  await assert.rejects(launcher.launch({ ...configFor(2), cdpPort: 12001 }), { code: 'CHROME_LAUNCH_COLLISION' });
  await assert.rejects(launcher.launch({ ...configFor(3), profileDirectory: configFor(1).profileDirectory }), { code: 'CHROME_LAUNCH_COLLISION' });
  assert.equal(calls, 1);
});

test('stopping one owned browser retains its lease until exit and does not affect another', async () => {
  const children = [makeChild(1, { emitOnKill: false }), makeChild(2)];
  let nextPid = 3;
  const launcher = new BrowserLauncher({ spawnImpl: () => children.shift() ?? makeChild(nextPid++), mkdirImpl: async () => {} });
  const first = await launcher.launch(configFor(1));
  const second = await launcher.launch(configFor(2));
  await launcher.stop(first);
  assert.equal(first.child.killed, true);
  assert.equal(second.child.killed, false);
  await assert.rejects(launcher.launch({ ...configFor(3), cdpPort: first.cdpPort }), { code: 'CHROME_LAUNCH_COLLISION' });
  await assert.rejects(launcher.launch({ ...configFor(3), profileDirectory: first.profileDirectory }), { code: 'CHROME_LAUNCH_COLLISION' });
  first.child.exitCode = 0;
  first.child.emit('exit', 0);
  await launcher.launch({ ...configFor(3), cdpPort: first.cdpPort });
  await launcher.launch({ ...configFor(4), profileDirectory: first.profileDirectory });
  await launcher.stop(second);
});

test('multi-browser hold parsing and polling use injected short timing', async () => {
  assert.equal(parseHoldMs([]), 30000);
  assert.equal(parseHoldMs(['--hold-ms', '1500']), 1500);
  assert.throws(() => parseHoldMs(['--hold-ms', '0']), /between 1000 and 60000/);
  assert.throws(() => parseHoldMs(['--other', '1500']), /Usage/);
  let now = 0;
  const probes = [];
  const progress = [];
  await soakEndpoints({ ports: [1, 2], holdMs: 3, pollMs: 1, probe: async (port) => probes.push(port), sleep: async (milliseconds) => { now += milliseconds; }, now: () => now, onProgress: (elapsed) => progress.push(elapsed) });
  assert.deepEqual(probes, [1, 2, 1, 2, 1, 2, 1, 2]);
  assert.deepEqual(progress, [0]);
});
