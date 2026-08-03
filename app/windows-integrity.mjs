import { spawn } from 'node:child_process';

function capture(executable, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { text += chunk; });
    child.stderr.on('data', (chunk) => { text += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise(text) : reject(new Error(text.trim() || `whoami exited with ${code}`)));
  });
}

export async function windowsIntegrityLevel() {
  if (process.platform !== 'win32') return 'not-windows';
  const groups = await capture('whoami', ['/groups', '/fo', 'csv', '/nh']);
  if (/S-1-16-16384/.test(groups)) return 'system';
  if (/S-1-16-12288/.test(groups)) return 'high';
  if (/S-1-16-8192/.test(groups)) return 'medium';
  if (/S-1-16-4096/.test(groups)) return 'low';
  return 'unknown';
}

export async function assertNotElevatedWindows() {
  const level = await windowsIntegrityLevel();
  if (level === 'high' || level === 'system') throw new Error(`Refusing to run local MCP with ${level} Windows integrity. Open a normal non-administrator PowerShell.`);
  return level;
}
