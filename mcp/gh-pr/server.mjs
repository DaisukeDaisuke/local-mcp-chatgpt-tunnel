import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { buildChildEnvironment } from '../../app/child-environment.mjs';
import { ToolPathPolicy } from '../../app/path-policy.mjs';
import { findDisallowedPathGlob, normalizeDisallowedPathGlobs } from '../../app/path-glob.mjs';

const MAX_BODY = 1024 * 1024;
const MAX_PROCESS_OUTPUT = 8 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const VIEW_FIELDS = 'number,url,title,body,state,isDraft,baseRefName,headRefName,headRefOid,headRepositoryOwner';
const REVIEW_FIELDS = 'number,url,state,isDraft,headRefOid,reviewDecision,reviewRequests';
const COMMENT_FIELDS = 'number,url,state,isDraft,headRefOid,comments';
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const EDIT = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const SET_STATE = { ...EDIT, destructiveHint: false };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const textSchema = { type: 'string' };
const nullableText = { type: ['string', 'null'] };
const countSchema = { type: 'integer', minimum: 0 };

export const GH_PR_MCP_HELP = `gh-pr
Usage:
  node mcp/gh-pr/server.mjs --repository=OWNER/REPO [--repository=OWNER/REPO ...] --token-file=ABSOLUTE_FILE --gh-executable=ABSOLUTE_GH [--max-body=10K]
Only gh pr create/edit/ready/view/comment and a fixed gh repo view identity preflight.
Exact comment-ID editing uses one fixed gh api PATCH after membership verification
by gh pr view; no Issue create/edit/close operation or arbitrary API is exposed.
--max-body accepts bytes, B, K/KB/KiB, M/MB/MiB (base 1024), up to 1M; default 10K.
Requires sandbox=onlineworkspace. No inline token, arbitrary gh flags, push, merge,
checkout, review submission, shell, browser, download, or package installation.
Token and gh are fixed read-only trust inputs, outside writable workspace roots,
and must be listed in allowed_files. Public operations use signed roots/base only.
`;

function fail(message, code = 'INVALID_ARGUMENT', details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function within(root, path) {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
function validText(value, label, maximum, empty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim()) || /\0/.test(value)
      || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) {
    throw fail(`${label} must be valid UTF-8 text within its size limit`);
  }
  return value;
}
function repository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)
      || value.includes('..') || /\.git$/i.test(value)) throw fail('repository must be github.com OWNER/REPO');
  return value;
}
function branch(value, label) {
  validText(value, label, 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.includes('//')
      || value.split('/').some((part) => part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
      || value.endsWith('/')) throw fail(`${label} is not a supported branch name`);
  return value;
}
function head(value) {
  if (typeof value !== 'string') throw fail('head must be BRANCH or OWNER:BRANCH');
  const parts = value.split(':');
  if (parts.length === 1) return branch(value, 'head');
  if (parts.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[0])) throw fail('head must be BRANCH or OWNER:BRANCH');
  return `${parts[0]}:${branch(parts[1], 'head branch')}`;
}
export function parseBodyLimit(value = '10K') {
  const match = /^([1-9][0-9]{0,6})(B|K|KB|KiB|M|MB|MiB)?$/i.exec(value);
  if (!match) throw fail('--max-body must be a positive byte count such as 100B, 10K, or 1M');
  const unit = (match[2] ?? 'B').toUpperCase();
  const size = Number(match[1]) * (unit.startsWith('K') ? 1024 : unit.startsWith('M') ? 1024 * 1024 : 1);
  if (size > MAX_BODY) throw fail('--max-body may not exceed 1M (1048576 UTF-8 bytes)');
  return size;
}
function pathSyntax(value, label) {
  if (typeof value !== 'string' || !value || value.length > 32767 || /[\x00-\x1f\x7f]/.test(value)
      || /^(?:\\|\/\/)/.test(value) || /^[A-Za-z]:(?![\\/])/.test(value)
      || /[%$]/.test(value)) throw fail(`${label} contains unsupported path syntax`, 'PATH_REJECTED');
  if (process.platform === 'win32') {
    if (value.replace(/^[A-Za-z]:/, '').includes(':') || /[<>"|?*]/.test(value)
        || value.replace(/^[A-Za-z]:[\\/]/, '').split(/[\\/]/).some((part) => /[. ]$/.test(part) && part !== '..' && part !== '.')
        || value.split(/[\\/]/).some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw fail(`${label} contains unsupported Windows path syntax`, 'PATH_REJECTED');
    }
  } else if (value.includes('\\') || value.includes(':')) throw fail(`${label} contains unsupported path syntax`, 'PATH_REJECTED');
  return value;
}
export function parseStartupArguments(argv) {
  const values = {};
  const repositories = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') { help = true; continue; }
    const match = /^--(repository|token-file|gh-executable|max-body)(?:=(.*))?$/s.exec(argv[index]);
    // Never echo arguments: unsupported flags may contain a credential.
    if (!match) throw fail('Unsupported startup argument; use --help');
    const value = match[2] ?? argv[++index];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw fail(`--${match[1]} requires a value`);
    if (match[1] === 'repository') repositories.push(repository(value));
    else {
      if (Object.hasOwn(values, match[1])) throw fail(`--${match[1]} may be specified only once`);
      values[match[1]] = value;
    }
  }
  if (help) return { help: true };
  if (!repositories.length || repositories.length > 100) throw fail('Specify from 1 through 100 --repository=OWNER/REPO entries');
  for (const name of ['token-file', 'gh-executable']) {
    pathSyntax(values[name], `--${name}`);
    if (!isAbsolute(values[name])) throw fail(`--${name} must be an absolute path`);
  }
  if (!/^gh(?:\.exe)?$/i.test(basename(values['gh-executable']))
      || (process.platform === 'win32' && !/\.exe$/i.test(values['gh-executable']))) throw fail('--gh-executable must identify gh (gh.exe on Windows)');
  return { help: false, repositories: [...new Map(repositories.map((repo) => [repo.toLowerCase(), repo])).values()],
    tokenFile: values['token-file'], executable: values['gh-executable'], maxBodyBytes: parseBodyLimit(values['max-body']) };
}
function arrayEnvironment(env, name, paths = true) {
  let result;
  try { result = JSON.parse(env[name] ?? '[]'); } catch { throw fail(`Invalid ${name} configuration`); }
  if (!Array.isArray(result) || result.length > 1000 || result.some((value) => typeof value !== 'string')) throw fail(`Invalid ${name} configuration`);
  if (paths) for (const value of result) {
    pathSyntax(value, name);
    if (!isAbsolute(value)) throw fail(`${name} must contain absolute paths`);
  }
  return result;
}
function settings(env) {
  if (env.LOCAL_MCP_CODEX_SANDBOX_MODE !== 'onlineworkspace') throw fail('gh-pr requires the onlineworkspace MCP sandbox', 'SANDBOX_REQUIRED');
  // The SDK helper treats an empty key as standalone; presence must fail closed.
  if (Object.hasOwn(env, 'LOCAL_MCP_GATEWAY_ISOLATION_KEY') && (typeof env.LOCAL_MCP_GATEWAY_ISOLATION_KEY !== 'string'
      || env.LOCAL_MCP_GATEWAY_ISOLATION_KEY.length < 32)) throw fail('Invalid Gateway isolation key configuration', 'ISOLATION_REJECTED');
  return {
    allowedDirectories: arrayEnvironment(env, 'LOCAL_MCP_ALLOWED_DIRECTORIES'),
    allowedFiles: arrayEnvironment(env, 'LOCAL_MCP_ALLOWED_FILES'),
    disallowedDirectories: arrayEnvironment(env, 'LOCAL_MCP_DISALLOWED_DIRECTORIES'),
    disallowedFiles: arrayEnvironment(env, 'LOCAL_MCP_DISALLOWED_FILES'),
    disallowedPathGlobs: normalizeDisallowedPathGlobs(arrayEnvironment(env, 'LOCAL_MCP_DISALLOWED_PATH_GLOBS', false)),
    disallowedPathsCanonical: env.LOCAL_MCP_DISALLOWED_PATHS_CANONICAL === '1'
  };
}

function schemas(config) {
  const repo = { type: 'string', enum: config.repositories, ...(config.repositories.length === 1 ? { default: config.repositories[0] } : {}) };
  const number = { type: 'integer', minimum: 1, maximum: 2147483647 };
  const commentId = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'REST timeline comment ID from list_pr_comments or #issuecomment-ID. Not a review inline-comment ID.' };
  const input = (extra = {}, required = []) => object({ repository: repo, ...extra }, [...(config.repositories.length === 1 ? [] : ['repository']), ...required]);
  const pr = object({ repository: textSchema, number, url: textSchema, title: textSchema, state: { type: 'string', enum: ['OPEN', 'CLOSED', 'MERGED'] },
    isDraft: { type: 'boolean' }, base: textSchema, head: textSchema, headOwner: nullableText, headSha: textSchema,
    body: nullableText, bodyBytes: countSchema, bodyOmitted: { type: 'boolean' } });
  const review = object({ repository: textSchema, number, url: textSchema, state: { type: 'string', enum: ['OPEN', 'CLOSED', 'MERGED'] },
    isDraft: { type: 'boolean' }, headSha: textSchema, reviewDecision: { type: ['string', 'null'], enum: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', null] },
    pendingReviewRequests: countSchema, reviewComplete: { type: ['boolean', 'null'] }, checkedAt: textSchema,
    scope: { type: 'string', enum: ['github-review-decision'] } });
  const comment = object({ prNumber: number, commentId, url: textSchema, author: nullableText, body: nullableText, bodyBytes: countSchema, bodyOmitted: { type: 'boolean' } });
  const singleComment = object({ repository: textSchema, comment });
  const commentList = object({ repository: textSchema, prNumber: number, comments: { type: 'array', maxItems: 1000, items: comment },
    returnedCount: countSchema, mayBeTruncated: { type: 'boolean' } });
  const failure = object({ exitCode: { type: ['integer', 'null'] }, signal: nullableText, stdout: textSchema, stderr: textSchema, writeMayHaveSucceeded: { type: 'boolean' } });
  const output = (result) => ({ type: 'object', properties: { ok: { type: 'boolean' }, result,
    error: textSchema, code: textSchema, execution: failure }, required: ['ok'], additionalProperties: false,
    oneOf: [{ required: ['result'], properties: { ok: { const: true } }, not: { anyOf: [{ required: ['error'] }, { required: ['execution'] }, { required: ['code'] }] } },
      { required: ['error', 'code'], properties: { ok: { const: false } }, not: { required: ['result'] } }] });
  return [
    { name: 'create_pr', description: 'Run gh pr create in a startup-allowlisted github.com repository. Explicit base/head prevent branch inference or pushing. Body is literal UTF-8 via stdin and is checked in bytes before any file access or gh process.',
      inputSchema: input({ base: { type: 'string', minLength: 1, maxLength: 255 }, head: { type: 'string', minLength: 1, maxLength: 295, description: 'BRANCH or OWNER:BRANCH, using GitHub CLI-supported fork syntax.' },
        title: { type: 'string', minLength: 1, maxLength: 256 }, body: { type: 'string', maxLength: config.maxBodyBytes, description: `At most ${config.maxBodyBytes} UTF-8 bytes; never truncated.` },
        draft: { type: 'boolean', default: false } }, ['base', 'head', 'title', 'body']), annotations: CREATE, result: pr },
    { name: 'edit_pr_body', description: 'Run gh pr edit NUMBER --body-file - to replace only the PR body in an allowlisted repository. No shell, editor, arbitrary flags, title changes, or file paths; enforce the configured UTF-8 byte limit before gh.',
      inputSchema: input({ prNumber: number, body: { type: 'string', maxLength: config.maxBodyBytes } }, ['prNumber', 'body']), annotations: EDIT, result: pr },
    { name: 'convert_to_draft', description: 'Run gh pr ready NUMBER --undo for the exact allowlisted repository and numeric PR. This changes draft state only; it does not submit or approve a review.',
      inputSchema: input({ prNumber: number }, ['prNumber']), annotations: SET_STATE, result: pr },
    { name: 'mark_ready_for_review', description: 'Run gh pr ready NUMBER for the exact allowlisted repository and numeric PR. Leaving draft means ready for review, not review completed or permission to merge.',
      inputSchema: input({ prNumber: number }, ['prNumber']), annotations: SET_STATE, result: pr },
    { name: 'view_pr', description: 'Read one PR with fixed gh pr view JSON fields. Validate its github.com URL against the allowlisted repository; omit an oversized existing body rather than returning unbounded data.',
      inputSchema: input({ prNumber: number }, ['prNumber']), annotations: READ, result: pr },
    { name: 'check_review_status', description: 'Read GitHub reviewDecision and outstanding review requests using gh pr view. Complete is true only for an open non-draft APPROVED PR with zero pending requests. Null decision or a possibly capped request list returns null. This does not certify CI or resolved discussion threads and never submits a review.',
      inputSchema: input({ prNumber: number }, ['prNumber']), annotations: READ, result: review },
    { name: 'comment_pr', description: 'Add one PR timeline comment with gh pr comment NUMBER --body-file -. Verify the PR first with gh pr view; bind the returned comment ID and URL to that PR. Literal UTF-8 body only; no last-comment, editor, or arbitrary file options.',
      inputSchema: input({ prNumber: number, body: { type: 'string', minLength: 1, maxLength: config.maxBodyBytes } }, ['prNumber', 'body']), annotations: CREATE, result: singleComment },
    { name: 'list_pr_comments', description: 'List bounded PR timeline comments and numeric comment IDs using gh pr view NUMBER --json comments and fixed identity fields. Not inline review comments. A possibly capped list is reported; missing IDs never authorize an edit.',
      inputSchema: input({ prNumber: number }, ['prNumber']), annotations: READ, result: commentList },
    { name: 'edit_pr_comment', description: 'Replace exactly one PR timeline comment by prNumber + commentId. First require that ID in gh pr view comments for the verified PR, then run a fixed gh api PATCH to the shared timeline-comment endpoint. Never use an Issue number to edit, never probe Issue type with API, never select a last comment.',
      inputSchema: input({ prNumber: number, commentId, body: { type: 'string', minLength: 1, maxLength: config.maxBodyBytes } }, ['prNumber', 'commentId', 'body']), annotations: EDIT, result: singleComment }
  ].map(({ result, ...tool }) => ({ ...tool, outputSchema: output(result) }));
}
function plan(name, args, config, tools) {
  const tool = tools.find((value) => value.name === name);
  if (!tool) throw fail('Unknown tool');
  if (Object.keys(args).some((key) => !Object.hasOwn(tool.inputSchema.properties, key))) throw fail('Unsupported tool argument');
  const selected = repository(args.repository ?? (config.repositories.length === 1 ? config.repositories[0] : undefined));
  const repo = config.repositories.find((value) => value.toLowerCase() === selected.toLowerCase());
  if (!repo) throw fail('repository is outside the startup --repository allowlist', 'REPOSITORY_REJECTED');
  if (name !== 'create_pr' && (!Number.isSafeInteger(args.prNumber) || args.prNumber < 1 || args.prNumber > 2147483647)) throw fail('prNumber must be a positive integer at most 2147483647');
  let body;
  if (['create_pr', 'edit_pr_body', 'comment_pr', 'edit_pr_comment'].includes(name)) {
    body = validText(args.body, 'body', config.maxBodyBytes, name === 'create_pr' || name === 'edit_pr_body');
    if (Buffer.byteLength(body, 'utf8') > config.maxBodyBytes) throw fail(`body exceeds ${config.maxBodyBytes} UTF-8 bytes`, 'BODY_TOO_LARGE');
  }
  if (name === 'edit_pr_comment' && (!Number.isSafeInteger(args.commentId) || args.commentId < 1)) throw fail('commentId must be a positive safe integer');
  const target = `github.com/${repo}`;
  if (name === 'create_pr') {
    const title = validText(args.title, 'title', 256);
    if (/[\r\n\x01-\x1f\x7f]/.test(title)) throw fail('title must be a single line without control characters');
    if (args.draft !== undefined && typeof args.draft !== 'boolean') throw fail('draft must be boolean');
    const command = ['pr', 'create', '--repo', target, '--base', branch(args.base, 'base'), '--head', head(args.head), `--title=${title}`, '--body-file', '-'];
    if (args.draft === true) command.push('--draft');
    return { repo, number: null, command, body, write: true, draft: args.draft ?? false, base: args.base, head: args.head, title };
  }
  if (name === 'edit_pr_comment') return { repo, number: args.prNumber, commentId: args.commentId, body, write: true };
  const view = ['view_pr', 'check_review_status', 'list_pr_comments'].includes(name);
  const prefix = ['pr', name === 'edit_pr_body' ? 'edit' : name === 'comment_pr' ? 'comment' : view ? 'view' : 'ready', '--repo', target];
  if (name === 'edit_pr_body') prefix.push('--body-file', '-');
  if (name === 'comment_pr') prefix.push('--body-file', '-');
  if (name === 'convert_to_draft') prefix.push('--undo');
  if (view) prefix.push('--json', name === 'check_review_status' ? REVIEW_FIELDS : name === 'list_pr_comments' ? COMMENT_FIELDS : VIEW_FIELDS);
  prefix.push('--', String(args.prNumber));
  return { repo, number: args.prNumber, command: prefix, body, write: !tool.annotations.readOnlyHint };
}
function redact(value, token) {
  if (typeof value === 'string') return token ? value.split(token).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, token));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key, token), redact(entry, token)]));
  return value;
}
function jsonOutput(value) {
  if (typeof value?.stdout !== 'string' || Buffer.byteLength(value.stdout, 'utf8') > MAX_PROCESS_OUTPUT) throw fail('gh returned invalid or oversized output', 'OUTPUT_LIMIT');
  try { return JSON.parse(value.stdout); } catch { throw fail('gh returned invalid JSON', 'GH_OUTPUT_REJECTED'); }
}
function prIdentity(value, repo, number) {
  if (!plain(value) || !Number.isSafeInteger(value.number) || value.number < 1 || value.number > 2147483647
      || (number !== null && value.number !== number)
      || typeof value.url !== 'string' || value.url.toLowerCase() !== `https://github.com/${repo}/pull/${value.number}`.toLowerCase()) {
    throw fail('gh returned a PR outside the selected repository or number', 'GH_OUTPUT_REJECTED');
  }
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(value.state) || typeof value.isDraft !== 'boolean'
      || typeof value.headRefOid !== 'string' || !/^[0-9a-f]{40,64}$/i.test(value.headRefOid)) throw fail('gh returned invalid PR state', 'GH_OUTPUT_REJECTED');
}
function summary(value, repo, number, config) {
  prIdentity(value, repo, number);
  const title = validText(value.title, 'returned title', 1024, true);
  const body = validText(value.body ?? '', 'returned body', MAX_PROCESS_OUTPUT, true);
  if (typeof value.baseRefName !== 'string' || typeof value.headRefName !== 'string'
      || value.baseRefName.length > 1024 || value.headRefName.length > 1024) throw fail('gh returned invalid branch names', 'GH_OUTPUT_REJECTED');
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  return { repository: repo, number: value.number, url: value.url, title, state: value.state, isDraft: value.isDraft,
    base: value.baseRefName, head: value.headRefName, headOwner: typeof value.headRepositoryOwner?.login === 'string' ? validText(value.headRepositoryOwner.login, 'returned head owner', 100) : null, headSha: value.headRefOid,
    body: bodyBytes > config.maxBodyBytes ? null : body, bodyBytes, bodyOmitted: bodyBytes > config.maxBodyBytes };
}
function commentFromView(value, repo, number, config) {
  const prefix = `https://github.com/${repo}/pull/${number}#issuecomment-`;
  if (!plain(value) || typeof value.url !== 'string' || !value.url.toLowerCase().startsWith(prefix.toLowerCase())) throw fail('Comment does not belong to the selected PR timeline', 'COMMENT_REJECTED');
  const id = value.url.slice(prefix.length);
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw fail('Invalid PR timeline comment ID', 'COMMENT_REJECTED');
  const body = validText(value.body ?? '', 'returned comment body', MAX_PROCESS_OUTPUT, true);
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  return { prNumber: number, commentId: Number(id), url: value.url, author: typeof value.author?.login === 'string' ? validText(value.author.login, 'returned comment author', 100) : null,
    body: bodyBytes > config.maxBodyBytes ? null : body, bodyBytes, bodyOmitted: bodyBytes > config.maxBodyBytes };
}
function commentsFromView(value, action, config) {
  prIdentity(value, action.repo, action.number);
  if (!Array.isArray(value.comments) || value.comments.length > 1000) throw fail('gh returned an invalid or oversized comment list', 'GH_OUTPUT_REJECTED');
  const comments = value.comments.map((comment) => commentFromView(comment, action.repo, action.number, config));
  if (new Set(comments.map((comment) => comment.commentId)).size !== comments.length) throw fail('gh returned duplicate comment identities', 'COMMENT_REJECTED');
  return { repository: action.repo, prNumber: action.number, comments, returnedCount: comments.length, mayBeTruncated: comments.length >= 100 };
}

export function createRuntime(config, { env = process.env, isolation = createBundledIsolation(), spawnProcess = spawn, timeoutMs = TIMEOUT_MS, maxOutputBytes = MAX_PROCESS_OUTPUT } = {}) {
  const policySettings = settings(env);
  const policy = (base) => new ToolPathPolicy({ serverName: 'gh-pr', cwd: base, ...policySettings });
  const checkAbort = (signal) => { if (signal?.aborted) throw fail('Operation cancelled or timed out', 'CANCELLED'); };
  async function assertDenied(path) {
    if (findDisallowedPathGlob(path, policySettings.disallowedPathGlobs)) throw fail('Path is denied by disallowed_path_globs', 'PATH_REJECTED');
    for (const [entries, directories] of [[policySettings.disallowedDirectories, true], [policySettings.disallowedFiles, false]]) {
      for (const entry of entries) {
        let actual = entry;
        if (!policySettings.disallowedPathsCanonical) {
          try { actual = await realpath(entry); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (directories ? within(entry, path) || within(actual, path) : relative(entry, path) === '' || relative(actual, path) === '') {
          throw fail('Path is denied by disallowed_directories or disallowed_files', 'PATH_REJECTED');
        }
      }
    }
  }
  async function checkedPath(path, base, kind, signedRoots) {
    pathSyntax(path, kind);
    const lexical = resolve(base, path);
    if (signedRoots && !signedRoots.some((root) => within(root, lexical))) throw fail('Path is outside signed roots', 'PATH_REJECTED');
    await assertDenied(lexical);
    // The SDK policy applies both allow arrays and all three deny arrays.
    await policy(base).assertToolArguments(kind, { path: lexical }, base);
    const canonical = await realpath(lexical);
    if (signedRoots && !signedRoots.some((root) => within(root, canonical))) throw fail('Real path escapes signed roots', 'PATH_REJECTED');
    await assertDenied(canonical);
    await policy(base).assertToolArguments(kind, { path: canonical }, base);
    return canonical;
  }
  async function context() {
    const current = isolation.current();
    const base = current ? current.base : process.cwd();
    const roots = current ? [...current.roots] : [...policySettings.allowedDirectories];
    if (!roots.length) throw fail('No authorized workspace roots', 'PATH_REJECTED');
    for (const root of roots) {
      pathSyntax(root, 'signed root');
      if (!isAbsolute(root) || !(await stat(await checkedPath(root, base, 'workspace directory'))).isDirectory()) throw fail('Invalid workspace root', 'PATH_REJECTED');
    }
    // Roots themselves must be canonical, so a later symlink substitution fails closed.
    for (const root of roots) if (relative(root, await realpath(root)) !== '') throw fail('Workspace roots must be canonical paths', 'PATH_REJECTED');
    const cwd = await checkedPath(base, base, 'working directory', roots);
    if (!(await stat(cwd)).isDirectory()) throw fail('Working directory is not a directory', 'PATH_REJECTED');
    return { cwd, roots };
  }
  async function trustFile(path, label, ctx) {
    // Fixed administrator-selected read-only trust inputs are not public paths.
    const canonical = await checkedPath(path, ctx.cwd, label);
    for (const root of [...policySettings.allowedDirectories, ...ctx.roots]) {
      if (within(root, canonical) || within(await realpath(root), canonical)) throw fail(`${label} must be outside writable workspace roots`, 'PATH_REJECTED');
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || relative(canonical, resolve(path)) !== '') throw fail(`${label} must be a canonical non-symbolic-link regular file`, 'PATH_REJECTED');
    // An exact allowed_files entry is required even if another allow rule covers it.
    if (!policySettings.allowedFiles.some((file) => relative(file, canonical) === '')) throw fail(`${label} must be listed in allowed_files`, 'PATH_REJECTED');
    if (findDisallowedPathGlob(canonical, policySettings.disallowedPathGlobs)) throw fail(`${label} is denied`, 'PATH_REJECTED');
    return { canonical, info };
  }
  async function credentials(ctx, signal) {
    const { canonical, info } = await trustFile(config.tokenFile, '--token-file', ctx);
    if (info.size < 1 || info.size > 8192) throw fail('Token file must contain 1 through 8192 bytes', 'AUTH_FILE_REJECTED');
    checkAbort(signal);
    const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size < 1 || opened.size > 8192 || opened.dev !== info.dev || opened.ino !== info.ino) throw fail('Token file changed or is invalid', 'AUTH_FILE_REJECTED');
      const bytes = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead < 1 || bytesRead > 8192) throw fail('Token file size limit exceeded', 'AUTH_FILE_REJECTED');
      let decoded;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)); }
      catch { throw fail('Token file must be UTF-8; UTF-16 is not supported', 'AUTH_FILE_REJECTED'); }
      const token = decoded.trim();
      if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw fail('Token file contains an invalid token', 'AUTH_FILE_REJECTED');
      checkAbort(signal);
      return token;
    } finally { await handle.close(); }
  }
  async function prepare(signal) {
    checkAbort(signal);
    const ctx = await context();
    const executable = (await trustFile(config.executable, '--gh-executable', ctx)).canonical;
    const token = await credentials(ctx, signal);
    checkAbort(signal);
    return { ...ctx, executable, token };
  }
  async function execute(args, input, signal, prepared, write = false) {
    checkAbort(signal);
    const environment = buildChildEnvironment({}, environmentWithoutBundledIsolationKey(env));
    Object.assign(environment, { GH_TOKEN: prepared.token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: '', PAGER: '', NO_COLOR: '1',
      GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
    return new Promise((resolvePromise, reject) => {
      let child;
      let timer;
      let killTimer;
      let pendingError;
      let settled = false;
      let total = 0;
      const stdout = [], stderr = [];
      const captured = (code = null, childSignal = null) => redact({ exitCode: code, signal: childSignal,
        stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), writeMayHaveSucceeded: write }, prepared.token);
      const finish = (error, code, childSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        const result = captured(code, childSignal);
        if (error) { error.message = redact(error.message, prepared.token); error.details = result; reject(error); }
        else resolvePromise({ ...result, writeMayHaveSucceeded: false });
      };
      const terminate = (error) => {
        if (settled || pendingError) return;
        pendingError = error;
        child?.stdin?.destroy();
        child?.kill();
        killTimer = setTimeout(() => { child?.kill('SIGKILL'); finish(error, null, null); }, 1500);
      };
      const onAbort = () => terminate(fail('Operation cancelled; inspect PR state before retrying a write', 'CANCELLED'));
      try { child = spawnProcess(prepared.executable, args, { cwd: prepared.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment }); }
      catch { finish(fail('Unable to start the configured gh executable', 'GH_EXECUTION_FAILED'), null, null); return; }
      timer = setTimeout(() => terminate(fail('gh timed out; inspect PR state before retrying a write', 'TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      const collect = (chunks) => (chunk) => {
        if (settled || pendingError) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length;
        if (total > maxOutputBytes) terminate(fail('gh output exceeded the size limit; inspect PR state before retrying a write', 'OUTPUT_LIMIT'));
        else chunks.push(bytes);
      };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
      child.once('error', () => finish(fail('Unable to execute the configured gh program', 'GH_EXECUTION_FAILED'), null, null));
      child.once('close', (code, childSignal) => finish(pendingError ?? (code === 0 ? null : fail('gh command failed; see bounded stderr/stdout', 'GH_EXECUTION_FAILED')), code, childSignal));
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') terminate(fail('gh stdin failed', 'GH_EXECUTION_FAILED')); });
      child.stdin.end(input, 'utf8');
    });
  }
  return { prepare, execute, isolation };
}

async function callTool(name, action, config, runtime, prepared, signal) {
  const run = (args, input, write = false) => runtime.execute(args, input, signal, prepared, write);
  const read = async (number, fields = VIEW_FIELDS) => jsonOutput(await run(['pr', 'view', '--repo', `github.com/${action.repo}`, '--json', fields, '--', String(number)]));
  if (['list_pr_comments', 'comment_pr', 'edit_pr_comment'].includes(name)) {
    const listing = commentsFromView(await read(action.number, COMMENT_FIELDS), action, config);
    if (name === 'list_pr_comments') return listing;
    let commentId = action.commentId;
    if (name === 'edit_pr_comment') {
      if (!listing.comments.some((comment) => comment.commentId === commentId)) throw fail('commentId is absent from this PR; no edit was attempted', 'COMMENT_REJECTED');
      // GitHub PR timeline comments share this REST endpoint with Issue comments.
      // The ID is already bound to a PR by gh pr view, never by an Issue-type probe.
      const result = jsonOutput(await run(['api', '--hostname', 'github.com', '--method', 'PATCH', '--input', '-', '--',
        `repos/${action.repo}/issues/comments/${commentId}`], JSON.stringify({ body: action.body }), true));
      if (result?.id !== commentId || result?.body !== action.body) throw fail('Comment edit response did not match the exact ID/body; inspect PR before retrying', 'UNCERTAIN_WRITE');
    } else {
      const result = await run(action.command, action.body, true);
      const prefix = `https://github.com/${action.repo}/pull/${action.number}#issuecomment-`;
      const url = result.stdout.trim();
      if (!url.toLowerCase().startsWith(prefix.toLowerCase()) || !/^[1-9][0-9]{0,15}$/.test(url.slice(prefix.length))
          || !Number.isSafeInteger(Number(url.slice(prefix.length)))) throw fail('Comment creation returned an unexpected URL; inspect PR before retrying', 'UNCERTAIN_WRITE');
      commentId = Number(url.slice(prefix.length));
    }
    const verified = commentsFromView(await read(action.number, COMMENT_FIELDS), action, config).comments.find((comment) => comment.commentId === commentId);
    if (!verified || verified.body !== action.body) throw fail('Comment write was not visible in the bounded PR comment list; inspect PR before retrying', 'UNCERTAIN_WRITE');
    return { repository: action.repo, comment: verified };
  }
  if (name === 'view_pr') return summary(await read(action.number), action.repo, action.number, config);
  if (name === 'check_review_status') {
    const value = await read(action.number, REVIEW_FIELDS);
    prIdentity(value, action.repo, action.number);
    const decision = value.reviewDecision === '' ? null : value.reviewDecision;
    if (![null, 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(decision) || !Array.isArray(value.reviewRequests)) throw fail('gh returned invalid review status', 'GH_OUTPUT_REJECTED');
    const reviewComplete = value.isDraft || value.state !== 'OPEN' ? false : decision === null || value.reviewRequests.length >= 100 ? null : decision === 'APPROVED' && value.reviewRequests.length === 0;
    return { repository: action.repo, number: value.number, url: value.url, state: value.state, isDraft: value.isDraft,
      headSha: value.headRefOid, reviewDecision: decision, pendingReviewRequests: value.reviewRequests.length, reviewComplete,
      checkedAt: new Date().toISOString(), scope: 'github-review-decision' };
  }
  if (name === 'create_pr') {
    const repo = jsonOutput(await run(['repo', 'view', '--json', 'nameWithOwner,url', '--', `github.com/${action.repo}`]));
    if (repo?.nameWithOwner?.toLowerCase() !== action.repo.toLowerCase() || repo?.url?.toLowerCase() !== `https://github.com/${action.repo}`.toLowerCase()) throw fail('Repository rename/redirect is outside the configured identity', 'REPOSITORY_REJECTED');
    const result = await run(action.command, action.body, true);
    const url = result.stdout.trim();
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]{0,9})$/.exec(url);
    if (!match || match[1].toLowerCase() !== action.repo.toLowerCase()) throw fail('PR create returned an unexpected URL; inspect GitHub before retrying', 'UNCERTAIN_WRITE');
    action.number = Number(match[2]);
    const value = summary(await read(action.number), action.repo, action.number, config);
    if (value.body !== action.body || value.title !== action.title || value.base !== action.base || value.head !== action.head.split(':').at(-1)
        || (action.head.includes(':') && value.headOwner?.toLowerCase() !== action.head.split(':')[0].toLowerCase())
        || value.isDraft !== action.draft) throw fail('Created PR verification did not match the requested fields; inspect GitHub before retrying', 'UNCERTAIN_WRITE');
    return value;
  }
  const original = summary(await read(action.number), action.repo, action.number, config);
  if (name !== 'edit_pr_body' && original.state !== 'OPEN') throw fail('Only an open PR may change draft state');
  await run(action.command, action.body, true);
  const value = summary(await read(action.number), action.repo, action.number, config);
  if (name === 'edit_pr_body' ? value.body !== action.body : value.isDraft !== (name === 'convert_to_draft')) throw fail('PR write verification failed; inspect GitHub before retrying', 'UNCERTAIN_WRITE');
  return value;
}

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: !value.ok });
export function createServer(options = {}) {
  const config = parseStartupArguments(options.argv ?? process.argv.slice(2));
  if (config.help) throw fail('Use --help from the command line');
  const env = options.env ?? process.env;
  settings(env);
  const isolation = createBundledIsolation({ key: env.LOCAL_MCP_GATEWAY_ISOLATION_KEY });
  const runtime = options.runtime ?? createRuntime(config, { env, isolation });
  const tools = schemas(config);
  const pending = new Map();
  let initialized = false;
  let serial = Promise.resolve();
  const handle = async (request) => {
    if (!plain(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
        || (request.id !== undefined && typeof request.id !== 'string' && !Number.isSafeInteger(request.id))) return protocolError(request?.id, -32600, 'Invalid Request');
    if (request.method === 'notifications/cancelled' && request.id === undefined) {
      pending.get(JSON.stringify(request.params?.requestId))?.abort(); return null;
    }
    if (request.id === undefined) return null;
    if (request.method === 'initialize') {
      initialized = true;
      return response(request.id, { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'gh-pr', version: '1.0.0' }, instructions: 'Fixed gh pr commands only. Repository startup allowlist is mandatory. Token is file-only. Do not retry an uncertain create automatically. ready-for-review is distinct from approved review status.' });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools });
    if (request.method !== 'tools/call') return protocolError(request.id, -32601, 'Method not found');
    if (pending.size >= 8) return protocolError(request.id, -32000, 'Too many pending calls');
    const key = JSON.stringify(request.id);
    if (pending.has(key)) return protocolError(request.id, -32600, 'Duplicate active request id');
    const controller = new AbortController();
    pending.set(key, controller);
    const job = serial.then(async () => {
      let token;
      let wrote = false;
      let timeout;
      try {
        const result = await isolation.run(request.params?.arguments ?? {}, async (args) => {
          const action = plan(request.params?.name, args, config, tools);
          if (controller.signal.aborted) throw fail('Operation cancelled before execution', 'CANCELLED');
          timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
          const prepared = await runtime.prepare(controller.signal);
          token = prepared.token;
          // A wrapper tracks writes so a failed verification never suggests a safe retry.
          const tracked = { execute: (...values) => { if (values[4] === true) wrote = true; return runtime.execute(...values); } };
          return callTool(request.params?.name, action, config, tracked, prepared, controller.signal);
        });
        return response(request.id, toolResult(redact({ ok: true, result }, token)));
      } catch (error) {
        const value = { ok: false, error: error instanceof Error ? error.message : 'Operation failed', code: typeof error?.code === 'string' ? error.code : 'ISOLATION_OR_PATH_REJECTED' };
        if (error?.details) value.execution = error.details;
        else if (wrote) value.execution = { exitCode: null, signal: null, stdout: '', stderr: '', writeMayHaveSucceeded: true };
        if (wrote && value.execution) value.execution.writeMayHaveSucceeded = true;
        return response(request.id, toolResult(redact(value, token)));
      } finally { clearTimeout(timeout); pending.delete(key); }
    });
    serial = job.then(() => undefined, () => undefined);
    return job;
  };
  handle.cancelAll = () => { for (const controller of pending.values()) controller.abort(); };
  handle.settled = () => serial;
  handle.maxInputBytes = 6 * config.maxBodyBytes + 65536;
  return handle;
}

export function startStdio(input = process.stdin, output = process.stdout, options = {}) {
  const handle = createServer(options);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let discarding = false;
  const writes = new Set();
  const write = (value) => {
    if (!value) return;
    const serialized = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > 2 * MAX_PROCESS_OUTPUT + 65536) {
      output.write(`${JSON.stringify(protocolError(value.id, -32603, 'Response size limit'))}\n`);
      return;
    }
    if (!output.write(serialized)) input.pause();
  };
  output.on('drain', () => input.resume());
  input.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (discarding) { discarding = false; continue; }
      if (!line.trim()) continue;
      let request;
      try {
        if (Buffer.byteLength(line, 'utf8') > handle.maxInputBytes) throw fail('Input limit');
        request = JSON.parse(line);
      } catch { write(protocolError(null, -32700, 'Invalid or oversized JSON input')); continue; }
      const work = handle(request).then(write).catch(() => write(protocolError(request?.id, -32603, 'Internal error')));
      writes.add(work); void work.finally(() => writes.delete(work));
    }
    if (Buffer.byteLength(buffer, 'utf8') > handle.maxInputBytes) {
      buffer = '';
      if (!discarding) write(protocolError(null, -32700, 'Input size limit'));
      discarding = true;
    }
  });
  input.on('end', () => { buffer = ''; handle.cancelAll(); });
  input.on('error', () => handle.cancelAll());
  output.on('error', () => handle.cancelAll());
  return { settled: async () => { await handle.settled(); await Promise.all([...writes]); }, close: handle.cancelAll };
}
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (directExecution) {
  try {
    const config = parseStartupArguments(process.argv.slice(2));
    if (config.help) process.stderr.write(GH_PR_MCP_HELP);
    else {
      const server = startStdio();
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); process.stdin.destroy(); });
    }
  } catch (error) { process.stderr.write(`gh-pr: ${error.message}\n`); process.exitCode = 1; }
}
