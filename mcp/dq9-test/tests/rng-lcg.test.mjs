import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MASK64, MULTIPLIER, INCREMENT, INVERSE_MULTIPLIER, FORWARD_TRANSFORM, INVERSE_TRANSFORM,
  composeAffine, affinePower, applyAffine, hex64, lcgNext, lcgPrevious, lcgAdvance, lcgRewind,
  lcgFindPosition, positionDifference, recoverInitialSeed
} from '../src/runtime/rng-lcg.mjs';

test('forward vector, modular inverse, and backward round trip are exact uint64 BigInt arithmetic', () => {
  assert.equal((MULTIPLIER * INVERSE_MULTIPLIER) & MASK64, 1n);
  assert.equal(lcgNext(0n), INCREMENT);
  assert.equal(hex64(lcgNext(0xffffffffffffffffn)), '0xa2a7749a941f155e');
  for (const seed of [0n, 1n, 0x0000fedcba987654n, MASK64]) assert.equal(lcgPrevious(lcgNext(seed)), seed);
});

test('affine composition order and binary exponentiation match naive small deltas', () => {
  const seed = 0x0000123456789abcn;
  let naive = seed;
  for (let delta = 0n; delta < 128n; delta += 1n) {
    assert.equal(lcgAdvance(seed, delta), naive);
    naive = lcgNext(naive);
  }
  const twice = composeAffine(FORWARD_TRANSFORM, FORWARD_TRANSFORM);
  assert.equal(applyAffine(seed, twice), lcgNext(lcgNext(seed)));
  assert.equal(applyAffine(seed, affinePower(FORWARD_TRANSFORM, 0xffffffffffffffffn)), lcgAdvance(seed, 0xffffffffffffffffn));
});

test('inverse long jump returns to the initial seed for known and huge distances', () => {
  const seed = 0x0000abcdef123456n;
  for (const distance of [0n, 1n, 25n, 0x123456789abcdef0n]) {
    const advanced = lcgAdvance(seed, distance);
    assert.equal(lcgRewind(advanced, distance), seed);
    assert.equal(applyAffine(advanced, affinePower(INVERSE_TRANSFORM, distance)), seed);
  }
});

test('64 low-bit decisions recover mathematical position and its action difference', () => {
  for (const [seed, delta] of [[0x1234n, 0n], [0x0000123456789abcn, 25n], [0x0000fedcba987654n, 0xfedcba9876543210n]]) {
    const current = lcgAdvance(seed, delta);
    assert.equal(lcgFindPosition(seed, current), delta);
  }
  assert.equal(positionDifference(0xfffffffffffffff0n, 0x10n), 0x20n);
});

test('upper-zero resolution uses candidate count only and distinguishes insufficient coverage', () => {
  const one = recoverInitialSeed(lcgAdvance(0x1234n, 5n), { maxBackwardSteps: 5, battleMaxSteps: 5, coverageBasis: 'fixture', initialSeedBits: 16 });
  assert.equal(one.initialSeedStatus, 'recovered');
  assert.equal(one.initialSeedCandidateCount, 1);
  assert.equal(one.initialSeedK, hex64(0x1234n));
  const none = recoverInitialSeed(0xffffffffffffffffn, { maxBackwardSteps: 0, battleMaxSteps: 0, coverageBasis: 'fixture', initialSeedBits: 16 });
  assert.equal(none.initialSeedStatus, 'not_found');
  const insufficient = recoverInitialSeed(0xffffffffffffffffn, { maxBackwardSteps: 0, battleMaxSteps: 1, coverageBasis: 'fixture', initialSeedBits: 16 });
  assert.equal(insufficient.initialSeedStatus, 'insufficient_range');
  const multiple = recoverInitialSeed(0n, { maxBackwardSteps: 8, battleMaxSteps: 8, coverageBasis: 'fixture', initialSeedBits: 64 });
  assert.equal(multiple.initialSeedStatus, 'ambiguous');
  assert.equal(multiple.initialSeedCandidateCount, 9);
});

test('JSON precision keeps maximum seed and position as fixed hex strings, never Number', () => {
  const encoded = JSON.parse(JSON.stringify({ seed: hex64(MASK64), position: hex64(MASK64) }));
  assert.deepEqual(encoded, { seed: '0xffffffffffffffff', position: '0xffffffffffffffff' });
  assert.equal(typeof encoded.seed, 'string');
});
