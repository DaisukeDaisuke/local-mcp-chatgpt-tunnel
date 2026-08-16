import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundledIsolation } from '../../app/bundled-isolation.mjs';
import { ToolPathPolicy } from '../../app/path-policy.mjs';

const SERVER_VERSION = '0.1.0';
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600000;
const MAX_TIMEOUT_MS = 3600000;
const DEFAULT_SYNC_WAIT_MS = 10_000;
const MAX_RETAINED_ASYNC_OPERATIONS = 64;
const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const cli = { help: process.argv.slice(2).some((value) => value === '--help' || value === '-h') };
for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') continue;
  throw new Error(`Unknown argument: ${argument}`);
}
const HELP = `internet MCP\n\nUsage:\n  node mcp/internet/server.mjs\n\nDownloads HTTP/HTTPS resources only to Gateway-signed workspace roots. Intended for sandbox="onlineworkspace".\n`;

function pathArray(name, fallback = []) {
  if (cli.help) return [];
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) throw new Error(`${name} must contain a JSON string array`);
  return parsed;
}
function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
const allowedDirectories = pathArray('LOCAL_MCP_ALLOWED_DIRECTORIES', [process.cwd()]);
const allowedFiles = pathArray('LOCAL_MCP_ALLOWED_FILES');
const disallowedDirectories = pathArray('LOCAL_MCP_DISALLOWED_DIRECTORIES');
const disallowedFiles = pathArray('LOCAL_MCP_DISALLOWED_FILES');
const isolation = createBundledIsolation();
const policy = new ToolPathPolicy({ serverName: 'internet', cwd: process.cwd(), allowedDirectories, allowedFiles, disallowedDirectories, disallowedFiles, disallowedPathGlobs: pathArray('LOCAL_MCP_DISALLOWED_PATH_GLOBS') });
const MAX_BYTES = positiveInteger('INTERNET_MAX_BYTES', DEFAULT_MAX_BYTES);

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } }, required: ['ok'], additionalProperties: false };
const downloadSchema = {
  name: 'download_file',
  description: 'Download one HTTP/HTTPS resource to one file inside the signed workspace roots. No shell or executable selection is exposed. The call waits synchronously for at most 10 seconds; if the download is still running, it returns an asyncId and continues in the background. Call internet__status with that asyncId to retrieve the complete final result or error.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 16384 },
      destinationPath: { type: 'string', minLength: 1 },
      overwrite: { type: 'boolean', default: false },
      expectedSha256: { type: 'string', pattern: '^[0-9A-Fa-f]{64}$' },
      maxBytes: { type: 'integer', minimum: 1 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS }
    },
    required: ['url', 'destinationPath'],
    additionalProperties: false
  },
  outputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
};
const statusSchema = {
  name: 'status',
  description: 'Return retained async download state. Pass asyncId to retrieve the complete state and final download result or error. Omit asyncId to list all retained async downloads for the current isolated session.',
  inputSchema: {
    type: 'object',
    properties: {
      asyncId: { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-fA-F-]{36}$' }
    },
    additionalProperties: false
  },
  outputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
};
const schemas = [downloadSchema, statusSchema];
const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError });

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function validateUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch (error) { throw new Error(`url is invalid: ${error.message}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('url must use http: or https:');
  if (parsed.username || parsed.password) throw new Error('url may not contain embedded credentials');
  return parsed;
}
function rejectPath(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw new Error('destinationPath must be a non-empty path without NUL or line breaks');
  if (/^(?:\\\\|\/\/)/.test(value)) throw new Error('destinationPath may not be a UNC path');
  if (process.platform === 'win32') {
    const normalized = value.replace(/\//g, '\\');
    if (/^\\\\[?.]\\/i.test(normalized)) throw new Error('destinationPath may not use Windows namespace paths');
    if (normalized.replace(/^[A-Za-z]:/, '').includes(':')) throw new Error('destinationPath may not use NTFS alternate data streams');
  }
}
async function roots() {
  const current = isolation.current();
  if (current) return [...current.roots];
  return policy.selectAllowedDirectories(allowedDirectories.length > 0 ? allowedDirectories : [process.cwd()]);
}
async function base() { return isolation.current()?.base ?? (await roots())[0]; }
async function destinationPath(value) {
  rejectPath(value);
  const selectedRoots = await roots();
  const selectedBase = await base();
  const lexical = resolve(isAbsolute(value) ? value : join(selectedBase, value));
  await policy.assertToolArguments('download_file', { destinationPath: lexical }, selectedBase);
  const scoped = new ToolPathPolicy({ serverName: 'internet-isolation', cwd: selectedBase, allowedDirectories: selectedRoots });
  await scoped.allowed();
  await scoped.assertToolArguments('download_file', { destinationPath: lexical }, selectedBase);
  const parent = dirname(lexical);
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('destinationPath parent must be an existing non-symbolic-link directory');
  const canonicalParent = await realpath(parent);
  if (!selectedRoots.some((root) => within(root, canonicalParent))) throw new Error('destinationPath parent resolves outside the signed workspace roots');
  const target = join(canonicalParent, parse(lexical).base);
  await policy.assertToolArguments('download_file', { destinationPath: target }, selectedBase);
  await scoped.assertToolArguments('download_file', { destinationPath: target }, selectedBase);
  return target;
}
function bounded(value, fallback, max, label) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) throw new Error(`${label} must be an integer from 1 through ${max}`);
  return resolved;
}

function isolationScopeKey() {
  const context = isolation.current();
  if (!context) return 'direct';
  return context.isolatedId ?? JSON.stringify({ base: context.base, roots: context.roots });
}

function safeAsyncId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('asyncId must be a UUID returned by internet__download_file');
  }
  return value.toLowerCase();
}

function createAsyncDownloadManager(serverInstanceId) {
  const operations = new Map();

  const prune = () => {
    if (operations.size < MAX_RETAINED_ASYNC_OPERATIONS) return;
    for (const [asyncId, operation] of operations) {
      if (operation.status !== 'running') operations.delete(asyncId);
      if (operations.size < MAX_RETAINED_ASYNC_OPERATIONS) break;
    }
  };

  const summary = (operation, includeResult = true) => ({
    asyncId: operation.asyncId,
    serverInstanceId,
    operation: 'download_file',
    status: operation.status,
    createdAt: operation.createdAt,
    finishedAt: operation.finishedAt,
    hasResult: operation.status === 'completed',
    ...(includeResult && operation.status === 'completed' ? { result: operation.result } : {}),
    error: operation.error,
    ...(operation.status === 'running' ? {
      statusTool: 'internet__status',
      nextAction: 'Call internet__status with this asyncId to retrieve the complete final result or error.'
    } : {})
  });

  const requireOperation = (value) => {
    const asyncId = safeAsyncId(value);
    const operation = operations.get(asyncId);
    if (!operation) throw new Error('Unknown or expired asyncId. Async state is process-local; an MCP crash or restart makes asyncIds from the previous server instance unrecoverable.');
    if (operation.scopeKey !== isolationScopeKey()) throw new Error('asyncId belongs to a different isolated workspace context');
    return operation;
  };

  return {
    promote(promise, createdAt, promotedAfterMs) {
      prune();
      const operation = {
        asyncId: randomUUID().toLowerCase(),
        scopeKey: isolationScopeKey(),
        createdAt,
        finishedAt: null,
        status: 'running',
        result: undefined,
        error: null
      };
      operations.set(operation.asyncId, operation);
      void Promise.resolve(promise).then(
        (result) => {
          operation.status = 'completed';
          operation.finishedAt = new Date().toISOString();
          operation.result = result;
        },
        (error) => {
          operation.status = 'failed';
          operation.finishedAt = new Date().toISOString();
          operation.error = error instanceof Error ? error.message : String(error);
        }
      );
      return {
        ...summary(operation, false),
        async: true,
        promotedAfterMs
      };
    },
    status(asyncId) {
      if (asyncId !== undefined) return summary(requireOperation(asyncId), true);
      const scopeKey = isolationScopeKey();
      return {
        serverInstanceId,
        registryPersistence: 'process-memory',
        crashRecovery: 'unrecoverable',
        operations: [...operations.values()]
          .filter((operation) => operation.scopeKey === scopeKey)
          .map((operation) => summary(operation, true))
          .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      };
    }
  };
}

async function requestUrl(initial, signal) {
  let current = validateUrl(initial);
  for (let redirects = 0; redirects <= 10; redirects += 1) {
    const result = await fetch(current, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(result.status)) return { result, finalUrl: current.href, redirects };
    const location = result.headers.get('location');
    if (!location || redirects === 10) throw new Error('HTTP redirect limit exceeded or Location is missing');
    current = validateUrl(new URL(location, current).href);
  }
}

async function download(args) {
  const target = await destinationPath(args.destinationPath);
  const overwrite = args.overwrite ?? false;
  if (typeof overwrite !== 'boolean') throw new Error('overwrite must be a boolean');
  const maxBytes = bounded(args.maxBytes, MAX_BYTES, MAX_BYTES, 'maxBytes');
  const timeoutMs = bounded(args.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, 'timeoutMs');
  const expected = args.expectedSha256?.toLowerCase();
  if (expected !== undefined && !/^[0-9a-f]{64}$/.test(expected)) throw new Error('expectedSha256 must be 64 hexadecimal characters');
  if (!overwrite) {
    try { await lstat(target); throw new Error('destinationPath already exists'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  const temporary = `${target}.part-${randomUUID()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let handle;
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    const fetched = await requestUrl(args.url, controller.signal);
    if (!fetched.result.ok) throw new Error(`HTTP ${fetched.result.status} ${fetched.result.statusText}`);
    const declared = Number(fetched.result.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`Content-Length ${declared} exceeds maxBytes ${maxBytes}`);
    handle = await open(temporary, 'wx');
    for await (const chunk of fetched.result.body ?? []) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new Error(`download exceeded maxBytes ${maxBytes}`);
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    const sha256 = hash.digest('hex');
    if (expected && expected !== sha256) throw new Error(`SHA-256 mismatch: expected ${expected}, got ${sha256}`);
    if (overwrite) {
      try {
        const existing = await lstat(target);
        if (existing.isSymbolicLink() || !existing.isFile()) throw new Error('overwrite target must be a regular non-symbolic-link file');
        await rm(target);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await rename(temporary, target);
    }
    else { await copyFile(temporary, target, constants.COPYFILE_EXCL); await rm(temporary, { force: true }); }
    return { destinationPath: target, bytes, sha256, finalUrl: fetched.finalUrl, redirects: fetched.redirects, contentType: fetched.result.headers.get('content-type') };
  } finally {
    clearTimeout(timer);
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function createServer(options = {}) {
  const serverInstanceId = options.serverInstanceId ?? randomUUID().toLowerCase();
  const synchronousWaitMs = options.synchronousWaitMs ?? DEFAULT_SYNC_WAIT_MS;
  if (!Number.isSafeInteger(synchronousWaitMs) || synchronousWaitMs < 0 || synchronousWaitMs > DEFAULT_SYNC_WAIT_MS) {
    throw new Error(`synchronousWaitMs must be an integer from 0 through ${DEFAULT_SYNC_WAIT_MS}`);
  }
  const runDownload = options.download ?? download;
  const asyncDownloads = createAsyncDownloadManager(serverInstanceId);
  let initialized = false;
  return async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return protocolError(request?.id, -32600, 'Invalid Request');
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'initialize') { initialized = true; return response(request.id, { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'internet', version: SERVER_VERSION }, instructions: 'internet__download_file waits synchronously for at most 10 seconds. If it returns an asyncId, call internet__status with that asyncId; internet__status returns the complete retained result or error.' }); }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        const toolName = request.params?.name;
        const result = await isolation.run(request.params?.arguments ?? {}, async (toolArguments) => {
          if (toolName === 'status') return asyncDownloads.status(toolArguments.asyncId);
          if (toolName !== 'download_file') throw new Error(`Unknown tool: ${toolName}`);
          const createdAt = new Date().toISOString();
          let settled = false;
          let completedResult;
          let failure;
          const tracked = Promise.resolve(runDownload(toolArguments)).then(
            (value) => {
              settled = true;
              completedResult = value;
              return value;
            },
            (error) => {
              settled = true;
              failure = error;
              return undefined;
            }
          );
          let timer;
          await Promise.race([
            tracked,
            new Promise((resolvePromise) => {
              timer = setTimeout(resolvePromise, synchronousWaitMs);
            })
          ]);
          if (timer) clearTimeout(timer);
          if (settled) {
            if (failure) throw failure;
            return completedResult;
          }
          return asyncDownloads.promote(tracked.then(() => {
            if (failure) throw failure;
            return completedResult;
          }), createdAt, synchronousWaitMs);
        });
        return response(request.id, toolResult({ ok: true, result }));
      } catch (error) {
        return response(request.id, toolResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true));
      }
    }
    return protocolError(request.id, -32601, 'Method not found');
  };
}
export async function startStdio(input = process.stdin, output = process.stdout) {
  const server = createServer();
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request;
      try { request = JSON.parse(line); } catch { output.write(`${JSON.stringify(protocolError(null, -32700, 'Parse error'))}\n`); continue; }
      void server(request).then((reply) => { if (reply) output.write(`${JSON.stringify(reply)}\n`); });
    }
  });
}
if (directExecution) {
  if (cli.help) process.stdout.write(HELP);
  else await startStdio();
}
