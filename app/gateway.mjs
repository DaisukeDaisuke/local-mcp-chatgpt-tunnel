import { createHash, randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
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
  TOOL_DIRECTORY_NAME,
  createToolDirectoryPayload,
  toolDirectoryDefinition,
  toolDirectoryMcpResult
} from './tool-directory.mjs';
import { assertNotElevatedWindows } from './windows-integrity.mjs';
import { assertSandboxPathPolicyCompatible } from './sandbox-path-policy.mjs';

scrubSecretEnvironment(process.env);
await assertNotElevatedWindows();

const MAX_TOOL_NAME = 64;
const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function pathInside(directory, candidate) {
  const path = relative(directory, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function canonicalExecutable(path, label) {
  const actual = await realpath(path);
  if (!(await stat(actual)).isFile()) throw new Error(`${label} must point to a regular file`);
  return actual;
}
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const warn = (message) => process.stderr.write(`[gateway] ${message}\n`);
const info = (message) => process.stderr.write(`[gateway] INFO ${message}\n`);

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
const toolAnnotationConfig = await loadToolAnnotationConfig(
  config.toolAnnotationsPath,
  config.servers.filter((server) => server.manageAnnotations).map((server) => server.prefix)
);
const queues = new SerialQueues();
const children = [];
const childrenByName = new Map();
const childStarts = new Map();
const toolRoutes = new Map();
const isolatedWorkspaces = new Map();
const usedIsolatedIds = new Set();
const pendingIsolatedIds = new Set();
let started = false;
let upstreamInitialized = false;
let initializationPromise = null;

function blockedToolReason(childConfig, toolName) {
  if (childConfig.blockedTools?.has(toolName)) return { type: 'exact', value: toolName };
  const lowered = toolName.toLowerCase();
  const substring = childConfig.blockedToolSubstrings?.find((candidate) => lowered.includes(candidate));
  return substring ? { type: 'substring', value: substring } : null;
}

function rebuildRoutes() {
  toolRoutes.clear();
  for (const child of children) {
    for (const tool of child.tools) {
      if (tool.name === ACCESS_SCOPE_TOOL_NAME) continue;
      if (blockedToolReason(child.config, tool.name)) continue;
      const publicName = namespacedName(child.config.prefix, tool.name);
      if ((config.publishToolDirectory && publicName === TOOL_DIRECTORY_NAME) || isolatedToolNames.has(publicName)) throw new Error(`Tool name collision: ${publicName}`);
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
    if ((config.publishToolDirectory && accessScopePublicName === TOOL_DIRECTORY_NAME) || isolatedToolNames.has(accessScopePublicName)) throw new Error(`Tool name collision: ${accessScopePublicName}`);
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
  if (config.publishToolDirectory) tools.unshift(toolDirectoryDefinition);
  return tools;
}

function supportsGatewayErrorEnvelope(tool) {
  return tool?.outputSchema?.type === 'object'
    && tool.outputSchema.properties?.ok?.type === 'boolean'
    && tool.outputSchema.properties?.result?.type === 'object';
}

function toolExposureReport() {
  const disabled = [];
  let found = 0;
  for (const child of children) {
    for (const tool of child.tools) {
      if (tool.name === ACCESS_SCOPE_TOOL_NAME) continue;
      found += 1;
      const reason = blockedToolReason(child.config, tool.name);
      if (!reason) continue;
      disabled.push({
        server: child.config.name,
        tool: tool.name,
        publicName: namespacedName(child.config.prefix, tool.name),
        reason
      });
    }
  }
  return { found, disabled, published: toolRoutes.size + (hasBundledChildren() ? isolatedToolDefinitions.length : 0) };
}

function logToolExposureReport() {
  const report = toolExposureReport();
  for (const item of report.disabled) {
    const identity = `server=${JSON.stringify(item.server)} tool=${JSON.stringify(item.tool)} public_name=${JSON.stringify(item.publicName)}`;
    if (item.reason.type === 'exact') info(`tool disabled: ${identity} reason="blocked_tools exact match"`);
    else info(`tool disabled: ${identity} blocked_tool_substrings=${JSON.stringify(item.reason.value)}`);
  }
  info(`tool exposure: found=${report.found} disabled=${report.disabled.length} published=${report.published}`);
}

async function startChildren() {
  if (started) return;
  for (const childConfig of config.servers.filter((candidate) => !candidate.deferred)) {
    try {
      await startChild(childConfig);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
  const context = { roots, base: roots[0] };
  state.mcpContexts.set(child.config.name, context);
  return context;
}

function privateIsolationArguments(child, context, childArguments) {
  const signature = signBundledIsolationContext(child.config.gatewayIsolationKey, context);
  return {
    ...childArguments,
    [BUNDLED_ISOLATION_ARGUMENT]: {
      version: 1,
      roots: context.roots,
      base: context.base,
      signature
    }
  };
}

function routeQueueGroup(route, isolatedId) {
  if (route.child.config.serialGroup) return route.child.config.serialGroup;
  if (route.child.config.isBundled && isolatedId !== null) {
    return `bundled:${route.child.config.name}:${isolatedId}`;
  }
  return undefined;
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
      disallowedDirectories: childConfig.disallowedDirectories,
      disallowedFiles: childConfig.disallowedFiles,
      protectedFiles: childConfig.dangerousAllowGatewayConfigAccess ? [] : childConfig.protectedGatewayConfigPaths,
      disallowedPathGlobs: childConfig.disallowedPathGlobs
    });
    try {
      const allowedPolicy = await child.pathPolicy.allowed();
      assertSandboxPathPolicyCompatible(childConfig, allowedPolicy);
      if (childConfig.sandbox && childConfig.sandbox !== 'never') {
        childConfig.allowedDirectories = allowedPolicy.directories.map((entry) => entry.canonical);
        childConfig.allowedFiles = allowedPolicy.files.map((entry) => entry.canonical);
        childConfig.codexExecutable = await canonicalExecutable(childConfig.codexExecutable, `${childConfig.name} codex_executable`);
        if (childConfig.sandbox === 'elevated') {
          childConfig.command = await canonicalExecutable(childConfig.command, `${childConfig.name} command`);
          if (childConfig.allowedDirectories.some((root) => pathInside(root, childConfig.command))) {
            throw new Error(`${childConfig.name}: command resolves inside a writable sandbox root`);
          }
        }
        if (childConfig.allowedDirectories.some((root) => pathInside(root, childConfig.codexExecutable))) {
          throw new Error(`${childConfig.name}: codex_executable resolves inside a writable sandbox root`);
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
    logToolExposureReport();
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
            || Object.keys(toolArguments).some((key) => !['isolatedId', 'workspaces'].includes(key))) {
          throw new Error(`${ISOLATED_CREATE_TOOL} accepts only isolatedId and workspaces`);
        }
        const isolatedId = validateIsolatedId(toolArguments.isolatedId);
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
            if (roots.length > 0) mcpContexts.set(child.config.name, { roots, base: roots[0] });
          }
          usedIsolatedIds.add(isolatedId);
          isolatedWorkspaces.set(isolatedId, { isolatedId, workspaces, mcpContexts });
          return response(request.id, isolatedMcpResult({
            ok: true,
            result: {
              isolatedId,
              created: true,
              workspaceCount: workspaces.length,
              bundledMcpCount: mcpContexts.size
            }
          }));
        } finally {
          pendingIsolatedIds.delete(isolatedId);
        }
      } catch (error) {
        return response(request.id, isolatedMcpResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true));
      }
    }
    if (request.params?.name === ISOLATED_LIST_TOOL && hasBundledChildren()) {
      const toolArguments = request.params?.arguments ?? {};
      if (!toolArguments || typeof toolArguments !== 'object' || Array.isArray(toolArguments) || Object.keys(toolArguments).length > 0) {
        return response(request.id, isolatedMcpResult({ ok: false, error: `${ISOLATED_LIST_TOOL} does not accept arguments` }, true));
      }
      const isolated = [...isolatedWorkspaces.values()].map((state) => ({
        isolatedId: state.isolatedId,
        workspaceCount: state.workspaces.length,
        bundledMcp: children
          .filter((child) => child.config.isBundled)
          .map((child) => {
            const context = state.mcpContexts.get(child.config.name);
            return {
              prefix: child.config.prefix,
              available: context !== undefined,
              workspaceCount: context?.roots.length ?? 0
            };
          })
          .sort((left, right) => left.prefix.localeCompare(right.prefix))
      }));
      return response(request.id, isolatedMcpResult({ ok: true, result: { isolated } }));
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
        const payload = await queues.run(routeQueueGroup(route, isolatedId), async () => {
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
        return response(request.id, accessScopeMcpResult(payload));
      }
      if (state && route.originalName === 'get_working_directory') {
        const result = await queues.run(routeQueueGroup(route, isolatedId), async () => {
          const context = await isolationContextForChild(state, route.child);
          return bundledStateResult({ workingDirectory: context.base });
        });
        return response(request.id, result);
      }
      if (state && route.originalName === 'set_working_directory') {
        const result = await queues.run(routeQueueGroup(route, isolatedId), async () => {
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
        return response(request.id, result);
      }
      const result = await queues.run(routeQueueGroup(route, isolatedId), async () => {
        const context = state ? await isolationContextForChild(state, route.child) : null;
        const base = context?.base ?? route.child.pathPolicy.cwd;
        await route.child.pathPolicy.assertToolArguments(route.originalName, childArguments, base);
        if (context) {
          const isolationPolicy = new ToolPathPolicy({
            serverName: `${route.child.config.name}[${isolatedId}]`,
            cwd: context.base,
            allowedDirectories: context.roots
          });
          await isolationPolicy.allowed();
          await isolationPolicy.assertToolArguments(route.originalName, childArguments, context.base);
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
      await applyLifecycle(route, result);
      return response(request.id, result);
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
      return response(request.id, result);
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
    void handle(request).then((message) => { if (message) write(message); }).catch((error) => write(errorResponse(request?.id, -32603, error.message)));
  }
});

const shutdown = async () => {
  await Promise.allSettled(children.map((child) => child.close()));
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
