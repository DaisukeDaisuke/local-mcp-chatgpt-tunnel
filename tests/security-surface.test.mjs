import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
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

test('runtime key is not persisted and PowerShell installers are gone', async () => {
  const windowsScripts = await readdir(new URL('../scripts/windows/', import.meta.url));
  assert.deepEqual(windowsScripts, ['README.md']);
  const tunnelCommon = await readFile(new URL('../scripts/node/tunnel-common.mjs', import.meta.url), 'utf8');
  assert.match(tunnelCommon, /not saved/);
  assert.match(tunnelCommon, /delete process\.env\.CONTROL_PLANE_API_KEY/);
  assert.doesNotMatch(tunnelCommon, /writeFile|tunnel-runtime-key/);
  const launcher = await readFile(new URL('../app/gateway-launcher.mjs', import.meta.url), 'utf8');
  assert.match(launcher, /scrubSecretEnvironment/);
  assert.match(launcher, /await import\('\.\/gateway\.mjs'\)/);
  const gateway = await readFile(new URL('../app/gateway.mjs', import.meta.url), 'utf8');
  assert.match(gateway, /scrubSecretEnvironment\(process\.env\)/);
  assert.match(gateway, /assertNotElevatedWindows/);
});

test('child MCP environment is allowlisted instead of inheriting credentials', async () => {
  const child = await readFile(new URL('../app/stdio-child.mjs', import.meta.url), 'utf8');
  assert.match(child, /env: buildChildEnvironment\(env\)/);
  assert.doesNotMatch(child, /env:\s*\{\s*\.\.\.process\.env/);
  const policy = await import('../app/child-environment.mjs');
  const environment = policy.buildChildEnvironment({ SAFE_FILES_ROOTS: '[]' }, {
    PATH: 'safe',
    AWS_ACCESS_KEY_ID: 'secret',
    OPENAI_API_KEY: 'secret',
    GH_TOKEN: 'secret',
    GITHUB_PAT: 'secret',
    DISCORD_TOKEN: 'secret',
    NODE_OPTIONS: '--require malicious.js'
  });
  assert.equal(environment.PATH, 'safe');
  assert.equal(environment.SAFE_FILES_ROOTS, '[]');
  assert.equal(environment.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.GITHUB_PAT, undefined);
  assert.equal(environment.DISCORD_TOKEN, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
});

test('tunnel client acquisition is manual and does not use the GitHub API', async () => {
  await assert.rejects(access(new URL('../scripts/node/download-tunnel-client.mjs', import.meta.url)));
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['tunnel:download'], undefined);
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8');
  assert.match(install, /releases\/latest\/download\/tunnel-client-v0\.0\.10-windows-amd64\.zip/);
  assert.match(install, /releases\/latest\/download\/SHA256SUMS\.txt/);
  assert.match(install, /Get-FileHash/);
  assert.doesNotMatch(install, /api\.github\.com/);
  assert.doesNotMatch(install, /Expand-Archive|Invoke-WebRequest|download-tunnel-client/);
});

test('setup scripts refuse elevated Windows execution and npm lifecycle scripts are disabled', async () => {
  for (const path of ['../scripts/node/init-workspace.mjs', '../scripts/node/enable-git-hooks.mjs']) {
    const script = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(script, /assertNotElevatedWindows/);
  }
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8');
  assert.match(install, /npm install --ignore-scripts/);
  assert.doesNotMatch(install, /@latest/);
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
  assert.match(filesServer, /name: 'search_text'/);
  assert.match(filesServer, /name: 'read_file_chunk'/);
  assert.match(filesServer, /spawn\('git', args/);
  assert.match(filesServer, /spawn\('rg', args/);
  const dq9Server = await readFile(new URL('../mcp/dq9-test/mcp-server.mjs', import.meta.url), 'utf8');
  assert.match(dq9Server, /DQ9_ALLOWED_SUITE_ROOTS/);
  const suitePolicy = await readFile(new URL('../mcp/dq9-test/src/services/suite-file-policy.mjs', import.meta.url), 'utf8');
  assert.match(suitePolicy, /SUITE_PATH_OUTSIDE_WORKSPACE/);
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
