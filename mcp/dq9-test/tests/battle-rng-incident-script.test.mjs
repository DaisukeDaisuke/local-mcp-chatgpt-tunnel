import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakePersistentRuntime } from './fixtures/fake-persistent-runtime.mjs';
import { lcgAdvance } from '../src/runtime/rng-lcg.mjs';

const source = await readFile(new URL('../../scripts/dq9/battle_rng_incident_mcp.js', import.meta.url), 'utf8');
const profile = JSON.parse(await readFile(new URL('../profiles/battle-runtime-profile-v1.json', import.meta.url), 'utf8'));
const seedAddress = Number.parseInt(profile.rng.seedLowAddress.slice(2), 16);
const hook = (role) => Number.parseInt(profile.hooks.find((item) => item.role === role).address.slice(2), 16);
const randInt = profile.diagnosticRngApis.find((item) => item.id === 'RandInt');
const setSeed = (runtime, value) => {
  runtime.setDword(seedAddress, Number(value & 0xffffffffn));
  runtime.setDword(seedAddress + 4, Number(value >> 32n));
};
const setup = async () => {
  const runtime = new FakePersistentRuntime(); setSeed(runtime, 0x1234n);
  await runtime.load(source, 'incidentPublication');
  await runtime.call('incidentConfigure', { profile, initialSeedK: '0x0000000000001234' });
  return runtime;
};

test('incident mode is inactive normally and fixed hooks do not multiply across reset/configure', async () => {
  const runtime = await setup();
  assert.deepEqual([...runtime.handlers.keys()], ['incidentConfigure', 'incidentArm', 'incidentRead', 'incidentDisarm', 'incidentReset', 'incidentStatus']);
  const first = await runtime.call('incidentStatus');
  assert.equal(first.armed, false); assert.equal(first.hookInventory.active, 0); assert.equal(first.hookInventory.registered, 8);
  await runtime.call('incidentReset'); await runtime.call('incidentConfigure', { profile, initialSeedK: '0x0000000000001234' });
  assert.equal(runtime.registrations.filter((item) => item.kind === 'exec').length, 8);
});

test('bounded incident replay separates sequence/call count from mathematical positions and disarms cleanly', async () => {
  const runtime = await setup();
  await runtime.call('incidentArm', { traceId: 'trace-1', traceSize: 8, callCount: 2, actionCount: 1 });
  runtime.setRegister('lr', 0x02160d64); await runtime.hit(Number.parseInt(randInt.entry.slice(2), 16));
  setSeed(runtime, lcgAdvance(0x1234n, 1n)); runtime.setRegister('r0', 1); await runtime.hit(Number.parseInt(randInt.exit.slice(2), 16));
  await runtime.hit(hook('incident.group.start'));
  runtime.setRegister('lr', 0x02159b10); await runtime.hit(Number.parseInt(randInt.entry.slice(2), 16));
  setSeed(runtime, lcgAdvance(0x1234n, 2n)); runtime.setRegister('r0', 7); await runtime.hit(Number.parseInt(randInt.exit.slice(2), 16));
  await runtime.hit(hook('incident.group.end'));
  const trace = await runtime.call('incidentRead');
  assert.equal(trace.rngApiCallCount, 2); assert.equal(trace.events[0].inGroup, false);
  assert.equal(trace.events[0].after.position, '0x0000000000000001');
  assert.equal(trace.events[2].inGroup, true); assert.equal(trace.diagnosticCounterIsPosition, false); assert.equal(trace.rngApiCallCountIsPosition, false);
  const disarmed = await runtime.call('incidentDisarm');
  assert.equal(disarmed.hookInventory.active, 0);
});

test('incident hard limits stop capture and State reload clears initial-seed ownership', async () => {
  const runtime = await setup();
  await runtime.call('incidentArm', { traceId: 'limit', traceSize: 1, callCount: 1, actionCount: 1 });
  await runtime.hit(hook('incident.group.start')); await runtime.hit(hook('incident.group.end'));
  assert.equal((await runtime.call('incidentStatus')).overflow, 'trace-size');
  await runtime.loadState();
  const status = await runtime.call('incidentStatus');
  assert.equal(status.configured, false); assert.equal(status.armed, false); assert.equal(status.hookInventory.active, 0);
});
