import { access, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseJson, isPlainObject } from '../util/json.mjs';
import { RelayError } from '../util/errors.mjs';

const requiredPaths = ['chromePath', 'romPath', 'statePath'];
const scriptRoles = ['command', 'observer', 'incident'];

const existsFile = async (path, label, fs = { access, stat }) => {
  try {
    await fs.access(path);
    const details = await fs.stat(path);
    if (!details.isFile()) throw new Error('not a file');
  } catch {
    throw new RelayError('CONFIG_PATH_INVALID', `${label} is not a readable file`, { path });
  }
};

export async function validateConfig(config, { fs } = {}) {
  if (!isPlainObject(config)) throw new RelayError('INVALID_CONFIG', 'Configuration must be a JSON object');
  for (const key of requiredPaths) {
    if (typeof config[key] !== 'string' || config[key].trim() === '') {
      throw new RelayError('INVALID_CONFIG', `${key} must be a non-empty path`);
    }
  }
  if (!isPlainObject(config.scriptPaths)) throw new RelayError('INVALID_CONFIG', 'scriptPaths must contain command, observer, and incident paths');
  for (const role of scriptRoles) if (typeof config.scriptPaths[role] !== 'string' || !config.scriptPaths[role].trim()) throw new RelayError('INVALID_CONFIG', `scriptPaths.${role} must be a non-empty path`);
  if (typeof config.profilePath !== 'string' || !config.profilePath.trim()) throw new RelayError('INVALID_CONFIG', 'profilePath must be a non-empty path');
  if (typeof config.url !== 'string' || !/^https?:\/\//.test(config.url)) {
    throw new RelayError('INVALID_CONFIG', 'url must be an http or https URL');
  }
  if (!Number.isInteger(config.cdpPort) || config.cdpPort < 1024 || config.cdpPort > 65535) {
    throw new RelayError('INVALID_CONFIG', 'cdpPort must be an integer between 1024 and 65535');
  }
  if (typeof config.runtimeDirectory !== 'string' || config.runtimeDirectory.trim() === '') {
    throw new RelayError('INVALID_CONFIG', 'runtimeDirectory must be a non-empty path');
  }
  const fileSystem = fs ?? { access, stat };
  for (const key of requiredPaths) await existsFile(config[key], key, fileSystem);
  for (const role of scriptRoles) await existsFile(config.scriptPaths[role], `scriptPaths.${role}`, fileSystem);
  await existsFile(config.profilePath, 'profilePath', fileSystem);
  return Object.freeze({ ...config, runtimeDirectory: resolve(config.runtimeDirectory) });
}

export async function loadConfig(configPath, { fs, readFile } = {}) {
  const reader = readFile ?? (await import('node:fs/promises')).readFile;
  let text;
  try {
    text = await reader(configPath, 'utf8');
  } catch {
    throw new RelayError('CONFIG_NOT_FOUND', 'Local runtime configuration is not readable', { path: String(configPath) });
  }
  return validateConfig(parseJson(text, 'Local runtime configuration'), { fs });
}
