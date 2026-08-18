import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanGitMetadataPolicy } from '../app/git-metadata-policy.mjs';

test('Git metadata scanner finds existing nested repositories and keeps executable/config metadata read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-git-metadata-'));
  const repository = join(root, 'nested', 'repo');
  const git = join(repository, '.git');
  await mkdir(join(git, 'objects'), { recursive: true });
  await writeFile(join(git, 'config'), '[core]\nrepositoryformatversion = 0\n', 'utf8');

  const policy = await scanGitMetadataPolicy([root]);
  const canonicalGit = await realpath(git);
  assert.deepEqual(policy.writableDirectories, [canonicalGit]);
  assert.ok(policy.deniedDirectories.includes(join(canonicalGit, 'hooks')));
  assert.ok(policy.deniedDirectories.includes(join(canonicalGit, 'objects', 'info')));
  assert.ok(policy.deniedDirectories.includes(join(canonicalGit, 'modules')));
  assert.ok(policy.deniedFiles.includes(await realpath(join(git, 'config'))));
  assert.equal(policy.deniedFiles.includes(join(canonicalGit, 'config.worktree')), false);
  assert.equal(policy.deniedFiles.includes(join(canonicalGit, 'commondir')), false);
  assert.equal(policy.deniedFiles.includes(join(canonicalGit, 'gitdir')), false);
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
  assert.ok(policy.writableDirectories.includes(await realpath(commonGit)));
  assert.ok(policy.writableDirectories.includes(await realpath(worktreeGit)));
  assert.equal(policy.writableDirectories.includes(await realpath(outside)), false);
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
