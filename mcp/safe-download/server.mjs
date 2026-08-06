import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { disallowedPathGlobError, findDisallowedPathGlob, normalizeDisallowedPathGlobs } from '../../app/path-glob.mjs';

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_INPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ZIP_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_RG_OUTPUT_BYTES = 8 * 1024 * 1024;
const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);

export const SAFE_DOWNLOAD_HELP = `safe-download MCP

Usage:
  node mcp/safe-download/server.mjs

Options:
  --help  Print this help and exit.

Outside the Gateway, the process working directory is the fallback download root. Through the Gateway, every call requires an HMAC-signed isolated base and root list.
Public root or workspace override arguments are rejected.
download_zip always returns a ZIP, including when the requested path is one source file.
Directory enumeration uses fixed ripgrep arguments. Arbitrary ripgrep arguments and shell execution are not supported.
`;

const cli = { help: process.argv.slice(2).some((value) => value === '--help' || value === '-h') };
const configuredRoots = cli.help ? [] : JSON.parse(process.env.SAFE_DOWNLOAD_ROOTS ?? JSON.stringify([process.cwd()]));
const configuredDisallowedPathGlobs = cli.help ? [] : normalizeDisallowedPathGlobs(
  JSON.parse(process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS ?? '[]'),
  'LOCAL_MCP_DISALLOWED_PATH_GLOBS'
);
const isolation = createBundledIsolation();
const MAX_FILES = readPositiveInteger('SAFE_DOWNLOAD_MAX_FILES', DEFAULT_MAX_FILES);
const MAX_INPUT_BYTES = readPositiveInteger('SAFE_DOWNLOAD_MAX_INPUT_BYTES', DEFAULT_MAX_INPUT_BYTES);
const MAX_ZIP_BYTES = readPositiveInteger('SAFE_DOWNLOAD_MAX_ZIP_BYTES', DEFAULT_MAX_ZIP_BYTES);
const MAX_RG_OUTPUT_BYTES = readPositiveInteger('SAFE_DOWNLOAD_MAX_RG_OUTPUT_BYTES', DEFAULT_MAX_RG_OUTPUT_BYTES);

const BLOCKED_SECRET_EXTENSIONS = new Set(['.key', '.kdbx', '.p12', '.pem', '.pfx', '.ppk', '.pub']);
const BLOCKED_DOWNLOAD_EXTENSIONS = new Set(['.dsv', '.dst', '.nds', '.sav', ...BLOCKED_SECRET_EXTENSIONS]);
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{25,}\b/
];

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

const schema = {
  name: 'download_zip',
  title: 'Download local files as ZIP',
  description: 'Create one bounded ZIP from a file or a recursively enumerated directory inside the independently configured download root.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, description: 'File or directory inside the configured download root.' },
      archiveName: { type: 'string', minLength: 1, maxLength: 128, description: 'ZIP basename only. .zip is appended when omitted.' },
      globs: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 512 },
        maxItems: 20,
        description: 'Safe ripgrep glob patterns used only when path is a directory.'
      },
      excludePaths: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 1024 },
        maxItems: 100,
        description: 'Exact files or directories to omit. Relative values are resolved below path.'
      },
      includeIgnored: { type: 'boolean', default: false }
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
};

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

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

function rejectAlternateDataStream(path) {
  const rootLength = parse(path).root.length;
  if (path.slice(rootLength).includes(':')) throw new Error('NTFS alternate data streams are not supported');
}

let rootsPromise;
const roots = () => {
  const context = isolation.current();
  if (context) return Promise.resolve([...context.roots]);
  if (!Array.isArray(configuredRoots) || configuredRoots.length === 0) return Promise.reject(new Error('No download root is configured'));
  rootsPromise ??= Promise.all(configuredRoots.map(async (root) => {
    if (typeof root !== 'string' || root.length === 0 || /[\0\r\n]/.test(root)) throw new Error('Download roots must be valid strings');
    if (/^(?:\\\\|\/\/)/.test(root)) throw new Error('UNC download roots are not supported');
    const actual = await realpath(resolve(root));
    rejectAlternateDataStream(actual);
    assertNotGlobDenied(actual, 'safe-download root');
    return actual;
  }));
  return rootsPromise;
};

const workingDirectory = async () => isolation.current()?.base ?? (await roots())[0];

const outsideRootsError = (message, allowed) => new Error([
  message,
  `Allowed directories (absolute): ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
  'Allowed files (absolute): (none)'
].join('\n'));

async function resolveDownloadPath(path) {
  if (typeof path !== 'string' || path.length === 0 || /[\0\r\n]/.test(path)) throw new Error('Path must be a non-empty string without NUL or line breaks');
  if (/^(?:\\\\|\/\/)/.test(path)) throw new Error('UNC paths are not supported');
  const candidate = resolve(isAbsolute(path) ? path : join(await workingDirectory(), path));
  rejectAlternateDataStream(candidate);
  const allowed = await roots();
  const root = allowed.find((entry) => within(entry, candidate));
  if (!root) throw outsideRootsError('Path is outside all configured download roots', allowed);
  const lexicalInfo = await lstat(candidate);
  if (lexicalInfo.isSymbolicLink()) throw new Error('Symbolic-link download paths are not supported');
  const actual = await realpath(candidate);
  if (!within(root, actual)) throw outsideRootsError('Resolved path escaped the configured download root', allowed);
  assertNotGlobDenied(actual, 'download_zip path');
  return { root, path: actual, info: await stat(actual) };
}

function validateGlob(glob) {
  if (typeof glob !== 'string' || glob.length === 0 || glob.length > 512) throw new Error('Glob must be a non-empty string of at most 512 characters');
  if (/[\0\r\n]/.test(glob)) throw new Error('Glob patterns may not contain NUL or line breaks');
  const pattern = glob.startsWith('!') ? glob.slice(1) : glob;
  if (!pattern) throw new Error('Glob exclusion pattern must not be empty');
  if (pattern.startsWith('-')) throw new Error('Glob patterns may not start with an option-looking hyphen');
  if (pattern.includes('\\')) throw new Error('Glob patterns must use forward slashes');
  if (isAbsolute(pattern) || /^(?:[A-Za-z]:|\/\/)/.test(pattern)) throw new Error('Glob patterns must be relative to the requested path');
  if (pattern.split('/').includes('..')) throw new Error('Glob patterns may not traverse to a parent directory');
  return glob;
}

function validateGlobs(globs) {
  if (globs === undefined) return [];
  if (!Array.isArray(globs) || globs.length > 20) throw new Error('globs must be an array with at most 20 items');
  return globs.map(validateGlob);
}

async function resolveExcludePaths(base, values) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 100) throw new Error('excludePaths must be an array with at most 100 items');
  const output = [];
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\0\r\n]/.test(value)) {
      throw new Error('Each excludePaths entry must be a non-empty path without NUL or line breaks');
    }
    const candidate = resolve(isAbsolute(value) ? value : join(base, value));
    rejectAlternateDataStream(candidate);
    if (!within(base, candidate)) throw new Error(`Excluded path is outside the requested download root: ${value}`);
    let actual = candidate;
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`Excluded path may not be a symbolic link: ${value}`);
      actual = await realpath(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!within(base, actual)) throw new Error(`Excluded path escaped the requested download root: ${value}`);
    output.push(actual);
  }
  return output;
}

function runRipgrep(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('rg', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: environmentWithoutBundledIsolationKey()
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolvePromise(value);
    };
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_RG_OUTPUT_BYTES) {
        child.kill();
        finish(new Error(`ripgrep output exceeded ${MAX_RG_OUTPUT_BYTES} bytes`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (code !== 0 && code !== 1) {
        finish(new Error(Buffer.concat(stderr).toString('utf8').trim() || `ripgrep exited with ${code}`));
        return;
      }
      finish(null, Buffer.concat(stdout));
    });
  });
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
}

const excludedBy = (path, exclusions) => exclusions.some((entry) => path === entry || path.startsWith(`${entry}${sep}`));
const pathSort = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const archivePath = (base, path) => relative(base, path).split(sep).join('/');
const isGitInternalPath = (relativePath) => relativePath.split('/').includes('.git');

async function assertDirectoryTreeHasNoGlobDeniedPath(target) {
  if (configuredDisallowedPathGlobs.length === 0) return;
  const pending = [target.path];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const lexical = join(directory, entry.name);
      assertNotGlobDenied(lexical, 'safe-download directory scan');
      const info = await lstat(lexical);
      if (info.isSymbolicLink()) throw new Error(`safe-download directory scan found a symbolic link: ${lexical}`);
      const actual = await realpath(lexical);
      if (!within(target.path, actual)) throw new Error(`safe-download directory scan escaped the requested download root: ${lexical}`);
      assertNotGlobDenied(actual, 'safe-download directory scan');
      if (info.isDirectory()) pending.push(actual);
    }
  }
}

async function enumerateDirectory(target, args) {
  await assertDirectoryTreeHasNoGlobDeniedPath(target);
  const globs = validateGlobs(args.globs);
  const exclusions = await resolveExcludePaths(target.path, args.excludePaths);
  if (args.includeIgnored !== undefined && typeof args.includeIgnored !== 'boolean') throw new Error('includeIgnored must be a boolean');
  const command = ['--files', '--hidden', '--null', '--sort', 'path'];
  if (args.includeIgnored === true) command.push('--no-ignore');
  for (const glob of globs) command.push('--glob', glob);
  command.push('--glob', '!.git', '--glob', '!.git/**', '--glob', '!**/.git', '--glob', '!**/.git/**', '--', target.path);
  const output = decodeUtf8(await runRipgrep(command));
  const files = [];
  for (const rawPath of output.split('\0')) {
    if (!rawPath) continue;
    const lexical = resolve(rawPath);
    const info = await lstat(lexical);
    if (info.isSymbolicLink()) throw new Error(`ripgrep returned a symbolic-link path: ${rawPath}`);
    if (!info.isFile()) continue;
    const actual = await realpath(lexical);
    if (!within(target.path, actual)) throw new Error(`ripgrep returned a path outside the requested download root: ${rawPath}`);
    assertNotGlobDenied(actual, 'safe-download directory entry');
    if (excludedBy(actual, exclusions)) continue;
    const name = archivePath(target.path, actual);
    if (isGitInternalPath(name)) continue;
    files.push({ path: actual, name, info: await stat(actual) });
  }
  files.sort((left, right) => pathSort(left.name, right.name));
  return files;
}

function validateArchiveName(value, target) {
  let name = value ?? `${basename(target.path) || 'download'}.zip`;
  if (typeof name !== 'string' || name.length === 0 || name.length > 128) throw new Error('archiveName must be a non-empty basename of at most 128 characters');
  if (/[\0-\x1f<>:"/\\|?*]/.test(name) || name.includes('..')) throw new Error('archiveName must be a safe basename without path separators, control characters, or reserved filename characters');
  if (!name.toLowerCase().endsWith('.zip')) name += '.zip';
  return name;
}

function rejectCredentialContent(bytes) {
  const text = bytes.toString('utf8');
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text))) throw new Error('File content resembles a credential or private key and was not downloaded');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.bytes, { level: 9 });
    const compressed = deflated.length < entry.bytes.length ? deflated : entry.bytes;
    const method = compressed === entry.bytes ? 0 : 8;
    const checksum = crc32(entry.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, end]);
}

async function readEntry(file) {
  assertNotGlobDenied(file.path, 'safe-download file');
  if (BLOCKED_DOWNLOAD_EXTENSIONS.has(extname(file.path).toLowerCase())) throw new Error(`Blocked file type cannot be downloaded: ${file.name}`);
  if (!file.info.isFile()) throw new Error(`Download entry is not a regular file: ${file.name}`);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(file.path, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Download entry is not a regular file: ${file.name}`);
    const bytes = await handle.readFile();
    rejectCredentialContent(bytes);
    return { name: file.name, bytes };
  } finally {
    await handle.close();
  }
}

function validateArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  const allowed = new Set(['path', 'archiveName', 'globs', 'excludePaths', 'includeIgnored']);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`download_zip does not accept the ${key} argument`);
  if (!Object.hasOwn(args, 'path')) throw new Error('download_zip requires path');
  if (args.archiveName !== undefined && typeof args.archiveName !== 'string') throw new Error('archiveName must be a string');
  if (args.includeIgnored !== undefined && typeof args.includeIgnored !== 'boolean') throw new Error('includeIgnored must be a boolean');
  return args;
}

async function downloadZip(args) {
  const target = await resolveDownloadPath(args.path);
  const archiveName = validateArchiveName(args.archiveName, target);
  let files;
  if (target.info.isFile()) {
    validateGlobs(args.globs);
    if (args.excludePaths !== undefined && (!Array.isArray(args.excludePaths) || args.excludePaths.length > 0)) {
      throw new Error('excludePaths is supported only when path is a directory');
    }
    files = [{ path: target.path, name: basename(target.path), info: target.info }];
  } else if (target.info.isDirectory()) {
    files = await enumerateDirectory(target, args);
  } else {
    throw new Error('download_zip path must be a regular file or directory');
  }
  if (files.length === 0) throw new Error('No files matched the download request');
  if (files.length > MAX_FILES) throw new Error(`Download file count ${files.length} exceeds the ${MAX_FILES}-file limit`);
  const inputBytes = files.reduce((sum, file) => sum + file.info.size, 0);
  if (!Number.isSafeInteger(inputBytes) || inputBytes > MAX_INPUT_BYTES) throw new Error(`Download input bytes ${inputBytes} exceed the ${MAX_INPUT_BYTES}-byte limit`);
  const entries = [];
  for (const file of files) entries.push(await readEntry(file));
  const actualInputBytes = entries.reduce((sum, entry) => sum + entry.bytes.length, 0);
  if (!Number.isSafeInteger(actualInputBytes) || actualInputBytes > MAX_INPUT_BYTES) {
    throw new Error(`Download input bytes ${actualInputBytes} exceed the ${MAX_INPUT_BYTES}-byte limit`);
  }
  const zip = createZip(entries);
  if (zip.length > MAX_ZIP_BYTES) throw new Error(`Generated ZIP bytes ${zip.length} exceed the ${MAX_ZIP_BYTES}-byte limit`);
  const metadata = {
    name: archiveName,
    mimeType: 'application/zip',
    files: entries.length,
    inputBytes: actualInputBytes,
    zipBytes: zip.length,
    sha256: createHash('sha256').update(zip).digest('hex')
  };
  const structuredContent = { ok: true, result: metadata };
  return {
    content: [
      { type: 'text', text: JSON.stringify(structuredContent) },
      {
        type: 'resource',
        resource: {
          uri: `file:///${encodeURIComponent(archiveName)}`,
          mimeType: 'application/zip',
          blob: zip.toString('base64')
        }
      }
    ],
    structuredContent,
    isError: false
  };
}

function errorToolResult(error) {
  const value = { ok: false, error: error instanceof Error ? error.message : String(error) };
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true
  };
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
        serverInfo: { name: 'safe-download', version: '1.1.0' },
        instructions: 'Read-only ZIP transfer from an independently configured cwd and root allowlist. Directory listing uses fixed ripgrep arguments; output limits, blocked file types, credentials, and path boundaries are enforced locally.'
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: [schema] });
    if (request.method === 'tools/call') {
      try {
        if (request.params?.name !== 'download_zip') throw new Error(`Unknown tool: ${request.params?.name}`);
        return response(request.id, await isolation.run(
          request.params?.arguments ?? {},
          (toolArguments) => downloadZip(validateArguments(toolArguments))
        ));
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
  if (cli.help) process.stdout.write(SAFE_DOWNLOAD_HELP);
  else if (process.argv.slice(2).length > 0) {
    process.stderr.write('Unknown argument. Run with --help.\n');
    process.exitCode = 2;
  } else await startStdio();
}