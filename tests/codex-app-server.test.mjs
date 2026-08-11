import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { dirname } from 'node:path';
import test from 'node:test';
import { CodexAppServerSandboxedProcess, codexAppServerInternals } from '../app/codex-app-server.mjs';

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
  const launch = codexAppServerInternals.codexAppServerLaunchSpec(
    'C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd',
    'C:\\work',
    { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } }
  );
  assert.equal(launch.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(launch.args, [
    '/d',
    '/v:off',
    '/s',
    '/c',
    '""C:\\Users\\owner\\AppData\\Roaming\\npm\\codex.cmd" app-server --listen stdio://"'
  ]);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.windowsVerbatimArguments, true);
});

test('Codex app-server transport preserves UTF-8 split across output deltas', async () => {
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
  fake.notify('command/exec/exited', { processId: sandboxed.processId, exitCode: 0 });
  await sandboxed.closeStdin();
  fake.resolveExec({ exitCode: 0, stdout: 'あ' });

  await sandboxed.waitForExit();
  assert.equal(stdout, 'あ');
  assert.equal(stdoutAtExit, 'あ');
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
  assert.equal(persistentFake.execRequest().params.sandboxPolicy.networkAccess, false);
  assert.deepEqual(persistentFake.execRequest().params.sandboxPolicy.writableRoots, [process.cwd()]);
  assert.ok(persistentFake.execRequest().params.sandboxPolicy.readOnlyAccess.readableRoots.includes(dirname(process.execPath)));
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
  assert.equal(Buffer.from(fake.writeRequests()[0].params.deltaBase64, 'base64').toString('utf8'), 'first\n');
  fake.resolveNextWrite();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(fake.writeRequests().length, 2);
  assert.equal(Buffer.from(fake.writeRequests()[1].params.deltaBase64, 'base64').toString('utf8'), 'second\n');
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
