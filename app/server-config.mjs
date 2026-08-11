import { readFile, realpath } from 'node:fs/promises';
import { dirname, posix, resolve, win32 } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { normalizeDisallowedPathGlobs } from './path-glob.mjs';
import { parseToml } from './toml-lite.mjs';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const gatewayLogsDirectory = resolve(repositoryRoot, 'logs');
const CODEX_SCRIPT_SERVER_PATH = resolve(repositoryRoot, 'mcp', 'codex-script', 'server.mjs');
const BUILD_V5T_ASSEMBLY_SERVER_PATH = resolve(repositoryRoot, 'mcp', 'buildv5tassembly', 'server.mjs');
const BUNDLED_SERVER_PATHS = [
  ['mcp', 'safe-files', 'server.mjs'],
  ['mcp', 'safe-images', 'server.mjs'],
  ['mcp', 'safe-download', 'server.mjs'],
  ['mcp', 'gitmcp', 'server.mjs'],
  ['mcp', 'git-capability', 'server.mjs'],
  ['mcp', 'gh-workflow', 'server.mjs'],
  ['mcp', 'codex-script', 'server.mjs'],
  ['mcp', 'buildv5tassembly', 'server.mjs']
].map((parts) => resolve(repositoryRoot, ...parts));

const SERVER_SANDBOX_MODES = new Set(['never', 'elevated', 'unelevated']);

const RESERVED_POLICY_ENVIRONMENT = new Set([
  'LOCAL_MCP_ALLOWED_DIRECTORIES',
  'LOCAL_MCP_ALLOWED_FILES',
  'LOCAL_MCP_DISALLOWED_DIRECTORIES',
  'LOCAL_MCP_DISALLOWED_FILES',
  'LOCAL_MCP_DISALLOWED_PATH_GLOBS',
  'LOCAL_MCP_GATEWAY_ISOLATION_KEY',
  'LOCAL_MCP_CODEX_SANDBOX_MODE',
  'LOCAL_MCP_CODEX_EXECUTABLE'
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

function comparablePath(value, platform = process.platform) {
  const normalized = platformPath(platform).normalize(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathWithin(directory, candidate, platform = process.platform) {
  const api = platformPath(platform);
  const path = api.relative(directory, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${api.sep}`) && !api.isAbsolute(path));
}

function isBundledServer(command, args, cwd, platform = process.platform) {
  if (platform !== process.platform || args.length === 0) return false;
  const executable = platformPath(platform).basename(command).toLowerCase();
  if (executable !== 'node' && executable !== 'node.exe') return false;
  const candidate = comparablePath(absoluteFrom(cwd, args[0], platform), platform);
  return BUNDLED_SERVER_PATHS.some((path) => comparablePath(path, platform) === candidate);
}

function isCodexScriptServer(command, args, cwd, platform = process.platform) {
  if (platform !== process.platform || args.length === 0) return false;
  const executable = platformPath(platform).basename(command).toLowerCase();
  if (executable !== 'node' && executable !== 'node.exe') return false;
  return comparablePath(absoluteFrom(cwd, args[0], platform), platform) === comparablePath(CODEX_SCRIPT_SERVER_PATH, platform);
}

function isBuildV5tAssemblyServer(command, args, cwd, platform = process.platform) {
  if (platform !== process.platform || args.length === 0) return false;
  const executable = platformPath(platform).basename(command).toLowerCase();
  if (executable !== 'node' && executable !== 'node.exe') return false;
  return comparablePath(absoluteFrom(cwd, args[0], platform), platform) === comparablePath(BUILD_V5T_ASSEMBLY_SERVER_PATH, platform);
}

function normalizeSandbox(raw, serverName) {
  const value = raw.sandbox ?? 'never';
  if (typeof value !== 'string' || !SERVER_SANDBOX_MODES.has(value)) {
    throw new Error(`mcp_servers.${serverName}.sandbox must be one of: never, elevated, unelevated`);
  }
  return value;
}

function normalizeAbsoluteExecutable(value, name, platform = process.platform) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty absolute path`);
  if (!platformPath(platform).isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function normalizeNativeExecutable(value, name, platform = process.platform) {
  const executable = normalizeAbsoluteExecutable(value, name, platform);
  if (platform === 'win32' && !/\.exe$/i.test(executable)) {
    throw new Error(`${name} must point to a native .exe on Windows`);
  }
  return executable;
}

function normalizeCodexExecutable(value, name, platform = process.platform) {
  return normalizeAbsoluteExecutable(value, name, platform);
}

function normalizeLifecycle(raw, key, serverName) {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`mcp_servers.${serverName}.${key} must be a table`);
  if (typeof value.server !== 'string' || typeof value.tool !== 'string') throw new Error(`mcp_servers.${serverName}.${key} requires server and tool`);
  return { server: value.server, tool: value.tool };
}

function protectedLogPolicyEntries(allowedDirectories, allowedFiles, protectedDirectory, platform = process.platform) {
  if (platform !== process.platform) return { directories: [], files: [] };
  const directories = [];
  for (const allowed of allowedDirectories) {
    if (pathWithin(allowed, protectedDirectory, platform)) directories.push(protectedDirectory);
    else if (pathWithin(protectedDirectory, allowed, platform)) directories.push(allowed);
  }
  const files = allowedFiles.filter((allowed) => pathWithin(protectedDirectory, allowed, platform));
  return {
    directories: [...new Set(directories)],
    files: [...new Set(files)]
  };
}

function normalizeServer(name, raw, base, platform, protectedGatewayConfigPaths, protectedGatewayLogDirectory) {
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
  if (raw.dangerous_allow_gateway_config_access !== undefined && typeof raw.dangerous_allow_gateway_config_access !== 'boolean') {
    throw new Error(`mcp_servers.${name}.dangerous_allow_gateway_config_access must be boolean`);
  }
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
  const args = stringArray(raw.args, `mcp_servers.${name}.args`);
  const cwd = absoluteFrom(base, typeof raw.cwd === 'string' && raw.cwd ? raw.cwd : '.', platform);
  const sandbox = normalizeSandbox(raw, name);
  const codexScriptServer = isCodexScriptServer(raw.command, args, cwd, platform);
  const buildV5tAssemblyServer = isBuildV5tAssemblyServer(raw.command, args, cwd, platform);
  if (codexScriptServer && sandbox === 'never') {
    throw new Error(`mcp_servers.${name}.sandbox must be elevated or unelevated for codex-script`);
  }
  if (buildV5tAssemblyServer && sandbox === 'never') {
    throw new Error(`mcp_servers.${name}.sandbox must be elevated or unelevated for buildv5tassembly`);
  }
  const sandboxDelegated = false;
  const command = sandbox === 'elevated'
    ? normalizeNativeExecutable(raw.command, `mcp_servers.${name}.command`, platform)
    : raw.command;
  const codexExecutable = sandbox !== 'never'
    ? normalizeCodexExecutable(raw.codex_executable, `mcp_servers.${name}.codex_executable`, platform)
    : undefined;
  const allowedDirectories = absolutePathArray(raw.allowed_directories, `mcp_servers.${name}.allowed_directories`, platform);
  const allowedFiles = absolutePathArray(raw.allowed_files, `mcp_servers.${name}.allowed_files`, platform);
  const protectedGatewayLogs = protectedLogPolicyEntries(
    allowedDirectories,
    allowedFiles,
    protectedGatewayLogDirectory,
    platform
  );
  const sandboxReadOnlyDirectories = absolutePathArray(raw.sandbox_read_only_directories, `mcp_servers.${name}.sandbox_read_only_directories`, platform);
  if (sandbox !== 'never' && !allowedDirectories.some((directory) => pathWithin(directory, cwd, platform))) {
    throw new Error(`mcp_servers.${name}.cwd must be inside allowed_directories when sandbox is enabled`);
  }
  if (sandbox !== 'never' && allowedDirectories.some((directory) => pathWithin(directory, codexExecutable, platform))) {
    throw new Error(`mcp_servers.${name}.codex_executable must be outside allowed_directories so sandboxed code cannot modify it`);
  }
  if (sandbox === 'elevated' && allowedDirectories.some((directory) => pathWithin(directory, command, platform))) {
    throw new Error(`mcp_servers.${name}.command must be outside allowed_directories so the sandboxed MCP cannot modify its executable`);
  }
  return {
    name,
    prefix: typeof raw.prefix === 'string' && raw.prefix ? raw.prefix : name,
    command,
    args,
    cwd,
    isBundled: isBundledServer(raw.command, args, cwd, platform),
    sandbox,
    sandboxDelegated,
    codexExecutable,
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
    allowedDirectories,
    allowedFiles,
    sandboxReadOnlyDirectories,
    disallowedDirectories: absolutePathArray(raw.disallowed_directories, `mcp_servers.${name}.disallowed_directories`, platform),
    disallowedFiles: absolutePathArray(raw.disallowed_files, `mcp_servers.${name}.disallowed_files`, platform),
    disallowedPathGlobs: normalizeDisallowedPathGlobs(raw.disallowed_path_globs, `mcp_servers.${name}.disallowed_path_globs`),
    dangerousAllowGatewayConfigAccess: raw.dangerous_allow_gateway_config_access === true,
    protectedGatewayConfigPaths,
    protectedGatewayLogDirectories: protectedGatewayLogs.directories,
    protectedGatewayLogFiles: protectedGatewayLogs.files
  };
}

export function configPathFromArgs(argv = process.argv.slice(2)) {
  const parsed = parseArgs({ args: argv, options: { config: { type: 'string' } }, strict: true, allowPositionals: false });
  return parsed.values.config ?? process.env.MCP_GATEWAY_CONFIG ?? resolve(repositoryRoot, 'config', 'gateway.toml');
}

export async function loadGatewayConfig(configPath = configPathFromArgs(), { platform = process.platform } = {}) {
  const resolvedConfigPath = absoluteFrom(repositoryRoot, configPath, process.platform);
  let canonicalConfigPath;
  let raw;
  try {
    canonicalConfigPath = await realpath(resolvedConfigPath);
    raw = parseToml(await readFile(canonicalConfigPath, 'utf8'));
  } catch (error) {
    throw new Error(`Gateway configuration is not readable at ${resolvedConfigPath}: ${error.message}`);
  }
  if (raw.private_use_only !== true) throw new Error('gateway.toml must set private_use_only = true');
  if (raw.publish_tool_directory !== undefined && typeof raw.publish_tool_directory !== 'boolean') {
    throw new Error('gateway.toml publish_tool_directory must be boolean');
  }
  if (raw['enable-logging-files'] !== undefined && typeof raw['enable-logging-files'] !== 'boolean') {
    throw new Error('gateway.toml enable-logging-files must be boolean');
  }
  if (raw.tool_annotations_path !== undefined && (typeof raw.tool_annotations_path !== 'string' || !raw.tool_annotations_path)) {
    throw new Error('gateway.toml tool_annotations_path must be a non-empty string');
  }
  if (!raw.mcp_servers || typeof raw.mcp_servers !== 'object' || Array.isArray(raw.mcp_servers)) {
    throw new Error('gateway.toml must define at least one [mcp_servers.<name>] table');
  }
  const base = dirname(resolvedConfigPath);
  const protectedGatewayConfigPaths = [...new Set([resolvedConfigPath, canonicalConfigPath])];
  const servers = [];
  const disabledServerNames = [];
  for (const [name, server] of Object.entries(raw.mcp_servers)) {
    const normalized = normalizeServer(
      name,
      server,
      base,
      platform,
      protectedGatewayConfigPaths,
      gatewayLogsDirectory
    );
    if (normalized) servers.push(normalized);
    else disabledServerNames.push(name);
  }
  return {
    configPath: resolvedConfigPath,
    canonicalConfigPath,
    toolAnnotationsPath: absoluteFrom(base, raw.tool_annotations_path ?? 'tool-annotations.toml', platform),
    privateUseOnly: true,
    publishToolDirectory: raw.publish_tool_directory === true,
    enableLoggingFiles: raw['enable-logging-files'] === true,
    gatewayLogsDirectory,
    servers,
    disabledServerNames
  };
}

export const serverConfigInternals = {
  absoluteFrom,
  absolutePathArray
};
