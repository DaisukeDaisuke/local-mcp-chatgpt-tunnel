import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, open, readFile, realpath, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disallowedPathGlobError, findDisallowedPathGlob, normalizeDisallowedPathGlobs } from '../../app/path-glob.mjs';

const MAX_TEXT_BYTES = Number(process.env.SAFE_FILES_MAX_BYTES ?? 2 * 1024 * 1024);
const MAX_READ_OUTPUT_BYTES = Number(process.env.SAFE_FILES_MAX_READ_OUTPUT_BYTES ?? 4 * 1024 * 1024);
const MAX_READ_ITEMS = 20;
const MAX_PATCH_BYTES = Number(process.env.SAFE_FILES_MAX_PATCH_BYTES ?? 4 * 1024 * 1024);
const MAX_TRANSFER_BYTES = Number(process.env.SAFE_FILES_MAX_TRANSFER_BYTES ?? 16 * 1024 * 1024);
const MAX_TRANSFER_CHUNK_BYTES = Number(process.env.SAFE_FILES_MAX_TRANSFER_CHUNK_BYTES ?? 512 * 1024);
const MAX_SEARCH_OUTPUT_BYTES = Number(process.env.SAFE_FILES_MAX_SEARCH_OUTPUT_BYTES ?? 8 * 1024 * 1024);
const MAX_SEARCH_RESULTS = Number(process.env.SAFE_FILES_MAX_SEARCH_RESULTS ?? 500);
const MAX_BINARY_SAMPLE_BYTES = 64 * 1024;
const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);

export const SAFE_FILES_HELP = `safe-files MCP

Usage:
  node mcp/safe-files/server.mjs

Options:
  --help  Print this help and exit.

The process working directory is exposed as the MCP root and is the base for relative paths. Set cwd in gateway.toml instead of passing --root.
Tools that document it, including read_text, accept both paths relative to the current MCP root and absolute paths. Every resolved path must remain inside a configured allowed directory.
When exposed through the gateway, add every permitted absolute directory to allowed_directories.
Use multiple allowed directories in one safe-files entry when copy or move must cross workspaces; use separate entries when isolation is preferred.
`;

const cli = { help: process.argv.slice(2).some((value) => value === '--help' || value === '-h') };
const configuredRoots = cli.help ? [] : JSON.parse(
  process.env.LOCAL_MCP_ALLOWED_DIRECTORIES
    ?? process.env.SAFE_FILES_ROOTS
    ?? JSON.stringify([process.cwd()])
);
const configuredDisallowedDirectories = cli.help ? [] : JSON.parse(process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES ?? '[]');
const configuredDisallowedFiles = cli.help ? [] : JSON.parse(process.env.LOCAL_MCP_DISALLOWED_FILES ?? '[]');
const configuredDisallowedPathGlobs = cli.help ? [] : normalizeDisallowedPathGlobs(
  JSON.parse(process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS ?? '[]'),
  'LOCAL_MCP_DISALLOWED_PATH_GLOBS'
);

const BLOCKED_SECRET_EXTENSIONS = new Set(['.key', '.kdbx', '.p12', '.pem', '.pfx', '.ppk', '.pub']);
const BLOCKED_TRANSFER_EXTENSIONS = new Set(['.dsv', '.dst', '.nds', '.sav', ...BLOCKED_SECRET_EXTENSIONS]);
const BLOCKED_BINARY_WRITE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.dll', '.exe', '.lnk', '.msi', '.ps1', '.scr']);
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{25,}\b/
];

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
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
const LOCAL_STATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
const LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
};
const LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false
};
const LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
const toolResult = (value, isError = false, displayText) => ({
  content: [{ type: 'text', text: typeof displayText === 'string' ? displayText : JSON.stringify(value) }],
  structuredContent: value,
  isError
});

const schemas = [
  {
    name: 'roots',
    description: 'List configured allowed workspace directories and the current MCP root, which is the process working directory used to resolve relative paths.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'get_working_directory',
    description: 'Return the current MCP root, which is the working directory used to resolve relative paths.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'set_working_directory',
    description: 'Change the current MCP root and relative-path base to an existing directory inside a configured allowed directory.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    },
    annotations: LOCAL_STATE_ANNOTATIONS
  },
  {
    name: 'list_directory',
    description: 'List one directory inside the workspace root.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'list_files',
    description: 'Recursively list files with fixed ripgrep arguments. Hidden files are included, .git is always excluded, and exact files or directories can be omitted with excludePaths.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', default: '.', description: 'Directory to enumerate.' },
        globs: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 512 },
          maxItems: 20,
          description: 'Safe ripgrep glob patterns relative to path. Absolute, parent-traversing, control-character, and option-looking patterns are rejected.'
        },
        excludePaths: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 1024 },
          maxItems: 100,
          description: 'Exact files or directories to omit. Relative values are resolved below path; descendants of excluded directories are omitted.'
        },
        includeIgnored: { type: 'boolean', default: false },
        maxResults: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, default: 100 }
      },
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'search_text',
    description: 'Search UTF-8 workspace text with ripgrep. The executable and arguments are fixed; paths outside the workspace root are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 4096 },
        path: { type: 'string', default: '.' },
        fixedStrings: { type: 'boolean', default: false },
        caseSensitive: { type: 'boolean', default: true },
        globs: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 512 }, maxItems: 20 },
        maxResults: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_RESULTS, default: 100 }
      },
      required: ['query'],
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'read_text',
    description: 'Read one or more UTF-8 workspace files. Paths may be absolute or relative to the current MCP root, which is the current working directory; every resolved path must remain inside a configured allowed directory. Each read may request the whole file or an inclusive line range. UTF-16, UTF-32, invalid UTF-8, detected credentials, and other failures are reported independently per file. Use format=annotated for absolute-path delimiters and source line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, description: 'Absolute path or path relative to the current MCP root/current working directory.' },
        startLine: { type: 'integer', minimum: 1 },
        endLine: { type: 'integer', minimum: 1 },
        reads: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_READ_ITEMS,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', minLength: 1, description: 'Absolute path or path relative to the current MCP root/current working directory.' },
              startLine: { type: 'integer', minimum: 1 },
              endLine: { type: 'integer', minimum: 1 }
            },
            required: ['path'],
            additionalProperties: false
          }
        },
        format: { type: 'string', enum: ['structured', 'annotated'], default: 'structured' }
      },
      additionalProperties: false,
      oneOf: [
        { required: ['path'], not: { required: ['reads'] } },
        { required: ['reads'], not: { required: ['path'] } }
      ]
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'file_info',
    description: 'Inspect multiple workspace paths without returning file content, including type, size, line availability, credential censorship, prohibition status, and a binary-likelihood assessment. Each path reports success or its own error independently.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          maxItems: 100
        }
      },
      required: ['paths'],
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'read_file_chunk',
    description: 'Transfer a bounded chunk of a non-secret workspace file as base64. ROM, state, and key file types are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 0, default: 0 },
        length: { type: 'integer', minimum: 1, maximum: MAX_TRANSFER_CHUNK_BYTES, default: MAX_TRANSFER_CHUNK_BYTES }
      },
      required: ['path'],
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'write_file',
    description: 'Atomically receive one bounded base64 file inside a workspace. Native executables, PowerShell/batch launchers, secrets, ROMs, and state files are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        dataBase64: { type: 'string', minLength: 1 },
        overwrite: { type: 'boolean', default: false },
        sha256: { type: 'string', pattern: '^[A-Fa-f0-9]{64}$' }
      },
      required: ['path', 'dataBase64'],
      additionalProperties: false
    },
    annotations: LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: 'write_text_file',
    description: 'Atomically create or replace one UTF-8 text file inside a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        overwrite: { type: 'boolean', default: false }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    annotations: LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS
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
    },
    annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: 'create_directory',
    description: 'Create one directory inside a workspace. Existing directories are accepted.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false
    },
    annotations: LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: 'copy',
    description: 'Copy one regular file between configured allowed workspace directories. Source and destination may be absolute or relative to the current MCP root. The destination must not already exist, and paths are handled literally without a shell.',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', minLength: 1 },
        destinationPath: { type: 'string', minLength: 1 }
      },
      required: ['sourcePath', 'destinationPath'],
      additionalProperties: false
    },
    annotations: LOCAL_ADDITIVE_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: 'move',
    description: 'Move one regular file between configured allowed workspace directories. Source and destination may be absolute or relative to the current MCP root. The destination must not already exist, and paths are handled literally without a shell.',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', minLength: 1 },
        destinationPath: { type: 'string', minLength: 1 }
      },
      required: ['sourcePath', 'destinationPath'],
      additionalProperties: false
    },
    annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: 'apply_patch',
    description: 'Apply a structured patch or unified Git diff in the workspace. Every file path inside the patch must be workspace-relative; absolute paths and parent traversal are rejected. This invokes only the built-in parser or fixed git apply command.',
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          minLength: 1,
          description: 'Structured patch or unified Git diff whose file paths are relative to the current safe-files workspace, for example INSTALL.md or src/app.mjs. Do not use absolute paths.'
        },
        dryRun: { type: 'boolean', default: false }
      },
      required: ['patch'],
      additionalProperties: false
    },
    annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
  }
].map((schema) => ({ ...schema, outputSchema: TOOL_OUTPUT_SCHEMA }));

const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);
const rootFor = (allowed, candidate) => allowed.find((root) => within(root, candidate));

function assertSafePath(root, candidate) {
  const relativePath = relative(root, candidate);
  if (relativePath === '') return;
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error('Path escaped the allowed workspace root');
}

let rootsPromise;
let deniedPromise;
let workingDirectoryPromise;
const roots = () => {
  if (!Array.isArray(configuredRoots) || configuredRoots.length === 0) {
    return Promise.reject(new Error('No workspace root is configured'));
  }
  rootsPromise ??= Promise.all(configuredRoots.map(async (root) => {
    if (typeof root !== 'string') throw new Error('Workspace roots must be strings');
    return realpath(resolve(root));
  }));
  return rootsPromise;
};
const workingDirectory = async () => {
  workingDirectoryPromise ??= roots().then(([first]) => first);
  return workingDirectoryPromise;
};

const outsideRootsError = (message, allowed) => new Error([
  message,
  `Allowed directories (absolute): ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
  'Allowed files (absolute): (none)'
].join('\n'));

async function canonicalizeExistingPrefix(path) {
  let cursor = resolve(path);
  const missing = [];
  while (true) {
    try {
      const actual = await realpath(cursor);
      return join(actual, ...missing.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

const denied = () => {
  deniedPromise ??= Promise.all([
    Promise.all(configuredDisallowedDirectories.map(canonicalizeExistingPrefix)),
    Promise.all(configuredDisallowedFiles.map(canonicalizeExistingPrefix))
  ]).then(([directories, files]) => ({ directories, files }));
  return deniedPromise;
};

async function assertNotDenied(candidate, context = 'Path') {
  const status = await prohibitedPathStatus(candidate);
  if (status.globMatch) throw disallowedPathGlobError(context, status.globMatch);
  if (status.deniedByConfiguration) throw new Error('Path is denied by disallowed_directories or disallowed_files');
}

async function prohibitedPathStatus(candidate) {
  const globMatch = findDisallowedPathGlob(candidate, configuredDisallowedPathGlobs);
  const blocked = await denied();
  const deniedFile = blocked.files.includes(candidate);
  const deniedDirectory = blocked.directories.find((directory) => within(directory, candidate)) ?? null;
  return {
    globMatch,
    deniedFile,
    deniedDirectory,
    deniedByConfiguration: deniedFile || deniedDirectory !== null
  };
}

async function chooseRoot(path) {
  if (typeof path !== 'string' || path.length === 0 || /[\0\r\n]/.test(path)) throw new Error('Path must be a non-empty string without NUL or line breaks');
  const allowed = await roots();
  const unresolvedCandidate = resolve(isAbsolute(path) ? path : join(await workingDirectory(), path));
  const candidate = await canonicalizeExistingPrefix(unresolvedCandidate);
  const root = rootFor(allowed, candidate);
  if (!root) throw outsideRootsError('Path is outside all allowed workspace roots', allowed);
  assertSafePath(root, candidate);
  return { root, candidate };
}

async function resolveExisting(path) {
  const target = await resolveExistingUnchecked(path);
  await assertNotDenied(target.path);
  return target;
}

async function resolveExistingUnchecked(path) {
  const { root, candidate } = await chooseRoot(path);
  const actual = await realpath(candidate);
  if (!within(root, actual)) throw outsideRootsError('Resolved path escaped the allowed workspace root', await roots());
  assertSafePath(root, actual);
  return { root, path: actual };
}

async function resolveWritable(path) {
  const { root, candidate } = await chooseRoot(path);
  const parent = await realpath(dirname(candidate));
  if (!within(root, parent)) throw new Error('Resolved parent escaped the allowed workspace root');
  assertSafePath(root, parent);
  try {
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) throw new Error('Writing through symbolic links is not allowed');
    const actual = await realpath(candidate);
    if (!within(root, actual)) throw new Error('Resolved file escaped the allowed workspace root');
    assertSafePath(root, actual);
    await assertNotDenied(actual);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await assertNotDenied(candidate);
  return { root, path: candidate };
}

async function resolveTransferSource(path) {
  if (typeof path !== 'string' || path.length === 0 || /[\0\r\n]/.test(path)) {
    throw new Error('Source path must be a non-empty string without NUL or line breaks');
  }
  const allowed = await roots();
  const unresolved = resolve(isAbsolute(path) ? path : join(await workingDirectory(), path));
  const parent = await realpath(dirname(unresolved));
  const candidate = join(parent, basename(unresolved));
  const root = rootFor(allowed, candidate);
  if (!root) throw outsideRootsError('Source path is outside all allowed workspace roots', allowed);
  assertSafePath(root, candidate);
  const sourceInfo = await lstat(candidate);
  if (sourceInfo.isSymbolicLink()) throw new Error('Moving or copying symbolic links is not allowed');
  const actual = await realpath(candidate);
  if (!within(root, actual)) throw outsideRootsError('Resolved source path escaped the allowed workspace root', allowed);
  assertSafePath(root, actual);
  await assertNotDenied(actual, 'Source path');
  const info = await stat(actual);
  if (!info.isFile()) throw new Error('Source path must be a regular file');
  return { path: actual, bytes: info.size };
}

async function resolveTransferDestination(path) {
  const target = await resolveWritable(path);
  try {
    await lstat(target.path);
    throw new Error('Destination already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target.path;
}

async function copyWorkspaceFile(sourcePath, destinationPath) {
  const source = await resolveTransferSource(sourcePath);
  const destination = await resolveTransferDestination(destinationPath);
  await copyFile(source.path, destination, constants.COPYFILE_EXCL);
  return { sourcePath: source.path, destinationPath: destination, bytes: source.bytes };
}

async function moveWorkspaceFile(sourcePath, destinationPath) {
  const source = await resolveTransferSource(sourcePath);
  const destination = await resolveTransferDestination(destinationPath);
  await copyFile(source.path, destination, constants.COPYFILE_EXCL);
  try {
    await unlink(source.path);
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  return { sourcePath: source.path, destinationPath: destination, bytes: source.bytes };
}

function decodeUtf8(bytes) {
  if (bytes.length > MAX_TEXT_BYTES) throw new Error(`Text file exceeds ${MAX_TEXT_BYTES} bytes`);
  return decodeUtf8Strict(bytes);
}

function decodeUtf8Strict(bytes) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) throw new Error('UTF-16 text is not supported; convert the file to UTF-8 first');
  if ((bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
      || (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00)) throw new Error('UTF-32 text is not supported; convert the file to UTF-8 first');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
}

function containsCredential(text) {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

function rejectCredentialContent(text) {
  if (containsCredential(text)) throw new Error('File content resembles a credential or private key and was not returned');
}

function redactCredentialContent(text) {
  let redacted = false;
  let output = text;
  for (const pattern of CREDENTIAL_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    output = output.replace(global, () => {
      redacted = true;
      return '[REDACTED_CREDENTIAL]';
    });
  }
  return { text: output, redacted };
}

function splitTextLines(content) {
  if (content.length === 0) return [];
  const lines = content.split(/\r\n|\n|\r/);
  if (/(?:\r\n|\n|\r)$/.test(content)) lines.pop();
  return lines;
}

function detectedTextEncoding(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) return 'utf-32-le';
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) return 'utf-32-be';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16-le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16-be';
  return 'utf-8';
}

function assessBinaryLikelihood(bytes, complete) {
  const textEncoding = detectedTextEncoding(bytes);
  if (textEncoding !== 'utf-8') {
    return { binaryLikely: false, binaryReason: null, textEncoding };
  }
  if (bytes.includes(0x00)) {
    return { binaryLikely: true, binaryReason: 'nul_byte', textEncoding: null };
  }
  let controlBytes = 0;
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) controlBytes += 1;
  }
  if (bytes.length > 0 && controlBytes / bytes.length >= 0.1) {
    return { binaryLikely: true, binaryReason: 'control_byte_ratio', textEncoding: null };
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    decoder.decode(bytes, { stream: !complete });
  } catch {
    return { binaryLikely: true, binaryReason: 'invalid_utf8', textEncoding: null };
  }
  return { binaryLikely: false, binaryReason: null, textEncoding };
}

async function readBinarySample(path, size) {
  if (size <= MAX_TEXT_BYTES) return { bytes: await readFile(path), complete: true };
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(MAX_BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return { bytes: bytes.subarray(0, bytesRead), complete: false };
  } finally {
    await handle.close();
  }
}

function normalizeTextReadRequests(args) {
  const hasPath = Object.hasOwn(args, 'path');
  const hasReads = Object.hasOwn(args, 'reads');
  if (hasPath === hasReads) throw new Error('Specify exactly one of path or reads');
  if (args.format !== undefined && args.format !== 'structured' && args.format !== 'annotated') {
    throw new Error(`Invalid read format: ${String(args.format)}`);
  }
  if (hasPath) return [{ path: args.path, startLine: args.startLine, endLine: args.endLine }];
  if (args.startLine !== undefined || args.endLine !== undefined) {
    throw new Error('Top-level startLine and endLine cannot be used with reads');
  }
  if (!Array.isArray(args.reads) || args.reads.length < 1 || args.reads.length > MAX_READ_ITEMS) {
    throw new Error(`reads must contain between 1 and ${MAX_READ_ITEMS} items`);
  }
  return args.reads;
}

function validateTextReadRange(input, path) {
  const hasStartLine = input.startLine !== undefined;
  const hasEndLine = input.endLine !== undefined;
  if (hasStartLine !== hasEndLine) throw new Error(`Both startLine and endLine are required for ${path}`);
  if (!hasStartLine) return null;
  const startLine = input.startLine;
  const requestedEndLine = input.endLine;
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new Error(`Invalid start line for ${path}: got ${String(startLine)}, expected an integer of at least 1`);
  }
  if (!Number.isSafeInteger(requestedEndLine) || requestedEndLine < 1) {
    throw new Error(`Invalid end line for ${path}: got ${String(requestedEndLine)}, expected an integer of at least 1`);
  }
  if (requestedEndLine < startLine) {
    throw new Error(`End line is before start line for ${path}: got ${requestedEndLine}, expected at least ${startLine}`);
  }
  return { startLine, requestedEndLine };
}

async function readOneText(input) {
  const inputPath = input?.path;
  if (typeof inputPath !== 'string' || inputPath.length < 1) throw new Error('Read path must be a non-empty string');
  const target = await resolveExisting(inputPath);
  if (!(await stat(target.path)).isFile()) throw new Error('Path is not a file');
  const content = decodeUtf8(await readFile(target.path));
  rejectCredentialContent(content);
  const lines = splitTextLines(content);
  const range = validateTextReadRange(input, target.path);
  if (!range) {
    return {
      ok: true,
      inputPath,
      path: target.path,
      startLine: lines.length === 0 ? null : 1,
      endLine: lines.length === 0 ? null : lines.length,
      requestedEndLine: null,
      lineCount: lines.length,
      contentBytes: new TextEncoder().encode(content).length,
      content
    };
  }
  if (range.startLine > lines.length) {
    throw new Error(`Start line is out of range for ${target.path}: got ${range.startLine}, expected a maximum of ${lines.length}`);
  }
  const endLine = Math.min(range.requestedEndLine, lines.length);
  const rangedContent = lines.slice(range.startLine - 1, endLine).join('\n');
  return {
    ok: true,
    inputPath,
    path: target.path,
    startLine: range.startLine,
    endLine,
    requestedEndLine: range.requestedEndLine,
    lineCount: lines.length,
    contentBytes: new TextEncoder().encode(rangedContent).length,
    content: rangedContent
  };
}

function formatAnnotatedTextRead(item) {
  const path = item.path ?? item.inputPath ?? '<invalid path>';
  const delimiter = `----- ${path} -----`;
  if (!item.ok) return `${delimiter}\nERROR: ${item.error}\n${delimiter}`;
  const lines = splitTextLines(item.content);
  const firstLine = item.startLine ?? 1;
  const body = lines.map((line, index) => `${firstLine + index}: ${line}`);
  return [delimiter, ...body, delimiter].join('\n');
}

async function readText(args) {
  const requests = normalizeTextReadRequests(args);
  const format = args.format ?? 'structured';
  const results = [];
  const annotatedBlocks = [];
  let outputBytes = 0;
  let contentBytes = 0;
  for (const request of requests) {
    try {
      const item = await readOneText(request);
      const annotated = format === 'annotated' ? formatAnnotatedTextRead(item) : null;
      const itemOutputBytes = format === 'annotated'
        ? new TextEncoder().encode(annotated).length
        : item.contentBytes;
      if (outputBytes + itemOutputBytes > MAX_READ_OUTPUT_BYTES) {
        throw new Error(`Combined read output exceeds ${MAX_READ_OUTPUT_BYTES} bytes`);
      }
      outputBytes += itemOutputBytes;
      contentBytes += item.contentBytes;
      results.push(item);
      if (annotated !== null) annotatedBlocks.push(annotated);
    } catch (error) {
      const failed = {
        ok: false,
        inputPath: typeof request?.path === 'string' ? request.path : null,
        error: error instanceof Error ? error.message : String(error)
      };
      results.push(failed);
      if (format === 'annotated') annotatedBlocks.push(formatAnnotatedTextRead(failed));
    }
  }
  const result = {
    format,
    requested: requests.length,
    succeeded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    contentBytes,
    results
  };
  if (format === 'annotated') result.annotated = annotatedBlocks.join('\n');
  return result;
}

async function inspectFileInfo(path) {
  const target = await resolveExistingUnchecked(path);
  const info = await stat(target.path);
  const type = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'other';
  const pathStatus = await prohibitedPathStatus(target.path);
  const prohibitedReasons = [];
  if (pathStatus.globMatch) prohibitedReasons.push(`disallowed_path_globs:${pathStatus.globMatch.pattern}`);
  if (pathStatus.deniedFile) prohibitedReasons.push('disallowed_files');
  if (pathStatus.deniedDirectory) prohibitedReasons.push(`disallowed_directories:${pathStatus.deniedDirectory}`);
  if (type === 'file') {
    const extension = extname(target.path).toLowerCase();
    if (BLOCKED_TRANSFER_EXTENSIONS.has(extension)) prohibitedReasons.push(`blocked_transfer_extension:${extension}`);
    if (BLOCKED_BINARY_WRITE_EXTENSIONS.has(extension)) prohibitedReasons.push(`blocked_binary_write_extension:${extension}`);
  }
  const result = {
    path: target.path,
    type,
    bytes: info.size,
    hasLineCount: false,
    lineCount: null,
    censored: type === 'file' ? null : false,
    censorChecked: type === 'file' ? 'not_checked' : 'not_applicable',
    prohibited: prohibitedReasons.length > 0,
    prohibitedReasons,
    binaryLikely: type === 'file' ? null : false,
    binaryReason: null,
    binaryChecked: type === 'file' ? 'not_checked' : 'not_applicable',
    textEncoding: null
  };
  if (type !== 'file') return result;
  const sample = await readBinarySample(target.path, info.size);
  const binary = assessBinaryLikelihood(sample.bytes, sample.complete);
  result.binaryLikely = binary.binaryLikely;
  result.binaryReason = binary.binaryReason;
  result.binaryChecked = sample.complete ? 'full' : 'sample';
  result.textEncoding = binary.textEncoding;
  const sampleText = sample.bytes.toString('utf8');
  const credentialFound = containsCredential(sampleText);
  result.censored = credentialFound ? true : sample.complete ? false : null;
  result.censorChecked = sample.complete ? 'full' : 'sample';
  if (sample.complete && !binary.binaryLikely && binary.textEncoding === 'utf-8') {
    const content = decodeUtf8(sample.bytes);
    result.hasLineCount = true;
    result.lineCount = splitTextLines(content).length;
    result.censored = containsCredential(content);
  }
  return result;
}

async function fileInfo(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  for (const key of Object.keys(args)) if (key !== 'paths') throw new Error(`file_info does not accept the ${key} argument`);
  if (!Array.isArray(args.paths) || args.paths.length < 1 || args.paths.length > 100) {
    throw new Error('file_info paths must be an array containing 1 through 100 paths');
  }
  const items = [];
  for (const requestedPath of args.paths) {
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      items.push({ requestedPath, ok: false, error: 'Path must be a non-empty string' });
      continue;
    }
    try {
      items.push({ requestedPath, ok: true, ...(await inspectFileInfo(requestedPath)) });
    } catch (error) {
      items.push({
        requestedPath,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { count: items.length, items };
}

async function atomicWriteBytes(path, bytes, overwrite) {
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
    await handle.writeFile(bytes);
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

async function atomicWrite(path, content, overwrite) {
  rejectCredentialContent(content);
  const encoded = new TextEncoder().encode(content);
  if (encoded.length > MAX_TEXT_BYTES) throw new Error(`Text content exceeds ${MAX_TEXT_BYTES} bytes`);
  return atomicWriteBytes(path, encoded, overwrite);
}

function decodeBase64Strict(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_TRANSFER_BYTES / 3) * 4 + 4) throw new Error('Invalid or oversized base64 payload');
  const normalized = value.replace(/\s+/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) throw new Error('Invalid base64 payload');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length > MAX_TRANSFER_BYTES) throw new Error(`File exceeds ${MAX_TRANSFER_BYTES} bytes`);
  return bytes;
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
  if (typeof path !== 'string' || path.trim() === '') throw new Error('Patch path must be a non-empty workspace-relative path');
  if (isAbsolute(path)) throw new Error(`Unsafe patch path: ${path}. Use a workspace-relative path such as INSTALL.md instead of an absolute path.`);
  const parts = path.split(/[\\/]+/);
  if (parts.includes('..')) throw new Error(`Unsafe patch path: ${path}`);
  if (parts.some((part) => part.toLowerCase() === '.git')) throw new Error(`Git internals are not patch targets: ${path}`);
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
  if (/^(?:new file mode|old mode|new mode|deleted file mode) (?:120000|160000)$/m.test(patch)) throw new Error('Symlink and Gitlink mode patches are not supported');
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

async function runRipgrep(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('rg', args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
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
      if (stdoutBytes > MAX_SEARCH_OUTPUT_BYTES) {
        child.kill();
        finish(new Error(`ripgrep output exceeded ${MAX_SEARCH_OUTPUT_BYTES} bytes`));
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
    if (!within(base, candidate)) throw new Error(`Excluded path is outside the requested listing root: ${value}`);
    let actual = candidate;
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error(`Excluded path may not be a symbolic link: ${value}`);
      actual = await realpath(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!within(base, actual)) throw new Error(`Excluded path escaped the requested listing root: ${value}`);
    output.push(actual);
  }
  return output;
}

const pathSort = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const normalizedRelativePath = (base, path) => relative(base, path).split(sep).join('/');
const excludedBy = (path, exclusions) => exclusions.some((entry) => path === entry || path.startsWith(`${entry}${sep}`));
const isGitInternalPath = (relativePath) => relativePath.split('/').includes('.git');
const RIPGREP_GLOB_META = new Set(['\\', '*', '?', '[', ']', '{', '}', '!']);
const escapeRipgrepGlobLiteral = (value) => [...value]
  .map((character) => RIPGREP_GLOB_META.has(character) ? `\\${character}` : character)
  .join('');

async function deniedRipgrepGlobs(base) {
  const blocked = await denied();
  const patterns = new Set();
  for (const file of blocked.files) {
    if (!within(base, file) || file === base) continue;
    patterns.add(`!${escapeRipgrepGlobLiteral(normalizedRelativePath(base, file))}`);
  }
  for (const directory of blocked.directories) {
    if (!within(base, directory) || directory === base) continue;
    const relativeDirectory = escapeRipgrepGlobLiteral(normalizedRelativePath(base, directory));
    patterns.add(`!${relativeDirectory}`);
    patterns.add(`!${relativeDirectory}/**`);
  }
  return [...patterns];
}

async function listFiles(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  const allowed = new Set(['path', 'globs', 'excludePaths', 'includeIgnored', 'maxResults']);
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error(`list_files does not accept the ${key} argument`);
  const target = await resolveExisting(args.path ?? '.');
  if (!(await stat(target.path)).isDirectory()) throw new Error('list_files path must be a directory');
  const globs = validateGlobs(args.globs);
  const exclusions = await resolveExcludePaths(target.path, args.excludePaths);
  const maximum = args.maxResults ?? 100;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_SEARCH_RESULTS) {
    throw new Error(`maxResults must be an integer from 1 through ${MAX_SEARCH_RESULTS}`);
  }
  if (args.includeIgnored !== undefined && typeof args.includeIgnored !== 'boolean') throw new Error('includeIgnored must be a boolean');
  const command = ['--files', '--hidden', '--null', '--sort', 'path'];
  if (args.includeIgnored === true) command.push('--no-ignore');
  for (const glob of globs) command.push('--glob', glob);
  for (const glob of await deniedRipgrepGlobs(target.path)) command.push('--glob', glob);
  command.push('--glob', '!.git', '--glob', '!.git/**', '--glob', '!**/.git', '--glob', '!**/.git/**', '--', target.path);
  const output = decodeUtf8Strict(await runRipgrep(command));
  const files = [];
  for (const rawPath of output.split('\0')) {
    if (!rawPath) continue;
    const lexical = resolve(rawPath);
    const info = await lstat(lexical);
    if (info.isSymbolicLink()) throw new Error(`ripgrep returned a symbolic-link path: ${rawPath}`);
    if (!info.isFile()) continue;
    const actual = await realpath(lexical);
    if (!within(target.path, actual)) throw new Error(`ripgrep returned a path outside the requested listing root: ${rawPath}`);
    await assertNotDenied(actual, 'list_files entry');
    if (excludedBy(actual, exclusions)) continue;
    const relativePath = normalizedRelativePath(target.path, actual);
    if (isGitInternalPath(relativePath)) continue;
    files.push({ path: actual, relativePath });
  }
  files.sort((left, right) => pathSort(left.relativePath, right.relativePath));
  const truncated = files.length > maximum;
  const selected = files.slice(0, maximum);
  return { path: target.path, count: selected.length, truncated, files: selected };
}

async function searchText(args) {
  const target = await resolveExisting(args.path ?? '.');
  const maximum = Math.min(args.maxResults ?? 100, MAX_SEARCH_RESULTS);
  const command = ['--json', '--color=never', '--hidden', '--max-filesize', String(MAX_TEXT_BYTES)];
  if (args.fixedStrings === true) command.push('--fixed-strings');
  if (args.caseSensitive === false) command.push('--ignore-case');
  for (const glob of validateGlobs(args.globs)) command.push('--glob', glob);
  for (const glob of await deniedRipgrepGlobs(target.path)) command.push('--glob', glob);
  command.push('--', args.query, target.path);
  const output = decodeUtf8Strict(await runRipgrep(command));
  const matches = [];
  let redacted = false;
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (event.type !== 'match') continue;
    const rawPath = event.data?.path?.text;
    if (typeof rawPath !== 'string') continue;
    const actual = await resolveExisting(rawPath);
    const rawLine = event.data?.lines?.text ?? '';
    const safeLine = redactCredentialContent(rawLine.replace(/\r?\n$/, ''));
    redacted ||= safeLine.redacted;
    matches.push({
      path: actual.path,
      line: event.data?.line_number ?? null,
      column: (event.data?.submatches?.[0]?.start ?? 0) + 1,
      text: safeLine.text
    });
    if (matches.length >= maximum) break;
  }
  return { query: args.query, path: target.path, count: matches.length, truncated: matches.length >= maximum, redacted, matches };
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'roots':
      return {
        roots: await roots(),
        denied: await denied(),
        disallowedPathGlobs: configuredDisallowedPathGlobs,
        workingDirectory: await workingDirectory()
      };
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
      for (const entry of entries) await assertNotDenied(join(target.path, entry.name), 'list_directory entry');
      return {
        path: target.path,
        entries: entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'
        }))
      };
    }
    case 'list_files':
      return listFiles(args);
    case 'search_text':
      return searchText(args);
    case 'read_text':
      return readText(args);
    case 'file_info':
      return fileInfo(args);
    case 'read_file_chunk': {
      const target = await resolveExisting(args.path);
      const info = await stat(target.path);
      if (!info.isFile()) throw new Error('Path is not a file');
      if (BLOCKED_TRANSFER_EXTENSIONS.has(extname(target.path).toLowerCase())) throw new Error('This file type is not available through file transfer');
      if (info.size > MAX_TRANSFER_BYTES) throw new Error(`File exceeds transfer limit of ${MAX_TRANSFER_BYTES} bytes`);
      const bytes = await readFile(target.path);
      rejectCredentialContent(bytes.toString('utf8'));
      const offset = args.offset ?? 0;
      const length = Math.min(args.length ?? MAX_TRANSFER_CHUNK_BYTES, MAX_TRANSFER_CHUNK_BYTES);
      if (offset > bytes.length) throw new Error('Offset is beyond end of file');
      const chunk = bytes.subarray(offset, Math.min(offset + length, bytes.length));
      return {
        path: target.path,
        offset,
        bytes: chunk.length,
        totalBytes: bytes.length,
        eof: offset + chunk.length >= bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        dataBase64: chunk.toString('base64')
      };
    }
    case 'write_file': {
      const extension = extname(args.path).toLowerCase();
      if (BLOCKED_TRANSFER_EXTENSIONS.has(extension) || BLOCKED_BINARY_WRITE_EXTENSIONS.has(extension)) throw new Error('This file type is not accepted through binary transfer');
      const bytes = decodeBase64Strict(args.dataBase64);
      rejectCredentialContent(bytes.toString('utf8'));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (args.sha256 && args.sha256.toLowerCase() !== digest) throw new Error('SHA-256 mismatch');
      const destination = await atomicWriteBytes(args.path, bytes, args.overwrite === true);
      return { path: destination, bytes: bytes.length, sha256: digest };
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
      if (!within(root, parent)) throw new Error('Resolved parent escaped the allowed workspace root');
      assertSafePath(root, parent);
      try {
        await mkdir(candidate, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST' || !(await stat(candidate)).isDirectory()) throw error;
      }
      return { path: candidate };
    }
    case 'copy':
      return copyWorkspaceFile(args.sourcePath, args.destinationPath);
    case 'move':
      return moveWorkspaceFile(args.sourcePath, args.destinationPath);
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
        serverInfo: { name: 'safe-files', version: '4.3.0' },
        instructions: 'Current-working-directory UTF-8 editing, fixed ripgrep search, and bounded file transfer. The gateway enforces configured path allowlists before tool calls are forwarded.'
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        const toolName = request.params?.name;
        const result = await callTool(toolName, request.params?.arguments ?? {});
        if (toolName === 'read_text' && result?.format === 'annotated') {
          const { annotated, ...structuredResult } = result;
          return response(request.id, toolResult({ ok: true, result: structuredResult }, false, annotated));
        }
        return response(request.id, toolResult({ ok: true, result }));
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

if (directExecution) {
  if (cli.help) process.stdout.write(SAFE_FILES_HELP);
  else if (process.argv.slice(2).length > 0) {
    process.stderr.write('Unknown argument. Run with --help.\n');
    process.exitCode = 2;
  } else await startStdio();
}
