import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
const fromConfig = (base, value) => isAbsolute(value) ? value : resolve(base, value);

const gatewayPath = join(repositoryRoot, 'config', 'gateway.json');
await Promise.all([
  checkFile('Gateway configuration', gatewayPath),
  checkFile('Tunnel client', join(repositoryRoot, '.tools', 'tunnel-client', 'tunnel-client.exe')),
  checkCommand('Node.js', process.execPath),
  checkCommand('Git', 'git')
]);

let gateway;
try {
  gateway = JSON.parse(await readFile(gatewayPath, 'utf8'));
  const base = dirname(gatewayPath);
  if (!Array.isArray(gateway.workspaceRoots) || gateway.workspaceRoots.length === 0) throw new Error('workspaceRoots must contain at least one path');
  for (const [index, root] of gateway.workspaceRoots.entries()) await checkFile(`Workspace root ${index + 1}`, fromConfig(base, root));
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

record('OpenAI model API', true, 'not implemented; only the Secure MCP Tunnel runtime key is consumed by tunnel-client');
record('MCP transport', true, 'gateway and child MCP servers use stdio; no public MCP port is opened');
record('Tunnel network', true, 'outbound HTTPS only; tunnel-client may expose its operator health UI on Windows loopback');

for (const check of checks) process.stdout.write(`${check.ok ? 'OK' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;