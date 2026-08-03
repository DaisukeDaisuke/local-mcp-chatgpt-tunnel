import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function createDefaultCommands({ platform = process.platform, env = process.env } = {}) {
  const npm = platform === 'win32'
    ? {
        name: 'npm',
        command: env.ComSpec || env.COMSPEC || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npm --version']
      }
    : { name: 'npm', command: 'npm', args: ['--version'] };

  return [
    { name: 'node', command: 'node', args: ['--version'] },
    npm,
    { name: 'git', command: 'git', args: ['--version'] },
    { name: 'rg', command: 'rg', args: ['--version'] },
    { name: 'py', command: 'py', args: ['--version'] }
  ];
}

export const DEFAULT_COMMANDS = createDefaultCommands();

function firstLine(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

function spawnErrorDetail(error) {
  if (error?.code === 'ENOENT') return 'not found in PATH';
  const code = error?.code ?? error?.errno;
  return code === undefined
    ? String(error?.message ?? error)
    : `spawn failed (${code}): ${error?.message ?? 'unknown error'}`;
}

export function checkCommand(spec, spawnImpl = spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(spec.command, spec.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      resolve({ ...spec, ok: false, detail: spawnErrorDetail(error) });
      return;
    }
    let output = '';
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => { output += chunk; });
    child.stderr?.on?.('data', (chunk) => { output += chunk; });
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill?.();
      finish(false, 'timed out while requesting version');
    }, spec.timeoutMs ?? 10000);
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ...spec, ok, detail });
    };
    child.once('error', (error) => finish(false, spawnErrorDetail(error)));
    child.once('exit', (code) => {
      const version = firstLine(output);
      finish(code === 0 && version !== '', version || `exit ${code ?? 'unknown'} without version output`);
    });
  });
}

export async function runDoctor({ commands = DEFAULT_COMMANDS, spawnImpl = spawn, output = process.stdout } = {}) {
  const results = await Promise.all(commands.map((command) => checkCommand(command, spawnImpl)));
  for (const result of results) output.write(`${result.ok ? 'OK' : 'FAIL'}  ${result.name}: ${result.detail}\n`);
  const failed = results.filter((result) => !result.ok);
  output.write(failed.length === 0
    ? 'OK  summary: all required commands returned a version\n'
    : `FAIL  summary: ${failed.map((result) => result.name).join(', ')} need installation or PATH repair\n`);
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await runDoctor();
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}