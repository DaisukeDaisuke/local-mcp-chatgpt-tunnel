import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RelayError } from '../util/errors.mjs';

const MAX_SUITE_BYTES = 2 * 1024 * 1024;
const BLOCKED_COMPONENTS = new Set([
  '.aws', '.azure', '.codex', '.docker', '.git', '.gnupg', '.kube', '.secrets', '.ssh',
  'credentials', 'secrets'
]);
const BLOCKED_NAMES = new Set([
  '.git-credentials', '.netrc', '.npmrc', '.pypirc', 'authorized_keys', 'credentials.json',
  'id_dsa', 'id_ecdsa', 'id_ed25519', 'id_rsa', 'known_hosts', 'passwords.txt',
  'secrets.json', 'tokens.json'
]);
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{25,}\b/
];

const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);

function blockedName(name) {
  const lower = name.toLowerCase();
  if (BLOCKED_COMPONENTS.has(lower) || BLOCKED_NAMES.has(lower)) return true;
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  return /^(?:passwords?|credentials?|secrets?|tokens?|cookies?)(?:\.|$)/i.test(lower);
}

function decodeUtf8(bytes) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new RelayError('SUITE_ENCODING_UNSUPPORTED', 'Suite must be UTF-8, not UTF-16');
  }
  if ((bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
      || (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00)) {
    throw new RelayError('SUITE_ENCODING_UNSUPPORTED', 'Suite must be UTF-8, not UTF-32');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    throw new RelayError('SUITE_ENCODING_UNSUPPORTED', 'Suite is not valid UTF-8');
  }
}

async function validatedRoots(configuredRoots) {
  if (!Array.isArray(configuredRoots) || configuredRoots.length === 0) {
    throw new RelayError('SUITE_ROOTS_NOT_CONFIGURED', 'No workspace roots are configured for battle suites');
  }
  return Promise.all(configuredRoots.map(async (root) => {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new RelayError('SUITE_ROOT_INVALID', 'Suite workspace roots must be absolute paths');
    const actual = await realpath(root).catch(() => { throw new RelayError('SUITE_ROOT_INVALID', 'Suite workspace root is not readable', { root }); });
    const home = resolve(homedir());
    if (within(actual, home)) throw new RelayError('SUITE_ROOT_INVALID', 'Suite workspace root may not be a user profile or its ancestor', { root: actual });
    if (actual.split(/[\\/]+/).some((part) => blockedName(part))) throw new RelayError('SUITE_ROOT_INVALID', 'Suite workspace root contains a credential-like component', { root: actual });
    return actual;
  }));
}

export async function loadAllowedSuiteFile(path, { roots } = {}) {
  if (typeof path !== 'string' || !path || path.includes('\0')) throw new RelayError('INVALID_SUITE_PATH', 'suitePath must be a valid local JSON path');
  const allowedRoots = await validatedRoots(roots);
  const candidate = resolve(isAbsolute(path) ? path : join(allowedRoots[0], path));
  const selectedRoot = allowedRoots.find((root) => within(root, candidate));
  if (!selectedRoot) throw new RelayError('SUITE_PATH_OUTSIDE_WORKSPACE', 'Suite path is outside all configured workspace roots');
  const actual = await realpath(candidate).catch(() => { throw new RelayError('SUITE_NOT_FOUND', 'Suite file is not readable', { path: candidate }); });
  if (!within(selectedRoot, actual)) throw new RelayError('SUITE_PATH_OUTSIDE_WORKSPACE', 'Resolved suite path escaped the configured workspace root');
  const relativePath = relative(selectedRoot, actual);
  if (relativePath.split(/[\\/]+/).some((part) => blockedName(part))) throw new RelayError('SUITE_PATH_BLOCKED', 'Credential-like suite paths are not accessible');
  if (extname(actual).toLowerCase() !== '.json') throw new RelayError('INVALID_SUITE_PATH', 'Battle suite must be a .json file');
  const info = await stat(actual);
  if (!info.isFile()) throw new RelayError('INVALID_SUITE_PATH', 'Battle suite path is not a regular file');
  if (info.size > MAX_SUITE_BYTES) throw new RelayError('SUITE_TOO_LARGE', `Battle suite exceeds ${MAX_SUITE_BYTES} bytes`);
  const text = decodeUtf8(await readFile(actual));
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) throw new RelayError('SUITE_CREDENTIAL_DETECTED', 'Battle suite resembles a credential or private key and was not read');
  return { path: actual, text };
}
