import { spawn } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnvironment } from '../../app/child-environment.mjs';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { normalizeDisallowedPathGlobs } from '../../app/path-glob.mjs';
import { ToolPathPolicy } from '../../app/path-policy.mjs';

const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const MAX_ARGUMENTS = Number(process.env.CODEX_SCRIPT_MAX_ARGUMENTS ?? 64);
const MAX_ARGUMENT_BYTES = Number(process.env.CODEX_SCRIPT_MAX_ARGUMENT_BYTES ?? 4096);
const MAX_OUTPUT_BYTES = Number(process.env.CODEX_SCRIPT_MAX_OUTPUT_BYTES ?? 1024 * 1024);
const DEFAULT_TIMEOUT_MS = Number(process.env.CODEX_SCRIPT_DEFAULT_TIMEOUT_MS ?? 30_000);
const MAX_TIMEOUT_MS = Number(process.env.CODEX_SCRIPT_MAX_TIMEOUT_MS ?? 600_000);
const MAX_CHECK_FILES = Number(process.env.CODEX_SCRIPT_MAX_CHECK_FILES ?? 500);
const SERVER_VERSION = '0.1.0';
const cli = { help: process.argv.slice(2).some((value) => value === '--help' || value === '-h') };
const MODES = new Set(['run', 'check']);

function nodePermissionArgv(roots, { allowWrite }) {
  const args = ['--permission'];
  for (const root of roots) {
    args.push(`--allow-fs-read=${root}`);
    if (allowWrite) args.push(`--allow-fs-write=${root}`);
  }
  return args;
}

const RUNTIME_SPECS = {
  mjs: {
    label: 'ECMAScript module',
    extensions: ['.mjs'],
    argvPrefix: (roots) => nodePermissionArgv(roots, { allowWrite: true })
  },
  nodejs: {
    label: 'Node.js',
    extensions: ['.js', '.cjs', '.mjs'],
    argvPrefix: (roots) => nodePermissionArgv(roots, { allowWrite: true })
  },
  python: {
    label: 'Python',
    extensions: ['.py'],
    argvPrefix: () => ['-I']
  },
  php: {
    label: 'PHP',
    extensions: ['.php'],
    argvPrefix: () => []
  }
};

const CHECK_SPECS = {
  nodejs: {
    label: 'Node.js --check',
    extensions: ['.js', '.cjs', '.mjs'],
    argvPrefix: (roots) => [...nodePermissionArgv(roots, { allowWrite: false }), '--check']
  },
  python: {
    label: 'Python py_compile',
    extensions: ['.py'],
    argvPrefix: () => ['-I', '-B', '-m', 'py_compile']
  },
  php: {
    label: 'PHP -l',
    extensions: ['.php'],
    argvPrefix: () => ['-l']
  }
};

function parseMode() {
  const modeArgument = process.argv.slice(2).find((value) => value.startsWith('--mode='));
  const mode = modeArgument === undefined ? 'run' : modeArgument.slice('--mode='.length);
  if (!MODES.has(mode)) throw new Error('--mode must be one of: run, check');
  return mode;
}

function parseRuntime() {
  const runtimeArgument = process.argv.slice(2).find((value) => value.startsWith('--runtime='));
  const runtime = runtimeArgument === undefined ? (mode === 'check' ? 'nodejs' : 'mjs') : runtimeArgument.slice('--runtime='.length);
  if (!Object.hasOwn(RUNTIME_SPECS, runtime)) {
    throw new Error(`--runtime must be one of: ${Object.keys(RUNTIME_SPECS).join(', ')}`);
  }
  return runtime;
}

const HELP = `codex-script MCP

Usage:
  node mcp/codex-script/server.mjs --mode=run --runtime=mjs --runtime-executable=<absolute-node-path>
  node mcp/codex-script/server.mjs --mode=check --runtime=nodejs --runtime-executable=<absolute-node-path>

Runs one existing script with literal argv, or checks one existing source file, using the runtime selected at MCP startup.
This server is intended to be launched from gateway.toml with sandbox = "elevated" or "unelevated".
The gateway starts this MCP itself inside that Codex sandbox once.
Each run/check starts only the fixed runtime as a child of the already-sandboxed MCP process.
Node.js runtimes enable the Node Permission Model, allow workspace file access, and do not grant child-process permission.

Options:
  --mode=run|check
  --runtime=mjs|nodejs|python|php
  --runtime-executable=<absolute-path>
`;

for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') continue;
  if (argument.startsWith('--mode=')) continue;
  if (argument.startsWith('--runtime=')) continue;
  if (argument.startsWith('--runtime-executable=')) continue;
  throw new Error(`Unknown argument: ${argument}`);
}
const mode = cli.help ? 'run' : parseMode();
const runtime = cli.help ? 'mjs' : parseRuntime();
const runtimeSpec = RUNTIME_SPECS[runtime];
const checkSpec = CHECK_SPECS[runtime];
if (mode === 'check' && !checkSpec) throw new Error(`--mode=check supports only these --runtime values: ${Object.keys(CHECK_SPECS).join(', ')}`);

function parseAbsoluteCliPath(name) {
  if (cli.help) return null;
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (!argument) throw new Error(`--${name}=<absolute-path> is required`);
  const value = argument.slice(prefix.length);
  if (!value || !isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  if (process.platform === 'win32' && !/\.exe$/i.test(value)) throw new Error(`--${name} must point to a native .exe on Windows`);
  return value;
}

const runtimeExecutable = parseAbsoluteCliPath('runtime-executable');

let runtimeExecutablePromise = null;

async function canonicalRuntimeExecutable() {
  runtimeExecutablePromise ??= (async () => {
    const info = await lstat(runtimeExecutable);
    const actual = await realpath(runtimeExecutable);
    const actualInfo = info.isSymbolicLink() ? await stat(actual) : info;
    if (!actualInfo.isFile()) throw new Error('--runtime-executable must point to a regular file');
    return actual;
  })();
  return runtimeExecutablePromise;
}

function pathArray(name, fallback = []) {
  if (cli.help) return [];
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`${name} must contain a JSON string array`);
  }
  return parsed;
}

const configuredAllowedDirectories = pathArray('LOCAL_MCP_ALLOWED_DIRECTORIES', [process.cwd()]);
const configuredAllowedFiles = pathArray('LOCAL_MCP_ALLOWED_FILES');
const configuredDisallowedDirectories = pathArray('LOCAL_MCP_DISALLOWED_DIRECTORIES');
const configuredDisallowedFiles = pathArray('LOCAL_MCP_DISALLOWED_FILES');
const configuredDisallowedPathGlobs = cli.help ? [] : normalizeDisallowedPathGlobs(
  pathArray('LOCAL_MCP_DISALLOWED_PATH_GLOBS'),
  'LOCAL_MCP_DISALLOWED_PATH_GLOBS'
);
const isolation = createBundledIsolation();
const policy = new ToolPathPolicy({
  serverName: 'codex-script',
  cwd: process.cwd(),
  allowedDirectories: configuredAllowedDirectories,
  allowedFiles: configuredAllowedFiles,
  disallowedDirectories: configuredDisallowedDirectories,
  disallowedFiles: configuredDisallowedFiles,
  disallowedPathGlobs: configuredDisallowedPathGlobs
});
let standaloneWorkingDirectoryPromise = null;

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } },
  required: ['ok'],
  additionalProperties: false
};
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_STATE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const toolResult = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  isError
});

const commonSchemas = [
  {
    name: 'roots',
    description: 'List the verified signed roots and current base for this script runner. Security: reports only Gateway-controlled context and configured allow/deny rules.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'get_working_directory',
    description: 'Return the current base used to resolve relative script and cwd paths. Security: in Gateway mode this is the signed isolation base.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'set_working_directory',
    description: 'Change the relative-path base to an existing allowed directory. Security: the target must stay inside a signed root and pass all deny rules.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: LOCAL_STATE_ANNOTATIONS
  }
];

const scriptSchema = {
  name: 'run_script',
  description: `Run one existing ${runtimeSpec.label} script with literal argv using the fixed ${runtime} runtime selected at MCP startup. Security: no shell, no arbitrary executable, no environment injection, stdin closed, timeout enforced, output bounded, paths checked against signed roots and configured allow/deny rules.`,
  inputSchema: {
    type: 'object',
    properties: {
      scriptPath: { type: 'string', minLength: 1 },
      executionReason: {
        type: 'string',
        minLength: 10,
        description: 'Explain in detail why this script execution is required for the user-requested goal X or the current task, and why the existing higher-level MCP tools are insufficient.'
      },
      scriptSafety: {
        type: 'string',
        minLength: 10,
        description: 'Describe the script\'s behavior, relevant effects, and safety considerations objectively enough to justify executing it.'
      },
      args: { type: 'array', items: { type: 'string', maxLength: MAX_ARGUMENT_BYTES }, maxItems: MAX_ARGUMENTS, default: [] },
      cwd: { type: 'string', minLength: 1 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
      maxOutputBytes: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_BYTES, default: MAX_OUTPUT_BYTES }
    },
    required: ['scriptPath', 'executionReason', 'scriptSafety'],
    additionalProperties: false
  },
  outputSchema: TOOL_OUTPUT_SCHEMA,
  annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
};

const checkSchema = {
  name: 'check_file',
  description: `Check one or more existing ${checkSpec?.label ?? runtime} source files using the fixed ${runtime} checker selected at MCP startup. Successful checker stdio is omitted; only failed files are returned in messages. Security: no shell, no npm scripts, no package manager, no arbitrary checker executable, stdin closed, timeout enforced, output bounded, and every file/cwd is checked against signed roots plus configured allow/deny rules before execution.`,
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', minLength: 1, description: 'Absolute path, or path relative to the current working directory, for the source file to check.' },
      filePaths: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_CHECK_FILES,
        items: { type: 'string', minLength: 1 },
        description: 'Absolute paths, or paths relative to the current working directory, for source files to check.'
      },
      cwd: { type: 'string', minLength: 1 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS },
      maxOutputBytes: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT_BYTES, default: MAX_OUTPUT_BYTES }
    },
    oneOf: [
      { required: ['filePath'], not: { required: ['filePaths'] } },
      { required: ['filePaths'], not: { required: ['filePath'] } }
    ],
    additionalProperties: false
  },
  outputSchema: TOOL_OUTPUT_SCHEMA,
  annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
};

const schemas = [
  ...commonSchemas,
  mode === 'check' ? checkSchema : scriptSchema
];

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function contextBase() {
  const current = isolation.current();
  if (current) return current.base;
  standaloneWorkingDirectoryPromise ??= policy.selectAllowedDirectories([process.cwd()]).then((roots) => {
    if (!roots[0]) throw new Error('The process cwd is outside this MCP allowlist; set cwd to an allowed directory');
    return roots[0];
  });
  return standaloneWorkingDirectoryPromise;
}

async function contextRoots() {
  const current = isolation.current();
  if (current) return [...current.roots];
  return policy.selectAllowedDirectories(configuredAllowedDirectories.length > 0 ? configuredAllowedDirectories : [process.cwd()]);
}

function rejectAmbiguousPathSyntax(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} may not contain NUL or line breaks`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error(`${label} must be a filesystem path, not a URL`);
  if (/%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value)) throw new Error(`${label} may not contain environment-variable syntax`);
  if (process.platform === 'win32') {
    const normalized = value.replace(/\//g, '\\');
    if (/^[A-Za-z]:(?!\\)/.test(normalized)) throw new Error(`${label} may not use drive-relative Windows syntax`);
    if (/^\\(?!\\)/.test(normalized)) throw new Error(`${label} may not use root-relative Windows syntax`);
    if (/^\\\\[?.]\\/i.test(normalized)) throw new Error(`${label} may not use Windows namespace paths`);
    if (/^\\\\/.test(normalized)) throw new Error(`${label} may not use UNC paths`);
    const withoutDrive = normalized.replace(/^[A-Za-z]:/, '');
    if (withoutDrive.includes(':')) throw new Error(`${label} may not use NTFS alternate data streams`);
  }
}

async function resolveExistingPath(value, { label, base, roots, requireDirectory = false, requireFile = false }) {
  rejectAmbiguousPathSyntax(value, label);
  const lexical = resolve(isAbsolute(value) ? value : join(base, value));
  await policy.assertToolArguments(label, { [label]: lexical }, base);
  const isolationPolicy = new ToolPathPolicy({ serverName: 'codex-script-isolation', cwd: base, allowedDirectories: roots });
  await isolationPolicy.allowed();
  await isolationPolicy.assertToolArguments(label, { [label]: lexical }, base);
  await lstat(lexical);
  const actual = await realpath(lexical);
  if (!roots.some((root) => within(root, actual))) throw new Error(`${label} resolved outside signed roots after symlink resolution`);
  await policy.assertToolArguments(label, { [label]: actual }, base);
  await isolationPolicy.assertToolArguments(label, { [label]: actual }, base);
  const actualInfo = await stat(actual);
  if (requireDirectory && !actualInfo.isDirectory()) throw new Error(`${label} is not a directory`);
  if (requireFile && !actualInfo.isFile()) throw new Error(`${label} is not a file`);
  return actual;
}

function validateArguments(args) {
  if (args === undefined) return [];
  if (!Array.isArray(args) || args.length > MAX_ARGUMENTS) throw new Error(`args must be an array of at most ${MAX_ARGUMENTS} strings`);
  return args.map((value, index) => {
    if (typeof value !== 'string') throw new Error(`args[${index}] must be a string`);
    if (value.includes('\0')) throw new Error(`args[${index}] may not contain NUL`);
    if (Buffer.byteLength(value, 'utf8') > MAX_ARGUMENT_BYTES) throw new Error(`args[${index}] exceeds ${MAX_ARGUMENT_BYTES} UTF-8 bytes`);
    return value;
  });
}


function boundedInteger(value, { name, fallback, min, max }) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) throw new Error(`${name} must be an integer from ${min} through ${max}`);
  return resolved;
}

async function rootsPayload() {
  const roots = await contextRoots();
  const base = await contextBase();
  const scope = isolation.current() ? await policy.describeForAllowedDirectories(roots, base) : await policy.describe(base);
  return { roots, base, workingDirectory: base, disallowedPathGlobs: configuredDisallowedPathGlobs, policy: scope };
}

async function assertSandboxPolicyRepresentable(roots, base) {
  if (configuredDisallowedPathGlobs.length > 0) {
    throw new Error('codex-script cannot safely enforce disallowed_path_globs inside arbitrary-code sandbox roots; remove the glob deny rules and narrow allowed_directories instead');
  }
}

async function runSandboxedCommand({ command, commandArgs, cwd, timeoutMs, maxOutputBytes, truncateOutput = false }) {
  if (configuredAllowedDirectories.some((root) => within(root, command))) {
    throw new Error('--runtime-executable must resolve outside configured writable roots');
  }
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let totalOutputBytes = 0;
  let outputTruncated = false;
  let overflowError = null;
  let child = null;
  let timeout = null;
  const collect = (streamName, chunk) => {
    if (overflowError) return;
    const current = streamName === 'stdout' ? stdout : stderr;
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    let acceptedChunk = nextChunk;
    if (truncateOutput) {
      const remaining = maxOutputBytes - totalOutputBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      if (nextChunk.length > remaining) outputTruncated = true;
      acceptedChunk = nextChunk.subarray(0, remaining);
      totalOutputBytes += acceptedChunk.length;
    } else if (current.length + nextChunk.length > maxOutputBytes) {
      overflowError = new Error(`${streamName} exceeded ${maxOutputBytes} bytes`);
      if (child && child.exitCode === null && !child.killed) child.kill();
      return;
    }
    const next = Buffer.concat([current, acceptedChunk]);
    if (streamName === 'stdout') stdout = next;
    else stderr = next;
  };
  try {
    child = spawn(command, commandArgs, {
      cwd,
      env: buildChildEnvironment({}, environmentWithoutBundledIsolationKey()),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    const exit = await new Promise((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', (exitCode, signal) => resolveExit({ exitCode, signal }));
      timeout = setTimeout(() => {
        if (child.exitCode !== null || child.killed) return;
        child.kill();
        rejectExit(new Error(`script/check timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    if (overflowError) throw overflowError;
    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      outputTruncated
    };
  } catch (error) {
    if (overflowError) throw overflowError;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (child && child.exitCode === null && !child.killed) child.kill();
  }
}

async function runScript(args) {
  if (mode !== 'run') throw new Error('run_script is available only when this MCP is started with --mode=run');
  if (typeof args.executionReason !== 'string' || args.executionReason.trim().length < 10) {
    throw new Error('executionReason is required and must contain at least 10 non-whitespace characters');
  }
  if (typeof args.scriptSafety !== 'string' || args.scriptSafety.trim().length < 10) {
    throw new Error('scriptSafety is required and must contain at least 10 non-whitespace characters');
  }
  const base = await contextBase();
  const roots = await contextRoots();
  await assertSandboxPolicyRepresentable(roots, base);
  const scriptPath = await resolveExistingPath(args.scriptPath, { label: 'scriptPath', base, roots, requireFile: true });
  const extension = extname(scriptPath).toLowerCase();
  if (!runtimeSpec.extensions.includes(extension)) {
    throw new Error(`run_script for runtime=${runtime} accepts only: ${runtimeSpec.extensions.join(', ')}`);
  }
  const cwd = args.cwd === undefined
    ? await resolveExistingPath(base, { label: 'cwd', base, roots, requireDirectory: true })
    : await resolveExistingPath(args.cwd, { label: 'cwd', base, roots, requireDirectory: true });
  const argv = validateArguments(args.args);
  const timeoutMs = boundedInteger(args.timeoutMs, { name: 'timeoutMs', fallback: DEFAULT_TIMEOUT_MS, min: 1, max: MAX_TIMEOUT_MS });
  const maxOutputBytes = boundedInteger(args.maxOutputBytes, { name: 'maxOutputBytes', fallback: MAX_OUTPUT_BYTES, min: 1, max: MAX_OUTPUT_BYTES });
  const executable = await canonicalRuntimeExecutable();
  const execution = await runSandboxedCommand({
    command: executable,
    commandArgs: [...runtimeSpec.argvPrefix(roots), scriptPath, ...argv],
    cwd,
    timeoutMs,
    maxOutputBytes
  });
  return {
    scriptPath,
    runtime,
    cwd,
    args: argv,
    timeoutMs,
    maxOutputBytes,
    ...execution
  };
}

async function checkFile(args) {
  if (mode !== 'check') throw new Error('check_file is available only when this MCP is started with --mode=check');
  const base = await contextBase();
  const roots = await contextRoots();
  const cwd = args.cwd === undefined
    ? await resolveExistingPath(base, { label: 'cwd', base, roots, requireDirectory: true })
    : await resolveExistingPath(args.cwd, { label: 'cwd', base, roots, requireDirectory: true });
  const timeoutMs = boundedInteger(args.timeoutMs, { name: 'timeoutMs', fallback: DEFAULT_TIMEOUT_MS, min: 1, max: MAX_TIMEOUT_MS });
  const maxOutputBytes = boundedInteger(args.maxOutputBytes, { name: 'maxOutputBytes', fallback: MAX_OUTPUT_BYTES, min: 1, max: MAX_OUTPUT_BYTES });
  const hasFilePath = typeof args.filePath === 'string';
  const hasFilePaths = Array.isArray(args.filePaths);
  if (hasFilePath === hasFilePaths) throw new Error('check_file requires exactly one of filePath or filePaths');
  const requestedPaths = args.filePaths ?? [args.filePath];
  if (!Array.isArray(requestedPaths) || requestedPaths.length < 1 || requestedPaths.length > MAX_CHECK_FILES) {
    throw new Error(`filePaths must contain from 1 through ${MAX_CHECK_FILES} files`);
  }
  const filePaths = [];
  for (let index = 0; index < requestedPaths.length; index += 1) {
    const filePath = await resolveExistingPath(requestedPaths[index], {
      label: `filePaths[${index}]`,
      base,
      roots,
      requireFile: true
    });
    const extension = extname(filePath).toLowerCase();
    if (!checkSpec.extensions.includes(extension)) {
      throw new Error(`check_file for runtime=${runtime} accepts only: ${checkSpec.extensions.join(', ')}`);
    }
    filePaths.push(filePath);
  }
  const executable = await canonicalRuntimeExecutable();
  const perFileOutputBytes = Math.max(1, Math.floor(maxOutputBytes / filePaths.length));
  let pass = 0;
  const messages = [];
  for (const filePath of filePaths) {
    try {
      const execution = await runSandboxedCommand({
        command: executable,
        commandArgs: [...checkSpec.argvPrefix(roots), filePath],
        cwd,
        timeoutMs,
        maxOutputBytes: perFileOutputBytes,
        truncateOutput: true
      });
      if (execution.exitCode === 0 && execution.signal === null) {
        pass += 1;
        continue;
      }
      messages.push({
        filePath,
        exitCode: execution.exitCode,
        signal: execution.signal,
        stdout: execution.stdout,
        stderr: execution.stderr,
        outputTruncated: execution.outputTruncated
      });
    } catch (error) {
      messages.push({
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { pass, fault: messages.length, messages };
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'roots': return rootsPayload();
    case 'get_working_directory': return { workingDirectory: await contextBase() };
    case 'set_working_directory': {
      const base = await contextBase();
      const roots = await contextRoots();
      const target = await resolveExistingPath(args.path, { label: 'path', base, roots, requireDirectory: true });
      if (!isolation.current()) standaloneWorkingDirectoryPromise = Promise.resolve(target);
      return { workingDirectory: target };
    }
    case 'run_script': return runScript(args);
    case 'check_file': return checkFile(args);
    default: throw new Error(`Unknown tool: ${name}`);
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
        serverInfo: { name: 'codex-script', version: SERVER_VERSION },
        instructions: mode === 'check' ? `Strict ${runtime} checker. Requires gateway sandbox=elevated or sandbox=unelevated; the MCP itself runs inside that Codex sandbox and each check inherits the same sandbox as a direct child process.` : `Strict ${runtime} runner. Requires gateway sandbox=elevated or sandbox=unelevated; the MCP itself runs inside that Codex sandbox and each script inherits the same sandbox as a direct child process.`
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        const result = await isolation.run(request.params?.arguments ?? {}, (toolArguments) => callTool(request.params?.name, toolArguments));
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
  if (cli.help) process.stdout.write(HELP);
  else await startStdio();
}
