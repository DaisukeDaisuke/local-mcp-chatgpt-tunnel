import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  ACCESS_SCOPE_TOOL_NAME,
  accessScopeMcpResult,
  accessScopeToolDefinition
} from './access-scope.mjs';
import { scrubSecretEnvironment } from './child-environment.mjs';
import { ToolPathPolicy } from './path-policy.mjs';
import { StdioMcpChild } from './stdio-child.mjs';
import { loadGatewayConfig } from './server-config.mjs';
import {
  BUNDLED_ISOLATION_ARGUMENT,
  assertNoPublicRootOverride,
  signBundledIsolationContext
} from './bundled-isolation.mjs';
import {
  ISOLATED_CLOSE_TOOL,
  ISOLATED_CREATE_TOOL,
  ISOLATED_LIST_TOOL,
  isolatedMcpResult,
  isolatedToolDefinitions,
  isolatedToolNames,
  requireIsolatedId,
  validateIsolatedId
} from './isolated-workspaces.mjs';
import {
  applyConfiguredAnnotations,
  loadToolAnnotationConfig,
  syncDiscoveredToolAnnotations
} from './tool-annotations.mjs';
import {
  GATEWAY_CHILDS_MCP_ASYNC_STATUS_NAME,
  GATEWAY_CONFIG_NAME,
  PREFIX_LIST_NAME,
  TOOL_DIRECTORY_NAME,
  createGatewayConfigPayload,
  createPrefixListPayload,
  createToolDirectoryPayload,
  gatewayBuiltinToolDefinitions,
  gatewayBuiltinToolNames,
  gatewayOperationalToolDefinitions,
  gatewayConfigMcpResult,
  prefixListMcpResult,
  toolDirectoryMcpResult
} from './tool-directory.mjs';
import { assertNotElevatedWindows } from './windows-integrity.mjs';
import { assertSandboxPathPolicyCompatible } from './sandbox-path-policy.mjs';
import { createGatewayInfoLogger } from './gateway-info-log.mjs';
import { gatewayPathPolicyArguments } from './gateway-path-arguments.mjs';
import { sandboxDotPathWarningLines } from './sandbox-hidden-path-warning.mjs';
import {
  createGatewayChildAsyncRegistry,
  gatewayChildAsyncPromotionMcpResult,
  gatewayChildAsyncStatusMcpResult
} from './gateway-child-async.mjs';

scrubSecretEnvironment(process.env);
await assertNotElevatedWindows();

const MAX_TOOL_NAME = 64;
const DEFAULT_TEXT_RESPONSE_LIMIT_BYTES = 200 * 1024;
const TEXT_RESPONSE_PREVIEW_BYTES = 512;
const FILES_RESPONSE_LIMIT_ENV = 'LOCAL_MCP_FILES_MAX_RESPONSE_BYTES';
const CODESPACE_RESPONSE_LIMIT_ENV = 'LOCAL_MCP_CODESPACE_MAX_RESPONSE_BYTES';
const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function textResponseLimitBytes(environmentName, environment = process.env) {
  const raw = environment[environmentName];
  if (raw === undefined || raw === '') return DEFAULT_TEXT_RESPONSE_LIMIT_BYTES;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${environmentName} must be a positive integer number of bytes`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${environmentName} must be a positive safe integer number of bytes`);
  }
  return value;
}

const filesResponseLimit = textResponseLimitBytes(FILES_RESPONSE_LIMIT_ENV);
const codespaceResponseLimit = textResponseLimitBytes(CODESPACE_RESPONSE_LIMIT_ENV);

function formatTextBytes(bytes) {
  const kibibyte = 1024;
  const mebibyte = kibibyte * 1024;
  const gibibyte = mebibyte * 1024;
  if (bytes >= gibibyte) return `${Math.ceil((bytes / gibibyte) * 10) / 10}GB`;
  if (bytes >= mebibyte) return `${Math.ceil((bytes / mebibyte) * 10) / 10}MB`;
  return `${Math.ceil(bytes / kibibyte)}KB`;
}

function utf8Prefix(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function pathInside(directory, candidate) {
  const path = relative(directory, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function canonicalExecutable(path, label) {
  const actual = await realpath(path);
  if (!(await stat(actual)).isFile()) throw new Error(`${label} must point to a regular file`);
  return actual;
}

async function canonicalCodespaceSshKeygenExecutable() {
  const candidates = process.platform === 'win32'
    ? [join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe')]
    : ['/usr/bin/ssh-keygen', '/bin/ssh-keygen'];
  const failures = [];
  for (const candidate of candidates) {
    try {
      return await canonicalExecutable(candidate, 'codespace ssh-keygen');
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`codespace requires the system ssh-keygen executable (${failures.join('; ')})`);
}
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const warn = (message) => process.stderr.write(`[gateway] ${message}\n`);

const namespacedName = (prefix, name) => {
  const normalized = `${prefix}__${name}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized.length <= MAX_TOOL_NAME) return normalized;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${normalized.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
};

class SerialQueues {
  constructor() { this.tails = new Map(); }
  run(group, operation) {
    if (!group) return operation();
    const previous = this.tails.get(group) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.tails.set(group, tail);
    void tail.then(() => {
      if (this.tails.get(group) === tail) this.tails.delete(group);
    });
    return current;
  }
}

const config = await loadGatewayConfig();
const gatewayInfoLogger = createGatewayInfoLogger({
  enabled: config.enableLoggingFiles,
  directory: config.gatewayLogsDirectory
});
const info = (message) => gatewayInfoLogger.info(message);
for (const line of sandboxDotPathWarningLines(config)) info(line);
const toolAnnotationConfig = await loadToolAnnotationConfig(
  config.toolAnnotationsPath,
  config.servers.filter((server) => server.manageAnnotations).map((server) => server.prefix)
);
const queues = new SerialQueues();
const childAsyncRegistry = createGatewayChildAsyncRegistry();
const children = [];
const childrenByName = new Map();
const childStarts = new Map();
const unavailableServers = [];
const toolRoutes = new Map();
const isolatedWorkspaces = new Map();
const usedIsolatedIds = new Set();
const pendingIsolatedIds = new Set();
let started = false;
let upstreamInitialized = false;
let exposureReportLogged = false;
let initializationPromise = null;

function blockedToolReason(childConfig, toolName) {
  if (childConfig.blockedTools?.has(toolName)) return { type: 'exact', value: toolName };
  const lowered = toolName.toLowerCase();
  const substring = childConfig.blockedToolSubstrings?.find((candidate) => lowered.includes(candidate));
  return substring ? { type: 'substring', value: substring } : null;
}

const gatewayOperationalToolNames = new Set(gatewayOperationalToolDefinitions.map((tool) => tool.name));
const collidesWithGatewayBuiltin = (publicName) => gatewayOperationalToolNames.has(publicName)
  || (config.publishToolDirectory && gatewayBuiltinToolNames.has(publicName));

function rebuildRoutes() {
  toolRoutes.clear();
  for (const child of children) {
    for (const tool of child.tools) {
      if (tool.name === ACCESS_SCOPE_TOOL_NAME) continue;
      if (blockedToolReason(child.config, tool.name)) continue;
      const publicName = namespacedName(child.config.prefix, tool.name);
      if (collidesWithGatewayBuiltin(publicName) || isolatedToolNames.has(publicName)) throw new Error(`Tool name collision: ${publicName}`);
      if (toolRoutes.has(publicName)) throw new Error(`Tool name collision: ${publicName}`);
      const annotatedTool = child.config.manageAnnotations
        ? applyConfiguredAnnotations(tool, child.config.prefix, toolAnnotationConfig)
        : tool;
      const publicTool = { ...annotatedTool, name: publicName };
      toolRoutes.set(publicName, {
        child,
        originalName: tool.name,
        tool: child.config.isBundled ? requireIsolatedId(publicTool) : publicTool
      });
    }
    const accessScopePublicName = namespacedName(child.config.prefix, ACCESS_SCOPE_TOOL_NAME);
    if (collidesWithGatewayBuiltin(accessScopePublicName) || isolatedToolNames.has(accessScopePublicName)) throw new Error(`Tool name collision: ${accessScopePublicName}`);
    if (toolRoutes.has(accessScopePublicName)) throw new Error(`Tool name collision: ${accessScopePublicName}`);
    const publicAccessScopeTool = { ...accessScopeToolDefinition, name: accessScopePublicName };
    toolRoutes.set(accessScopePublicName, {
      child,
      originalName: ACCESS_SCOPE_TOOL_NAME,
      synthetic: 'access-scope',
      tool: child.config.isBundled ? requireIsolatedId(publicAccessScopeTool) : publicAccessScopeTool
    });
  }
}

const hasBundledChildren = () => children.some((child) => child.config.isBundled);

function publishedTools() {
  const tools = [...toolRoutes.values()].map((route) => route.tool);
  if (hasBundledChildren()) tools.unshift(...isolatedToolDefinitions);
  tools.unshift(...(config.publishToolDirectory ? gatewayBuiltinToolDefinitions : gatewayOperationalToolDefinitions));
  return tools;
}

function activePrefixes() {
  const prefixes = children.map((child) => child.config.prefix);
  if (hasBundledChildren()) prefixes.push('isolated');
  prefixes.push('gateway');
  return [...new Set(prefixes)];
}

function supportsGatewayErrorEnvelope(tool) {
  return tool?.outputSchema?.type === 'object'
    && tool.outputSchema.properties?.ok?.type === 'boolean'
    && tool.outputSchema.properties?.result?.type === 'object';
}

function textLimitedResult(id, route, result) {
  const message = response(id, result);
  const prefix = route.child.config.prefix;
  const responseLimit = prefix === 'files'
    ? filesResponseLimit
    : prefix === 'codespace'
      ? codespaceResponseLimit
      : null;
  if (responseLimit === null) return result;
  const serialized = `${JSON.stringify(message)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= responseLimit) return result;
  const preview = utf8Prefix(serialized, TEXT_RESPONSE_PREVIEW_BYTES);
  const previewBytes = Buffer.byteLength(preview, 'utf8');
  const recovery = prefix === 'files'
    ? 'ダウンロードツール（**downloads__download_zip**）を直接使うか、クエリを狭めるようにしてください。'
    : '大きな出力はファイルへ保存して**codespace__copy_from_codespace**で取得するか、クエリを狭めるようしてください。';
  const text = `返却文字列が${formatTextBytes(bytes)}のため、このリクエストはゲートウェイによって拒否されました。破壊的操作はすでに行われている可能性があります。現在の制限は${formatTextBytes(responseLimit)}です。${recovery} デバッグ用に元の返却文字列の先頭1.0KBを添付します。`;
  const limited = {
    content: [{ type: 'text', text }, { type: 'text', text: preview }],
    isError: true
  };
  if (supportsGatewayErrorEnvelope(route.tool)) {
    limited.structuredContent = {
      ok: false,
      error: text,
      result: {
        responseBytes: bytes,
        limitBytes: responseLimit,
        previewBytes
      }
    };
  }
  return limited;
}

const textLimitedResponse = (id, route, result) => response(id, textLimitedResult(id, route, result));

function toolExposureReport() {
  const disabled = [];
  const prefixes = [];
  let found = 0;
  for (const child of children) {
    let childFound = 0;
    let childRejected = 0;
    let childPublished = 1;
    for (const tool of child.tools) {
      if (tool.name === ACCESS_SCOPE_TOOL_NAME) continue;
      found += 1;
      childFound += 1;
      const reason = blockedToolReason(child.config, tool.name);
      const item = {
        server: child.config.name,
        prefix: child.config.prefix,
        tool: tool.name,
        publicName: namespacedName(child.config.prefix, tool.name),
        reason
      };
      if (reason) {
        childRejected += 1;
        disabled.push(item);
      } else {
        childPublished += 1;
      }
    }
    prefixes.push({
      server: child.config.name,
      prefix: child.config.prefix,
      found: childFound,
      rejected: childRejected,
      published: childPublished
    });
  }
  return { found, disabled, prefixes, published: publishedTools().length };
}

function logToolExposureReport() {
  const report = toolExposureReport();
  for (const item of report.disabled) {
    const identity = `server=${JSON.stringify(item.server)} prefix=${JSON.stringify(item.prefix)} tool=${JSON.stringify(item.tool)} public_name=${JSON.stringify(item.publicName)}`;
    if (item.reason.type === 'exact') {
      info(`tool disabled: ${identity} status="rejected" reason="blocked_tools exact match"`);
    } else {
      info(`tool disabled: ${identity} status="rejected" blocked_tool_substrings=${JSON.stringify(item.reason.value)}`);
    }
  }
  const publishedGatewayTools = config.publishToolDirectory ? gatewayBuiltinToolDefinitions : gatewayOperationalToolDefinitions;
  info(`tool prefix: server="gateway" prefix="gateway" enabled=true found=${publishedGatewayTools.length} rejected=0 published=${publishedGatewayTools.length}`);
  if (hasBundledChildren()) {
    info(`tool prefix: server="gateway" prefix="isolated" enabled=true found=${isolatedToolDefinitions.length} rejected=0 published=${isolatedToolDefinitions.length}`);
  }
  for (const item of report.prefixes) {
    info(`tool prefix: server=${JSON.stringify(item.server)} prefix=${JSON.stringify(item.prefix)} enabled=true found=${item.found} rejected=${item.rejected} published=${item.published}`);
  }
  for (const item of config.disabledServers ?? []) {
    info(`tool prefix disabled: server=${JSON.stringify(item.name)} prefix=${JSON.stringify(item.prefix)} enabled=false reason="enabled=false"`);
  }
  for (const item of unavailableServers) {
    info(`tool prefix unavailable: server=${JSON.stringify(item.name)} prefix=${JSON.stringify(item.prefix)} enabled=true reason=${JSON.stringify(item.reason)}`);
  }
  info(`tool exposure: found=${report.found} disabled=${report.disabled.length} published=${report.published} prefixes=${activePrefixes().length}`);
}

async function startChildren() {
  if (started) return;
  for (const childConfig of config.servers.filter((candidate) => !candidate.deferred)) {
    try {
      await startChild(childConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unavailableServers.push({ name: childConfig.name, prefix: childConfig.prefix, reason: message });
      warn(`MCP "${childConfig.name}" is unavailable and was skipped: ${message}`);
    }
  }
  rebuildRoutes();
  started = true;
}

function ensureChildrenStarted() {
  if (started) return Promise.resolve();
  initializationPromise ??= startChildren();
  return initializationPromise;
}

function notifyToolsChanged() {
  if (upstreamInitialized) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

function isolationState(isolatedId) {
  const id = validateIsolatedId(isolatedId);
  const state = isolatedWorkspaces.get(id);
  if (!state) throw new Error(`Unknown or closed isolatedId: ${id}. Create a new unique ID with ${ISOLATED_CREATE_TOOL}.`);
  return state;
}

function splitIsolatedArguments(route, toolArguments) {
  if (!route.child.config.isBundled) return { isolatedId: null, state: null, childArguments: toolArguments };
  if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)) {
    throw new Error(`${route.tool.name} arguments must be an object containing isolatedId`);
  }
  const state = isolationState(toolArguments.isolatedId);
  const { isolatedId, ...childArguments } = toolArguments;
  assertNoPublicRootOverride(childArguments);
  return { isolatedId, state, childArguments };
}

async function isolationContextForChild(state, child) {
  const existing = state.mcpContexts.get(child.config.name);
  if (existing) return existing;
  const roots = await child.pathPolicy.selectAllowedDirectories(state.workspaces);
  if (roots.length === 0) {
    throw new Error(`Isolation ${state.isolatedId} has no workspace allowed for bundled MCP ${child.config.prefix}`);
  }
  const context = { isolatedId: state.isolatedId, roots, base: roots[0] };
  state.mcpContexts.set(child.config.name, context);
  return context;
}

function privateIsolationArguments(child, context, childArguments) {
  const signature = signBundledIsolationContext(child.config.gatewayIsolationKey, context);
  return {
    ...childArguments,
    [BUNDLED_ISOLATION_ARGUMENT]: {
      version: 1,
      isolatedId: context.isolatedId,
      roots: context.roots,
      base: context.base,
      signature
    }
  };
}

function routeQueueGroup(route, isolatedId, childArguments = {}) {
  if (route.child.config.serialGroup) return route.child.config.serialGroup;
  if (route.child.config.gatewayArgumentPolicy === 'codespace'
      && typeof childArguments?.codespaceId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(childArguments.codespaceId)) {
    return `codespace:${route.child.config.name}:${childArguments.codespaceId}`;
  }
  return undefined;
}

function markIsolationOperation(state, prefix) {
  if (!state) return;
  state.lastOperationAtByPrefix ??= new Map();
  state.lastOperationAtByPrefix.set(prefix, new Date().toISOString());
}

async function startChild(childConfig) {
  const existing = childrenByName.get(childConfig.name);
  if (existing) return existing;
  const inProgress = childStarts.get(childConfig.name);
  if (inProgress) return inProgress;
  const start = (async () => {
    if (childConfig.isBundled) childConfig.gatewayIsolationKey = randomBytes(32).toString('hex');
    const child = new StdioMcpChild(childConfig, {
      onToolsChanged: async (changedChild) => {
        if (changedChild.config.manageAnnotations) {
          await syncDiscoveredToolAnnotations(toolAnnotationConfig, changedChild.config.prefix, changedChild.tools.map((tool) => tool.name));
        }
        rebuildRoutes();
        notifyToolsChanged();
      }
    });
    child.pathPolicy = new ToolPathPolicy({
      serverName: childConfig.name,
      cwd: childConfig.cwd,
      allowedDirectories: childConfig.allowedDirectories,
      allowedFiles: childConfig.allowedFiles,
      disallowedDirectories: [
        ...childConfig.disallowedDirectories,
        ...childConfig.protectedGatewayLogDirectories
      ],
      disallowedFiles: [
        ...childConfig.disallowedFiles,
        ...childConfig.protectedGatewayLogFiles
      ],
      protectedFiles: childConfig.dangerousAllowGatewayConfigAccess ? [] : childConfig.protectedGatewayConfigPaths,
      disallowedPathGlobs: childConfig.disallowedPathGlobs
    });
    try {
      const allowedPolicy = await child.pathPolicy.allowed();
      assertSandboxPathPolicyCompatible(childConfig, allowedPolicy);
      if (childConfig.sandbox && childConfig.sandbox !== 'never') {
        childConfig.allowedDirectories = allowedPolicy.directories.map((entry) => entry.canonical);
        childConfig.allowedFiles = allowedPolicy.files.map((entry) => entry.canonical);
        childConfig.sandboxDeniedDirectories = allowedPolicy.disallowedDirectories.map((entry) => entry.canonical);
        childConfig.sandboxDeniedFiles = [...new Set([
          ...allowedPolicy.disallowedFiles.map((entry) => entry.canonical),
          ...allowedPolicy.protectedFiles
            .map((entry) => entry.canonical)
            .filter((path) => childConfig.allowedDirectories.some((root) => pathInside(root, path))
              || childConfig.allowedFiles.some((file) => relative(file, path) === ''))
        ])];
        childConfig.sandboxForcedReadOnlyDirectories = childConfig.protectGatewayApp
          ? [...new Set(childConfig.protectedGatewayAppDirectories ?? [])]
          : [];
        childConfig.sandboxForcedReadOnlyFiles = childConfig.protectGatewayApp
          ? [...new Set(childConfig.protectedGatewayAppFiles ?? [])]
          : [];
        childConfig.codexExecutable = await canonicalExecutable(childConfig.codexExecutable, `${childConfig.name} codex_executable`);
        if (childConfig.sandbox === 'elevated' || childConfig.sandbox === 'onlineworkspace') {
          childConfig.command = await canonicalExecutable(childConfig.command, `${childConfig.name} command`);
          if (childConfig.allowedDirectories.some((root) => pathInside(root, childConfig.command))) {
            throw new Error(`${childConfig.name}: command resolves inside a writable sandbox root`);
          }
        }
        if (childConfig.allowedDirectories.some((root) => pathInside(root, childConfig.codexExecutable))) {
          throw new Error(`${childConfig.name}: codex_executable resolves inside a writable sandbox root`);
        }
        if (childConfig.gatewayArgumentPolicy === 'codespace') {
          const sshKeygenExecutable = await canonicalCodespaceSshKeygenExecutable();
          const sshRuntimeDirectory = await mkdtemp(join(tmpdir(), 'local-mcp-codespace-ssh-'));
          childConfig.codespaceSshRuntimeDirectory = sshRuntimeDirectory;
          childConfig.codespaceSshKeygenExecutable = sshKeygenExecutable;
          childConfig.sandboxInternalWritableDirectories = [...new Set([
            ...(childConfig.sandboxInternalWritableDirectories ?? []),
            sshRuntimeDirectory
          ])];
          childConfig.sandboxReadOnlyFiles = [...new Set([
            ...(childConfig.sandboxReadOnlyFiles ?? []),
            sshKeygenExecutable
          ])];
          childConfig.internalCleanupDirectories = [...new Set([
            ...(childConfig.internalCleanupDirectories ?? []),
            sshRuntimeDirectory
          ])];
        }
      }
      await child.start();
      if (childConfig.manageAnnotations) {
        await syncDiscoveredToolAnnotations(toolAnnotationConfig, childConfig.prefix, child.tools.map((tool) => tool.name));
      }
    } catch (error) {
      await child.close().catch(() => {});
      throw error;
    }
    children.push(child);
    childrenByName.set(childConfig.name, child);
    rebuildRoutes();
    return child;
  })();
  childStarts.set(childConfig.name, start);
  try { return await start; }
  finally { childStarts.delete(childConfig.name); }
}

async function stopChild(name) {
  const child = childrenByName.get(name);
  if (!child) return false;
  await child.close();
  childrenByName.delete(name);
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
  rebuildRoutes();
  return true;
}

const toolSucceeded = (result) => result?.isError !== true && result?.structuredContent?.ok !== false;

function bundledStateResult(result) {
  const value = { ok: true, result };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false
  };
}

function updateExternalWorkingDirectory(route, result) {
  if (route.child.config.isBundled || !toolSucceeded(result)) return;
  const workingDirectory = result?.structuredContent?.result?.workingDirectory;
  if (typeof workingDirectory === 'string' && workingDirectory.length > 0) {
    route.child.pathPolicy.setCwd(workingDirectory);
  }
}

async function applyLifecycle(route, result) {
  if (!toolSucceeded(result)) return;
  let changed = false;
  for (const candidate of config.servers) {
    if (candidate.startAfter?.server === route.child.config.name && candidate.startAfter?.tool === route.originalName) {
      await startChild(candidate);
      changed = true;
    }
    if (candidate.stopAfter?.server === route.child.config.name && candidate.stopAfter?.tool === route.originalName) {
      changed = await stopChild(candidate.name) || changed;
    }
  }
  if (changed) notifyToolsChanged();
}

async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return errorResponse(request?.id, -32600, 'Invalid Request');
  if (request.method === 'initialize') {
    await ensureChildrenStarted();
    if (!exposureReportLogged) {
      logToolExposureReport();
      exposureReportLogged = true;
    }
    return response(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'local-mcp-gateway', version: '0.6.0' },
      instructions: 'Private stdio MCP gateway for ChatGPT Secure MCP Tunnel. Enabled child servers come only from gateway.toml, and public tool names are namespaced. Bundled MCP tools require a unique isolatedId created with isolated__create and one or more absolute workspaces. Every child prefix also exposes get_gateway_access_scope; bundled scopes require the same isolatedId.'
    });
  }
  if (request.method === 'notifications/initialized') {
    upstreamInitialized = true;
    return null;
  }
  if (!started && initializationPromise) await initializationPromise;
  if (!started) return errorResponse(request.id, -32002, 'Server not initialized');
  if (request.method === 'ping') return response(request.id, {});
  if (request.method === 'tools/list') return response(request.id, { tools: publishedTools() });
  if (request.method === 'tools/call') {
    if (request.params?.name === GATEWAY_CHILDS_MCP_ASYNC_STATUS_NAME) {
      try {
        const toolArguments = request.params?.arguments ?? {};
        if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)
            || Object.keys(toolArguments).some((key) => !['asyncId', 'isolatedId'].includes(key))) {
          throw new Error(`${GATEWAY_CHILDS_MCP_ASYNC_STATUS_NAME} accepts only asyncId and optional isolatedId`);
        }
        if (typeof toolArguments.asyncId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(toolArguments.asyncId)) {
          throw new Error('asyncId must be a UUID string');
        }
        const isolatedId = toolArguments.isolatedId === undefined ? null : validateIsolatedId(toolArguments.isolatedId);
        if (isolatedId !== null) isolationState(isolatedId);
        const status = childAsyncRegistry.status(toolArguments.asyncId.toLowerCase(), isolatedId);
        return response(request.id, gatewayChildAsyncStatusMcpResult({ ok: true, result: status }));
      } catch (error) {
        return response(request.id, gatewayChildAsyncStatusMcpResult({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }, true));
      }
    }
    if (config.publishToolDirectory && request.params?.name === GATEWAY_CONFIG_NAME) {
      const toolArguments = request.params?.arguments ?? {};
      if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments) || Object.keys(toolArguments).length > 0) {
        return response(request.id, {
          content: [{ type: 'text', text: 'gateway__get_config does not accept arguments' }],
          isError: true
        });
      }
      return response(request.id, gatewayConfigMcpResult(createGatewayConfigPayload(config)));
    }
    if (config.publishToolDirectory && request.params?.name === PREFIX_LIST_NAME) {
      const toolArguments = request.params?.arguments ?? {};
      if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments) || Object.keys(toolArguments).length > 0) {
        return response(request.id, {
          content: [{ type: 'text', text: 'gateway__get_prefix_list does not accept arguments' }],
          isError: true
        });
      }
      return response(request.id, prefixListMcpResult(createPrefixListPayload(activePrefixes())));
    }
    if (config.publishToolDirectory && request.params?.name === TOOL_DIRECTORY_NAME) {
      const toolArguments = request.params?.arguments ?? {};
      if (toolArguments.prefix !== undefined && typeof toolArguments.prefix !== 'string') {
        return response(request.id, {
          content: [{ type: 'text', text: 'prefix must be a string' }],
          isError: true
        });
      }
      const report = toolExposureReport();
      const payload = createToolDirectoryPayload({
        tools: publishedTools(),
        prefix: toolArguments.prefix,
        enabledProxyCount: config.servers.length,
        rejectedToolCount: report.disabled.length,
        disabledProxyNames: config.disabledServerNames
      });
      return response(request.id, toolDirectoryMcpResult(payload));
    }
    if (request.params?.name === ISOLATED_CREATE_TOOL && hasBundledChildren()) {
      try {
        const toolArguments = request.params?.arguments ?? {};
        if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments)
            || Object.keys(toolArguments).some((key) => !['isolatedId', 'purpose', 'workspaces'].includes(key))) {
          throw new Error(`${ISOLATED_CREATE_TOOL} accepts only isolatedId, purpose, and workspaces`);
        }
        const isolatedId = validateIsolatedId(toolArguments.isolatedId);
        if (typeof toolArguments.purpose !== 'string' || toolArguments.purpose.trim().length < 1 || toolArguments.purpose.length > 500) {
          throw new Error('purpose must be a non-empty human-readable description up to 500 characters');
        }
        const purpose = toolArguments.purpose.trim();
        if (usedIsolatedIds.has(isolatedId) || pendingIsolatedIds.has(isolatedId)) {
          throw new Error(`isolatedId has already been used or is being created and cannot be reused until Gateway restart: ${isolatedId}`);
        }
        if (!Array.isArray(toolArguments.workspaces) || toolArguments.workspaces.length < 1 || toolArguments.workspaces.length > 32) {
          throw new Error('workspaces must contain from 1 through 32 absolute directories');
        }
        pendingIsolatedIds.add(isolatedId);
        const workspaces = [];
        try {
          for (const workspace of toolArguments.workspaces) {
            if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
              throw new Error(`Workspace paths must be absolute: ${String(workspace)}`);
            }
            let canonical = null;
            for (const child of children.filter((candidate) => candidate.config.isBundled)) {
              const selected = await child.pathPolicy.selectAllowedDirectories([workspace]);
              canonical ??= selected[0] ?? null;
            }
            if (canonical === null) throw new Error(`Workspace is outside every bundled MCP allowlist or is denied: ${workspace}`);
            if (!workspaces.includes(canonical)) workspaces.push(canonical);
          }
          const mcpContexts = new Map();
          for (const child of children.filter((candidate) => candidate.config.isBundled)) {
            const roots = await child.pathPolicy.selectAllowedDirectories(workspaces);
            if (roots.length > 0) mcpContexts.set(child.config.name, { isolatedId, roots, base: roots[0] });
          }
          usedIsolatedIds.add(isolatedId);
          const createdAt = new Date().toISOString();
          isolatedWorkspaces.set(isolatedId, {
            isolatedId,
            purpose,
            createdAt,
            workspaces,
            mcpContexts,
            lastOperationAtByPrefix: new Map()
          });
          return response(request.id, isolatedMcpResult({
            ok: true,
            result: {
              isolatedId,
              purpose,
              createdAt,
              created: true,
              workspaceCount: workspaces.length,
              bundledMcpCount: mcpContexts.size
            }
          }));
        } finally {
          pendingIsolatedIds.delete(isolatedId);
        }
      } catch (error) {
        return response(request.id, isolatedMcpResult({
          ok: false,
          result: { gatewayConfig: createGatewayConfigPayload(config) },
          error: error instanceof Error ? error.message : String(error)
        }, true));
      }
    }
    if (request.params?.name === ISOLATED_LIST_TOOL && hasBundledChildren()) {
      const toolArguments = request.params?.arguments ?? {};
      if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments) || Object.keys(toolArguments).length > 0) {
        return response(request.id, isolatedMcpResult({ ok: false, error: `${ISOLATED_LIST_TOOL} does not accept arguments` }, true));
      }
      const isolated = [...isolatedWorkspaces.values()].map((state) => ({
        isolatedId: state.isolatedId,
        purpose: state.purpose,
        createdAt: state.createdAt,
        workspaceCount: state.workspaces.length,
        bundledMcp: children
          .filter((child) => child.config.isBundled)
          .map((child) => {
            const context = state.mcpContexts.get(child.config.name);
            return {
              prefix: child.config.prefix,
              available: context !== undefined,
              workspaceCount: context?.roots.length ?? 0,
              lastOperationAt: state.lastOperationAtByPrefix?.get(child.config.prefix) ?? null
            };
          })
          .sort((left, right) => left.prefix.localeCompare(right.prefix))
      }));
      return response(request.id, isolatedMcpResult({ ok: true, result: { listedAt: new Date().toISOString(), isolated } }));
    }
    if (request.params?.name === ISOLATED_CLOSE_TOOL && hasBundledChildren()) {
      try {
        const toolArguments = request.params?.arguments ?? {};
        if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments) || Object.keys(toolArguments).some((key) => key !== 'isolatedId')) {
          throw new Error(`${ISOLATED_CLOSE_TOOL} accepts only isolatedId`);
        }
        const isolatedId = validateIsolatedId(toolArguments.isolatedId);
        if (!isolatedWorkspaces.delete(isolatedId)) throw new Error(`Unknown or already closed isolatedId: ${isolatedId}`);
        return response(request.id, isolatedMcpResult({ ok: true, result: { isolatedId, closed: true, reusable: false } }));
      } catch (error) {
        return response(request.id, isolatedMcpResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true));
      }
    }
    const route = toolRoutes.get(request.params?.name);
    if (!route) return errorResponse(request.id, -32602, `Unknown tool: ${request.params?.name ?? ''}`);
    try {
      const toolArguments = request.params?.arguments ?? {};
      const { isolatedId, state, childArguments } = splitIsolatedArguments(route, toolArguments);
      if (route.synthetic === 'access-scope') {
        if (!childArguments || typeof childArguments !== 'object' || Array.isArray(childArguments) || Object.keys(childArguments).length > 0) {
          throw new Error(`${request.params?.name} accepts only isolatedId for bundled MCPs and no arguments for external MCPs`);
        }
        const payload = await queues.run(routeQueueGroup(route, isolatedId, childArguments), async () => {
          markIsolationOperation(state, route.child.config.prefix);
          const context = state ? await isolationContextForChild(state, route.child) : null;
          const scope = context
            ? await route.child.pathPolicy.describeForAllowedDirectories(context.roots, context.base)
            : await route.child.pathPolicy.describe(route.child.pathPolicy.cwd);
          return {
            ...scope,
            prefix: route.child.config.prefix,
            ...(isolatedId === null ? { childProcessCwd: route.child.config.cwd } : {
              isolatedId,
              isolationRoots: context.roots,
              isolationBase: context.base
            })
          };
        });
        return textLimitedResponse(request.id, route, accessScopeMcpResult(payload));
      }
      if (state && route.originalName === 'get_working_directory') {
        const result = await queues.run(routeQueueGroup(route, isolatedId, childArguments), async () => {
          markIsolationOperation(state, route.child.config.prefix);
          const context = await isolationContextForChild(state, route.child);
          return bundledStateResult({ workingDirectory: context.base });
        });
        return textLimitedResponse(request.id, route, result);
      }
      if (state && route.originalName === 'set_working_directory') {
        const result = await queues.run(routeQueueGroup(route, isolatedId, childArguments), async () => {
          markIsolationOperation(state, route.child.config.prefix);
          if (!childArguments || typeof childArguments !== 'object' || Array.isArray(childArguments)
              || typeof childArguments.path !== 'string' || Object.keys(childArguments).some((key) => key !== 'path')) {
            throw new Error(`${request.params?.name} requires only path`);
          }
          const context = await isolationContextForChild(state, route.child);
          const isolationPolicy = new ToolPathPolicy({
            serverName: `${route.child.config.name}[${isolatedId}]`,
            cwd: context.base,
            allowedDirectories: context.roots
          });
          const selected = await isolationPolicy.selectAllowedDirectories([childArguments.path], context.base);
          if (selected.length !== 1) throw new Error('Path is outside the current isolation roots or is not an existing directory');
          context.base = selected[0];
          return bundledStateResult({ workingDirectory: selected[0] });
        });
        return textLimitedResponse(request.id, route, result);
      }
      const childRequest = queues.run(routeQueueGroup(route, isolatedId, childArguments), async () => {
        markIsolationOperation(state, route.child.config.prefix);
        const context = state ? await isolationContextForChild(state, route.child) : null;
        const base = context?.base ?? route.child.pathPolicy.cwd;
        const pathArguments = gatewayPathPolicyArguments(route.child.config, route.originalName, childArguments);
        await route.child.pathPolicy.assertToolArguments(route.originalName, pathArguments, base);
        if (context) {
          const isolationPolicy = new ToolPathPolicy({
            serverName: `${route.child.config.name}[${isolatedId}]`,
            cwd: context.base,
            allowedDirectories: context.roots
          });
          await isolationPolicy.allowed();
          await isolationPolicy.assertToolArguments(route.originalName, pathArguments, context.base);
        }
        const childResult = await route.child.request('tools/call', {
          name: route.originalName,
          arguments: context
            ? privateIsolationArguments(route.child, context, childArguments)
            : childArguments
        });
        updateExternalWorkingDirectory(route, childResult);
        return childResult;
      });
      const completedRequest = childRequest.then(async (childResult) => {
        await applyLifecycle(route, childResult);
        return textLimitedResult(request.id, route, childResult);
      });
      const resolved = await childAsyncRegistry.resolveOrPromote({
        tool: request.params.name,
        prefix: route.child.config.prefix,
        isolatedId,
        promise: completedRequest
      });
      if (resolved.promoted) return response(request.id, gatewayChildAsyncPromotionMcpResult(resolved.status));
      return response(request.id, resolved.result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = {
        content: [{ type: 'text', text: message }],
        isError: true
      };
      if (error?.accessScope && supportsGatewayErrorEnvelope(route.tool)) {
        result.structuredContent = {
          ok: false,
          error: message,
          result: { accessScope: error.accessScope }
        };
      }
      return textLimitedResponse(request.id, route, result);
    }
  }
  return errorResponse(request.id, -32601, 'Method not found');
}

let inputBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  while (true) {
    const newline = inputBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = inputBuffer.slice(0, newline).replace(/\r$/, '');
    inputBuffer = inputBuffer.slice(newline + 1);
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); }
    catch { write(errorResponse(null, -32700, 'Parse error')); continue; }
    if (request?.method === 'tools/call') {
      info(`tool call: name=${JSON.stringify(request.params?.name ?? '')} arguments=${JSON.stringify(request.params?.arguments ?? {})}`);
    }
    void handle(request).then((message) => { if (message) write(message); }).catch((error) => write(errorResponse(request?.id, -32603, error.message)));
  }
});

const shutdown = async () => {
  await Promise.allSettled(children.map((child) => child.close()));
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
