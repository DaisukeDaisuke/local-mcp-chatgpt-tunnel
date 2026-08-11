import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { signBundledIsolationContext } from '../app/bundled-isolation.mjs';
import { testGitExecutable } from './test-git-executable.mjs';

const exec = promisify(execFile);
const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const ISOLATION_KEY = 'git-capability-test-isolation-key-0123456789';

async function testRoot(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
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

async function importCapability(root, mode, suffix, options = {}) {
  const previousArgv = process.argv;
  const previousEnvironment = new Map([
    ['LOCAL_MCP_ALLOWED_DIRECTORIES', process.env.LOCAL_MCP_ALLOWED_DIRECTORIES],
    ['LOCAL_MCP_ALLOWED_FILES', process.env.LOCAL_MCP_ALLOWED_FILES],
    ['LOCAL_MCP_DISALLOWED_DIRECTORIES', process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES],
    ['LOCAL_MCP_DISALLOWED_FILES', process.env.LOCAL_MCP_DISALLOWED_FILES],
    ['LOCAL_MCP_DISALLOWED_PATH_GLOBS', process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS],
    ['LOCAL_MCP_GATEWAY_ISOLATION_KEY', process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY],
    ['LOCAL_MCP_CODEX_SANDBOX_MODE', process.env.LOCAL_MCP_CODEX_SANDBOX_MODE]
  ]);
  const git = await testGitExecutable();
  const args = [`--mode=${mode}`, `--git-executable=${git}`];
  if (mode === 'push' || mode === 'pull') {
    args.push('--remote=origin');
    for (const repository of options.repositories ?? ['example/repository']) args.push(`--repository=${repository}`);
  }
  if (mode === 'clone') args.push('--url=https://example.invalid/repository.git');
  process.argv = [previousArgv[0], join(process.cwd(), 'tests', 'git-capability.test.mjs'), ...args];
  process.env.LOCAL_MCP_ALLOWED_DIRECTORIES = JSON.stringify([root]);
  process.env.LOCAL_MCP_ALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES = JSON.stringify(options.disallowedDirectories ?? []);
  process.env.LOCAL_MCP_DISALLOWED_FILES = JSON.stringify(options.disallowedFiles ?? []);
  process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = JSON.stringify(options.disallowedPathGlobs ?? []);
  process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY = ISOLATION_KEY;
  process.env.LOCAL_MCP_CODEX_SANDBOX_MODE = options.sandboxMode ?? 'never';
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

test('git-capability matches GitHub HTTPS and SSH remotes by OWNER/REPO identity', async () => {
  const root = await testRoot('git-capability-repository-match-');
  const { githubRemoteMatchesRepository } = await importCapability(root, 'push', 'repository-match');
  assert.equal(
    githubRemoteMatchesRepository('https://github.com/DaisukeDaisuke/desmume_webassembly.git', 'DaisukeDaisuke/desmume_webassembly'),
    true
  );
  assert.equal(
    githubRemoteMatchesRepository('git@github.com:DaisukeDaisuke/desmume_webassembly.git', 'DaisukeDaisuke/desmume_webassembly'),
    true
  );
  assert.equal(
    githubRemoteMatchesRepository('ssh://git@github.com/DaisukeDaisuke/desmume_webassembly.git', 'DaisukeDaisuke/desmume_webassembly'),
    true
  );
  assert.equal(
    githubRemoteMatchesRepository('https://github.com/DaisukeDaisuke/desmume_webassembly-old.git', 'DaisukeDaisuke/desmume_webassembly'),
    false
  );
  assert.throws(
    () => githubRemoteMatchesRepository('https://example.com/DaisukeDaisuke/desmume_webassembly.git', 'DaisukeDaisuke/desmume_webassembly'),
    (error) => error.message === 'remote URL must target github.com without a custom port, query, or fragment'
  );
});

test('git-capability push accepts a remote matching any repeated startup repository allowlist entry', async () => {
  const root = await testRoot('git-capability-multi-repository-');
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['remote', 'add', 'origin', 'git@github.com:DaisukeDaisuke/local-mcp-chatgpt-tunnel.git'], { cwd: root });
  const { createServer } = await importCapability(root, 'push', 'multi-repository', {
    repositories: [
      'DaisukeDaisuke/dqixToGPT',
      'DaisukeDaisuke/local-mcp-chatgpt-tunnel',
      'DaisukeDaisuke/desmume_webassembly_harness'
    ]
  });
  const server = createServer();
  await server(request(1, 'initialize'));
  const result = await server(request(2, 'tools/call', {
    name: 'push',
    arguments: signedArguments(root)
  }));
  assert.equal(result.result.isError, true);
  assert.doesNotMatch(result.result.structuredContent.error, /does not match any startup allowlisted GitHub repository/);
});

test('git-capability exposes only the operations assigned to each mode', async () => {
  const root = await testRoot('git-capability-schema-');
  const expected = new Map([
    ['stage', ['add_all', 'stage_paths', 'unstage_paths']],
    ['commit', ['commit']],
    ['push', ['push']],
    ['pull', ['pull']],
    ['clone', ['clone_repository']]
  ]);
  for (const [mode, operations] of expected) {
    const { createServer } = await importCapability(root, mode, `schema-${mode}`);
    const server = createServer();
    await server(request(1, 'initialize'));
    const listed = await server(request(2, 'tools/list'));
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, ['roots', 'get_working_directory', 'set_working_directory', ...operations]);
    for (const tool of listed.result.tools.slice(3)) assert.equal(tool.inputSchema.additionalProperties, false);
    if (mode === 'commit') assert.deepEqual(Object.keys(listed.result.tools.at(-1).inputSchema.properties), ['message']);
    if (mode === 'push' || mode === 'pull') assert.deepEqual(Object.keys(listed.result.tools.at(-1).inputSchema.properties), []);
    if (mode === 'clone') {
      const schema = listed.result.tools.at(-1).inputSchema;
      assert.deepEqual(Object.keys(schema.properties), ['destinationDirectory', 'depth']);
      assert.ok(!Object.hasOwn(schema.properties, 'url'));
      assert.ok(!Object.hasOwn(schema.properties, 'parentDirectory'));
      assert.ok(!Object.hasOwn(schema.properties, 'recurseSubmodules'));
    }
  }
});

test('git-capability stage updates only the Git index and preserves line-ending conversion', async () => {
  const root = await testRoot('git-capability-stage-');
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'core.autocrlf', 'true'], { cwd: root });
  await writeFile(join(root, 'line.txt'), 'alpha\r\nbeta\r\n', 'utf8');
  await writeFile(join(root, 'other.txt'), 'other\n', 'utf8');
  const { createServer } = await importCapability(root, 'stage', 'stage');
  const server = createServer();
  await server(request(1, 'initialize'));

  const staged = await server(request(2, 'tools/call', {
    name: 'stage_paths',
    arguments: signedArguments(root, { paths: ['line.txt'] })
  }));
  assert.equal(staged.result.isError, false);
  assert.equal((await exec('git', ['show', ':line.txt'], { cwd: root })).stdout, 'alpha\nbeta\n');
  const cachedNames = (await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(cachedNames, ['line.txt']);

  const unstaged = await server(request(3, 'tools/call', {
    name: 'unstage_paths',
    arguments: signedArguments(root, { paths: ['line.txt'] })
  }));
  assert.equal(unstaged.result.isError, false);
  assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout, '');

  const all = await server(request(4, 'tools/call', {
    name: 'add_all',
    arguments: signedArguments(root)
  }));
  assert.equal(all.result.isError, false);
  const allNames = (await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout.trim().split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(allNames, ['line.txt', 'other.txt']);
});

test('git-capability stage refuses to add a configured denied worktree path', async () => {
  const root = await testRoot('git-capability-stage-denied-');
  const denied = join(root, 'private.txt');
  await exec('git', ['init'], { cwd: root });
  await writeFile(join(root, 'public.txt'), 'public\n', 'utf8');
  await writeFile(denied, 'private\n', 'utf8');
  const { createServer } = await importCapability(root, 'stage', 'stage-denied', { disallowedFiles: [denied] });
  const server = createServer();
  await server(request(1, 'initialize'));
  const refused = await server(request(2, 'tools/call', {
    name: 'add_all',
    arguments: signedArguments(root)
  }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /denied by disallowed_directories or disallowed_files/);
  assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout, '');
});

test('git-capability commit accepts only a literal message and commits the staged index', async () => {
  const root = await testRoot('git-capability-commit-');
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
  assert.equal(extra.result.structuredContent.error, 'Unexpected tool argument: repositoryPath');
});

test('git-capability commit rejects repository-local executable signing configuration', async () => {
  const root = await testRoot('git-capability-local-signing-');
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
  assert.equal(
    refused.result.structuredContent.error,
    'Repository-local Git configuration contains executable hooks, helpers, filters, diff/textconv commands, merge drivers, signing programs, proxies, custom transport commands, or external attributes/ignore files'
  );
});

test('git-capability fails closed on a modified signed workspace context', async () => {
  const root = await testRoot('git-capability-signature-');
  const { createServer } = await importCapability(root, 'commit', 'signature');
  const server = createServer();
  await server(request(1, 'initialize'));
  const args = signedArguments(root, { message: 'unused' });
  args.__localMcpIsolation.base = join(root, 'forged');
  const refused = await server(request(2, 'tools/call', { name: 'commit', arguments: args }));
  assert.equal(refused.result.isError, true);
  assert.equal(refused.result.structuredContent.ok, false);
});
