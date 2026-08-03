import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadGatewayConfig } from '../app/server-config.mjs';
import { parseToml } from '../app/toml-lite.mjs';

test('TOML subset parses Codex-style MCP tables, arrays, and env', () => {
  const parsed = parseToml([
    'private_use_only = true',
    '[mcp_servers.demo]',
    'command = "node"',
    "args = ['server.mjs', '--flag']",
    'enabled = false',
    '[mcp_servers.demo.env]',
    'DEMO = "value"'
  ].join('\n'));
  assert.equal(parsed.private_use_only, true);
  assert.deepEqual(parsed.mcp_servers.demo.args, ['server.mjs', '--flag']);
  assert.equal(parsed.mcp_servers.demo.env.DEMO, 'value');
});

test('gateway config keeps arbitrary enabled stdio MCPs and skips disabled entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-toml-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    "args = ['alpha.mjs']",
    'enabled = true',
    'prefix = "a"',
    'startup_timeout_sec = 5',
    'tool_timeout_sec = 15',
    'deferred = true',
    'serial_group = "browser"',
    'blocked_tools = ["dangerous"]',
    "allowed_directories = ['C:\\work\\project']",
    "allowed_files = ['C:\\Users\\owner\\Downloads\\upload.png']",
    '[mcp_servers.alpha.env]',
    'CONFIG = "alpha.json"',
    '[mcp_servers.alpha.start_after]',
    'server = "controller"',
    'tool = "prepare"',
    '[mcp_servers.beta]',
    'enabled = false'
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(path);
  assert.equal(config.servers.length, 1);
  assert.equal(config.servers[0].name, 'alpha');
  assert.equal(config.servers[0].prefix, 'a');
  assert.equal(config.servers[0].requestTimeoutMs, 15000);
  assert.equal(config.servers[0].startupTimeoutMs, 5000);
  assert.equal(config.servers[0].env.CONFIG, 'alpha.json');
  assert.equal(config.servers[0].deferred, true);
  assert.equal(config.servers[0].serialGroup, 'browser');
  assert.deepEqual(config.servers[0].startAfter, { server: 'controller', tool: 'prepare' });
  assert.equal(config.servers[0].blockedTools.has('dangerous'), true);
  assert.deepEqual(config.servers[0].allowedDirectories, ['C:\\work\\project']);
  assert.deepEqual(config.servers[0].allowedFiles, ['C:\\Users\\owner\\Downloads\\upload.png']);
});

test('gateway path allowlists require absolute paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-relative-path-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'allowed_directories = ["relative/project"]'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(path), /must be absolute paths/);
});

test('gateway rejects Codex-only token and approval settings instead of silently ignoring them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-codex-only-'));
  const tokenPath = join(directory, 'token.toml');
  await writeFile(tokenPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'tool_output_token_limit = 1000'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(tokenPath), /tool_output_token_limit is Codex-specific/);
  const approvalPath = join(directory, 'approval.toml');
  await writeFile(approvalPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    '[mcp_servers.alpha.tools.dangerous]',
    'approval_mode = "approve"'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(approvalPath), /approval tables are Codex-specific/);
});