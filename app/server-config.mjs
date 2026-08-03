import { access, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const absoluteFrom = (base, value) => isAbsolute(value) ? value : resolve(base, value);

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  return paths[0];
}

async function chromeMcpEntry() {
  const packagePath = join(repositoryRoot, 'node_modules', 'chrome-devtools-mcp', 'package.json');
  const metadata = JSON.parse(await readFile(packagePath, 'utf8'));
  const bin = typeof metadata.bin === 'string' ? metadata.bin : Object.values(metadata.bin ?? {})[0];
  if (!bin) throw new Error('chrome-devtools-mcp package has no executable entry');
  return resolve(dirname(packagePath), bin);
}

export async function loadGatewayConfig(configPath = process.env.MCP_GATEWAY_CONFIG ?? join(repositoryRoot, 'config', 'gateway.json')) {
  const resolvedConfigPath = absoluteFrom(repositoryRoot, configPath);
  let raw;
  try {
    raw = JSON.parse(await readFile(resolvedConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`Gateway configuration is not readable at ${resolvedConfigPath}: ${error.message}`);
  }
  const base = dirname(resolvedConfigPath);
  if (raw.privateUseOnly !== true) throw new Error('gateway.json must set privateUseOnly to true');
  const workspaceRoots = (raw.workspaceRoots ?? []).map((path) => absoluteFrom(base, path));
  if (workspaceRoots.length === 0) throw new Error('gateway.json must define at least one workspaceRoots entry');
  const dq9Config = absoluteFrom(base, raw.dq9Config ?? './dq9-runtime.json');
  const python = await firstExisting([
    join(repositoryRoot, '.venv', 'Scripts', 'python.exe'),
    join(repositoryRoot, '.venv', 'bin', 'python'),
    'python'
  ]);
  const common = { cwd: repositoryRoot, requestTimeoutMs: 30 * 60 * 1000 };
  const enabled = raw.enabledServers ? new Set(raw.enabledServers) : new Set(['files', 'dq9', 'chrome', 'ghidra']);
  const servers = [];
  if (enabled.has('files')) servers.push({
      ...common,
      name: 'files',
      prefix: 'files',
      command: process.execPath,
      args: [join(repositoryRoot, 'mcp', 'safe-files', 'server.mjs')],
      env: {
        SAFE_FILES_ROOTS: JSON.stringify(workspaceRoots),
        SAFE_FILES_ROOT_MARKER: raw.workspaceRootMarker ?? '.chatgpt-local-mcp-root'
      }
    });
  if (enabled.has('dq9')) servers.push({
      ...common,
      name: 'dq9',
      prefix: 'dq9',
      serialGroup: 'browser',
      command: process.execPath,
      args: [join(repositoryRoot, 'mcp', 'dq9-test', 'mcp-server.mjs')],
      env: {
        DQ9_TEST_CONFIG: dq9Config,
        DQ9_ALLOWED_SUITE_ROOTS: JSON.stringify(workspaceRoots),
        DQ9_WORKSPACE_ROOT_MARKER: raw.workspaceRootMarker ?? '.chatgpt-local-mcp-root'
      }
    });
  if (enabled.has('chrome')) servers.push({
      ...common,
      name: 'chrome',
      prefix: 'chrome',
      serialGroup: 'browser',
      deferred: true,
      startAfter: { server: 'dq9', tool: 'prepare_test_runtime' },
      stopAfter: { server: 'dq9', tool: 'stop_test_runtime' },
      command: process.execPath,
      args: [await chromeMcpEntry(), '--browser-url=http://127.0.0.1:9222', '--no-usage-statistics', '--no-performance-crux'],
      env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' }
    });
  if (enabled.has('ghidra')) servers.push({
      ...common,
      name: 'ghidra',
      prefix: 'ghidra',
      serialGroup: 'ghidra',
      command: python,
      args: [join(repositoryRoot, 'mcp', 'ghidra', 'bridge_mcp_ghidra.py'), '--transport', 'stdio', '--no-lazy'],
      env: {
        GHIDRA_MCP_URL: raw.ghidraUrl ?? 'http://127.0.0.1:8089',
        GHIDRA_DEBUGGER_URL: raw.ghidraDebuggerUrl ?? 'http://127.0.0.1:8099'
      },
      blockedTools: new Set(['run_ghidra_script', 'run_script_inline'])
    });
  const unknown = [...enabled].filter((name) => !['files', 'dq9', 'chrome', 'ghidra'].includes(name));
  if (unknown.length) throw new Error(`gateway.json contains unknown enabledServers: ${unknown.join(', ')}`);
  return {
    configPath: resolvedConfigPath,
    privateUseOnly: true,
    workspaceRoots,
    dq9Config,
    servers
  };
}
