import { readFile } from 'node:fs/promises';
import { dirname, posix, resolve, win32 } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { normalizeDisallowedPathGlobs } from './path-glob.mjs';
import { parseToml } from './toml-lite.mjs';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RESERVED_POLICY_ENVIRONMENT = new Set([
  'LOCAL_MCP_ALLOWED_DIRECTORIES',
  'LOCAL_MCP_ALLOWED_FILES',
  'LOCAL_MCP_DISALLOWED_DIRECTORIES',
  'LOCAL_MCP_DISALLOWED_FILES',
  'LOCAL_MCP_DISALLOWED_PATH_GLOBS'
]);

function platformPath(platform = process.platform) {
  return platform === 'win32' ? win32 : posix;
}

const absoluteFrom = (base, value, platform = process.platform) => {
  const api = platformPath(platform);
  return api.isAbsolute(value) ? value : api.resolve(base, value);
};

function stringArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be an array of strings`);
  return value;
}

function blockedToolSubstringArray(value, name) {
  const values = stringArray(value, name);
  const normalized = [];
  const seen = new Set();
  for (const item of values) {
    if (item.trim().length === 0) throw new Error(`${name} entries must be non-empty`);
    if (/[\u0000-\u001f\u007f]/.test(item)) throw new Error(`${name} entries may not contain control characters`);
    const lowered = item.toLowerCase();
    if (!seen.has(lowered)) {
      seen.add(lowered);
      normalized.push(lowered);
    }
  }
  return normalized;
}

function absolutePathArray(value, name, platform = process.platform) {
  const values = stringArray(value, name);
  const api = platformPath(platform);
  for (const item of values) {
    if (!api.isAbsolute(item)) {
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

function normalizeServer(name, raw, base, platform) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`mcp_servers.${name} must be a table`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error(`mcp_servers.${name}.enabled must be boolean`);
  if (raw.enabled === false) return null;
  if (typeof raw.command !== 'string' || !raw.command.trim()) throw new Error(`mcp_servers.${name}.command is required when enabled`);
  if (raw.url !== undefined) throw new Error(`mcp_servers.${name}.url is not supported by this stdio gateway; use command and args`);
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || !raw.cwd)) throw new Error(`mcp_servers.${name}.cwd must be a non-empty string`);
  if (raw.prefix !== undefined && (typeof raw.prefix !== 'string' || !raw.prefix)) throw new Error(`mcp_servers.${name}.prefix must be a non-empty string`);
  if (raw.serial_group !== undefined && (typeof raw.serial_group !== 'string' || !raw.serial_group)) throw new Error(`mcp_servers.${name}.serial_group must be a non-empty string`);
  if (raw.deferred !== undefined && typeof raw.deferred !== 'boolean') throw new Error(`mcp_servers.${name}.deferred must be boolean`);
  if (raw.annotation_config !== undefined && typeof raw.annotation_config !== 'boolean') throw new Error(`mcp_servers.${name}.annotation_config must be boolean`);
  const timeoutSeconds = raw.tool_timeout_sec ?? raw.request_timeout_sec ?? 1800;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error(`mcp_servers.${name}.tool_timeout_sec must be positive`);
  const startupTimeoutSeconds = raw.startup_timeout_sec ?? 30;
  if (!Number.isFinite(startupTimeoutSeconds) || startupTimeoutSeconds <= 0) throw new Error(`mcp_servers.${name}.startup_timeout_sec must be positive`);
  const env = raw.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error(`mcp_servers.${name}.env must be a table`);
  if (Object.values(env).some((value) => !['string', 'number', 'boolean'].includes(typeof value))) {
    throw new Error(`mcp_servers.${name}.env values must be strings, numbers, or booleans`);
  }
  for (const environmentName of Object.keys(env)) {
    if (RESERVED_POLICY_ENVIRONMENT.has(environmentName.toUpperCase())) {
      throw new Error(`mcp_servers.${name}.env may not override reserved path-policy variable ${environmentName}`);
    }
  }
  return {
    name,
    prefix: typeof raw.prefix === 'string' && raw.prefix ? raw.prefix : name,
    command: raw.command,
    args: stringArray(raw.args, `mcp_servers.${name}.args`),
    cwd: absoluteFrom(base, typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : '.', platform),
    env,
    requestTimeoutMs: Math.round(timeoutSeconds * 1000),
    startupTimeoutMs: Math.round(startupTimeoutSeconds * 1000),
    serialGroup: typeof raw.serial_group === 'string' && raw.serial_group ? raw.serial_group : undefined,
    manageAnnotations: raw.annotation_config !== false,
    deferred: raw.deferred === true,
    startAfter: normalizeLifecycle(raw, 'start_after', name),
    stopAfter: normalizeLifecycle(raw, 'stop_after', name),
    blockedTools: new Set(stringArray(raw.blocked_tools, `mcp_servers.${name}.blocked_tools`)),
    blockedToolSubstrings: blockedToolSubstringArray(raw.blocked_tool_substrings, `mcp_servers.${name}.blocked_tool_substrings`),
    allowedDirectories: absolutePathArray(raw.allowed_directories, `mcp_servers.${name}.allowed_directories`, platform),
    allowedFiles: absolutePathArray(raw.allowed_files, `mcp_servers.${name}.allowed_files`, platform),
    disallowedDirectories: absolutePathArray(raw.disallowed_directories, `mcp_servers.${name}.disallowed_directories`, platform),
    disallowedFiles: absolutePathArray(raw.disallowed_files, `mcp_servers.${name}.disallowed_files`, platform),
    disallowedPathGlobs: normalizeDisallowedPathGlobs(raw.disallowed_path_globs, `mcp_servers.${name}.disallowed_path_globs`)
  };
}

export function configPathFromArgs(argv = process.argv.slice(2)) {
  const parsed = parseArgs({ args: argv, options: { config: { type: 'string' } }, strict: true, allowPositionals: false });
  return parsed.values.config ?? process.env.MCP_GATEWAY_CONFIG ?? resolve(repositoryRoot, 'config', 'gateway.toml');
}

export async function loadGatewayConfig(configPath = configPathFromArgs(), { platform = process.platform } = {}) {
  const resolvedConfigPath = absoluteFrom(repositoryRoot, configPath, process.platform);
  let raw;
  try {
    raw = parseToml(await readFile(resolvedConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`Gateway configuration is not readable at ${resolvedConfigPath}: ${error.message}`);
  }
  if (raw.private_use_only !== true) throw new Error('gateway.toml must set private_use_only = true');
  if (raw.publish_tool_directory !== undefined && typeof raw.publish_tool_directory !== 'boolean') {
    throw new Error('gateway.toml publish_tool_directory must be boolean');
  }
  if (raw.tool_annotations_path !== undefined && (typeof raw.tool_annotations_path !== 'string' || !raw.tool_annotations_path)) {
    throw new Error('gateway.toml tool_annotations_path must be a non-empty string');
  }
  if (!raw.mcp_servers || typeof raw.mcp_servers !== 'object' || Array.isArray(raw.mcp_servers)) {
    throw new Error('gateway.toml must define at least one [mcp_servers.<name>] table');
  }
  const base = dirname(resolvedConfigPath);
  const servers = [];
  const disabledServerNames = [];
  for (const [name, server] of Object.entries(raw.mcp_servers)) {
    const normalized = normalizeServer(name, server, base, platform);
    if (normalized) servers.push(normalized);
    else disabledServerNames.push(name);
  }
  return {
    configPath: resolvedConfigPath,
    toolAnnotationsPath: absoluteFrom(base, raw.tool_annotations_path ?? 'tool-annotations.toml', platform),
    privateUseOnly: true,
    publishToolDirectory: raw.publish_tool_directory === true,
    servers,
    disabledServerNames
  };
}

export const serverConfigInternals = {
  absoluteFrom,
  absolutePathArray
};
