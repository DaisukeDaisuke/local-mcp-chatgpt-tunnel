import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const checks = [];
const file = async (name, path) => {
  try { await access(path); checks.push({ name, ok: true, detail: path }); }
  catch { checks.push({ name, ok: false, detail: `missing: ${path}` }); }
};
const command = (name, executable, args = ['--version']) => new Promise((resolve) => {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (chunk) => { text += chunk; });
  child.stderr.on('data', (chunk) => { text += chunk; });
  child.once('error', (error) => { checks.push({ name, ok: false, detail: error.message }); resolve(); });
  child.once('exit', (code) => { checks.push({ name, ok: code === 0, detail: text.trim().split('\n')[0] || `exit ${code}` }); resolve(); });
});

await Promise.all([
  file('DQ9 configuration', process.env.DQ9_TEST_CONFIG ?? '/config/dq9-runtime.json'),
  file('Workspace', '/workspace'),
  command('Node.js', 'node'),
  command('Google Chrome', 'google-chrome-stable'),
  command('Chrome DevTools MCP', 'chrome-devtools-mcp'),
  command('Python Ghidra bridge runtime', '/opt/ghidra-mcp-venv/bin/python')
]);
const apiKeyPath = process.env.OPENAI_API_KEY_FILE ?? '/run/secrets/openai_api_key';
let keyMounted = false;
try { keyMounted = Boolean((await readFile(apiKeyPath, 'utf8')).trim()); } catch {}
checks.push({ name: 'OpenAI API mode', ok: true, detail: keyMounted ? 'key mounted; billable calls still require OPENAI_BILLING_ACK' : 'disabled; no key mounted' });
for (const check of checks) process.stdout.write(`${check.ok ? 'OK' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
