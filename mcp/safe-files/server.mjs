import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TEXT_BYTES = Number(process.env.SAFE_FILES_MAX_BYTES ?? 2 * 1024 * 1024);
const MAX_PATCH_BYTES = Number(process.env.SAFE_FILES_MAX_PATCH_BYTES ?? 4 * 1024 * 1024);
const configuredRoots = JSON.parse(process.env.SAFE_FILES_ROOTS ?? JSON.stringify([process.cwd()]));

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolResult = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  isError
});

const schemas = [
  {
    name: 'roots',
    description: 'List allowed filesystem roots and the current working directory.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_working_directory',
    description: 'Return the directory used to resolve relative paths.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'set_working_directory',
    description: 'Change the working directory used by subsequent file calls. The target must be an existing directory inside an allowed root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'list_directory',
    description: 'List one directory inside an allowed root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'read_text_file',
    description: 'Read a UTF-8 text file. UTF-16, UTF-32, invalid UTF-8, and paths outside allowed roots are rejected.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'write_text_file',
    description: 'Atomically create or replace one UTF-8 text file inside an allowed root.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        overwrite: { type: 'boolean', default: false }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'replace_text',
    description: 'Replace an exact UTF-8 string. The call fails unless the occurrence count is exactly as expected.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        oldText: { type: 'string', minLength: 1 },
        newText: { type: 'string' },
        expectedOccurrences: { type: 'integer', minimum: 1, default: 1 }
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false
    }
  },
  {
    name: 'create_directory',
    description: 'Create one directory inside an allowed root. Existing directories are accepted.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'apply_patch',
    description: 'Apply a structured *** Begin Patch change or a standard unified Git diff in the current working directory. This is a dedicated patch operation, not a shell or arbitrary-command API.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'string', minLength: 1 },
        dryRun: { type: 'boolean', default: false }
      },
      required: ['patch'],
      additionalProperties: false
    }
  }
];

let rootsPromise;
let workingDirectoryPromise;
const roots = () => {
  rootsPromise ??= Promise.all(configuredRoots.map(async (root) => {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('SAFE_FILES_ROOTS must contain absolute paths');
    return realpath(root);
  }));
  return rootsPromise;
};
const workingDirectory = async () => {
  workingDirectoryPromise ??= roots().then(([first]) => first);
  return workingDirectoryPromise;
};

const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);
const rootFor = (allowed, candidate) => allowed.find((root) => within(root, candidate));

async function chooseRoot(path) {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('Path must be a valid string');
  const allowed = await roots();
  const candidate = resolve(isAbsolute(path) ? path : join(await workingDirectory(), path));
  const root = rootFor(allowed, candidate);
  if (!root) throw new Error('Path is outside all allowed roots');
  return { root, candidate };
}

async function resolveExisting(path) {
  const { root, candidate } = await chooseRoot(path);
  const actual = await realpath(candidate);
  if (!within(root, actual)) throw new Error('Resolved path escaped the allowed root');
  return { root, path: actual };
}

async function resolveWritable(path) {
  const { root, candidate } = await chooseRoot(path);
  const parent = await realpath(dirname(candidate));
  if (!within(root, parent)) throw new Error('Resolved parent escaped the allowed root');
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error('Writing through symbolic links is not allowed');
    const actual = await realpath(candidate);
    if (!within(root, actual)) throw new Error('Resolved file escaped the allowed root');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { root, path: candidate };
}

function decodeUtf8(bytes) {
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`Text file exceeds ${MAX_TEXT_BYTES} bytes`);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new Error('UTF-16 text is not supported; convert the file to UTF-8 first');
  }
  if ((bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
      || (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00)) {
    throw new Error('UTF-32 text is not supported; convert the file to UTF-8 first');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
}

async function atomicWrite(path, content, overwrite) {
  const encoded = new TextEncoder().encode(content);
  if (encoded.length > MAX_TEXT_BYTES) throw new Error(`Text content exceeds ${MAX_TEXT_BYTES} bytes`);
  const { path: destination } = await resolveWritable(path);
  if (!overwrite) {
    try {
      await access(destination, constants.F_OK);
      throw new Error('Destination already exists; set overwrite=true to replace it');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(encoded);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let backup = null;
  try {
    if (overwrite) {
      try {
        await access(destination, constants.F_OK);
        backup = join(dirname(destination), `.${randomUUID()}.bak`);
        await rename(destination, backup);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    await rename(temporary, destination);
    if (backup) await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    if (backup) {
      await rm(destination, { force: true }).catch(() => {});
      await rename(backup, destination).catch(() => {});
    }
    throw error;
  }
  return destination;
}

function parseStructuredPatch(patch) {
  const lines = patch.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') throw new Error('Invalid structured patch envelope');
  const operations = [];
  let index = 1;
  while (index < lines.length - 1) {
    const marker = lines[index++];
    const match = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(marker);
    if (!match) throw new Error(`Invalid patch operation marker: ${marker}`);
    const body = [];
    while (index < lines.length - 1 && !lines[index].startsWith('*** ')) body.push(lines[index++]);
    validatePatchPath(match[2]);
    operations.push({ type: match[1].toLowerCase(), path: match[2], body });
  }
  return operations;
}

function validatePatchPath(path) {
  if (typeof path !== 'string' || path.trim() === '' || isAbsolute(path)) throw new Error(`Unsafe patch path: ${path}`);
  const parts = path.split(/[\\/]+/);
  if (parts.includes('..')) throw new Error(`Unsafe patch path: ${path}`);
  if (parts.some((part) => part.toLowerCase() === '.git')) throw new Error(`Patching .git internals is not allowed: ${path}`);
}

function applyUpdateHunks(current, body, path) {
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  let normalized = current.replace(/\r\n/g, '\n');
  const hunks = [];
  let hunk = [];
  for (const line of body) {
    if (line.startsWith('@@')) {
      if (hunk.length) hunks.push(hunk);
      hunk = [];
      continue;
    }
    if (line === '*** End of File') continue;
    if (!/^[ +\-]/.test(line)) throw new Error(`Invalid update line for ${path}: ${line}`);
    hunk.push(line);
  }
  if (hunk.length) hunks.push(hunk);
  if (hunks.length === 0) throw new Error(`Update for ${path} contains no hunks`);
  let cursor = 0;
  for (const lines of hunks) {
    const oldText = lines.filter((line) => !line.startsWith('+')).map((line) => line.slice(1)).join('\n');
    const newText = lines.filter((line) => !line.startsWith('-')).map((line) => line.slice(1)).join('\n');
    const found = normalized.indexOf(oldText, cursor);
    if (found < 0) throw new Error(`Patch context was not found in ${path}`);
    normalized = `${normalized.slice(0, found)}${newText}${normalized.slice(found + oldText.length)}`;
    cursor = found + newText.length;
  }
  return eol === '\n' ? normalized : normalized.replace(/\n/g, '\r\n');
}

async function applyStructuredPatch(patch, dryRun) {
  const operations = parseStructuredPatch(patch);
  const plan = [];
  for (const operation of operations) {
    const { path } = await resolveWritable(operation.path);
    if (operation.type === 'add') {
      try { await access(path); throw new Error(`Add target already exists: ${operation.path}`); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (operation.body.some((line) => !line.startsWith('+'))) throw new Error(`Add lines must start with +: ${operation.path}`);
      const content = operation.body.map((line) => line.slice(1)).join('\n') + (operation.body.length ? '\n' : '');
      plan.push({ ...operation, path, original: null, content });
      continue;
    }
    const existing = await resolveExisting(operation.path);
    if (!(await stat(existing.path)).isFile()) throw new Error(`Patch target is not a file: ${operation.path}`);
    const original = decodeUtf8(await readFile(existing.path));
    if (operation.type === 'delete') plan.push({ ...operation, path: existing.path, original, content: null });
    else plan.push({ ...operation, path: existing.path, original, content: applyUpdateHunks(original, operation.body, operation.path) });
  }
  if (dryRun) return { format: 'structured', changed: plan.map(({ type, path }) => ({ type, path })) };
  const completed = [];
  try {
    for (const item of plan) {
      if (item.type === 'delete') await rm(item.path);
      else await atomicWrite(item.path, item.content, item.type !== 'add');
      completed.push(item);
    }
  } catch (error) {
    for (const item of completed.reverse()) {
      try {
        if (item.original === null) await rm(item.path, { force: true });
        else await atomicWrite(item.path, item.original, true);
      } catch {}
    }
    throw error;
  }
  return { format: 'structured', changed: plan.map(({ type, path }) => ({ type, path })) };
}

function unifiedPatchPaths(patch) {
  if (/GIT binary patch|Binary files .* differ/.test(patch)) throw new Error('Binary patches are not supported');
  if (/^(?:rename|copy) (?:from|to) /m.test(patch)) throw new Error('Rename and copy patches are not supported');
  if (/^(?:new file mode|old mode|new mode|deleted file mode) (?:120000|160000)$/m.test(patch)) {
    throw new Error('Symlink and Gitlink mode patches are not supported');
  }
  const paths = new Set();
  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^(?:---|\+\+\+)\s+(.+?)(?:\t.*)?$/.exec(line);
    if (!match || match[1] === '/dev/null') continue;
    let path = match[1].replace(/^"|"$/g, '');
    if (/^[ab]\//.test(path)) path = path.slice(2);
    validatePatchPath(path);
    paths.add(path);
  }
  if (paths.size === 0) throw new Error('Unified patch contains no file paths');
  return [...paths];
}

async function runGitApply(patch, dryRun) {
  const cwd = await workingDirectory();
  const paths = unifiedPatchPaths(patch);
  for (const path of paths) {
    await resolveWritable(path);
    try {
      const target = await resolveExisting(path);
      if ((await stat(target.path)).isFile()) decodeUtf8(await readFile(target.path));
    } catch (error) {
      if (error?.code !== 'ENOENT' && !String(error.message).includes('ENOENT')) throw error;
    }
  }
  const invoke = (checkOnly) => new Promise((resolvePromise, reject) => {
    const args = ['apply', '--whitespace=nowarn'];
    if (checkOnly) args.push('--check');
    args.push('-');
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(stderr.trim() || `git apply exited with ${code}`)));
    child.stdin.end(patch, 'utf8');
  });
  await invoke(true);
  if (!dryRun) await invoke(false);
  return { format: 'unified', dryRun, paths: paths.map((path) => resolve(cwd, path)) };
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'roots':
      return { roots: await roots(), workingDirectory: await workingDirectory() };
    case 'get_working_directory':
      return { workingDirectory: await workingDirectory() };
    case 'set_working_directory': {
      const target = await resolveExisting(args.path);
      if (!(await stat(target.path)).isDirectory()) throw new Error('Path is not a directory');
      workingDirectoryPromise = Promise.resolve(target.path);
      return { workingDirectory: target.path };
    }
    case 'list_directory': {
      const target = await resolveExisting(args.path);
      if (!(await stat(target.path)).isDirectory()) throw new Error('Path is not a directory');
      const entries = await readdir(target.path, { withFileTypes: true });
      return {
        path: target.path,
        entries: entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'
        }))
      };
    }
    case 'read_text_file': {
      const target = await resolveExisting(args.path);
      if (!(await stat(target.path)).isFile()) throw new Error('Path is not a file');
      return { path: target.path, content: decodeUtf8(await readFile(target.path)) };
    }
    case 'write_text_file': {
      const destination = await atomicWrite(args.path, args.content, args.overwrite === true);
      return { path: destination, bytes: new TextEncoder().encode(args.content).length };
    }
    case 'replace_text': {
      const target = await resolveExisting(args.path);
      const current = decodeUtf8(await readFile(target.path));
      const expected = args.expectedOccurrences ?? 1;
      const occurrences = current.split(args.oldText).length - 1;
      if (occurrences !== expected) throw new Error(`Expected ${expected} occurrence(s), found ${occurrences}`);
      const next = current.split(args.oldText).join(args.newText);
      await atomicWrite(target.path, next, true);
      return { path: target.path, replacements: occurrences };
    }
    case 'create_directory': {
      const { root, candidate } = await chooseRoot(args.path);
      const parent = await realpath(dirname(candidate));
      if (!within(root, parent)) throw new Error('Resolved parent escaped the allowed root');
      try {
        await mkdir(candidate, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST' || !(await stat(candidate)).isDirectory()) throw error;
      }
      return { path: candidate };
    }
    case 'apply_patch': {
      const encoded = new TextEncoder().encode(args.patch);
      if (encoded.length > MAX_PATCH_BYTES) throw new Error(`Patch exceeds ${MAX_PATCH_BYTES} bytes`);
      return args.patch.startsWith('*** Begin Patch\n') || args.patch.startsWith('*** Begin Patch\r\n')
        ? applyStructuredPatch(args.patch, args.dryRun === true)
        : runGitApply(args.patch, args.dryRun === true);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createServer() {
  let initialized = false;
  return async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return protocolError(request?.id, -32600, 'Invalid Request');
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'initialize') {
      initialized = true;
      return response(request.id, {
        protocolVersion: request.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'safe-files', version: '2.0.0' },
        instructions: 'UTF-8 filesystem and dedicated patch operations only. No shell, arbitrary command, or access outside configured roots.'
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        return response(request.id, toolResult({ ok: true, result: await callTool(request.params?.name, request.params?.arguments ?? {}) }));
      } catch (error) {
        return response(request.id, toolResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true));
      }
    }
    return protocolError(request.id, -32601, 'Method not found');
  };
}

export async function startStdio(input = process.stdin, output = process.stdout) {
  const handle = createServer();
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
      try { request = JSON.parse(line); }
      catch { output.write(`${JSON.stringify(protocolError(null, -32700, 'Parse error'))}\n`); continue; }
      void handle(request).then((reply) => { if (reply) output.write(`${JSON.stringify(reply)}\n`); });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await startStdio();