import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { StdioMcpChild } from '../app/stdio-child.mjs';

async function environmentFixture(directory) {
  const serverPath = join(directory, 'environment-server.mjs');
  await writeFile(serverPath, `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    let reply = null;
    if (request.method === 'initialize') {
      reply = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'environment-fixture', version: '1.0.0' } } };
    } else if (request.method === 'tools/list') {
      reply = { jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'environment', inputSchema: { type: 'object' } }] } };
    } else if (request.method === 'tools/call' && request.params?.name === 'environment') {
      reply = { jsonrpc: '2.0', id: request.id, result: { disallowedFiles: JSON.parse(process.env.LOCAL_MCP_DISALLOWED_FILES ?? '[]') } };
    }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\\n');
  }
});
`, 'utf8');
  return serverPath;
}

test('stdio child passes gateway config protection only when the config is inside child file access', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'stdio-child-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'stdio-child-config-'));
  const serverPath = await environmentFixture(workspace);
  const outsideConfig = join(configDirectory, 'gateway.toml');
  const insideConfig = join(workspace, 'gateway.toml');
  await writeFile(outsideConfig, 'private_use_only = true\n', 'utf8');
  await writeFile(insideConfig, 'private_use_only = true\n', 'utf8');

  async function observedDisallowedFiles(protectedGatewayConfigPaths) {
    const child = new StdioMcpChild({
      name: 'environment-fixture',
      command: process.execPath,
      args: [serverPath],
      cwd: workspace,
      env: {},
      allowedDirectories: [workspace],
      allowedFiles: [],
      disallowedDirectories: [],
      disallowedFiles: [],
      disallowedPathGlobs: [],
      protectedGatewayConfigPaths,
      dangerousAllowGatewayConfigAccess: false,
      startupTimeoutMs: 5000,
      requestTimeoutMs: 5000
    });
    t.after(() => child.close());
    await child.start();
    const result = await child.request('tools/call', { name: 'environment', arguments: {} });
    return result.disallowedFiles;
  }

  assert.deepEqual(await observedDisallowedFiles([outsideConfig]), []);
  assert.deepEqual(await observedDisallowedFiles([insideConfig]), [insideConfig]);
});

test('stdio child includes captured stdout and stderr when a child exits during initialization', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'stdio-child-failed-start-'));
  const serverPath = join(workspace, 'failed-server.mjs');
  await writeFile(serverPath, "process.stdout.write('{\\\"jsonrpc\\\":\\\"2.0\\\",\\\"method\\\":\\\"startup/detail\\\"}\\n'); process.stderr.write('sandbox startup detail\\n'); process.exitCode = 1;\n", 'utf8');
  const child = new StdioMcpChild({
    name: 'failed-fixture',
    command: process.execPath,
    args: [serverPath],
    cwd: workspace,
    env: {},
    allowedDirectories: [workspace],
    allowedFiles: [],
    disallowedDirectories: [],
    disallowedFiles: [],
    disallowedPathGlobs: [],
    protectedGatewayConfigPaths: [],
    dangerousAllowGatewayConfigAccess: false,
    startupTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    sandbox: 'never'
  });
  t.after(() => child.close());
  await assert.rejects(child.start(), (error) => {
    assert.match(error.message, /exited \(1\)/);
    assert.match(error.message, /stdout: .*startup\/detail/);
    assert.match(error.message, /stderr: sandbox startup detail/);
    return true;
  });
});

test('stdio child points setup refresh failures at the Codex sandbox log', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'stdio-child-codex-log-'));
  const serverPath = join(workspace, 'failed-server.mjs');
  const codexHome = join(workspace, 'codex-home');
  await writeFile(serverPath, "process.stderr.write('windows sandbox failed: helper_unknown_error: setup refresh had errors\\n'); process.exitCode = 1;\n", 'utf8');
  const child = new StdioMcpChild({
    name: 'failed-codex-fixture',
    command: process.execPath,
    args: [serverPath],
    cwd: workspace,
    env: { CODEX_HOME: codexHome },
    allowedDirectories: [workspace],
    allowedFiles: [],
    disallowedDirectories: [],
    disallowedFiles: [],
    disallowedPathGlobs: [],
    protectedGatewayConfigPaths: [],
    dangerousAllowGatewayConfigAccess: false,
    startupTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    sandbox: 'never'
  });
  t.after(() => child.close());
  await assert.rejects(child.start(), (error) => {
    assert.match(error.message, /setup refresh had errors/);
    assert.match(error.message, /codex sandbox log:/);
    assert.match(error.message, /sandbox\.\d{4}-\d{2}-\d{2}\.log/);
    return true;
  });
});

test('stdio child can clear one request deadline after it is handed off to async handling', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'stdio-child-no-timeout-'));
  const serverPath = join(workspace, 'delayed-server.mjs');
  await writeFile(serverPath, `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    const send = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    if (request.method === 'initialize') send({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'delayed-fixture', version: '1.0.0' } });
    else if (request.method === 'tools/list') send({ tools: [{ name: 'delayed', inputSchema: { type: 'object' } }] });
    else if (request.method === 'tools/call') setTimeout(() => send({ ok: true }), 40);
  }
});
`, 'utf8');
  const child = new StdioMcpChild({
    name: 'delayed-fixture',
    command: process.execPath,
    args: [serverPath],
    cwd: workspace,
    env: {},
    allowedDirectories: [workspace],
    allowedFiles: [],
    disallowedDirectories: [],
    disallowedFiles: [],
    disallowedPathGlobs: [],
    protectedGatewayConfigPaths: [],
    dangerousAllowGatewayConfigAccess: false,
    startupTimeoutMs: 5000,
    requestTimeoutMs: 10,
    sandbox: 'never'
  });
  t.after(() => child.close());
  await child.start();
  await assert.rejects(
    child.request('tools/call', { name: 'delayed', arguments: {} }),
    /timed out handling tools\/call/
  );
  const controlled = child.requestWithControl('tools/call', { name: 'delayed', arguments: {} });
  assert.equal(controlled.clearDeadline(), true);
  const result = await controlled.promise;
  assert.equal(result.ok, true);
});