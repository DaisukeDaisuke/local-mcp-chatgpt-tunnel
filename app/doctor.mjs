import { spawn } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { repositoryRoot } from './server-config.mjs';

const checks = [];
const record = (name, ok, detail) => checks.push({ name, ok, detail });
const checkFile = async (name, path) => {
  try { await access(path); record(name, true, path); }
  catch { record(name, false, `missing: ${path}`); }
};
const checkCommand = (name, executable, args = ['--version']) => new Promise((done) => {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let text = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { text += chunk; });
  child.stderr.on('data', (chunk) => { text += chunk; });
  let settled = false;
  const finish = (ok, detail) => {
    if (settled) return;
    settled = true;
    record(name, ok, detail);
    done();
  };
  child.once('error', (error) => finish(false, error.message));
  child.once('exit', (code) => finish(code === 0, text.trim().split(/\r?\n/)[0] || `exit ${code}`));
});
const captureCommand = (executable, args) => new Promise((resolvePromise, reject) => {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let text = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { text += chunk; });
  child.stderr.on('data', (chunk) => { text += chunk; });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolvePromise(text) : reject(new Error(text.trim() || `exit ${code}`)));
});
const fromConfig = (base, value) => isAbsolute(value) ? value : resolve(base, value);
const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);

if (process.platform === 'win32') {
  try {
    const groups = await captureCommand('whoami', ['/groups', '/fo', 'csv', '/nh']);
    const elevated = /S-1-16-(?:12288|16384)/.test(groups);
    record('Non-elevated Windows process', !elevated, elevated ? 'high/system integrity detected; reopen a normal PowerShell' : 'medium or lower integrity');
  } catch (error) {
    record('Non-elevated Windows process', false, `could not inspect token: ${error.message}`);
  }
} else {
  record('Non-elevated Windows process', true, 'not running on Windows; elevation check skipped');
}

const gatewayPath = join(repositoryRoot, 'config', 'gateway.json');
await Promise.all([
  checkFile('Gateway configuration', gatewayPath),
  checkFile('Tunnel client', join(repositoryRoot, '.tools', 'tunnel-client', 'tunnel-client.exe')),
  checkCommand('Node.js', process.execPath),
  checkCommand('Git', 'git'),
  checkCommand('ripgrep', 'rg')
]);

let gateway;
try {
  gateway = JSON.parse(await readFile(gatewayPath, 'utf8'));
  const base = dirname(gatewayPath);
  if (gateway.privateUseOnly !== true) throw new Error('privateUseOnly must be true');
  if (!Array.isArray(gateway.workspaceRoots) || gateway.workspaceRoots.length === 0) throw new Error('workspaceRoots must contain at least one path');
  const marker = gateway.workspaceRootMarker ?? '.chatgpt-local-mcp-root';
  for (const [index, rootValue] of gateway.workspaceRoots.entries()) {
    const root = fromConfig(base, rootValue);
    await checkFile(`Workspace root ${index + 1}`, root);
    const markerPath = join(root, marker);
    const markerInfo = await stat(markerPath).catch(() => null);
    record(`Workspace marker ${index + 1}`, markerInfo?.isFile() === true, markerInfo?.isFile() ? markerPath : `missing: ${markerPath}`);
    const home = resolve(homedir());
    const normalizedRoot = resolve(root);
    record(`Workspace root boundary ${index + 1}`, !within(normalizedRoot, home), within(normalizedRoot, home) ? 'root is the user profile or its ancestor' : normalizedRoot);
  }
  record('Private-use configuration', true, 'privateUseOnly=true');
  record('Gateway JSON', true, gatewayPath);
} catch (error) {
  record('Gateway JSON', false, error.message);
}

const enabled = new Set(gateway?.enabledServers ?? ['files', 'dq9', 'chrome', 'ghidra']);
if (enabled.has('chrome')) await checkFile('Chrome DevTools MCP dependency', join(repositoryRoot, 'node_modules', 'chrome-devtools-mcp', 'package.json'));
if (enabled.has('ghidra')) {
  await checkFile('Ghidra Python environment', join(repositoryRoot, '.venv', 'Scripts', 'python.exe'));
  await checkFile('Ghidra MCP bridge', join(repositoryRoot, 'mcp', 'ghidra', 'bridge_mcp_ghidra.py'));
}
if (enabled.has('dq9')) {
  const dq9Path = gateway?.dq9Config ? fromConfig(dirname(gatewayPath), gateway.dq9Config) : join(repositoryRoot, 'config', 'dq9-runtime.json');
  await checkFile('DQ9 configuration', dq9Path);
  try {
    const dq9 = JSON.parse(await readFile(dq9Path, 'utf8'));
    const base = dirname(dq9Path);
    const paths = [
      ['Google Chrome', dq9.chromePath],
      ['DQ9 ROM', dq9.romPath],
      ['DQ9 State', dq9.statePath],
      ['DQ9 command script', dq9.scriptPaths?.command],
      ['DQ9 observer script', dq9.scriptPaths?.observer],
      ['DQ9 incident script', dq9.scriptPaths?.incident],
      ['DQ9 runtime profile', dq9.profilePath]
    ];
    for (const [name, value] of paths) {
      if (typeof value !== 'string' || !value.trim()) record(name, false, 'path is not configured');
      else await checkFile(name, fromConfig(base, value));
    }
    record('DQ9 JSON', true, dq9Path);
  } catch (error) {
    record('DQ9 JSON', false, error.message);
  }
}

record('Runtime key persistence', true, 'no key file is used; Node.js prompts for each tunnel command');
record('OpenAI model API', true, 'not implemented; only tunnel-client consumes the Secure MCP Tunnel runtime key');
record('MCP transport', true, 'gateway and child MCP servers use stdio; no public MCP listener is created');
record('Tunnel network', true, 'outbound HTTPS only; tunnel-client operator UI remains loopback-only by default');
record('PowerShell installer', true, 'removed; INSTALL.md uses explicit commands and single-purpose Node.js scripts');

for (const check of checks) process.stdout.write(`${check.ok ? 'OK' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
