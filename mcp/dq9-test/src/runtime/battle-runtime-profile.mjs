import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { INCREMENT, INVERSE_MULTIPLIER, MULTIPLIER, parseHex64 } from './rng-lcg.mjs';
import { RelayError } from '../util/errors.mjs';

export const defaultBattleRuntimeProfilePath = fileURLToPath(new URL('../../profiles/battle-runtime-profile-v1.json', import.meta.url));

const address = (value, label) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{8}$/.test(value)) throw new RelayError('RUNTIME_PROFILE_INVALID', `${label} must be a lowercase 32-bit hex address`);
  return Number.parseInt(value.slice(2), 16);
};

export const validateBattleRuntimeProfile = (profile) => {
  if (!profile || profile.schema !== 'dq9.battle-runtime-profile' || profile.version !== 1 || typeof profile.profileId !== 'string') {
    throw new RelayError('RUNTIME_PROFILE_INVALID', 'Unsupported battle runtime profile identity');
  }
  if (profile.game?.romName !== 'dq9_new2.nds' || profile.game?.romSize !== 268435456 || profile.provenance?.frozenMeaning !== true) {
    throw new RelayError('RUNTIME_PROFILE_INVALID', 'Game/build identity or provenance is invalid');
  }
  if (profile.rng?.modulusBits !== 64 || profile.rng?.initialSeedBits !== 48 || profile.rng?.initialSeedUpperZeroBits !== 16 ||
      parseHex64(profile.rng.multiplier) !== MULTIPLIER || parseHex64(profile.rng.increment) !== INCREMENT ||
      parseHex64(profile.rng.inverseMultiplier) !== INVERSE_MULTIPLIER) {
    throw new RelayError('RUNTIME_PROFILE_INVALID', 'RNG arithmetic contract does not match DQ9');
  }
  if (!Number.isSafeInteger(profile.rng.recovery?.maxBackwardSteps) ||
      profile.rng.recovery.maxBackwardSteps < profile.rng.recovery.battleMaxSteps ||
      typeof profile.rng.recovery.coverageBasis !== 'string' || !profile.rng.recovery.coverageBasis) {
    throw new RelayError('RUNTIME_PROFILE_INVALID', 'RNG recovery coverage is not established');
  }
  const roles = new Map();
  for (const hook of profile.hooks ?? []) {
    address(hook.address, `hook ${hook.id}`);
    if (!hook.id || hook.kind !== 'exec' || hook.mode !== 'blocking' || !hook.role || !Array.isArray(hook.capture)) {
      throw new RelayError('RUNTIME_PROFILE_INVALID', `Invalid hook contract: ${hook?.id ?? 'unknown'}`);
    }
    if (roles.has(hook.role)) throw new RelayError('RUNTIME_PROFILE_INVALID', `Duplicate hook role: ${hook.role}`);
    roles.set(hook.role, hook);
  }
  const requiredRoles = ['observer.action.start', 'observer.action.complete', 'observer.result.calculated-damage', 'observer.result.selector', 'observer.mutation.hp.before', 'observer.mutation.hp.after', 'observer.camera.start', 'observer.camera.end', 'incident.group.start', 'incident.group.end'];
  for (const role of requiredRoles) if (!roles.has(role)) throw new RelayError('RUNTIME_PROFILE_INVALID', `Missing hook role: ${role}`);
  for (const api of profile.diagnosticRngApis ?? []) { address(api.entry, `${api.id}.entry`); address(api.exit, `${api.id}.exit`); }
  address(profile.rng.seedLowAddress, 'rng.seedLowAddress');
  address(profile.memory.actorTableAddress, 'memory.actorTableAddress');
  address(profile.memory.battleScreen?.address, 'memory.battleScreen.address');
  if (profile.memory.battleScreen?.length !== 8) throw new RelayError('RUNTIME_PROFILE_INVALID', 'Battle screen gate must cover exactly 8 bytes');
  address(profile.memory.cameraObservable?.address, 'memory.cameraObservable.address');
  const cameraParameter = profile.memory.cameraObservable?.entryParameter;
  if (profile.memory.cameraObservable?.length !== 4 || typeof profile.memory.cameraObservable?.provenance !== 'string' || !profile.memory.cameraObservable.provenance ||
      cameraParameter?.register !== 'r3' || cameraParameter?.width !== 4 || cameraParameter?.signedness !== 'unsigned' || typeof cameraParameter?.provenance !== 'string' || !cameraParameter.provenance) {
    throw new RelayError('RUNTIME_PROFILE_INVALID', 'Camera observable must be a provenance-backed 4-byte field');
  }
  return Object.freeze(profile);
};

export const loadBattleRuntimeProfile = async (path = defaultBattleRuntimeProfilePath, { readFileImpl = readFile } = {}) => {
  let profile;
  try { profile = JSON.parse(await readFileImpl(path, 'utf8')); }
  catch (error) { throw new RelayError('RUNTIME_PROFILE_INVALID', 'Battle runtime profile is unreadable', { cause: String(error) }); }
  return validateBattleRuntimeProfile(profile);
};

export const persistentProfilePayload = (profile) => ({
  schema: profile.schema,
  version: profile.version,
  profileId: profile.profileId,
  rng: profile.rng,
  memory: profile.memory,
  hooks: profile.hooks,
  diagnosticRngApis: profile.diagnosticRngApis
});
