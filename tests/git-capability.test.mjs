import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { signBundledIsolationContext } from '../app/bundled-isolation.mjs';

const exec = promisify(execFile);
const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const ISOLATION_KEY = 'git-capability-test-isolation-key-0123456789';

async function gitExecutable() {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const { stdout } = await exec(locator, ['git']);
  return stdout.trim().split(/\r?\n/)[0];
}

function signedArguments(root, args = {}) {
  const context = { roots: [root], base: root };
  return {
    ...args,
    __localMcpIsolation: {
      version: 1,
      ...context,
      signature: signBundledIsolationContext(ISOLATION_KEY, context)
    }
  };
}

async function importCapability(root, mode, suffix) {
  const previousArgv = process.argv;
  const previousEnvironment = new Map([
    ['LOCAL_MCP_ALLOWED_DIRECTORIES', process.env.LOCAL_MCP_ALLOWED_DIRECTORIES],
    ['LOCAL_MCP_ALLOWED_FILES', process.env.LOCAL_MCP_ALLOWED_FILES],
    ['LOCAL_MCP_DISALLOWED_DIRECTORIES', process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES],
    ['LOCAL_MCP_DISALLOWED_FILES', process.env.LOCAL_MCP_DISALLOWED_FILES],
    ['LOCAL_MCP_DISALLOWED_PATH_GLOBS', process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS],
    ['LOCAL_MCP_GATEWAY_ISOLATION_KEY', process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY]
  ]);
  const git = await gitExecutable();
  const args = [`--mode=${mode}`, `--git-executable=${git}`];
  if (mode === 'push' || mode === 'pull') args.push('--remote=origin', '--expected-remote-url=https://example.invalid/repository.git');
  if (mode === 'clone') args.push('--url=https://example.invalid/repository.git');
  process.argv = [previousArgv[0], join(process.cwd(), 'tests', 'git-capability.test.mjs'), ...args];
  process.env.LOCAL_MCP_ALLOWED_DIRECTORIES = JSON.stringify([root]);
  process.env.LOCAL_MCP_ALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = '[]';
  process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY = ISOLATION_KEY;
  try {
    return await import(`../mcp/git-capability/server.mjs?test=${suffix}-${Date.now()}`);
  } finally {
    process.argv = previousArgv;
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('git-capability exposes exactly one Git operation per mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-capability-schema-'));
  const expected = new Map([
    ['commit', 'commit'],
    ['push', 'push'],
    ['pull', 'pull'],
    ['clone', 'clone_repository']
  ]);
  for (const [mode, operation] of expected) {
    const { createServer } = await importCapability(root, mode, `schema-${mode}`);
    const server = createServer();
    await server(request(1, 'initialize'));
    const listed = await server(request(2, 'tools/list'));
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ['roots', 'get_working_directory', 'set_working_directory', operation]);
    const schema = listed.result.tools.at(-1).inputSchema;
    assert.equal(schema.additionalProperties, false);
    if (mode === 'commit') assert.deepEqual(Object.keys(schema.properties), ['message']);
    if (mode === 'push' || mode === 'pull') assert.deepEqual(Object.keys(schema.properties), []);
    if (mode === 'clone') {
      assert.deepEqual(Object.keys(schema.properties), ['destinationDirectory', 'depth']);
      assert.ok(!Object.hasOwn(schema.properties, 'url'));
      assert.ok(!Object.hasOwn(schema.properties, 'parentDirectory'));
      assert.ok(!Object.hasOwn(schema.properties, 'recurseSubmodules'));
    }
  }
});

test('git-capability commit accepts only a literal message and commits the staged index', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-capability-commit-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await exec('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  await writeFile(join(root, 'staged.txt'), 'staged\n', 'utf8');
  await exec('git', ['add', '--', 'staged.txt'], { cwd: root });
  const { createServer } = await importCapability(root, 'commit', 'commit');
  const server = createServer();
  await server(request(1, 'initialize'));
  const committed = await server(request(2, 'tools/call', {
    name: 'commit',
    arguments: signedArguments(root, { message: 'bounded commit' })
  }));
  assert.equal(committed.result.isError, false);
  assert.equal(committed.result.structuredContent.result.committed, true);
  assert.equal((await exec('git', ['log', '-1', '--format=%s'], { cwd: root })).stdout.trim(), 'bounded commit');

  const extra = await server(request(3, 'tools/call', {
    name: 'commit',
    arguments: signedArguments(root, { message: 'nope', repositoryPath: root })
  }));
  assert.equal(extra.result.isError, true);
  assert.match(extra.result.structuredContent.error, /Unexpected tool argument: repositoryPath/);
});

test('git-capability commit rejects repository-local executable signing configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-capability-local-signing-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Test User'], { cwd: root });
  await exec('git', ['config', 'gpg.program', 'definitely-not-a-real-program'], { cwd: root });
  await writeFile(join(root, 'staged.txt'), 'staged\n', 'utf8');
  await exec('git', ['add', '--', 'staged.txt'], { cwd: root });
  const { createServer } = await importCapability(root, 'commit', 'local-signing');
  const server = createServer();
  await server(request(1, 'initialize'));
  const refused = await server(request(2, 'tools/call', {
    name: 'commit',
    arguments: signedArguments(root, { message: 'must not execute local gpg.program' })
  }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /Repository-local Git configuration contains executable/);
});

test('git-capability fails closed on a modified signed workspace context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-capability-signature-'));
  const { createServer } = await importCapability(root, 'commit', 'signature');
  const server = createServer();
  await server(request(1, 'initialize'));
  const args = signedArguments(root, { message: 'unused' });
  args.__localMcpIsolation.base = join(root, 'forged');
  const refused = await server(request(2, 'tools/call', { name: 'commit', arguments: args }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /isolation signature|outside its roots/i);
});
