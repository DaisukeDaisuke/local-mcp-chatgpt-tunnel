import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, resolve, win32 } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseToml } from './toml-lite.mjs';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const absoluteFrom = (base, value) => isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value) ? value : resolve(base, value);

function stringArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be an array of strings`);
  return value;
}

function absolutePathArray(value, name) {
  const values = stringArray(value, name);
  for (const item of values) {
    if (!isAbsolute(item) && !win32.isAbsolute(item) && !posix.isAbsolute(item)) {
      throw new Error(`${name} entries must be absolute paths: ${item}`);
    }
  }
  return values;
}

function normalizeLifecycle(raw, key, serverName) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`mcp_servers.${serverName}.${key} must be a table`);
  if (typeof value.server !== 'string' || typeof value.tool !== 'string') throw new Error(`mcp_servers.${serverName}.${key} requires server and tool`);
  return { server: value.server, tool: value.tool };
}

function normalizeServer(name, raw, base) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`mcp_servers.${name} must be a table`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error(`mcp_servers.${name}.enabled must be boolean`);
  if (raw.enabled === false) return null;
  if (typeof raw.command !== 'string' || !raw.command.trim()) throw new Error(`mcp_servers.${name}.command is required when enabled`);
  if (raw.url !== undefined) throw new Error(`mcp_servers.${name}.url is not supported by this stdio gateway; use command and args`);
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || !raw.cwd)) throw new Error(`mcp_servers.${name}.cwd must be a non-empty string`);
  if (raw.prefix !== undefined && (typeof raw.prefix !== 'string' || !raw.prefix)) throw new Error(`mcp_servers.${name}.prefix must be a non-empty string`);
  if (raw.serial_group !== undefined && (typeof raw.serial_group !== 'string' || !raw.serial_group)) throw new Error(`mcp_servers.${name}.serial_group must be a non-empty string`);
  if (raw.deferred !== undefined && typeof raw.deferred !== 'boolean') throw new Error(`mcp_servers.${name}.deferred must be boolean`);
  const timeoutSeconds = raw.tool_timeout_sec ?? raw.request_timeout_sec ?? 1800;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error(`mcp_servers.${name}.tool_timeout_sec must be positive`);
  const startupTimeoutSeconds = raw.startup_timeout_sec ?? 30;
  if (!Number.isFinite(startupTimeoutSeconds) || startupTimeoutSeconds <= 0) throw new Error(`mcp_servers.${name}.startup_timeout_sec must be positive`);
  const env = raw.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error(`mcp_servers.${name}.env must be a table`);
  if (Object.values(env).some((value) => !['string', 'number', 'boolean'].includes(typeof value))) {
    throw new Error(`mcp_servers.${name}.env values must be strings, numbers, or booleans`);
  }
  return {
    name,
    prefix: typeof raw.prefix === 'string' && raw.prefix ? raw.prefix : name,
    command: raw.command,
    args: stringArray(raw.args, `mcp_servers.${name}.args`),
    cwd: absoluteFrom(base, typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : '.'),
    env,
    requestTimeoutMs: Math.round(timeoutSeconds * 1000),
    startupTimeoutMs: Math.round(startupTimeoutSeconds * 1000),
    serialGroup: typeof raw.serial_group === 'string' && raw.serial_group ? raw.serial_group : undefined,
    deferred: raw.deferred === true,
    startAfter: normalizeLifecycle(raw, 'start_after', name),
    stopAfter: normalizeLifecycle(raw, 'stop_after', name),
    blockedTools: new Set(stringArray(raw.blocked_tools, `mcp_servers.${name}.blocked_tools`)),
    allowedDirectories: absolutePathArray(raw.allowed_directories, `mcp_servers.${name}.allowed_directories`),
    allowedFiles: absolutePathArray(raw.allowed_files, `mcp_servers.${name}.allowed_files`)
  };
}

export function configPathFromArgs(argv = process.argv.slice(2)) {
  const parsed = parseArgs({ args: argv, options: { config: { type: 'string' } }, strict: true, allowPositionals: false });
  return parsed.values.config ?? process.env.MCP_GATEWAY_CONFIG ?? resolve(repositoryRoot, 'config', 'gateway.toml');
}

export async function loadGatewayConfig(configPath = configPathFromArgs()) {
  const resolvedConfigPath = absoluteFrom(repositoryRoot, configPath);
  let raw;
  try {
    raw = parseToml(await readFile(resolvedConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`Gateway configuration is not readable at ${resolvedConfigPath}: ${error.message}`);
  }
  if (raw.private_use_only !== true) throw new Error('gateway.toml must set private_use_only = true');
  if (!raw.mcp_servers || typeof raw.mcp_servers !== 'object' || Array.isArray(raw.mcp_servers)) {
    throw new Error('gateway.toml must define at least one [mcp_servers.<name>] table');
  }
  const base = dirname(resolvedConfigPath);
  const servers = Object.entries(raw.mcp_servers).map(([name, server]) => normalizeServer(name, server, base)).filter(Boolean);
  return { configPath: resolvedConfigPath, privateUseOnly: true, servers };
}
