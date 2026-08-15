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

test('TOML comments do not participate in string parsing', () => {
  const parsed = parseToml([
    'private_use_only = true',
    "# The gateway's comments may contain apostrophes.",
    'publish_tool_directory = false # trailing comment',
    'tool_annotations_path = "tool-#annotations.toml" # hash inside a string is data'
  ].join('\n'));
  assert.deepEqual(parsed, {
    private_use_only: true,
    publish_tool_directory: false,
    tool_annotations_path: 'tool-#annotations.toml'
  });
});

test('gateway config keeps arbitrary enabled stdio MCPs and skips disabled entries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-toml-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    'enable-logging-files = true',
    'publish_tool_directory = true',
    '[mcp_servers.alpha]',
    "command = 'C:\\runtime\\node.exe'",
    "args = ['alpha.mjs']",
    "cwd = 'C:\\work\\project'",
    'enabled = true',
    'prefix = "a"',
    'annotation_config = false',
    'sandbox = "elevated"',
    "codex_executable = 'C:\\runtime\\codex.exe'",
    'dangerous_allow_gateway_config_access = true',
    'startup_timeout_sec = 5',
    'tool_timeout_sec = 15',
    'deferred = true',
    'serial_group = "browser"',
    'blocked_tools = ["dangerous"]',
    'blocked_tool_substrings = ["script", "shell"]',
    "allowed_directories = ['C:\\work\\project']",
    "allowed_files = ['C:\\Users\\owner\\Downloads\\upload.png']",
    "sandbox_read_only_directories = ['C:\\tools\\alpha-mcp']",
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
  assert.equal(config.enableLoggingFiles, true);
  assert.equal(config.publishToolDirectory, true);
  assert.deepEqual(config.disabledServerNames, ['beta']);
  assert.equal(config.servers[0].name, 'alpha');
  assert.equal(config.servers[0].prefix, 'a');
  assert.equal(config.servers[0].manageAnnotations, false);
  assert.equal(config.servers[0].sandbox, 'elevated');
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
  assert.deepEqual(config.servers[0].sandboxReadOnlyDirectories, ['C:\\tools\\alpha-mcp']);
  assert.deepEqual(config.servers[0].disallowedDirectories, ['C:\\work\\project\\private']);
  assert.deepEqual(config.servers[0].disallowedFiles, ['C:\\work\\project\\.env']);
  assert.deepEqual(config.servers[0].disallowedPathGlobs, ['**.ssh**']);
});

test('gateway file logging is disabled by default and requires a boolean top-level flag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-file-logging-config-'));
  const defaultPath = join(directory, 'default.toml');
  await writeFile(defaultPath, [
    'private_use_only = true',
    '[mcp_servers.files]',
    'enabled = false'
  ].join('\n'), 'utf8');
  const defaultConfig = await loadGatewayConfig(defaultPath);
  assert.equal(defaultConfig.enableLoggingFiles, false);

  const invalidPath = join(directory, 'invalid.toml');
  await writeFile(invalidPath, [
    'private_use_only = true',
    'enable-logging-files = "yes"',
    '[mcp_servers.files]',
    'enabled = false'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(invalidPath), (error) => {
    assert.equal(error.message, 'gateway.toml enable-logging-files must be boolean');
    return true;
  });
});

test('gateway log protection is added only where configured access overlaps the logs directory', async () => {
  const root = resolve('.');
  const logs = resolve('logs');
  const outside = await mkdtemp(join(tmpdir(), 'gateway-log-protection-outside-'));
  const directory = await mkdtemp(join(tmpdir(), 'gateway-log-protection-config-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.inside]',
    'command = "node"',
    `cwd = '${root}'`,
    `allowed_directories = ['${root}']`,
    '[mcp_servers.outside]',
    'command = "node"',
    `cwd = '${outside}'`,
    `allowed_directories = ['${outside}']`
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(path);
  assert.deepEqual(config.servers[0].protectedGatewayLogDirectories, [logs]);
  assert.deepEqual(config.servers[0].protectedGatewayLogFiles, []);
  assert.deepEqual(config.servers[1].protectedGatewayLogDirectories, []);
  assert.deepEqual(config.servers[1].protectedGatewayLogFiles, []);
});

test('gateway config rejects unsupported MCP sandbox modes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-sandbox-mode-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    'sandbox = "dangerFullAccess"'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(path), (error) => {
    assert.equal(error.message, 'mcp_servers.alpha.sandbox must be one of: never, elevated, unelevated, onlineworkspace');
    return true;
  });
});

test('internet bundled MCP requires onlineworkspace and keeps the sandbox at MCP startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-internet-sandbox-'));
  const workspace = join(directory, 'workspace');
  const serverPath = resolve('mcp/internet/server.mjs');
  const goodPath = join(directory, 'good.toml');
  await writeFile(goodPath, [
    'private_use_only = true',
    '[mcp_servers.internet]',
    `command = '${process.execPath}'`,
    `args = ['${serverPath}']`,
    `cwd = '${workspace}'`,
    'sandbox = "onlineworkspace"',
    `codex_executable = '${process.execPath}'`,
    `allowed_directories = ['${workspace}']`
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(goodPath);
  assert.equal(config.servers[0].isBundled, true);
  assert.equal(config.servers[0].sandbox, 'onlineworkspace');
  assert.equal(config.servers[0].sandboxDelegated, false);

  const badPath = join(directory, 'bad.toml');
  await writeFile(badPath, [
    'private_use_only = true',
    '[mcp_servers.internet]',
    `command = '${process.execPath}'`,
    `args = ['${serverPath}']`,
    `cwd = '${workspace}'`,
    'sandbox = "elevated"',
    `codex_executable = '${process.execPath}'`,
    `allowed_directories = ['${workspace}']`
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(badPath), /sandbox must be onlineworkspace for internet/);
});

test('gateway requires absolute command paths only for elevated sandbox mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-sandbox-executables-'));
  const commandPath = join(directory, 'relative-command.toml');
  await writeFile(commandPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    `cwd = '${directory}'`,
    'sandbox = "elevated"',
    `codex_executable = '${join(directory, 'codex.exe')}'`,
    `allowed_directories = ['${directory}']`
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(commandPath), (error) => {
    assert.equal(error.message, 'mcp_servers.alpha.command must be an absolute path');
    return true;
  });

  const unelevatedPath = join(directory, 'unelevated-command.toml');
  await writeFile(unelevatedPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    "cwd = 'C:\\work\\project'",
    'sandbox = "unelevated"',
    "codex_executable = 'C:\\tools\\codex.cmd'",
    "allowed_directories = ['C:\\work\\project']"
  ].join('\n'), 'utf8');
  const unelevated = await loadGatewayConfig(unelevatedPath, { platform: 'win32' });
  assert.equal(unelevated.servers[0].command, 'node');
  assert.equal(unelevated.servers[0].codexExecutable, 'C:\\tools\\codex.cmd');

  const codexPath = join(directory, 'relative-codex.toml');
  await writeFile(codexPath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    `command = '${process.execPath}'`,
    `cwd = '${directory}'`,
    'sandbox = "elevated"',
    'codex_executable = "codex.exe"',
    `allowed_directories = ['${directory}']`
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(codexPath), (error) => {
    assert.equal(error.message, 'mcp_servers.alpha.codex_executable must be an absolute path');
    return true;
  });
});

test('gateway requires sandboxed MCP cwd to stay inside its writable allowlist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-sandbox-cwd-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    `command = '${join(directory, 'node.exe')}'`,
    `cwd = '${directory}'`,
    'sandbox = "elevated"',
    `codex_executable = '${join(directory, 'codex.exe')}'`,
    `allowed_directories = ['${join(directory, 'workspace')}']`
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(path), (error) => {
    assert.equal(error.message, 'mcp_servers.alpha.cwd must be inside allowed_directories when sandbox is enabled');
    return true;
  });
});

test('gateway config reserves the delegated Codex sandbox marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-sandbox-marker-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    '[mcp_servers.alpha.env]',
    'LOCAL_MCP_CODEX_SANDBOX_MODE = "elevated"'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(path), (error) => {
    assert.equal(error.message, 'mcp_servers.alpha.env may not override reserved path-policy variable LOCAL_MCP_CODEX_SANDBOX_MODE');
    return true;
  });

  const executablePath = join(directory, 'gateway-executable.toml');
  await writeFile(executablePath, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    'command = "node"',
    '[mcp_servers.alpha.env]',
    "LOCAL_MCP_CODEX_EXECUTABLE = 'C:\\fake\\codex.exe'"
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(executablePath), (error) => {
    assert.equal(error.message, 'mcp_servers.alpha.env may not override reserved path-policy variable LOCAL_MCP_CODEX_EXECUTABLE');
    return true;
  });
});

test('bundled codex-script is sandboxed once at MCP startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-codex-script-'));
  const path = join(directory, 'gateway.toml');
  const serverPath = resolve('mcp/codex-script/server.mjs');
  const cwd = join(directory, 'workspace');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.script]',
    `command = '${process.execPath}'`,
    `args = ['${serverPath}', '--mode=run', '--runtime=mjs', '--runtime-executable=${process.execPath}']`,
    `cwd = '${cwd}'`,
    'sandbox = "elevated"',
    `codex_executable = '${join(directory, 'codex.exe')}'`,
    `allowed_directories = ['${cwd}']`
  ].join('\n'), 'utf8');
  const config = await loadGatewayConfig(path);
  assert.equal(config.servers[0].isBundled, true);
  assert.equal(config.servers[0].sandboxDelegated, false);
  assert.equal(config.servers[0].sandbox, 'elevated');
  assert.equal(config.servers[0].cwd, cwd);
});

test('gateway keeps sandbox executable trust anchors outside writable roots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-sandbox-trust-anchor-'));
  const path = join(directory, 'gateway.toml');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.alpha]',
    `command = '${join(directory, 'node.exe')}'`,
    `cwd = '${directory}'`,
    'sandbox = "elevated"',
    `codex_executable = '${join(tmpdir(), 'codex.exe')}'`,
    `allowed_directories = ['${directory}']`
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(path), (error) => {
    assert.equal(error.message, 'mcp_servers.alpha.command must be outside allowed_directories so the sandboxed MCP cannot modify its executable');
    return true;
  });
});

test('gateway refuses codex-script without a Codex sandbox mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-codex-script-unsandboxed-'));
  const path = join(directory, 'gateway.toml');
  const serverPath = resolve('mcp/codex-script/server.mjs');
  await writeFile(path, [
    'private_use_only = true',
    '[mcp_servers.script]',
    `command = '${process.execPath}'`,
    `args = ['${serverPath}', '--mode=run', '--runtime=mjs', '--runtime-executable=${process.execPath}']`,
    `cwd = '${resolve('.')}'`,
    'sandbox = "never"'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(path), (error) => {
    assert.equal(error.message, 'mcp_servers.script.sandbox must be elevated or unelevated for codex-script');
    return true;
  });
});

test('bundled buildv5tassembly requires a Codex sandbox and remains marked bundled', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-buildv5tassembly-'));
  const serverPath = resolve('mcp/buildv5tassembly/server.mjs');
  const cwd = join(directory, 'workspace');
  const sandboxedPath = join(directory, 'sandboxed.toml');
  await writeFile(sandboxedPath, [
    'private_use_only = true',
    '[mcp_servers.builder]',
    `command = '${process.execPath}'`,
    `args = ['${serverPath}', '--preprocessor-module=${join(directory, 'preprocessor.mjs')}', '--gcc-executable=${join(directory, 'gcc.exe')}', '--objcopy-executable=${join(directory, 'objcopy.exe')}']`,
    `cwd = '${cwd}'`,
    'sandbox = "elevated"',
    `codex_executable = '${join(directory, 'codex.exe')}'`,
    `allowed_directories = ['${cwd}']`
  ].join('\n'), 'utf8');
  const sandboxed = await loadGatewayConfig(sandboxedPath);
  assert.equal(sandboxed.servers[0].isBundled, true);
  assert.equal(sandboxed.servers[0].sandbox, 'elevated');

  const unsandboxedPath = join(directory, 'unsandboxed.toml');
  await writeFile(unsandboxedPath, [
    'private_use_only = true',
    '[mcp_servers.builder]',
    `command = '${process.execPath}'`,
    `args = ['${serverPath}']`,
    `cwd = '${resolve('.')}'`,
    'sandbox = "never"'
  ].join('\n'), 'utf8');
  await assert.rejects(loadGatewayConfig(unsandboxedPath), (error) => {
    assert.equal(error.message, 'mcp_servers.builder.sandbox must be elevated or unelevated for buildv5tassembly');
    return true;
  });
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

  const capabilityPath = resolve('mcp/git-capability/server.mjs');
  const capabilityConfigPath = join(directory, 'git-capability.toml');
  await writeFile(capabilityConfigPath, [
    'private_use_only = true',
    '[mcp_servers.git_commit]',
    `command = '${process.execPath}'`,
    `args = ['${capabilityPath}', '--mode=commit', '--git-executable=${process.execPath}']`,
    `cwd = '${cwd}'`,
    `allowed_directories = ['${cwd}']`,
    'sandbox = "never"'
  ].join('\n'), 'utf8');
  const capability = await loadGatewayConfig(capabilityConfigPath);
  assert.equal(capability.servers[0].isBundled, true);
  assert.equal(capability.servers[0].sandbox, 'never');
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
