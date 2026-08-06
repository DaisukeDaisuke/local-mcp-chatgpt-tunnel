import { spawn } from 'node:child_process';
import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
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

Options:
  --disable-push=true|false   Remove the push tool when true. Default: false.
  --disable-pull=true|false   Remove the pull tool when true. Default: true.
  --disable-clone=true|false  Remove the clone_repository tool when true. Default: true.

The disable options affect only push, pull, and clone_repository. Local Git tools such as status,
diff, show, branch listing and creation, checkout, worktree creation and removal, add_all, and
commit remain available while this MCP server is enabled. Branch deletion is intentionally absent.
The gateway supplies allowed and denied paths through reserved LOCAL_MCP_* environment variables.
Gateway calls also require an HMAC-signed isolated base and root list; public root or workspace override arguments are rejected.
Standard Git ignore rules, attributes, line-ending conversion, system/global filters, and configured
commit signing are preserved. Repository-local executable Git configuration is rejected.
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
const isolation = createBundledIsolation();

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
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_STATE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_ADDITIVE_NON_IDEMPOTENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const OPEN_WORLD_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const OPEN_WORLD_ADDITIVE_NON_IDEMPOTENT_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const repositorySchema = () => ({
  type: 'object',
  properties: { repositoryPath: { type: 'string', default: '.' } },
  additionalProperties: false
});
const repositoryPathsSchema = () => ({
  type: 'object',
  properties: {
    repositoryPath: { type: 'string', default: '.' },
    paths: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 4096 },
      minItems: 1,
      maxItems: 100
    }
  },
  required: ['paths'],
  additionalProperties: false
});

const schemas = [
  { name: 'roots', description: 'List allowed and denied Git paths and the current working directory.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: READ_ONLY_ANNOTATIONS },
  {
    name: 'get_policy',
    description: 'Describe which standard Git ignore, attribute, line-ending, filter, signing, and configuration behaviors this MCP preserves or deliberately disables.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS
  },
  { name: 'get_working_directory', description: 'Return the directory used to resolve relative repository paths.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: READ_ONLY_ANNOTATIONS },
  {
    name: 'set_working_directory',
    description: 'Change the relative-path base to an existing allowed directory that is not denied.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
    annotations: LOCAL_STATE_ANNOTATIONS
  },
  { name: 'status', description: 'Return porcelain Git status. Standard Git ignore rules are respected for untracked files.', inputSchema: repositorySchema(), annotations: READ_ONLY_ANNOTATIONS },
  { name: 'ls_files', description: 'List tracked files without exposing .git internals. Tracked files remain listed even if a later ignore rule matches them.', inputSchema: repositorySchema(), annotations: READ_ONLY_ANNOTATIONS },
  { name: 'list_worktree_files', description: 'List tracked files and non-ignored untracked files using Git exclude rules, including .gitignore and configured excludes files.', inputSchema: repositorySchema(), annotations: READ_ONLY_ANNOTATIONS },
  { name: 'check_ignore', description: 'Ask Git which ignore rule applies to each repository path and whether that rule leaves the path ignored.', inputSchema: repositoryPathsSchema(), annotations: READ_ONLY_ANNOTATIONS },
  { name: 'check_attributes', description: 'Ask Git for all effective attributes on each repository path, including text, binary, diff, merge, filter, and line-ending attributes.', inputSchema: repositoryPathsSchema(), annotations: READ_ONLY_ANNOTATIONS },
  { name: 'get_effective_config', description: 'Return behavior-relevant effective Git configuration with scope and origin, excluding credentials and author name/email.', inputSchema: repositorySchema(), annotations: READ_ONLY_ANNOTATIONS },
  { name: 'branches', description: 'List local and remote branches with object IDs, upstreams, and the current branch.', inputSchema: repositorySchema(), annotations: READ_ONLY_ANNOTATIONS },
  { name: 'list_worktrees', description: 'List Git worktrees whose paths are inside the configured allowlist. Worktrees outside policy are omitted without exposing their paths.', inputSchema: repositorySchema(), annotations: READ_ONLY_ANNOTATIONS },
  { name: 'remotes', description: 'List configured remote names and URLs.', inputSchema: repositorySchema(), annotations: READ_ONLY_ANNOTATIONS },
  {
    name: 'log',
    description: 'Return a bounded recent commit log.',
    inputSchema: { type: 'object', properties: { repositoryPath: { type: 'string', default: '.' }, maxCount: { type: 'integer', minimum: 1, maximum: 100, default: 20 } }, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'diff',
    description: 'Return a working-tree or staged diff while respecting Git binary/text attributes and trusted system/global external diff and textconv configuration. Repository-local executable diff configuration is rejected.',
    inputSchema: { type: 'object', properties: { repositoryPath: { type: 'string', default: '.' }, staged: { type: 'boolean', default: false } }, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'show',
    description: 'Show one commit with an optional repository-relative file selection. format=patch returns the commit patch, stat returns its diffstat and summary, and summary returns commit metadata without a patch.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryPath: { type: 'string', default: '.' },
        commit: { type: 'string', minLength: 1, maxLength: 255, description: 'Commit object ID or a simple local revision such as HEAD, main, or HEAD~1.' },
        paths: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 4096 },
          minItems: 1,
          maxItems: 100,
          description: 'Optional repository-relative or absolute paths inside the selected worktree.'
        },
        format: { type: 'string', enum: ['patch', 'stat', 'summary'], default: 'patch' }
      },
      required: ['commit'],
      additionalProperties: false
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  {
    name: 'switch_branch',
    description: 'Switch to an existing local branch, or create and switch to one from an optional startPoint. startPoint is accepted only when create=true.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryPath: { type: 'string', default: '.' },
        branch: { type: 'string', minLength: 1, maxLength: 255 },
        create: { type: 'boolean', default: false },
        startPoint: { type: 'string', minLength: 1, maxLength: 255, description: 'Simple local revision used as the parent when create=true. Defaults to HEAD.' }
      },
      required: ['branch'],
      additionalProperties: false
    },
    annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: 'create_branch',
    description: 'Create a local branch from an optional startPoint and optionally switch to it. Branch deletion is not supported.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryPath: { type: 'string', default: '.' },
        branch: { type: 'string', minLength: 1, maxLength: 255 },
        startPoint: { type: 'string', minLength: 1, maxLength: 255, default: 'HEAD' },
        switch: { type: 'boolean', default: true }
      },
      required: ['branch'],
      additionalProperties: false
    },
    annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: 'checkout',
    description: 'Move HEAD to an existing local branch, or detach HEAD at a verified commit when detach=true. File/path checkout is not supported.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryPath: { type: 'string', default: '.' },
        target: { type: 'string', minLength: 1, maxLength: 255 },
        detach: { type: 'boolean', default: false }
      },
      required: ['target'],
      additionalProperties: false
    },
    annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: 'create_worktree',
    description: 'Create one Git worktree as a new child directory inside an allowed parent. It can use an existing local branch or create a new branch from startPoint.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryPath: { type: 'string', default: '.' },
        parentDirectory: { type: 'string', default: '.' },
        destinationDirectory: { type: 'string', minLength: 1, maxLength: 255 },
        branch: { type: 'string', minLength: 1, maxLength: 255 },
        createBranch: { type: 'boolean', default: false },
        startPoint: { type: 'string', minLength: 1, maxLength: 255, description: 'Simple local revision used only when createBranch=true. Defaults to HEAD.' }
      },
      required: ['destinationDirectory', 'branch'],
      additionalProperties: false
    },
    annotations: LOCAL_ADDITIVE_NON_IDEMPOTENT_ANNOTATIONS
  },
  {
    name: 'remove_worktree',
    description: 'Remove one registered non-primary Git worktree inside the configured allowlist. Dirty or locked worktrees are not forced, and branch deletion is not performed.',
    inputSchema: {
      type: 'object',
      properties: {
        repositoryPath: { type: 'string', default: '.' },
        worktreePath: { type: 'string', minLength: 1 }
      },
      required: ['worktreePath'],
      additionalProperties: false
    },
    annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
  },
  { name: 'add_all', description: 'Stage all non-ignored changes with the fixed command git add --all -- . Standard Git ignore, attributes, clean filters, and line-ending conversion are respected.', inputSchema: repositorySchema(), annotations: LOCAL_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS },
  {
    name: 'commit',
    description: 'Commit already staged changes using a literal message. Configured commit signing is respected; Git hooks remain disabled. This tool does not stage files.',
    inputSchema: { type: 'object', properties: { repositoryPath: { type: 'string', default: '.' }, message: { type: 'string', minLength: 1 } }, required: ['message'], additionalProperties: false },
    annotations: LOCAL_DESTRUCTIVE_NON_IDEMPOTENT_ANNOTATIONS
  },
  ...(!cli.disablePush ? [{
    name: 'push',
    description: 'Push the current branch to a named remote. Force push and arbitrary refspecs are not supported.',
    inputSchema: { type: 'object', properties: { repositoryPath: { type: 'string', default: '.' }, remote: { type: 'string', minLength: 1, maxLength: 255, default: 'origin' }, setUpstream: { type: 'boolean', default: false } }, additionalProperties: false },
    annotations: OPEN_WORLD_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS
  }] : []),
  ...(!cli.disablePull ? [{
    name: 'pull',
    description: 'Fetch the configured upstream without submodules, reject denied incoming paths, then fast-forward only. Arbitrary remotes, refspecs, merge commits, and rebase are not supported.',
    inputSchema: repositorySchema(),
    annotations: OPEN_WORLD_DESTRUCTIVE_IDEMPOTENT_ANNOTATIONS
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
    },
    annotations: OPEN_WORLD_ADDITIVE_NON_IDEMPOTENT_ANNOTATIONS
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
  const configured = await policyPromise;
  const context = isolation.current();
  if (!context) return configured;
  return {
    ...configured,
    allowedDirectories: [...context.roots],
    allowedFiles: []
  };
}

async function workingDirectory() {
  const context = isolation.current();
  if (context) return context.base;
  return (await policy()).allowedDirectories[0];
}

function outsidePolicyError(message, rules) {
  return new Error([
    message,
    `Allowed directories (absolute): ${rules.allowedDirectories.length > 0 ? rules.allowedDirectories.join(', ') : '(none)'}`,
    `Allowed files (absolute): ${rules.allowedFiles.length > 0 ? rules.allowedFiles.join(', ') : '(none)'}`
  ].join('\n'));
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
  if (!allowed) throw outsidePolicyError('Path is outside allowed_directories and allowed_files', rules);
  const denied = rules.disallowedDirectories.some((root) => within(root, actual)) || rules.disallowedFiles.some((file) => same(file, actual));
  if (denied) throw new Error('Path is denied by disallowed_directories or disallowed_files');
  return actual;
}

async function assertAllowedNewDirectory(parentDirectory, destinationDirectory, context = 'Git destination') {
  const parent = await assertAllowedExisting(parentDirectory);
  if (!(await stat(parent)).isDirectory()) throw new Error('parentDirectory is not a directory');
  if (typeof destinationDirectory !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/.test(destinationDirectory)) {
    throw new Error('destinationDirectory must be one relative directory name without separators or option-looking syntax');
  }
  if (destinationDirectory === '.' || destinationDirectory === '..' || destinationDirectory.toLowerCase() === '.git') throw new Error('Unsafe destinationDirectory');
  const destination = resolve(parent, destinationDirectory);
  assertNotGlobDenied(destination, context);
  if (!within(parent, destination)) throw new Error(`${context} escaped parentDirectory`);
  const rules = await policy();
  if (!rules.allowedDirectories.some((root) => within(root, destination))) throw outsidePolicyError(`${context} is outside allowed_directories`, rules);
  if (rules.disallowedDirectories.some((root) => within(root, destination)) || rules.disallowedFiles.some((file) => same(file, destination))) throw new Error(`${context} is denied`);
  try { await lstat(destination); throw new Error(`${context} already exists`); }
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

function safeCommit(value, label = 'commit') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || /[\0\r\n]/.test(value) || value.startsWith('-')) {
    throw new Error(`${label} is invalid`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/~^+-]{0,254}$/.test(value)
      || value.includes('..')
      || value.includes('//')
      || value.endsWith('/')
      || value.endsWith('.')
      || value.endsWith('.lock')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

async function safeBranchName(cwd, value, label = 'branch') {
  const branch = safeName(value, label);
  const checked = (await runGit(cwd, ['check-ref-format', '--branch', branch])).stdout.trim();
  if (checked !== branch) throw new Error(`${label} is invalid`);
  return branch;
}

async function resolveCommit(cwd, value, label = 'commit') {
  const requested = safeCommit(value, label);
  const objectId = (await runGit(cwd, ['rev-parse', '--verify', '--end-of-options', `${requested}^{commit}`])).stdout.trim();
  if (!/^[0-9A-Fa-f]{40,64}$/.test(objectId)) throw new Error('Git returned an invalid commit object ID');
  await assertTreeAvoidsDeniedPaths(cwd, objectId);
  return { requested, objectId };
}

function safeShowFormat(value = 'patch') {
  if (!['patch', 'stat', 'summary'].includes(value)) throw new Error('format must be patch, stat, or summary');
  return value;
}

function safeCloneUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value) || value.startsWith('-')) throw new Error('Clone URL is invalid');
  if (/^(?:https?|ssh):\/\//i.test(value) || /^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/.test(value)) return value;
  throw new Error('Clone URL must use http, https, ssh, or git@host:path syntax');
}

async function runGit(cwd, args, { input, acceptedExitCodes = [0] } = {}) {
  return new Promise((resolvePromise, reject) => {
    const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    const environment = {
      ...environmentWithoutBundledIsolationKey(),
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_CONFIG_COUNT: '7',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: nullPath,
      GIT_CONFIG_KEY_1: 'protocol.file.allow',
      GIT_CONFIG_VALUE_1: 'never',
      GIT_CONFIG_KEY_2: 'protocol.ext.allow',
      GIT_CONFIG_VALUE_2: 'never',
      GIT_CONFIG_KEY_3: 'protocol.http.allow',
      GIT_CONFIG_VALUE_3: 'always',
      GIT_CONFIG_KEY_4: 'protocol.https.allow',
      GIT_CONFIG_VALUE_4: 'always',
      GIT_CONFIG_KEY_5: 'protocol.ssh.allow',
      GIT_CONFIG_VALUE_5: 'always',
      GIT_CONFIG_KEY_6: 'core.fsmonitor',
      GIT_CONFIG_VALUE_6: 'false'
    };
    delete environment.GIT_EXTERNAL_DIFF;
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: environment
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
    child.once('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (!acceptedExitCodes.includes(code)) finish(new Error(err.trim() || out.trim() || `git exited with ${code}`));
      else finish(null, { stdout: out, stderr: err, exitCode: code });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function repository(path = '.') {
  const cwd = await assertAllowedExisting(path);
  if (!(await stat(cwd)).isDirectory()) throw new Error('repositoryPath is not a directory');
  const top = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const actualTop = await assertAllowedExisting(top);
  if (!within(actualTop, cwd)) throw new Error('repositoryPath is outside its Git worktree');
  await assertNoRepositoryExecutableGitConfiguration(actualTop);
  await assertRepositoryHasNoGlobDeniedPaths(actualTop);
  const denied = await deniedTrackedPaths(actualTop);
  if (denied.length > 0) throw new Error(`Repository contains denied paths: ${denied.join(', ')}`);
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

async function assertNoRepositoryExecutableGitConfiguration(cwd) {
  try {
    const output = (await runGit(cwd, [
      'config',
      '--show-scope',
      '--show-origin',
      '--get-regexp',
      '^(core\\.(hookspath|sshcommand|gitproxy|fsmonitor|attributesfile|excludesfile)|credential\\..*helper|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv)|merge\\..*\\.driver|gpg\\.(program|ssh\\.program)|remote\\..*\\.(proxy|receivepack|uploadpack))$'
    ])).stdout.trim();
    const unsafe = output.split(/\r?\n/).filter(Boolean).filter((line) => /^(local|worktree)\s/.test(line));
    if (unsafe.length > 0) {
      throw new Error('Repository-local Git configuration contains executable hooks, helpers, filters, diff/textconv commands, merge drivers, signing programs, proxies, custom transport commands, or external attributes/ignore files');
    }
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

async function repositoryRelativePaths(cwd, values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw new Error('paths must contain from 1 through 100 entries');
  const rules = await policy();
  return values.map((value) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[\0\r\n]/.test(value)) {
      throw new Error('Each paths entry must be a non-empty string of at most 4096 characters without NUL or line breaks');
    }
    const candidate = resolve(isAbsolute(value) ? value : join(cwd, value));
    if (!within(cwd, candidate)) throw new Error(`Repository path escaped the worktree: ${value}`);
    assertNotGlobDenied(candidate, 'Git repository path');
    if (rules.disallowedDirectories.some((root) => within(root, candidate)) || rules.disallowedFiles.some((file) => same(file, candidate))) {
      throw new Error(`Repository path is denied: ${value}`);
    }
    const relativePath = candidate === cwd ? '.' : relative(cwd, candidate).split(sep).join('/');
    if (relativePath.split('/').includes('.git')) throw new Error(`Direct .git paths are not supported: ${value}`);
    return relativePath;
  });
}

function parseIgnoreDecisions(stdout) {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 4 !== 0) throw new Error('Unexpected git check-ignore output');
  const decisions = [];
  for (let index = 0; index < fields.length; index += 4) {
    const [source, lineNumber, pattern, path] = fields.slice(index, index + 4);
    decisions.push({
      path,
      ignored: pattern.length > 0 && !pattern.startsWith('!'),
      source: source || null,
      lineNumber: lineNumber ? Number(lineNumber) : null,
      pattern: pattern || null
    });
  }
  return decisions;
}

function parseAttributes(stdout) {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 3 !== 0) throw new Error('Unexpected git check-attr output');
  const byPath = new Map();
  for (let index = 0; index < fields.length; index += 3) {
    const [path, attribute, value] = fields.slice(index, index + 3);
    const attributes = byPath.get(path) ?? [];
    attributes.push({ attribute, value });
    byPath.set(path, attributes);
  }
  return [...byPath].map(([path, attributes]) => ({ path, attributes }));
}

function parseBranches(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [fullName, branch, objectId, head, upstream] = line.split('\0');
    if (!fullName || !branch || !/^[0-9A-Fa-f]{40,64}$/.test(objectId ?? '')) throw new Error('Unexpected git for-each-ref output');
    const type = fullName.startsWith('refs/heads/') ? 'local' : fullName.startsWith('refs/remotes/') ? 'remote' : 'other';
    return {
      branch,
      fullName,
      type,
      objectId,
      current: head === '*',
      upstream: upstream || null
    };
  });
}

function parseWorktrees(stdout) {
  const worktrees = [];
  let current = null;
  const finish = () => {
    if (current === null) return;
    if (typeof current.path !== 'string' || current.path.length === 0) throw new Error('Unexpected git worktree output');
    worktrees.push(current);
    current = null;
  };
  for (const field of stdout.split('\0')) {
    if (field === '') {
      finish();
      continue;
    }
    const separator = field.indexOf(' ');
    const key = separator < 0 ? field : field.slice(0, separator);
    const value = separator < 0 ? '' : field.slice(separator + 1);
    if (key === 'worktree') {
      finish();
      current = {
        path: value,
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null
      };
      continue;
    }
    if (current === null) throw new Error('Unexpected git worktree output');
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') {
      current.locked = true;
      current.lockReason = value || null;
    } else if (key === 'prunable') {
      current.prunable = true;
      current.pruneReason = value || null;
    }
  }
  finish();
  return worktrees;
}

async function visibleWorktreePath(path) {
  try {
    const actual = await realpath(resolve(path));
    if (!(await stat(actual)).isDirectory()) return null;
    assertNotGlobDenied(actual, 'Git worktree path');
    const rules = await policy();
    if (!rules.allowedDirectories.some((root) => within(root, actual))) return null;
    if (rules.disallowedDirectories.some((root) => within(root, actual)) || rules.disallowedFiles.some((file) => same(file, actual))) return null;
    return actual;
  } catch {
    return null;
  }
}

async function worktreesForRepository(cwd) {
  return parseWorktrees((await runGit(cwd, ['worktree', 'list', '--porcelain', '-z'])).stdout);
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'roots': return { ...(await policy()), workingDirectory: await workingDirectory(), disablePush: cli.disablePush, disablePull: cli.disablePull, disableClone: cli.disableClone };
    case 'get_policy':
      return {
        ignoreRules: {
          respected: true,
          ignoredUntrackedFilesShownByStatus: false,
          ignoredUntrackedFilesStagedByAddAll: false,
          trackedFilesRemainTrackedWhenIgnoredLater: true
        },
        attributes: {
          repositoryAttributesRespected: true,
          infoAttributesRespected: true,
          globalAttributesFileRespected: true,
          binaryAndTextClassificationRespectedByDiff: true,
          systemAndGlobalExternalDiffCommandsRespected: true,
          systemAndGlobalTextconvRespected: true,
          repositoryExternalDiffAndTextconvRejected: true
        },
        gitConfiguration: {
          systemConfigurationRespected: true,
          globalConfigurationRespected: true,
          repositoryOrdinaryConfigurationRespected: true,
          repositoryExecutableConfigurationRejected: true,
          repositoryExternalAttributesAndIgnoreFilesRejected: true,
          lineEndingConversionRespected: true,
          systemAndGlobalCleanSmudgeFiltersRespected: true,
          configuredCommitSigningRespected: true
        },
        deliberatelyDisabled: {
          hooks: true,
          fsmonitor: true,
          fileProtocol: true,
          extProtocol: true,
          interactiveCredentialPrompt: true
        }
      };
    case 'get_working_directory': return { workingDirectory: await workingDirectory() };
    case 'set_working_directory': {
      const target = await assertAllowedExisting(args.path);
      if (!(await stat(target)).isDirectory()) throw new Error('Path is not a directory');
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
    case 'list_worktree_files': {
      const cwd = await repository(args.repositoryPath);
      const files = (await runGit(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).stdout.split('\0').filter(Boolean);
      files.sort((left, right) => left.localeCompare(right));
      return { repositoryPath: cwd, files };
    }
    case 'check_ignore': {
      const cwd = await repository(args.repositoryPath);
      const paths = await repositoryRelativePaths(cwd, args.paths);
      const result = await runGit(cwd, ['check-ignore', '-z', '-v', '--no-index', '--non-matching', '--stdin'], {
        input: `${paths.join('\0')}\0`,
        acceptedExitCodes: [0, 1]
      });
      return { repositoryPath: cwd, decisions: parseIgnoreDecisions(result.stdout) };
    }
    case 'check_attributes': {
      const cwd = await repository(args.repositoryPath);
      const paths = await repositoryRelativePaths(cwd, args.paths);
      const result = await runGit(cwd, ['check-attr', '-z', '-a', '--stdin'], { input: `${paths.join('\0')}\0` });
      const attributes = parseAttributes(result.stdout);
      const present = new Set(attributes.map((entry) => entry.path));
      for (const path of paths) if (!present.has(path)) attributes.push({ path, attributes: [] });
      return { repositoryPath: cwd, paths: attributes };
    }
    case 'get_effective_config': {
      const cwd = await repository(args.repositoryPath);
      const result = await runGit(cwd, [
        'config',
        '--show-scope',
        '--show-origin',
        '--get-regexp',
        '^(core\\.(autocrlf|safecrlf|eol|attributesfile|excludesfile|symlinks|fscache)|commit\\.gpgsign|gpg\\.(format|program|ssh\\.program)|user\\.signingkey|filter\\..*\\.(clean|smudge|process|required)|diff\\..*\\.(binary|textconv)|push\\.followtags|pull\\.rebase)$'
      ], { acceptedExitCodes: [0, 1] });
      return { repositoryPath: cwd, configuration: result.stdout.trim().split(/\r?\n/).filter(Boolean) };
    }
    case 'branches': {
      const cwd = await repository(args.repositoryPath);
      const branches = (await runGit(cwd, [
        'for-each-ref',
        '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)%00%(upstream:short)',
        'refs/heads',
        'refs/remotes'
      ])).stdout;
      return { repositoryPath: cwd, branches: parseBranches(branches) };
    }
    case 'list_worktrees': {
      const cwd = await repository(args.repositoryPath);
      const worktrees = [];
      for (const item of await worktreesForRepository(cwd)) {
        const path = await visibleWorktreePath(item.path);
        if (path === null) continue;
        worktrees.push({ ...item, path, current: same(path, cwd) });
      }
      return { repositoryPath: cwd, worktrees };
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
      const command = ['--no-pager', 'diff', '--ext-diff', '--textconv'];
      if (args.staged === true) command.push('--cached');
      command.push('--');
      return { repositoryPath: cwd, staged: args.staged === true, diff: (await runGit(cwd, command)).stdout };
    }
    case 'show': {
      const cwd = await repository(args.repositoryPath);
      const requestedCommit = safeCommit(args.commit);
      const objectId = (await runGit(cwd, ['rev-parse', '--verify', '--end-of-options', `${requestedCommit}^{commit}`])).stdout.trim();
      if (!/^[0-9A-Fa-f]{40,64}$/.test(objectId)) throw new Error('Git returned an invalid commit object ID');
      await assertTreeAvoidsDeniedPaths(cwd, objectId);
      const paths = args.paths === undefined ? [] : await repositoryRelativePaths(cwd, args.paths);
      const format = safeShowFormat(args.format ?? 'patch');
      const command = ['--no-pager', '--literal-pathspecs', 'show', '--format=fuller'];
      if (format === 'patch') command.push('--ext-diff', '--textconv');
      else if (format === 'stat') command.push('--stat', '--summary');
      else command.push('--summary', '--no-patch');
      command.push(objectId);
      if (paths.length > 0) command.push('--', ...paths);
      return {
        repositoryPath: cwd,
        commit: requestedCommit,
        objectId,
        format,
        paths,
        show: (await runGit(cwd, command)).stdout
      };
    }
    case 'switch_branch': {
      const cwd = await repository(args.repositoryPath);
      const branch = await safeBranchName(cwd, args.branch);
      if (args.create === true) {
        const startPoint = await resolveCommit(cwd, args.startPoint ?? 'HEAD', 'startPoint');
        await runGit(cwd, ['switch', '-c', branch, startPoint.objectId]);
        return { repositoryPath: cwd, branch, created: true, startPoint: startPoint.requested, objectId: startPoint.objectId };
      }
      if (args.startPoint !== undefined) throw new Error('startPoint is accepted only when create=true');
      const target = await resolveCommit(cwd, `refs/heads/${branch}`, 'branch');
      await runGit(cwd, ['switch', branch]);
      return { repositoryPath: cwd, branch, created: false, objectId: target.objectId };
    }
    case 'create_branch': {
      const cwd = await repository(args.repositoryPath);
      const branch = await safeBranchName(cwd, args.branch);
      const startPoint = await resolveCommit(cwd, args.startPoint ?? 'HEAD', 'startPoint');
      if (args.switch === false) await runGit(cwd, ['branch', branch, startPoint.objectId]);
      else await runGit(cwd, ['switch', '-c', branch, startPoint.objectId]);
      return {
        repositoryPath: cwd,
        branch,
        startPoint: startPoint.requested,
        objectId: startPoint.objectId,
        switched: args.switch !== false
      };
    }
    case 'checkout': {
      const cwd = await repository(args.repositoryPath);
      if (args.detach === true) {
        const target = await resolveCommit(cwd, args.target, 'target');
        await runGit(cwd, ['checkout', '--detach', target.objectId]);
        return { repositoryPath: cwd, target: target.requested, objectId: target.objectId, detached: true };
      }
      const branch = await safeBranchName(cwd, args.target, 'target');
      const target = await resolveCommit(cwd, `refs/heads/${branch}`, 'target');
      await runGit(cwd, ['checkout', branch]);
      return { repositoryPath: cwd, target: branch, objectId: target.objectId, detached: false };
    }
    case 'create_worktree': {
      const cwd = await repository(args.repositoryPath);
      const branch = await safeBranchName(cwd, args.branch);
      const { parent, destination } = await assertAllowedNewDirectory(
        args.parentDirectory ?? '.',
        args.destinationDirectory,
        'Git worktree destination'
      );
      let startPoint = null;
      let command;
      if (args.createBranch === true) {
        startPoint = await resolveCommit(cwd, args.startPoint ?? 'HEAD', 'startPoint');
        command = ['worktree', 'add', '-b', branch, '--', destination, startPoint.objectId];
      } else {
        if (args.startPoint !== undefined) throw new Error('startPoint is accepted only when createBranch=true');
        await resolveCommit(cwd, `refs/heads/${branch}`, 'branch');
        command = ['worktree', 'add', '--', destination, branch];
      }
      await runGit(cwd, command);
      const actualDestination = await realpath(destination);
      if (!same(actualDestination, destination)) throw new Error('Git created the worktree at an unexpected path');
      return {
        repositoryPath: cwd,
        parentDirectory: parent,
        worktreePath: actualDestination,
        branch,
        createdBranch: args.createBranch === true,
        ...(startPoint === null ? {} : { startPoint: startPoint.requested, objectId: startPoint.objectId })
      };
    }
    case 'remove_worktree': {
      const cwd = await repository(args.repositoryPath);
      const target = await assertAllowedExisting(args.worktreePath);
      if (!(await stat(target)).isDirectory()) throw new Error('worktreePath is not a directory');
      const registered = await worktreesForRepository(cwd);
      let matchIndex = -1;
      for (const [index, item] of registered.entries()) {
        const path = await visibleWorktreePath(item.path);
        if (path !== null && same(path, target)) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex < 0) throw new Error('worktreePath is not a registered allowed worktree');
      if (matchIndex === 0) throw new Error('The primary worktree cannot be removed');
      if (same(target, cwd)) throw new Error('The current worktree cannot remove itself');
      if (registered[matchIndex].locked) throw new Error('Locked worktrees are not removed');
      await runGit(cwd, ['worktree', 'remove', '--', target]);
      return { repositoryPath: cwd, worktreePath: target, removed: true, branchDeleted: false, forced: false };
    }
    case 'add_all': {
      const cwd = await repository(args.repositoryPath);
      const denied = await deniedTrackedPaths(cwd);
      if (denied.length > 0) throw new Error(`Refusing to stage denied paths: ${denied.join(', ')}`);
      await runGit(cwd, ['add', '--all', '--', '.']);
      return { repositoryPath: cwd, staged: true };
    }
    case 'commit': {
      const cwd = await repository(args.repositoryPath);
      if (typeof args.message !== 'string' || args.message.length === 0 || /\0/.test(args.message)) throw new Error('message must be a non-empty string without NUL');
      if (Buffer.byteLength(args.message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) throw new Error('Commit message is too large');
      await runGit(cwd, ['commit', '--no-verify', '-m', args.message]);
      return { repositoryPath: cwd, committed: true };
    }
    case 'push': {
      if (cli.disablePush) throw new Error('push is disabled');
      const cwd = await repository(args.repositoryPath);
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
        serverInfo: { name: 'gitmcp', version: '1.2.0' },
        instructions: 'Allowlisted Git operations only. Branch listing, creation, switching, checkout, and allowed-path worktree creation/removal are supported; branch deletion and forced worktree removal are not. Standard ignore rules, attributes, line-ending conversion, system/global filters, external diff/textconv, and configured commit signing are preserved. Repository-local executable Git configuration, hooks, force push, and arbitrary clone destinations are blocked.'
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      try {
        const result = await isolation.run(
          request.params?.arguments ?? {},
          (toolArguments) => callTool(request.params?.name, toolArguments)
        );
        return response(request.id, toolResult({ ok: true, result }));
      }
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
