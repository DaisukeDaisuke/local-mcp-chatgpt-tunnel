import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  await exec('git', ['commit', '-m', 'fixture'], { cwd: root });
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
