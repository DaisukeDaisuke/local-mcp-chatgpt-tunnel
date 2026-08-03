import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });

async function importGitMcp(root, args, suffix) {
  const previousArgv = process.argv;
  const previousAllowed = process.env.LOCAL_MCP_ALLOWED_DIRECTORIES;
  const previousAllowedFiles = process.env.LOCAL_MCP_ALLOWED_FILES;
  const previousDeniedDirectories = process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES;
  const previousDeniedFiles = process.env.LOCAL_MCP_DISALLOWED_FILES;
  process.argv = [previousArgv[0], join(process.cwd(), 'mcp', 'gitmcp', 'server.mjs'), ...args];
  process.env.LOCAL_MCP_ALLOWED_DIRECTORIES = JSON.stringify([root]);
  process.env.LOCAL_MCP_ALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_FILES = '[]';
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
});

test('gitmcp rejects unknown CLI options instead of forwarding them to Git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitmcp-options-'));
  await assert.rejects(importGitMcp(root, ['--upload-pack=calc.exe'], 'unknown'), /Unknown argument/);
});
