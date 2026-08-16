import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { ToolPathPolicy } from '../../app/path-policy.mjs';

const SERVER_VERSION = '0.1.0';
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_ASYNC_RUNTIME_MS = 10 * 60 * 1000;
const MAX_ASYNC_WAIT_MS = 10 * 60 * 1000;
const MAX_ACTIVE_ASYNC_JOBS = 16;
const MAX_RETAINED_ASYNC_JOBS = 64;
const MAX_OUTPUT_BYTES = boundedIntegerEnvironment('CODESPACE_MCP_MAX_OUTPUT_BYTES', 8 * 1024 * 1024, 1024, 128 * 1024 * 1024);
const MAX_TRANSFER_BYTES = boundedIntegerEnvironment('CODESPACE_MCP_MAX_TRANSFER_BYTES', 500_000_000, 1, 500_000_000);
const MAX_SCAN_ENTRIES = boundedIntegerEnvironment('CODESPACE_MCP_MAX_SCAN_ENTRIES', 20_000, 1, 1_000_000);
const MAX_CP_SOURCES = 200;
const MAX_REMOTE_SEARCH_RESULTS = 500;
const MAX_REMOTE_STDIN_BYTES = 1024 * 1024;
const MAX_ASYNC_STDIN_WRITE_BYTES = 64 * 1024;
const MAX_ASYNC_STDIN_TOTAL_BYTES = 1024 * 1024;
const REMOTE_MAX_TEXT_BYTES = 16 * 1024 * 1024;
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\b[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{25,}\b/
];

const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);

function boundedIntegerEnvironment(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  return value;
}

function stringOption(name) {
  const prefix = `--${name}=`;
  const matches = process.argv.slice(2).filter((value) => value.startsWith(prefix));
  if (matches.length > 1) throw new Error(`${prefix}<value> may be specified only once`);
  return matches.length === 1 ? matches[0].slice(prefix.length) : undefined;
}

const help = process.argv.slice(2).some((value) => value === '--help' || value === '-h');
for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') continue;
  if (argument.startsWith('--gh-executable=') || argument.startsWith('--token-file=') || argument.startsWith('--ssh-key-file=')) continue;
  throw new Error(`Unknown argument: ${argument}`);
}

function absoluteExecutableArgument(value) {
  if (help) return process.execPath;
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) throw new Error('--gh-executable=<absolute-path> is required');
  if (process.platform === 'win32' && !/\.exe$/i.test(value)) throw new Error('--gh-executable must point to a native .exe on Windows');
  return value;
}

function optionalAbsoluteFileArgument(value, name) {
  if (value === undefined || help) return undefined;
  if (value.length === 0 || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

const ghExecutableConfigured = absoluteExecutableArgument(stringOption('gh-executable'));
const tokenFileConfigured = optionalAbsoluteFileArgument(stringOption('token-file'), '--token-file');
const sshKeyFileConfigured = optionalAbsoluteFileArgument(stringOption('ssh-key-file'), '--ssh-key-file');

export const CODESPACE_MCP_HELP = `codespace MCP\n\nUsage:\n  node mcp/codespace/server.mjs --gh-executable=<absolute-gh.exe-path> [--token-file=<absolute-token-file>] [--ssh-key-file=<absolute-private-key>]\n\nControls existing GitHub Codespaces only. It can list/view existing codespaces, run strictly tokenized SSH commands, copy selected local files/directories to one remote destination directory, and publish/privatize GitHub-hosted forwarded ports while returning their browseUrl. It never creates, rebuilds, stops, deletes, or changes the machine type of a codespace, and it never creates a localhost port tunnel.\n`;

function pathArray(name, fallback = []) {
  if (help) return [];
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
const disallowedPathGlobs = pathArray('LOCAL_MCP_DISALLOWED_PATH_GLOBS');
const isolation = createBundledIsolation();
const policy = new ToolPathPolicy({ serverName: 'codespace', cwd: process.cwd(), allowedDirectories, allowedFiles, disallowedDirectories, disallowedFiles, disallowedPathGlobs });

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } }, required: ['ok'], additionalProperties: false };
const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError });
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const remoteMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const copyMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const installMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const localState = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const closeState = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const commonCodespaceId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,127}$', description: 'Exact Codespace name returned by list_codespaces.' };
const commonTimeout = { type: 'integer', minimum: 1, maximum: MAX_COMMAND_TIMEOUT_MS, default: DEFAULT_COMMAND_TIMEOUT_MS };
const commonSshTimeout = { type: 'integer', minimum: 1, maximum: MAX_ASYNC_RUNTIME_MS, default: MAX_ASYNC_RUNTIME_MS, description: 'Hard execution limit. SSH is never allowed to run for more than 10 minutes.' };
const commonAsyncId = { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-fA-F-]{36}$' };

const schemas = [
  { name: 'list_codespaces', description: 'List existing GitHub Codespaces for the authenticated user. This MCP cannot create codespaces.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'view_codespace', description: 'View one existing Codespace by exact name.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'roots', description: 'List only immediate workspace roots below /workspaces in one existing Codespace. This never scans /, the home directory, or arbitrary filesystem roots.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'git_root', description: 'Resolve the Git repository top-level directory for one path already below /workspaces/<workspace>. The input may not be / or /workspaces itself.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, path: { type: 'string', minLength: 1, maxLength: 1024 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'path'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'ripgrep_version', description: 'Return rg --version from one existing Codespace without modifying it.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'install_ripgrep', description: 'Ensure ripgrep exists in one existing Codespace. If rg --version already works nothing is installed; otherwise a fixed package-manager installer is used and rg --version is verified afterwards.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, timeoutMs: commonTimeout }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: installMutation },
  { name: 'search_text', description: 'Search text with ripgrep inside one explicit remote root below /workspaces/<workspace>. searchBase is required on every call; / and /workspaces are rejected so the tool cannot scan the whole Codespace. Query/glob data is sent over SSH stdin and is never interpolated into the remote shell command.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, searchBase: { type: 'string', minLength: 1, maxLength: 1024 }, query: { type: 'string', minLength: 1, maxLength: 4096 }, fixedStrings: { type: 'boolean', default: false }, caseSensitive: { type: 'boolean', default: true }, globs: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 512 } }, maxResults: { type: 'integer', minimum: 1, maximum: MAX_REMOTE_SEARCH_RESULTS, default: 100 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'searchBase', 'query'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'ssh', description: 'Run one remote command in an existing Codespace. The command is a strictly validated token array. Set async=true for commands that may block: the tool returns an asyncId immediately, and the job still has a hard runtime limit of at most 10 minutes. Synchronous SSH is also capped at 10 minutes.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, command: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 512 } }, async: { type: 'boolean', default: false }, timeoutMs: commonSshTimeout }, required: ['codespaceId', 'command'], additionalProperties: false }, outputSchema, annotations: remoteMutation },
  { name: 'get_async_status', description: 'Return state and exit metadata for one async SSH job created by this MCP process.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId }, required: ['asyncId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'get_async_logs', description: 'Return the currently captured stdout and stderr for one async SSH job. Output is bounded by CODESPACE_MCP_MAX_OUTPUT_BYTES; exceeding the bound terminates the job instead of growing without limit.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId }, required: ['asyncId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'write_async_stdin', description: 'Write bounded UTF-8 data to stdin of one running async SSH job. Each write is limited to 64 KiB and total stdin per job is limited to 1 MiB. Set end=true to close stdin after this write. This does not extend the job runtime deadline.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId, data: { type: 'string', maxLength: MAX_ASYNC_STDIN_WRITE_BYTES }, end: { type: 'boolean', default: false } }, required: ['asyncId'], additionalProperties: false }, outputSchema, annotations: remoteMutation },
  { name: 'wait_async', description: 'Wait again for one async SSH job. waitTimeoutMs controls only this wait and is capped at 10 minutes; it does not extend the job runtime deadline. If the wait expires while the job is still running, the current running status is returned.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId, waitTimeoutMs: { type: 'integer', minimum: 1, maximum: MAX_ASYNC_WAIT_MS, default: MAX_ASYNC_WAIT_MS } }, required: ['asyncId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'cancel_async', description: 'Cancel one running async SSH job by terminating its local gh process. Completed jobs are left unchanged.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId }, required: ['asyncId'], additionalProperties: false }, outputSchema, annotations: closeState },
  { name: 'copy_to_codespace', description: 'Copy multiple selected local files/directories from one local source directory to one remote destination directory. Select exactly one of paths or globs. The first copy for an isolated session verifies SSH readiness with a fixed echo started probe; later copies reuse that readiness unless cp fails, then refresh once. Copy always uses gh codespace cp -e.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, sourceDirectory: { type: 'string', minLength: 1, maxLength: 1024 }, paths: { type: 'array', minItems: 1, maxItems: MAX_CP_SOURCES, items: { type: 'string', minLength: 1, maxLength: 1024 } }, globs: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 512 } }, remoteDestination: { type: 'string', minLength: 1, maxLength: 1024 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'sourceDirectory', 'remoteDestination'], additionalProperties: false }, outputSchema, annotations: copyMutation },
  { name: 'stop_codespace', description: 'Stop one existing Codespace owned by this isolated session using gh codespace stop. Running async SSH jobs for that Codespace are cancelled first and cached SSH readiness is cleared. This does not delete the Codespace or discard saved changes.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, timeoutMs: commonTimeout }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: closeState },
  { name: 'list_ports', description: 'List GitHub-hosted forwarded ports for one Codespace, including complete browseUrl values and visibility.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'open_port', description: 'Make one already-forwarded Codespace port public on GitHub infrastructure and return its complete https://...app.github.dev browse URL. This does not create a local tunnel.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, port: { type: 'integer', minimum: 1, maximum: 65535 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'port'], additionalProperties: false }, outputSchema, annotations: localState },
  { name: 'close_port', description: 'Close public internet access to one forwarded Codespace port by changing its GitHub visibility back to private.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, port: { type: 'integer', minimum: 1, maximum: 65535 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'port'], additionalProperties: false }, outputSchema, annotations: closeState }
];

function safeCodespaceId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)) throw new Error('codespaceId must contain only letters, numbers, and hyphens');
  return value;
}

function safeLimit(value = 30) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new Error('limit must be from 1 through 100');
  return String(value);
}

function timeout(value, fallback = DEFAULT_COMMAND_TIMEOUT_MS) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_COMMAND_TIMEOUT_MS) throw new Error(`timeoutMs must be an integer from 1 through ${MAX_COMMAND_TIMEOUT_MS}`);
  return resolved;
}

function sshTimeout(value) {
  const resolved = value ?? MAX_ASYNC_RUNTIME_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_ASYNC_RUNTIME_MS) throw new Error(`timeoutMs must be an integer from 1 through ${MAX_ASYNC_RUNTIME_MS} for SSH`);
  return resolved;
}

function asyncWaitTimeout(value) {
  const resolved = value ?? MAX_ASYNC_WAIT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_ASYNC_WAIT_MS) throw new Error(`waitTimeoutMs must be an integer from 1 through ${MAX_ASYNC_WAIT_MS}`);
  return resolved;
}

function safeAsyncId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('asyncId must be a UUID returned by async SSH');
  return value.toLowerCase();
}

function safePort(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error(`${label} must be an integer from 1 through 65535`);
  return value;
}

function safeRemoteWorkspacePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty remote path without NUL or line breaks`);
  }
  if (value.includes('\\')) throw new Error(`${label} must use POSIX / separators`);
  const collapsed = value.replace(/\/{2,}/g, '/').replace(/\/$/, '');
  if (!collapsed.startsWith('/workspaces/')) throw new Error(`${label} must be below /workspaces/<workspace>`);
  const components = collapsed.split('/').filter(Boolean);
  if (components.length < 2 || components[0] !== 'workspaces') throw new Error(`${label} may not be / or /workspaces`);
  if (components.some((component) => component === '.' || component === '..')) throw new Error(`${label} may not contain . or .. path components`);
  return collapsed;
}

function safeRemoteGlob(value, index) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\0\r\n]/.test(value)) throw new Error(`globs[${index}] is invalid`);
  if (value.startsWith('/') || value.includes('\\')) throw new Error(`globs[${index}] must be relative to the selected root`);
  const components = value.split('/');
  if (components.some((component) => component === '..')) throw new Error(`globs[${index}] may not contain .. path components`);
  return value;
}

function boundedSearchLimit(value = 100) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_REMOTE_SEARCH_RESULTS) throw new Error(`maxResults must be from 1 through ${MAX_REMOTE_SEARCH_RESULTS}`);
  return value;
}

function base64Line(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function safeRemoteCommandTokens(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw new Error('command must contain from 1 through 64 tokens');
  const output = value.map((token, index) => {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512 || /[\0\r\n\t ]/.test(token)) throw new Error(`command[${index}] must be a non-empty token without whitespace`);
    const expression = index === 0 ? /^[A-Za-z0-9._/+:-]+$/ : /^[A-Za-z0-9._/:+,=%-]+$/;
    if (!expression.test(token)) throw new Error(`command[${index}] contains characters that are not permitted in remote shell tokens`);
    if (/["'!@`$;&|<>(){}\[\]\\*?~]/.test(token)) throw new Error(`command[${index}] contains shell expansion or metacharacters`);
    return token;
  });
  if (output[0].startsWith('-')) throw new Error('command executable may not start with -');
  return output;
}

function safeRemoteDestination(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\0\r\n\t ]/.test(value)) throw new Error('remoteDestination must be a non-empty path without whitespace or control characters');
  if (/["'!@`$;&|<>(){}\[\]\\*?]/.test(value)) throw new Error('remoteDestination contains shell expansion or metacharacters');
  if (!/^(?:~(?:\/|$)|\/)[A-Za-z0-9._~\/-]*$/.test(value)) throw new Error('remoteDestination must be an absolute remote path or ~/ path using only letters, numbers, dot, underscore, hyphen, slash, and a leading tilde');
  const parts = value.split('/').filter((part) => part !== '' && part !== '~');
  if (parts.some((part) => part === '.' || part === '..')) throw new Error('remoteDestination may not contain . or .. path components');
  return `remote:${value.endsWith('/') ? value : `${value}/`}`;
}

function safeRelativeSelection(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a non-empty relative path`);
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) throw new Error(`${label} must be relative to sourceDirectory`);
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) throw new Error(`${label} may not contain . or .. path components`);
  return parts.join('/');
}

function compileGlob(pattern, index) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 512 || /[\0\r\n]/.test(pattern)) throw new Error(`globs[${index}] is invalid`);
  const normalized = pattern.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').some((part) => part === '..')) throw new Error(`globs[${index}] must stay relative to sourceDirectory`);
  if (/["'!@`$;&|<>(){}\[\]]/.test(normalized)) throw new Error(`globs[${index}] contains unsupported shell-like syntax`);
  let source = '^';
  for (let cursor = 0; cursor < normalized.length; cursor += 1) {
    const character = normalized[cursor];
    if (character === '*') {
      if (normalized[cursor + 1] === '*') {
        while (normalized[cursor + 1] === '*') cursor += 1;
        source += '.*';
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else source += /[\\^$+?.()|{}\[\]]/.test(character) ? `\\${character}` : character;
  }
  source += '$';
  return { pattern: normalized, expression: new RegExp(source, process.platform === 'win32' ? 'iu' : 'u') };
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function roots() {
  const current = isolation.current();
  if (current) return [...current.roots];
  return policy.selectAllowedDirectories(allowedDirectories.length > 0 ? allowedDirectories : [process.cwd()]);
}
async function base() { return isolation.current()?.base ?? (await roots())[0]; }
async function scopedPolicy(selectedRoots, selectedBase) {
  const scoped = new ToolPathPolicy({ serverName: 'codespace-isolation', cwd: selectedBase, allowedDirectories: selectedRoots });
  await scoped.allowed();
  return scoped;
}

async function existingSourceDirectory(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\0\r\n]/.test(value)) throw new Error('sourceDirectory is invalid');
  const selectedRoots = await roots();
  const selectedBase = await base();
  const lexical = resolve(isAbsolute(value) ? value : join(selectedBase, value));
  await policy.assertToolArguments('copy_to_codespace', { sourceDirectory: lexical }, selectedBase);
  const scoped = await scopedPolicy(selectedRoots, selectedBase);
  await scoped.assertToolArguments('copy_to_codespace', { sourceDirectory: lexical }, selectedBase);
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('sourceDirectory must be an existing non-symbolic-link directory');
  const actual = await realpath(lexical);
  if (!selectedRoots.some((root) => within(root, actual))) throw new Error('sourceDirectory resolves outside the signed workspace roots');
  await policy.assertToolArguments('copy_to_codespace', { sourceDirectory: actual }, selectedBase);
  await scoped.assertToolArguments('copy_to_codespace', { sourceDirectory: actual }, selectedBase);
  return { path: actual, roots: selectedRoots, base: selectedBase, scoped };
}

async function validateSelectedPath(source, relativePath, label) {
  const lexical = resolve(source.path, ...relativePath.split('/'));
  if (!within(source.path, lexical)) throw new Error(`${label} escapes sourceDirectory`);
  await policy.assertToolArguments('copy_to_codespace', { [label]: lexical }, source.base);
  await source.scoped.assertToolArguments('copy_to_codespace', { [label]: lexical }, source.base);
  const info = await lstat(lexical);
  if (info.isSymbolicLink()) throw new Error(`${label} may not be a symbolic link`);
  const actual = await realpath(lexical);
  if (!within(source.path, actual)) throw new Error(`${label} resolves outside sourceDirectory`);
  await policy.assertToolArguments('copy_to_codespace', { [label]: actual }, source.base);
  await source.scoped.assertToolArguments('copy_to_codespace', { [label]: actual }, source.base);
  return { relativePath, path: actual, directory: info.isDirectory() };
}

async function enumerateSource(source) {
  const output = [];
  const queue = [{ directory: source.path, relativeDirectory: '' }];
  let scanned = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SCAN_ENTRIES) throw new Error(`glob scan exceeded CODESPACE_MCP_MAX_SCAN_ENTRIES=${MAX_SCAN_ENTRIES}`);
      const relativePath = current.relativeDirectory ? `${current.relativeDirectory}/${entry.name}` : entry.name;
      const path = join(current.directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`copy source contains a symbolic link: ${relativePath}`);
      if (!entry.isFile() && !entry.isDirectory()) throw new Error(`copy source contains an unsupported filesystem entry: ${relativePath}`);
      output.push({ relativePath, path, directory: entry.isDirectory() });
      if (entry.isDirectory()) queue.push({ directory: path, relativeDirectory: relativePath });
    }
  }
  return output;
}

function collapseSelections(selections) {
  const ordered = [...selections].sort((left, right) => left.relativePath.split('/').length - right.relativePath.split('/').length || left.relativePath.localeCompare(right.relativePath));
  const output = [];
  for (const selection of ordered) {
    if (output.some((parent) => parent.directory && (selection.relativePath === parent.relativePath || selection.relativePath.startsWith(`${parent.relativePath}/`)))) continue;
    if (!output.some((existing) => existing.relativePath === selection.relativePath)) output.push(selection);
  }
  return output;
}

async function selectCopySources(source, args) {
  const hasPaths = Array.isArray(args.paths);
  const hasGlobs = Array.isArray(args.globs);
  if (hasPaths === hasGlobs) throw new Error('copy_to_codespace requires exactly one of paths or globs');
  let selections;
  if (hasPaths) {
    if (args.paths.length < 1 || args.paths.length > MAX_CP_SOURCES) throw new Error(`paths must contain from 1 through ${MAX_CP_SOURCES} entries`);
    selections = [];
    for (let index = 0; index < args.paths.length; index += 1) {
      const relativePath = safeRelativeSelection(args.paths[index], `paths[${index}]`);
      selections.push(await validateSelectedPath(source, relativePath, `paths[${index}]`));
    }
  } else {
    if (args.globs.length < 1 || args.globs.length > 50) throw new Error('globs must contain from 1 through 50 entries');
    const globs = args.globs.map(compileGlob);
    const candidates = await enumerateSource(source);
    selections = [];
    for (const candidate of candidates) {
      if (!globs.some((glob) => glob.expression.test(candidate.relativePath))) continue;
      selections.push(await validateSelectedPath(source, candidate.relativePath, `glob match ${candidate.relativePath}`));
    }
    if (selections.length === 0) throw new Error('globs matched no files or directories');
  }
  const collapsed = collapseSelections(selections);
  if (collapsed.length > MAX_CP_SOURCES) throw new Error(`copy selection produced ${collapsed.length} sources; narrow it to at most ${MAX_CP_SOURCES}`);
  const basenames = new Set();
  for (const selection of collapsed) {
    const name = process.platform === 'win32' ? win32.basename(selection.path) : basename(selection.path);
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if (basenames.has(key)) throw new Error(`copy selection has duplicate destination basename: ${name}`);
    basenames.add(key);
  }
  return collapsed;
}

async function transferSizeForSelections(source, selections) {
  const seen = new Set();
  let totalBytes = 0;
  let fileCount = 0;
  let scannedEntries = 0;
  const visit = async (path, relativePath) => {
    scannedEntries += 1;
    if (scannedEntries > MAX_SCAN_ENTRIES) throw new Error(`copy size scan exceeded CODESPACE_MCP_MAX_SCAN_ENTRIES=${MAX_SCAN_ENTRIES}`);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`copy source contains a symbolic link: ${relativePath}`);
    const actual = await realpath(path);
    if (!within(source.path, actual)) throw new Error(`copy source resolves outside sourceDirectory: ${relativePath}`);
    await policy.assertToolArguments('copy_to_codespace', { sourcePath: actual }, source.base);
    await source.scoped.assertToolArguments('copy_to_codespace', { sourcePath: actual }, source.base);
    if (info.isFile()) {
      if (seen.has(actual)) return;
      seen.add(actual);
      fileCount += 1;
      totalBytes += info.size;
      if (totalBytes >= MAX_TRANSFER_BYTES) throw new Error(`copy transfer size ${totalBytes} bytes meets or exceeds CODESPACE_MCP_MAX_TRANSFER_BYTES=${MAX_TRANSFER_BYTES}`);
      return;
    }
    if (!info.isDirectory()) throw new Error(`copy source contains an unsupported filesystem entry: ${relativePath}`);
    const entries = await readdir(actual, { withFileTypes: true });
    for (const entry of entries) await visit(join(actual, entry.name), `${relativePath}/${entry.name}`);
  };
  for (const selection of selections) await visit(selection.path, selection.relativePath);
  return { totalBytes, fileCount };
}

let ghExecutablePromise;
async function ghExecutable() {
  ghExecutablePromise ??= (async () => {
    const info = await lstat(ghExecutableConfigured);
    if (info.isSymbolicLink()) throw new Error('--gh-executable may not be a symbolic link');
    const actual = await realpath(ghExecutableConfigured);
    if (!(await stat(actual)).isFile()) throw new Error('--gh-executable must point to a regular file');
    return actual;
  })();
  const actual = await ghExecutablePromise;
  const selectedRoots = await roots();
  if (selectedRoots.some((root) => within(root, actual))) throw new Error('--gh-executable must be outside writable workspace roots');
  return actual;
}

let tokenPromise;
async function githubToken() {
  if (!tokenFileConfigured) return undefined;
  tokenPromise ??= (async () => {
    const info = await lstat(tokenFileConfigured);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('--token-file must be a non-symbolic-link regular file');
    if (info.size < 1 || info.size > 8192) throw new Error('--token-file must contain from 1 through 8192 bytes');
    const actual = await realpath(tokenFileConfigured);
    const selectedRoots = await roots();
    if (selectedRoots.some((root) => within(root, actual))) throw new Error('--token-file must be outside writable workspace roots');
    const value = (await readFile(actual, 'utf8')).trim();
    if (value.length === 0 || value.length > 4096 || /\s/.test(value) || /[\0\r\n]/.test(value)) throw new Error('--token-file contains an invalid token');
    return value;
  })();
  return tokenPromise;
}

let sshKeyPromise;
async function sshKeyFile() {
  if (!sshKeyFileConfigured) return undefined;
  sshKeyPromise ??= (async () => {
    const info = await lstat(sshKeyFileConfigured);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('--ssh-key-file must be a non-symbolic-link regular file');
    if (info.size < 1 || info.size > 1024 * 1024) throw new Error('--ssh-key-file must contain from 1 byte through 1 MiB');
    const actual = await realpath(sshKeyFileConfigured);
    const selectedRoots = await roots();
    if (selectedRoots.some((root) => within(root, actual))) throw new Error('--ssh-key-file must be outside writable workspace roots');
    return actual;
  })();
  return sshKeyPromise;
}

async function ghEnvironment() {
  const environment = { ...environmentWithoutBundledIsolationKey(), GH_PAGER: '', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', PAGER: '' };
  delete environment.GH_FORCE_TTY;
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  const token = await githubToken();
  if (token) environment.GH_TOKEN = token;
  return environment;
}

function commandDescription(args) { return JSON.stringify(['gh', ...args]); }

async function startGhExecution(args, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, stdinText, keepStdinOpen = false } = {}) {
  const command = await ghExecutable();
  const cwd = await base();
  const environment = await ghEnvironment();
  if (stdinText !== undefined && typeof stdinText !== 'string') throw new Error('stdinText must be a string');
  if (stdinText !== undefined && Buffer.byteLength(stdinText, 'utf8') > MAX_REMOTE_STDIN_BYTES) {
    throw new Error(`remote stdin exceeded ${MAX_REMOTE_STDIN_BYTES} bytes`);
  }
  const child = spawn(command, args, { cwd, env: environment, shell: false, windowsHide: true, stdio: [stdinText === undefined && !keepStdinOpen ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  let totalBytes = 0;
  let state = 'running';
  let exitCode = null;
  let signal = null;
  let failure = null;
  let settled = false;
  let timer;
  let resolveCompletion;
  const completion = new Promise((resolvePromise) => { resolveCompletion = resolvePromise; });

  const snapshot = () => ({
    command: ['gh', ...args],
    state,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    outputBytes: totalBytes,
    exitCode,
    signal,
    error: failure
  });

  const finish = (nextState, { code = exitCode, childSignal = signal, error = failure } = {}) => {
    if (settled) return;
    settled = true;
    state = nextState;
    exitCode = code;
    signal = childSignal;
    failure = error;
    if (timer) clearTimeout(timer);
    resolveCompletion(snapshot());
  };

  timer = setTimeout(() => {
    failure = `${commandDescription(args)} timed out after ${timeoutMs}ms`;
    child.kill();
    finish('timed_out', { error: failure });
  }, timeoutMs);
  timer.unref?.();

  const collect = (target) => (chunk) => {
    if (settled) return;
    totalBytes += chunk.length;
    if (totalBytes > MAX_OUTPUT_BYTES) {
      failure = `gh output exceeded CODESPACE_MCP_MAX_OUTPUT_BYTES=${MAX_OUTPUT_BYTES} for ${commandDescription(args)}`;
      child.kill();
      finish('failed', { error: failure });
      return;
    }
    target.push(chunk);
  };
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  if (stdinText !== undefined && child.stdin) {
    child.stdin.on('error', () => {});
    if (keepStdinOpen) child.stdin.write(stdinText, 'utf8');
    else child.stdin.end(stdinText, 'utf8');
  } else if (keepStdinOpen && child.stdin) {
    child.stdin.on('error', () => {});
  }
  child.once('error', (error) => finish('failed', { error: `Unable to start gh for ${commandDescription(args)}: ${error.message}` }));
  child.once('close', (code, childSignal) => {
    if (settled) return;
    const out = Buffer.concat(stdout).toString('utf8');
    const err = Buffer.concat(stderr).toString('utf8');
    if (code !== 0) {
      const detail = err.trim() || out.trim() || `gh exited with code ${code}${childSignal ? ` after signal ${childSignal}` : ''}`;
      finish('failed', { code, childSignal, error: `${commandDescription(args)} failed: ${detail}` });
      return;
    }
    finish('completed', { code, childSignal, error: null });
  });

  const cancel = () => {
    if (settled) return false;
    const killed = child.kill();
    finish('cancelled', { error: `${commandDescription(args)} was cancelled` });
    return killed;
  };

  const writeStdin = (data, end = false) => new Promise((resolvePromise, rejectPromise) => {
    if (settled || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      rejectPromise(new Error('async SSH stdin is not writable'));
      return;
    }
    const finishWrite = (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    if (end) child.stdin.end(data, 'utf8', finishWrite);
    else child.stdin.write(data, 'utf8', finishWrite);
  });

  return { child, completion, snapshot, cancel, writeStdin };
}

export async function runGh(args, options = {}) {
  const execution = await startGhExecution(args, options);
  const result = await execution.completion;
  if (result.state !== 'completed') throw new Error(result.error ?? `${commandDescription(args)} did not complete successfully`);
  return { command: result.command, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

function parseJsonOutput(execution, label) {
  try { return JSON.parse(execution.stdout || 'null'); }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${error.message}`); }
}

async function sshGhArgs(codespace, remoteCommand) {
  const key = await sshKeyFile();
  return [
    'codespace', 'ssh', '-c', codespace,
    ...(key ? ['--', '-i', key] : []),
    remoteCommand
  ];
}

const REMOTE_REALPATH_COMMAND = "bash -c 'IFS= read -r encoded || exit 2; path=$(printf %s \"$encoded\" | base64 -d) || exit 2; test -d \"$path\" || exit 3; realpath -- \"$path\"'";
const REMOTE_GIT_ROOT_COMMAND = "bash -c 'IFS= read -r encoded || exit 2; path=$(printf %s \"$encoded\" | base64 -d) || exit 2; exec git -C \"$path\" rev-parse --show-toplevel'";
const REMOTE_RG_SEARCH_COMMAND = "bash -c 'set -u; read_b64(){ IFS= read -r line || return 1; printf %s \"$line\" | base64 -d; }; search_base=$(read_b64) || exit 2; query=$(read_b64) || exit 2; IFS= read -r fixed || exit 2; IFS= read -r sensitive || exit 2; IFS= read -r result_cap || exit 2; IFS= read -r glob_count || exit 2; args=(--json --color=never --hidden --max-filesize " + REMOTE_MAX_TEXT_BYTES + " --glob \"!.git\" --glob \"!.git/**\"); if [ \"$fixed\" = 1 ]; then args+=(-F); fi; if [ \"$sensitive\" = 0 ]; then args+=(-i); fi; for ((i=0; i<glob_count; i++)); do glob=$(read_b64) || exit 2; args+=(--glob \"$glob\"); done; rg \"${args[@]}\" -- \"$query\" \"$search_base\" | awk -v max=\"$result_cap\" \"{ print; if (index(\\$0, \\\"\\\\\\\"type\\\\\\\":\\\\\\\"match\\\\\\\"\\\") > 0) { count++; if (count >= max) exit 0 } }\"; statuses=(\"${PIPESTATUS[@]}\"); rg_rc=\"${statuses[0]}\"; awk_rc=\"${statuses[1]}\"; if [ \"$awk_rc\" != 0 ]; then exit \"$awk_rc\"; fi; if [ \"$rg_rc\" = 0 ] || [ \"$rg_rc\" = 1 ] || [ \"$rg_rc\" = 141 ]; then exit 0; fi; exit \"$rg_rc\"'";

async function runFixedRemote(codespace, execute, remoteCommand, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, stdinText } = {}) {
  return execute(await sshGhArgs(codespace, remoteCommand), { timeoutMs, stdinText });
}

async function canonicalRemoteWorkspacePath(codespace, value, execute, timeoutMs) {
  const requested = safeRemoteWorkspacePath(value, 'path');
  const execution = await runFixedRemote(codespace, execute, REMOTE_REALPATH_COMMAND, {
    timeoutMs,
    stdinText: `${base64Line(requested)}\n`
  });
  const actual = execution.stdout.trim();
  return safeRemoteWorkspacePath(actual, 'resolved remote path');
}

async function ripgrepVersion(codespace, execute, timeoutMs = 30_000) {
  const execution = await runFixedRemote(codespace, execute, 'rg --version', { timeoutMs });
  const firstLine = execution.stdout.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!/^ripgrep\s+\d/i.test(firstLine)) throw new Error(`Unexpected rg --version output: ${firstLine || '(empty)'}`);
  return { version: firstLine, stdout: execution.stdout };
}

function parseRipgrepJson(stdout, maxResults) {
  const matches = [];
  let totalMatches = 0;
  let redacted = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { continue; }
    if (event?.type !== 'match') continue;
    totalMatches += 1;
    if (matches.length >= maxResults) continue;
    let text = String(event.data?.lines?.text ?? '').replace(/\r?\n$/, '');
    for (const pattern of CREDENTIAL_PATTERNS) {
      const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
      text = text.replace(global, () => {
        redacted = true;
        return '[REDACTED_CREDENTIAL]';
      });
    }
    const firstSubmatch = Array.isArray(event.data?.submatches) ? event.data.submatches[0] : undefined;
    matches.push({
      path: event.data?.path?.text ?? '',
      line: event.data?.line_number ?? null,
      column: (firstSubmatch?.start ?? 0) + 1,
      text
    });
  }
  return { matches, count: matches.length, totalMatches, truncated: totalMatches > matches.length, redacted };
}

async function ensureCodespaceAvailable(codespace, execute, timeoutMs) {
  let confirmed = false;
  try {
    const viewed = await execute(['codespace', 'view', '-c', codespace, '--json', 'state', '--jq', '.state'], { timeoutMs });
    confirmed = viewed.stdout.trim().toLowerCase() === 'available';
  } catch { confirmed = false; }
  if (confirmed) return { woke: false };
  await execute(await sshGhArgs(codespace, 'true'), { timeoutMs });
  return { woke: true };
}

async function probeCodespaceSshReady(codespace, execute, timeoutMs) {
  const startup = await execute(await sshGhArgs(codespace, 'echo started'), { timeoutMs });
  const startupConfirmed = startup.stdout.split(/\r?\n/).some((line) => line.trim() === 'started');
  if (!startupConfirmed) throw new Error('Codespace SSH readiness probe completed without the expected "started" marker');
  return {
    startupStdout: startup.stdout,
    startupStderr: startup.stderr
  };
}

async function portsForCodespace(codespace, execute, timeoutMs = 30_000) {
  const execution = await execute(['codespace', 'ports', '-c', codespace, '--json', 'browseUrl,label,sourcePort,visibility'], { timeoutMs });
  const ports = parseJsonOutput(execution, 'gh codespace ports');
  if (!Array.isArray(ports)) throw new Error('gh codespace ports did not return an array');
  return ports;
}

function selectedForwardedPort(ports, port) {
  return ports.find((entry) => Number(entry?.sourcePort) === port) ?? null;
}

function isolationScopeKey() {
  const context = isolation.current();
  if (!context) return 'direct';
  return context.isolatedId ?? JSON.stringify({ base: context.base, roots: context.roots });
}

function createAsyncJobManager(startExecution, assertOwnership = () => {}) {
  const jobs = new Map();

  const prune = () => {
    if (jobs.size < MAX_RETAINED_ASYNC_JOBS) return;
    for (const [asyncId, job] of jobs) {
      if (job.status !== 'running') jobs.delete(asyncId);
      if (jobs.size < MAX_RETAINED_ASYNC_JOBS) break;
    }
  };

  const requireJob = (value) => {
    const asyncId = safeAsyncId(value);
    const job = jobs.get(asyncId);
    if (!job) throw new Error('Unknown or expired asyncId');
    if (job.scopeKey !== isolationScopeKey()) throw new Error('asyncId belongs to a different isolated workspace context');
    assertOwnership(job.scopeKey, job.codespaceId);
    return job;
  };

  const refresh = (job) => {
    const processState = job.execution.snapshot();
    if (processState.state !== 'running') {
      job.status = processState.state;
      job.finishedAt ??= new Date().toISOString();
    }
    return processState;
  };

  const summary = (job) => {
    const processState = refresh(job);
    return {
      asyncId: job.asyncId,
      codespaceId: job.codespaceId,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      timeoutMs: job.timeoutMs,
      exitCode: processState.exitCode,
      signal: processState.signal,
      error: processState.error
    };
  };

  const logs = (job) => {
    const processState = refresh(job);
    return {
      ...summary(job),
      stdout: processState.stdout,
      stderr: processState.stderr,
      outputBytes: processState.outputBytes
    };
  };

  return {
    async start({ codespaceId, args, timeoutMs }) {
      prune();
      const active = [...jobs.values()].filter((job) => refresh(job).state === 'running').length;
      if (active >= MAX_ACTIVE_ASYNC_JOBS) throw new Error(`Too many active async SSH jobs; maximum is ${MAX_ACTIVE_ASYNC_JOBS}`);
      const execution = await startExecution(args, { timeoutMs, keepStdinOpen: true });
      const asyncId = randomUUID().toLowerCase();
      const job = {
        asyncId,
        codespaceId,
        timeoutMs,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        status: 'running',
        stdinBytes: 0,
        stdinEnded: false,
        scopeKey: isolationScopeKey(),
        execution
      };
      jobs.set(asyncId, job);
      void execution.completion.then(() => { refresh(job); });
      return summary(job);
    },
    status(asyncId) {
      return summary(requireJob(asyncId));
    },
    logs(asyncId) {
      return logs(requireJob(asyncId));
    },
    async writeStdin(asyncId, data = '', end = false) {
      const job = requireJob(asyncId);
      if (refresh(job).state !== 'running') throw new Error('async SSH job is not running');
      if (job.stdinEnded) throw new Error('async SSH stdin is already closed');
      if (typeof data !== 'string') throw new Error('data must be a UTF-8 string');
      if (typeof end !== 'boolean') throw new Error('end must be boolean');
      const bytes = Buffer.byteLength(data, 'utf8');
      if (bytes > MAX_ASYNC_STDIN_WRITE_BYTES) throw new Error(`stdin write exceeds ${MAX_ASYNC_STDIN_WRITE_BYTES} bytes`);
      if (job.stdinBytes + bytes > MAX_ASYNC_STDIN_TOTAL_BYTES) throw new Error(`async SSH stdin exceeds cumulative limit ${MAX_ASYNC_STDIN_TOTAL_BYTES} bytes`);
      await job.execution.writeStdin(data, end);
      job.stdinBytes += bytes;
      if (end) job.stdinEnded = true;
      return { ...summary(job), bytesWritten: bytes, stdinBytes: job.stdinBytes, stdinEnded: job.stdinEnded };
    },
    cancel(asyncId) {
      const job = requireJob(asyncId);
      const before = refresh(job);
      if (before.state !== 'running') return { ...summary(job), cancelled: false };
      const signalSent = job.execution.cancel();
      refresh(job);
      return { ...summary(job), cancelled: true, signalSent };
    },
    cancelScopeCodespace(scopeKey, codespaceId) {
      let cancelled = 0;
      for (const job of jobs.values()) {
        if (job.scopeKey !== scopeKey || job.codespaceId !== codespaceId) continue;
        if (refresh(job).state !== 'running') continue;
        job.execution.cancel();
        refresh(job);
        cancelled += 1;
      }
      return cancelled;
    },
    async wait(asyncId, waitTimeoutMs) {
      const job = requireJob(asyncId);
      if (refresh(job).state === 'running') {
        let timer;
        await Promise.race([
          job.execution.completion,
          new Promise((resolvePromise) => {
            timer = setTimeout(resolvePromise, waitTimeoutMs);
          })
        ]);
        if (timer) clearTimeout(timer);
      }
      return summary(job);
    }
  };
}

export function createServer(options = {}) {
  const rawExecute = options.execute ?? runGh;
  const sshReadyScopes = new Set();
  const readinessKey = (codespace) => `${isolationScopeKey()}\0${codespace}`;
  const execute = async (args, executeOptions = {}) => {
    const execution = await rawExecute(args, executeOptions);
    if (args[0] === 'codespace' && args[1] === 'ssh') {
      const codespaceIndex = args.indexOf('-c');
      if (codespaceIndex >= 0 && typeof args[codespaceIndex + 1] === 'string') {
        sshReadyScopes.add(readinessKey(args[codespaceIndex + 1]));
      }
    }
    return execution;
  };
  const codespaceOwners = new Map();
  const revokedCodespaceScopes = new Set();
  const ownershipKey = (scopeKey, codespace) => `${scopeKey}\0${codespace}`;

  const ownershipConflictError = (codespace, owner) => new Error(`Codespace ${codespace} is now owned by isolated session ${owner ?? 'unknown'}. This older isolated session was revoked after another AI/session acquired the Codespace and must not take it back automatically. Call isolated__list, compare each session purpose and the codespace prefix lastOperationAt timestamp, then ask the user which AI/session should control this Codespace before doing anything else.`);

  const assertCodespaceOwnership = (scopeKey, codespace) => {
    const owner = codespaceOwners.get(codespace);
    if (owner !== undefined && owner !== scopeKey) throw ownershipConflictError(codespace, owner);
  };

  const asyncJobs = createAsyncJobManager(options.startAsyncExecution ?? startGhExecution, assertCodespaceOwnership);

  const claimCodespace = (codespace) => {
    const scopeKey = isolationScopeKey();
    const revokedKey = ownershipKey(scopeKey, codespace);
    const owner = codespaceOwners.get(codespace);
    if (owner === scopeKey) return { scopeKey, ownerChanged: false };
    if (revokedCodespaceScopes.has(revokedKey)) {
      throw ownershipConflictError(codespace, owner);
    }
    if (owner !== undefined) {
      revokedCodespaceScopes.add(ownershipKey(owner, codespace));
      sshReadyScopes.delete(`${owner}\0${codespace}`);
      asyncJobs.cancelScopeCodespace(owner, codespace);
    }
    codespaceOwners.set(codespace, scopeKey);
    return { scopeKey, ownerChanged: owner !== undefined };
  };
  let initialized = false;

  const callTool = async (name, args) => {
    if (typeof args.codespaceId === 'string') claimCodespace(safeCodespaceId(args.codespaceId));
    switch (name) {
      case 'list_codespaces': {
        const execution = await execute(['codespace', 'list', '--limit', safeLimit(args.limit), '--json', 'name,displayName,state,repository,lastUsedAt'], { timeoutMs: 30_000 });
        return { codespaces: parseJsonOutput(execution, 'gh codespace list') };
      }
      case 'view_codespace': {
        const codespace = safeCodespaceId(args.codespaceId);
        const execution = await execute(['codespace', 'view', '-c', codespace, '--json', 'name,displayName,state,repository,machineName,lastUsedAt,location'], { timeoutMs: 30_000 });
        return { codespace: parseJsonOutput(execution, 'gh codespace view') };
      }
      case 'roots': {
        const codespace = safeCodespaceId(args.codespaceId);
        const execution = await runFixedRemote(codespace, execute, 'find /workspaces -mindepth 1 -maxdepth 1 -type d -print0', { timeoutMs: 30_000 });
        const roots = execution.stdout.split('\0').filter(Boolean).map((entry) => safeRemoteWorkspacePath(entry, 'workspace root')).sort();
        return { codespaceId: codespace, roots };
      }
      case 'git_root': {
        const codespace = safeCodespaceId(args.codespaceId);
        const timeoutMs = timeout(args.timeoutMs, 30_000);
        const requested = safeRemoteWorkspacePath(args.path, 'path');
        const canonical = await canonicalRemoteWorkspacePath(codespace, requested, execute, timeoutMs);
        const execution = await runFixedRemote(codespace, execute, REMOTE_GIT_ROOT_COMMAND, {
          timeoutMs,
          stdinText: `${base64Line(canonical)}\n`
        });
        const gitRoot = safeRemoteWorkspacePath(execution.stdout.trim(), 'git root');
        return { codespaceId: codespace, requestedPath: requested, canonicalPath: canonical, gitRoot };
      }
      case 'ripgrep_version': {
        const codespace = safeCodespaceId(args.codespaceId);
        const version = await ripgrepVersion(codespace, execute, 30_000);
        return { codespaceId: codespace, version: version.version };
      }
      case 'install_ripgrep': {
        const codespace = safeCodespaceId(args.codespaceId);
        const timeoutMs = timeout(args.timeoutMs);
        try {
          const version = await ripgrepVersion(codespace, execute, Math.min(timeoutMs, 30_000));
          return { codespaceId: codespace, installed: false, version: version.version };
        } catch {
          await runFixedRemote(codespace, execute, "bash -c 'if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get update && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ripgrep; elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y ripgrep; elif command -v yum >/dev/null 2>&1; then sudo -n yum install -y ripgrep; elif command -v apk >/dev/null 2>&1; then sudo -n apk add ripgrep; else echo no-supported-package-manager >&2; exit 127; fi'", { timeoutMs });
          const version = await ripgrepVersion(codespace, execute, Math.min(timeoutMs, 30_000));
          return { codespaceId: codespace, installed: true, version: version.version };
        }
      }
      case 'search_text': {
        const codespace = safeCodespaceId(args.codespaceId);
        const timeoutMs = timeout(args.timeoutMs);
        if (typeof args.query !== 'string' || args.query.length === 0 || args.query.length > 4096 || args.query.includes('\0')) throw new Error('query must be a non-empty string up to 4096 characters without NUL');
        if (args.fixedStrings !== undefined && typeof args.fixedStrings !== 'boolean') throw new Error('fixedStrings must be boolean');
        if (args.caseSensitive !== undefined && typeof args.caseSensitive !== 'boolean') throw new Error('caseSensitive must be boolean');
        const globs = args.globs ?? [];
        if (!Array.isArray(globs) || globs.length > 20) throw new Error('globs must be an array with at most 20 entries');
        const validatedGlobs = globs.map(safeRemoteGlob);
        const maxResults = boundedSearchLimit(args.maxResults ?? 100);
        const requestedBase = safeRemoteWorkspacePath(args.searchBase, 'searchBase');
        const searchBase = await canonicalRemoteWorkspacePath(codespace, requestedBase, execute, timeoutMs);
        try {
          await ripgrepVersion(codespace, execute, Math.min(timeoutMs, 30_000));
        } catch {
          throw new Error('ripgrep is not installed in this Codespace; call install_ripgrep first');
        }
        const payload = [
          base64Line(searchBase),
          base64Line(args.query),
          args.fixedStrings === true ? '1' : '0',
          args.caseSensitive === false ? '0' : '1',
          String(maxResults + 1),
          String(validatedGlobs.length),
          ...validatedGlobs.map(base64Line)
        ].join('\n') + '\n';
        const execution = await runFixedRemote(codespace, execute, REMOTE_RG_SEARCH_COMMAND, { timeoutMs, stdinText: payload });
        const parsed = parseRipgrepJson(execution.stdout, maxResults);
        return { codespaceId: codespace, searchBase, query: args.query, ...parsed };
      }
      case 'ssh': {
        const codespace = safeCodespaceId(args.codespaceId);
        const command = safeRemoteCommandTokens(args.command);
        const remoteCommand = command.join(' ');
        if (args.async !== undefined && typeof args.async !== 'boolean') throw new Error('async must be boolean');
        const timeoutMs = sshTimeout(args.timeoutMs);
        const ghArgs = await sshGhArgs(codespace, remoteCommand);
        if (args.async === true) {
          const job = await asyncJobs.start({ codespaceId: codespace, args: ghArgs, timeoutMs });
          return { ...job, async: true };
        }
        const execution = await execute(ghArgs, { timeoutMs });
        return { codespaceId: codespace, remoteCommand, stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.exitCode };
      }
      case 'get_async_status': return asyncJobs.status(args.asyncId);
      case 'get_async_logs': return asyncJobs.logs(args.asyncId);
      case 'write_async_stdin': return asyncJobs.writeStdin(args.asyncId, args.data ?? '', args.end ?? false);
      case 'wait_async': return asyncJobs.wait(args.asyncId, asyncWaitTimeout(args.waitTimeoutMs));
      case 'cancel_async': return asyncJobs.cancel(args.asyncId);
      case 'copy_to_codespace': {
        const codespace = safeCodespaceId(args.codespaceId);
        const remoteDestination = safeRemoteDestination(args.remoteDestination);
        const source = await existingSourceDirectory(args.sourceDirectory);
        const selections = await selectCopySources(source, args);
        const size = await transferSizeForSelections(source, selections);
        const timeoutMs = timeout(args.timeoutMs);
        const key = readinessKey(codespace);
        const wasReady = sshReadyScopes.has(key);
        let readiness = { startupStdout: '', startupStderr: '', reused: wasReady };
        if (!wasReady) {
          try {
            readiness = { ...(await probeCodespaceSshReady(codespace, execute, timeoutMs)), reused: false };
          } catch (error) {
            sshReadyScopes.delete(key);
            throw error;
          }
        }
        const command = ['codespace', 'cp', '-e'];
        if (selections.some((selection) => selection.directory)) command.push('-r');
        command.push('-c', codespace);
        const sshKey = await sshKeyFile();
        if (sshKey) command.push('--', '-i', sshKey);
        command.push(...selections.map((selection) => selection.path), remoteDestination);
        let execution;
        let retriedAfterReadinessRefresh = false;
        try {
          execution = await execute(command, { timeoutMs });
        } catch (error) {
          if (!wasReady) throw error;
          sshReadyScopes.delete(key);
          readiness = { ...(await probeCodespaceSshReady(codespace, execute, timeoutMs)), reused: false };
          retriedAfterReadinessRefresh = true;
          execution = await execute(command, { timeoutMs });
        }
        return { codespaceId: codespace, sshReady: true, reusedSshReadiness: readiness.reused, retriedAfterReadinessRefresh, startupStdout: readiness.startupStdout, startupStderr: readiness.startupStderr, sourceDirectory: source.path, selected: selections.map((selection) => selection.relativePath), remoteDestination: remoteDestination.slice('remote:'.length), totalBytes: size.totalBytes, fileCount: size.fileCount, stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.exitCode };
      }
      case 'stop_codespace': {
        const codespace = safeCodespaceId(args.codespaceId);
        const timeoutMs = timeout(args.timeoutMs);
        const scopeKey = isolationScopeKey();
        const cancelledAsyncJobs = asyncJobs.cancelScopeCodespace(scopeKey, codespace);
        sshReadyScopes.delete(readinessKey(codespace));
        const execution = await execute(['codespace', 'stop', '-c', codespace], { timeoutMs });
        let state = null;
        let stateCheckError = null;
        try {
          const viewed = await execute(['codespace', 'view', '-c', codespace, '--json', 'state', '--jq', '.state'], { timeoutMs: Math.min(timeoutMs, 30_000) });
          state = viewed.stdout.trim() || null;
        } catch (error) {
          stateCheckError = error instanceof Error ? error.message : String(error);
        }
        return { codespaceId: codespace, stopRequested: true, stopped: String(state ?? '').toLowerCase() === 'shutdown', state, stateCheckError, cancelledAsyncJobs, stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.exitCode };
      }
      case 'list_ports': {
        const codespace = safeCodespaceId(args.codespaceId);
        return { codespaceId: codespace, ports: await portsForCodespace(codespace, execute) };
      }
      case 'open_port': {
        const codespace = safeCodespaceId(args.codespaceId);
        const port = safePort(args.port, 'port');
        const timeoutMs = timeout(args.timeoutMs);
        const availability = await ensureCodespaceAvailable(codespace, execute, timeoutMs);
        const before = selectedForwardedPort(await portsForCodespace(codespace, execute, timeoutMs), port);
        if (!before) throw new Error(`Codespace port ${port} is not currently forwarded on GitHub infrastructure; start the remote service or configure Codespaces forwardPorts first`);
        await execute(['codespace', 'ports', 'visibility', `${port}:public`, '-c', codespace], { timeoutMs });
        const after = selectedForwardedPort(await portsForCodespace(codespace, execute, timeoutMs), port);
        if (!after) throw new Error(`Codespace port ${port} disappeared after setting visibility`);
        if (String(after.visibility).toLowerCase() !== 'public') throw new Error(`Codespace port ${port} did not become public; current visibility is ${after.visibility ?? 'unknown'}`);
        if (typeof after.browseUrl !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+\.app\.github\.dev\/?$/i.test(after.browseUrl)) throw new Error(`Codespace port ${port} did not return a valid GitHub browseUrl`);
        return { codespaceId: codespace, port, wokeCodespace: availability.woke, url: after.browseUrl, browseUrl: after.browseUrl, visibility: after.visibility, label: after.label ?? '' };
      }
      case 'close_port': {
        const codespace = safeCodespaceId(args.codespaceId);
        const port = safePort(args.port, 'port');
        const timeoutMs = timeout(args.timeoutMs);
        await execute(['codespace', 'ports', 'visibility', `${port}:private`, '-c', codespace], { timeoutMs });
        const after = selectedForwardedPort(await portsForCodespace(codespace, execute, timeoutMs), port);
        if (!after) return { codespaceId: codespace, port, visibility: 'private', closedPublicAccess: true, browseUrl: null };
        if (String(after.visibility).toLowerCase() !== 'private') throw new Error(`Codespace port ${port} did not become private; current visibility is ${after.visibility ?? 'unknown'}`);
        return { codespaceId: codespace, port, visibility: after.visibility, closedPublicAccess: true, browseUrl: after.browseUrl ?? null };
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  };

  const handle = async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return protocolError(request?.id, -32600, 'Invalid Request');
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'initialize') {
      initialized = true;
      return response(request.id, { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'codespace', version: SERVER_VERSION }, instructions: 'Controls existing GitHub Codespaces only. There is intentionally no create/start/delete/rebuild/edit tool. Existing Codespaces can be started implicitly by SSH/copy and explicitly stopped with stop_codespace. Use list_codespaces first and pass its name as codespaceId. SSH accepts only strictly validated token arrays and is hard-capped at 10 minutes; use async=true for potentially blocking commands, then get_async_logs/get_async_status/wait_async/cancel_async with the returned asyncId. search_text always requires a /workspaces/<workspace> searchBase. Copy uses local path selection plus one safe remote destination. Port tools operate on GitHub-hosted forwarded ports and return browseUrl; they never create localhost tunnels.' });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        const result = await isolation.run(request.params?.arguments ?? {}, (toolArguments) => callTool(request.params?.name, toolArguments));
        return response(request.id, toolResult({ ok: true, result }));
      } catch (error) { return response(request.id, toolResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true)); }
    }
    return protocolError(request.id, -32601, 'Method not found');
  };
  return handle;
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
  if (help) process.stdout.write(CODESPACE_MCP_HELP);
  else await startStdio();
}
