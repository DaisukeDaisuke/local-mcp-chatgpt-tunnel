import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const exec = promisify(execFile);

async function importGitMcp(root, args, suffix, options = {}) {
  const previousArgv = process.argv;
  const previousAllowed = process.env.LOCAL_MCP_ALLOWED_DIRECTORIES;
  const previousAllowedFiles = process.env.LOCAL_MCP_ALLOWED_FILES;
  const previousDeniedDirectories = process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES;
  const previousDeniedFiles = process.env.LOCAL_MCP_DISALLOWED_FILES;
  const previousDeniedPathGlobs = process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS;
  process.argv = [previousArgv[0], join(process.cwd(), 'tests', 'gitmcp.test.mjs'), ...args];
  process.env.LOCAL_MCP_ALLOWED_DIRECTORIES = JSON.stringify([root]);
  process.env.LOCAL_MCP_ALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_FILES = JSON.stringify(options.disallowedFiles ?? []);
  process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = JSON.stringify(options.disallowedPathGlobs ?? []);
  try {
    return await import(`../mcp/gitmcp/server.mjs?test=${suffix}-${Date.now()}`);
  } finally {
    process.argv = previousArgv;
    if (previousAllowed === undefined) delete process.env.LOCAL_MCP_ALLOWED_DIRECTORIES;
    else process.env.LOCAL_MCP_ALLOWED_DIRECTORIES = previousAllowed;
    if (previousAllowedFiles === undefined) delete process.env.LOCAL_MCP_ALLOWED_FILES;
    else process.env.LOCAL_MCP_ALLOWED_FILES = previousAllowedFiles;
    if (previousDeniedDirectories === undefined) delete process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES;
    else process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES = previousDeniedDirectories;
    if (previousDeniedFiles === undefined) delete process.env.LOCAL_MCP_DISALLOWED_FILES;
    else process.env.LOCAL_MCP_DISALLOWED_FILES = previousDeniedFiles;
    if (previousDeniedPathGlobs === undefined) delete process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS;
    else process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = previousDeniedPathGlobs;
  }
}

test('gitmcp exposes only local Git capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-default-'));
  const { createServer } = await importGitMcp(root, [], 'default');
  const server = createServer();
  await server(request(1, 'initialize'));
  const listed = await server(request(2, 'tools/list'));
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(!names.includes('commit'));
  assert.ok(!names.includes('push'));
  assert.ok(!names.includes('pull'));
  assert.ok(!names.includes('clone_repository'));
  assert.ok(names.includes('get_policy'));
  assert.ok(names.includes('list_worktree_files'));
  assert.ok(names.includes('check_ignore'));
  assert.ok(names.includes('check_attributes'));
  assert.ok(names.includes('get_effective_config'));
  assert.ok(names.includes('show'));
  assert.ok(names.includes('branches'));
  assert.ok(names.includes('create_branch'));
  assert.ok(names.includes('checkout'));
  assert.ok(names.includes('list_worktrees'));
  assert.ok(names.includes('create_worktree'));
  assert.ok(names.includes('remove_worktree'));
  assert.ok(names.includes('stage_paths'));
  assert.ok(names.includes('unstage_paths'));
  assert.ok(!names.includes('delete_branch'));
});

test('gitmcp reports which standard Git behaviors are preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-policy-'));
  const { createServer } = await importGitMcp(root, [], 'policy');
  const server = createServer();
  await server(request(1, 'initialize'));
  const result = await server(request(2, 'tools/call', { name: 'get_policy', arguments: {} }));
  assert.equal(result.result.isError, false);
  const policy = result.result.structuredContent.result;
  assert.equal(policy.ignoreRules.respected, true);
  assert.equal(policy.attributes.binaryAndTextClassificationRespectedByDiff, true);
  assert.equal(policy.gitConfiguration.lineEndingConversionRespected, true);
  assert.equal(policy.gitConfiguration.systemAndGlobalCleanSmudgeFiltersRespected, true);
  assert.equal(policy.gitConfiguration.commitCapabilityMovedToDedicatedMcp, true);
  assert.equal(policy.deliberatelyDisabled.hooks, true);
  assert.equal(policy.attributes.systemAndGlobalTextconvRespected, true);
  assert.equal(policy.attributes.repositoryExternalDiffAndTextconvRejected, true);
});

test('gitmcp accepts legacy disable flags as no-ops without restoring moved capabilities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-enabled-'));
  const { createServer } = await importGitMcp(root, ['--disable-push=false', '--disable-pull=false', '--disable-clone=false'], 'enabled');
  const server = createServer();
  await server(request(1, 'initialize'));
  const listed = await server(request(2, 'tools/list'));
  const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  assert.ok(!tools.has('commit'));
  assert.ok(!tools.has('push'));
  assert.ok(!tools.has('pull'));
  assert.ok(!tools.has('clone_repository'));
  const annotationKeys = ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'];
  for (const tool of tools.values()) assert.deepEqual(Object.keys(tool.annotations).sort(), annotationKeys);
  assert.deepEqual(tools.get('status').annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  assert.deepEqual(tools.get('set_working_directory').annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  assert.deepEqual(tools.get('add_all').annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  });
  assert.deepEqual(tools.get('stage_paths').annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  });
  assert.deepEqual(tools.get('unstage_paths').annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false
  });
});

test('gitmcp rejects unknown CLI options instead of forwarding them to Git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-options-'));
  await assert.rejects(importGitMcp(root, ['--upload-pack=calc.exe'], 'unknown'), /Unknown argument/);
});

test('gitmcp reports absolute allowed paths when an existing path is outside its scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-allowed-'));
  const canonicalRoot = await realpath(root);
  const outside = await mkdtemp(join(tmpdir(), 'gitmcp-outside-'));
  const { createServer } = await importGitMcp(root, [], 'outside-scope');
  const server = createServer();
  await server(request(1, 'initialize'));
  const refused = await server(request(2, 'tools/call', {
    name: 'status', arguments: { repositoryPath: outside }
  }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /outside allowed_directories and allowed_files/);
  assert.match(refused.result.structuredContent.error, /Allowed directories \(absolute\):/);
  assert.ok(refused.result.structuredContent.error.includes(canonicalRoot));
});

test('gitmcp status and add_all respect .gitignore without force-adding ignored files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-ignore-'));
  await exec('git', ['init'], { cwd: root });
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n', 'utf8');
  await writeFile(join(root, 'ignored.txt'), 'ignored\n', 'utf8');
  await writeFile(join(root, 'visible.txt'), 'visible\n', 'utf8');
  const { createServer } = await importGitMcp(root, [], 'ignore');
  const server = createServer();
  await server(request(1, 'initialize'));
  const status = await server(request(2, 'tools/call', { name: 'status', arguments: { repositoryPath: root } }));
  assert.equal(status.result.isError, false);
  assert.match(status.result.structuredContent.result.status, /visible\.txt/);
  assert.doesNotMatch(status.result.structuredContent.result.status, /ignored\.txt/);
  const added = await server(request(3, 'tools/call', { name: 'add_all', arguments: { repositoryPath: root } }));
  assert.equal(added.result.isError, false);
  const tracked = (await exec('git', ['ls-files', '-z'], { cwd: root })).stdout.split('\0').filter(Boolean);
  assert.ok(tracked.includes('.gitignore'));
  assert.ok(tracked.includes('visible.txt'));
  assert.ok(!tracked.includes('ignored.txt'));
  const listed = await server(request(4, 'tools/call', { name: 'list_worktree_files', arguments: { repositoryPath: root } }));
  assert.equal(listed.result.isError, false);
  assert.ok(listed.result.structuredContent.result.files.includes('visible.txt'));
  assert.ok(!listed.result.structuredContent.result.files.includes('ignored.txt'));
  const checked = await server(request(5, 'tools/call', {
    name: 'check_ignore', arguments: { repositoryPath: root, paths: ['ignored.txt', 'visible.txt'] }
  }));
  assert.equal(checked.result.isError, false);
  const decisions = new Map(checked.result.structuredContent.result.decisions.map((entry) => [entry.path, entry]));
  assert.equal(decisions.get('ignored.txt').ignored, true);
  assert.equal(decisions.get('visible.txt').ignored, false);
});

test('gitmcp stage_paths and unstage_paths isolate selected directories without changing working files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-path-stage-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await mkdir(join(root, 'stage-a'));
  await mkdir(join(root, 'stage-b'));
  await writeFile(join(root, 'stage-a', 'modified.txt'), 'before a\n', 'utf8');
  await writeFile(join(root, 'stage-a', 'deleted.txt'), 'delete me\n', 'utf8');
  await writeFile(join(root, 'stage-b', 'modified.txt'), 'before b\n', 'utf8');
  await exec('git', ['add', '--all', '--', '.'], { cwd: root });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: root });
  await writeFile(join(root, 'stage-a', 'modified.txt'), 'after a\n', 'utf8');
  await writeFile(join(root, 'stage-a', 'new.txt'), 'new a\n', 'utf8');
  await rm(join(root, 'stage-a', 'deleted.txt'));
  await writeFile(join(root, 'stage-b', 'modified.txt'), 'after b\n', 'utf8');

  const { createServer } = await importGitMcp(root, [], 'path-stage');
  const server = createServer();
  await server(request(1, 'initialize'));
  const staged = await server(request(2, 'tools/call', {
    name: 'stage_paths', arguments: { repositoryPath: root, paths: ['stage-a'] }
  }));
  assert.equal(staged.result.isError, false);
  assert.deepEqual(staged.result.structuredContent.result.paths, ['stage-a']);
  const stagedNames = (await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(stagedNames, ['stage-a/deleted.txt', 'stage-a/modified.txt', 'stage-a/new.txt']);
  const unstagedNames = (await exec('git', ['diff', '--name-only'], { cwd: root })).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(unstagedNames, ['stage-b/modified.txt']);

  const unstaged = await server(request(3, 'tools/call', {
    name: 'unstage_paths', arguments: { repositoryPath: root, paths: ['stage-a'] }
  }));
  assert.equal(unstaged.result.isError, false);
  assert.equal(unstaged.result.structuredContent.result.changed, true);
  assert.equal(unstaged.result.structuredContent.result.unbornHead, false);
  assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout, '');
  const status = (await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })).stdout;
  assert.match(status, / D stage-a\/deleted\.txt/);
  assert.match(status, / M stage-a\/modified\.txt/);
  assert.match(status, /\?\? stage-a\/new\.txt/);
  assert.match(status, / M stage-b\/modified\.txt/);
  const repeated = await server(request(4, 'tools/call', {
    name: 'unstage_paths', arguments: { repositoryPath: root, paths: ['stage-a'] }
  }));
  assert.equal(repeated.result.isError, false);
  assert.equal(repeated.result.structuredContent.result.changed, false);
});

test('gitmcp unstage_paths works before the first commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-unborn-'));
  await exec('git', ['init'], { cwd: root });
  await writeFile(join(root, 'keep.txt'), 'keep\n', 'utf8');
  await writeFile(join(root, 'remove.txt'), 'remove\n', 'utf8');
  await exec('git', ['add', '--all', '--', '.'], { cwd: root });
  const { createServer } = await importGitMcp(root, [], 'unborn');
  const server = createServer();
  await server(request(1, 'initialize'));
  const result = await server(request(2, 'tools/call', {
    name: 'unstage_paths', arguments: { repositoryPath: root, paths: ['remove.txt'] }
  }));
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.result.changed, true);
  assert.equal(result.result.structuredContent.result.unbornHead, true);
  const stagedNames = (await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(stagedNames, ['keep.txt']);
  const status = (await exec('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })).stdout;
  assert.match(status, /\?\? remove\.txt/);
  const repeated = await server(request(3, 'tools/call', {
    name: 'unstage_paths', arguments: { repositoryPath: root, paths: ['remove.txt'] }
  }));
  assert.equal(repeated.result.isError, false);
  assert.equal(repeated.result.structuredContent.result.changed, false);
});

test('gitmcp diff respects .gitattributes binary classification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-attributes-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await writeFile(join(root, '.gitattributes'), 'payload.dat binary\n', 'utf8');
  await writeFile(join(root, 'payload.dat'), 'alpha\n', 'utf8');
  await exec('git', ['add', '--', '.gitattributes', 'payload.dat'], { cwd: root });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: root });
  await writeFile(join(root, 'payload.dat'), 'beta\n', 'utf8');
  const { createServer } = await importGitMcp(root, [], 'attributes');
  const server = createServer();
  await server(request(1, 'initialize'));
  const diff = await server(request(2, 'tools/call', { name: 'diff', arguments: { repositoryPath: root } }));
  assert.equal(diff.result.isError, false);
  assert.match(diff.result.structuredContent.result.diff, /Binary files .*payload\.dat.* differ/);
  const attributes = await server(request(3, 'tools/call', {
    name: 'check_attributes', arguments: { repositoryPath: root, paths: ['payload.dat'] }
  }));
  assert.equal(attributes.result.isError, false);
  const values = new Map(attributes.result.structuredContent.result.paths[0].attributes.map((entry) => [entry.attribute, entry.value]));
  assert.equal(values.get('diff'), 'unset');
  assert.equal(values.get('merge'), 'unset');
  assert.equal(values.get('text'), 'unset');
});

test('gitmcp show returns one commit with optional path selection and bounded summary formats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-show-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'alpha\n', 'utf8');
  await writeFile(join(root, 'b.txt'), 'bravo\n', 'utf8');
  await exec('git', ['add', '--', 'a.txt', 'b.txt'], { cwd: root });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'initial'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'alpha changed\n', 'utf8');
  await writeFile(join(root, 'b.txt'), 'bravo changed\n', 'utf8');
  await exec('git', ['add', '--', 'a.txt', 'b.txt'], { cwd: root });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'change both'], { cwd: root });
  const { createServer } = await importGitMcp(root, [], 'show');
  const server = createServer();
  await server(request(1, 'initialize'));

  const selected = await server(request(2, 'tools/call', {
    name: 'show', arguments: { repositoryPath: root, commit: 'HEAD', paths: ['a.txt'] }
  }));
  assert.equal(selected.result.isError, false);
  const selectedResult = selected.result.structuredContent.result;
  assert.match(selectedResult.objectId, /^[0-9a-f]{40,64}$/i);
  assert.deepEqual(selectedResult.paths, ['a.txt']);
  assert.match(selectedResult.show, /a\.txt/);
  assert.doesNotMatch(selectedResult.show, /b\.txt/);

  const statResult = await server(request(3, 'tools/call', {
    name: 'show', arguments: { repositoryPath: root, commit: 'HEAD', format: 'stat' }
  }));
  assert.equal(statResult.result.isError, false);
  assert.equal(statResult.result.structuredContent.result.format, 'stat');
  assert.match(statResult.result.structuredContent.result.show, /2 files changed/);

  const summary = await server(request(4, 'tools/call', {
    name: 'show', arguments: { repositoryPath: root, commit: 'HEAD~1', format: 'summary' }
  }));
  assert.equal(summary.result.isError, false);
  assert.equal(summary.result.structuredContent.result.format, 'summary');
  assert.match(summary.result.structuredContent.result.show, /initial/);
  assert.doesNotMatch(summary.result.structuredContent.result.show, /^diff --git/m);

  for (const [id, commit] of [[5, '--help'], [6, 'HEAD;marker']]) {
    const refused = await server(request(id, 'tools/call', {
      name: 'show', arguments: { repositoryPath: root, commit }
    }));
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.structuredContent.error, /commit is invalid/);
  }
  const escaped = await server(request(7, 'tools/call', {
    name: 'show', arguments: { repositoryPath: root, commit: 'HEAD', paths: ['../outside.txt'] }
  }));
  assert.equal(escaped.result.isError, true);
  assert.match(escaped.result.structuredContent.error, /escaped the worktree/);
});

test('gitmcp manages branches and allowed worktrees without branch deletion or forced removal', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'gitmcp-worktrees-'));
  const repository = join(workspace, 'repository');
  const worktreePath = join(workspace, 'feature-tree');
  await mkdir(repository);
  await exec('git', ['init'], { cwd: repository });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: repository });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: repository });
  await writeFile(join(repository, 'fixture.txt'), 'fixture\n', 'utf8');
  await exec('git', ['add', '--', 'fixture.txt'], { cwd: repository });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: repository });
  const primaryBranch = (await exec('git', ['branch', '--show-current'], { cwd: repository })).stdout.trim();

  const { createServer } = await importGitMcp(workspace, [], 'worktrees');
  const server = createServer();
  await server(request(1, 'initialize'));

  const created = await server(request(2, 'tools/call', {
    name: 'create_branch',
    arguments: { repositoryPath: repository, branch: 'feature', startPoint: 'HEAD', switch: false }
  }));
  assert.equal(created.result.isError, false);
  assert.equal(created.result.structuredContent.result.switched, false);

  const branches = await server(request(3, 'tools/call', {
    name: 'branches', arguments: { repositoryPath: repository }
  }));
  assert.equal(branches.result.isError, false);
  const feature = branches.result.structuredContent.result.branches.find((entry) => entry.branch === 'feature');
  assert.equal(feature.type, 'local');
  assert.match(feature.objectId, /^[0-9a-f]{40,64}$/i);

  const added = await server(request(4, 'tools/call', {
    name: 'create_worktree',
    arguments: {
      repositoryPath: repository,
      parentDirectory: workspace,
      destinationDirectory: 'feature-tree',
      branch: 'feature'
    }
  }));
  assert.equal(added.result.isError, false);
  const canonicalWorktreePath = await realpath(worktreePath);
  assert.equal(added.result.structuredContent.result.worktreePath, canonicalWorktreePath);

  const listed = await server(request(5, 'tools/call', {
    name: 'list_worktrees', arguments: { repositoryPath: repository }
  }));
  assert.equal(listed.result.isError, false);
  assert.ok(listed.result.structuredContent.result.worktrees.some((entry) => entry.path === canonicalWorktreePath && entry.branch === 'feature'));

  await writeFile(join(worktreePath, 'dirty.txt'), 'dirty\n', 'utf8');
  const dirtyRemoval = await server(request(6, 'tools/call', {
    name: 'remove_worktree', arguments: { repositoryPath: repository, worktreePath }
  }));
  assert.equal(dirtyRemoval.result.isError, true);

  await exec('git', ['clean', '-fd'], { cwd: worktreePath });
  const removed = await server(request(7, 'tools/call', {
    name: 'remove_worktree', arguments: { repositoryPath: repository, worktreePath }
  }));
  assert.equal(removed.result.isError, false);
  assert.equal(removed.result.structuredContent.result.branchDeleted, false);
  assert.equal(removed.result.structuredContent.result.forced, false);

  const switched = await server(request(8, 'tools/call', {
    name: 'switch_branch', arguments: { repositoryPath: repository, branch: 'feature' }
  }));
  assert.equal(switched.result.isError, false);
  const detached = await server(request(9, 'tools/call', {
    name: 'checkout', arguments: { repositoryPath: repository, target: 'HEAD', detach: true }
  }));
  assert.equal(detached.result.isError, false);
  assert.equal(detached.result.structuredContent.result.detached, true);
  const restored = await server(request(10, 'tools/call', {
    name: 'checkout', arguments: { repositoryPath: repository, target: primaryBranch }
  }));
  assert.equal(restored.result.isError, false);
  assert.equal(restored.result.structuredContent.result.detached, false);
});

test('gitmcp add_all preserves configured line-ending conversion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-autocrlf-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'core.autocrlf', 'true'], { cwd: root });
  await writeFile(join(root, 'line.txt'), 'alpha\r\nbeta\r\n', 'utf8');
  const { createServer } = await importGitMcp(root, [], 'autocrlf');
  const server = createServer();
  await server(request(1, 'initialize'));
  const added = await server(request(2, 'tools/call', { name: 'add_all', arguments: { repositoryPath: root } }));
  assert.equal(added.result.isError, false);
  const blob = (await exec('git', ['show', ':line.txt'], { cwd: root })).stdout;
  assert.equal(blob, 'alpha\nbeta\n');
  const configuration = await server(request(3, 'tools/call', { name: 'get_effective_config', arguments: { repositoryPath: root } }));
  assert.equal(configuration.result.isError, false);
  assert.ok(configuration.result.structuredContent.result.configuration.some((line) => /core\.autocrlf\s+true$/i.test(line)));
});

test('gitmcp rejects repository-local executable filters before status or staging while allowing ordinary repository configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-local-filter-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'core.autocrlf', 'true'], { cwd: root });
  await exec('git', ['config', 'filter.evil.clean', 'node evil.mjs'], { cwd: root });
  await writeFile(join(root, '.gitattributes'), '*.txt filter=evil\n', 'utf8');
  await writeFile(join(root, 'payload.txt'), 'payload\n', 'utf8');
  const { createServer } = await importGitMcp(root, [], 'local-filter');
  const server = createServer();
  await server(request(1, 'initialize'));
  for (const [id, name] of [[2, 'status'], [3, 'add_all']]) {
    const refused = await server(request(id, 'tools/call', { name, arguments: { repositoryPath: root } }));
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.structuredContent.error, /Repository-local Git configuration contains executable/);
  }
});

test('gitmcp refuses repository operations when an internal path matches disallowed_path_globs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-path-glob-'));
  await exec('git', ['init'], { cwd: root });
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'config.txt'), 'dummy', 'utf8');
  const { createServer } = await importGitMcp(root, [], 'path-glob', {
    disallowedPathGlobs: ['**.ssh**']
  });
  const server = createServer();
  await server(request(1, 'initialize'));
  const refused = await server(request(2, 'tools/call', {
    name: 'status', arguments: { repositoryPath: root }
  }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /Git repository scan/);
  assert.match(refused.result.structuredContent.error, /glob filter disallowed_path_globs/);
  assert.match(refused.result.structuredContent.error, /\.ssh/);
});

test('gitmcp refuses repository operations when a tracked file is denied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-denied-file-'));
  const deniedPath = join(root, 'gateway.toml');
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await writeFile(deniedPath, 'private_use_only = true\n', 'utf8');
  await exec('git', ['add', '--', 'gateway.toml'], { cwd: root });
  await exec('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'], { cwd: root });
  const { createServer } = await importGitMcp(root, [], 'denied-file', { disallowedFiles: [deniedPath] });
  const server = createServer();
  await server(request(1, 'initialize'));
  const refused = await server(request(2, 'tools/call', {
    name: 'diff', arguments: { repositoryPath: root }
  }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /Repository contains denied paths/);
  assert.match(refused.result.structuredContent.error, /gateway\.toml/);
});
