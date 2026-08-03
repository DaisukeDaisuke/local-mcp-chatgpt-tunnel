import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakePersistentRuntime } from './fixtures/fake-persistent-runtime.mjs';
import { lcgAdvance } from '../src/runtime/rng-lcg.mjs';

const sourceUrl = new URL('../../scripts/dq9/battle_observer_mcp.js', import.meta.url);
const profileUrl = new URL('../profiles/battle-runtime-profile-v1.json', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
profile.rng.recovery = { maxBackwardSteps: 64, battleMaxSteps: 64, coverageBasis: 'fake runtime bounded fixture' };
const byRole = Object.fromEntries(profile.hooks.map((hook) => [hook.role, Number.parseInt(hook.address.slice(2), 16)]));
const seedAddress = Number.parseInt(profile.rng.seedLowAddress.slice(2), 16);
const cameraAddress = Number.parseInt(profile.memory.cameraObservable.address.slice(2), 16);
const entityAddress = 0x02101000;
const statusAddress = 0x02102000;
const offsets = { hp: 0, mp: 2, baseDefense: 10, defenseStageWord: 88, defenseTurns: 111 };

const setSeed = (runtime, seed) => {
  runtime.setDword(seedAddress, Number(seed & 0xffffffffn));
  runtime.setDword(seedAddress + 4, Number((seed >> 32n) & 0xffffffffn));
};
const setup = async () => {
  const runtime = new FakePersistentRuntime();
  runtime.setWord(entityAddress, 402); runtime.setWord(entityAddress + 2, 10); runtime.setWord(entityAddress + 10, 285);
  runtime.setDword(statusAddress + 88, 0); runtime.setByte(statusAddress + 111, 0);
  setSeed(runtime, lcgAdvance(0x1234n, 3n));
  await runtime.load(source);
  return runtime;
};
const configure = (runtime, sessionId = 'session-1') => runtime.call('observerConfigure', { sessionId, sessionKind: 'rewind', profile });
const arm = (runtime, actionId = 'action-1') => runtime.call('observerArm', { actionId, entities: [{ identity: 'enemy:1', address: '0x02101000', statusAddress: '0x02102000', offsets }] });

test('observer publishes its role handler set, resolves unique K, and registers fixed hooks once', async () => {
  const runtime = await setup();
  assert.deepEqual([...runtime.handlers.keys()], ['observerConfigure', 'observerArm', 'observerRead', 'observerReset', 'observerStatus']);
  const configured = await configure(runtime);
  assert.equal(configured.initialSeed.initialSeedStatus, 'recovered');
  assert.equal(configured.initialSeed.initialSeedK, '0x0000000000001234');
  assert.equal(configured.initialSeed.initialSeedCandidateCount, 1);
  assert.equal(runtime.registrations.filter((item) => item.kind === 'exec').length, 12);
  await runtime.call('observerReset'); await configure(runtime, 'session-2');
  assert.equal(runtime.registrations.filter((item) => item.kind === 'exec').length, 12);
  await assert.rejects(runtime.call('observerStatus', {}, false), /blocking:true/);
});

test('observer emits an ordered structured action event with mathematical positions and concrete deltas', async () => {
  const runtime = await setup(); await configure(runtime); await arm(runtime);
  await runtime.hit(byRole['observer.action.start']);
  runtime.setRegister('r0', 301); await runtime.hit(byRole['observer.result.calculated-damage']);
  runtime.setRegister('r0', 0x021db2a0); runtime.setRegister('r1', entityAddress); await runtime.hit(byRole['observer.result.selector']);
  await runtime.hit(byRole['observer.mutation.hp.before']);
  runtime.setWord(entityAddress, 101); await runtime.hit(byRole['observer.mutation.hp.after']);
  runtime.setDword(statusAddress + 88, 1 << 3); runtime.setByte(statusAddress + 111, 6);
  await runtime.hit(byRole['observer.mutation.defense-turn.init']);
  runtime.setRegister('r3', 0xfedcba98);
  runtime.setDword(cameraAddress, 0x12345678); await runtime.hit(byRole['observer.camera.start']);
  setSeed(runtime, lcgAdvance(0x1234n, 7n));
  runtime.setDword(cameraAddress, 0x90abcdef); await runtime.hit(byRole['observer.camera.end']);
  setSeed(runtime, lcgAdvance(0x1234n, 28n));
  await runtime.hit(byRole['observer.action.complete']);
  const result = await runtime.call('observerRead');
  const event = result.events[0];
  assert.equal(event.complete, true);
  assert.deepEqual(event.calculatedDamage, [{ order: 0, value: 301 }]);
  assert.equal(event.selectorResults.length, 1);
  assert.equal(event.hpMutations[0].delta[0].hp, -301);
  assert.equal(event.entityDelta[0].defenseStage, 1);
  assert.equal(event.entityDelta[0].remainingDefenseTurns, 6);
  assert.equal(event.rng.actionStartPosition, '0x0000000000000003');
  assert.equal(event.rng.actionEndPosition, '0x000000000000001c');
  assert.equal(event.rng.consumedSteps, '0x0000000000000019');
  assert.equal(event.rng.rngApiCallCount, 0);
  assert.deepEqual(event.cameraOccurrences, [{
    order: 0, startValue: 0x12345678, startValueHex: '0x12345678',
    parameterR3: 0xfedcba98, parameterR3Hex: '0xfedcba98',
    startSeed: `0x${lcgAdvance(0x1234n, 3n).toString(16).padStart(16, '0')}`,
    startPosition: '0x0000000000000003',
    endValue: 0x90abcdef, endValueHex: '0x90abcdef',
    endSeed: `0x${lcgAdvance(0x1234n, 7n).toString(16).padStart(16, '0')}`,
    endPosition: '0x0000000000000007', consumedSteps: '0x0000000000000004', complete: true
  }]);
});

test('State reload resets session/K/transient data without hook growth or cross-session reuse', async () => {
  const runtime = await setup(); await configure(runtime); await arm(runtime);
  await runtime.hit(byRole['observer.action.start']);
  await runtime.loadState();
  const status = await runtime.call('observerStatus');
  assert.equal(status.configured, false); assert.equal(status.sessionId, null); assert.equal(status.armed, false);
  assert.equal(runtime.registrations.filter((item) => item.kind === 'exec').length, 12);
  await assert.rejects(arm(runtime), /not configured/);
});

test('camera occurrences preserve start order, multiple pairs, and unpaired diagnostics', async () => {
  const runtime = await setup(); await configure(runtime); await arm(runtime);
  await runtime.hit(byRole['observer.action.start']);
  runtime.setDword(cameraAddress, 1); await runtime.hit(byRole['observer.camera.start']);
  runtime.setDword(cameraAddress, 2); await runtime.hit(byRole['observer.camera.end']);
  await runtime.hit(byRole['observer.camera.end']);
  runtime.setDword(cameraAddress, 3); await runtime.hit(byRole['observer.camera.start']);
  setSeed(runtime, lcgAdvance(0x1234n, 4n)); await runtime.hit(byRole['observer.action.complete']);
  const result = await runtime.call('observerRead');
  assert.deepEqual(result.events[0].cameraOccurrences, [
    {
      order: 0, startValue: 1, startValueHex: '0x00000001', parameterR3: 0, parameterR3Hex: '0x00000000',
      startSeed: `0x${lcgAdvance(0x1234n, 3n).toString(16).padStart(16, '0')}`, startPosition: '0x0000000000000003',
      endValue: 2, endValueHex: '0x00000002', endSeed: `0x${lcgAdvance(0x1234n, 3n).toString(16).padStart(16, '0')}`,
      endPosition: '0x0000000000000003', consumedSteps: '0x0000000000000000', complete: true
    },
    {
      order: 1, startValue: 3, startValueHex: '0x00000003', parameterR3: 0, parameterR3Hex: '0x00000000',
      startSeed: `0x${lcgAdvance(0x1234n, 3n).toString(16).padStart(16, '0')}`, startPosition: '0x0000000000000003',
      endValue: null, endValueHex: null, endSeed: null, endPosition: null, consumedSteps: null, complete: false
    }
  ]);
  assert.deepEqual(result.violations.map((item) => item.code), ['camera-end-without-start', 'camera-start-without-end']);
});

test('camera limits fail boundedly and callback errors resume without hook growth', async () => {
  const runtime = await setup(); await configure(runtime); await arm(runtime);
  await runtime.hit(byRole['observer.action.start']);
  for (let index = 0; index < 64; index += 1) {
    runtime.setDword(cameraAddress, index); await runtime.hit(byRole['observer.camera.start']);
    runtime.setDword(cameraAddress, index + 1); await runtime.hit(byRole['observer.camera.end']);
  }
  await runtime.hit(byRole['observer.camera.start']);
  let result = await runtime.call('observerStatus');
  assert.equal(result.overflow, true);
  assert.equal(result.violations.at(-1).code, 'camera-occurrence-limit');

  const originalRead = runtime.memory.readdword;
  runtime.memory.readdword = async (address) => { if (address === cameraAddress) throw new Error('camera read failed'); return originalRead(address); };
  await runtime.call('observerReset', { keepSession: true }); await arm(runtime, 'action-2');
  await runtime.hit(byRole['observer.action.start']); await runtime.hit(byRole['observer.camera.start']);
  assert.equal(runtime.resumeCount, 1);
  result = await runtime.call('observerStatus');
  assert.equal(result.violations.at(-1).code, 'callback-error');
  runtime.memory.readdword = originalRead;
  await runtime.call('observerReset'); await configure(runtime, 'session-2');
  assert.equal(runtime.registrations.filter((item) => item.kind === 'exec').length, 12);
});
