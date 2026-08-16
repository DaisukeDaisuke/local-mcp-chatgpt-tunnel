import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { signBundledIsolationContext } from '../app/bundled-isolation.mjs';

const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const TEST_ISOLATION_KEY = '0123456789abcdef'.repeat(4);

async function importCodespace({ roots = [process.cwd()], maxTransferBytes, isolationKey, disallowedPathGlobs = [], suffix = 'default' } = {}) {
  const previousArgv = process.argv;
  const previousAllowed = process.env.LOCAL_MCP_ALLOWED_DIRECTORIES;
  const previousFiles = process.env.LOCAL_MCP_ALLOWED_FILES;
  const previousDisallowedPathGlobs = process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS;
  const previousMax = process.env.CODESPACE_MCP_MAX_TRANSFER_BYTES;
  const previousIsolationKey = process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY;
  process.argv = [
    previousArgv[0],
    'tests/codespace.test.mjs',
    `--gh-executable=${process.execPath}`
  ];
  process.env.LOCAL_MCP_ALLOWED_DIRECTORIES = JSON.stringify(roots);
  process.env.LOCAL_MCP_ALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = JSON.stringify(disallowedPathGlobs);
  if (isolationKey === undefined) delete process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY;
  else process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY = isolationKey;
  if (maxTransferBytes === undefined) delete process.env.CODESPACE_MCP_MAX_TRANSFER_BYTES;
  else process.env.CODESPACE_MCP_MAX_TRANSFER_BYTES = String(maxTransferBytes);
  try {
    const imported = await import(`../mcp/codespace/server.mjs?test=${suffix}-${Date.now()}-${Math.random()}`);
    return {
      ...imported,
      createServer(options = {}) {
        return imported.createServer({ sshKeyProvider: async () => undefined, ...options });
      }
    };
  } finally {
    process.argv = previousArgv;
    if (previousAllowed === undefined) delete process.env.LOCAL_MCP_ALLOWED_DIRECTORIES; else process.env.LOCAL_MCP_ALLOWED_DIRECTORIES = previousAllowed;
    if (previousFiles === undefined) delete process.env.LOCAL_MCP_ALLOWED_FILES; else process.env.LOCAL_MCP_ALLOWED_FILES = previousFiles;
    if (previousDisallowedPathGlobs === undefined) delete process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS; else process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = previousDisallowedPathGlobs;
    if (previousMax === undefined) delete process.env.CODESPACE_MCP_MAX_TRANSFER_BYTES; else process.env.CODESPACE_MCP_MAX_TRANSFER_BYTES = previousMax;
    if (previousIsolationKey === undefined) delete process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY; else process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY = previousIsolationKey;
  }
}

function isolatedArguments(root, isolatedId, args = {}) {
  const context = { isolatedId, base: root, roots: [root] };
  return {
    ...args,
    __localMcpIsolation: {
      version: 1,
      isolatedId,
      base: root,
      roots: [root],
      signature: signBundledIsolationContext(TEST_ISOLATION_KEY, context)
    }
  };
}

test('codespace exposes existing-codespace operations including stop but no create/start/delete/rebuild/edit tool', async () => {
  const { createServer } = await importCodespace({ suffix: 'tools' });
  const commands = [];
  const server = createServer({
    execute: async (args) => {
      commands.push(args);
      return { stdout: '[]', stderr: '', exitCode: 0 };
    }
  });
  await server(request(1, 'initialize'));
  const listed = await server(request(2, 'tools/list'));
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'list_codespaces',
    'view_codespace',
    'roots',
    'git_root',
    'ripgrep_version',
    'install_ripgrep',
    'search_text',
    'ssh',
    'get_async_status',
    'get_async_logs',
    'write_async_stdin',
    'wait_async',
    'cancel_async',
    'copy_to_codespace',
    'stop_codespace',
    'list_temporary_public_deployments',
    'open_temporary_public_deployment',
    'close_temporary_public_deployment'
  ]);
  const result = await server(request(3, 'tools/call', { name: 'list_codespaces', arguments: { limit: 17 } }));
  assert.equal(result.result.isError, false);
  assert.deepEqual(commands, [[
    'codespace', 'list', '--limit', '17', '--json', 'name,displayName,state,repository,lastUsedAt'
  ]]);
});

function fakeAsyncExecution() {
  let state = 'running';
  let stdout = '';
  let stderr = '';
  let exitCode = null;
  let signal = null;
  let error = null;
  const stdinWrites = [];
  let stdinEnded = false;
  let resolveCompletion;
  const completion = new Promise((resolvePromise) => { resolveCompletion = resolvePromise; });
  const snapshot = () => ({ command: ['gh', 'codespace', 'ssh'], state, stdout, stderr, outputBytes: Buffer.byteLength(stdout) + Buffer.byteLength(stderr), exitCode, signal, error });
  const finish = ({ code = 0, out = stdout, err = stderr } = {}) => {
    stdout = out;
    stderr = err;
    exitCode = code;
    state = code === 0 ? 'completed' : 'failed';
    error = code === 0 ? null : `exit ${code}`;
    resolveCompletion(snapshot());
  };
  return {
    execution: {
      completion,
      snapshot,
      cancel() {
        if (state !== 'running') return false;
        state = 'cancelled';
        error = 'cancelled';
        resolveCompletion(snapshot());
        return true;
      },
      async writeStdin(data, end = false) {
        if (state !== 'running') throw new Error('not running');
        if (stdinEnded) throw new Error('stdin closed');
        stdinWrites.push({ data, end });
        if (end) stdinEnded = true;
      }
    },
    stdinWrites,
    appendStdout(value) { stdout += value; },
    appendStderr(value) { stderr += value; },
    finish
  };
}

test('codespace async SSH returns immediately, exposes stdio/status, supports bounded re-wait, and completes under one asyncId', async () => {
  const { createServer } = await importCodespace({ suffix: 'async-ssh' });
  const fake = fakeAsyncExecution();
  const starts = [];
  const server = createServer({
    startAsyncExecution: async (args, options) => {
      starts.push({ args, options });
      return fake.execution;
    }
  });
  await server(request(1, 'initialize'));
  const started = await server(request(2, 'tools/call', {
    name: 'ssh',
    arguments: { codespaceId: 'existing-space-123', command: ['node', '--version'], async: true, timeoutMs: 600000 }
  }));
  assert.equal(started.result.isError, false);
  const asyncId = started.result.structuredContent.result.asyncId;
  assert.match(asyncId, /^[0-9a-f-]{36}$/);
  assert.equal(started.result.structuredContent.result.status, 'running');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.timeoutMs, 600000);
  assert.equal(starts[0].options.keepStdinOpen, true);

  const firstInput = await server(request(30, 'tools/call', {
    name: 'write_async_stdin',
    arguments: { asyncId, data: 'hello\n' }
  }));
  assert.equal(firstInput.result.isError, false);
  assert.equal(firstInput.result.structuredContent.result.bytesWritten, 6);
  assert.equal(firstInput.result.structuredContent.result.stdinEnded, false);

  const finalInput = await server(request(31, 'tools/call', {
    name: 'write_async_stdin',
    arguments: { asyncId, data: 'done\n', end: true }
  }));
  assert.equal(finalInput.result.isError, false);
  assert.equal(finalInput.result.structuredContent.result.stdinEnded, true);
  assert.deepEqual(fake.stdinWrites, [
    { data: 'hello\n', end: false },
    { data: 'done\n', end: true }
  ]);
  const afterEof = await server(request(32, 'tools/call', {
    name: 'write_async_stdin',
    arguments: { asyncId, data: 'late' }
  }));
  assert.equal(afterEof.result.isError, true);

  fake.appendStdout('line one\n');
  fake.appendStderr('warning\n');
  const logs = await server(request(3, 'tools/call', { name: 'get_async_logs', arguments: { asyncId } }));
  assert.equal(logs.result.structuredContent.result.stdout, 'line one\n');
  assert.equal(logs.result.structuredContent.result.stderr, 'warning\n');

  const stillRunning = await server(request(4, 'tools/call', { name: 'wait_async', arguments: { asyncId, waitTimeoutMs: 5 } }));
  assert.equal(stillRunning.result.structuredContent.result.status, 'running');

  fake.finish({ out: 'line one\ndone\n', err: 'warning\n' });
  const completed = await server(request(5, 'tools/call', { name: 'wait_async', arguments: { asyncId, waitTimeoutMs: 1000 } }));
  assert.equal(completed.result.structuredContent.result.status, 'completed');
  assert.equal(completed.result.structuredContent.result.exitCode, 0);
});

test('codespace async SSH can be cancelled, allows up to one hour, and rejects longer runtimes', async () => {
  const { createServer } = await importCodespace({ suffix: 'async-cancel' });
  const fake = fakeAsyncExecution();
  let starts = 0;
  const server = createServer({
    startAsyncExecution: async () => {
      starts += 1;
      return fake.execution;
    }
  });
  await server(request(1, 'initialize'));
  const tooLongSync = await server(request(20, 'tools/call', {
    name: 'ssh',
    arguments: { codespaceId: 'existing-space-123', command: ['sleep', '1'], timeoutMs: 600001 }
  }));
  assert.equal(tooLongSync.result.isError, true);
  assert.equal(starts, 0);

  const tooLong = await server(request(2, 'tools/call', {
    name: 'ssh',
    arguments: { codespaceId: 'existing-space-123', command: ['sleep', '1'], async: true, timeoutMs: 3600001 }
  }));
  assert.equal(tooLong.result.isError, true);
  assert.equal(starts, 0);

  const started = await server(request(3, 'tools/call', {
    name: 'ssh',
    arguments: { codespaceId: 'existing-space-123', command: ['sleep', '1'], async: true, timeoutMs: 3600000 }
  }));
  assert.equal(started.result.isError, false);
  assert.equal(starts, 1);
  const asyncId = started.result.structuredContent.result.asyncId;
  const cancelled = await server(request(4, 'tools/call', { name: 'cancel_async', arguments: { asyncId } }));
  assert.equal(cancelled.result.structuredContent.result.cancelled, true);
  assert.equal(cancelled.result.structuredContent.result.status, 'cancelled');
  const status = await server(request(5, 'tools/call', { name: 'get_async_status', arguments: { asyncId } }));
  assert.equal(status.result.structuredContent.result.status, 'cancelled');
});

test('codespace ownership is last-isolation-wins and a revoked older isolation must defer to the user', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codespace-owner-')));
  const { createServer } = await importCodespace({ roots: [root], isolationKey: TEST_ISOLATION_KEY, suffix: 'ownership' });
  const executions = [];
  const server = createServer({ execute: async (args) => {
    executions.push(args);
    return { stdout: JSON.stringify({ name: 'existing-space-123' }), stderr: '', exitCode: 0 };
  } });
  await server(request(1, 'initialize'));

  const first = await server(request(2, 'tools/call', {
    name: 'view_codespace',
    arguments: isolatedArguments(root, 'ai-session-a', { codespaceId: 'existing-space-123' })
  }));
  assert.equal(first.result.isError, false);

  const second = await server(request(3, 'tools/call', {
    name: 'view_codespace',
    arguments: isolatedArguments(root, 'ai-session-b', { codespaceId: 'existing-space-123' })
  }));
  assert.equal(second.result.isError, false);

  const stale = await server(request(4, 'tools/call', {
    name: 'view_codespace',
    arguments: isolatedArguments(root, 'ai-session-a', { codespaceId: 'existing-space-123' })
  }));
  assert.equal(stale.result.isError, true);
  assert.match(stale.result.structuredContent.error, /owned by isolated session ai-session-b/);
  assert.match(stale.result.structuredContent.error, /isolated__list/);
  assert.match(stale.result.structuredContent.error, /ask the user/);
  assert.equal(executions.length, 2);
});

test('codespace ownership transfer cancels the previous isolation async SSH and blocks its management calls', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codespace-owner-async-')));
  const { createServer } = await importCodespace({ roots: [root], isolationKey: TEST_ISOLATION_KEY, suffix: 'ownership-async' });
  const fake = fakeAsyncExecution();
  const server = createServer({
    execute: async () => ({ stdout: JSON.stringify({ name: 'existing-space-123' }), stderr: '', exitCode: 0 }),
    startAsyncExecution: async () => fake.execution
  });
  await server(request(1, 'initialize'));

  const started = await server(request(2, 'tools/call', {
    name: 'ssh',
    arguments: isolatedArguments(root, 'ai-session-a', {
      codespaceId: 'existing-space-123', command: ['sleep', '60'], async: true
    })
  }));
  assert.equal(started.result.isError, false);
  const asyncId = started.result.structuredContent.result.asyncId;

  const takeover = await server(request(3, 'tools/call', {
    name: 'view_codespace',
    arguments: isolatedArguments(root, 'ai-session-b', { codespaceId: 'existing-space-123' })
  }));
  assert.equal(takeover.result.isError, false);
  assert.equal(fake.execution.snapshot().state, 'cancelled');

  const staleStatus = await server(request(4, 'tools/call', {
    name: 'get_async_status',
    arguments: isolatedArguments(root, 'ai-session-a', { asyncId })
  }));
  assert.equal(staleStatus.result.isError, true);
  assert.match(staleStatus.result.structuredContent.error, /owned by isolated session ai-session-b/);
});

test('codespace stop cancels owned async SSH, clears readiness, and reports Shutdown without deleting the Codespace', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codespace-stop-')));
  await writeFile(join(root, 'alpha.txt'), 'alpha', 'utf8');
  const { createServer } = await importCodespace({ roots: [root], isolationKey: TEST_ISOLATION_KEY, suffix: 'stop' });
  const fake = fakeAsyncExecution();
  const commands = [];
  const server = createServer({
    execute: async (args) => {
      commands.push(args);
      if (args[0] === 'codespace' && args[1] === 'ssh') {
        if (args.at(-1) === 'echo started') return { stdout: 'started\n', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'codespace' && args[1] === 'stop') return { stdout: 'stopped\n', stderr: '', exitCode: 0 };
      if (args[0] === 'codespace' && args[1] === 'view') return { stdout: 'Shutdown\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    startAsyncExecution: async () => fake.execution
  });
  await server(request(1, 'initialize'));

  const ready = await server(request(2, 'tools/call', {
    name: 'ssh',
    arguments: isolatedArguments(root, 'ai-session-stop', { codespaceId: 'existing-space-123', command: ['true'] })
  }));
  assert.equal(ready.result.isError, false);

  const started = await server(request(3, 'tools/call', {
    name: 'ssh',
    arguments: isolatedArguments(root, 'ai-session-stop', {
      codespaceId: 'existing-space-123', command: ['sleep', '60'], async: true
    })
  }));
  assert.equal(started.result.isError, false);

  const stopped = await server(request(4, 'tools/call', {
    name: 'stop_codespace',
    arguments: isolatedArguments(root, 'ai-session-stop', { codespaceId: 'existing-space-123' })
  }));
  assert.equal(stopped.result.isError, false);
  assert.equal(stopped.result.structuredContent.result.stopRequested, true);
  assert.equal(stopped.result.structuredContent.result.stopped, true);
  assert.equal(stopped.result.structuredContent.result.state, 'Shutdown');
  assert.equal(stopped.result.structuredContent.result.cancelledAsyncJobs, 1);
  assert.equal(fake.execution.snapshot().state, 'cancelled');
  assert.equal(commands.some((args) => args[0] === 'codespace' && args[1] === 'stop' && args[2] === '-c' && args[3] === 'existing-space-123'), true);

  const copied = await server(request(5, 'tools/call', {
    name: 'copy_to_codespace',
    arguments: isolatedArguments(root, 'ai-session-stop', {
      codespaceId: 'existing-space-123',
      sourceDirectory: root,
      paths: ['alpha.txt'],
      remoteDestination: '/workspaces/project'
    })
  }));
  assert.equal(copied.result.isError, false);
  assert.equal(copied.result.structuredContent.result.reusedSshReadiness, false);
  assert.equal(commands.filter((args) => args[0] === 'codespace' && args[1] === 'ssh' && args.at(-1) === 'echo started').length, 1);
});

test('codespace roots only lists immediate /workspaces directories and git_root stays below /workspaces', async () => {
  const { createServer } = await importCodespace({ suffix: 'roots' });
  const calls = [];
  const server = createServer({ execute: async (args, options = {}) => {
    calls.push({ args, options });
    const command = args.at(-1);
    if (command === 'find /workspaces -mindepth 1 -maxdepth 1 -type d -print0') {
      return { stdout: '/workspaces/alpha\0/workspaces/beta\0', stderr: '', exitCode: 0 };
    }
    if (typeof command === 'string' && command.includes('realpath --')) {
      return { stdout: '/workspaces/alpha/src\n', stderr: '', exitCode: 0 };
    }
    if (typeof command === 'string' && command.includes('git -C')) {
      return { stdout: '/workspaces/alpha\n', stderr: '', exitCode: 0 };
    }
    throw new Error(`unexpected command: ${JSON.stringify(args)}`);
  } });
  await server(request(1, 'initialize'));
  const roots = await server(request(2, 'tools/call', { name: 'roots', arguments: { codespaceId: 'existing-space-123' } }));
  assert.deepEqual(roots.result.structuredContent.result.roots, ['/workspaces/alpha', '/workspaces/beta']);
  const gitRoot = await server(request(3, 'tools/call', { name: 'git_root', arguments: { codespaceId: 'existing-space-123', path: '/workspaces/alpha/src' } }));
  assert.equal(gitRoot.result.isError, false);
  assert.equal(gitRoot.result.structuredContent.result.gitRoot, '/workspaces/alpha');
  assert.equal(calls.some(({ args }) => args.includes('/')), false);
});

test('codespace search_text rejects broad roots and keeps hostile query/glob data out of the remote shell command', async () => {
  const { createServer } = await importCodespace({ suffix: 'search-injection' });
  const calls = [];
  const hostileQuery = `\"'!@$(id)\`whoami\``;
  const hostileGlob = `src/**/!@'\"*.js`;
  const server = createServer({ execute: async (args, options = {}) => {
    calls.push({ args, options });
    const command = args.at(-1);
    if (typeof command === 'string' && command.includes('realpath --')) {
      return { stdout: '/workspaces/project\n', stderr: '', exitCode: 0 };
    }
    if (command === 'rg --version') return { stdout: 'ripgrep 14.1.1\n', stderr: '', exitCode: 0 };
    if (typeof command === 'string' && command.includes('args=(--json')) {
      return {
        stdout: `${JSON.stringify({ type: 'match', data: { path: { text: '/workspaces/project/src/a.js' }, lines: { text: 'match line\\n' }, line_number: 7, submatches: [{ start: 2, end: 7, match: { text: 'match' } }] } })}\n`,
        stderr: '',
        exitCode: 0
      };
    }
    throw new Error(`unexpected command: ${JSON.stringify(args)}`);
  } });
  await server(request(1, 'initialize'));
  for (const searchBase of ['/', '/workspaces', '/etc']) {
    const rejected = await server(request(2, 'tools/call', { name: 'search_text', arguments: { codespaceId: 'existing-space-123', searchBase, query: 'x' } }));
    assert.equal(rejected.result.isError, true);
  }
  assert.equal(calls.length, 0);

  const result = await server(request(3, 'tools/call', {
    name: 'search_text',
    arguments: { codespaceId: 'existing-space-123', searchBase: '/workspaces/project', query: hostileQuery, globs: [hostileGlob], maxResults: 10 }
  }));
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.result.matches[0].line, 7);
  assert.equal(result.result.structuredContent.result.matches[0].column, 3);
  const shellCommands = calls.map(({ args }) => String(args.at(-1)));
  assert.equal(shellCommands.some((command) => command.includes(hostileQuery)), false);
  assert.equal(shellCommands.some((command) => command.includes(hostileGlob)), false);
  const searchCall = calls.find(({ args }) => typeof args.at(-1) === 'string' && args.at(-1).includes('args=(--json'));
  assert.ok(searchCall);
  assert.equal(searchCall.options.stdinText.includes(Buffer.from(hostileQuery, 'utf8').toString('base64')), true);
  assert.equal(searchCall.options.stdinText.includes(Buffer.from(hostileGlob, 'utf8').toString('base64')), true);
});

test('codespace install_ripgrep does nothing when rg exists and otherwise uses only fixed apt commands', async () => {
  const { createServer } = await importCodespace({ suffix: 'install-ripgrep' });
  const existingCalls = [];
  const existingServer = createServer({ execute: async (args) => {
    existingCalls.push(args);
    return { stdout: 'ripgrep 14.1.1\n', stderr: '', exitCode: 0 };
  } });
  await existingServer(request(1, 'initialize'));
  const existing = await existingServer(request(2, 'tools/call', { name: 'install_ripgrep', arguments: { codespaceId: 'existing-space-123' } }));
  assert.equal(existing.result.structuredContent.result.installed, false);
  assert.deepEqual(existingCalls.map((args) => args.at(-1)), ['rg --version']);

  const installCalls = [];
  let versionAttempts = 0;
  const installServer = createServer({ execute: async (args) => {
    installCalls.push(args);
    const command = args.at(-1);
    if (command === 'rg --version') {
      versionAttempts += 1;
      if (versionAttempts === 1) throw new Error('rg: command not found');
      return { stdout: 'ripgrep 14.1.1\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  } });
  await installServer(request(3, 'initialize'));
  const installed = await installServer(request(4, 'tools/call', { name: 'install_ripgrep', arguments: { codespaceId: 'existing-space-123' } }));
  assert.equal(installed.result.structuredContent.result.installed, true);
  assert.equal(installCalls.length, 3);
  assert.equal(installCalls[0].at(-1), 'rg --version');
  assert.equal(installCalls[1].at(-1).startsWith('bash -c '), true);
  assert.equal(installCalls[2].at(-1), 'rg --version');
});

test('codespace SSH rejects shell metacharacters and never accepts a raw shell string', async () => {
  const { createServer } = await importCodespace({ suffix: 'ssh-injection' });
  let executions = 0;
  const server = createServer({ execute: async () => { executions += 1; return { stdout: '', stderr: '', exitCode: 0 }; } });
  await server(request(1, 'initialize'));
  const payloads = [
    ['printf', 'hello world'],
    ['printf', '"boom"'],
    ['printf', "'boom'"],
    ['printf', '!boom'],
    ['printf', '@boom'],
    ['printf', '$HOME'],
    ['printf', 'x;y'],
    ['printf', 'x&&y'],
    ['printf', '`id`']
  ];
  for (const [index, command] of payloads.entries()) {
    const reply = await server(request(10 + index, 'tools/call', { name: 'ssh', arguments: { codespaceId: 'existing-space-123', command } }));
    assert.equal(reply.result.isError, true);
  }
  const raw = await server(request(30, 'tools/call', { name: 'ssh', arguments: { codespaceId: 'existing-space-123', command: 'uname -a' } }));
  assert.equal(raw.result.isError, true);
  assert.equal(executions, 0);
});

test('codespace SSH joins only validated tokens into the one unavoidable remote command string', async () => {
  const { createServer } = await importCodespace({ suffix: 'ssh-safe' });
  const commands = [];
  const server = createServer({ execute: async (args) => { commands.push(args); return { stdout: 'ok', stderr: '', exitCode: 0 }; } });
  await server(request(1, 'initialize'));
  const reply = await server(request(2, 'tools/call', {
    name: 'ssh',
    arguments: { codespaceId: 'existing-space-123', command: ['node', '--version'] }
  }));
  assert.equal(reply.result.isError, false);
  assert.deepEqual(commands, [['codespace', 'ssh', '-c', 'existing-space-123', 'node --version']]);
});

test('codespace uses an internally supplied transient SSH key while normal .ssh copy paths remain denied', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codespace-internal-ssh-key-root-')));
  const sshDirectory = join(root, '.ssh');
  await mkdir(sshDirectory);
  await writeFile(join(sshDirectory, 'do-not-copy'), 'blocked', 'utf8');
  const internalSshKey = join(tmpdir(), 'local-mcp-codespace-internal-key');
  const { createServer } = await importCodespace({
    roots: [root],
    disallowedPathGlobs: ['**.ssh**'],
    suffix: 'internal-ssh-key'
  });
  const commands = [];
  const server = createServer({
    sshKeyProvider: async () => internalSshKey,
    execute: async (args) => { commands.push(args); return { stdout: 'ok', stderr: '', exitCode: 0 }; }
  });
  await server(request(1, 'initialize'));
  const reply = await server(request(2, 'tools/call', {
    name: 'ssh',
    arguments: { codespaceId: 'existing-space-123', command: ['node', '--version'] }
  }));
  assert.equal(reply.result.isError, false);
  assert.deepEqual(commands, [[
    'codespace', 'ssh', '-c', 'existing-space-123', '--', '-i', internalSshKey, 'node --version'
  ]]);

  const copyDenied = await server(request(3, 'tools/call', {
    name: 'copy_to_codespace',
    arguments: {
      codespaceId: 'existing-space-123',
      sourceDirectory: root,
      paths: ['.ssh/do-not-copy'],
      remoteDestination: '/workspaces/project'
    }
  }));
  assert.equal(copyDenied.result.isError, true);
  assert.equal(commands.length, 1);
});

test('codespace copy takes many local paths to one remote directory and always uses -e', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codespace-copy-')));
  await writeFile(join(root, 'alpha.txt'), 'alpha', 'utf8');
  await writeFile(join(root, 'beta.txt'), 'beta', 'utf8');
  const { createServer } = await importCodespace({ roots: [root], suffix: 'copy-paths' });
  const internalSshKey = join(tmpdir(), 'local-mcp-codespace-copy-key');
  const commands = [];
  const server = createServer({
    sshKeyProvider: async () => internalSshKey,
    execute: async (args) => {
      commands.push(args);
      if (args[0] === 'codespace' && args[1] === 'ssh') return { stdout: 'started\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  });
  await server(request(1, 'initialize'));
  const reply = await server(request(2, 'tools/call', {
    name: 'copy_to_codespace',
    arguments: {
      codespaceId: 'existing-space-123',
      sourceDirectory: root,
      paths: ['alpha.txt', 'beta.txt'],
      remoteDestination: '/workspaces/project'
    }
  }));
  assert.equal(reply.result.isError, false);
  assert.deepEqual(commands[0], ['codespace', 'ssh', '-c', 'existing-space-123', '--', '-i', internalSshKey, 'echo started']);
  assert.equal(reply.result.structuredContent.result.sshReady, true);
  assert.equal(reply.result.structuredContent.result.startupStdout, 'started\n');
  assert.equal(reply.result.structuredContent.result.reusedSshReadiness, false);
  assert.equal(commands[1][0], 'codespace');
  assert.equal(commands[1][1], 'cp');
  assert.equal(commands[1].includes('-e'), true);
  assert.equal(commands[1].includes('-i'), true);
  assert.equal(commands[1].includes(internalSshKey), true);
  assert.equal(commands[1].includes('-r'), false);
  assert.equal(commands[1].includes(join(root, 'alpha.txt')), true);
  assert.equal(commands[1].includes(join(root, 'beta.txt')), true);
  assert.equal(commands[1].at(-1), 'remote:/workspaces/project/');

  const second = await server(request(3, 'tools/call', {
    name: 'copy_to_codespace',
    arguments: {
      codespaceId: 'existing-space-123',
      sourceDirectory: root,
      paths: ['alpha.txt'],
      remoteDestination: '/workspaces/project'
    }
  }));
  assert.equal(second.result.isError, false);
  assert.equal(second.result.structuredContent.result.reusedSshReadiness, true);
  assert.equal(commands.filter((args) => args[0] === 'codespace' && args[1] === 'ssh').length, 1);
  assert.equal(commands[2][1], 'cp');
});

test('codespace copy supports directory-scoped glob selection and performs an SSH readiness probe before the first copy', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codespace-glob-')));
  await writeFile(join(root, 'alpha.js'), 'a', 'utf8');
  await writeFile(join(root, 'ignore.txt'), 'b', 'utf8');
  const { createServer } = await importCodespace({ roots: [root], suffix: 'copy-glob' });
  const commands = [];
  const server = createServer({
    execute: async (args) => {
      commands.push(args);
      if (args[0] === 'codespace' && args[1] === 'ssh') return { stdout: 'started\n', stderr: '', exitCode: 0 };
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  });
  await server(request(1, 'initialize'));
  const reply = await server(request(2, 'tools/call', {
    name: 'copy_to_codespace',
    arguments: {
      codespaceId: 'existing-space-123',
      sourceDirectory: root,
      globs: ['*.js'],
      remoteDestination: '~/incoming'
    }
  }));
  assert.equal(reply.result.isError, false);
  assert.deepEqual(commands[0], ['codespace', 'ssh', '-c', 'existing-space-123', 'echo started']);
  assert.equal(reply.result.structuredContent.result.startupStdout, 'started\n');
  assert.equal(commands[1].includes(join(root, 'alpha.js')), true);
  assert.equal(commands[1].includes(join(root, 'ignore.txt')), false);
  assert.equal(commands[1].at(-1), 'remote:~/incoming/');
});

test('codespace copy rejects transfers at or above the configured byte limit before gh cp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codespace-size-'));
  await writeFile(join(root, 'ten.bin'), Buffer.alloc(10));
  const { createServer } = await importCodespace({ roots: [root], maxTransferBytes: 10, suffix: 'copy-limit' });
  let executions = 0;
  const server = createServer({ execute: async () => { executions += 1; return { stdout: '', stderr: '', exitCode: 0 }; } });
  await server(request(1, 'initialize'));
  const reply = await server(request(2, 'tools/call', {
    name: 'copy_to_codespace',
    arguments: { codespaceId: 'existing-space-123', sourceDirectory: root, paths: ['ten.bin'], remoteDestination: '/tmp/incoming' }
  }));
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.structuredContent.error, /meets or exceeds CODESPACE_MCP_MAX_TRANSFER_BYTES=10/);
  assert.equal(executions, 0);
});

test('codespace copy rejects remote shell expansion characters even though gh cp uses -e', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codespace-remote-path-'));
  await writeFile(join(root, 'a.txt'), 'a', 'utf8');
  const { createServer } = await importCodespace({ roots: [root], suffix: 'remote-injection' });
  let executions = 0;
  const server = createServer({ execute: async () => { executions += 1; return { stdout: '', stderr: '', exitCode: 0 }; } });
  await server(request(1, 'initialize'));
  for (const remoteDestination of ['/tmp/"x"', "/tmp/'x'", '/tmp/!x', '/tmp/@x', '/tmp/$HOME', '/tmp/`id`', '/tmp/x;y']) {
    const reply = await server(request(2, 'tools/call', {
      name: 'copy_to_codespace',
      arguments: { codespaceId: 'existing-space-123', sourceDirectory: root, paths: ['a.txt'], remoteDestination }
    }));
    assert.equal(reply.result.isError, true);
  }
  assert.equal(executions, 0);
});

test('codespace temporary public deployment tools list, publish, return complete browseUrl, and close public access by restoring private visibility', async () => {
  const { createServer } = await importCodespace({ suffix: 'github-forwarded-port' });
  const commands = [];
  let visibility = 'private';
  const server = createServer({
    execute: async (args) => {
      commands.push(args);
      if (args[0] === 'codespace' && args[1] === 'view') return { stdout: 'Available\n', stderr: '', exitCode: 0 };
      if (args[0] === 'codespace' && args[1] === 'ports' && args[2] === 'visibility') {
        visibility = args[3].endsWith(':public') ? 'public' : 'private';
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'codespace' && args[1] === 'ports') {
        return {
          stdout: JSON.stringify([{ sourcePort: 3000, browseUrl: 'https://existing-space-123-3000.app.github.dev/', visibility, label: 'web' }]),
          stderr: '',
          exitCode: 0
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  });
  await server(request(1, 'initialize'));
  const listed = await server(request(2, 'tools/call', {
    name: 'list_temporary_public_deployments',
    arguments: { codespaceId: 'existing-space-123' }
  }));
  assert.equal(listed.result.isError, false);
  assert.equal(listed.result.structuredContent.result.deployments[0].port, 3000);
  assert.equal(listed.result.structuredContent.result.deployments[0].visibility, 'private');

  const opened = await server(request(3, 'tools/call', {
    name: 'open_temporary_public_deployment',
    arguments: { codespaceId: 'existing-space-123', port: 3000 }
  }));
  assert.equal(opened.result.isError, false);
  assert.equal(opened.result.structuredContent.result.url, 'https://existing-space-123-3000.app.github.dev/');
  assert.equal(opened.result.structuredContent.result.visibility, 'public');
  assert.equal(commands.some((args) => args.join(' ') === 'codespace ports visibility 3000:public -c existing-space-123'), true);

  const closed = await server(request(4, 'tools/call', {
    name: 'close_temporary_public_deployment',
    arguments: { codespaceId: 'existing-space-123', port: 3000 }
  }));
  assert.equal(closed.result.isError, false);
  assert.equal(closed.result.structuredContent.result.closedPublicAccess, true);
  assert.equal(closed.result.structuredContent.result.visibility, 'private');
  assert.equal(commands.some((args) => args.join(' ') === 'codespace ports visibility 3000:private -c existing-space-123'), true);
});

test('codespace temporary public deployment refuses to auto-detect or invent a GitHub port entry when the requested port is unavailable', async () => {
  const { createServer } = await importCodespace({ suffix: 'missing-forwarded-port' });
  const commands = [];
  const server = createServer({ execute: async (args) => {
    commands.push(args);
    if (args[0] === 'codespace' && args[1] === 'view') return { stdout: 'Available\n', stderr: '', exitCode: 0 };
    if (args[0] === 'codespace' && args[1] === 'ports') return { stdout: '[]', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: '', exitCode: 0 };
  } });
  await server(request(1, 'initialize'));
  const listed = await server(request(2, 'tools/call', { name: 'list_temporary_public_deployments', arguments: { codespaceId: 'existing-space-123' } }));
  assert.equal(listed.result.isError, true);
  assert.match(listed.result.structuredContent.error, /not a localhost or local-listening-port auto-detection result/);
  assert.match(listed.result.structuredContent.error, /does not guess a port or synthesize a deployment URL/);
  const reply = await server(request(3, 'tools/call', { name: 'open_temporary_public_deployment', arguments: { codespaceId: 'existing-space-123', port: 3000 } }));
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.structuredContent.error, /does not scan localhost or auto-detect ports/);
  assert.equal(commands.some((args) => args.includes('3000:public')), false);
});
