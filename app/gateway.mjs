import { createHash } from 'node:crypto';
import { StdioMcpChild } from './stdio-child.mjs';
import { loadGatewayConfig } from './server-config.mjs';

const MAX_TOOL_NAME = 64;
const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const errorResponse = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

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
    const tracked = current.finally(() => {
      if (this.tails.get(group) === tracked) this.tails.delete(group);
    });
    this.tails.set(group, tracked);
    return current;
  }
}

const config = await loadGatewayConfig();
const queues = new SerialQueues();
const children = [];
const childrenByName = new Map();
const childStarts = new Map();
const toolRoutes = new Map();
let started = false;
let upstreamInitialized = false;

function rebuildRoutes() {
  toolRoutes.clear();
  for (const child of children) {
    for (const tool of child.tools) {
      if (child.config.blockedTools?.has(tool.name)) continue;
      const publicName = namespacedName(child.config.prefix, tool.name);
      if (toolRoutes.has(publicName)) throw new Error(`Tool name collision: ${publicName}`);
      toolRoutes.set(publicName, { child, originalName: tool.name, tool: { ...tool, name: publicName } });
    }
  }
}

async function startChildren() {
  if (started) return;
  try {
    for (const childConfig of config.servers.filter((candidate) => !candidate.deferred)) await startChild(childConfig);
  } catch (error) {
    await Promise.allSettled(children.map((child) => child.close()));
    children.length = 0;
    childrenByName.clear();
    childStarts.clear();
    throw error;
  }
  rebuildRoutes();
  started = true;
}

function notifyToolsChanged() {
  if (upstreamInitialized) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

async function startChild(childConfig) {
  const existing = childrenByName.get(childConfig.name);
  if (existing) return existing;
  const inProgress = childStarts.get(childConfig.name);
  if (inProgress) return inProgress;
  const start = (async () => {
    const child = new StdioMcpChild(childConfig, {
      onToolsChanged: () => {
        rebuildRoutes();
        notifyToolsChanged();
      }
    });
    try {
      await child.start();
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

async function applyLifecycle(route, result) {
  if (!toolSucceeded(result)) return;
  let changed = false;
  for (const candidate of config.servers) {
    if (candidate.startAfter?.server === route.child.config.name && candidate.startAfter?.tool === route.originalName) {
      try {
        await startChild(candidate);
      } catch (error) {
        if (route.child.config.name === 'dq9' && route.originalName === 'prepare_test_runtime') {
          await route.child.request('tools/call', { name: 'stop_test_runtime', arguments: {} }).catch(() => {});
        }
        throw new Error(`${candidate.name} could not attach after ${route.originalName}; the prepared runtime was stopped: ${error.message}`);
      }
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
    await startChildren();
    return response(request.id, {
      protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'dq9-local-mcp-gateway', version: '0.2.0' },
      instructions: 'Windows-local MCP gateway for ChatGPT Secure MCP Tunnel. Tool names are namespaced. Browser-changing tools are serialized. Host command execution and Ghidra script execution are not exposed.'
    });
  }
  if (request.method === 'notifications/initialized') {
    upstreamInitialized = true;
    return null;
  }
  if (!started) return errorResponse(request.id, -32002, 'Server not initialized');
  if (request.method === 'ping') return response(request.id, {});
  if (request.method === 'tools/list') return response(request.id, { tools: [...toolRoutes.values()].map((route) => route.tool) });
  if (request.method === 'tools/call') {
    const route = toolRoutes.get(request.params?.name);
    if (!route) return errorResponse(request.id, -32602, `Unknown tool: ${request.params?.name ?? ''}`);
    try {
      const result = await queues.run(route.child.config.serialGroup, () => route.child.request('tools/call', {
        name: route.originalName,
        arguments: request.params?.arguments ?? {}
      }));
      await applyLifecycle(route, result);
      return response(request.id, result);
    } catch (error) {
      return response(request.id, {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true
      });
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