import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dirname } from 'node:path';
import test from 'node:test';
import { CodexAppServerSandboxedProcess, codexAppServerInternals } from '../app/codex-app-server.mjs';
import {
  CodexWindowsSandboxedProcess,
  codexWindowsSandboxLaunchSpec,
  codexWindowsSandboxInternals
} from '../app/codex-windows-sandbox.mjs';

function fakeAppServer({ holdWrites = false } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    if (child.killed) return false;
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  };

  let input = '';
  let execRequest = null;
  const writeRequests = [];
  const pendingWriteRequests = [];
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => {
    input += chunk;
    while (true) {
      const newline = input.indexOf('\n');
      if (newline < 0) break;
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === 'command/exec') {
        execRequest = message;
        continue;
      }
      if (message.method === 'command/exec/write') {
        writeRequests.push(message);
        if (holdWrites) pendingWriteRequests.push(message);
        else child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
        continue;
      }
      if (Object.hasOwn(message, 'id')) {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      }
    }
  });

  return {
    child,
    execRequest: () => execRequest,
    writeRequests: () => [...writeRequests],
    resolveNextWrite() {
      const request = pendingWriteRequests.shift();
      if (!request) throw new Error('no pending command/exec/write request');
      child.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    },
    resolveExec(result) {
      if (!execRequest) throw new Error('command/exec was not requested');
      child.stdout.write(`${JSON.stringify({ id: execRequest.id, result })}\n`);
    },
    notify(method, params) {
      child.stdout.write(`${JSON.stringify({ method, params })}\n`);
    }
  };
}

test('Codex app-server launches an explicit Windows npm .cmd shim through cmd.exe', () => {
  const permissionProfileOverride = "permissions.local_mcp_gateway={filesystem={':minimal'='read','C:\\work'='write'},network={enabled=false}}";
  const launch = codexAppServerInternals.codexAppServerLaunchSpec(
    'C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd',
    'C:\\work',
    {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      permissionProfileOverride
    }
  );
  assert.equal(launch.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(launch.args, [
    '/d',
    '/v:off',
    '/s',
    '/c',
    `""C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd" -c "${permissionProfileOverride}" app-server --listen stdio://"`
  ]);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsVerbatimArguments, true);
});

test('Windows MCP sandbox uses codex sandbox with inherited stdio instead of streaming command/exec', () => {
  const childEnvironment = {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    LOCAL_MCP_ALLOWED_DIRECTORIES: '["C:\\\\work"]'
  };
  const launch = codexWindowsSandboxLaunchSpec(
    'C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd',
    {
      name: 'files',
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\repo\\mcp\\safe-files\\server.mjs'],
      cwd: 'C:\\work',
      sandbox: 'elevated',
      allowedDirectories: ['C:\\work'],
      allowedFiles: [],
      sandboxReadOnlyDirectories: [],
      isBundled: false
    },
    childEnvironment
  );

  assert.equal(launch.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(launch.options.env, childEnvironment);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsVerbatimArguments, true);
  assert.equal(launch.args[0], '/d');
  assert.equal(launch.args[1], '/v:off');
  assert.equal(launch.args[2], '/s');
  assert.equal(launch.args[3], '/c');
  assert.equal(
    launch.args[4],
    `""C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd" "-c" "permissions.local_mcp_gateway={filesystem={':minimal'='read','C:\\Program Files\\nodejs'='read','C:\\repo\\mcp\\safe-files'='read','C:\\work'='write'},network={enabled=false}}" "-c" "windows.sandbox='elevated'" "-c" "${codexWindowsSandboxInternals.SANITIZED_CHILD_ENVIRONMENT_OVERRIDE}" "sandbox" "--permission-profile" "local_mcp_gateway" "-C" "C:\\work" "--" "C:\\Program Files\\nodejs\\node.exe" "C:\\repo\\mcp\\safe-files\\server.mjs""`
  );
});

test('Windows Codex sandbox process carries MCP JSON-RPC bidirectionally over inherited stdio', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0, null);
    return true;
  };

  let childInput = '';
  let gatewayOutput = '';
  child.stdin.setEncoding('utf8');
  child.stdin.on('data', (chunk) => { childInput += chunk; });
  const sandboxed = new CodexWindowsSandboxedProcess({
    name: 'files',
    codexExecutable: 'C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd',
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\repo\\mcp\\safe-files\\server.mjs'],
    cwd: 'C:\\work',
    sandbox: 'elevated',
    allowedDirectories: ['C:\\work']
  }, {
    env: { PATH: 'C:\\Windows\\System32' },
    canonicalize: async (path) => path,
    spawnSandbox: () => child,
    onStdout: (chunk) => { gatewayOutput += chunk; },
    stderr: new PassThrough()
  });

  await sandboxed.start();
  sandboxed.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"safe-files"}}}\n');
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(childInput, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  assert.equal(gatewayOutput, '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"safe-files"}}}\n');
  child.exitCode = 7;
  child.emit('exit', 7, null);
  assert.deepEqual(await sandboxed.waitForExit(), { exitCode: 7, signal: null });
  await sandboxed.close();
});

test('Windows Codex sandbox process enforces a bounded command timeout', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 1;
    child.emit('exit', 1, null);
    return true;
  };

  const sandboxed = new CodexWindowsSandboxedProcess({
    name: 'script-timeout',
    codexExecutable: 'C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd',
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\work\\slow.mjs'],
    cwd: 'C:\\work',
    sandbox: 'elevated',
    allowedDirectories: ['C:\\work'],
    commandTimeoutMs: 10
  }, {
    env: { PATH: 'C:\\Windows\\System32' },
    canonicalize: async (path) => path,
    spawnSandbox: () => child,
    stderr: new PassThrough()
  });

  await sandboxed.start();
  await assert.rejects(sandboxed.waitForExit(), /timed out after 10ms/);
  assert.equal(child.killed, true);
  await sandboxed.close();
});

test('Codex app-server builds a restricted temporary permission profile for the child MCP', () => {
  const override = codexAppServerInternals.permissionProfileOverrideFor({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\tools\\safe-files\\server.mjs'],
    allowedDirectories: ['C:\\workspace', 'C:\\repo'],
    allowedFiles: ['C:\\inputs\\one.txt'],
    sandboxReadOnlyDirectories: ['C:\\readonly'],
    sandboxDeniedDirectories: ['C:\\workspace\\blocked'],
    sandboxDeniedFiles: ['C:\\repo\\private.txt'],
    isBundled: false
  });
  assert.equal(override.startsWith('permissions.local_mcp_gateway={filesystem={'), true);
  assert.equal(override.includes("':minimal'='read'"), true);
  assert.equal(override.includes("'C:\\workspace'='write'"), true);
  assert.equal(override.includes("'C:\\repo'='write'"), true);
  assert.equal(override.includes("'C:\\inputs\\one.txt'='read'"), true);
  assert.equal(override.includes("'C:\\readonly'='read'"), true);
  assert.equal(override.includes("'C:\\Program Files\\nodejs'='read'"), true);
  assert.equal(override.includes("'C:\\tools\\safe-files'='read'"), true);
  assert.equal(override.includes("'C:\\workspace\\blocked'='deny'"), true);
  assert.equal(override.includes("'C:\\repo\\private.txt'='deny'"), true);
  assert.equal(override.endsWith('},network={enabled=false}}'), true);
});

test('Codex permission profile does not narrow a writable parent with redundant read-only child entries', () => {
  const override = codexAppServerInternals.permissionProfileOverrideFor({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\repo\\mcp\\safe-files\\server.mjs'],
    allowedDirectories: ['C:\\repo'],
    allowedFiles: [],
    sandboxReadOnlyDirectories: ['C:\\repo\\readonly-helper'],
    isBundled: false
  });
  assert.equal(override.includes("'C:\\repo'='write'"), true);
  assert.equal(override.includes("'C:\\repo\\mcp\\safe-files'='read'"), false);
  assert.equal(override.includes("'C:\\repo\\readonly-helper'='read'"), false);
});

test('Codex permission profile grants an internal Codespace runtime write root without exposing it as a workspace root', () => {
  const override = codexAppServerInternals.permissionProfileOverrideFor({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\repo\\mcp\\codespace\\server.mjs'],
    allowedDirectories: ['C:\\repo'],
    allowedFiles: [],
    sandboxInternalWritableDirectories: ['C:\\Temp\\local-mcp-codespace-ssh-123'],
    sandboxReadOnlyFiles: ['C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe'],
    isBundled: true
  });
  assert.equal(override.includes("'C:\\repo'='write'"), true);
  assert.equal(override.includes("'C:\\Temp\\local-mcp-codespace-ssh-123'='write'"), true);
  assert.equal(override.includes("'C:\\Windows\\System32\\OpenSSH\\ssh-keygen.exe'='read'"), true);
});

test('onlineworkspace permission profile enables network without widening filesystem roots', () => {
  const override = codexAppServerInternals.permissionProfileOverrideFor({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\repo\\mcp\\internet\\server.mjs'],
    allowedDirectories: ['C:\\workspace'],
    allowedFiles: [],
    sandboxReadOnlyDirectories: [],
    isBundled: true,
    sandbox: 'onlineworkspace'
  });
  assert.equal(override.includes("'C:\\workspace'='write'"), true);
  assert.equal(override.includes("'C:\\repo'='write'"), false);
  assert.equal(override.endsWith('},network={enabled=true}}'), true);
});

test('Codex app-server forwards streamed text deltas without dropping MCP stdout', async () => {
  const fake = fakeAppServer();
  let stdout = '';
  let stdoutAtExit = null;
  const sandboxed = new CodexAppServerSandboxedProcess({
    name: 'utf8-test',
    command: process.execPath,
    codexExecutable: process.execPath,
    args: ['server.mjs'],
    cwd: process.cwd(),
    sandbox: 'never',
    allowedDirectories: [process.cwd()]
  }, {
    spawnAppServer: () => fake.child,
    onStdout: (chunk) => { stdout += chunk; },
    onExit: () => { stdoutAtExit = stdout; },
    stderr: new PassThrough()
  });

  await sandboxed.start();
  fake.notify('command/exec/outputDelta', {
    processId: sandboxed.processId,
    stream: 'stdout',
    delta: '{"jsonrpc":"2.0",'
  });
  fake.notify('command/exec/outputDelta', {
    processId: sandboxed.processId,
    stream: 'stdout',
    delta: '"id":1,"result":{"serverInfo":{"name":"safe-files"}}}\n'
  });
  fake.notify('command/exec/exited', { processId: sandboxed.processId, exitCode: 0 });
  await sandboxed.closeStdin();
  fake.resolveExec({ exitCode: 0, stdout: 'must-not-be-duplicated' });

  await sandboxed.waitForExit();
  const expected = '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"safe-files"}}}\n';
  assert.equal(stdout, expected);
  assert.equal(stdoutAtExit, expected);
  await sandboxed.close();
});

test('Codex app-server keeps legacy base64 output deltas UTF-8 safe', async () => {
  const fake = fakeAppServer();
  let stdout = '';
  const sandboxed = new CodexAppServerSandboxedProcess({
    name: 'legacy-base64-test',
    command: process.execPath,
    codexExecutable: process.execPath,
    args: ['server.mjs'],
    cwd: process.cwd(),
    sandbox: 'never',
    allowedDirectories: [process.cwd()]
  }, {
    spawnAppServer: () => fake.child,
    onStdout: (chunk) => { stdout += chunk; },
    stderr: new PassThrough()
  });

  await sandboxed.start();
  const bytes = Buffer.from('あ', 'utf8');
  fake.notify('command/exec/outputDelta', {
    processId: sandboxed.processId,
    stream: 'stdout',
    deltaBase64: bytes.subarray(0, 2).toString('base64')
  });
  fake.notify('command/exec/outputDelta', {
    processId: sandboxed.processId,
    stream: 'stdout',
    deltaBase64: bytes.subarray(2).toString('base64')
  });
  fake.resolveExec({ exitCode: 0 });
  await sandboxed.waitForExit();
  assert.equal(stdout, 'あ');
  await sandboxed.close();
});

test('Codex app-server adds a command timeout only when explicitly requested', async () => {
  const persistentFake = fakeAppServer();
  const persistent = new CodexAppServerSandboxedProcess({
    name: 'persistent-test',
    command: process.execPath,
    codexExecutable: process.execPath,
    args: ['server.mjs'],
    cwd: process.cwd(),
    sandbox: 'never',
    allowedDirectories: [process.cwd()]
  }, {
    spawnAppServer: () => persistentFake.child,
    stderr: new PassThrough()
  });
  await persistent.start();
  assert.equal(Object.hasOwn(persistentFake.execRequest().params, 'timeoutMs'), false);
  assert.equal(Object.hasOwn(persistentFake.execRequest().params, 'sandboxPolicy'), false);
  assert.equal(persistentFake.execRequest().params.permissionProfile, 'local_mcp_gateway');
  await persistent.close();

  const boundedFake = fakeAppServer();
  const bounded = new CodexAppServerSandboxedProcess({
    name: 'bounded-test',
    command: process.execPath,
    codexExecutable: process.execPath,
    args: ['script.mjs'],
    cwd: process.cwd(),
    sandbox: 'never',
    allowedDirectories: [process.cwd()],
    commandTimeoutMs: 1234
  }, {
    spawnAppServer: () => boundedFake.child,
    stderr: new PassThrough()
  });
  await bounded.start();
  assert.equal(boundedFake.execRequest().params.timeoutMs, 1234);
  await bounded.close();
});

test('Codex app-server uses final output when no stream delta was emitted', async () => {
  const fake = fakeAppServer();
  let stdout = '';
  let stderr = '';
  const sandboxed = new CodexAppServerSandboxedProcess({
    name: 'final-output-test',
    command: process.execPath,
    codexExecutable: process.execPath,
    args: ['script.mjs'],
    cwd: process.cwd(),
    sandbox: 'never',
    allowedDirectories: [process.cwd()]
  }, {
    spawnAppServer: () => fake.child,
    onStdout: (chunk) => { stdout += chunk; },
    onStderr: (chunk) => { stderr += chunk; },
    stderr: new PassThrough()
  });
  await sandboxed.start();
  fake.resolveExec({ exitCode: 0, stdout: '日本語stdout', stderr: 'stderr' });
  await sandboxed.waitForExit();
  assert.equal(stdout, '日本語stdout');
  assert.equal(stderr, 'stderr');
  await sandboxed.close();
});

test('Codex app-server serializes MCP stdin writes', async () => {
  const fake = fakeAppServer({ holdWrites: true });
  const sandboxed = new CodexAppServerSandboxedProcess({
    name: 'write-order-test',
    command: process.execPath,
    codexExecutable: process.execPath,
    args: ['server.mjs'],
    cwd: process.cwd(),
    sandbox: 'never',
    allowedDirectories: [process.cwd()]
  }, {
    spawnAppServer: () => fake.child,
    stderr: new PassThrough()
  });
  await sandboxed.start();
  sandboxed.write('first\n');
  sandboxed.write('second\n');
  const closeStdinPromise = sandboxed.closeStdin();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fake.writeRequests().length, 1);
  assert.equal(fake.writeRequests()[0].params.delta, 'first\n');
  fake.resolveNextWrite();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fake.writeRequests().length, 2);
  assert.equal(fake.writeRequests()[1].params.delta, 'second\n');
  fake.resolveNextWrite();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fake.writeRequests().length, 3);
  assert.equal(fake.writeRequests()[2].params.closeStdin, true);
  fake.resolveNextWrite();
  await closeStdinPromise;
  fake.resolveExec({ exitCode: 0 });
  await sandboxed.waitForExit();
  await sandboxed.close();
});
