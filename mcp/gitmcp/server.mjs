import { spawn } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disallowedPathGlobError, findDisallowedPathGlob, normalizeDisallowedPathGlobs } from '../../app/path-glob.mjs';

const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const MAX_OUTPUT_BYTES = Number(process.env.GIT_MCP_MAX_OUTPUT_BYTES ?? 8 * 1024 * 1024);
const MAX_COMMIT_MESSAGE_BYTES = Number(process.env.GIT_MCP_MAX_COMMIT_MESSAGE_BYTES ?? 64 * 1024);

function booleanOption(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  if (argument === undefined) return fallback;
  const value = argument.slice(prefix.length).toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${prefix} accepts only true or false`);
}

const cli = {
  help: process.argv.slice(2).some((value) => value === '--help' || value === '-h'),
  disablePush: booleanOption('disable-push', false),
  disablePull: booleanOption('disable-pull', true),
  disableClone: booleanOption('disable-clone', true)
};

for (const argument of process.argv.slice(2)) {
  if (argument === '--help' || argument === '-h') continue;
  if (argument.startsWith('--disable-push=') || argument.startsWith('--disable-pull=') || argument.startsWith('--disable-clone=')) continue;
  throw new Error(`Unknown argument: ${argument}`);
}

export const GIT_MCP_HELP = `gitmcp

Usage:
  node mcp/gitmcp/server.mjs [--disable-push=true|false] [--disable-pull=true|false] [--disable-clone=true|false]

The gateway supplies allowed and denied paths through reserved LOCAL_MCP_* environment variables.
Git is always spawned with shell=false and fixed subcommands and options.
`;

function pathArray(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error(`${name} must contain a JSON string array`);
  }
  return parsed;
}

const configuredAllowedDirectories = cli.help ? [] : pathArray('LOCAL_MCP_ALLOWED_DIRECTORIES', [process.cwd()]);
const configuredAllowedFiles = cli.help ? [] : pathArray('LOCAL_MCP_ALLOWED_FILES');
const configuredDisallowedDirectories = cli.help ? [] : pathArray('LOCAL_MCP_DISALLOWED_DIRECTORIES');
const configuredDisallowedFiles = cli.help ? [] : pathArray('LOCAL_MCP_DISALLOWED_FILES');
const configuredDisallowedPathGlobs = cli.help ? [] : normalizeDisallowedPathGlobs(
  pathArray('LOCAL_MCP_DISALLOWED_PATH_GLOBS'),
  'LOCAL_MCP_DISALLOWED_PATH_GLOBS'
);

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } },
  required: ['ok'],
  additionalProperties: false
};
const toolResult = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  isError
});
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const repositorySchema = () => ({
  type: 'object',
  properties: { repositoryPath: { type: 'string', default: '.' } },
  additionalProperties: false
});

const schemas = [
  { name: 'roots', description: 'List allowed and denied Git paths and the current working directory.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly },
  { name: 'get_working_directory', description: 'Return the directory used to resolve relative repository paths.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: readOnly },
  {
    name: 'set_working_directory',
    description: 'Change the relative-path base to an existing allowed directory that is not denied.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false }
  },
  { name: 'status', description: 'Return porcelain Git status.', inputSchema: repositorySchema(), annotations: readOnly },
  { name: 'ls_files', description: 'List tracked files without exposing .git internals.', inputSchema: repositorySchema(), annotations: readOnly },
  { name: 'branches', description: 'List local and remote branches and identify the current branch.', inputSchema: repositorySchema(), annotations: readOnly },
  { name: 'remotes', description: 'List configured remote names and URLs.', inputSchema: repositorySchema(), annotations: readOnly },
  {
    name: 'log',
    description: 'Return a bounded recent commit log.',
    inputSchema: { type: 'object', properties: { repositoryPath: { type: 'string', default: '.' }, maxCount: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    annotations: readOnly
  },
  {
    name: 'diff',
    description: 'Return a working-tree or staged diff with external diff commands disabled.',
    inputSchema: { type: 'object', properties: { repositoryPath: { type: 'string', default: '.' }, staged: { type: 'boolean', default: false } }, additionalProperties: false },
    annotations: readOnly
  },
  {
    name: 'switch_branch',
    description: 'Switch to an existing local branch, or create one from the current HEAD.',
    inputSchema: { type: 'object', properties: { repositoryPath: { type: 'string', default: '.' }, branch: { type: 'string', minLength: 1, maxLength: 255 }, create: { type: 'boolean', default: false } }, required: ['branch'], additionalProperties: false }
  },
  { name: 'add_all', description: 'Stage all changes with the fixed command git add --all -- .', inputSchema: repositorySchema() },
  {
    name: 'commit',
    description: 'Commit already staged changes using a literal message. This tool does not stage files.',
    inputSchema: { type: 'object', properties: { repositoryPath: { type: 'string', default: '.' }, message: { type: 'string', minLength: 1 } }, required: ['message'], additionalProperties: false }
  },
  ...(!cli.disablePush ? [{
    name: 'push',
    description: 'Push the current branch to a named remote. Force push and arbitrary refspecs are not supported.',
    inputSchema: { type: 'object', properties: { repositoryPath: { type: 'string', default: '.' }, remote: { type: 'string', minLength: 1, maxLength: 255, default: 'origin' }, setUpstream: { type: 'boolean', default: false } }, additionalProperties: false }
  }] : []),
  ...(!cli.disablePull ? [{
    name: 'pull',
    description: 'Fetch the configured upstream without submodules, reject denied incoming paths, then fast-forward only. Arbitrary remotes, refspecs, merge commits, and rebase are not supported.',
    inputSchema: repositorySchema()
  }] : []),
  ...(!cli.disableClone ? [{
    name: 'clone_repository',
    description: 'Clone into one new relative child directory under an allowed directory. recurseSubmodules adds the fixed --recurse-submodules option, and depth adds a fixed --depth=<n> option.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1, maxLength: 4096 },
        destinationDirectory: { type: 'string', minLength: 1, maxLength: 255 },
        parentDirectory: { type: 'string', default: '.' },
        recurseSubmodules: { type: 'boolean', default: false },
        depth: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
      },
      required: ['url', 'destinationDirectory'],
      additionalProperties: false
    }
  }] : [])
].map((schema) => ({ ...schema, outputSchema: TOOL_OUTPUT_SCHEMA }));

const normalizeCase = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (left, right) => normalizeCase(left) === normalizeCase(right);
const within = (root, candidate) => {
  const base = normalizeCase(root);
  const target = normalizeCase(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
};

function assertNotGlobDenied(path, context) {
  const match = findDisallowedPathGlob(path, configuredDisallowedPathGlobs);
  if (match) throw disallowedPathGlobError(context, match);
}

let policyPromise;
let workingDirectoryPromise;

async function canonicalExisting(path) {
  if (typeof path !== 'string' || path.length === 0 || /[\0\r\n]/.test(path)) throw new Error('Path must be a non-empty string without NUL or line breaks');
  return realpath(resolve(path));
}

async function canonicalDirectory(path) {
  const actual = await canonicalExisting(path);
  if (!(await stat(actual)).isDirectory()) throw new Error(`Configured path is not a directory: ${path}`);
  return actual;
}

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

async function policy() {
  policyPromise ??= (async () => {
    if (configuredAllowedDirectories.length === 0) throw new Error('At least one allowed directory is required');
    return {
      allowedDirectories: await Promise.all(configuredAllowedDirectories.map(canonicalDirectory)),
      allowedFiles: await Promise.all(configuredAllowedFiles.map(canonicalExisting)),
      disallowedDirectories: await Promise.all(configuredDisallowedDirectories.map(canonicalizeExistingPrefix)),
      disallowedFiles: await Promise.all(configuredDisallowedFiles.map(canonicalizeExistingPrefix)),
      disallowedPathGlobs: configuredDisallowedPathGlobs
    };
  })();
  return policyPromise;
}

async function workingDirectory() {
  workingDirectoryPromise ??= policy().then(({ allowedDirectories }) => allowedDirectories[0]);
  return workingDirectoryPromise;
}

function lexicalCandidate(path, base) {
  if (typeof path !== 'string' || path.length === 0 || /[\0\r\n]/.test(path)) throw new Error('Path must be a non-empty string without NUL or line breaks');
  return resolve(isAbsolute(path) ? path : join(base, path));
}

async function assertAllowedExisting(path) {
  const candidate = lexicalCandidate(path, await workingDirectory());
  const actual = await realpath(candidate);
  assertNotGlobDenied(actual, 'Git path');
  const rules = await policy();
  const allowed = rules.allowedDirectories.some((root) => within(root, actual)) || rules.allowedFiles.some((file) => same(file, actual));
  if (!allowed) throw new Error('Path is outside allowed_directories and allowed_files');
  const denied = rules.disallowedDirectories.some((root) => within(root, actual)) || rules.disallowedFiles.some((file) => same(file, actual));
  if (denied) throw new Error('Path is denied by disallowed_directories or disallowed_files');
  return actual;
}

async function assertAllowedNewDirectory(parentDirectory, destinationDirectory) {
  const parent = await assertAllowedExisting(parentDirectory);
  if (!(await stat(parent)).isDirectory()) throw new Error('parentDirectory is not a directory');
  if (typeof destinationDirectory !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(destinationDirectory)) {
    throw new Error('destinationDirectory must be one relative directory name without separators or option-looking syntax');
  }
  if (destinationDirectory === '.' || destinationDirectory === '..' || destinationDirectory.toLowerCase() === '.git') throw new Error('Unsafe destinationDirectory');
  const destination = resolve(parent, destinationDirectory);
  assertNotGlobDenied(destination, 'Git clone destination');
  if (!within(parent, destination)) throw new Error('Clone destination escaped parentDirectory');
  const rules = await policy();
  if (!rules.allowedDirectories.some((root) => within(root, destination))) throw new Error('Clone destination is outside allowed_directories');
  if (rules.disallowedDirectories.some((root) => within(root, destination)) || rules.disallowedFiles.some((file) => same(file, destination))) throw new Error('Clone destination is denied');
  try { await lstat(destination); throw new Error('Clone destination already exists'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return { parent, destination };
}

function safeName(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || /[\0\r\n]/.test(value) || value.startsWith('-')) throw new Error(`${label} is invalid`);
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('..') || value.includes('\\')) throw new Error(`${label} is invalid`);
  return value;
}

function safeRemote(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/.test(value) || value.startsWith('-')) throw new Error('remote is invalid');
  return value;
}

function safeCloneUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value) || value.startsWith('-')) throw new Error('Clone URL is invalid');
  if (/^(?:https?|ssh):\/\//i.test(value) || /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(value)) return value;
  throw new Error('Clone URL must use http, https, ssh, or git@host:path syntax');
}

async function runGit(cwd, args) {
  return new Promise((resolvePromise, reject) => {
    const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_EXTERNAL_DIFF: '',
        GIT_CONFIG_COUNT: '12',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: nullPath,
        GIT_CONFIG_KEY_1: 'diff.external',
        GIT_CONFIG_VALUE_1: '',
        GIT_CONFIG_KEY_2: 'core.attributesFile',
        GIT_CONFIG_VALUE_2: nullPath,
        GIT_CONFIG_KEY_3: 'protocol.file.allow',
        GIT_CONFIG_VALUE_3: 'never',
        GIT_CONFIG_KEY_4: 'protocol.ext.allow',
        GIT_CONFIG_VALUE_4: 'never',
        GIT_CONFIG_KEY_5: 'protocol.http.allow',
        GIT_CONFIG_VALUE_5: 'always',
        GIT_CONFIG_KEY_6: 'protocol.https.allow',
        GIT_CONFIG_VALUE_6: 'always',
        GIT_CONFIG_KEY_7: 'protocol.ssh.allow',
        GIT_CONFIG_VALUE_7: 'always',
        GIT_CONFIG_KEY_8: 'core.fsmonitor',
        GIT_CONFIG_VALUE_8: 'false',
        GIT_CONFIG_KEY_9: 'commit.gpgsign',
        GIT_CONFIG_VALUE_9: 'false',
        GIT_CONFIG_KEY_10: 'tag.gpgsign',
        GIT_CONFIG_VALUE_10: 'false',
        GIT_CONFIG_KEY_11: 'merge.gpgsign',
        GIT_CONFIG_VALUE_11: 'false'
      }
    });
    const stdout = [];
    const stderr = [];
    let total = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolvePromise(value);
    };
    const collect = (target) => (chunk) => {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error(`Git output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) finish(new Error(err.trim() || out.trim() || `git exited with ${code}`));
      else finish(null, { stdout: out, stderr: err });
    });
  });
}

async function repository(path = '.') {
  const cwd = await assertAllowedExisting(path);
  if (!(await stat(cwd)).isDirectory()) throw new Error('repositoryPath is not a directory');
  const top = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const actualTop = await assertAllowedExisting(top);
  if (!within(actualTop, cwd)) throw new Error('repositoryPath is outside its Git worktree');
  await assertRepositoryHasNoGlobDeniedPaths(actualTop);
  return actualTop;
}

async function assertRepositoryHasNoGlobDeniedPaths(cwd) {
  if (configuredDisallowedPathGlobs.length === 0) return;
  const output = (await runGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout;
  for (const entry of output.split('\0').filter(Boolean)) {
    assertNotGlobDenied(resolve(cwd, entry), 'Git repository scan');
  }
}

async function deniedTrackedPaths(cwd) {
  const output = (await runGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout;
  const rules = await policy();
  return output.split('\0').filter(Boolean).filter((entry) => {
    const absolute = resolve(cwd, entry);
    return findDisallowedPathGlob(absolute, configuredDisallowedPathGlobs) !== null
      || rules.disallowedDirectories.some((root) => within(root, absolute))
      || rules.disallowedFiles.some((file) => same(file, absolute));
  });
}

async function assertNoExecutableGitConfiguration(cwd) {
  try {
    const output = (await runGit(cwd, ['config', '--show-origin', '--get-regexp', '^(core\\.(hooksPath|sshCommand|gitProxy|fsmonitor)|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.command|merge\\..*\\.driver|remote\\..*\\.(proxy|receivepack|uploadpack))$'])).stdout.trim();
    const unsafe = output.split(/\r?\n/).filter(Boolean).filter((line) => !line.startsWith('command line:'));
    if (unsafe.length > 0) throw new Error('Git configuration contains executable hooks, filters, diff commands, merge drivers, proxies, or custom transport commands');
  } catch (error) {
    if (!/git exited with 1$/.test(error.message)) throw error;
  }
}

async function assertTreeAvoidsDeniedPaths(cwd, treeish) {
  const output = (await runGit(cwd, ['ls-tree', '-r', '-z', '--name-only', treeish])).stdout;
  const rules = await policy();
  const denied = output.split('\0').filter(Boolean).filter((entry) => {
    const absolute = resolve(cwd, entry);
    return findDisallowedPathGlob(absolute, configuredDisallowedPathGlobs) !== null
      || rules.disallowedDirectories.some((root) => within(root, absolute))
      || rules.disallowedFiles.some((file) => same(file, absolute));
  });
  if (denied.length > 0) throw new Error(`Incoming tree contains denied paths: ${denied.join(', ')}`);
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'roots': return { ...(await policy()), workingDirectory: await workingDirectory(), disablePush: cli.disablePush, disablePull: cli.disablePull, disableClone: cli.disableClone };
    case 'get_working_directory': return { workingDirectory: await workingDirectory() };
    case 'set_working_directory': {
      const target = await assertAllowedExisting(args.path);
      if (!(await stat(target)).isDirectory()) throw new Error('Path is not a directory');
      workingDirectoryPromise = Promise.resolve(target);
      return { workingDirectory: target };
    }
    case 'status': {
      const cwd = await repository(args.repositoryPath);
      return { repositoryPath: cwd, status: (await runGit(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=all'])).stdout };
    }
    case 'ls_files': {
      const cwd = await repository(args.repositoryPath);
      return { repositoryPath: cwd, files: (await runGit(cwd, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean) };
    }
    case 'branches': {
      const cwd = await repository(args.repositoryPath);
      const branches = (await runGit(cwd, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)', 'refs/heads', 'refs/remotes'])).stdout;
      return { repositoryPath: cwd, branches: branches.split('\n').filter(Boolean).map((line) => { const [branch, head] = line.split('\0'); return { branch, current: head === '*' }; }) };
    }
    case 'remotes': {
      const cwd = await repository(args.repositoryPath);
      return { repositoryPath: cwd, remotes: (await runGit(cwd, ['remote', '-v'])).stdout.trim().split(/\r?\n/).filter(Boolean) };
    }
    case 'log': {
      const cwd = await repository(args.repositoryPath);
      const maxCount = args.maxCount ?? 20;
      if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 100) throw new Error('maxCount must be from 1 through 100');
      return { repositoryPath: cwd, log: (await runGit(cwd, ['log', `--max-count=${maxCount}`, '--date=iso-strict', '--format=%H%x00%an%x00%ad%x00%s'])).stdout };
    }
    case 'diff': {
      const cwd = await repository(args.repositoryPath);
      const command = ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv'];
      if (args.staged === true) command.push('--cached');
      command.push('--');
      return { repositoryPath: cwd, staged: args.staged === true, diff: (await runGit(cwd, command)).stdout };
    }
    case 'switch_branch': {
      const cwd = await repository(args.repositoryPath);
      await assertNoExecutableGitConfiguration(cwd);
      const branch = safeName(args.branch, 'branch');
      if (args.create !== true) await assertTreeAvoidsDeniedPaths(cwd, branch);
      await runGit(cwd, args.create === true ? ['switch', '-c', branch] : ['switch', branch]);
      return { repositoryPath: cwd, branch, created: args.create === true };
    }
    case 'add_all': {
      const cwd = await repository(args.repositoryPath);
      await assertNoExecutableGitConfiguration(cwd);
      const denied = await deniedTrackedPaths(cwd);
      if (denied.length > 0) throw new Error(`Refusing to stage denied paths: ${denied.join(', ')}`);
      await runGit(cwd, ['add', '--all', '--', '.']);
      return { repositoryPath: cwd, staged: true };
    }
    case 'commit': {
      const cwd = await repository(args.repositoryPath);
      await assertNoExecutableGitConfiguration(cwd);
      if (typeof args.message !== 'string' || args.message.length === 0 || /\0/.test(args.message)) throw new Error('message must be a non-empty string without NUL');
      if (Buffer.byteLength(args.message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) throw new Error('Commit message is too large');
      await runGit(cwd, ['commit', '--no-verify', '--no-gpg-sign', '-m', args.message]);
      return { repositoryPath: cwd, committed: true };
    }
    case 'push': {
      if (cli.disablePush) throw new Error('push is disabled');
      const cwd = await repository(args.repositoryPath);
      await assertNoExecutableGitConfiguration(cwd);
      const remote = safeRemote(args.remote ?? 'origin');
      const current = (await runGit(cwd, ['branch', '--show-current'])).stdout.trim();
      if (!current) throw new Error('Detached HEAD cannot be pushed');
      safeName(current, 'current branch');
      const command = ['push'];
      if (args.setUpstream === true) command.push('--set-upstream');
      command.push('--', remote, current);
      await runGit(cwd, command);
      return { repositoryPath: cwd, remote, branch: current, setUpstream: args.setUpstream === true };
    }
    case 'pull': {
      if (cli.disablePull) throw new Error('pull is disabled');
      const cwd = await repository(args.repositoryPath);
      await assertNoExecutableGitConfiguration(cwd);
      const current = (await runGit(cwd, ['branch', '--show-current'])).stdout.trim();
      if (!current) throw new Error('Detached HEAD cannot be pulled');
      safeName(current, 'current branch');
      const remote = (await runGit(cwd, ['config', '--get', `branch.${current}.remote`])).stdout.trim();
      safeRemote(remote);
      await runGit(cwd, ['fetch', '--no-recurse-submodules', '--', remote]);
      await runGit(cwd, ['rev-parse', '--verify', '@{upstream}']);
      await assertTreeAvoidsDeniedPaths(cwd, '@{upstream}');
      await runGit(cwd, ['merge', '--ff-only', '--no-edit', '@{upstream}']);
      return { repositoryPath: cwd, remote, branch: current, fastForwardOnly: true, recurseSubmodules: false };
    }
    case 'clone_repository': {
      if (cli.disableClone) throw new Error('clone is disabled');
      const url = safeCloneUrl(args.url);
      const { parent, destination } = await assertAllowedNewDirectory(args.parentDirectory ?? '.', args.destinationDirectory);
      const depth = args.depth;
      if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 1)) throw new Error('depth must be a positive safe integer');
      const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
      const command = ['clone', '--no-local', '--config', `core.hooksPath=${nullPath}`];
      if (args.recurseSubmodules === true) command.push('--recurse-submodules');
      if (depth !== undefined) command.push(`--depth=${depth}`);
      command.push('--', url, args.destinationDirectory);
      await runGit(parent, command);
      return {
        parentDirectory: parent,
        destinationDirectory: destination,
        recurseSubmodules: args.recurseSubmodules === true,
        ...(depth === undefined ? {} : { depth })
      };
    }
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
        serverInfo: { name: 'gitmcp', version: '1.0.0' },
        instructions: 'Allowlisted Git operations only. No shell, arbitrary Git arguments, direct .git editing, hook installation, force push, or arbitrary clone destination paths.'
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try { return response(request.id, toolResult({ ok: true, result: await callTool(request.params?.name, request.params?.arguments ?? {}) })); }
      catch (error) { return response(request.id, toolResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true)); }
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
  if (cli.help) process.stdout.write(GIT_MCP_HELP);
  else await startStdio();
}
