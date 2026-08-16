import { createHmac, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, relative, sep } from 'node:path';

export const BUNDLED_ISOLATION_ARGUMENT = '__localMcpIsolation';
export const BUNDLED_ISOLATION_KEY_ENV = 'LOCAL_MCP_GATEWAY_ISOLATION_KEY';
const ENVELOPE_VERSION = 1;

const ROOT_LIKE_KEY = /(?:^|_)(?:root|roots|workspace|workspaces)(?:$|_)/i;

function normalizedKey(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

export function assertNoPublicRootOverride(value, path = 'arguments') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertNoPublicRootOverride(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizedKey(key);
    if (key === BUNDLED_ISOLATION_ARGUMENT || ROOT_LIKE_KEY.test(normalized)) {
      throw new Error(`${path}.${key} is reserved; workspace roots are controlled only by isolated__create`);
    }
    assertNoPublicRootOverride(child, `${path}.${key}`);
  }
}

function canonicalPayload({ isolatedId, base, roots }) {
  return JSON.stringify(isolatedId === undefined ? { base, roots } : { isolatedId, base, roots });
}

export function signBundledIsolationContext(key, context) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('Gateway isolation key is unavailable or too short');
  return createHmac('sha256', key).update(canonicalPayload(context), 'utf8').digest('hex');
}

export function environmentWithoutBundledIsolationKey(source = process.env) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === BUNDLED_ISOLATION_KEY_ENV) delete environment[name];
  }
  return environment;
}

function validSignature(signature, expected) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function validateEnvelope(value, expectedKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Missing private Gateway isolation context');
  }
  const keys = Object.keys(value).sort();
  const keyList = keys.join(',');
  if (keyList !== 'base,roots,signature,version' && keyList !== 'base,isolatedId,roots,signature,version') {
    throw new Error('Invalid private Gateway isolation context');
  }
  if (value.version !== ENVELOPE_VERSION) throw new Error('Unsupported private Gateway isolation context version');
  if (!Array.isArray(value.roots) || value.roots.length < 1
      || value.roots.some((root) => typeof root !== 'string' || root.length === 0 || !isAbsolute(root))) {
    throw new Error('Private Gateway isolation roots must be a non-empty absolute-path array');
  }
  if (typeof value.base !== 'string' || value.base.length === 0 || !isAbsolute(value.base)) {
    throw new Error('Private Gateway isolation base must be an absolute path');
  }
  if (!value.roots.some((root) => within(root, value.base))) throw new Error('Private Gateway isolation base is outside its roots');
  if (value.isolatedId !== undefined && (typeof value.isolatedId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.isolatedId))) {
    throw new Error('Private Gateway isolation id is invalid');
  }
  const context = value.isolatedId === undefined
    ? { roots: [...value.roots], base: value.base }
    : { isolatedId: value.isolatedId, roots: [...value.roots], base: value.base };
  const expectedSignature = signBundledIsolationContext(expectedKey, context);
  if (!validSignature(value.signature, expectedSignature)) throw new Error('Invalid private Gateway isolation signature');
  return context;
}

export function createBundledIsolation({ key = process.env[BUNDLED_ISOLATION_KEY_ENV] } = {}) {
  const storage = new AsyncLocalStorage();
  const expectedKey = key;

  return {
    enabled: typeof expectedKey === 'string' && expectedKey.length >= 32,
    current: () => storage.getStore() ?? null,
    async run(argumentsValue, operation) {
      if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
        throw new Error('Tool arguments must be an object');
      }
      if (!expectedKey) {
        if (Object.hasOwn(argumentsValue, BUNDLED_ISOLATION_ARGUMENT)) {
          throw new Error('Private Gateway isolation context is unavailable outside the Gateway');
        }
        assertNoPublicRootOverride(argumentsValue);
        return operation(argumentsValue);
      }
      const context = validateEnvelope(argumentsValue[BUNDLED_ISOLATION_ARGUMENT], expectedKey);
      const publicArguments = { ...argumentsValue };
      delete publicArguments[BUNDLED_ISOLATION_ARGUMENT];
      assertNoPublicRootOverride(publicArguments);
      return storage.run(context, () => operation(publicArguments));
    }
  };
}
