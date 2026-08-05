import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
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

test('gitmcp hides pull and clone by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-default-'));
  const { createServer } = await importGitMcp(root, [], 'default');
  const server = createServer();
  await server(request(1, 'initialize'));
  const listed = await server(request(2, 'tools/list'));
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('push'));
  assert.ok(!names.includes('pull'));
  assert.ok(!names.includes('clone_repository'));
  assert.ok(names.includes('get_policy'));
  assert.ok(names.includes('list_worktree_files'));
  assert.ok(names.includes('check_ignore'));
  assert.ok(names.includes('check_attributes'));
  assert.ok(names.includes('get_effective_config'));
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
  assert.equal(policy.gitConfiguration.configuredCommitSigningRespected, true);
  assert.equal(policy.deliberatelyDisabled.hooks, true);
  assert.equal(policy.attributes.systemAndGlobalTextconvRespected, true);
  assert.equal(policy.attributes.repositoryExternalDiffAndTextconvRejected, true);
});

test('gitmcp exposes pull and recursive clone only when explicitly enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-enabled-'));
  const { createServer } = await importGitMcp(root, ['--disable-pull=false', '--disable-clone=false'], 'enabled');
  const server = createServer();
  await server(request(1, 'initialize'));
  const listed = await server(request(2, 'tools/list'));
  const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  assert.ok(tools.has('pull'));
  assert.ok(tools.has('clone_repository'));
  assert.equal(tools.get('clone_repository').inputSchema.properties.recurseSubmodules.type, 'boolean');
  assert.equal(tools.get('clone_repository').inputSchema.properties.depth.type, 'integer');
  assert.equal(tools.get('clone_repository').inputSchema.properties.depth.minimum, 1);
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
  assert.deepEqual(tools.get('commit').annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  });
  assert.deepEqual(tools.get('push').annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true
  });
  assert.deepEqual(tools.get('clone_repository').annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true
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

test('gitmcp add_all preserves configured line-ending conversion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-autocrlf-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'core.autocrlf', 'true'], { cwd: root });
  await exec('git', ['config', 'commit.gpgsign', 'true'], { cwd: root });
  await exec('git', ['config', 'user.signingkey', 'TEST-SIGNING-KEY'], { cwd: root });
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
  assert.ok(configuration.result.structuredContent.result.configuration.some((line) => /commit\.gpgsign\s+true$/i.test(line)));
  assert.ok(configuration.result.structuredContent.result.configuration.some((line) => /user\.signingkey\s+TEST-SIGNING-KEY$/i.test(line)));
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
