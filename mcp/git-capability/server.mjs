import { spawn } from 'node:child_process';
import { lstat, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { ToolPathPolicy } from '../../app/path-policy.mjs';

const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const MODES = new Set(['stage', 'commit', 'push', 'pull', 'clone']);
const MAX_OUTPUT_BYTES = Number(process.env.GIT_CAPABILITY_MAX_OUTPUT_BYTES ?? 4 * 1024 * 1024);
const MAX_COMMIT_MESSAGE_BYTES = Number(process.env.GIT_CAPABILITY_MAX_COMMIT_MESSAGE_BYTES ?? 64 * 1024);
const DEFAULT_TIMEOUT_MS = Number(process.env.GIT_CAPABILITY_TIMEOUT_MS ?? 300_000);

function option(name) {
  const prefix = `--${name}=`;
  const entry = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return entry === undefined ? undefined : entry.slice(prefix.length);
}

function options(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2)
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length));
}

const help = process.argv.slice(2).some((value) => value === '--help' || value === '-h');
const mode = help ? 'commit' : option('mode');
if (!help && !MODES.has(mode)) throw new Error('--mode must be one of: stage, commit, push, pull, clone');
const gitExecutableConfigured = help ? null : option('git-executable');
if (!help && (typeof gitExecutableConfigured !== 'string' || !isAbsolute(gitExecutableConfigured))) {
  throw new Error('--git-executable=<absolute-path> is required');
}
if (!help && process.platform === 'win32' && !/\.exe$/i.test(gitExecutableConfigured)) {
  throw new Error('--git-executable must point to a native .exe on Windows');
}

const configuredRemote = option('remote') ?? 'origin';
const expectedRemoteUrl = option('expected-remote-url');
const expectedRepositories = options('repository');
for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') continue;
  if (argument.startsWith('--mode=') || argument.startsWith('--git-executable=')) continue;
  if ((mode === 'push' || mode === 'pull') && (
    argument.startsWith('--remote=') ||
    argument.startsWith('--expected-remote-url=') ||
    argument.startsWith('--repository=')
  )) continue;
  throw new Error(`Unknown argument for mode=${mode}: ${argument}`);
}

function safeRemote(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/.test(value) || value.startsWith('-')) throw new Error('--remote is invalid');
  return value;
}

function safeNetworkUrl(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value) || value.startsWith('-')) {
    throw new Error(`${label} is invalid`);
  }
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(value)) return value;
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error(`${label} must use https, ssh, or git@host:path syntax`); }
  if (!['https:', 'ssh:'].includes(parsed.protocol)) throw new Error(`${label} must use https, ssh, or git@host:path syntax`);
  if (parsed.password) throw new Error(`${label} may not contain an embedded password`);
  if (parsed.protocol === 'https:' && parsed.username) throw new Error(`${label} may not contain embedded HTTPS credentials`);
  return value;
}

export function safeCloneUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value) || value.startsWith('-')) {
    throw new Error('url is invalid');
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(value)) return value;
  let parsed;
  try { parsed = new URL(value); }
  catch { throw new Error('url must use http, https, ssh, or user@host:path syntax'); }
  if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('url must use http, https, ssh, or user@host:path syntax');
  }
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.username || parsed.password)) {
    throw new Error('HTTP(S) url may not contain embedded credentials; HTTP(S) cloning is anonymous only');
  }
  if (parsed.password) {
    throw new Error('url may not contain an embedded password');
  }
  return value;
}

export function cloneUsesAnonymousHttp(value) {
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(value)) return false;
  const parsed = new URL(value);
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export function safeCloneRef(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || /[\0\r\n]/.test(value) || value.startsWith('-')) {
    throw new Error('ref must be one branch or tag name');
  }
  return value;
}

function validateRepository(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 201 || /[\0\r\n]/.test(value)) {
    throw new Error('--repository must be OWNER/REPO');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
    throw new Error('--repository must be OWNER/REPO using only letters, numbers, dot, underscore, and hyphen');
  }
  if (value.includes('..') || value.endsWith('.git')) throw new Error('--repository is invalid');
  return value;
}

export function githubRepositoryFromRemoteUrl(value) {
  const url = safeNetworkUrl(value, 'remote URL');
  let repositoryPath;
  if (url.startsWith('git@')) {
    const match = /^git@([^:]+):(.+)$/.exec(url);
    if (!match || match[1].toLowerCase() !== 'github.com') throw new Error('remote URL must target github.com');
    repositoryPath = match[2];
  } else {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.port || parsed.search || parsed.hash) {
      throw new Error('remote URL must target github.com without a custom port, query, or fragment');
    }
    if (parsed.protocol === 'ssh:' && parsed.username && parsed.username !== 'git') {
      throw new Error('GitHub SSH remote URL must use the git user');
    }
    repositoryPath = parsed.pathname.replace(/^\//, '');
  }
  if (repositoryPath.endsWith('.git')) repositoryPath = repositoryPath.slice(0, -4);
  return validateRepository(repositoryPath);
}

export function githubRemoteMatchesRepository(remoteUrl, repository) {
  return githubRepositoryFromRemoteUrl(remoteUrl).toLowerCase() === validateRepository(repository).toLowerCase();
}

const remote = mode === 'push' || mode === 'pull' ? safeRemote(configuredRemote) : null;
if (!help && (mode === 'push' || mode === 'pull') && expectedRemoteUrl !== undefined && expectedRepositories.length > 0) {
  throw new Error('Use either one or more --repository=OWNER/REPO options or --expected-remote-url=<exact-url>, not both');
}
if (!help && (mode === 'push' || mode === 'pull') && expectedRemoteUrl === undefined && expectedRepositories.length === 0) {
  throw new Error('At least one --repository=OWNER/REPO or --expected-remote-url=<exact-url> is required');
}
const allowedRepositories = mode === 'push' || mode === 'pull'
  ? expectedRepositories.length === 0 ? null : [...new Set(expectedRepositories.map(validateRepository))]
  : null;
const allowedRemoteUrl = mode === 'push' || mode === 'pull'
  ? expectedRemoteUrl === undefined ? null : safeNetworkUrl(expectedRemoteUrl, '--expected-remote-url')
  : null;

function pathArray(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) throw new Error(`${name} must contain a JSON string array`);
  return parsed;
}

const configuredAllowedDirectories = help ? [] : pathArray('LOCAL_MCP_ALLOWED_DIRECTORIES', [process.cwd()]);
const configuredAllowedFiles = help ? [] : pathArray('LOCAL_MCP_ALLOWED_FILES');
const configuredDisallowedDirectories = help ? [] : pathArray('LOCAL_MCP_DISALLOWED_DIRECTORIES');
const configuredDisallowedFiles = help ? [] : pathArray('LOCAL_MCP_DISALLOWED_FILES');
const configuredDisallowedPathGlobs = help ? [] : pathArray('LOCAL_MCP_DISALLOWED_PATH_GLOBS');
const policy = new ToolPathPolicy({
  serverName: `git-capability-${mode}`,
  cwd: process.cwd(),
  allowedDirectories: configuredAllowedDirectories,
  allowedFiles: configuredAllowedFiles,
  disallowedDirectories: configuredDisallowedDirectories,
  disallowedFiles: configuredDisallowedFiles,
  disallowedPathGlobs: configuredDisallowedPathGlobs
});
const isolation = createBundledIsolation();
let standaloneWorkingDirectoryPromise;
let gitExecutablePromise;
const codexSandboxMode = process.env.LOCAL_MCP_CODEX_SANDBOX_MODE;
const codexSandboxChangesUser = codexSandboxMode === 'elevated';

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } },
  required: ['ok'],
  additionalProperties: false
};
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_STATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const LOCAL_DESTRUCTIVE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const OPEN_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const OPEN_ADDITIVE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const commonSchemas = [
  { name: 'roots', description: 'List only the verified signed roots and current relative-path base for this Git capability.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: READ_ONLY },
  { name: 'get_working_directory', description: 'Return the verified directory used as the repository or clone parent for this capability.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: READ_ONLY },
  { name: 'set_working_directory', description: 'Change the relative-path base to one existing directory inside the signed roots after applying all allow/deny rules.', inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false }, annotations: LOCAL_STATE }
];
const stagePathsInputSchema = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { type: 'string', minLength: 1, maxLength: 4096 }
    }
  },
  required: ['paths'],
  additionalProperties: false
};
const operationSchemas = mode === 'stage' ? [
  {
    name: 'add_all',
    description: 'Stage all non-ignored changes with the fixed command git add --all -- . Standard Git ignore, attributes, clean filters, and line-ending conversion are respected.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: LOCAL_DESTRUCTIVE_IDEMPOTENT
  },
  {
    name: 'stage_paths',
    description: 'Stage only the selected repository files or directories with literal pathspecs. Deletions below selected directories are included; unrelated changes remain unstaged.',
    inputSchema: stagePathsInputSchema,
    annotations: LOCAL_DESTRUCTIVE_IDEMPOTENT
  },
  {
    name: 'unstage_paths',
    description: 'Remove only the selected repository files or directories from the index without changing working-tree files. Literal pathspecs are used, including before the first commit.',
    inputSchema: stagePathsInputSchema,
    annotations: LOCAL_DESTRUCTIVE_IDEMPOTENT
  }
] : [mode === 'commit' ? {
  name: 'commit',
  description: 'Commit only the already staged index with one literal message. No staging, hooks, arbitrary Git arguments, repository path, or network operation is exposed. Configured signing is allowed, but repository-local executable Git configuration is rejected first.',
  inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1 } }, required: ['message'], additionalProperties: false },
  annotations: LOCAL_DESTRUCTIVE
} : mode === 'push' ? {
  name: 'push',
  description: 'Push only the current branch to the fixed startup-configured remote after verifying that remote resolves to the allowlisted GitHub OWNER/REPO or legacy exact URL. Force push, refspecs, upstream mutation, arbitrary remotes, and arbitrary URLs are not exposed.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: OPEN_DESTRUCTIVE
} : mode === 'pull' ? {
  name: 'pull',
  description: 'Fetch only the fixed startup-configured remote after verifying that it resolves to the allowlisted GitHub OWNER/REPO or legacy exact URL, reject denied incoming tree paths, then fast-forward the current branch only. Rebase, merge commits, arbitrary remotes, submodules, and arbitrary URLs are not exposed.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: OPEN_DESTRUCTIVE
} : {
  name: 'clone_repository',
  description: 'Clone one caller-supplied HTTP, HTTPS, or SSH Git URL into one new child directory of the signed base. HTTP(S) cloning is always anonymous: credential helpers, AskPass, terminal prompts, inherited Git config injection, and system/global Git config are disabled. SSH cloning is allowed only when this MCP is running without the Codex sandbox (sandbox=never), where normal local SSH authentication is inherited. Optional ref accepts either a branch name or tag name and is passed as git clone --branch. Remote access and the requested ref are verified before the destination is created. Checkout is delayed until the incoming tree passes path policy. Submodules, arbitrary parents, and arbitrary Git arguments are not exposed.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 4096, description: 'HTTP, HTTPS, or SSH Git repository URL. HTTP(S) is always anonymous. SSH uses normal local authentication only when sandbox=never. Embedded HTTP(S) credentials and SSH passwords are rejected.' },
      destinationDirectory: { type: 'string', minLength: 1, maxLength: 255 },
      depth: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      ref: { type: 'string', minLength: 1, maxLength: 255, description: 'Optional branch or tag name, equivalent to git clone --branch <ref>.' }
    },
    required: ['url', 'destinationDirectory'],
    additionalProperties: false
  },
  annotations: OPEN_ADDITIVE
}];
const schemas = [...commonSchemas, ...operationSchemas].map((schema) => ({ ...schema, outputSchema: RESPONSE_SCHEMA }));

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError });

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function rejectAmbiguousPath(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/.test(value)) throw new Error(`${label} must be a non-empty path without NUL or line breaks`);
  if (/%[^%]+%|\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*/.test(value)) throw new Error(`${label} may not contain environment-variable syntax`);
  if (process.platform === 'win32') {
    const normalized = value.replace(/\//g, '\\');
    if (/^[A-Za-z]:(?!\\)/.test(normalized)) throw new Error(`${label} may not use drive-relative Windows syntax`);
    if (/^\\(?!\\)/.test(normalized)) throw new Error(`${label} may not use root-relative Windows syntax`);
    if (/^\\\\[?.]\\/i.test(normalized)) throw new Error(`${label} may not use Windows namespace paths`);
    const withoutDrive = normalized.replace(/^[A-Za-z]:/, '');
    if (withoutDrive.includes(':')) throw new Error(`${label} may not use NTFS alternate data streams`);
  }
}

async function contextRoots() {
  const current = isolation.current();
  if (current) return [...current.roots];
  return policy.selectAllowedDirectories(configuredAllowedDirectories.length > 0 ? configuredAllowedDirectories : [process.cwd()]);
}

async function contextBase() {
  const current = isolation.current();
  if (current) return current.base;
  standaloneWorkingDirectoryPromise ??= policy.selectAllowedDirectories([process.cwd()]).then(([base]) => {
    if (!base) throw new Error('The process cwd is outside the configured Git capability allowlist');
    return base;
  });
  return standaloneWorkingDirectoryPromise;
}

async function contextPolicy(roots, base) {
  const selected = new ToolPathPolicy({ serverName: `git-capability-${mode}-isolation`, cwd: base, allowedDirectories: roots });
  await selected.allowed();
  return selected;
}

async function resolveExistingDirectory(value, label = 'path') {
  rejectAmbiguousPath(value, label);
  const base = await contextBase();
  const roots = await contextRoots();
  const isolationPolicy = await contextPolicy(roots, base);
  const lexical = resolve(isAbsolute(value) ? value : join(base, value));
  await policy.assertToolArguments(label, { path: lexical }, base);
  await isolationPolicy.assertToolArguments(label, { path: lexical }, base);
  const actual = await realpath(lexical);
  if (!(await stat(actual)).isDirectory()) throw new Error(`${label} is not a directory`);
  if (!roots.some((root) => within(root, actual))) throw new Error(`${label} resolved outside signed roots`);
  await policy.assertToolArguments(label, { path: actual }, base);
  await isolationPolicy.assertToolArguments(label, { path: actual }, base);
  return actual;
}

async function canonicalGitExecutable() {
  gitExecutablePromise ??= (async () => {
    const actual = await realpath(gitExecutableConfigured);
    if (!(await stat(actual)).isFile()) throw new Error('--git-executable must point to a regular file');
    return actual;
  })();
  return gitExecutablePromise;
}

function gitEnvironment({ anonymousClone = false } = {}) {
  const environment = environmentWithoutBundledIsolationKey();
  const networkAuthentication = mode === 'push' || mode === 'pull' || mode === 'clone';
  for (const name of ['GIT_EXTERNAL_DIFF', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']) delete environment[name];
  if (!networkAuthentication) {
    for (const name of [
      'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'
    ]) delete environment[name];
    for (const name of Object.keys(environment)) {
      if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/i.test(name)) delete environment[name];
    }
  }
  if (anonymousClone) {
    for (const name of [
      'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_GLOBAL'
    ]) delete environment[name];
    for (const name of Object.keys(environment)) {
      if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/i.test(name)) delete environment[name];
    }
    environment.GIT_CONFIG_NOSYSTEM = '1';
    environment.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
    environment.GIT_TERMINAL_PROMPT = '0';
    environment.GCM_INTERACTIVE = 'Never';
  }
  environment.GIT_OPTIONAL_LOCKS = '0';
  if (!networkAuthentication && environment.GIT_TERMINAL_PROMPT === undefined) environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function fixedGitConfigArguments(cwd, { anonymousClone = false } = {}) {
  const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const configEntries = [
    ['core.hooksPath', nullPath],
    ['protocol.file.allow', 'never'],
    ['protocol.ext.allow', 'never'],
    ['protocol.http.allow', mode === 'clone' ? 'always' : 'never'],
    ['protocol.https.allow', 'always'],
    ['protocol.ssh.allow', 'always'],
    ['core.fsmonitor', 'false'],
    ...(anonymousClone ? [
      ['credential.helper', ''],
      ['credential.interactive', 'never'],
      ['core.askPass', ''],
      ['http.extraHeader', '']
    ] : []),
    ...(codexSandboxChangesUser ? [['safe.directory', cwd]] : [])
  ];
  return configEntries.flatMap(([key, value]) => ['-c', `${key}=${value}`]);
}

async function runGit(cwd, args, { acceptedExitCodes = [0], anonymousClone = false } = {}) {
  const executable = await canonicalGitExecutable();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...fixedGitConfigArguments(cwd, { anonymousClone }), ...args], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: gitEnvironment({ anonymousClone }) });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    let timeout;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (error) rejectPromise(error); else resolvePromise(value);
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        if (child.exitCode === null && !child.killed) child.kill();
        finish(new Error(`Git output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (!acceptedExitCodes.includes(code)) finish(new Error(err.trim() || out.trim() || `git exited with ${code}`));
      else finish(null, { stdout: out, stderr: err, exitCode: code });
    });
    timeout = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill();
      finish(new Error(`Git command timed out after ${DEFAULT_TIMEOUT_MS}ms`));
    }, DEFAULT_TIMEOUT_MS);
  });
}

async function assertNoRepositoryExecutableGitConfiguration(cwd) {
  const result = await runGit(cwd, [
    'config', '--show-scope', '--show-origin', '--get-regexp',
    '^(core\\.(hookspath|sshcommand|gitproxy|fsmonitor|attributesfile|excludesfile)|credential\\..*helper|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv)|merge\\..*\\.driver|gpg\\.(program|ssh\\.program)|remote\\..*\\.(proxy|receivepack|uploadpack))$'
  ], { acceptedExitCodes: [0, 1] });
  const unsafe = result.stdout.trim().split(/\r?\n/).filter(Boolean).filter((line) => /^(local|worktree)\s/.test(line));
  if (unsafe.length > 0) throw new Error('Repository-local Git configuration contains executable hooks, helpers, filters, diff/textconv commands, merge drivers, signing programs, proxies, custom transport commands, or external attributes/ignore files');
}

async function repository() {
  const base = await resolveExistingDirectory(await contextBase(), 'repository');
  const top = (await runGit(base, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const actualTop = await resolveExistingDirectory(top, 'repository');
  if (!within(actualTop, base)) throw new Error('Current working directory is outside its Git worktree');
  await assertNoRepositoryExecutableGitConfiguration(actualTop);
  return actualTop;
}

async function assertTreeAllowed(cwd, treeish) {
  const output = (await runGit(cwd, ['ls-tree', '-r', '-z', '--name-only', treeish])).stdout;
  const paths = output.split('\0').filter(Boolean).map((entry) => resolve(cwd, entry));
  if (paths.length === 0) return;
  const base = await contextBase();
  const roots = await contextRoots();
  const isolationPolicy = await contextPolicy(roots, base);
  await policy.assertToolArguments('tree', { paths }, base);
  await isolationPolicy.assertToolArguments('tree', { paths }, base);
}

async function assertStagedPathsAllowed(cwd) {
  const output = (await runGit(cwd, ['diff', '--cached', '--name-only', '-z'])).stdout;
  const paths = output.split('\0').filter(Boolean).map((entry) => resolve(cwd, entry));
  if (paths.length === 0) throw new Error('Nothing is staged to commit');
  const base = await contextBase();
  const roots = await contextRoots();
  const isolationPolicy = await contextPolicy(roots, base);
  await policy.assertToolArguments('commit', { paths }, base);
  await isolationPolicy.assertToolArguments('commit', { paths }, base);
}

async function repositoryRelativePaths(cwd, values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw new Error('paths must contain from 1 through 100 entries');
  const base = await contextBase();
  const roots = await contextRoots();
  const isolationPolicy = await contextPolicy(roots, base);
  const relativePaths = [];
  for (const value of values) {
    rejectAmbiguousPath(value, 'path');
    if (value.length > 4096) throw new Error('Each paths entry must be at most 4096 characters');
    const candidate = resolve(isAbsolute(value) ? value : join(cwd, value));
    if (!within(cwd, candidate)) throw new Error(`Repository path escaped the worktree: ${value}`);
    const relativePath = candidate === cwd ? '.' : relative(cwd, candidate).split(sep).join('/');
    if (relativePath.split('/').includes('.git')) throw new Error(`Direct .git paths are not supported: ${value}`);
    await policy.assertToolArguments('stage path', { path: candidate }, base);
    await isolationPolicy.assertToolArguments('stage path', { path: candidate }, base);
    relativePaths.push(relativePath);
  }
  return relativePaths;
}

async function assertStageCandidatesAllowed(cwd) {
  const output = (await runGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout;
  const paths = output.split('\0').filter(Boolean).map((entry) => resolve(cwd, entry));
  if (paths.length === 0) return;
  const base = await contextBase();
  const roots = await contextRoots();
  const isolationPolicy = await contextPolicy(roots, base);
  await policy.assertToolArguments('stage', { paths }, base);
  await isolationPolicy.assertToolArguments('stage', { paths }, base);
}

async function addAll() {
  const cwd = await repository();
  await assertStageCandidatesAllowed(cwd);
  await runGit(cwd, ['add', '--all', '--', '.']);
  return { repositoryPath: cwd, staged: true };
}

async function stagePaths(args) {
  const cwd = await repository();
  const paths = await repositoryRelativePaths(cwd, args.paths);
  await assertStageCandidatesAllowed(cwd);
  await runGit(cwd, ['--literal-pathspecs', 'add', '--all', '--', ...paths]);
  return { repositoryPath: cwd, paths, staged: true };
}

async function unstagePaths(args) {
  const cwd = await repository();
  const paths = await repositoryRelativePaths(cwd, args.paths);
  const stagedDiff = await runGit(cwd, ['--literal-pathspecs', 'diff', '--cached', '--quiet', '--', ...paths], { acceptedExitCodes: [0, 1] });
  if (stagedDiff.exitCode === 0) {
    return { repositoryPath: cwd, paths, unstaged: true, changed: false, unbornHead: false };
  }
  const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { acceptedExitCodes: [0, 1] });
  if (head.exitCode === 0) {
    await runGit(cwd, ['--literal-pathspecs', 'restore', '--staged', '--source=HEAD', '--', ...paths]);
  } else {
    await runGit(cwd, ['--literal-pathspecs', 'rm', '--cached', '-r', '--ignore-unmatch', '--', ...paths]);
  }
  return { repositoryPath: cwd, paths, unstaged: true, changed: true, unbornHead: head.exitCode !== 0 };
}

async function currentBranch(cwd) {
  const branch = (await runGit(cwd, ['branch', '--show-current'])).stdout.trim();
  if (!branch || branch.length > 255 || !/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes('..') || branch.startsWith('-')) {
    throw new Error('A safe attached current branch is required');
  }
  return branch;
}

async function assertExpectedRemote(cwd) {
  const command = mode === 'push'
    ? ['remote', 'get-url', '--push', '--', remote]
    : ['remote', 'get-url', '--', remote];
  const actual = (await runGit(cwd, command)).stdout.trim();
  if (allowedRepositories !== null) {
    if (!allowedRepositories.some((repository) => githubRemoteMatchesRepository(actual, repository))) {
      throw new Error(`Configured remote ${remote} does not match any startup allowlisted GitHub repository`);
    }
    return;
  }
  if (actual !== allowedRemoteUrl) throw new Error(`Configured remote ${remote} does not match the startup allowlisted URL`);
}

async function commit(args) {
  if (typeof args.message !== 'string' || args.message.length === 0 || /\0/.test(args.message)) throw new Error('message must be a non-empty string without NUL');
  if (Buffer.byteLength(args.message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) throw new Error(`message exceeds ${MAX_COMMIT_MESSAGE_BYTES} UTF-8 bytes`);
  const cwd = await repository();
  await assertStagedPathsAllowed(cwd);
  await runGit(cwd, ['commit', '--no-verify', '-m', args.message]);
  return { repositoryPath: cwd, committed: true };
}

async function push() {
  const cwd = await repository();
  await assertExpectedRemote(cwd);
  const branch = await currentBranch(cwd);
  await assertTreeAllowed(cwd, 'HEAD');
  await runGit(cwd, ['push', '--', remote, branch]);
  return { repositoryPath: cwd, remote, branch, remoteUrlVerified: true, force: false };
}

async function pull() {
  const cwd = await repository();
  await assertExpectedRemote(cwd);
  const branch = await currentBranch(cwd);
  await runGit(cwd, ['fetch', '--no-recurse-submodules', '--', remote]);
  const incoming = `refs/remotes/${remote}/${branch}`;
  await runGit(cwd, ['rev-parse', '--verify', incoming]);
  await assertTreeAllowed(cwd, incoming);
  await runGit(cwd, ['merge', '--ff-only', '--no-edit', incoming]);
  return { repositoryPath: cwd, remote, branch, remoteUrlVerified: true, fastForwardOnly: true, recurseSubmodules: false };
}

function safeDestinationName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(value) || value === '.' || value === '..' || value.toLowerCase() === '.git') {
    throw new Error('destinationDirectory must be one safe relative directory name');
  }
  return value;
}

async function cloneRepository(args) {
  const base = await resolveExistingDirectory(await contextBase(), 'clone parent');
  const url = safeCloneUrl(args.url);
  const anonymousHttp = cloneUsesAnonymousHttp(url);
  if (!anonymousHttp && codexSandboxMode !== 'never') {
    throw new Error('SSH cloning requires sandbox=never so local SSH authentication is never exposed inside the Codex sandbox');
  }
  const ref = safeCloneRef(args.ref);
  const name = safeDestinationName(args.destinationDirectory);
  const destination = resolve(base, name);
  const roots = await contextRoots();
  const isolationPolicy = await contextPolicy(roots, base);
  await policy.assertToolArguments('clone_repository', { path: destination }, base);
  await isolationPolicy.assertToolArguments('clone_repository', { path: destination }, base);
  try { await lstat(destination); throw new Error('clone destination already exists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const depth = args.depth;
  if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 1)) throw new Error('depth must be a positive safe integer');
  const command = ['clone', '--no-local', '--no-checkout'];
  if (depth !== undefined) command.push(`--depth=${depth}`);
  if (ref !== undefined) command.push('--branch', ref);
  command.push('--', url, name);
  try {
    const probe = ref === undefined
      ? ['ls-remote', '--', url]
      : ['ls-remote', '--exit-code', '--refs', '--', url, `refs/heads/${ref}`, `refs/tags/${ref}`];
    await runGit(base, probe, { anonymousClone: anonymousHttp });
    await runGit(base, command, { anonymousClone: anonymousHttp });
    const cloned = await resolveExistingDirectory(destination, 'clone destination');
    await assertNoRepositoryExecutableGitConfiguration(cloned);
    await assertTreeAllowed(cloned, 'HEAD');
    await runGit(cloned, ['checkout', '--force']);
    return { parentDirectory: base, destinationDirectory: cloned, remoteUrlAccepted: true, anonymous: anonymousHttp, recurseSubmodules: false, ...(depth === undefined ? {} : { depth }), ...(ref === undefined ? {} : { ref }) };
  } catch (error) {
    try {
      const actual = await realpath(destination);
      if (within(base, actual) && basename(actual) === name) await rm(actual, { recursive: true, force: true });
    } catch {}
    throw error;
  }
}

async function rootsPayload() {
  const roots = await contextRoots();
  const base = await contextBase();
  return { roots, base, workingDirectory: base, policy: isolation.current() ? await policy.describeForAllowedDirectories(roots, base) : await policy.describe(base) };
}

function assertExactArguments(args, allowed, required = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object');
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`Unexpected tool argument: ${unexpected[0]}`);
  for (const key of required) if (!Object.hasOwn(args, key)) throw new Error(`Missing required tool argument: ${key}`);
}

async function callTool(name, args = {}) {
  if (name === 'roots') {
    assertExactArguments(args, []);
    return rootsPayload();
  }
  if (name === 'get_working_directory') {
    assertExactArguments(args, []);
    return { workingDirectory: await contextBase() };
  }
  if (name === 'set_working_directory') {
    assertExactArguments(args, ['path'], ['path']);
    const target = await resolveExistingDirectory(args.path, 'path');
    if (!isolation.current()) standaloneWorkingDirectoryPromise = Promise.resolve(target);
    return { workingDirectory: target };
  }
  if (mode === 'stage' && name === 'add_all') {
    assertExactArguments(args, []);
    return addAll();
  }
  if (mode === 'stage' && name === 'stage_paths') {
    assertExactArguments(args, ['paths'], ['paths']);
    return stagePaths(args);
  }
  if (mode === 'stage' && name === 'unstage_paths') {
    assertExactArguments(args, ['paths'], ['paths']);
    return unstagePaths(args);
  }
  if (mode === 'commit' && name === 'commit') {
    assertExactArguments(args, ['message'], ['message']);
    return commit(args);
  }
  if (mode === 'push' && name === 'push') {
    assertExactArguments(args, []);
    return push();
  }
  if (mode === 'pull' && name === 'pull') {
    assertExactArguments(args, []);
    return pull();
  }
  if (mode === 'clone' && name === 'clone_repository') {
    assertExactArguments(args, ['url', 'destinationDirectory', 'depth'], ['url', 'destinationDirectory']);
    return cloneRepository(args);
  }
  throw new Error(`Unknown tool for mode=${mode}: ${name}`);
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
        serverInfo: { name: `git-capability-${mode}`, version: '0.2.0' },
        instructions: `Single-capability Git MCP. Only ${operationSchemas.map((schema) => schema.name).join(', ')} plus signed-workspace control tools are exposed. Repository-local executable Git configuration is rejected before the capability runs. sandbox mode remains an explicit gateway.toml choice for backward compatibility.`
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

export const HELP = `git-capability MCP\n\nUsage:\n  node mcp/git-capability/server.mjs --mode=stage --git-executable=<absolute-git-path>\n  node mcp/git-capability/server.mjs --mode=commit --git-executable=<absolute-git-path>\n  node mcp/git-capability/server.mjs --mode=push --git-executable=<absolute-git-path> --remote=origin --repository=OWNER/REPO [--repository=OWNER/OTHER_REPO ...]\n  node mcp/git-capability/server.mjs --mode=pull --git-executable=<absolute-git-path> --remote=origin --repository=OWNER/REPO [--repository=OWNER/OTHER_REPO ...]\n  node mcp/git-capability/server.mjs --mode=clone --git-executable=<absolute-git-path>\n\nFor push/pull, --repository may be repeated to allow multiple GitHub repositories. Legacy --expected-remote-url=<exact-url> remains supported instead of --repository. clone_repository accepts caller-supplied HTTP/HTTPS/SSH URLs. HTTP(S) is always anonymous: credential helpers, AskPass, terminal prompting, inherited Git config injection, and system/global Git config are disabled. SSH is accepted only with sandbox=never and then inherits normal local SSH authentication. Optional ref selects either a branch or a tag using git clone --branch.\nEach process exposes one bounded Git capability group plus roots/get_working_directory/set_working_directory. stage exposes only add_all, stage_paths, and unstage_paths.\nAll Gateway calls require the bundled HMAC-signed isolation context. The capability never accepts a repositoryPath, arbitrary Git arguments, arbitrary executable, arbitrary environment, or shell command.\n`;

if (directExecution) {
  if (help) process.stdout.write(HELP);
  else await startStdio();
}
