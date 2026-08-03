import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_TEXT_BYTES = Number(process.env.SAFE_FILES_MAX_BYTES ?? 2 * 1024 * 1024);
const configuredRoots = JSON.parse(process.env.SAFE_FILES_ROOTS ?? '["/workspace"]');

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
    description: 'List the filesystem roots exposed by this server.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_directory',
    description: 'List one directory below an allowed root. This tool never follows a path outside an allowed root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'read_text_file',
    description: 'Read a UTF-8 text file below an allowed root. UTF-16 and invalid UTF-8 are rejected.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'write_text_file',
    description: 'Atomically create or replace one UTF-8 text file below an allowed root.',
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
    description: 'Replace an exact UTF-8 string in one file. The call fails unless the occurrence count is exactly as expected.',
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
    description: 'Create a directory below an allowed root. Existing directories are accepted.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    }
  }
];

let rootsPromise;
const roots = () => {
  rootsPromise ??= Promise.all(configuredRoots.map(async (root) => {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('SAFE_FILES_ROOTS must contain absolute paths');
    return realpath(root);
  }));
  return rootsPromise;
};

const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);

async function chooseRoot(path) {
  const allowed = await roots();
  if (isAbsolute(path)) {
    const normalized = resolve(path);
    const root = allowed.find((item) => within(item, normalized));
    if (!root) throw new Error('Path is outside all allowed roots');
    return { root, candidate: normalized };
  }
  if (path.split(/[\\/]+/).includes('..')) throw new Error('Parent path components are not allowed');
  return { root: allowed[0], candidate: resolve(allowed[0], path) };
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
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) {
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
  try {
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return destination;
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'roots':
      return { roots: await roots() };
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
        serverInfo: { name: 'safe-files', version: '1.0.0' },
        instructions: 'UTF-8 filesystem operations only. No command execution, deletion, or access outside configured roots.'
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
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
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(protocolError(null, -32700, 'Parse error'))}\n`);
        continue;
      }
      void handle(request).then((message) => {
        if (message) output.write(`${JSON.stringify(message)}\n`);
      });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startStdio();
}
