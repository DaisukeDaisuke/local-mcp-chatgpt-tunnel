import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnvironment } from '../../app/child-environment.mjs';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { ToolPathPolicy } from '../../app/path-policy.mjs';

const SERVER_VERSION = '0.1.0';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_PATH_CODE_UNITS = 1024;
const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const cli = { help: process.argv.slice(2).some((value) => value === '--help' || value === '-h') };

for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') continue;
  if (argument.startsWith('--seven-zip-executable=')) continue;
  throw new Error(`Unknown argument: ${argument}`);
}
function sevenZipArgument() {
  if (cli.help) return null;
  const prefix = '--seven-zip-executable=';
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (!argument && !directExecution) return process.execPath;
  if (!argument) throw new Error(`${prefix}<absolute-path> is required`);
  const value = argument.slice(prefix.length);
  if (!isAbsolute(value)) throw new Error('--seven-zip-executable must be an absolute path');
  if (process.platform === 'win32' && !/\.exe$/i.test(value)) throw new Error('--seven-zip-executable must point to a native .exe on Windows');
  return value;
}
const sevenZipExecutable = sevenZipArgument();
const HELP = `archive MCP\n\nUsage:\n  node mcp/archive/server.mjs --seven-zip-executable=<absolute-7z.exe-path>\n\nUses only the fixed 7-Zip executable to extract archives and create .zip/.7z archives inside signed workspace roots. No shell or arbitrary 7-Zip arguments are exposed.\n`;

function pathArray(name, fallback = []) {
  if (cli.help) return [];
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) throw new Error(`${name} must contain a JSON string array`);
  return parsed;
}
const allowedDirectories = pathArray('LOCAL_MCP_ALLOWED_DIRECTORIES', [process.cwd()]);
const allowedFiles = pathArray('LOCAL_MCP_ALLOWED_FILES');
const disallowedDirectories = pathArray('LOCAL_MCP_DISALLOWED_DIRECTORIES');
const disallowedFiles = pathArray('LOCAL_MCP_DISALLOWED_FILES');
const isolation = createBundledIsolation();
const policy = new ToolPathPolicy({ serverName: 'archive', cwd: process.cwd(), allowedDirectories, allowedFiles, disallowedDirectories, disallowedFiles, disallowedPathGlobs: pathArray('LOCAL_MCP_DISALLOWED_PATH_GLOBS') });

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } }, required: ['ok'], additionalProperties: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const commonTimeout = { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS };
const schemas = [
  {
    name: 'extract_archive',
    description: 'Extract one archive with the fixed 7-Zip executable into a new destination directory inside the signed workspace roots.',
    inputSchema: { type: 'object', properties: { archivePath: { type: 'string', minLength: 1 }, destinationDirectory: { type: 'string', minLength: 1 }, timeoutMs: commonTimeout }, required: ['archivePath', 'destinationDirectory'], additionalProperties: false },
    outputSchema,
    annotations: writeAnnotations
  },
  {
    name: 'create_zip',
    description: 'Create one new .zip archive from one file or directory using the fixed 7-Zip executable.',
    inputSchema: { type: 'object', properties: { sourcePath: { type: 'string', minLength: 1 }, archivePath: { type: 'string', minLength: 1 }, timeoutMs: commonTimeout }, required: ['sourcePath', 'archivePath'], additionalProperties: false },
    outputSchema,
    annotations: writeAnnotations
  },
  {
    name: 'create_7z',
    description: 'Create one new .7z archive from one file or directory using the fixed 7-Zip executable.',
    inputSchema: { type: 'object', properties: { sourcePath: { type: 'string', minLength: 1 }, archivePath: { type: 'string', minLength: 1 }, timeoutMs: commonTimeout }, required: ['sourcePath', 'archivePath'], additionalProperties: false },
    outputSchema,
    annotations: writeAnnotations
  }
];
const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError });

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function rejectPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a non-empty path without NUL or line breaks`);
  if (value.length > MAX_PATH_CODE_UNITS) throw new Error(`${label} exceeds the ${MAX_PATH_CODE_UNITS}-character path limit`);
  if (/^(?:\\\\|\/\/)/.test(value)) throw new Error(`${label} may not be a UNC path`);
  if (process.platform === 'win32') {
    const normalized = value.replace(/\//g, '\\');
    if (/^\\\\[?.]\\/i.test(normalized)) throw new Error(`${label} may not use Windows namespace paths`);
    if (normalized.replace(/^[A-Za-z]:/, '').includes(':')) throw new Error(`${label} may not use NTFS alternate data streams`);
  }
}
function assertResolvedPathLength(value, label) {
  if (value.length > MAX_PATH_CODE_UNITS) throw new Error(`${label} exceeds the ${MAX_PATH_CODE_UNITS}-character path limit after resolution`);
}
async function roots() {
  const current = isolation.current();
  if (current) return [...current.roots];
  return policy.selectAllowedDirectories(allowedDirectories.length > 0 ? allowedDirectories : [process.cwd()]);
}
async function base() { return isolation.current()?.base ?? (await roots())[0]; }
async function scopedPolicy(selectedRoots, selectedBase) {
  const scoped = new ToolPathPolicy({ serverName: 'archive-isolation', cwd: selectedBase, allowedDirectories: selectedRoots });
  await scoped.allowed();
  return scoped;
}
async function existingPath(value, label) {
  rejectPath(value, label);
  const selectedRoots = await roots();
  const selectedBase = await base();
  const lexical = resolve(isAbsolute(value) ? value : join(selectedBase, value));
  assertResolvedPathLength(lexical, label);
  await policy.assertToolArguments(label, { [label]: lexical }, selectedBase);
  const scoped = await scopedPolicy(selectedRoots, selectedBase);
  await scoped.assertToolArguments(label, { [label]: lexical }, selectedBase);
  const info = await lstat(lexical);
  if (info.isSymbolicLink()) throw new Error(`${label} may not be a symbolic link`);
  const actual = await realpath(lexical);
  if (!selectedRoots.some((root) => within(root, actual))) throw new Error(`${label} resolves outside the signed workspace roots`);
  await policy.assertToolArguments(label, { [label]: actual }, selectedBase);
  await scoped.assertToolArguments(label, { [label]: actual }, selectedBase);
  return { path: actual, info: await stat(actual), roots: selectedRoots, base: selectedBase };
}
async function newPath(value, label, expectedExtension) {
  rejectPath(value, label);
  const selectedRoots = await roots();
  const selectedBase = await base();
  const lexical = resolve(isAbsolute(value) ? value : join(selectedBase, value));
  assertResolvedPathLength(lexical, label);
  if (expectedExtension && extname(lexical).toLowerCase() !== expectedExtension) throw new Error(`${label} must end with ${expectedExtension}`);
  await policy.assertToolArguments(label, { [label]: lexical }, selectedBase);
  const scoped = await scopedPolicy(selectedRoots, selectedBase);
  await scoped.assertToolArguments(label, { [label]: lexical }, selectedBase);
  const parent = dirname(lexical);
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error(`${label} parent must be an existing non-symbolic-link directory`);
  const canonicalParent = await realpath(parent);
  if (!selectedRoots.some((root) => within(root, canonicalParent))) throw new Error(`${label} parent resolves outside the signed workspace roots`);
  const target = join(canonicalParent, parse(lexical).base);
  assertResolvedPathLength(target, label);
  try { await lstat(target); throw new Error(`${label} already exists`); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await policy.assertToolArguments(label, { [label]: target }, selectedBase);
  await scoped.assertToolArguments(label, { [label]: target }, selectedBase);
  return target;
}
async function extractionDestination(value) {
  const label = 'destinationDirectory';
  rejectPath(value, label);
  const selectedRoots = await roots();
  const selectedBase = await base();
  const lexical = resolve(isAbsolute(value) ? value : join(selectedBase, value));
  assertResolvedPathLength(lexical, label);
  await policy.assertToolArguments(label, { [label]: lexical }, selectedBase);
  const scoped = await scopedPolicy(selectedRoots, selectedBase);
  await scoped.assertToolArguments(label, { [label]: lexical }, selectedBase);

  try {
    const info = await lstat(lexical);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a non-symbolic-link directory`);
    const actual = await realpath(lexical);
    assertResolvedPathLength(actual, label);
    if (!selectedRoots.some((root) => within(root, actual))) throw new Error(`${label} resolves outside the signed workspace roots`);
    await policy.assertToolArguments(label, { [label]: actual }, selectedBase);
    await scoped.assertToolArguments(label, { [label]: actual }, selectedBase);
    if ((await readdir(actual)).length !== 0) throw new Error(`${label} must be empty before extraction`);
    return { path: actual, created: false };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const parent = dirname(lexical);
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error(`${label} parent must be an existing non-symbolic-link directory`);
  const canonicalParent = await realpath(parent);
  if (!selectedRoots.some((root) => within(root, canonicalParent))) throw new Error(`${label} parent resolves outside the signed workspace roots`);
  const target = join(canonicalParent, parse(lexical).base);
  assertResolvedPathLength(target, label);
  await policy.assertToolArguments(label, { [label]: target }, selectedBase);
  await scoped.assertToolArguments(label, { [label]: target }, selectedBase);
  await mkdir(target);
  return { path: target, created: true };
}
async function cleanupExtractionDestination(destination) {
  if (destination.created) {
    await rm(destination.path, { recursive: true, force: true }).catch(() => {});
    return;
  }
  let entries;
  try { entries = await readdir(destination.path); }
  catch { return; }
  await Promise.all(entries.map((entry) => rm(join(destination.path, entry), { recursive: true, force: true }).catch(() => {})));
}
function timeout(value) {
  const resolved = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_TIMEOUT_MS) throw new Error(`timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}`);
  return resolved;
}
let executablePromise;
async function executable() {
  executablePromise ??= (async () => {
    const info = await lstat(sevenZipExecutable);
    if (info.isSymbolicLink()) throw new Error('--seven-zip-executable may not be a symbolic link');
    const actual = await realpath(sevenZipExecutable);
    if (!(await stat(actual)).isFile()) throw new Error('--seven-zip-executable must point to a regular file');
    return actual;
  })();
  const actual = await executablePromise;
  const selectedRoots = await roots();
  if (selectedRoots.some((root) => within(root, actual))) throw new Error('--seven-zip-executable must be outside writable workspace roots');
  return actual;
}
async function run7z(args, cwd, timeoutMs) {
  const command = await executable();
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let child;
  let timer;
  const append = (current, chunk, name) => {
    const next = Buffer.concat([current, Buffer.from(chunk)]);
    if (next.length > MAX_OUTPUT_BYTES) {
      if (child && child.exitCode === null && !child.killed) child.kill();
      throw new Error(`${name} exceeded ${MAX_OUTPUT_BYTES} bytes`);
    }
    return next;
  };
  const exit = await new Promise((resolveExit, rejectExit) => {
    child = spawn(command, args, { cwd, env: buildChildEnvironment({}, environmentWithoutBundledIsolationKey()), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
    child.stdout.on('data', (chunk) => { try { stdout = append(stdout, chunk, 'stdout'); } catch (error) { rejectExit(error); } });
    child.stderr.on('data', (chunk) => { try { stderr = append(stderr, chunk, 'stderr'); } catch (error) { rejectExit(error); } });
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
    timer = setTimeout(() => { if (child.exitCode === null && !child.killed) child.kill(); rejectExit(new Error(`7-Zip timed out after ${timeoutMs}ms`)); }, timeoutMs);
  }).finally(() => clearTimeout(timer));
  const output = { exitCode: exit.code, signal: exit.signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
  if (exit.code !== 0 || exit.signal) throw new Error(`7-Zip failed (${exit.signal ?? exit.code}): ${output.stderr.trim() || output.stdout.trim() || 'no output'}`);
  return output;
}

async function extractArchive(args, runner = run7z) {
  const source = await existingPath(args.archivePath, 'archivePath');
  if (!source.info.isFile()) throw new Error('archivePath must be a regular file');
  const destination = await extractionDestination(args.destinationDirectory);
  try {
    const result = await runner(['x', source.path, `-o${destination.path}`, '-y'], source.base, timeout(args.timeoutMs));
    return { archivePath: source.path, destinationDirectory: destination.path, ...result };
  } catch (error) {
    await cleanupExtractionDestination(destination);
    throw error;
  }
}
async function createArchive(args, format, runner = run7z) {
  const source = await existingPath(args.sourcePath, 'sourcePath');
  const extension = format === 'zip' ? '.zip' : '.7z';
  const archive = await newPath(args.archivePath, 'archivePath', extension);
  try {
    const result = await runner(['a', `-t${format}`, archive, source.path], source.base, timeout(args.timeoutMs));
    return { sourcePath: source.path, archivePath: archive, format, ...result };
  } catch (error) {
    await rm(archive, { force: true }).catch(() => {});
    throw error;
  }
}
async function callTool(name, args, runner) {
  if (name === 'extract_archive') return extractArchive(args, runner);
  if (name === 'create_zip') return createArchive(args, 'zip', runner);
  if (name === 'create_7z') return createArchive(args, '7z', runner);
  throw new Error(`Unknown tool: ${name}`);
}

export function createServer({ runSevenZip = run7z } = {}) {
  let initialized = false;
  return async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return protocolError(request?.id, -32600, 'Invalid Request');
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'initialize') { initialized = true; return response(request.id, { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'archive', version: SERVER_VERSION } }); }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        const result = await isolation.run(request.params?.arguments ?? {}, (toolArguments) => callTool(request.params?.name, toolArguments, runSevenZip));
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
