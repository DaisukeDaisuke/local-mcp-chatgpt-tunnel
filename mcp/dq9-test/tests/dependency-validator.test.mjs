import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLocalDependencies, validateManifestShape } from '../src/services/dependency-validator.mjs';

const manifest = {
  schemaVersion: 'dq9-test-local-dependencies-v1',
  repositories: [{ name: 'BattleEmulator', path: 'C:\\deps\\BattleEmulator', expectedRevision: 'a'.repeat(40), requireClean: true }],
  files: [{ name: 'api', path: 'C:\\deps\\API_CURRENT.md', sha256: 'b'.repeat(64) }]
};
const validOptions = { getGitIdentity: async () => ({ revision: 'a'.repeat(40), clean: true }), hashFile: async () => 'b'.repeat(64) };

test('dependency manifest validates a pinned clean local sibling revision and static hash', async () => {
  const result = await validateLocalDependencies(manifest, validOptions);
  assert.equal(result.valid, true);
  assert.equal(result.checks.length, 2);
});

test('dependency validator fails closed on malformed paths, revision mismatch, and hash mismatch', async () => {
  assert.throws(() => validateManifestShape({ ...manifest, repositories: [{ ...manifest.repositories[0], path: 'relative' }] }), { code: 'DEPENDENCY_MANIFEST_INVALID' });
  await assert.rejects(validateLocalDependencies(manifest, { ...validOptions, getGitIdentity: async () => ({ revision: 'c'.repeat(40), clean: true }) }), { code: 'DEPENDENCY_REVISION_MISMATCH' });
  await assert.rejects(validateLocalDependencies(manifest, { ...validOptions, hashFile: async () => 'd'.repeat(64) }), { code: 'DEPENDENCY_HASH_MISMATCH' });
});
