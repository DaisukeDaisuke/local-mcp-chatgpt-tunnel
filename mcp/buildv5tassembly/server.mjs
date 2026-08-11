// Sandboxed ARMv5T build MCP: preprocesses one assembly source using the legacy
// assembly.php rules, then invokes only fixed arm-none-eabi-gcc and objcopy
// executables with a fixed BIOS_ARM9/ARMv5T build pipeline. It is intentionally
// not a general command runner and requires absolute input/output paths.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildChildEnvironment } from '../../app/child-environment.mjs';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { normalizeDisallowedPathGlobs } from '../../app/path-glob.mjs';
import { ToolPathPolicy } from '../../app/path-policy.mjs';

const SERVER_VERSION = '0.1.0';
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const OUTPUT_NAMES = Object.freeze([
  'generated_output.S',
  'debugger.txt',
  'arm9.list',
  'arm9.o',
  'arm9.bin'
]);
const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const cli = { help: process.argv.slice(2).some((value) => value === '--help' || value === '-h') };

const HELP = `buildv5tassembly MCP\n\nUsage:\n  node mcp/buildv5tassembly/server.mjs --preprocessor-module=<absolute-path> --gcc-executable=<absolute-path> --objcopy-executable=<absolute-path>\n\nBuilds exactly one ARMv5T assembly source through the fixed pipeline:\n  preprocess -> arm-none-eabi-gcc -DBIOS_ARM9 -march=armv5t -mlittle-endian -c -Wa,-asl=arm9.list -o arm9.o\n  arm-none-eabi-objcopy -O binary arm9.o arm9.bin\n\nThe preprocessing implementation is fixed at MCP startup and must export preprocessAssemblySource(source, baseAddress). All path arguments are absolute.\n`;

for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') continue;
  if (argument.startsWith('--preprocessor-module=')) continue;
  if (argument.startsWith('--gcc-executable=')) continue;
  if (argument.startsWith('--objcopy-executable=')) continue;
  throw new Error(`Unknown argument: ${argument}`);
}

function parseAbsoluteExecutable(name) {
  if (cli.help) return null;
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (!argument) throw new Error(`${prefix}<absolute-path> is required`);
  const value = argument.slice(prefix.length);
  if (!isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  if (process.platform === 'win32' && !/\.exe$/i.test(value)) throw new Error(`--${name} must point to a native .exe on Windows`);
  return value;
}

function parseAbsolutePathArgument(name) {
  if (cli.help) return null;
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (!argument) throw new Error(`${prefix}<absolute-path> is required`);
  const value = argument.slice(prefix.length);
  if (!isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  return value;
}

const preprocessorModulePath = parseAbsolutePathArgument('preprocessor-module');
const gccExecutable = parseAbsoluteExecutable('gcc-executable');
const objcopyExecutable = parseAbsoluteExecutable('objcopy-executable');

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
  serverName: 'buildv5tassembly',
  cwd: process.cwd(),
  allowedDirectories: configuredAllowedDirectories,
  allowedFiles: configuredAllowedFiles,
  disallowedDirectories: configuredDisallowedDirectories,
  disallowedFiles: configuredDisallowedFiles,
  disallowedPathGlobs: configuredDisallowedPathGlobs
});

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
const BUILD_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false
};
const toolResult = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  isError
});

const schemas = [{
  name: 'build',
  description: 'Build one absolute-path ARMv5T assembly source with the translated assembly.php preprocessing rules and fixed GCC/objcopy options. The address used to begin label/branch resolution is supplied directly as hexadecimal baseAddress. Security: fixed executables, fixed compiler arguments, no shell, no arbitrary environment, bounded UTF-8 input/output, signed workspace roots, and sandboxed filesystem/network access.',
  inputSchema: {
    type: 'object',
    properties: {
      sourcePath: { type: 'string', minLength: 1, description: 'Absolute path to the input assembly source, such as main.S.' },
      baseAddress: { type: 'string', pattern: '^0[xX][0-9A-Fa-f]{1,8}$', description: 'Hexadecimal address where assembly address resolution begins, for example 0x020F9104.' },
      outputDirectory: { type: 'string', minLength: 1, description: 'Absolute existing directory where the five fixed build outputs are written.' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, default: DEFAULT_TIMEOUT_MS }
    },
    required: ['sourcePath', 'baseAddress', 'outputDirectory'],
    additionalProperties: false
  },
  outputSchema: TOOL_OUTPUT_SCHEMA,
  annotations: BUILD_ANNOTATIONS
}];

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function rejectAmbiguousAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty absolute path`);
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${label} may not contain NUL or line breaks`);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error(`${label} must be a filesystem path, not a URL`);
  if (/%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value)) throw new Error(`${label} may not contain environment-variable syntax`);
  if (process.platform === 'win32') {
    const normalized = value.replace(/\//g, '\\');
    if (/^\\\\[?.]\\/i.test(normalized)) throw new Error(`${label} may not use Windows namespace paths`);
    if (/^\\\\/.test(normalized)) throw new Error(`${label} may not use UNC paths`);
    const withoutDrive = normalized.replace(/^[A-Za-z]:/, '');
    if (withoutDrive.includes(':')) throw new Error(`${label} may not use NTFS alternate data streams`);
  }
}

async function contextRoots() {
  const current = isolation.current();
  if (current) return [...current.roots];
  return await policy.selectAllowedDirectories(configuredAllowedDirectories.length > 0 ? configuredAllowedDirectories : [process.cwd()]);
}

async function resolveExistingAbsolute(value, { label, roots, type }) {
  rejectAmbiguousAbsolutePath(value, label);
  const lexical = resolve(value);
  await policy.assertToolArguments(label, { [label]: lexical }, process.cwd());
  const isolationPolicy = new ToolPathPolicy({ serverName: 'buildv5tassembly-isolation', cwd: roots[0], allowedDirectories: roots });
  await isolationPolicy.allowed();
  await isolationPolicy.assertToolArguments(label, { [label]: lexical }, roots[0]);
  const info = await lstat(lexical);
  if (info.isSymbolicLink()) throw new Error(`${label} may not be a symbolic link`);
  const actual = await realpath(lexical);
  if (!roots.some((root) => within(root, actual))) throw new Error(`${label} resolves outside the signed workspace roots`);
  await policy.assertToolArguments(label, { [label]: actual }, process.cwd());
  await isolationPolicy.assertToolArguments(label, { [label]: actual }, roots[0]);
  const actualInfo = await stat(actual);
  if (type === 'file' && !actualInfo.isFile()) throw new Error(`${label} must point to a regular file`);
  if (type === 'directory' && !actualInfo.isDirectory()) throw new Error(`${label} must point to an existing directory`);
  return actual;
}

function decodeUtf8Strict(bytes, label) {
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error(`${label} exceeds ${MAX_SOURCE_BYTES} bytes`);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new Error(`${label} is UTF-16; convert it to UTF-8 first`);
  }
  if ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00)
      || (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)) {
    throw new Error(`${label} is UTF-32; convert it to UTF-8 first`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${error.message}`);
  }
}

function parseHexAddress(text, label, { requirePrefix = false } = {}) {
  const valueText = String(text).trim();
  if (requirePrefix && !/^0x/i.test(valueText)) throw new Error(`${label} must start with 0x`);
  const normalized = valueText.replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(normalized)) throw new Error(`${label} must contain one hexadecimal address`);
  const value = Number.parseInt(normalized, 16);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${label} is outside uint32 range`);
  return value >>> 0;
}

let preprocessorPromise = null;
async function fixedPreprocessor(roots) {
  preprocessorPromise ??= (async () => {
    const info = await lstat(preprocessorModulePath);
    if (info.isSymbolicLink()) throw new Error('--preprocessor-module may not be a symbolic link');
    const actual = await realpath(preprocessorModulePath);
    if (!(await stat(actual)).isFile()) throw new Error('--preprocessor-module must point to a regular file');
    const imported = await import(pathToFileURL(actual).href);
    if (typeof imported.preprocessAssemblySource !== 'function') {
      throw new Error('--preprocessor-module must export preprocessAssemblySource(source, baseAddress)');
    }
    return { path: actual, preprocessAssemblySource: imported.preprocessAssemblySource };
  })();
  const preprocessor = await preprocessorPromise;
  if (roots.some((root) => within(root, preprocessor.path))) {
    throw new Error('--preprocessor-module must resolve outside signed writable workspace roots');
  }
  return preprocessor;
}

async function canonicalExecutable(pathValue, label) {
  const info = await lstat(pathValue);
  if (info.isSymbolicLink()) throw new Error(`${label} may not be a symbolic link`);
  const actual = await realpath(pathValue);
  if (!(await stat(actual)).isFile()) throw new Error(`${label} must point to a regular file`);
  return actual;
}

let executablesPromise = null;
async function fixedExecutables(roots) {
  executablesPromise ??= Promise.all([
    canonicalExecutable(gccExecutable, '--gcc-executable'),
    canonicalExecutable(objcopyExecutable, '--objcopy-executable')
  ]).then(([gcc, objcopy]) => ({ gcc, objcopy }));
  const executables = await executablesPromise;
  for (const [label, executable] of Object.entries(executables)) {
    if (roots.some((root) => within(root, executable))) {
      throw new Error(`${label} executable must resolve outside signed writable workspace roots`);
    }
  }
  return executables;
}

function boundedTimeout(value) {
  const resolved = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}`);
  }
  return resolved;
}

async function runFixedProcess(command, args, cwd, timeoutMs) {
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let child = null;
  let timer = null;
  let overflow = null;
  const collect = (name, chunk) => {
    if (overflow) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    const current = name === 'stdout' ? stdout : stderr;
    if (current.length + bytes.length > MAX_OUTPUT_BYTES) {
      overflow = new Error(`${name} exceeded ${MAX_OUTPUT_BYTES} bytes`);
      if (child && child.exitCode === null && !child.killed) child.kill();
      return;
    }
    if (name === 'stdout') stdout = Buffer.concat([stdout, bytes]);
    else stderr = Buffer.concat([stderr, bytes]);
  };
  try {
    child = spawn(command, args, {
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
      timer = setTimeout(() => {
        if (child.exitCode !== null || child.killed) return;
        child.kill();
        rejectExit(new Error(`build process timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    if (overflow) throw overflow;
    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8')
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (child && child.exitCode === null && !child.killed) child.kill();
  }
}

async function fileSummary(path) {
  const bytes = await readFile(path);
  return {
    path,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

async function build(args) {
  const roots = await contextRoots();
  if (roots.length === 0) throw new Error('No signed workspace root is available');
  const sourcePath = await resolveExistingAbsolute(args.sourcePath, { label: 'sourcePath', roots, type: 'file' });
  const outputDirectory = await resolveExistingAbsolute(args.outputDirectory, { label: 'outputDirectory', roots, type: 'directory' });
  const timeoutMs = boundedTimeout(args.timeoutMs);
  const executables = await fixedExecutables(roots);
  const preprocessor = await fixedPreprocessor(roots);

  const source = decodeUtf8Strict(await readFile(sourcePath), 'sourcePath');
  const baseAddress = parseHexAddress(args.baseAddress, 'baseAddress', { requirePrefix: true });
  const preprocessed = preprocessor.preprocessAssemblySource(source, baseAddress);
  const outputPaths = Object.fromEntries(OUTPUT_NAMES.map((name) => [name, join(outputDirectory, name)]));

  for (const pathValue of Object.values(outputPaths)) await rm(pathValue, { force: true });
  await writeFile(outputPaths['generated_output.S'], preprocessed.generatedSource, 'utf8');
  await writeFile(outputPaths['debugger.txt'], preprocessed.debuggerText, 'utf8');

  const gcc = await runFixedProcess(executables.gcc, [
    'generated_output.S',
    '-DBIOS_ARM9',
    '-march=armv5t',
    '-mlittle-endian',
    '-c',
    '-Wa,-asl=arm9.list',
    '-o',
    'arm9.o'
  ], outputDirectory, timeoutMs);
  if (gcc.exitCode !== 0) {
    await rm(outputPaths['arm9.o'], { force: true });
    await rm(outputPaths['arm9.bin'], { force: true });
    throw new Error(`arm-none-eabi-gcc exited with ${gcc.exitCode}: ${gcc.stderr.trim() || gcc.stdout.trim() || 'no diagnostic output'}`);
  }

  const objcopy = await runFixedProcess(executables.objcopy, ['-O', 'binary', 'arm9.o', 'arm9.bin'], outputDirectory, timeoutMs);
  if (objcopy.exitCode !== 0) {
    await rm(outputPaths['arm9.bin'], { force: true });
    throw new Error(`arm-none-eabi-objcopy exited with ${objcopy.exitCode}: ${objcopy.stderr.trim() || objcopy.stdout.trim() || 'no diagnostic output'}`);
  }

  return {
    sourcePath,
    outputDirectory,
    baseAddress,
    preprocessorModule: preprocessor.path,
    gcc: { exitCode: gcc.exitCode, stdout: gcc.stdout, stderr: gcc.stderr },
    objcopy: { exitCode: objcopy.exitCode, stdout: objcopy.stdout, stderr: objcopy.stderr },
    outputs: await Promise.all(OUTPUT_NAMES.map((name) => fileSummary(outputPaths[name])))
  };
}

async function callTool(name, args = {}) {
  if (name === 'build') return await build(args);
  throw new Error(`Unknown tool: ${name}`);
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
        serverInfo: { name: 'buildv5tassembly', version: SERVER_VERSION },
        instructions: 'Sandboxed fixed ARMv5T build pipeline. The preprocessing module, GCC, and objcopy are fixed at MCP startup by absolute path. build requires absolute sourcePath and outputDirectory plus a hexadecimal baseAddress such as 0x020F9104. It never runs arbitrary commands or caller-supplied compiler options.'
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

export const buildv5tassemblyInternals = {
  parseHexAddress
};
