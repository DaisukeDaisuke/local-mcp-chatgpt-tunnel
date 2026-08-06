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
  assert.match(install, /node mcp\\safe-download\\server\.mjs --help/);
  assert.match(install, /node mcp\\gh-workflow\\server\.mjs --help/);
  assert.doesNotMatch(install, /Expand-Archive|Invoke-WebRequest|enable-git-hooks|init-workspace/);
});

test('runtime key and tunnel id use tunnel-client native environment variables', async () => {
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8');
  assert.match(install, /CONTROL_PLANE_API_KEY/);
  assert.match(install, /CONTROL_PLANE_TUNNEL_ID/);
  assert.match(install, /SetEnvironmentVariable\(\s*'CONTROL_PLANE_API_KEY'/);
  assert.match(install, /\$env:CONTROL_PLANE_API_KEY = \$apiKey/);
  assert.doesNotMatch(install, /^\s*\$[^\n]*Read-Host/m);
  assert.doesNotMatch(install, /NetworkCredential\]::new|SecureStringToBSTR/);
  assert.match(install, /local-mcp-tunnel-runtime-no-model-api/);
  assert.match(install, /tunnel-client\.exe doctor --mcp\.command=/);
  assert.match(install, /tunnel-client\.exe run --mcp\.command=/);
  assert.doesNotMatch(install, /tunnel-client\.exe doctor[^\n]*--control-plane\.(?:api-key|tunnel-id)/);
  assert.doesNotMatch(install, /tunnel-client\.exe run[^\n]*--control-plane\.(?:api-key|tunnel-id)/);
  assert.doesNotMatch(install, /OPENAI_TUNNEL_API_KEY/);
  assert.doesNotMatch(install, /--control-plane\.api-key=sk_REPLACE_ME/);
  assert.doesNotMatch(install, /promptMasked|Tunnel runtime API key \(not saved\)/);
});

test('installation documents tunnel runtime roles and restricted API key creation', async () => {
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8');
  assert.match(install, /platform\.openai\.com\/settings\/organization\/people\/roles/);
  assert.match(install, /platform\.openai\.com\/settings\/organization\/people\/groups/);
  assert.match(install, /platform\.openai\.com\/settings\/organization\/api-keys/);
  assert.match(install, /Tunnels Read \+ Use/);
  assert.match(install, /モデルAPIに使えないTunnel専用キー/);
});

test('gateway uses Codex-style generic MCP tables and honors enabled entries', async () => {
  const config = await readFile(new URL('../config/gateway.example.toml', import.meta.url), 'utf8');
  assert.match(config, /\[mcp_servers\.files\]/);
  assert.match(config, /\[mcp_servers\.downloads\]/);
  assert.match(config, /command = "node"/);
  assert.match(config, /enabled = true/);
  assert.match(config, /publish_tool_directory = false/);
  assert.match(config, /disallowed_path_globs = \['\*\*\.ssh\*\*'\]/);
  const loader = await readFile(new URL('../app/server-config.mjs', import.meta.url), 'utf8');
  assert.match(loader, /raw\.mcp_servers/);
  assert.match(loader, /raw\.enabled === false/);
  assert.match(loader, /allowed_directories/);
  assert.match(loader, /allowed_files/);
  assert.match(loader, /disallowed_path_globs/);
  assert.doesNotMatch(loader, /chromeMcpEntry|enabledServers|workspaceRoots|dq9Config|ghidraUrl/);
});

test('child MCP environment is allowlisted instead of inheriting credentials', async () => {
  const child = await readFile(new URL('../app/stdio-child.mjs', import.meta.url), 'utf8');
  assert.match(child, /env: buildChildEnvironment\(\{ \.\.\.env, \.\.\.policyEnvironment \}\)/);
  assert.match(child, /LOCAL_MCP_ALLOWED_DIRECTORIES/);
  assert.match(child, /LOCAL_MCP_DISALLOWED_FILES/);
  assert.match(child, /LOCAL_MCP_DISALLOWED_PATH_GLOBS/);
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
  assert.match(filesServer, /process working directory is exposed as the MCP root/i);
  assert.match(filesServer, /accept both paths relative to the current MCP root and absolute paths/i);
  assert.match(filesServer, /Every resolved path must remain inside a configured allowed directory/i);
  assert.doesNotMatch(filesServer, /--root <path>|parseSafeFilesArgs/);
  assert.doesNotMatch(filesServer, /chatgpt-local-mcp-root|ROOT_MARKER/);
  assert.doesNotMatch(filesServer, /name:\s*['"](?:execute|start_command|without_sandbox|shell)['"]/);
  assert.match(filesServer, /spawn\('git', args/);
  assert.match(filesServer, /spawn\('rg', args/);
  const gateway = await readFile(new URL('../app/gateway.mjs', import.meta.url), 'utf8');
  assert.match(gateway, /ToolPathPolicy/);
  assert.match(gateway, /assertToolArguments/);
});

test('bundled MCP tools declare structured output schemas and safe-download is independently rooted', async () => {
  for (const path of ['../mcp/safe-files/server.mjs', '../mcp/safe-images/server.mjs', '../mcp/safe-download/server.mjs', '../mcp/gh-workflow/server.mjs']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /outputSchema/);
  }
  const download = await readFile(new URL('../mcp/safe-download/server.mjs', import.meta.url), 'utf8');
  assert.match(download, /SAFE_DOWNLOAD_ROOTS/);
  assert.match(download, /spawn\('rg', args, \{[^}]*shell:\s*false/s);
  assert.doesNotMatch(download, /rgArgs|exec\(|execFile\(|shell:\s*true/);
});

test('bundled gh-workflow MCP exposes only bounded inspection and run cancellation without a shell', async () => {
  const source = await readFile(new URL('../mcp/gh-workflow/server.mjs', import.meta.url), 'utf8');
  assert.match(source, /spawn\('gh', args, \{[^}]*cwd,[^}]*shell:\s*false/s);
  assert.match(source, /At least one --repository=OWNER\/REPO is required/);
  assert.match(source, /'--exit-status'/);
  assert.match(source, /'run',\s*'cancel'/);
  assert.doesNotMatch(source, /exec\(|execFile\(|shell:\s*true/);
  assert.doesNotMatch(source, /'delete'|'rerun'|'download'|'workflow',\s*'run'|'api'/);
  const config = await readFile(new URL('../config/gateway.example.toml', import.meta.url), 'utf8');
  assert.match(config, /\[mcp_servers\.gh_workflow\]/);
  assert.match(config, /mcp\\gh-workflow\\server\.mjs/);
  assert.match(config, /--repository=DaisukeDaisuke\/desmume_webassembly/);
  assert.match(config, /\[mcp_servers\.gh_workflow\][\s\S]*?cwd = '[^']+'[\s\S]*?enabled = false/);
});

test('gitmcp preserves normal Git configuration while disabling only executable repository-controlled paths', async () => {
  const source = await readFile(new URL('../mcp/gitmcp/server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /GIT_CONFIG_NOSYSTEM/);
  assert.doesNotMatch(source, /GIT_CONFIG_KEY_\d+: 'core\.attributesFile'/);
  assert.doesNotMatch(source, /GIT_CONFIG_KEY_\d+: '(?:commit|tag|merge)\.gpgsign'/);
  assert.doesNotMatch(source, /GIT_CONFIG_KEY_\d+: 'diff\.external'/);
  assert.doesNotMatch(source, /--no-gpg-sign/);
  assert.doesNotMatch(source, /--no-textconv|--no-ext-diff/);
  assert.match(source, /'--ext-diff', '--textconv'/);
  assert.match(source, /configuredCommitSigningRespected: true/);
  assert.match(source, /lineEndingConversionRespected: true/);
  assert.match(source, /systemAndGlobalCleanSmudgeFiltersRespected: true/);
  assert.match(source, /\/\^\(local\|worktree\)\\s\//);
});

test('gateway publishes an exact access-scope tool and installation guidance requires using it instead of remembered paths', async () => {
  const gateway = await readFile(new URL('../app/gateway.mjs', import.meta.url), 'utf8');
  const scope = await readFile(new URL('../app/access-scope.mjs', import.meta.url), 'utf8');
  const install = await readFile(new URL('../INSTALL.md', import.meta.url), 'utf8');
  assert.match(scope, /get_gateway_access_scope/);
  assert.match(scope, /exact current gateway-enforced allow\/deny path scope/i);
  assert.match(gateway, /pathPolicy\.describe\(\)/);
  assert.match(gateway, /call it before assuming a working directory or allowed local path/);
  assert.match(install, /過去チャットの記憶で補わない/);
  assert.match(install, /get_gateway_access_scope/);
  assert.match(install, /gateway__list_available_tools/);
  assert.match(install, /新しいGitHub Actions runを特定して完了まで確認する/);
  assert.match(install, /全jobの成功を確認する前に「全環境で成功した」と断定しない/);
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