import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { RelayError } from '../util/errors.mjs';
import { isPlainObject, parseJson } from '../util/json.mjs';

const execFileAsync = promisify(execFile);
const manifestVersion = 'dq9-test-local-dependencies-v1';
const sha256 = async (path, readFileImpl = readFile) => createHash('sha256').update(await readFileImpl(path)).digest('hex');

const invalid = (message) => { throw new RelayError('DEPENDENCY_MANIFEST_INVALID', message); };
const requireAbsolute = (value, label) => {
  if (typeof value !== 'string' || !isAbsolute(value)) invalid(`${label} must be an absolute local path`);
  return value;
};
const requireSha256 = (value, label) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(`${label} must be a lowercase SHA-256`);
  return value;
};

export const validateManifestShape = (manifest) => {
  if (!isPlainObject(manifest) || manifest.schemaVersion !== manifestVersion || !Array.isArray(manifest.repositories) || !Array.isArray(manifest.files)) {
    invalid(`Manifest must contain schemaVersion ${manifestVersion}, repositories, and files`);
  }
  for (const dependency of manifest.repositories) {
    if (!isPlainObject(dependency) || typeof dependency.name !== 'string' || !dependency.name || typeof dependency.expectedRevision !== 'string' || !/^[a-f0-9]{40}$/.test(dependency.expectedRevision)) invalid('Each repository must name a 40-character expectedRevision');
    requireAbsolute(dependency.path, `${dependency.name}.path`);
    if (dependency.requireClean !== true) invalid(`${dependency.name}.requireClean must be true`);
  }
  for (const file of manifest.files) {
    if (!isPlainObject(file) || typeof file.name !== 'string' || !file.name) invalid('Each file must have a name');
    requireAbsolute(file.path, `${file.name}.path`);
    requireSha256(file.sha256, `${file.name}.sha256`);
  }
  return manifest;
};

const gitIdentity = async (repositoryPath) => {
  const common = ['-c', `safe.directory=${repositoryPath}`, '-C', repositoryPath];
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync('git', [...common, 'rev-parse', 'HEAD']),
    execFileAsync('git', [...common, 'status', '--porcelain'])
  ]);
  return { revision: revision.trim(), clean: status.trim() === '' };
};

export const validateLocalDependencies = async (manifest, { getGitIdentity = gitIdentity, hashFile = sha256 } = {}) => {
  validateManifestShape(manifest);
  const checks = [];
  for (const repository of manifest.repositories) {
    let actual;
    try { actual = await getGitIdentity(repository.path); }
    catch (error) { throw new RelayError('DEPENDENCY_REPOSITORY_UNAVAILABLE', `${repository.name} identity could not be read`, { name: repository.name, cause: error instanceof Error ? error.message : String(error) }); }
    if (actual.revision !== repository.expectedRevision || !actual.clean) {
      throw new RelayError('DEPENDENCY_REVISION_MISMATCH', `${repository.name} does not match its pinned clean revision`, { name: repository.name });
    }
    checks.push({ name: repository.name, kind: 'repository', revision: actual.revision });
  }
  for (const file of manifest.files) {
    let actual;
    try { actual = await hashFile(file.path); }
    catch (error) { throw new RelayError('DEPENDENCY_FILE_UNAVAILABLE', `${file.name} hash could not be read`, { name: file.name, cause: error instanceof Error ? error.message : String(error) }); }
    if (actual !== file.sha256) throw new RelayError('DEPENDENCY_HASH_MISMATCH', `${file.name} does not match its pinned SHA-256`, { name: file.name });
    checks.push({ name: file.name, kind: 'file', sha256: actual });
  }
  return Object.freeze({ schemaVersion: manifestVersion, valid: true, checks: Object.freeze(checks) });
};

export const loadAndValidateLocalDependencies = async (manifestPath, { readFileImpl = readFile, ...options } = {}) => {
  let text;
  try { text = await readFileImpl(resolve(manifestPath), 'utf8'); }
  catch { throw new RelayError('DEPENDENCY_MANIFEST_NOT_FOUND', 'Local dependency manifest is not readable', { path: String(manifestPath) }); }
  return validateLocalDependencies(parseJson(text, 'Local dependency manifest'), options);
};

export { manifestVersion };
