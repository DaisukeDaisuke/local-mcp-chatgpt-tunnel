import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBattleRuntimeProfile, persistentProfilePayload, validateBattleRuntimeProfile } from '../src/runtime/battle-runtime-profile.mjs';

test('versioned production profile validates identity, provenance, hooks, and full RNG contract', async () => {
  const profile = await loadBattleRuntimeProfile();
  assert.equal(profile.profileId, 'dq9-new2-stage1-runtime-v1');
  assert.equal(profile.provenance.frozenMeaning, true);
  assert.equal(profile.rng.initialSeedBits, 48);
  assert.equal(profile.rng.longJump.algorithm, 'binary-exponentiation-from-identity-(1,0)');
  assert.equal(persistentProfilePayload(profile).hooks.length, 16);
  assert.deepEqual(profile.memory.cameraObservable, {
    address: '0x0238fbb0', length: 4,
    provenance: 'Human-confirmed Stage 3 free-camera observable contract',
    entryParameter: {
      register: 'r3', width: 4, signedness: 'unsigned',
      provenance: 'Human-confirmed camera entry register contract'
    }
  });
  assert.equal(profile.hooks.find((hook) => hook.role === 'observer.camera.start').address, '0x0216fda4');
  assert.equal(profile.hooks.find((hook) => hook.role === 'observer.camera.end').address, '0x02170120');
});

test('profile validation fails closed for arithmetic and coverage drift', async () => {
  const profile = structuredClone(await loadBattleRuntimeProfile());
  profile.rng.multiplier = '0x0000000000000001';
  assert.throws(() => validateBattleRuntimeProfile(profile), { code: 'RUNTIME_PROFILE_INVALID' });
  const coverage = structuredClone(await loadBattleRuntimeProfile());
  coverage.rng.recovery.maxBackwardSteps = coverage.rng.recovery.battleMaxSteps - 1;
  assert.throws(() => validateBattleRuntimeProfile(coverage), { code: 'RUNTIME_PROFILE_INVALID' });
  const camera = structuredClone(await loadBattleRuntimeProfile());
  camera.memory.cameraObservable.length = 8;
  assert.throws(() => validateBattleRuntimeProfile(camera), { code: 'RUNTIME_PROFILE_INVALID' });
  const cameraParameter = structuredClone(await loadBattleRuntimeProfile());
  cameraParameter.memory.cameraObservable.entryParameter.register = 'sp';
  assert.throws(() => validateBattleRuntimeProfile(cameraParameter), { code: 'RUNTIME_PROFILE_INVALID' });
});
