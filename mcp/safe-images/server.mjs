import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disallowedPathGlobError, findDisallowedPathGlob, normalizeDisallowedPathGlobs } from '../../app/path-glob.mjs';

const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_PIXELS = 50 * 1024 * 1024;
const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);

export const SAFE_IMAGES_HELP = `safe-images MCP

Usage:
  node mcp/safe-images/server.mjs

Options:
  --help  Print this help and exit.

The process working directory is the image root. Set cwd in gateway.toml instead of passing --root.
Supported formats are PNG, JPEG, and WebP. SVG, HEIC, executable formats, and arbitrary binary files are rejected.
The default maximum image size is 8 MiB. Override it with SAFE_IMAGES_MAX_BYTES when necessary.
`;

const cli = { help: process.argv.slice(2).some((value) => value === '--help' || value === '-h') };
const configuredRoots = cli.help ? [] : JSON.parse(process.env.SAFE_IMAGES_ROOTS ?? JSON.stringify([process.cwd()]));
const configuredDisallowedPathGlobs = cli.help ? [] : normalizeDisallowedPathGlobs(
  JSON.parse(process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS ?? '[]'),
  'LOCAL_MCP_DISALLOWED_PATH_GLOBS'
);
const MAX_IMAGE_BYTES = readPositiveInteger('SAFE_IMAGES_MAX_BYTES', DEFAULT_MAX_IMAGE_BYTES);
const MAX_IMAGE_PIXELS = readPositiveInteger('SAFE_IMAGES_MAX_PIXELS', DEFAULT_MAX_IMAGE_PIXELS);

const EXTENSION_MIME_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp']
]);

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    result: { type: 'object' },
    error: { type: 'string' }
  },
  required: ['ok'],
  additionalProperties: false
};
const errorToolResult = (error) => {
  const value = { ok: false, error: error instanceof Error ? error.message : String(error) };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true
  };
};

const schemas = [
  {
    name: 'read_image',
    title: 'Read local image',
    description: 'Read one bounded PNG, JPEG, or WebP file from the configured image root and return it as MCP image content.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Absolute path or a path relative to the configured image root.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }
];

function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);

function assertNotGlobDenied(path, context) {
  const match = findDisallowedPathGlob(path, configuredDisallowedPathGlobs);
  if (match) throw disallowedPathGlobError(context, match);
}

function assertSafePath(root, candidate) {
  const relativePath = relative(root, candidate);
  if (relativePath === '') return;
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error('Path escaped the configured image root');
  }
}

function rejectAlternateDataStream(path) {
  const rootLength = parse(path).root.length;
  if (path.slice(rootLength).includes(':')) throw new Error('NTFS alternate data streams are not supported');
}

let rootsPromise;
let workingDirectoryPromise;

const roots = () => {
  if (!Array.isArray(configuredRoots) || configuredRoots.length === 0) {
    return Promise.reject(new Error('No image root is configured'));
  }
  rootsPromise ??= Promise.all(configuredRoots.map(async (root) => {
    if (typeof root !== 'string' || root.includes('\0')) throw new Error('Image roots must be valid strings');
    if (/^(?:\\\\|\/\/)/.test(root)) throw new Error('UNC image roots are not supported');
    const actual = await realpath(resolve(root));
    assertNotGlobDenied(actual, 'safe-images root');
    return actual;
  }));
  return rootsPromise;
};

const workingDirectory = async () => {
  workingDirectoryPromise ??= roots().then(([first]) => first);
  return workingDirectoryPromise;
};

async function resolveImagePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) throw new Error('Path must be a non-empty string');
  if (/^(?:\\\\|\/\/)/.test(path)) throw new Error('UNC paths are not supported');
  const allowed = await roots();
  const candidate = resolve(isAbsolute(path) ? path : join(await workingDirectory(), path));
  rejectAlternateDataStream(candidate);
  const root = allowed.find((entry) => within(entry, candidate));
  if (!root) throw new Error('Path is outside all configured image roots');
  assertSafePath(root, candidate);
  const linkInfo = await lstat(candidate);
  if (linkInfo.isSymbolicLink()) throw new Error('Symbolic-link image paths are not supported');
  if (!linkInfo.isFile()) throw new Error('Image path is not a regular file');
  const actual = await realpath(candidate);
  if (!within(root, actual)) throw new Error('Resolved path escaped the configured image root');
  assertSafePath(root, actual);
  assertNotGlobDenied(actual, 'read_image path');
  return actual;
}

function parsePng(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { mimeType: 'image/png', width, height } : null;
}

function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { mimeType: 'image/jpeg', width, height } : null;
    }
    offset += segmentLength;
  }
  return null;
}

function parseWebp(bytes) {
  if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunkType = bytes.toString('ascii', 12, 16);
  if (chunkType === 'VP8X') {
    const width = 1 + bytes.readUIntLE(24, 3);
    const height = 1 + bytes.readUIntLE(27, 3);
    return { mimeType: 'image/webp', width, height };
  }
  if (chunkType === 'VP8L' && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { mimeType: 'image/webp', width, height };
  }
  if (chunkType === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    const width = bytes.readUInt16LE(26) & 0x3fff;
    const height = bytes.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { mimeType: 'image/webp', width, height } : null;
  }
  return null;
}

function inspectImage(bytes, extension) {
  const expectedMimeType = EXTENSION_MIME_TYPES.get(extension);
  if (!expectedMimeType) throw new Error('Unsupported image extension; use PNG, JPEG, or WebP');
  const detected = parsePng(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes);
  if (!detected) throw new Error('File content is not a supported PNG, JPEG, or WebP image');
  if (detected.mimeType !== expectedMimeType) throw new Error(`Image extension does not match detected content type ${detected.mimeType}`);
  const pixels = detected.width * detected.height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_IMAGE_PIXELS) {
    throw new Error(`Image dimensions exceed the ${MAX_IMAGE_PIXELS}-pixel limit`);
  }
  return detected;
}

async function readImage(path) {
  const actual = await resolveImagePath(path);
  const extension = extname(actual).toLowerCase();
  if (!EXTENSION_MIME_TYPES.has(extension)) throw new Error('Unsupported image extension; use PNG, JPEG, or WebP');
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(actual, flags);
  let bytes;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Image path is not a regular file');
    if (info.size <= 0) throw new Error('Image file is empty');
    if (info.size > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Image exceeds ${MAX_IMAGE_BYTES} bytes`);
  const detected = inspectImage(bytes, extension);
  const metadata = {
    path: actual,
    name: basename(actual),
    mimeType: detected.mimeType,
    bytes: bytes.length,
    width: detected.width,
    height: detected.height,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
  const structuredContent = { ok: true, result: metadata };
  return {
    content: [
      { type: 'text', text: JSON.stringify(structuredContent) },
      { type: 'image', data: bytes.toString('base64'), mimeType: detected.mimeType }
    ],
    structuredContent,
    isError: false
  };
}

function validateReadImageArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  const keys = Object.keys(args);
  if (keys.length !== 1 || keys[0] !== 'path') throw new Error('read_image accepts only the path argument');
  return args.path;
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
        serverInfo: { name: 'safe-images', version: '1.0.0' },
        instructions: 'Read-only transfer of bounded PNG, JPEG, and WebP files as MCP image content. The server independently enforces configured roots, file type, file size, and image dimensions.'
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        if (request.params?.name !== 'read_image') throw new Error(`Unknown tool: ${request.params?.name}`);
        const result = await readImage(validateReadImageArguments(request.params?.arguments ?? {}));
        return response(request.id, result);
      } catch (error) {
        return response(request.id, errorToolResult(error));
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
      try {
        request = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(protocolError(null, -32700, 'Parse error'))}\n`);
        continue;
      }
      void handle(request).then((reply) => {
        if (reply) output.write(`${JSON.stringify(reply)}\n`);
      });
    }
  });
}

if (directExecution) {
  if (cli.help) process.stdout.write(SAFE_IMAGES_HELP);
  else if (process.argv.slice(2).length > 0) {
    process.stderr.write('Unknown argument. Run with --help.\n');
    process.exitCode = 2;
  } else await startStdio();
}