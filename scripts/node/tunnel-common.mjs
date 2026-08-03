import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { buildChildEnvironment } from '../../app/child-environment.mjs';
import { repositoryRoot } from '../../app/server-config.mjs';
import { assertNotElevatedWindows } from '../../app/windows-integrity.mjs';

export const tunnelClientPath = join(repositoryRoot, '.tools', 'tunnel-client', 'tunnel-client.exe');
export const gatewayLauncherPath = join(repositoryRoot, 'app', 'gateway-launcher.mjs');

export function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export async function requireTunnelClient() {
  await access(tunnelClientPath).catch(() => {
    throw new Error('tunnel-client.exe is missing. Run: node scripts/node/download-tunnel-client.mjs');
  });
}

async function promptMasked(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Set CONTROL_PLANE_API_KEY for non-interactive use');
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  let value = '';
  try {
    return await new Promise((resolvePromise, reject) => {
      const onData = (chunk) => {
        for (const character of chunk) {
          if (character === '\u0003') {
            cleanup();
            reject(new Error('Cancelled'));
            return;
          }
          if (character === '\r' || character === '\n') {
            cleanup();
            process.stdout.write('\n');
            resolvePromise(value);
            return;
          }
          if (character === '\u007f' || character === '\b') {
            if (value) {
              value = value.slice(0, -1);
              process.stdout.write('\b \b');
            }
            continue;
          }
          value += character;
          process.stdout.write('*');
        }
      };
      const cleanup = () => process.stdin.off('data', onData);
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

function tunnelEnvironment(runtimeKey) {
  const environment = buildChildEnvironment({ CONTROL_PLANE_API_KEY: runtimeKey });
  for (const name of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

export async function obtainRuntimeKey() {
  const fromEnvironment = process.env.CONTROL_PLANE_API_KEY;
  delete process.env.CONTROL_PLANE_API_KEY;
  const runtimeKey = fromEnvironment?.trim() || (await promptMasked('Tunnel runtime API key (not saved): ')).trim();
  if (!runtimeKey) throw new Error('Tunnel runtime API key is empty');
  return runtimeKey;
}

export async function runTunnelClient(args, suppliedRuntimeKey) {
  await assertNotElevatedWindows();
  await requireTunnelClient();
  const runtimeKey = suppliedRuntimeKey ?? await obtainRuntimeKey();
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn(tunnelClientPath, args, {
        cwd: repositoryRoot,
        env: tunnelEnvironment(runtimeKey),
        stdio: 'inherit',
        windowsHide: true,
        shell: false
      });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`tunnel-client exited with ${code}`)));
    });
  } finally {
    delete process.env.CONTROL_PLANE_API_KEY;
  }
}

export function fixedGatewayCommand() {
  return `"${process.execPath}" "${gatewayLauncherPath}"`;
}
