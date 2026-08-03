import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

function nextLine(stream, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => cleanup(new Error('Timed out waiting for gateway output')), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      cleanup(null, JSON.parse(line));
    };
    const cleanup = (error, value) => {
      clearTimeout(timeout);
      stream.off('data', onData);
      if (error) reject(error); else resolvePromise(value);
    };
    stream.setEncoding('utf8');
    stream.on('data', onData);
  });
}

test('gateway aggregates a selected local stdio MCP without model API or HTTP', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-config-'));
  const configPath = join(configDirectory, 'gateway.json');
  await writeFile(configPath, JSON.stringify({ workspaceRoots: [workspace], enabledServers: ['files'] }), 'utf8');
  const child = spawn(process.execPath, [resolve('app/gateway.mjs')], {
    cwd: resolve('.'),
    env: { ...process.env, MCP_GATEWAY_CONFIG: configPath },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  const initialized = await nextLine(child.stdout);
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, 'dq9-local-mcp-gateway');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const listed = await nextLine(child.stdout);
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('files__apply_patch'));
  assert.ok(names.includes('files__set_working_directory'));
  assert.ok(names.every((name) => name.startsWith('files__')));
});