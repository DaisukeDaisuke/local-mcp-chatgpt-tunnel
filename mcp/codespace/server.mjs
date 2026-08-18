import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { ToolPathPolicy } from '../../app/path-policy.mjs';

const SERVER_VERSION = '0.1.0';
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_ASYNC_RUNTIME_MS = 60 * 60 * 1000;
const MAX_ASYNC_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_SYNC_WAIT_MS = 10_000;
const MAX_SYNC_WAIT_MS = 10_000;
const IMMEDIATE_ASYNC_SYNC_WAIT_MS = 1_000;
const MAX_ACTIVE_ASYNC_JOBS = 16;
const MAX_RETAINED_ASYNC_JOBS = 64;
const MAX_OUTPUT_BYTES = boundedIntegerEnvironment('CODESPACE_MCP_MAX_OUTPUT_BYTES', 100 * 1024, 1024, 128 * 1024 * 1024);
const MAX_TRANSFER_BYTES = boundedIntegerEnvironment('CODESPACE_MCP_MAX_TRANSFER_BYTES', 500_000_000, 1, 500_000_000);
const MAX_SCAN_ENTRIES = boundedIntegerEnvironment('CODESPACE_MCP_MAX_SCAN_ENTRIES', 20_000, 1, 1_000_000);
const MAX_CP_SOURCES = 200;
const MAX_REMOTE_SEARCH_RESULTS = 500;
const MAX_REMOTE_STDIN_BYTES = 1024 * 1024;
const MAX_ASYNC_STDIN_WRITE_BYTES = 64 * 1024;
const MAX_ASYNC_STDIN_TOTAL_BYTES = 1024 * 1024;
const REMOTE_MAX_TEXT_BYTES = 16 * 1024 * 1024;
const FORWARD_REGISTRATION_POLL_MS = 100;

function formatOutputBytes(bytes) {
  const kibibyte = 1024;
  const mebibyte = kibibyte * 1024;
  const gibibyte = mebibyte * 1024;
  if (bytes < kibibyte) return `${bytes}B`;
  if (bytes >= gibibyte) return `${Math.ceil((bytes / gibibyte) * 10) / 10}GB`;
  if (bytes >= mebibyte) return `${Math.ceil((bytes / mebibyte) * 10) / 10}MB`;
  return `${Math.ceil(bytes / kibibyte)}KB`;
}

const REMOTE_BASH_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { constants, tmpdir } = require("node:os");
const { join } = require("node:path");

const chunks = [];
let child = null;
let runtimeDirectory = null;
let requestedSignal = null;
let settled = false;

function signalNumber(signal) {
  return constants.signals[signal] || 1;
}

function cleanup() {
  if (!runtimeDirectory) return;
  try { rmSync(runtimeDirectory, { recursive: true, force: true }); } catch {}
  runtimeDirectory = null;
}

function killGroup(signal) {
  if (!child || !child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    throw error;
  }
}

function terminateGroup() {
  try { killGroup("SIGTERM"); } catch {}
  const timer = setTimeout(() => {
    try { killGroup("SIGKILL"); } catch {}
  }, 250);
  if (timer.unref) timer.unref();
}

function requestShutdown(signal) {
  if (!requestedSignal) requestedSignal = signal;
  terminateGroup();
  if (!child && !settled) {
    settled = true;
    cleanup();
    process.exit(128 + signalNumber(signal));
  }
}

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => requestShutdown(signal));
}

process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.on("error", (error) => {
  if (settled) return;
  settled = true;
  console.error("codespace run_bash_script stdin failed: " + error.message);
  cleanup();
  process.exit(74);
});
process.stdin.on("end", () => {
  if (settled) return;
  if (requestedSignal) {
    settled = true;
    cleanup();
    process.exit(128 + signalNumber(requestedSignal));
  }
  runtimeDirectory = mkdtempSync(join(tmpdir(), "codespace-mcp-bash-"));
  const scriptPath = join(runtimeDirectory, "script.sh");
  writeFileSync(scriptPath, Buffer.concat(chunks), { mode: 0o700 });
  child = spawn("/bin/bash", [scriptPath], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"]
  });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    console.error("codespace run_bash_script could not start /bin/bash: " + error.message);
    cleanup();
    process.exit(127);
  });
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    try { killGroup("SIGKILL"); } catch {}
    cleanup();
    if (requestedSignal) process.exit(128 + signalNumber(requestedSignal));
    if (signal) process.exit(128 + signalNumber(signal));
    process.exit(Number.isInteger(code) ? code : 1);
  });
});
process.stdin.resume();
`;
new Function(REMOTE_BASH_SUPERVISOR_SOURCE);
const REMOTE_BASH_SUPERVISOR_COMMAND = `node -e "eval(Buffer.from('${Buffer.from(REMOTE_BASH_SUPERVISOR_SOURCE, 'utf8').toString('base64')}','base64').toString('utf8'))"`;
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
  if (argument.startsWith('--gh-executable=') || argument.startsWith('--token-file=')) continue;
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
const sshRuntimeDirectoryConfigured = optionalAbsoluteFileArgument(
  process.env.LOCAL_MCP_CODESPACE_SSH_RUNTIME_DIRECTORY,
  'LOCAL_MCP_CODESPACE_SSH_RUNTIME_DIRECTORY'
);
const sshKeygenExecutableConfigured = optionalAbsoluteFileArgument(
  process.env.LOCAL_MCP_CODESPACE_SSH_KEYGEN_EXECUTABLE,
  'LOCAL_MCP_CODESPACE_SSH_KEYGEN_EXECUTABLE'
);

export const CODESPACE_MCP_HELP = `codespace MCP\n\nUsage:\n  node mcp/codespace/server.mjs --gh-executable=<absolute-gh.exe-path> [--token-file=<absolute-token-file>]\n\nControls existing GitHub Codespaces only. SSH authentication keys are generated internally for the MCP process; no user SSH key is accepted. It can list/view/stop existing codespaces, run strictly tokenized SSH commands, run arbitrary Bash source supplied only over SSH stdin, copy selected local files/directories to an explicitly remote: destination while preserving their relative paths, copy one explicitly remote: file/directory back into a local signed workspace directory, and open/close temporary public deployments backed by GitHub Codespaces. Copy never infers or inserts the remote: protocol: exactly one transfer side must be explicitly remote: and the other side must be local. Prefer codespace__run_bash_script for arbitrary code, multi-command shell logic, pipelines, redirection, quoting-heavy commands, or other shell-oriented work instead of assembling those operations through the older SSH/stdin tools. codespace__run_bash_script is always asynchronous. Other execution tools expose async and syncWaitMs separately: async=true returns an asyncId immediately and ignores syncWaitMs; otherwise syncWaitMs controls only how long the MCP response waits synchronously, defaults to 10000 ms, and never shortens the underlying timeoutMs. If the operation is still running when syncWaitMs expires, it continues in the shared async registry and an asyncId is returned. syncWaitMs values from 0 through 1000 ms are treated as immediate async mode. Call codespace__get_async_status with no asyncId to see all retained async operations in the current isolation, or with one asyncId to retrieve the complete retained output/result for that operation. get_async_logs remains available as a compatibility alias for process logs. The registry is process-local, so serverInstanceId changes after an MCP crash/restart and older asyncIds are not recoverable. Temporary public deployment tools never scan localhost, inspect local listening sockets, browser tabs, or local development servers, and never auto-detect or guess a port. When an exact caller-specified port is not yet present in GitHub Codespaces metadata, open_temporary_public_deployment may bootstrap that exact port with gh codespace ports forward <port>:<port>, wait for GitHub to register it, then make it public. The bootstrap forwarding process is kept alive while this MCP owns the temporary deployment and is cancelled when the deployment is closed, the Codespace is stopped, or ownership moves to another isolated session. It never creates, rebuilds, deletes, or changes the machine type of a codespace.\n`;

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
const commonTimeout = { type: 'integer', minimum: 1, maximum: MAX_COMMAND_TIMEOUT_MS, default: DEFAULT_COMMAND_TIMEOUT_MS, description: 'Hard runtime deadline for the underlying operation. This is separate from syncWaitMs, which controls only how long the MCP call waits synchronously before returning an asyncId.' };
const commonSshTimeout = { type: 'integer', minimum: 1, maximum: MAX_ASYNC_RUNTIME_MS, default: DEFAULT_COMMAND_TIMEOUT_MS, description: 'Hard runtime deadline for the underlying remote process, up to 1 hour. This is separate from syncWaitMs, which controls only synchronous response waiting.' };
const commonAsyncId = { type: 'string', minLength: 36, maxLength: 36, pattern: '^[0-9a-fA-F-]{36}$' };
const commonAsync = { type: 'boolean', default: false, description: 'Set true to return an asyncId immediately. When async=true, syncWaitMs is ignored. When omitted or false, the MCP waits synchronously for up to syncWaitMs before returning an asyncId without cancelling the underlying operation.' };
const commonSyncWait = { type: 'integer', minimum: 0, maximum: MAX_SYNC_WAIT_MS, default: DEFAULT_SYNC_WAIT_MS, description: 'How long this MCP call may wait synchronously for a result. Default and maximum are 10000 ms. If the operation is still running after this time, it continues asynchronously and the call returns an asyncId. Values from 0 through 1000 ms are treated as immediate async mode to avoid pretending that such a short window is meaningful synchronous execution. Ignored when async=true.' };

const schemas = [
  { name: 'list_codespaces', description: 'List existing GitHub Codespaces for the authenticated user. This MCP cannot create codespaces.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'view_codespace', description: 'View one existing Codespace by exact name.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'roots', description: 'List only immediate workspace roots below /workspaces in one existing Codespace. This never scans /, the home directory, or arbitrary filesystem roots.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'git_root', description: 'Resolve the Git repository top-level directory for one path already below /workspaces/<workspace>. The input may not be / or /workspaces itself.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, path: { type: 'string', minLength: 1, maxLength: 1024 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'path'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'ripgrep_version', description: 'Return rg --version from one existing Codespace without modifying it.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'install_ripgrep', description: 'Ensure ripgrep exists in one existing Codespace. If rg --version already works nothing is installed; otherwise a fixed package-manager installer is used and rg --version is verified afterwards.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, timeoutMs: commonTimeout }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: installMutation },
  { name: 'search_text', description: 'Search text with ripgrep inside one explicit remote root below /workspaces/<workspace>. searchBase is required on every call; / and /workspaces are rejected so the tool cannot scan the whole Codespace. Query/glob data is sent over SSH stdin and is never interpolated into the remote shell command.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, searchBase: { type: 'string', minLength: 1, maxLength: 1024 }, query: { type: 'string', minLength: 1, maxLength: 4096 }, fixedStrings: { type: 'boolean', default: false }, caseSensitive: { type: 'boolean', default: true }, globs: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 512 } }, maxResults: { type: 'integer', minimum: 1, maximum: MAX_REMOTE_SEARCH_RESULTS, default: 100 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'searchBase', 'query'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'ssh', description: 'Run one simple remote command in an existing Codespace. The command is a strictly validated token array. Prefer codespace__run_bash_script for arbitrary code, multiple commands, shell operators, pipelines, redirection, variable expansion, or quoting-heavy shell work; do not emulate those cases through this older tokenized SSH interface. timeoutMs is only the hard remote-process runtime limit. Response behavior is controlled separately by async and syncWaitMs.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, command: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', minLength: 1, maxLength: 512 } }, timeoutMs: commonSshTimeout }, required: ['codespaceId', 'command'], additionalProperties: false }, outputSchema, annotations: remoteMutation },
  { name: 'run_bash_script', description: 'Run arbitrary UTF-8 Bash source in one existing Codespace under a fixed remote Node.js supervisor. Node first reads the complete source from SSH stdin into a private temporary script, then spawns /bin/bash with runtime stdin closed. Shell syntax and command execution remain Bash responsibilities; Node only supervises exit/signal state and owns the detached Bash process group so cancellation or supervisor termination can tear descendants down. Commands inside the script cannot consume source stdin and stdin-reading programs receive EOF. This is intentionally arbitrary remote code execution. It always returns an asyncId immediately; use codespace__get_async_status with that asyncId to retrieve lifecycle state and complete retained output.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, script: { type: 'string', minLength: 1, maxLength: MAX_REMOTE_STDIN_BYTES }, timeoutMs: commonSshTimeout }, required: ['codespaceId', 'script'], additionalProperties: false }, outputSchema, annotations: remoteMutation },
  { name: 'get_async_status', description: 'Return the shared non-blocking async registry for this isolated session. Omit asyncId to list every retained async operation without repeating full logs/results; pass asyncId to retrieve the complete retained status, including stdout/stderr for process-backed jobs or the final structured result/error for automatically promoted tool calls. The registry is process-local: serverInstanceId changes after an MCP crash/restart, and asyncIds from an older instance cannot be recovered.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId }, additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'get_async_logs', description: 'Compatibility API returning the complete currently captured stdout and stderr for one process-backed async operation, including SSH/run_bash_script jobs and managed temporary port-forward processes. codespace__get_async_status with an asyncId now returns the same retained process output together with status. Output is bounded by CODESPACE_MCP_MAX_OUTPUT_BYTES, which defaults to 128 KiB; exceeding the bound terminates the process instead of growing without limit.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId }, required: ['asyncId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'write_async_stdin', description: 'Write bounded UTF-8 data to stdin of one already-running async SSH job. This is primarily a compatibility/interactive-input mechanism. Prefer codespace__run_bash_script when the intended stdin is actually Bash source or when arbitrary shell work is needed, rather than starting async SSH and feeding a script through this older two-step path. Each write is limited to 64 KiB and total stdin per job is limited to 1 MiB. Set end=true to close stdin after this write. This does not extend the job runtime deadline.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId, data: { type: 'string', maxLength: MAX_ASYNC_STDIN_WRITE_BYTES }, end: { type: 'boolean', default: false } }, required: ['asyncId'], additionalProperties: false }, outputSchema, annotations: remoteMutation },
  { name: 'wait_async', description: 'Compatibility wait for one async SSH job. Prefer non-blocking codespace__get_async_status polling; it returns complete retained process output for an asyncId. Gateway configurations may block wait-style tools. For arbitrary shell execution, prefer codespace__run_bash_script rather than constructing an async SSH plus stdin plus wait workflow. waitTimeoutMs controls only this wait and is capped at 10 minutes; it does not extend the job runtime deadline. If the wait expires while the job is still running, the current running status is returned.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId, waitTimeoutMs: { type: 'integer', minimum: 1, maximum: MAX_ASYNC_WAIT_MS, default: MAX_ASYNC_WAIT_MS } }, required: ['asyncId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'cancel_async', description: 'Cancel one process-backed async operation by terminating its managed local process. SSH/run_bash_script jobs and managed temporary port-forward processes are cancellable. Automatically promoted compound tool operations currently report cancelSupported=false because they can span multiple sequential GitHub CLI operations. Completed jobs are left unchanged.', inputSchema: { type: 'object', properties: { asyncId: commonAsyncId }, required: ['asyncId'], additionalProperties: false }, outputSchema, annotations: closeState },
  { name: 'copy_to_codespace', description: 'Copy selected local files/directories below sourceDirectory into one explicitly remote destination while preserving each selected relative path. The caller must write remoteDestination with the remote: protocol, for example remote:/workspaces/project or remote:~/incoming. This MCP never inserts remote: automatically. Selecting scripts/a.js places it at <remoteDestination>/scripts/a.js rather than flattening it to <remoteDestination>/a.js. Every gh codespace cp invocation uses -e because GitHub CLI can otherwise report existing remote paths as missing. Select exactly one of paths or globs.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, sourceDirectory: { type: 'string', minLength: 1, maxLength: 1024 }, paths: { type: 'array', minItems: 1, maxItems: MAX_CP_SOURCES, items: { type: 'string', minLength: 1, maxLength: 1024 } }, globs: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 512 } }, remoteDestination: { type: 'string', minLength: 8, maxLength: 1031, pattern: '^remote:' }, timeoutMs: commonTimeout }, required: ['codespaceId', 'sourceDirectory', 'remoteDestination'], additionalProperties: false }, outputSchema, annotations: copyMutation },
  { name: 'copy_from_codespace', description: 'Copy one exact explicitly remote file or directory into an existing local destination directory inside the signed workspace roots. The caller must write remoteSource with the remote: protocol, for example remote:/workspaces/project/out.wav. This MCP never inserts remote: automatically. The remote source must resolve below /workspaces/<workspace>; it is inspected first so symlinks, unsupported entries, excessive entry counts, and transfers at or above CODESPACE_MCP_MAX_TRANSFER_BYTES are rejected before gh codespace cp runs. Every gh codespace cp invocation uses -e because GitHub CLI can otherwise report existing remote paths as missing. The destination basename must not already exist locally.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, remoteSource: { type: 'string', minLength: 8, maxLength: 1031, pattern: '^remote:' }, localDestinationDirectory: { type: 'string', minLength: 1, maxLength: 1024 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'remoteSource', 'localDestinationDirectory'], additionalProperties: false }, outputSchema, annotations: copyMutation },
  { name: 'stop_codespace', description: 'Stop one existing Codespace owned by this isolated session using gh codespace stop. Running async SSH jobs for that Codespace are cancelled first and cached SSH readiness is cleared. This does not delete the Codespace or discard saved changes.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, timeoutMs: commonTimeout }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: closeState },
  { name: 'list_temporary_public_deployments', description: 'List temporary public deployment candidates already known to GitHub for one Codespace, including browseUrl, port, and current visibility. This only queries GitHub Codespaces metadata; it never scans localhost, local listening sockets, browser tabs, or the local machine to auto-detect ports. If GitHub reports no candidates, the tool returns a corrective error instead of an empty list so callers do not mistake this for failed local-port discovery.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId }, required: ['codespaceId'], additionalProperties: false }, outputSchema, annotations: readOnly },
  { name: 'open_temporary_public_deployment', description: 'Open a temporary public deployment for exactly one caller-specified Codespace port and return its complete https://...app.github.dev URL. Call this directly when the exact remote port is known; list_temporary_public_deployments is not a prerequisite. If the exact port is absent from GitHub Codespaces metadata, the tool starts gh codespace ports forward <port>:<port> as a managed bootstrap process, polls until GitHub registers the port, changes that exact port to public, and keeps the bootstrap process alive until the deployment is closed, the Codespace is stopped, ownership moves to another isolated session, or the bounded process lifetime ends. It never scans localhost, inspects local listening sockets, browser tabs, or local development servers, and never guesses a port.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, port: { type: 'integer', minimum: 1, maximum: 65535 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'port'], additionalProperties: false }, outputSchema, annotations: localState },
  { name: 'close_temporary_public_deployment', description: 'Close temporary public internet access for exactly one caller-specified Codespace port by returning its GitHub visibility to private. This never scans localhost or auto-detects which port to close.', inputSchema: { type: 'object', properties: { codespaceId: commonCodespaceId, port: { type: 'integer', minimum: 1, maximum: 65535 }, timeoutMs: commonTimeout }, required: ['codespaceId', 'port'], additionalProperties: false }, outputSchema, annotations: closeState }
];

const RESPONSE_MODE_TOOL_NAMES = new Set([
  'list_codespaces',
  'view_codespace',
  'roots',
  'git_root',
  'ripgrep_version',
  'install_ripgrep',
  'search_text',
  'ssh',
  'copy_to_codespace',
  'copy_from_codespace',
  'stop_codespace',
  'list_temporary_public_deployments',
  'open_temporary_public_deployment',
  'close_temporary_public_deployment'
]);

for (const schema of schemas) {
  if (!RESPONSE_MODE_TOOL_NAMES.has(schema.name)) continue;
  schema.inputSchema.properties.async = commonAsync;
  schema.inputSchema.properties.syncWaitMs = commonSyncWait;
  schema.description += ' Response mode: async=true returns an asyncId immediately and ignores syncWaitMs. Otherwise syncWaitMs is only the synchronous response wait, defaults to 10000 ms, and never cancels or shortens the underlying operation timeout. If the operation is still running when syncWaitMs expires, it is moved to the shared async registry and an asyncId is returned. syncWaitMs values from 0 through 1000 ms are treated as immediate async mode.';
}

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

function syncWait(value) {
  const resolved = value ?? DEFAULT_SYNC_WAIT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > MAX_SYNC_WAIT_MS) {
    throw new Error(`syncWaitMs must be an integer from 0 through ${MAX_SYNC_WAIT_MS}`);
  }
  return resolved;
}

function responseMode(args) {
  if (args.async !== undefined && typeof args.async !== 'boolean') throw new Error('async must be boolean');
  if (args.async === true) {
    return { asyncRequested: true, syncWaitMs: null, immediateAsync: true };
  }
  const resolvedSyncWaitMs = syncWait(args.syncWaitMs);
  return {
    asyncRequested: false,
    syncWaitMs: resolvedSyncWaitMs,
    immediateAsync: resolvedSyncWaitMs <= IMMEDIATE_ASYNC_SYNC_WAIT_MS
  };
}

function sshTimeout(value) {
  const resolved = value ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const maximum = MAX_ASYNC_RUNTIME_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) throw new Error(`timeoutMs must be an integer from 1 through ${maximum}`);
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

function safeBashScript(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('script must be a non-empty UTF-8 string');
  if (value.includes('\0')) throw new Error('script may not contain NUL');
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_REMOTE_STDIN_BYTES) throw new Error(`script exceeds ${MAX_REMOTE_STDIN_BYTES} UTF-8 bytes`);
  return value;
}

function safeRemoteEndpoint(value, label = 'remote path') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1031 || /[\0\r\n\t ]/.test(value)) throw new Error(`${label} must be a non-empty remote: path without whitespace or control characters`);
  if (!value.startsWith('remote:')) throw new Error(`${label} must explicitly use the remote: protocol; this MCP never adds remote: automatically`);
  const remotePath = value.slice('remote:'.length);
  if (/["'!@`$;&|<>(){}\[\]\\*?]/.test(remotePath)) throw new Error(`${label} contains shell expansion or metacharacters`);
  if (!/^(?:~(?:\/|$)|\/)[A-Za-z0-9._~\/-]*$/.test(remotePath)) throw new Error(`${label} must be remote:/absolute/path or remote:~/path using only letters, numbers, dot, underscore, hyphen, slash, and a leading tilde`);
  const parts = remotePath.split('/').filter((part) => part !== '' && part !== '~');
  if (parts.some((part) => part === '.' || part === '..')) throw new Error(`${label} may not contain . or .. path components`);
  return { endpoint: value, path: remotePath };
}

function joinRemoteEndpoint(rootEndpoint, relativePath = '') {
  const root = safeRemoteEndpoint(rootEndpoint, 'remote endpoint');
  const joinedPath = relativePath ? posix.join(root.path, relativePath) : root.path.replace(/\/$/, '');
  const protocol = root.endpoint.slice(0, root.endpoint.length - root.path.length);
  return safeRemoteEndpoint(`${protocol}${joinedPath}`, 'derived remote endpoint').endpoint;
}

function safeAbsoluteRemotePath(value, label = 'remote path') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a non-empty absolute POSIX path without NUL or line breaks`);
  if (value.includes('\\')) throw new Error(`${label} must use POSIX / separators`);
  const collapsed = value.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  if (!collapsed.startsWith('/')) throw new Error(`${label} must be absolute`);
  if (collapsed.split('/').some((component) => component === '.' || component === '..')) throw new Error(`${label} may not contain . or .. path components`);
  return collapsed;
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
  if (value.startsWith('remote:')) throw new Error('sourceDirectory must be local; copy_to_codespace requires exactly one explicit remote: endpoint on remoteDestination');
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

async function existingLocalDestinationDirectory(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\0\r\n]/.test(value)) throw new Error('localDestinationDirectory is invalid');
  if (value.startsWith('remote:')) throw new Error('localDestinationDirectory must be local; copy_from_codespace requires exactly one explicit remote: endpoint on remoteSource');
  const selectedRoots = await roots();
  const selectedBase = await base();
  const lexical = resolve(isAbsolute(value) ? value : join(selectedBase, value));
  await policy.assertToolArguments('copy_from_codespace', { localDestinationDirectory: lexical }, selectedBase);
  const scoped = await scopedPolicy(selectedRoots, selectedBase);
  await scoped.assertToolArguments('copy_from_codespace', { localDestinationDirectory: lexical }, selectedBase);
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('localDestinationDirectory must be an existing non-symbolic-link directory');
  const actual = await realpath(lexical);
  if (!selectedRoots.some((root) => within(root, actual))) throw new Error('localDestinationDirectory resolves outside the signed workspace roots');
  await policy.assertToolArguments('copy_from_codespace', { localDestinationDirectory: actual }, selectedBase);
  await scoped.assertToolArguments('copy_from_codespace', { localDestinationDirectory: actual }, selectedBase);
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

const SSH_KEYGEN_TIMEOUT_MS = 30_000;
const SSH_KEYGEN_MAX_OUTPUT_BYTES = 64 * 1024;
let sshKeyPromise;

function generateInternalSshKey(executable, privateKeyPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let outputBytes = 0;
    let stdout = '';
    let stderr = '';
    let timer;
    const child = spawn(executable, ['-q', '-t', 'ed25519', '-N', '', '-f', privateKeyPath], {
      cwd: sshRuntimeDirectoryConfigured,
      env: environmentWithoutBundledIsolationKey(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const capture = (stream, chunk) => {
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text, 'utf8');
      if (outputBytes > SSH_KEYGEN_MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('ssh-keygen exceeded the bounded output limit'));
        return;
      }
      if (stream === 'stdout') stdout += text;
      else stderr += text;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (code === 0) finish();
      else finish(new Error(`ssh-keygen failed (${signal ?? code ?? 'unknown'}): ${(stderr || stdout).trim() || 'no diagnostic output'}`));
    });
    timer = setTimeout(() => {
      child.kill();
      finish(new Error(`ssh-keygen timed out after ${SSH_KEYGEN_TIMEOUT_MS}ms`));
    }, SSH_KEYGEN_TIMEOUT_MS);
  });
}

async function internalSshKeyFile() {
  if (!sshRuntimeDirectoryConfigured || !sshKeygenExecutableConfigured) {
    if (process.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY) {
      throw new Error('Codespace internal SSH key runtime was not provisioned by the Gateway');
    }
    return undefined;
  }
  sshKeyPromise ??= (async () => {
    const runtimeInfo = await lstat(sshRuntimeDirectoryConfigured);
    if (runtimeInfo.isSymbolicLink() || !runtimeInfo.isDirectory()) {
      throw new Error('Codespace internal SSH runtime must be a non-symbolic-link directory');
    }
    const runtimeDirectory = await realpath(sshRuntimeDirectoryConfigured);
    const privateKeyPath = join(runtimeDirectory, 'codespace-key');
    const publicKeyPath = `${privateKeyPath}.pub`;
    await generateInternalSshKey(sshKeygenExecutableConfigured, privateKeyPath);
    for (const [label, path] of [['private', privateKeyPath], ['public', publicKeyPath]]) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Generated Codespace ${label} SSH key is not a regular file`);
      if (info.size < 1 || info.size > 1024 * 1024) throw new Error(`Generated Codespace ${label} SSH key has an invalid size`);
    }
    return privateKeyPath;
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
      failure = `返却文字列のサイズが${formatOutputBytes(totalBytes)}のため、Codespace MCPによって処理が中断されました。破壊的操作はすでに行われている可能性があります。現在の制限は${formatOutputBytes(MAX_OUTPUT_BYTES)}です。`;
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

async function sshGhArgs(codespace, remoteCommand, sshKeyProvider = internalSshKeyFile) {
  const key = await sshKeyProvider();
  return [
    'codespace', 'ssh', '-c', codespace,
    ...(key ? ['--', '-i', key] : []),
    remoteCommand
  ];
}

const REMOTE_REALPATH_COMMAND = "bash -c 'IFS= read -r encoded || exit 2; path=$(printf %s \"$encoded\" | base64 -d) || exit 2; test -d \"$path\" || exit 3; realpath -- \"$path\"'";
const REMOTE_GIT_ROOT_COMMAND = "bash -c 'IFS= read -r encoded || exit 2; path=$(printf %s \"$encoded\" | base64 -d) || exit 2; exec git -C \"$path\" rev-parse --show-toplevel'";
const REMOTE_PREPARE_COPY_DESTINATION_COMMAND = "bash -c 'IFS= read -r encoded || exit 2; path=$(printf %s \"$encoded\" | base64 -d) || exit 2; case \"$path\" in \"~\") path=\"$HOME\" ;; \"~/\"*) path=\"$HOME/${path#~/}\" ;; esac; mkdir -p -- \"$path\" || exit 3; realpath -- \"$path\"'";
const REMOTE_MKDIRS_COMMAND = "bash -c 'IFS= read -r count || exit 2; case \"$count\" in \"\"|*[!0-9]*) exit 2 ;; esac; for ((i=0; i<count; i++)); do IFS= read -r encoded || exit 2; path=$(printf %s \"$encoded\" | base64 -d) || exit 2; mkdir -p -- \"$path\" || exit 3; done'";
const REMOTE_COPY_SOURCE_INFO_COMMAND = "bash -c 'set -eu; IFS= read -r encoded || exit 2; path=$(printf %s \"$encoded\" | base64 -d) || exit 2; if [ -L \"$path\" ]; then echo remote-source-symlink >&2; exit 4; fi; if [ ! -e \"$path\" ]; then echo remote-source-missing >&2; exit 3; fi; actual=$(realpath -- \"$path\") || exit 5; encoded_actual=$(printf %s \"$actual\" | base64 | tr -d \"\\n\"); if [ -f \"$actual\" ]; then size=$(stat -c %s -- \"$actual\") || exit 6; printf \"F\\t%s\\t1\\t0\\t%s\\n\" \"$size\" \"$encoded_actual\"; exit 0; fi; if [ ! -d \"$actual\" ]; then echo remote-source-unsupported >&2; exit 7; fi; unsupported=$(find -P \"$actual\" -mindepth 1 ! -type f ! -type d -print -quit); if [ -n \"$unsupported\" ]; then echo remote-source-contains-unsupported-entry >&2; exit 8; fi; entry_count=$(find -P \"$actual\" -mindepth 1 -printf \".\\n\" | wc -l | tr -d \" \" ); file_count=$(find -P \"$actual\" -type f -printf \".\\n\" | wc -l | tr -d \" \" ); total_bytes=$(du -sb --apparent-size -- \"$actual\" | cut -f1); printf \"D\\t%s\\t%s\\t%s\\t%s\\n\" \"$total_bytes\" \"$file_count\" \"$entry_count\" \"$encoded_actual\"'";
const REMOTE_RG_SEARCH_COMMAND = "bash -c 'set -u; read_b64(){ IFS= read -r line || return 1; printf %s \"$line\" | base64 -d; }; search_base=$(read_b64) || exit 2; query=$(read_b64) || exit 2; IFS= read -r fixed || exit 2; IFS= read -r sensitive || exit 2; IFS= read -r result_cap || exit 2; IFS= read -r glob_count || exit 2; args=(--json --color=never --hidden --max-filesize " + REMOTE_MAX_TEXT_BYTES + " --glob \"!.git\" --glob \"!.git/**\"); if [ \"$fixed\" = 1 ]; then args+=(-F); fi; if [ \"$sensitive\" = 0 ]; then args+=(-i); fi; for ((i=0; i<glob_count; i++)); do glob=$(read_b64) || exit 2; args+=(--glob \"$glob\"); done; rg \"${args[@]}\" -- \"$query\" \"$search_base\" | awk -v max=\"$result_cap\" \"{ print; if (index(\\$0, \\\"\\\\\\\"type\\\\\\\":\\\\\\\"match\\\\\\\"\\\") > 0) { count++; if (count >= max) exit 0 } }\"; statuses=(\"${PIPESTATUS[@]}\"); rg_rc=\"${statuses[0]}\"; awk_rc=\"${statuses[1]}\"; if [ \"$awk_rc\" != 0 ]; then exit \"$awk_rc\"; fi; if [ \"$rg_rc\" = 0 ] || [ \"$rg_rc\" = 1 ] || [ \"$rg_rc\" = 141 ]; then exit 0; fi; exit \"$rg_rc\"'";

async function runFixedRemote(codespace, execute, remoteCommand, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, stdinText } = {}, sshKeyProvider = internalSshKeyFile) {
  return execute(await sshGhArgs(codespace, remoteCommand, sshKeyProvider), { timeoutMs, stdinText });
}

async function canonicalRemoteWorkspacePath(codespace, value, execute, timeoutMs, sshKeyProvider = internalSshKeyFile) {
  const requested = safeRemoteWorkspacePath(value, 'path');
  const execution = await runFixedRemote(codespace, execute, REMOTE_REALPATH_COMMAND, {
    timeoutMs,
    stdinText: `${base64Line(requested)}\n`
  }, sshKeyProvider);
  const actual = execution.stdout.trim();
  return safeRemoteWorkspacePath(actual, 'resolved remote path');
}

async function prepareRemoteCopyDestination(codespace, remoteDestination, execute, timeoutMs, sshKeyProvider = internalSshKeyFile) {
  const requested = safeRemoteEndpoint(remoteDestination, 'remoteDestination').path.replace(/\/$/, '') || '/';
  const execution = await runFixedRemote(codespace, execute, REMOTE_PREPARE_COPY_DESTINATION_COMMAND, {
    timeoutMs,
    stdinText: `${base64Line(requested)}\n`
  }, sshKeyProvider);
  return safeAbsoluteRemotePath(execution.stdout.trim(), 'resolved remoteDestination');
}

async function prepareRemoteCopyParents(codespace, parents, execute, timeoutMs, sshKeyProvider = internalSshKeyFile) {
  const unique = [...new Set(parents.map((parent) => safeAbsoluteRemotePath(parent, 'remote copy parent')))];
  if (unique.length === 0) return;
  const payload = [String(unique.length), ...unique.map(base64Line)].join('\n') + '\n';
  await runFixedRemote(codespace, execute, REMOTE_MKDIRS_COMMAND, { timeoutMs, stdinText: payload }, sshKeyProvider);
}

function parseRemoteCopySourceInfo(stdout) {
  const fields = String(stdout).trim().split('\t');
  if (fields.length !== 5 || (fields[0] !== 'F' && fields[0] !== 'D')) throw new Error('remote source inspection returned invalid metadata');
  const totalBytes = Number(fields[1]);
  const fileCount = Number(fields[2]);
  const entryCount = Number(fields[3]);
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || !Number.isSafeInteger(fileCount) || fileCount < 0 || !Number.isSafeInteger(entryCount) || entryCount < 0) {
    throw new Error('remote source inspection returned invalid numeric metadata');
  }
  if (entryCount > MAX_SCAN_ENTRIES) throw new Error(`remote copy source contains ${entryCount} entries, exceeding CODESPACE_MCP_MAX_SCAN_ENTRIES=${MAX_SCAN_ENTRIES}`);
  if (totalBytes >= MAX_TRANSFER_BYTES) throw new Error(`copy transfer size ${totalBytes} bytes meets or exceeds CODESPACE_MCP_MAX_TRANSFER_BYTES=${MAX_TRANSFER_BYTES}`);
  let actual;
  try { actual = Buffer.from(fields[4], 'base64').toString('utf8'); }
  catch { throw new Error('remote source inspection returned invalid path encoding'); }
  const remoteSource = safeRemoteWorkspacePath(actual, 'resolved remoteSource');
  return { remoteSource, directory: fields[0] === 'D', totalBytes, fileCount, entryCount };
}

async function inspectRemoteCopySource(codespace, remoteSource, execute, timeoutMs, sshKeyProvider = internalSshKeyFile) {
  const requested = safeRemoteWorkspacePath(safeRemoteEndpoint(remoteSource, 'remoteSource').path, 'remoteSource');
  const execution = await runFixedRemote(codespace, execute, REMOTE_COPY_SOURCE_INFO_COMMAND, {
    timeoutMs,
    stdinText: `${base64Line(requested)}\n`
  }, sshKeyProvider);
  return parseRemoteCopySourceInfo(execution.stdout);
}

async function ripgrepVersion(codespace, execute, timeoutMs = 30_000, sshKeyProvider = internalSshKeyFile) {
  const execution = await runFixedRemote(codespace, execute, 'rg --version', { timeoutMs }, sshKeyProvider);
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

async function ensureCodespaceAvailable(codespace, execute, timeoutMs, sshKeyProvider = internalSshKeyFile) {
  let confirmed = false;
  try {
    const viewed = await execute(['codespace', 'view', '-c', codespace, '--json', 'state', '--jq', '.state'], { timeoutMs });
    confirmed = viewed.stdout.trim().toLowerCase() === 'available';
  } catch { confirmed = false; }
  if (confirmed) return { woke: false };
  await execute(await sshGhArgs(codespace, 'true', sshKeyProvider), { timeoutMs });
  return { woke: true };
}

async function probeCodespaceSshReady(codespace, execute, timeoutMs, sshKeyProvider = internalSshKeyFile) {
  const startup = await execute(await sshGhArgs(codespace, 'echo started', sshKeyProvider), { timeoutMs });
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

function createForwardBootstrapManager(startExecution, assertOwnership = () => {}, serverInstanceId = 'unknown') {
  const forwards = new Map();
  const history = new Map();
  const key = (scopeKey, codespaceId, port) => `${scopeKey}\0${codespaceId}\0${port}`;

  const prune = () => {
    if (history.size < MAX_RETAINED_ASYNC_JOBS) return;
    for (const [asyncId, record] of history) {
      const state = record.execution.snapshot();
      if (state.state !== 'running') history.delete(asyncId);
      if (history.size < MAX_RETAINED_ASYNC_JOBS) break;
    }
  };

  const refresh = (record) => {
    const state = record.execution.snapshot();
    if (state.state !== 'running') {
      record.finishedAt ??= new Date().toISOString();
      if (forwards.get(record.key) === record) forwards.delete(record.key);
    }
    return state;
  };

  const summary = (record) => {
    const state = refresh(record);
    return {
      asyncId: record.asyncId,
      serverInstanceId,
      kind: 'process',
      operation: 'temporary_public_port_forward',
      codespaceId: record.codespaceId,
      port: record.port,
      status: state.state,
      createdAt: record.createdAt,
      finishedAt: record.finishedAt,
      timeoutMs: MAX_ASYNC_RUNTIME_MS,
      exitCode: state.exitCode,
      signal: state.signal,
      error: state.error,
      managed: true,
      cancelSupported: true,
      hasLogs: true
    };
  };

  const requireRecord = (asyncId) => {
    const record = history.get(asyncId);
    if (!record || record.scopeKey !== isolationScopeKey()) return null;
    assertOwnership(record.scopeKey, record.codespaceId);
    return record;
  };

  const cancelRecord = (record) => {
    const before = refresh(record);
    if (before.state !== 'running') return false;
    const signalSent = record.execution.cancel();
    refresh(record);
    return signalSent;
  };

  return {
    async ensure(scopeKey, codespaceId, port) {
      const recordKey = key(scopeKey, codespaceId, port);
      const existing = forwards.get(recordKey);
      if (existing && refresh(existing).state === 'running') return { record: existing, started: false };
      prune();
      const args = ['codespace', 'ports', 'forward', `${port}:${port}`, '-c', codespaceId];
      const execution = await startExecution(args, { timeoutMs: MAX_ASYNC_RUNTIME_MS });
      const record = {
        asyncId: randomUUID().toLowerCase(),
        key: recordKey,
        scopeKey,
        codespaceId,
        port,
        args,
        execution,
        createdAt: new Date().toISOString(),
        finishedAt: null
      };
      forwards.set(recordKey, record);
      history.set(record.asyncId, record);
      void execution.completion.then(() => { refresh(record); });
      return { record, started: true };
    },
    state(record) {
      return refresh(record);
    },
    cancel(scopeKey, codespaceId, port) {
      const record = forwards.get(key(scopeKey, codespaceId, port));
      if (!record) return false;
      return cancelRecord(record);
    },
    cancelScopeCodespace(scopeKey, codespaceId) {
      let cancelled = 0;
      for (const record of [...forwards.values()]) {
        if (record.scopeKey !== scopeKey || record.codespaceId !== codespaceId) continue;
        if (cancelRecord(record)) cancelled += 1;
      }
      return cancelled;
    },
    tryStatus(asyncId) {
      const record = requireRecord(asyncId);
      return record ? summary(record) : null;
    },
    listStatus() {
      const scopeKey = isolationScopeKey();
      return [...history.values()]
        .filter((record) => record.scopeKey === scopeKey)
        .map(summary);
    },
    tryLogs(asyncId) {
      const record = requireRecord(asyncId);
      if (!record) return null;
      const state = refresh(record);
      return {
        ...summary(record),
        stdout: state.stdout,
        stderr: state.stderr,
        outputBytes: state.outputBytes
      };
    },
    tryCancel(asyncId) {
      const record = requireRecord(asyncId);
      if (!record) return null;
      const before = refresh(record);
      if (before.state !== 'running') return { ...summary(record), cancelled: false };
      const signalSent = record.execution.cancel();
      refresh(record);
      return { ...summary(record), cancelled: true, signalSent };
    }
  };
}

async function waitForForwardedPort(codespace, port, execute, forwardRecord, timeoutMs, sleep) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timed out waiting for GitHub Codespaces to register forwarded port ${port}`);
    const ports = await portsForCodespace(codespace, execute, Math.min(remaining, 30_000));
    const selected = selectedForwardedPort(ports, port);
    if (selected) return selected;
    const state = forwardRecord.execution.snapshot();
    if (state.state !== 'running') {
      const detail = state.error ?? state.stderr?.trim() ?? state.stdout?.trim() ?? state.state;
      throw new Error(`gh codespace ports forward ${port}:${port} ended before GitHub registered port ${port}: ${detail}`);
    }
    await sleep(Math.min(FORWARD_REGISTRATION_POLL_MS, remaining));
  }
}

function isolationScopeKey() {
  const context = isolation.current();
  if (!context) return 'direct';
  return context.isolatedId ?? JSON.stringify({ base: context.base, roots: context.roots });
}

function createAsyncJobManager(startExecution, assertOwnership = () => {}, serverInstanceId = 'unknown') {
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
    if (!job) throw new Error('Unknown or expired asyncId. Async state is process-local; an MCP crash or restart makes asyncIds from the previous server instance unrecoverable.');
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
      serverInstanceId,
      kind: 'process',
      operation: job.operation,
      codespaceId: job.codespaceId,
      status: job.status,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      timeoutMs: job.timeoutMs,
      exitCode: processState.exitCode,
      signal: processState.signal,
      error: processState.error,
      cancelSupported: true,
      hasLogs: true,
      ...(job.status === 'running' ? {
        statusTool: 'codespace__get_async_status',
        nextAction: 'Call codespace__get_async_status with this asyncId to retrieve the complete current output and final result.'
      } : {})
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
    async start({ codespaceId, operation = 'ssh', args, timeoutMs, stdinText, keepStdinOpen = true }) {
      prune();
      const active = [...jobs.values()].filter((job) => refresh(job).state === 'running').length;
      if (active >= MAX_ACTIVE_ASYNC_JOBS) throw new Error(`Too many active async SSH jobs; maximum is ${MAX_ACTIVE_ASYNC_JOBS}`);
      const execution = await startExecution(args, { timeoutMs, stdinText, keepStdinOpen });
      const asyncId = randomUUID().toLowerCase();
      const job = {
        asyncId,
        operation,
        codespaceId,
        timeoutMs,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        status: 'running',
        stdinBytes: stdinText === undefined ? 0 : Buffer.byteLength(stdinText, 'utf8'),
        stdinEnded: !keepStdinOpen,
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
    tryStatus(asyncId) {
      const job = jobs.get(asyncId);
      if (!job || job.scopeKey !== isolationScopeKey()) return null;
      assertOwnership(job.scopeKey, job.codespaceId);
      return summary(job);
    },
    listStatus() {
      const scopeKey = isolationScopeKey();
      return [...jobs.values()]
        .filter((job) => job.scopeKey === scopeKey)
        .map(summary);
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

function createAsyncTaskManager(serverInstanceId = 'unknown', assertOwnership = () => {}) {
  const tasks = new Map();

  const prune = () => {
    if (tasks.size < MAX_RETAINED_ASYNC_JOBS) return;
    for (const [asyncId, task] of tasks) {
      if (task.status !== 'running') tasks.delete(asyncId);
      if (tasks.size < MAX_RETAINED_ASYNC_JOBS) break;
    }
  };

  const summary = (task, includeResult = false) => ({
    asyncId: task.asyncId,
    serverInstanceId,
    kind: 'tool',
    operation: task.operation,
    codespaceId: task.codespaceId ?? null,
    status: task.status,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    asyncRequested: task.asyncRequested,
    syncWaitMs: task.syncWaitMs,
    autoPromoted: !task.asyncRequested,
    cancelSupported: false,
    hasLogs: false,
    hasResult: task.status === 'completed',
    ...(includeResult && task.status === 'completed' ? { result: task.result } : {}),
    error: task.error,
    ...(task.status === 'running' ? {
      statusTool: 'codespace__get_async_status',
      nextAction: 'Call codespace__get_async_status with this asyncId to retrieve the complete final result or error.'
    } : {})
  });

  const requireTask = (value) => {
    const asyncId = safeAsyncId(value);
    const task = tasks.get(asyncId);
    if (!task) return null;
    if (task.scopeKey !== isolationScopeKey()) throw new Error('asyncId belongs to a different isolated workspace context');
    if (task.codespaceId) assertOwnership(task.scopeKey, task.codespaceId);
    return task;
  };

  return {
    async resolveOrPromote({ operation, codespaceId, promise, mode }) {
      const scopeKey = isolationScopeKey();
      const createdAt = new Date().toISOString();
      let settled = false;
      let result;
      let failure;
      const tracked = Promise.resolve(promise).then(
        (value) => {
          settled = true;
          result = value;
          return value;
        },
        (error) => {
          settled = true;
          failure = error;
          return undefined;
        }
      );
      if (!mode.immediateAsync) {
        let timer;
        await Promise.race([
          tracked,
          new Promise((resolvePromise) => {
            timer = setTimeout(resolvePromise, mode.syncWaitMs);
          })
        ]);
        if (timer) clearTimeout(timer);
        if (settled) {
          if (failure) throw failure;
          return result;
        }
      }

      prune();
      const asyncId = randomUUID().toLowerCase();
      const task = {
        asyncId,
        operation,
        codespaceId: typeof codespaceId === 'string' ? codespaceId : null,
        scopeKey,
        createdAt,
        finishedAt: null,
        status: 'running',
        asyncRequested: mode.asyncRequested,
        syncWaitMs: mode.syncWaitMs,
        result: undefined,
        error: null
      };
      tasks.set(asyncId, task);
      void tracked.then(() => {
        task.finishedAt = new Date().toISOString();
        if (failure) {
          task.status = 'failed';
          task.error = failure instanceof Error ? failure.message : String(failure);
        } else {
          task.status = 'completed';
          task.result = result;
        }
      });
      return { ...summary(task), async: true, promotedAfterMs: mode.immediateAsync ? 0 : mode.syncWaitMs };
    },
    tryStatus(asyncId, includeResult = true) {
      const task = requireTask(asyncId);
      return task ? summary(task, includeResult) : null;
    },
    listStatus() {
      const scopeKey = isolationScopeKey();
      return [...tasks.values()]
        .filter((task) => task.scopeKey === scopeKey)
        .map((task) => summary(task, false));
    }
  };
}

export function createServer(options = {}) {
  const serverInstanceId = options.serverInstanceId ?? randomUUID().toLowerCase();
  const rawExecute = options.execute ?? runGh;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  const sshKeyProvider = options.sshKeyProvider ?? internalSshKeyFile;
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

  const asyncJobs = createAsyncJobManager(options.startAsyncExecution ?? startGhExecution, assertCodespaceOwnership, serverInstanceId);
  const asyncTasks = createAsyncTaskManager(serverInstanceId, assertCodespaceOwnership);
  const forwardBootstraps = createForwardBootstrapManager(options.startForwardExecution ?? startGhExecution, assertCodespaceOwnership, serverInstanceId);

  const asyncStatus = (asyncId) => {
    if (asyncId !== undefined) {
      const validated = safeAsyncId(asyncId);
      const processJob = asyncJobs.tryStatus(validated);
      if (processJob) return asyncJobs.logs(validated);
      const forwardJob = forwardBootstraps.tryStatus(validated);
      if (forwardJob) return forwardBootstraps.tryLogs(validated);
      const toolTask = asyncTasks.tryStatus(validated, true);
      if (toolTask) return toolTask;
      throw new Error('Unknown or expired asyncId. Async state is process-local; an MCP crash or restart makes asyncIds from the previous server instance unrecoverable.');
    }
    const operations = [...asyncJobs.listStatus(), ...forwardBootstraps.listStatus(), ...asyncTasks.listStatus()]
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    return {
      serverInstanceId,
      registryPersistence: 'process-memory',
      crashRecovery: 'unrecoverable',
      operations
    };
  };

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
      forwardBootstraps.cancelScopeCodespace(owner, codespace);
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
        const execution = await runFixedRemote(codespace, execute, 'find /workspaces -mindepth 1 -maxdepth 1 -type d -print0', { timeoutMs: 30_000 }, sshKeyProvider);
        const roots = execution.stdout.split('\0').filter(Boolean).map((entry) => safeRemoteWorkspacePath(entry, 'workspace root')).sort();
        return { codespaceId: codespace, roots };
      }
      case 'git_root': {
        const codespace = safeCodespaceId(args.codespaceId);
        const timeoutMs = timeout(args.timeoutMs, 30_000);
        const requested = safeRemoteWorkspacePath(args.path, 'path');
        const canonical = await canonicalRemoteWorkspacePath(codespace, requested, execute, timeoutMs, sshKeyProvider);
        const execution = await runFixedRemote(codespace, execute, REMOTE_GIT_ROOT_COMMAND, {
          timeoutMs,
          stdinText: `${base64Line(canonical)}\n`
        }, sshKeyProvider);
        const gitRoot = safeRemoteWorkspacePath(execution.stdout.trim(), 'git root');
        return { codespaceId: codespace, requestedPath: requested, canonicalPath: canonical, gitRoot };
      }
      case 'ripgrep_version': {
        const codespace = safeCodespaceId(args.codespaceId);
        const version = await ripgrepVersion(codespace, execute, 30_000, sshKeyProvider);
        return { codespaceId: codespace, version: version.version };
      }
      case 'install_ripgrep': {
        const codespace = safeCodespaceId(args.codespaceId);
        const timeoutMs = timeout(args.timeoutMs);
        try {
          const version = await ripgrepVersion(codespace, execute, Math.min(timeoutMs, 30_000), sshKeyProvider);
          return { codespaceId: codespace, installed: false, version: version.version };
        } catch {
          await runFixedRemote(codespace, execute, "bash -c 'if command -v apt-get >/dev/null 2>&1; then sudo -n apt-get update && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y ripgrep; elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y ripgrep; elif command -v yum >/dev/null 2>&1; then sudo -n yum install -y ripgrep; elif command -v apk >/dev/null 2>&1; then sudo -n apk add ripgrep; else echo no-supported-package-manager >&2; exit 127; fi'", { timeoutMs }, sshKeyProvider);
          const version = await ripgrepVersion(codespace, execute, Math.min(timeoutMs, 30_000), sshKeyProvider);
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
        const searchBase = await canonicalRemoteWorkspacePath(codespace, requestedBase, execute, timeoutMs, sshKeyProvider);
        try {
          await ripgrepVersion(codespace, execute, Math.min(timeoutMs, 30_000), sshKeyProvider);
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
        const execution = await runFixedRemote(codespace, execute, REMOTE_RG_SEARCH_COMMAND, { timeoutMs, stdinText: payload }, sshKeyProvider);
        const parsed = parseRipgrepJson(execution.stdout, maxResults);
        return { codespaceId: codespace, searchBase, query: args.query, ...parsed };
      }
      case 'ssh': {
        const codespace = safeCodespaceId(args.codespaceId);
        const command = safeRemoteCommandTokens(args.command);
        const remoteCommand = command.join(' ');
        const timeoutMs = sshTimeout(args.timeoutMs);
        const ghArgs = await sshGhArgs(codespace, remoteCommand, sshKeyProvider);
        if (args.async === true) {
          const job = await asyncJobs.start({ codespaceId: codespace, operation: 'ssh', args: ghArgs, timeoutMs });
          return { ...job, async: true };
        }
        const execution = await execute(ghArgs, { timeoutMs });
        return { codespaceId: codespace, remoteCommand, stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.exitCode };
      }
      case 'run_bash_script': {
        const codespace = safeCodespaceId(args.codespaceId);
        const script = safeBashScript(args.script);
        const timeoutMs = sshTimeout(args.timeoutMs);
        const ghArgs = await sshGhArgs(codespace, REMOTE_BASH_SUPERVISOR_COMMAND, sshKeyProvider);
        const job = await asyncJobs.start({ codespaceId: codespace, operation: 'run_bash_script', args: ghArgs, timeoutMs, stdinText: script, keepStdinOpen: false });
        return { ...job, async: true, remoteCommand: 'node supervisor -> /bin/bash', stdinBytes: Buffer.byteLength(script, 'utf8'), stdinEnded: true, stdinInherited: false, runtimeStdin: 'closed' };
      }
      case 'get_async_status': return asyncStatus(args.asyncId);
      case 'get_async_logs': {
        const validated = safeAsyncId(args.asyncId);
        const forwardLogs = forwardBootstraps.tryLogs(validated);
        if (forwardLogs) return forwardLogs;
        return asyncJobs.logs(validated);
      }
      case 'write_async_stdin': return asyncJobs.writeStdin(args.asyncId, args.data ?? '', args.end ?? false);
      case 'wait_async': return asyncJobs.wait(args.asyncId, asyncWaitTimeout(args.waitTimeoutMs));
      case 'cancel_async': {
        const validated = safeAsyncId(args.asyncId);
        const task = asyncTasks.tryStatus(validated, false);
        if (task) return { ...task, cancelled: false, reason: 'This automatically promoted compound tool operation cannot currently be cancelled safely.' };
        const forward = forwardBootstraps.tryCancel(validated);
        if (forward) return forward;
        return asyncJobs.cancel(validated);
      }
      case 'copy_to_codespace': {
        const codespace = safeCodespaceId(args.codespaceId);
        const remoteDestination = safeRemoteEndpoint(args.remoteDestination, 'remoteDestination').endpoint;
        const source = await existingSourceDirectory(args.sourceDirectory);
        const selections = await selectCopySources(source, args);
        const size = await transferSizeForSelections(source, selections);
        const timeoutMs = timeout(args.timeoutMs);
        const key = readinessKey(codespace);
        const wasReady = sshReadyScopes.has(key);
        let readiness = { startupStdout: '', startupStderr: '', reused: wasReady };
        if (!wasReady) {
          try {
            readiness = { ...(await probeCodespaceSshReady(codespace, execute, timeoutMs, sshKeyProvider)), reused: false };
          } catch (error) {
            sshReadyScopes.delete(key);
            throw error;
          }
        }
        const remoteRoot = await prepareRemoteCopyDestination(codespace, remoteDestination, execute, timeoutMs, sshKeyProvider);
        const placements = selections.map((selection) => {
          const remotePath = safeAbsoluteRemotePath(posix.join(remoteRoot, selection.relativePath), `remote target for ${selection.relativePath}`);
          const parentRelativePath = posix.dirname(selection.relativePath) === '.' ? '' : posix.dirname(selection.relativePath);
          const remoteEndpoint = joinRemoteEndpoint(remoteDestination, selection.relativePath);
          const remoteParentEndpoint = joinRemoteEndpoint(remoteDestination, parentRelativePath);
          return { selection, remotePath, remoteEndpoint, remoteParent: safeAbsoluteRemotePath(posix.dirname(remotePath), `remote parent for ${selection.relativePath}`), remoteParentEndpoint };
        });
        await prepareRemoteCopyParents(codespace, placements.map((placement) => placement.remoteParent), execute, timeoutMs, sshKeyProvider);
        const sshKey = await sshKeyProvider();
        let retriedAfterReadinessRefresh = false;
        for (const placement of placements) {
          const command = ['codespace', 'cp', '-e'];
          if (placement.selection.directory) command.push('-r');
          command.push('-c', codespace);
          if (sshKey) command.push('--', '-i', sshKey);
          const destination = placement.selection.directory ? `${placement.remoteParentEndpoint.replace(/\/$/, '')}/` : placement.remoteEndpoint;
          command.push(placement.selection.path, destination);
          let execution;
          try {
            execution = await execute(command, { timeoutMs });
          } catch (error) {
            if (!wasReady || retriedAfterReadinessRefresh) throw error;
            sshReadyScopes.delete(key);
            readiness = { ...(await probeCodespaceSshReady(codespace, execute, timeoutMs, sshKeyProvider)), reused: false };
            retriedAfterReadinessRefresh = true;
            execution = await execute(command, { timeoutMs });
          }
        }
        return { codespaceId: codespace, sshReady: true, reusedSshReadiness: readiness.reused, retriedAfterReadinessRefresh, startupStdout: readiness.startupStdout, startupStderr: readiness.startupStderr, sourceDirectory: source.path, selected: selections.map((selection) => selection.relativePath), remoteDestination, resolvedRemoteDestination: remoteRoot, placements: placements.map(({ selection, remotePath, remoteEndpoint }) => ({ relativePath: selection.relativePath, remotePath, remoteEndpoint })), totalBytes: size.totalBytes, fileCount: size.fileCount };
      }
      case 'copy_from_codespace': {
        const codespace = safeCodespaceId(args.codespaceId);
        const remoteSource = safeRemoteEndpoint(args.remoteSource, 'remoteSource').endpoint;
        const destination = await existingLocalDestinationDirectory(args.localDestinationDirectory);
        const timeoutMs = timeout(args.timeoutMs);
        const key = readinessKey(codespace);
        const wasReady = sshReadyScopes.has(key);
        let readiness = { startupStdout: '', startupStderr: '', reused: wasReady };
        if (!wasReady) {
          try {
            readiness = { ...(await probeCodespaceSshReady(codespace, execute, timeoutMs, sshKeyProvider)), reused: false };
          } catch (error) {
            sshReadyScopes.delete(key);
            throw error;
          }
        }
        const sourceInfo = await inspectRemoteCopySource(codespace, remoteSource, execute, timeoutMs, sshKeyProvider);
        const localName = posix.basename(sourceInfo.remoteSource);
        const localTarget = resolve(destination.path, localName);
        if (!within(destination.path, localTarget)) throw new Error('remoteSource basename escapes localDestinationDirectory');
        await policy.assertToolArguments('copy_from_codespace', { localTarget }, destination.base);
        await destination.scoped.assertToolArguments('copy_from_codespace', { localTarget }, destination.base);
        let existing = null;
        try { existing = await lstat(localTarget); }
        catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
        if (existing?.isSymbolicLink()) throw new Error('local copy target may not be a symbolic link');
        if (existing) throw new Error(`local copy target already exists: ${localName}`);
        const command = ['codespace', 'cp', '-e'];
        if (sourceInfo.directory) command.push('-r');
        command.push('-c', codespace);
        const sshKey = await sshKeyProvider();
        if (sshKey) command.push('--', '-i', sshKey);
        command.push(remoteSource, destination.path);
        let execution;
        let retriedAfterReadinessRefresh = false;
        try {
          execution = await execute(command, { timeoutMs });
        } catch (error) {
          if (!wasReady) throw error;
          sshReadyScopes.delete(key);
          readiness = { ...(await probeCodespaceSshReady(codespace, execute, timeoutMs, sshKeyProvider)), reused: false };
          retriedAfterReadinessRefresh = true;
          execution = await execute(command, { timeoutMs });
        }
        const copiedInfo = await lstat(localTarget);
        if (copiedInfo.isSymbolicLink()) throw new Error('gh codespace cp produced a symbolic-link local target, which is not permitted');
        const copiedActual = await realpath(localTarget);
        if (!within(destination.path, copiedActual)) throw new Error('copied local target resolves outside localDestinationDirectory');
        return { codespaceId: codespace, sshReady: true, reusedSshReadiness: readiness.reused, retriedAfterReadinessRefresh, startupStdout: readiness.startupStdout, startupStderr: readiness.startupStderr, remoteSource: sourceInfo.remoteSource, localDestinationDirectory: destination.path, localPath: copiedActual, directory: sourceInfo.directory, totalBytes: sourceInfo.totalBytes, fileCount: sourceInfo.fileCount, entryCount: sourceInfo.entryCount, stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.exitCode };
      }
      case 'stop_codespace': {
        const codespace = safeCodespaceId(args.codespaceId);
        const timeoutMs = timeout(args.timeoutMs);
        const scopeKey = isolationScopeKey();
        const cancelledAsyncJobs = asyncJobs.cancelScopeCodespace(scopeKey, codespace);
        const cancelledForwardBootstraps = forwardBootstraps.cancelScopeCodespace(scopeKey, codespace);
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
        return { codespaceId: codespace, stopRequested: true, stopped: String(state ?? '').toLowerCase() === 'shutdown', state, stateCheckError, cancelledAsyncJobs, cancelledForwardBootstraps, stdout: execution.stdout, stderr: execution.stderr, exitCode: execution.exitCode };
      }
      case 'list_temporary_public_deployments': {
        const codespace = safeCodespaceId(args.codespaceId);
        const deployments = (await portsForCodespace(codespace, execute)).map((entry) => ({
          port: safePort(Number(entry.sourcePort), 'GitHub deployment port'),
          url: entry.browseUrl ?? null,
          browseUrl: entry.browseUrl ?? null,
          visibility: entry.visibility ?? null,
          label: entry.label ?? ''
        }));
        if (deployments.length === 0) {
          throw new Error('GitHub currently reports no temporary public deployment candidates for this Codespace. This is not a localhost or local-listening-port auto-detection result: this MCP does not scan localhost, local sockets, browser tabs, or local development servers, and it does not guess a port or synthesize a deployment URL. If you already know the exact Codespace port to publish, do not stop here: call codespace__open_temporary_public_deployment directly with that exact port; list_temporary_public_deployments is not a prerequisite. Do not substitute gh codespace ports forward, localhost probing, port scanning, or URL guessing.');
        }
        return { codespaceId: codespace, deployments };
      }
      case 'open_temporary_public_deployment': {
        const codespace = safeCodespaceId(args.codespaceId);
        const port = safePort(args.port, 'port');
        const timeoutMs = timeout(args.timeoutMs);
        const availability = await ensureCodespaceAvailable(codespace, execute, timeoutMs, sshKeyProvider);
        const scopeKey = isolationScopeKey();
        let forwardRecord = null;
        let bootstrapStarted = false;
        try {
          let selected = selectedForwardedPort(await portsForCodespace(codespace, execute, Math.min(timeoutMs, 30_000)), port);
          if (!selected) {
            const bootstrap = await forwardBootstraps.ensure(scopeKey, codespace, port);
            forwardRecord = bootstrap.record;
            bootstrapStarted = bootstrap.started;
            selected = await waitForForwardedPort(codespace, port, execute, forwardRecord, timeoutMs, sleep);
          }
          await execute(['codespace', 'ports', 'visibility', `${port}:public`, '-c', codespace], { timeoutMs });
          const after = selectedForwardedPort(await portsForCodespace(codespace, execute, Math.min(timeoutMs, 30_000)), port);
          if (!after) throw new Error(`Codespace port ${port} disappeared from GitHub Codespaces deployment metadata while it was being made public`);
          if (String(after.visibility).toLowerCase() !== 'public') throw new Error(`Codespace port ${port} did not become public; current visibility is ${after.visibility ?? 'unknown'}`);
          if (typeof after.browseUrl !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+\.app\.github\.dev\/?$/i.test(after.browseUrl)) throw new Error(`Codespace port ${port} did not return a valid GitHub browseUrl`);
          return { codespaceId: codespace, port, wokeCodespace: availability.woke, bootstrapForwarding: forwardRecord !== null, bootstrapStarted, url: after.browseUrl, browseUrl: after.browseUrl, visibility: after.visibility, label: after.label ?? '' };
        } catch (error) {
          if (forwardRecord) forwardBootstraps.cancel(scopeKey, codespace, port);
          throw error;
        }
      }
      case 'close_temporary_public_deployment': {
        const codespace = safeCodespaceId(args.codespaceId);
        const port = safePort(args.port, 'port');
        const timeoutMs = timeout(args.timeoutMs);
        const scopeKey = isolationScopeKey();
        let after = null;
        let cancelledForwardBootstrap = false;
        try {
          await execute(['codespace', 'ports', 'visibility', `${port}:private`, '-c', codespace], { timeoutMs });
          after = selectedForwardedPort(await portsForCodespace(codespace, execute, Math.min(timeoutMs, 30_000)), port);
        } finally {
          cancelledForwardBootstrap = forwardBootstraps.cancel(scopeKey, codespace, port);
        }
        if (!after) return { codespaceId: codespace, port, visibility: 'private', closedPublicAccess: true, browseUrl: null, cancelledForwardBootstrap };
        if (String(after.visibility).toLowerCase() !== 'private') throw new Error(`Codespace port ${port} did not become private; current visibility is ${after.visibility ?? 'unknown'}`);
        return { codespaceId: codespace, port, visibility: after.visibility, closedPublicAccess: true, browseUrl: after.browseUrl ?? null, cancelledForwardBootstrap };
      }
      default: throw new Error(`Unknown tool: ${name}`);
    }
  };

  const handle = async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return protocolError(request?.id, -32600, 'Invalid Request');
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'initialize') {
      initialized = true;
      return response(request.id, { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'codespace', version: SERVER_VERSION }, instructions: 'Controls existing GitHub Codespaces only. There is intentionally no create/start/delete/rebuild/edit tool. Existing Codespaces can be started implicitly by SSH/copy and explicitly stopped with stop_codespace. Use list_codespaces first and pass its name as codespaceId. SSH accepts only strictly validated token arrays. Prefer codespace__run_bash_script for arbitrary code, multiple commands, shell operators, pipelines, redirection, variable expansion, quoting-heavy commands, or other shell-oriented work instead of assembling the older ssh + write_async_stdin workflow. codespace__run_bash_script transports UTF-8 Bash source only over SSH stdin to a fixed remote Node.js supervisor. The supervisor reads the complete source into a private temporary script, then spawns /bin/bash with runtime stdin closed and supervises the detached Bash process group, so commands cannot consume source bytes, stdin readers receive EOF, and cancellation/termination can tear descendants down. It always returns an asyncId immediately. Other execution tools expose async and syncWaitMs separately. async=true returns an asyncId immediately and syncWaitMs is ignored. Otherwise syncWaitMs controls only the synchronous MCP response wait, defaults to 10000 ms, and never changes the underlying timeoutMs. If the operation is still running when syncWaitMs expires, it continues in the shared async registry and an asyncId is returned. syncWaitMs values from 0 through 1000 ms are treated as immediate async mode. Call codespace__get_async_status with no asyncId to see all retained async operations in the current isolation, or pass one asyncId to retrieve complete retained status: stdout/stderr for process-backed jobs and the final structured result/error for automatically promoted compound tool calls. get_async_logs remains only as a compatibility process-log API. The async registry is process-local and reports serverInstanceId; after an MCP crash/restart older asyncIds are unrecoverable rather than being guessed as completed. wait_async remains implemented for compatibility but may be blocked by Gateway configuration. search_text always requires a /workspaces/<workspace> searchBase. Copy requires the caller to write remote: explicitly and never inserts it automatically. copy_to_codespace preserves each selected path relative to sourceDirectory under the explicitly remote: destination; copy_from_codespace accepts one explicitly remote: source below /workspaces/<workspace> and one local signed-workspace destination directory. Each copy direction requires exactly one remote: endpoint. Temporary public deployment tools operate only on exact caller-specified Codespace ports and return browseUrl. If the exact port is known, call open_temporary_public_deployment directly; list_temporary_public_deployments is not a prerequisite. If GitHub does not yet list that exact port, open_temporary_public_deployment starts gh codespace ports forward PORT:PORT as a managed bootstrap, waits for GitHub to register it, then makes it public. The managed forward stays alive until close, stop, ownership transfer, or its bounded lifetime. These tools never scan localhost, inspect local listening sockets or browser tabs, auto-detect ports, or guess a replacement port.' });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        const toolName = request.params?.name;
        const asyncControlTools = new Set(['get_async_status', 'get_async_logs', 'write_async_stdin', 'wait_async', 'cancel_async']);
        const result = await isolation.run(request.params?.arguments ?? {}, (toolArguments) => {
          if (asyncControlTools.has(toolName) || toolName === 'run_bash_script') return callTool(toolName, toolArguments);
          if (!RESPONSE_MODE_TOOL_NAMES.has(toolName)) return callTool(toolName, toolArguments);
          const mode = responseMode(toolArguments);
          const callArguments = toolName === 'ssh' && mode.immediateAsync
            ? { ...toolArguments, async: true }
            : toolArguments;
          const promise = callTool(toolName, callArguments);
          if (toolName === 'ssh' && mode.immediateAsync) {
            return Promise.resolve(promise).then((value) => ({
              ...value,
              asyncRequested: mode.asyncRequested,
              syncWaitMs: mode.syncWaitMs,
              autoPromoted: !mode.asyncRequested,
              promotedAfterMs: 0
            }));
          }
          return asyncTasks.resolveOrPromote({
            operation: toolName,
            codespaceId: typeof toolArguments.codespaceId === 'string' ? toolArguments.codespaceId : null,
            promise,
            mode
          });
        });
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
