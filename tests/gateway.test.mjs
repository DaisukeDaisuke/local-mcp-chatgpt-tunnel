import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { windowsIntegrityLevel } from '../app/windows-integrity.mjs';
import { testGitExecutable } from './test-git-executable.mjs';

const integrityLevel = await windowsIntegrityLevel();
const elevatedWindows = process.platform === 'win32' && (integrityLevel === 'high' || integrityLevel === 'system');
const gatewayIntegrationTest = elevatedWindows ? test.skip : test;

function nextLine(stream, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => cleanup(new Error('Timed out waiting for gateway output')), timeoutMs);
    const onClose = () => cleanup(new Error('Gateway output stream closed before a complete JSON line'));
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
      stream.off('close', onClose);
      if (error) reject(error); else resolvePromise(value);
    };
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.once('close', onClose);
  });
}

function nextLines(stream, count, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const lines = [];
    const timeout = setTimeout(() => cleanup(new Error('Timed out waiting for gateway output')), timeoutMs);
    const onClose = () => cleanup(new Error(`Gateway output stream closed after ${lines.length} of ${count} expected JSON lines`));
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
      stream.off('close', onClose);
      if (error) reject(error); else resolvePromise(value);
    };
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.once('close', onClose);
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

function loggedToolCalls(text) {
  const prefix = '[gateway] INFO tool call: name=';
  const separator = ' arguments=';
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      const payload = line.slice(prefix.length);
      const separatorIndex = payload.indexOf(separator);
      return {
        name: JSON.parse(payload.slice(0, separatorIndex)),
        arguments: JSON.parse(payload.slice(separatorIndex + separator.length))
      };
    });
}

test('gateway refuses elevated Windows before MCP initialization', { skip: !elevatedWindows }, async () => {
  const child = spawn(process.execPath, [
    resolve('app/gateway.mjs'),
    '--config',
    resolve('config/gateway.example.toml')
  ], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stderr = collectText(child.stderr);
  const [code] = await once(child, 'close');
  assert.notEqual(code, 0);
  assert.match(stderr.value, /Refusing to run local MCP with (high|system) Windows integrity/);
});

gatewayIntegrationTest('gateway excludes exact and substring-matched tools and logs exposure once per gateway process', async (t) => {
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
    'blocked_tool_substrings = ["script", "shell"]',
    '[mcp_servers.offline]',
    'enabled = false',
    'prefix = "offline"'
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
  await stderr.waitFor((text) => (text.match(/INFO tool exposure: found=5 disabled=4 published=3/g) ?? []).length >= 1);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  await nextLine(child.stdout);
  assert.equal((stderr.value.match(/INFO tool exposure: found=5 disabled=4 published=3/g) ?? []).length, 1);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })}\n`);
  const listed = await nextLine(child.stdout);
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'gateway_childs_mcp_async_status',
    'demo__plain',
    'demo__get_gateway_access_scope'
  ]);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'demo__runScript', arguments: {} } })}\n`);
  const blockedCall = await nextLine(child.stdout);
  assert.equal(blockedCall.error.code, -32602);
  assert.match(blockedCall.error.message, /Unknown tool/);

  const log = stderr.value;
  assert.equal((log.match(/INFO tool disabled:/g) ?? []).length, 4);
  assert.match(log, /tool="runScript".*blocked_tool_substrings="script"/);
  assert.match(log, /tool="SCRIPT_debug".*blocked_tool_substrings="script"/);
  assert.match(log, /tool="shell_exec".*blocked_tool_substrings="shell"/);
  assert.match(log, /tool="dangerous".*blocked_tools exact match/);
  assert.doesNotMatch(log, /status="published"/);
  assert.match(log, /INFO tool prefix: server="demo" prefix="demo" enabled=true found=5 rejected=4 published=2/);
  assert.match(log, /INFO tool prefix disabled: server="offline" prefix="offline" enabled=false reason="enabled=false"/);
});

gatewayIntegrationTest('gateway logs public tool name and received arguments before bundled isolation metadata is injected', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-input-log-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-input-log-config-'));
  const configPath = join(configDirectory, 'gateway.toml');
  await writeFile(join(workspace, 'inside.txt'), 'inside', 'utf8');
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.files]',
    `command = '${process.execPath}'`,
    `args = ['${resolve('mcp/safe-files/server.mjs')}']`,
    `cwd = '${workspace}'`,
    `allowed_directories = ['${workspace}']`,
    'enabled = true',
    'prefix = "files"'
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

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'isolated__create', arguments: { isolatedId: 'input-log', purpose: 'verify gateway input logging', workspaces: [workspace] }
  } })}\n`);
  const created = await nextLine(child.stdout);
  assert.equal(created.result.isError, false);

  const received = {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'files__read_text',
      arguments: { isolatedId: 'input-log', path: 'inside.txt' }
    }
  };
  child.stdin.write(`  ${JSON.stringify(received, null, 2).replace(/\n/g, ' ')}  \n`);
  const result = await nextLine(child.stdout);
  assert.equal(result.result.isError, false);

  await stderr.waitFor((text) => loggedToolCalls(text).some((entry) => entry.name === received.params.name));
  const logged = loggedToolCalls(stderr.value).find((entry) => entry.name === received.params.name);
  assert.deepEqual(logged, {
    name: received.params.name,
    arguments: received.params.arguments
  });
});

gatewayIntegrationTest('gateway rejects external sandbox glob rules it cannot safely translate before launching Codex', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-sandbox-hole-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-sandbox-hole-config-'));
  const configPath = join(configDirectory, 'gateway.toml');
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.demo]',
    `command = '${process.execPath}'`,
    `cwd = '${workspace}'`,
    'sandbox = "elevated"',
    `codex_executable = '${join(configDirectory, 'codex.exe')}'`,
    `allowed_directories = ['${workspace}']`,
    `disallowed_path_globs = ['**.ssh**']`,
    'enabled = true',
    'prefix = "demo"'
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const stderr = collectText(child.stderr);
  t.after(() => child.kill());

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  const initialized = await nextLine(child.stdout);
  assert.equal(initialized.result.serverInfo.name, 'local-mcp-gateway');
  await stderr.waitFor((text) => text.includes('cannot safely translate Gateway disallowed_path_globs into Codex filesystem glob semantics'));

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  const listed = await nextLine(child.stdout);
  assert.equal(listed.result.tools.some((tool) => tool.name.startsWith('demo__')), false);
});

gatewayIntegrationTest('gateway aggregates a selected local stdio MCP without model API or HTTP', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-workspace-'));
  const canonicalWorkspace = await realpath(workspace);
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-config-'));
  const configPath = join(configDirectory, 'gateway.toml');
  const repository = resolve('.');
  await writeFile(join(workspace, 'inside.txt'), 'inside', 'utf8');
  await mkdir(join(workspace, 'nested'));
  const canonicalNestedWorkspace = await realpath(join(workspace, 'nested'));
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
  assert.ok(names.includes('files__get_gateway_access_scope'));
  assert.ok(names.includes('isolated__create'));
  assert.ok(names.includes('isolated__list'));
  assert.ok(names.includes('isolated__close'));
  assert.ok(names.every((name) =>
    name === 'gateway_childs_mcp_async_status'
      || name.startsWith('files__')
      || name.startsWith('isolated__')
  ));
  assert.ok(listed.result.tools.every((tool) => tool.outputSchema?.type === 'object'));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 18, method: 'tools/call', params: {
    name: 'isolated__create', arguments: { isolatedId: 'missing-purpose', workspaces: [workspace] }
  } })}\n`);
  const missingPurpose = await nextLine(child.stdout);
  assert.equal(missingPurpose.result.isError, true);
  assert.match(missingPurpose.result.structuredContent.error, /purpose/);
  const isolatedId = 'gateway-files-test';
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 19, method: 'tools/call', params: {
    name: 'isolated__create', arguments: { isolatedId, purpose: 'exercise isolated safe-files operations', workspaces: [workspace] }
  } })}\n`);
  const createdIsolation = await nextLine(child.stdout);
  assert.equal(createdIsolation.result.isError, false);
  assert.equal(createdIsolation.result.structuredContent.result.workspaceCount, 1);
  assert.equal(createdIsolation.result.structuredContent.result.purpose, 'exercise isolated safe-files operations');
  assert.match(createdIsolation.result.structuredContent.result.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: {
    name: 'files__get_gateway_access_scope', arguments: { isolatedId }
  } })}\n`);
  const scope = await nextLine(child.stdout);
  assert.equal(scope.result.isError, false);
  assert.equal(scope.result.structuredContent.result.serverName, 'files');
  assert.equal(scope.result.structuredContent.result.workingDirectory, canonicalWorkspace);
  assert.equal(scope.result.structuredContent.result.relativePathBase, canonicalWorkspace);
  assert.deepEqual(scope.result.structuredContent.result.configured.allowedDirectories, [canonicalWorkspace]);
  assert.deepEqual(scope.result.structuredContent.result.configured.allowedFiles, []);
  assert.equal(scope.result.structuredContent.result.effective.allowedDirectories[0].canonicalPath, canonicalWorkspace);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: {
    name: 'files__set_working_directory', arguments: { isolatedId, path: 'nested' }
  } })}\n`);
  const changedDirectory = await nextLine(child.stdout);
  assert.equal(changedDirectory.result.isError, false);
  assert.equal(changedDirectory.result.structuredContent.result.workingDirectory, canonicalNestedWorkspace);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: {
    name: 'files__get_gateway_access_scope', arguments: { isolatedId }
  } })}\n`);
  const changedScope = await nextLine(child.stdout);
  assert.equal(changedScope.result.structuredContent.result.workingDirectory, canonicalNestedWorkspace);
  assert.equal(changedScope.result.structuredContent.result.relativePathBase, canonicalNestedWorkspace);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: {
    name: 'files__set_working_directory', arguments: { isolatedId, path: workspace }
  } })}\n`);
  const restoredDirectory = await nextLine(child.stdout);
  assert.equal(restoredDirectory.result.isError, false);
  assert.equal(restoredDirectory.result.structuredContent.result.workingDirectory, canonicalWorkspace);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId, path: 'inside.txt' }
  } })}\n`);
  const inside = await nextLine(child.stdout);
  assert.equal(inside.result.isError, false);
  assert.equal(inside.result.structuredContent.result.results[0].content, 'inside');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId, path: join(tmpdir(), 'outside.txt') }
  } })}\n`);
  const outside = await nextLine(child.stdout);
  assert.equal(outside.result.isError, true);
  assert.match(outside.result.content[0].text, /outside allowed_directories/);
  assert.match(outside.result.content[0].text, /Allowed directories \(absolute\):/);
  assert.ok(outside.result.content[0].text.includes(canonicalWorkspace));
  assert.deepEqual(outside.result.structuredContent.result.accessScope.allowedDirectories, [canonicalWorkspace]);
  assert.deepEqual(outside.result.structuredContent.result.accessScope.allowedFiles, []);

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
        isolatedId,
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

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId, root: workspace, path: 'inside.txt' }
  } })}\n`);
  const rootOverride = await nextLine(child.stdout);
  assert.equal(rootOverride.result.isError, true);
  assert.match(rootOverride.result.content[0].text, /workspace roots are controlled only by isolated__create/);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: {
    name: 'isolated__list', arguments: {}
  } })}\n`);
  const isolatedList = await nextLine(child.stdout);
  assert.match(isolatedList.result.structuredContent.result.listedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(isolatedList.result.structuredContent.result.isolated.map((entry) => entry.isolatedId), [isolatedId]);
  assert.equal(isolatedList.result.structuredContent.result.isolated[0].workspaceCount, 1);
  assert.equal(isolatedList.result.structuredContent.result.isolated[0].purpose, 'exercise isolated safe-files operations');
  assert.match(isolatedList.result.structuredContent.result.isolated[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  const filesActivity = isolatedList.result.structuredContent.result.isolated[0].bundledMcp.find((entry) => entry.prefix === 'files');
  assert.match(filesActivity.lastOperationAt, /^\d{4}-\d{2}-\d{2}T/);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: {
    name: 'isolated__close', arguments: { isolatedId }
  } })}\n`);
  const closed = await nextLine(child.stdout);
  assert.equal(closed.result.isError, false);
  assert.equal(closed.result.structuredContent.result.reusable, false);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId, path: 'inside.txt' }
  } })}\n`);
  const closedUse = await nextLine(child.stdout);
  assert.equal(closedUse.result.isError, true);
  assert.match(closedUse.result.content[0].text, /Unknown or closed isolatedId/);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 34, method: 'tools/call', params: {
    name: 'isolated__create', arguments: { isolatedId, purpose: 'verify closed isolation IDs cannot be reused', workspaces: [workspace] }
  } })}\n`);
  const reused = await nextLine(child.stdout);
  assert.equal(reused.result.isError, true);
  assert.match(reused.result.structuredContent.error, /cannot be reused until Gateway restart/);
});

gatewayIntegrationTest('gateway keeps multiple bundled workspaces isolated by unique ID', async (t) => {
  const workspaceA = await mkdtemp(join(tmpdir(), 'gateway-isolated-a-'));
  const workspaceB = await mkdtemp(join(tmpdir(), 'gateway-isolated-b-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-isolated-config-'));
  const configPath = join(configDirectory, 'gateway.toml');
  await writeFile(join(workspaceA, 'a.txt'), 'alpha', 'utf8');
  await writeFile(join(workspaceB, 'b.txt'), 'bravo', 'utf8');
  const git = await testGitExecutable();
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.files]',
    `command = '${process.execPath}'`,
    `args = ['${resolve('mcp/safe-files/server.mjs')}']`,
    `cwd = '${workspaceA}'`,
    `allowed_directories = ['${workspaceA}', '${workspaceB}']`,
    'enabled = true',
    'prefix = "files"',
    '[mcp_servers.git]',
    `command = '${process.execPath}'`,
    `args = ['${resolve('mcp/gitmcp/server.mjs')}', '--git-executable=${git}', '--disable-push=true', '--disable-pull=true', '--disable-clone=true']`,
    `cwd = '${workspaceB}'`,
    `allowed_directories = ['${workspaceB}']`,
    'enabled = true',
    'prefix = "git"',
    'annotation_config = false'
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  await nextLine(child.stdout);

  for (const [id, isolatedId, workspaces] of [
    [2, 'multi', [workspaceA, workspaceB]],
    [3, 'only-b', [workspaceB]]
  ]) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: 'isolated__create', arguments: { isolatedId, purpose: `test isolated workspace ${isolatedId}`, workspaces }
    } })}\n`);
    const created = await nextLine(child.stdout);
    assert.equal(created.result.isError, false);
  }

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 35, method: 'tools/call', params: {
    name: 'isolated__list', arguments: {}
  } })}\n`);
  const isolatedList = await nextLine(child.stdout);
  const multiEntry = isolatedList.result.structuredContent.result.isolated.find((entry) => entry.isolatedId === 'multi');
  const multiByPrefix = new Map(multiEntry.bundledMcp.map((entry) => [entry.prefix, entry]));
  assert.equal(multiEntry.purpose, 'test isolated workspace multi');
  assert.match(multiEntry.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(multiByPrefix.get('files').workspaceCount, 2);
  assert.equal(multiByPrefix.get('git').workspaceCount, 1);
  assert.equal(multiByPrefix.get('git').lastOperationAt, null);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 36, method: 'tools/call', params: {
    name: 'git__get_gateway_access_scope', arguments: { isolatedId: 'multi' }
  } })}\n`);
  const gitScope = await nextLine(child.stdout);
  assert.equal(gitScope.result.isError, false);
  assert.deepEqual(gitScope.result.structuredContent.result.isolationRoots, [await realpath(workspaceB)]);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId: 'multi', path: join(workspaceB, 'b.txt') }
  } })}\n`);
  const crossWorkspace = await nextLine(child.stdout);
  assert.equal(crossWorkspace.result.isError, false);
  assert.equal(crossWorkspace.result.structuredContent.result.results[0].content, 'bravo');

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId: 'only-b', path: 'b.txt' }
  } })}\n`);
  const relativeB = await nextLine(child.stdout);
  assert.equal(relativeB.result.isError, false);
  assert.equal(relativeB.result.structuredContent.result.results[0].content, 'bravo');

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId: 'only-b', path: join(workspaceA, 'a.txt') }
  } })}\n`);
  const escapedIsolation = await nextLine(child.stdout);
  assert.equal(escapedIsolation.result.isError, true);
  assert.match(escapedIsolation.result.content[0].text, /outside allowed_directories and allowed_files/);
});

gatewayIntegrationTest('gateway denies direct reads of its loaded configuration by default', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-protected-config-'));
  const configPath = join(workspace, 'gateway.toml');
  await writeFile(join(workspace, 'public.txt'), 'public', 'utf8');
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.files]',
    `command = '${process.execPath}'`,
    `args = ['${resolve('mcp/safe-files/server.mjs')}']`,
    `cwd = '${workspace}'`,
    `allowed_directories = ['${workspace}']`,
    'enabled = true',
    'prefix = "files"'
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
    cwd: resolve('.'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
  await nextLine(child.stdout);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'isolated__create', arguments: { isolatedId: 'protected-config', purpose: 'verify protected gateway config access', workspaces: [workspace] }
  } })}\n`);
  const created = await nextLine(child.stdout);
  assert.equal(created.result.isError, false);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId: 'protected-config', path: configPath }
  } })}\n`);
  const denied = await nextLine(child.stdout);
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /targets the gateway configuration/);
});

gatewayIntegrationTest('gateway refuses isolated workspaces when a bundled MCP has an empty allowlist', async (t) => {
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
    name: 'isolated__create', arguments: { isolatedId: 'empty-allowlist', purpose: 'verify empty bundled allowlist rejection', workspaces: [workspace] }
  } })}\n`);
  const noAllowlist = await nextLine(child.stdout);
  assert.equal(noAllowlist.result.isError, true);
  assert.match(noAllowlist.result.structuredContent.error, /outside every bundled MCP allowlist or is denied/);
});

gatewayIntegrationTest('gateway caps only files responses at 15KB by default, returns a 0.5KB preview, and allows an env override', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-files-response-limit-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-files-response-limit-config-'));
  const configPath = join(configDirectory, 'gateway.toml');
  const payload = 'x'.repeat(80 * 1024);
  await writeFile(join(workspace, 'large.txt'), payload, 'utf8');
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.files]',
    `command = '${process.execPath}'`,
    `args = ['${resolve('mcp/safe-files/server.mjs')}']`,
    `cwd = '${workspace}'`,
    `allowed_directories = ['${workspace}']`,
    'enabled = true',
    'prefix = "files"'
  ].join('\n'), 'utf8');

  async function startGateway(env, isolatedId) {
    const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
      cwd: resolve('.'),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    t.after(() => child.kill());
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
    await nextLine(child.stdout);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'isolated__create', arguments: { isolatedId, purpose: 'verify files response byte limit', workspaces: [workspace] }
    } })}\n`);
    const created = await nextLine(child.stdout);
    assert.equal(created.result.isError, false);
    return child;
  }

  const defaultEnv = { ...process.env };
  delete defaultEnv.LOCAL_MCP_FILES_MAX_RESPONSE_BYTES;
  const defaultGateway = await startGateway(defaultEnv, 'files-limit-default');
  defaultGateway.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId: 'files-limit-default', path: 'large.txt' }
  } })}\n`);
  const rejected = await nextLine(defaultGateway.stdout);
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.result.content.length, 2);
  assert.ok(rejected.result.content[1].text.startsWith('{"jsonrpc":"2.0","id":3,"result":'));
  assert.ok(Buffer.byteLength(rejected.result.content[1].text, 'utf8') <= 512);
  assert.equal(rejected.result.structuredContent.result.previewBytes, Buffer.byteLength(rejected.result.content[1].text, 'utf8'));
  assert.equal(rejected.result.structuredContent.result.limitBytes, 100 * 1024);
  assert.ok(rejected.result.structuredContent.result.responseBytes > rejected.result.structuredContent.result.limitBytes);

  const raisedGateway = await startGateway({
    ...process.env,
    LOCAL_MCP_FILES_MAX_RESPONSE_BYTES: String(256 * 1024)
  }, 'files-limit-raised');
  raisedGateway.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'files__read_text', arguments: { isolatedId: 'files-limit-raised', path: 'large.txt' }
  } })}\n`);
  const allowed = await nextLine(raisedGateway.stdout);
  assert.equal(allowed.result.isError, false);
  assert.equal(allowed.result.structuredContent.result.results[0].content, payload);
});

gatewayIntegrationTest('gateway also caps codespace responses at 15KB, returns a 0.5KB preview, and allows an independent env override', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'gateway-codespace-response-limit-workspace-'));
  const configDirectory = await mkdtemp(join(tmpdir(), 'gateway-codespace-response-limit-config-'));
  const serverPath = join(workspace, 'server.mjs');
  const configPath = join(configDirectory, 'gateway.toml');
  const payload = 'c'.repeat(80 * 1024);
  await writeFile(serverPath, `
const payload = 'c'.repeat(80 * 1024);
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
      reply = { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'codespace-limit-fixture', version: '1.0.0' } } };
    } else if (request.method === 'tools/list' && initialized) {
      reply = { jsonrpc: '2.0', id: request.id, result: { tools: [{
        name: 'huge',
        description: 'large response fixture',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, result: { type: 'object' } }, required: ['ok', 'result'] }
      }] } };
    } else if (request.method === 'tools/call' && initialized) {
      reply = { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: payload }], structuredContent: { ok: true, result: { payload } }, isError: false } };
    }
    if (reply) process.stdout.write(JSON.stringify(reply) + '\\n');
  }
});
`, 'utf8');
  await writeFile(configPath, [
    'private_use_only = true',
    '[mcp_servers.codespace]',
    `command = '${process.execPath}'`,
    `args = ['${serverPath}']`,
    `cwd = '${workspace}'`,
    `allowed_directories = ['${workspace}']`,
    'enabled = true',
    'prefix = "codespace"'
  ].join('\n'), 'utf8');

  async function callGateway(env) {
    const child = spawn(process.execPath, [resolve('app/gateway.mjs'), '--config', configPath], {
      cwd: resolve('.'),
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    t.after(() => child.kill());
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`);
    await nextLine(child.stdout);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'codespace__huge', arguments: {} } })}\n`);
    return nextLine(child.stdout);
  }

  const defaultEnv = { ...process.env };
  delete defaultEnv.LOCAL_MCP_CODESPACE_MAX_RESPONSE_BYTES;
  const rejected = await callGateway(defaultEnv);
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.result.content.length, 2);
  assert.ok(rejected.result.content[1].text.startsWith('{"jsonrpc":"2.0","id":2,"result":'));
  assert.ok(Buffer.byteLength(rejected.result.content[1].text, 'utf8') <= 512);
  assert.equal(rejected.result.structuredContent.result.previewBytes, Buffer.byteLength(rejected.result.content[1].text, 'utf8'));
  assert.equal(rejected.result.structuredContent.result.limitBytes, 100 * 1024);
  assert.ok(rejected.result.structuredContent.result.responseBytes > rejected.result.structuredContent.result.limitBytes);

  const allowed = await callGateway({
    ...process.env,
    LOCAL_MCP_CODESPACE_MAX_RESPONSE_BYTES: String(256 * 1024)
  });
  assert.equal(allowed.result.isError, false);
  assert.equal(allowed.result.structuredContent.result.payload, payload);
});

gatewayIntegrationTest('gateway preserves safe-download outputSchema and embedded ZIP resource content', async (t) => {
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
    env: { ...process.env, LOCAL_MCP_FILES_MAX_RESPONSE_BYTES: '1' },
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
    name: 'isolated__create', arguments: { isolatedId: 'download-test', purpose: 'verify safe-download isolation', workspaces: [workspace] }
  } })}\n`);
  const created = await nextLine(child.stdout);
  assert.equal(created.result.isError, false);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
    name: 'downloads__download_zip', arguments: { isolatedId: 'download-test', path: 'server.mjs', archiveName: 'server.zip' }
  } })}\n`);
  const downloaded = await nextLine(child.stdout);
  assert.equal(downloaded.result.isError, false);
  const resource = downloaded.result.content.find((part) => part.type === 'resource');
  assert.equal(resource.resource.mimeType, 'application/zip');
  assert.equal(Buffer.from(resource.resource.blob, 'base64').readUInt32LE(0), 0x04034b50);
  assert.equal(Object.hasOwn(downloaded.result.structuredContent.result, 'blob'), false);
});

gatewayIntegrationTest('gateway initialization survives an unavailable child MCP', async (t) => {
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
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['gateway_childs_mcp_async_status']);
});

gatewayIntegrationTest('tools/list waits for concurrent initialization when a child MCP is unavailable', async (t) => {
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
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['gateway_childs_mcp_async_status']);
});

gatewayIntegrationTest('optional gateway tool directory returns full names, prefix matches, counts, and disabled proxy names', async (t) => {
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
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), [
    'gateway__list_available_tools',
    'gateway__get_prefix_list',
    'gateway__get_config',
    'gateway_childs_mcp_async_status',
    'demo__plain',
    'demo__get_gateway_access_scope'
  ]);
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
    name: 'gateway__get_prefix_list', arguments: {}
  } })}\n`);
  const prefixes = await nextLine(child.stdout);
  assert.deepEqual(prefixes.result.structuredContent, {
    prefixes: ['demo', 'gateway'],
    prefixCount: 2
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
    name: 'gateway__list_available_tools', arguments: { prefix: 'no-such-prefix' }
  } })}\n`);
  const fallback = await nextLine(child.stdout);
  assert.equal(fallback.result.structuredContent.availableToolCount, 6);
  assert.deepEqual(fallback.result.structuredContent.tools.map((tool) => tool.name), [
    'demo__get_gateway_access_scope',
    'demo__plain',
    'gateway__get_config',
    'gateway__get_prefix_list',
    'gateway__list_available_tools',
    'gateway_childs_mcp_async_status'
  ]);
  assert.equal(fallback.result.structuredContent.tools[0].inputSchema, undefined);
  assert.equal(fallback.result.structuredContent.tools[0].outputSchema, undefined);

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
    name: 'gateway__get_config', arguments: {}
  } })}\n`);
  const gatewayConfig = await nextLine(child.stdout);
  assert.equal(gatewayConfig.result.isError, false);
  assert.deepEqual(gatewayConfig.result.structuredContent.disabledServerNames, ['offline']);
  assert.deepEqual(gatewayConfig.result.structuredContent.servers, [{
    name: 'demo',
    prefix: 'demo',
    allowedDirectories: [workspace],
    allowedFiles: [],
    disallowedDirectories: [],
    disallowedFiles: [],
    disallowedPathGlobs: [],
    sandboxReadOnlyDirectories: [],
    sandboxReadOnlyFiles: []
  }]);
  assert.equal(JSON.stringify(gatewayConfig.result.structuredContent).includes('env'), false);
  assert.equal(JSON.stringify(gatewayConfig.result.structuredContent).includes(serverPath), false);
});
