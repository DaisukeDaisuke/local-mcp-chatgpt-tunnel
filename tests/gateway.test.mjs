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

function collectText(stream) {
  let text = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { text += chunk; });
  return {
    get value() { return text; },
    async waitFor(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(text)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for gateway stderr:\n${text}`);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      return text;
    }
  };
}

test('gateway excludes exact and substring-matched tools and logs every initialization', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-tool-filter-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-tool-filter-config-'));
  const serverPath = join(workspace, 'server.mjs');
  const configPath = join(configDirectory, 'gateway.toml');
  await writeFile(serverPath, `
const tools = [
  { name: 'plain', description: 'allowed', inputSchema: { type: 'object' } },
  { name: 'runScript', description: 'blocked by script', inputSchema: { type: 'object' } },
  { name: 'SCRIPT_debug', description: 'blocked case-insensitively', inputSchema: { type: 'object' } },
  { name: 'shell_exec', description: 'blocked by shell', inputSchema: { type: 'object' } },
  { name: 'dangerous', description: 'blocked exactly', inputSchema: { type: 'object' } }
];
let initialized = false;
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
      initialized = true;
      reply = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'filter-fixture', version: '1.0.0' } } };
    } else if (request.method === 'tools/list' && initialized) {
      reply = { jsonrpc: '2.0', id: request.id, result: { tools } };
    } else if (request.method === 'tools/call' && initialized) {
      reply = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'ok' }], isError: false } };
    }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\\n');
  }
});
`, 'utf8');
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.demo]',
    `command = '${process.execPath}'`,
    `args = ['${serverPath}']`,
    `cwd = '${workspace}'`,
    `allowed_directories = ['${workspace}']`,
    'enabled = true',
    'prefix = "demo"',
    'blocked_tools = ["dangerous"]',
    'blocked_tool_substrings = ["script", "shell"]'
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stderr = collectText(child.stderr);
  t.after(() => child.kill());

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  await nextLine(child.stdout);
  await stderr.waitFor((text) => (text.match(/INFO tool exposure: found=5 disabled=4 published=1/g) ?? []).length >= 1);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  await nextLine(child.stdout);
  await stderr.waitFor((text) => (text.match(/INFO tool exposure: found=5 disabled=4 published=1/g) ?? []).length >= 2);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`);
  const listed = await nextLine(child.stdout);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['demo__plain']);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'demo__runScript', arguments: {} } })}\n`);
  const blockedCall = await nextLine(child.stdout);
  assert.equal(blockedCall.error.code, -32602);
  assert.match(blockedCall.error.message, /Unknown tool/);

  const log = stderr.value;
  assert.equal((log.match(/INFO tool disabled:/g) ?? []).length, 8);
  assert.match(log, /tool="runScript".*blocked_tool_substrings="script"/);
  assert.match(log, /tool="SCRIPT_debug".*blocked_tool_substrings="script"/);
  assert.match(log, /tool="shell_exec".*blocked_tool_substrings="shell"/);
  assert.match(log, /tool="dangerous".*blocked_tools exact match/);
});

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
  assert.ok(names.includes('files__list_files'));
  assert.ok(names.includes('files__search_text'));
  assert.ok(names.includes('files__read_file_chunk'));
  assert.ok(names.includes('files__set_working_directory'));
  assert.ok(names.every((name) => name.startsWith('files__')));
  assert.ok(listed.result.tools.every((tool) => tool.outputSchema?.type === 'object'));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { path: 'inside.txt' }
  } })}\n`);
  const inside = await nextLine(child.stdout);
  assert.equal(inside.result.isError, false);
  assert.equal(inside.result.structuredContent.result.results[0].content, 'inside');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { path: join(tmpdir(), 'outside.txt') }
  } })}\n`);
  const outside = await nextLine(child.stdout);
  assert.equal(outside.result.isError, true);
  assert.match(outside.result.content[0].text, /outside allowed_directories/);

  const colonEscape = process.platform === 'win32'
    ? join(tmpdir(), 'outside-colon.txt')
    : `${join(tmpdir(), 'outside-colon.txt')}:alternate`;
  const escapePaths = [
    '../outside.txt',
    './../outside.txt',
    'nested/../../outside.txt',
    '../outside.txt;ignored',
    colonEscape
  ];
  for (const [index, path] of escapePaths.entries()) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5 + index, method: 'tools/call', params: {
      name: 'files__read_text',
      arguments: {
        reads: [
          { path, startLine: 1, endLine: 10 },
          { path: 'inside.txt' }
        ],
        format: 'annotated'
      }
    } })}\n`);
    const escaped = await nextLine(child.stdout);
    assert.equal(escaped.result.isError, true, `escape path should be rejected: ${path}`);
    assert.match(escaped.result.content[0].text, /files\.read_text path argument reads\[0\]\.path/);
    assert.match(escaped.result.content[0].text, /outside allowed_directories and allowed_files/);
  }
});

test('gateway applies empty allowlists and disallowed path globs to nested read_text batches', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-read-text-policy-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-read-text-policy-config-'));
  const configPath = join(configDirectory, 'gateway.toml');
  await writeFile(join(workspace, 'public.txt'), 'alpha\nbeta\n', 'utf8');
  const config = [
    'private_use_only = true',
    '[mcp_servers.files]',
    `command = '${process.execPath}'`,
    `args = ['${resolve('mcp/safe-files/server.mjs')}']`,
    `cwd = '${workspace}'`,
    'allowed_directories = []',
    'allowed_files = []',
    'disallowed_directories = []',
    'disallowed_files = []',
    "disallowed_path_globs = ['**.ssh**']",
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
  await nextLine(child.stdout);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'files__read_text',
    arguments: {
      reads: [
        { path: 'public.txt', startLine: 1, endLine: 999 },
        { path: 'second.txt' },
        { path: 'nested/third.md', startLine: 30, endLine: 60 }
      ],
      format: 'annotated'
    }
  } })}\n`);
  const noAllowlist = await nextLine(child.stdout);
  assert.equal(noAllowlist.result.isError, true);
  assert.match(noAllowlist.result.content[0].text, /files\.read_text path argument reads\[0\]\.path/);
  assert.match(noAllowlist.result.content[0].text, /outside allowed_directories and allowed_files/);
  assert.match(noAllowlist.result.content[0].text, /public\.txt/);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'files__read_text',
    arguments: {
      reads: [
        { path: '.ssh/project-notes.txt', startLine: 1, endLine: 20 },
        { path: 'public.txt' }
      ],
      format: 'annotated'
    }
  } })}\n`);
  const disallowedGlob = await nextLine(child.stdout);
  assert.equal(disallowedGlob.result.isError, true);
  assert.match(disallowedGlob.result.content[0].text, /files\.read_text path argument reads\[0\]\.path/);
  assert.match(disallowedGlob.result.content[0].text, /glob filter disallowed_path_globs/);
  assert.match(disallowedGlob.result.content[0].text, /\*\*\.ssh\*\*/);
  assert.match(disallowedGlob.result.content[0].text, /\.ssh/);
});

test('gateway preserves safe-download outputSchema and embedded ZIP resource content', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-download-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-download-config-'));
  const configPath = join(configDirectory, 'gateway.toml');
  await writeFile(join(workspace, 'server.mjs'), 'export const value = 1;\n', 'utf8');
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.downloads]',
    `command = '${process.execPath}'`,
    `args = ['${resolve('mcp/safe-download/server.mjs')}']`,
    `cwd = '${workspace}'`,
    `allowed_directories = ['${workspace}']`,
    'enabled = true',
    'prefix = "downloads"'
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  await nextLine(child.stdout);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const listed = await nextLine(child.stdout);
  const tool = listed.result.tools.find((candidate) => candidate.name === 'downloads__download_zip');
  assert.equal(tool.outputSchema.type, 'object');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'downloads__download_zip', arguments: { path: 'server.mjs', archiveName: 'server.zip' }
  } })}\n`);
  const downloaded = await nextLine(child.stdout);
  assert.equal(downloaded.result.isError, false);
  const resource = downloaded.result.content.find((part) => part.type === 'resource');
  assert.equal(resource.resource.mimeType, 'application/zip');
  assert.equal(Buffer.from(resource.resource.blob, 'base64').readUInt32LE(0), 0x04034b50);
  assert.equal(Object.hasOwn(downloaded.result.structuredContent.result, 'blob'), false);
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

test('optional gateway tool directory returns full names, prefix matches, counts, and disabled proxy names', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-tool-directory-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-tool-directory-config-'));
  const serverPath = join(workspace, 'server.mjs');
  const configPath = join(configDirectory, 'gateway.toml');
  await writeFile(serverPath, `
const tools = [
  { name: 'plain', description: 'Allowed tool overview', inputSchema: { type: 'object' } },
  { name: 'dangerous', description: 'Must not be exposed', inputSchema: { type: 'object' } }
];
let initialized = false;
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
      initialized = true;
      reply = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'directory-fixture', version: '1.0.0' } } };
    } else if (request.method === 'tools/list' && initialized) {
      reply = { jsonrpc: '2.0', id: request.id, result: { tools } };
    }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\\n');
  }
});
`, 'utf8');
  await writeFile(configPath, [
    'private_use_only = true',
    'publish_tool_directory = true',
    '[mcp_servers.demo]',
    `command = '${process.execPath}'`,
    `args = ['${serverPath}']`,
    `cwd = '${workspace}'`,
    `allowed_directories = ['${workspace}']`,
    'enabled = true',
    'prefix = "demo"',
    'blocked_tools = ["dangerous"]',
    '[mcp_servers.offline]',
    'enabled = false'
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  await nextLine(child.stdout);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const listed = await nextLine(child.stdout);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['gateway__list_available_tools', 'demo__plain']);
  assert.deepEqual(listed.result.tools[0].annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'gateway__list_available_tools', arguments: { prefix: 'DEMO__PL' }
  } })}\n`);
  const filtered = await nextLine(child.stdout);
  assert.equal(filtered.result.isError, false);
  assert.deepEqual(filtered.result.structuredContent, {
    tools: [{ name: 'demo__plain', description: 'Allowed tool overview' }],
    availableToolCount: 1,
    enabledProxyCount: 1,
    rejectedToolCount: 1,
    disabledProxyNames: ['offline']
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'gateway__list_available_tools', arguments: { prefix: 'no-such-prefix' }
  } })}\n`);
  const fallback = await nextLine(child.stdout);
  assert.equal(fallback.result.structuredContent.availableToolCount, 2);
  assert.deepEqual(fallback.result.structuredContent.tools.map((tool) => tool.name), [
    'demo__plain',
    'gateway__list_available_tools'
  ]);
  assert.equal(fallback.result.structuredContent.tools[0].inputSchema, undefined);
  assert.equal(fallback.result.structuredContent.tools[0].outputSchema, undefined);
});
