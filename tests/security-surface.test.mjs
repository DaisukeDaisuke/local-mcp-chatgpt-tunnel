import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('repository is a Secure MCP Tunnel gateway, not an OpenAI model harness', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.equal(dependencies.openai, undefined);
  assert.equal(dependencies['@openai/agents'], undefined);
  const gateway = await readFile(new URL('../app/gateway.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(gateway, /responses\.create|chat\.completions|createServer\s*\(|listen\s*\(/);
  await assert.rejects(access(new URL('../Dockerfile', import.meta.url)));
  await assert.rejects(access(new URL('../compose.yaml', import.meta.url)));
});

test('Chrome and Ghidra stay on Windows loopback', async () => {
  const launcher = await readFile(new URL('../mcp/dq9-test/src/cdp/browser-launcher.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /--headless=new/);
  assert.match(launcher, /--remote-debugging-address=127\.0\.0\.1/);
  assert.doesNotMatch(launcher, /--no-sandbox/);
  const gatewayConfig = await readFile(new URL('../config/gateway.example.json', import.meta.url), 'utf8');
  assert.match(gatewayConfig, /127\.0\.0\.1:8089/);
  assert.match(gatewayConfig, /127\.0\.0\.1:8099/);
});

test('arbitrary host and Ghidra script execution tools are absent', async () => {
  const filesServer = await readFile(new URL('../mcp/safe-files/server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(filesServer, /name:\s*['"](?:execute|start_command|without_sandbox|shell)['"]/);
  assert.match(filesServer, /name: 'apply_patch'/);
  assert.match(filesServer, /name: 'set_working_directory'/);
  assert.match(filesServer, /spawn\('git', args/);
  const ghidra = await readFile(new URL('../mcp/ghidra/bridge_mcp_ghidra.py', import.meta.url), 'utf8');
  assert.match(ghidra, /Suppressing arbitrary-code Ghidra tool/);
  assert.match(ghidra, /run_ghidra_script/);
  assert.match(ghidra, /run_script_inline/);
  const config = await readFile(new URL('../app/server-config.mjs', import.meta.url), 'utf8');
  assert.match(config, /blockedTools: new Set\(\['run_ghidra_script', 'run_script_inline'\]\)/);
  assert.match(config, /deferred: true/);
  assert.match(config, /startAfter: \{ server: 'dq9', tool: 'prepare_test_runtime' \}/);
  assert.match(config, /stopAfter: \{ server: 'dq9', tool: 'stop_test_runtime' \}/);
});