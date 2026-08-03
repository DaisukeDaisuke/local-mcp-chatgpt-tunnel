import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('repository is a Secure MCP Tunnel gateway, not an OpenAI model harness', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  assert.equal(Object.keys(dependencies).length, 0);
  assert.equal(dependencies.openai, undefined);
  const gateway = await readFile(new URL('../app/gateway.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(gateway, /responses\.create|chat\.completions|createServer\s*\(|listen\s*\(/);
  await assert.rejects(access(new URL('../Dockerfile', import.meta.url)));
  await assert.rejects(access(new URL('../compose.yaml', import.meta.url)));
});

test('installation automation and repository hook mutation are absent', async () => {
  for (const path of [
    '../scripts/node/init-workspace.mjs',
    '../scripts/node/enable-git-hooks.mjs',
    '../scripts/node/run-tunnel.mjs',
    '../scripts/node/initialize-tunnel.mjs',
    '../.githooks/pre-commit'
  ]) await assert.rejects(access(new URL(path, import.meta.url)));
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), ['doctor', 'gateway', 'test']);
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8');
  assert.match(install, /node app\\doctor\.mjs/);
  assert.match(install, /node mcp\\safe-files\\server\.mjs --help/);
  assert.doesNotMatch(install, /Expand-Archive|Invoke-WebRequest|enable-git-hooks|init-workspace/);
});

test('runtime key goes directly to tunnel-client and is not handled by repository scripts', async () => {
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8');
  assert.match(install, /--control-plane\.api-key=env:OPENAI_TUNNEL_API_KEY/);
  assert.match(install, /tunnel-client\.exe doctor/);
  assert.match(install, /tunnel-client\.exe run/);
  assert.doesNotMatch(install, /--control-plane\.api-key=sk_REPLACE_ME/);
  assert.doesNotMatch(install, /promptMasked|Tunnel runtime API key \(not saved\)/);
});

test('gateway uses Codex-style generic MCP tables and honors enabled entries', async () => {
  const config = await readFile(new URL('../config/gateway.example.toml', import.meta.url), 'utf8');
  assert.match(config, /\[mcp_servers\.files\]/);
  assert.match(config, /command = "node"/);
  assert.match(config, /enabled = true/);
  const loader = await readFile(new URL('../app/server-config.mjs', import.meta.url), 'utf8');
  assert.match(loader, /raw\.mcp_servers/);
  assert.match(loader, /raw\.enabled === false/);
  assert.match(loader, /allowed_directories/);
  assert.match(loader, /allowed_files/);
  assert.doesNotMatch(loader, /chromeMcpEntry|enabledServers|workspaceRoots|dq9Config|ghidraUrl/);
});

test('child MCP environment is allowlisted instead of inheriting credentials', async () => {
  const child = await readFile(new URL('../app/stdio-child.mjs', import.meta.url), 'utf8');
  assert.match(child, /env: buildChildEnvironment\(env\)/);
  assert.doesNotMatch(child, /env:\s*\{\s*\.\.\.process\.env/);
  const policy = await import('../app/child-environment.mjs');
  const environment = policy.buildChildEnvironment({ EXPLICIT: 'yes' }, {
    PATH: 'safe',
    AWS_ACCESS_KEY_ID: 'secret',
    OPENAI_API_KEY: 'secret',
    GH_TOKEN: 'secret',
    DISCORD_TOKEN: 'secret',
    NODE_OPTIONS: '--require malicious.js'
  });
  assert.equal(environment.PATH, 'safe');
  assert.equal(environment.EXPLICIT, 'yes');
  assert.equal(environment.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.DISCORD_TOKEN, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
});

test('safe-files uses cwd while the gateway applies generic path allowlists', async () => {
  const filesServer = await readFile(new URL('../mcp/safe-files/server.mjs', import.meta.url), 'utf8');
  assert.match(filesServer, /process working directory is the workspace root/i);
  assert.doesNotMatch(filesServer, /--root <path>|parseSafeFilesArgs/);
  assert.doesNotMatch(filesServer, /chatgpt-local-mcp-root|ROOT_MARKER/);
  assert.doesNotMatch(filesServer, /name:\s*['"](?:execute|start_command|without_sandbox|shell)['"]/);
  assert.match(filesServer, /spawn\('git', args/);
  assert.match(filesServer, /spawn\('rg', args/);
  const gateway = await readFile(new URL('../app/gateway.mjs', import.meta.url), 'utf8');
  assert.match(gateway, /ToolPathPolicy/);
  assert.match(gateway, /assertToolArguments/);
});

test('third-party Ghidra and DQ9 MCP implementations are not redistributed', async () => {
  await assert.rejects(access(new URL('../mcp/ghidra', import.meta.url)));
  await assert.rejects(access(new URL('../mcp/dq9-test', import.meta.url)));
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(packageJson.scripts.test, /dq9-test|ghidra/);
});

test('tunnel client acquisition remains manual and uses the public release endpoint', async () => {
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8');
  assert.match(install, /releases\/latest\/download\/tunnel-client-v0\.0\.10-windows-amd64\.zip/);
  assert.match(install, /releases\/latest\/download\/SHA256SUMS\.txt/);
  assert.match(install, /Get-FileHash/);
  assert.doesNotMatch(install, /api\.github\.com/);
});

test('ChatGPT setup uses direct Developer Mode and connector creation links', async () => {
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8');
  assert.match(install, /chatgpt\.com\/plugins#settings\/Security\?section=developer-mode/);
  assert.match(install, /chatgpt\.com\/plugins#settings\/Connectors\?create-connector=true/);
  assert.match(install, /developers\.openai\.com\/plugins\/deploy\/connect-chatgpt/);
});