import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { signBundledIsolationContext } from '../app/bundled-isolation.mjs';

async function nextJsonLine(stream, state) {
  while (true) {
    const newline = state.buffer.indexOf('\n');
    if (newline >= 0) {
      const line = state.buffer.slice(0, newline).replace(/\r$/, '');
      state.buffer = state.buffer.slice(newline + 1);
      if (line.trim()) return JSON.parse(line);
      continue;
    }
    const [chunk] = await once(stream, 'data');
    state.buffer += chunk.toString('utf8');
  }
}

test('codex-script runs the fixed runtime inside its existing sandbox process and can use every configured allowed directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-script-existing-sandbox-'));
  const workspace = join(root, 'workspace');
  const shared = join(root, 'shared');
  await mkdir(workspace);
  await mkdir(shared);
  const canonicalWorkspace = await realpath(workspace);
  const canonicalShared = await realpath(shared);
  const sharedFile = join(shared, 'value.txt');
  await writeFile(sharedFile, 'shared-value', 'utf8');
  const scriptPath = join(workspace, 'read-shared.mjs');
  await writeFile(scriptPath, [
    "import { readFile } from 'node:fs/promises';",
    `process.stdout.write(await readFile(${JSON.stringify(sharedFile)}, 'utf8'));`
  ].join('\n'), 'utf8');

  const isolationKey = 'codex-script-test-isolation-key-0123456789';
  // Gateway-signed isolation roots are canonical paths. This matters on macOS,
  // where temporary directories may be addressed through /var but realpath to
  // /private/var.
  const context = { roots: [canonicalWorkspace], base: canonicalWorkspace };
  const child = spawn(process.execPath, [
    resolve('mcp/codex-script/server.mjs'),
    '--mode=run',
    '--runtime=mjs',
    `--runtime-executable=${process.execPath}`
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      LOCAL_MCP_ALLOWED_DIRECTORIES: JSON.stringify([canonicalWorkspace, canonicalShared]),
      LOCAL_MCP_ALLOWED_FILES: '[]',
      LOCAL_MCP_DISALLOWED_DIRECTORIES: '[]',
      LOCAL_MCP_DISALLOWED_FILES: '[]',
      LOCAL_MCP_DISALLOWED_PATH_GLOBS: '[]',
      LOCAL_MCP_GATEWAY_ISOLATION_KEY: isolationKey,
      // A nested-Codex implementation would try to use these and fail.
      LOCAL_MCP_CODEX_SANDBOX_MODE: 'elevated',
      LOCAL_MCP_CODEX_EXECUTABLE: join(root, 'does-not-exist', 'codex.cmd')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill();
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const state = { buffer: '' };

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
  })}\n`);
  const initialized = await nextJsonLine(child.stdout, state);
  assert.equal(initialized.result.serverInfo.name, 'codex-script');

  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'run_script',
      arguments: {
        __localMcpIsolation: {
          version: 1,
          roots: context.roots,
          base: context.base,
          signature: signBundledIsolationContext(isolationKey, context)
        },
        scriptPath
      }
    }
  })}\n`);
  const result = await nextJsonLine(child.stdout, state);
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.ok, true);
  assert.equal(result.result.structuredContent.result.exitCode, 0);
  assert.equal(result.result.structuredContent.result.stdout, 'shared-value');
});

test('codex-script check mode accepts a workspace with deny holes but still rejects a denied target file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-script-check-deny-hole-'));
  const denied = join(root, 'logs');
  await mkdir(denied);
  const sourcePath = join(root, 'valid.mjs');
  const invalidSourcePath = join(root, 'invalid.mjs');
  const deniedSourcePath = join(denied, 'hidden.mjs');
  await writeFile(sourcePath, 'export const value = 1;\n', 'utf8');
  await writeFile(invalidSourcePath, 'export const = ;\n', 'utf8');
  await writeFile(deniedSourcePath, 'export const hidden = 1;\n', 'utf8');
  const canonicalRoot = await realpath(root);
  const canonicalDenied = await realpath(denied);
  const canonicalInvalidSourcePath = await realpath(invalidSourcePath);
  const isolationKey = 'codex-script-check-isolation-key-0123456789';
  const context = { roots: [canonicalRoot], base: canonicalRoot };
  const envelope = {
    version: 1,
    roots: context.roots,
    base: context.base,
    signature: signBundledIsolationContext(isolationKey, context)
  };
  const child = spawn(process.execPath, [
    resolve('mcp/codex-script/server.mjs'),
    '--mode=check',
    '--runtime=nodejs',
    `--runtime-executable=${process.execPath}`
  ], {
    cwd: root,
    env: {
      ...process.env,
      LOCAL_MCP_ALLOWED_DIRECTORIES: JSON.stringify([canonicalRoot]),
      LOCAL_MCP_ALLOWED_FILES: '[]',
      LOCAL_MCP_DISALLOWED_DIRECTORIES: JSON.stringify([canonicalDenied]),
      LOCAL_MCP_DISALLOWED_FILES: '[]',
      LOCAL_MCP_DISALLOWED_PATH_GLOBS: '[]',
      LOCAL_MCP_GATEWAY_ISOLATION_KEY: isolationKey,
      LOCAL_MCP_CODEX_SANDBOX_MODE: 'elevated',
      LOCAL_MCP_CODEX_EXECUTABLE: join(root, 'does-not-exist', 'codex.cmd')
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill();
  });
  child.stdout.setEncoding('utf8');
  const state = { buffer: '' };

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
  })}\n`);
  await nextJsonLine(child.stdout, state);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'check_file', arguments: { __localMcpIsolation: envelope, filePaths: [sourcePath, invalidSourcePath] } }
  })}\n`);
  const checked = await nextJsonLine(child.stdout, state);
  assert.equal(checked.result.isError, false);
  assert.equal(checked.result.structuredContent.ok, true);
  assert.equal(checked.result.structuredContent.result.pass, 1);
  assert.equal(checked.result.structuredContent.result.fault, 1);
  assert.equal(checked.result.structuredContent.result.messages.length, 1);
  assert.equal(checked.result.structuredContent.result.messages[0].filePath, canonicalInvalidSourcePath);
  assert.notEqual(checked.result.structuredContent.result.messages[0].exitCode, 0);
  assert.equal(typeof checked.result.structuredContent.result.messages[0].stderr, 'string');
  assert.equal(checked.result.structuredContent.result.messages.some((message) => message.filePath === sourcePath), false);

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'check_file', arguments: { __localMcpIsolation: envelope, filePath: deniedSourcePath } }
  })}\n`);
  const deniedResult = await nextJsonLine(child.stdout, state);
  assert.equal(deniedResult.result.isError, true);
  assert.equal(deniedResult.result.structuredContent.ok, false);
  assert.match(deniedResult.result.structuredContent.error, /denied by disallowed/);
});