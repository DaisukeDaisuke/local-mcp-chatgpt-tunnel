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

function nextLines(stream, count, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const lines = [];
    const timeout = setTimeout(() => cleanup(new Error('Timed out waiting for gateway output')), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        lines.push(JSON.parse(line));
        if (lines.length === count) cleanup(null, lines);
      }
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
  const configPath = join(configDirectory, 'gateway.toml');
  const repository = resolve('.');
  await writeFile(join(workspace, 'inside.txt'), 'inside', 'utf8');
  const config = [
    'private_use_only = true',
    '[mcp_servers.files]',
    `command = '${process.execPath}'`,
    `args = ['${resolve('mcp/safe-files/server.mjs')}']`,
    `cwd = '${workspace}'`,
    `allowed_directories = ['${workspace}']`,
    'enabled = true',
    'prefix = "files"'
  ].join('\n');
  await writeFile(configPath, `${config}\n`, 'utf8');
  const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  const initialized = await nextLine(child.stdout);
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, 'local-mcp-gateway');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const listed = await nextLine(child.stdout);
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('files__apply_patch'));
  assert.ok(names.includes('files__search_text'));
  assert.ok(names.includes('files__read_file_chunk'));
  assert.ok(names.includes('files__set_working_directory'));
  assert.ok(names.every((name) => name.startsWith('files__')));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'files__read_text_file', arguments: { path: 'inside.txt' }
  } })}\n`);
  const inside = await nextLine(child.stdout);
  assert.equal(inside.result.isError, false);
  assert.equal(inside.result.structuredContent.result.content, 'inside');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'files__read_text_file', arguments: { path: join(tmpdir(), 'outside.txt') }
  } })}\n`);
  const outside = await nextLine(child.stdout);
  assert.equal(outside.result.isError, true);
  assert.match(outside.result.content[0].text, /outside allowed_directories/);
});

test('gateway initialization survives an unavailable child MCP', async (t) => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-unavailable-'));
  const configPath = join(configDirectory, 'gateway.toml');
  const missingScript = join(configDirectory, 'missing-server.mjs');
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.missing]',
    `command = '${process.execPath}'`,
    `args = ['${missingScript}']`,
    `cwd = '${configDirectory}'`,
    'enabled = true',
    'prefix = "missing"',
    'startup_timeout_sec = 2'
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  const initialized = await nextLine(child.stdout);
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, 'local-mcp-gateway');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const listed = await nextLine(child.stdout);
  assert.deepEqual(listed.result.tools, []);
});

test('tools/list waits for concurrent initialization when a child MCP is unavailable', async (t) => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-concurrent-init-'));
  const configPath = join(configDirectory, 'gateway.toml');
  const missingScript = join(configDirectory, 'missing-server.mjs');
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.missing]',
    `command = '${process.execPath}'`,
    `args = ['${missingScript}']`,
    `cwd = '${configDirectory}'`,
    'enabled = true',
    'prefix = "missing"',
    'startup_timeout_sec = 2'
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const [initialized, listed] = await nextLines(child.stdout, 2);
  assert.equal(initialized.id, 1);
  assert.equal(initialized.result.serverInfo.name, 'local-mcp-gateway');
  assert.equal(listed.id, 2);
  assert.deepEqual(listed.result.tools, []);
});
