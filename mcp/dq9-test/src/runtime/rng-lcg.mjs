export const MASK64 = (1n << 64n) - 1n;
export const MULTIPLIER = 0x5d588b656c078965n;
export const INCREMENT = 0x269ec3n;
export const INVERSE_MULTIPLIER = 0xdedcedae9638806dn;
export const IDENTITY_TRANSFORM = Object.freeze({ mul: 1n, add: 0n });
export const FORWARD_TRANSFORM = Object.freeze({ mul: MULTIPLIER, add: INCREMENT });
export const INVERSE_TRANSFORM = Object.freeze({
  mul: INVERSE_MULTIPLIER,
  add: (-INCREMENT * INVERSE_MULTIPLIER) & MASK64
});

const u64 = (value, label = 'value') => {
  if (typeof value !== 'bigint' || value < 0n || value > MASK64) throw new TypeError(`${label} must be a uint64 BigInt`);
  return value;
};

export const hex64 = (value) => `0x${u64(value).toString(16).padStart(16, '0')}`;
export const parseHex64 = (value, label = 'value') => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{16}$/.test(value)) throw new TypeError(`${label} must be fixed-length 64-bit hex`);
  return BigInt(value);
};

// P followed by Q: Q o P.
export const composeAffine = (p, q) => ({
  mul: (q.mul * p.mul) & MASK64,
  add: (q.mul * p.add + q.add) & MASK64
});

export const affinePower = (transform, delta) => {
  u64(delta, 'delta');
  let result = IDENTITY_TRANSFORM;
  let power = { mul: u64(transform.mul, 'transform.mul'), add: u64(transform.add, 'transform.add') };
  let remaining = delta;
  while (remaining !== 0n) {
    if ((remaining & 1n) !== 0n) result = composeAffine(result, power);
    power = composeAffine(power, power);
    remaining >>= 1n;
  }
  return result;
};

export const applyAffine = (seed, transform) => (u64(transform.mul) * u64(seed, 'seed') + u64(transform.add)) & MASK64;
export const lcgNext = (seed) => applyAffine(seed, FORWARD_TRANSFORM);
export const lcgPrevious = (seed) => applyAffine(seed, INVERSE_TRANSFORM);
export const lcgAdvance = (seed, delta) => applyAffine(seed, affinePower(FORWARD_TRANSFORM, delta));
export const lcgRewind = (seed, delta) => applyAffine(seed, affinePower(INVERSE_TRANSFORM, delta));

export const lcgPowerTable = (transform = FORWARD_TRANSFORM) => {
  const powers = [];
  let power = transform;
  for (let bit = 0; bit < 64; bit += 1) {
    powers.push(Object.freeze(power));
    power = composeAffine(power, power);
  }
  return Object.freeze(powers);
};

const POSITION_POWERS = lcgPowerTable();

// Full-period LCG: T^(2^bit) toggles the next unresolved low bit.
export const lcgFindPosition = (initialSeed, currentSeed) => {
  const target = u64(currentSeed, 'currentSeed');
  let current = u64(initialSeed, 'initialSeed');
  let position = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    const mask = bit === 63 ? MASK64 : (1n << BigInt(bit + 1)) - 1n;
    if ((current & mask) !== (target & mask)) {
      current = applyAffine(current, POSITION_POWERS[bit]);
      position |= 1n << BigInt(bit);
    }
  }
  if (current !== target) throw new Error('LCG position recovery failed');
  return position;
};

export const positionDifference = (start, end) => (u64(end, 'end') - u64(start, 'start')) & MASK64;

export const recoverInitialSeed = (currentSeed, {
  maxBackwardSteps,
  battleMaxSteps,
  coverageBasis,
  initialSeedBits = 48
} = {}) => {
  u64(currentSeed, 'currentSeed');
  if (!Number.isSafeInteger(maxBackwardSteps) || maxBackwardSteps < 0) throw new TypeError('maxBackwardSteps must be a non-negative safe integer');
  if (!Number.isSafeInteger(battleMaxSteps) || battleMaxSteps < 0 || typeof coverageBasis !== 'string' || !coverageBasis) {
    throw new TypeError('battleMaxSteps and coverageBasis are required');
  }
  const coverageEstablished = maxBackwardSteps >= battleMaxSteps;
  if (!Number.isInteger(initialSeedBits) || initialSeedBits < 1 || initialSeedBits > 64) throw new TypeError('initialSeedBits must be in [1,64]');
  const upperMask = initialSeedBits === 64 ? 0n : MASK64 ^ ((1n << BigInt(initialSeedBits)) - 1n);
  const candidates = [];
  let seed = currentSeed;
  for (let distance = 0; distance <= maxBackwardSteps; distance += 1) {
    if ((seed & upperMask) === 0n) candidates.push({ seed: hex64(seed), distance: hex64(BigInt(distance)) });
    seed = lcgPrevious(seed);
  }
  let status = candidates.length === 1 ? 'recovered' : candidates.length === 0 ? 'not_found' : 'ambiguous';
  if (!coverageEstablished && candidates.length === 0) status = 'insufficient_range';
  return Object.freeze({
    initialSeedStatus: status,
    initialSeedK: status === 'recovered' ? candidates[0].seed : null,
    initialSeedCandidateCount: candidates.length,
    initialSeedCandidates: candidates,
    maxBackwardSteps,
    battleMaxSteps,
    coverageBasis,
    coverageEstablished,
    currentPosition: status === 'recovered' ? candidates[0].distance : null
  });
};
