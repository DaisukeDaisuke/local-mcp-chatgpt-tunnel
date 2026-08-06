import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadGatewayConfig, serverConfigInternals } from '../app/server-config.mjs';
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
    'publish_tool_directory = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    "args = ['alpha.mjs']",
    'enabled = true',
    'prefix = "a"',
    'annotation_config = false',
    'dangerous_allow_gateway_config_access = true',
    'startup_timeout_sec = 5',
    'tool_timeout_sec = 15',
    'deferred = true',
    'serial_group = "browser"',
    'blocked_tools = ["dangerous"]',
    'blocked_tool_substrings = ["script", "shell"]',
    "allowed_directories = ['C:\\work\\project']",
    "allowed_files = ['C:\\Users\\owner\\Downloads\\upload.png']",
    "disallowed_directories = ['C:\\work\\project\\private']",
    "disallowed_files = ['C:\\work\\project\\.env']",
    "disallowed_path_globs = ['**.ssh**']",
    '[mcp_servers.alpha.env]',
    'CONFIG = "alpha.json"',
    '[mcp_servers.alpha.start_after]',
    'server = "controller"',
    'tool = "prepare"',
    '[mcp_servers.beta]',
    'enabled = false'
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(path, { platform: 'win32' });
  assert.equal(config.servers.length, 1);
  assert.equal(config.publishToolDirectory, true);
  assert.deepEqual(config.disabledServerNames, ['beta']);
  assert.equal(config.servers[0].name, 'alpha');
  assert.equal(config.servers[0].prefix, 'a');
  assert.equal(config.servers[0].manageAnnotations, false);
  assert.equal(config.servers[0].dangerousAllowGatewayConfigAccess, true);
  assert.ok(config.servers[0].protectedGatewayConfigPaths.includes(config.configPath));
  assert.ok(config.servers[0].protectedGatewayConfigPaths.includes(config.canonicalConfigPath));
  assert.equal(config.servers[0].requestTimeoutMs, 15000);
  assert.equal(config.servers[0].startupTimeoutMs, 5000);
  assert.equal(config.servers[0].env.CONFIG, 'alpha.json');
  assert.equal(config.servers[0].deferred, true);
  assert.equal(config.servers[0].serialGroup, 'browser');
  assert.deepEqual(config.servers[0].startAfter, { server: 'controller', tool: 'prepare' });
  assert.equal(config.servers[0].blockedTools.has('dangerous'), true);
  assert.deepEqual(config.servers[0].blockedToolSubstrings, ['script', 'shell']);
  assert.deepEqual(config.servers[0].allowedDirectories, ['C:\\work\\project']);
  assert.deepEqual(config.servers[0].allowedFiles, ['C:\\Users\\owner\\Downloads\\upload.png']);
  assert.deepEqual(config.servers[0].disallowedDirectories, ['C:\\work\\project\\private']);
  assert.deepEqual(config.servers[0].disallowedFiles, ['C:\\work\\project\\.env']);
  assert.deepEqual(config.servers[0].disallowedPathGlobs, ['**.ssh**']);
});

test('gateway marks only Node-launched bundled server paths as bundled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-bundled-config-'));
  const bundledPath = resolve('mcp/safe-files/server.mjs');
  const cwd = resolve('.');
  const bundledConfigPath = join(directory, 'bundled.toml');
  await writeFile(bundledConfigPath, [
    'private_use_only = true',
    '[mcp_servers.files]',
    `command = '${process.execPath}'`,
    `args = ['${bundledPath}']`,
    `cwd = '${cwd}'`,
    `allowed_directories = ['${cwd}']`
  ].join('\n'), 'utf8');
  const bundled = await loadGatewayConfig(bundledConfigPath);
  assert.equal(bundled.servers[0].isBundled, true);

  const impersonatedConfigPath = join(directory, 'impersonated.toml');
  await writeFile(impersonatedConfigPath, [
    'private_use_only = true',
    '[mcp_servers.files]',
    "command = 'not-node'",
    `args = ['${bundledPath}']`,
    `cwd = '${cwd}'`,
    `allowed_directories = ['${cwd}']`
  ].join('\n'), 'utf8');
  const impersonated = await loadGatewayConfig(impersonatedConfigPath);
  assert.equal(impersonated.servers[0].isBundled, false);
});

test('gateway config forbids overriding the private bundled isolation key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-isolation-key-config-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.files]',
    "command = 'node'",
    "args = ['server.mjs']",
    '[mcp_servers.files.env]',
    "LOCAL_MCP_GATEWAY_ISOLATION_KEY = 'forged'"
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(path), /may not override reserved path-policy variable LOCAL_MCP_GATEWAY_ISOLATION_KEY/);
});

test('gateway config validates disallowed_path_globs without treating them as absolute paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-path-glob-'));
  const validPath = join(directory, 'valid.toml');
  await writeFile(validPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    "disallowed_path_globs = ['**.ssh**', '**/private/**']"
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(validPath);
  assert.deepEqual(config.servers[0].disallowedPathGlobs, ['**.ssh**', '**/private/**']);

  const invalidPath = join(directory, 'invalid.toml');
  await writeFile(invalidPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'disallowed_path_globs = [""]'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(invalidPath), /disallowed_path_globs entries must be non-empty/);
});

test('gateway config rejects empty or control-character blocked tool substrings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-invalid-tool-filter-'));
  const emptyPath = join(directory, 'empty.toml');
  await writeFile(emptyPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'blocked_tool_substrings = [""]'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(emptyPath), /blocked_tool_substrings entries must be non-empty/);

  const newlinePath = join(directory, 'newline.toml');
  await writeFile(newlinePath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'blocked_tool_substrings = ["script\\nother"]'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(newlinePath), /blocked_tool_substrings entries may not contain control characters/);
});

test('gateway config permits every MCP entry to be disabled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-disabled-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.files]',
    'enabled = false'
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(path);
  assert.deepEqual(config.servers, []);
  assert.deepEqual(config.disabledServerNames, ['files']);
  assert.equal(config.publishToolDirectory, false);
});

test('gateway config requires publish_tool_directory to be boolean', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-tool-directory-config-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    'publish_tool_directory = "yes"',
    '[mcp_servers.files]',
    'enabled = false'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(path), /publish_tool_directory must be boolean/);
});

test('gateway config resolves the external tool annotations path beside gateway.toml', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-annotations-path-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    'tool_annotations_path = "annotations/tools.toml"',
    '[mcp_servers.alpha]',
    'command = "node"'
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(path);
  assert.equal(config.toolAnnotationsPath, join(directory, 'annotations', 'tools.toml'));
  assert.equal(config.servers[0].manageAnnotations, true);
});

test('gateway config requires annotation_config to be boolean', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-annotation-flag-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'annotation_config = "yes"'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(path), /annotation_config must be boolean/);
});

test('gateway config requires dangerous_allow_gateway_config_access to be boolean and defaults it to false', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-config-access-'));
  const invalidPath = join(directory, 'invalid.toml');
  await writeFile(invalidPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'dangerous_allow_gateway_config_access = "yes"'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(invalidPath), /dangerous_allow_gateway_config_access must be boolean/);

  const defaultPath = join(directory, 'default.toml');
  await writeFile(defaultPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"'
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(defaultPath);
  assert.equal(config.servers[0].dangerousAllowGatewayConfigAccess, false);
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

for (const platform of ['linux', 'darwin']) {
  test(`gateway path parsing uses POSIX rules on ${platform}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `gateway-${platform}-paths-`));
    const path = join(directory, 'gateway.toml');
    await writeFile(path, [
      'private_use_only = true',
      '[mcp_servers.alpha]',
      'command = "node"',
      'cwd = "/workspace"',
      'allowed_directories = ["/workspace"]',
      'allowed_files = ["/workspace/upload.png"]',
      'disallowed_directories = ["/workspace/private"]',
      'disallowed_files = ["/workspace/.env"]'
    ].join('\n'), 'utf8');

    const config = await loadGatewayConfig(path, { platform });
    assert.equal(config.servers[0].cwd, '/workspace');
    assert.deepEqual(config.servers[0].allowedDirectories, ['/workspace']);
    assert.deepEqual(config.servers[0].disallowedDirectories, ['/workspace/private']);
    assert.equal(serverConfigInternals.absoluteFrom('/repo/config', '../server', platform), '/repo/server');
  });
}

test('gateway rejects Windows-only allowlist paths on POSIX platforms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-posix-windows-path-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'cwd = "/workspace"',
    "allowed_directories = ['C:\\work\\project']"
  ].join('\n'), 'utf8');

  for (const platform of ['linux', 'darwin']) {
    await assert.rejects(loadGatewayConfig(path, { platform }), /allowed_directories entries must be absolute paths/);
  }
});

test('gateway accepts Codex-only token and approval settings and ignores unsupported fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-codex-only-'));
  const path = join(directory, 'codex-compatible.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'tool_output_token_limit = 1000',
    'unknown_codex_option = "kept in the source config"',
    '[mcp_servers.alpha.tools.dangerous]',
    'approval_mode = "approve"'
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(path);
  assert.equal(config.servers.length, 1);
  assert.equal(config.servers[0].name, 'alpha');
});
