import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { scanGitMetadataPolicy } from '../app/git-metadata-policy.mjs';

test('Git metadata scanner finds existing nested repositories and keeps executable/config metadata read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-git-metadata-'));
  const repository = join(root, 'nested', 'repo');
  const git = join(repository, '.git');
  await mkdir(join(git, 'objects'), { recursive: true });
  await writeFile(join(git, 'config'), '[core]\nrepositoryformatversion = 0\n', 'utf8');

  const policy = await scanGitMetadataPolicy([root]);
  assert.deepEqual(policy.writableDirectories, [resolve(git)]);
  assert.ok(policy.deniedDirectories.includes(resolve(git, 'hooks')));
  assert.ok(policy.deniedDirectories.includes(resolve(git, 'objects', 'info')));
  assert.ok(policy.deniedDirectories.includes(resolve(git, 'modules')));
  assert.ok(policy.deniedFiles.includes(resolve(git, 'config')));
  assert.equal(policy.deniedFiles.includes(resolve(git, 'config.worktree')), false);
  assert.equal(policy.deniedFiles.includes(resolve(git, 'commondir')), false);
  assert.equal(policy.deniedFiles.includes(resolve(git, 'gitdir')), false);
  assert.equal(policy.truncated, false);
});

test('Git metadata scanner resolves an existing in-scope gitdir pointer but never authorizes an out-of-scope target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-git-pointer-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'gateway-git-pointer-outside-'));
  const commonGit = join(root, 'main', '.git');
  const worktreeGit = join(commonGit, 'worktrees', 'feature');
  const worktree = join(root, 'feature');
  const externalWorktree = join(root, 'external-feature');
  await mkdir(worktreeGit, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await mkdir(externalWorktree, { recursive: true });
  await writeFile(join(worktree, '.git'), 'gitdir: ../main/.git/worktrees/feature\n', 'utf8');
  await writeFile(join(externalWorktree, '.git'), `gitdir: ${outside}\n`, 'utf8');

  const policy = await scanGitMetadataPolicy([root]);
  assert.ok(policy.writableDirectories.includes(resolve(commonGit)));
  assert.ok(policy.writableDirectories.includes(resolve(worktreeGit)));
  assert.equal(policy.writableDirectories.includes(resolve(outside)), false);
  assert.equal(policy.skippedGitPointers, 1);
});

test('Git metadata scanner does not predict metadata for git init or clone after startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-git-empty-'));
  await mkdir(join(root, 'future-repository'));
  const policy = await scanGitMetadataPolicy([root]);
  assert.deepEqual(policy.writableDirectories, []);
  assert.deepEqual(policy.deniedDirectories, []);
  assert.deepEqual(policy.deniedFiles, []);
});
