import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBundledIsolation, environmentWithoutBundledIsolationKey } from '../../app/bundled-isolation.mjs';
import { scrubSecretEnvironment } from '../../app/child-environment.mjs';

const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const GH_TIMEOUT_MS = 30_000;
const ISSUE_FIELDS = 'number,title,body,state,url,author,labels,assignees,createdAt,updatedAt,closedAt';
const LIST_FIELDS = 'number,title,state,url,author,labels,createdAt,updatedAt';

export const GH_ISSUE_MCP_HELP = `gh-issue
Usage:
  node mcp/gh-issue/server.mjs --token-file=/absolute/path/to/token.txt --gh-executable=/absolute/path/to/gh [--repository=OWNER/REPO ...]
Only create_issue, view_issue, list_issues, comment_issue, close_issue, and edit_issue are exposed.
Targets must be public repositories on github.com. Without --repository, any public
repository can be selected. Repeated --repository arguments form an optional allowlist.
Use --token-file for authentication; legacy --token=TOKEN is also supported.
If both are supplied, --token-file takes precedence. The selected token is passed
to gh only as GH_TOKEN. The UTF-8 token file is a read-only trust input.
The MCP itself must run in the Gateway onlineworkspace sandbox.
The fixed gh executable must be outside writable workspace roots.
`;

function repository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)
      || value.includes('..') || value.endsWith('.git')) throw new Error('repository must be OWNER/REPO on github.com');
  return value;
}

export function parseStartupArguments(argv) {
  const values = {};
  const repositories = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') { help = true; continue; }
    const match = /^--(token-file|token|repository|gh-executable)(?:=(.*))?$/s.exec(argument);
    // Do not echo an unknown argument: it may itself contain a credential.
    if (!match) throw new Error('Unsupported startup argument; use --help');
    const name = match[1];
    const value = match[2] ?? argv[++index];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    if (name === 'repository') repositories.push(repository(value));
    else {
      if (Object.hasOwn(values, name)) throw new Error(`--${name} may be specified only once`);
      values[name] = value;
    }
  }
  if (help) return { help: true };
  const tokenFile = values['token-file'];
  const token = values.token;
  if (tokenFile !== undefined && (!isAbsolute(tokenFile) || /[\0\r\n]/.test(tokenFile))) {
    throw new Error('--token-file must be an absolute path');
  }
  if (token !== undefined && (token.length > 4096 || !/^[\x21-\x7e]+$/.test(token))) throw new Error('--token contains an invalid token');
  if (tokenFile === undefined && token === undefined) throw new Error('--token-file or --token is required');
  const executable = values['gh-executable'];
  if (typeof executable !== 'string' || !isAbsolute(executable) || /[\0\r\n]/.test(executable)
      || !/^gh(?:\.exe)?$/i.test(basename(executable)) || (process.platform === 'win32' && !/\.exe$/i.test(executable))) {
    throw new Error('--gh-executable is required and must be an absolute path to gh (gh.exe on Windows)');
  }
  return { help: false, tokenFile, ...(token === undefined ? {} : { token }), executable, repositories: [...new Map(repositories.map((name) => [name.toLowerCase(), name])).values()] };
}

function redact(value, token) {
  return String(value).split(token).join('[REDACTED]');
}

function redactResult(value, token) {
  if (typeof value === 'string') return redact(value, token);
  if (Array.isArray(value)) return value.map((entry) => redactResult(entry, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key, token), redactResult(entry, token)]));
  return value;
}

function commandFailure(result, fallback) {
  const error = new Error(result.stderr || result.stdout || fallback);
  error.result = result;
  return error;
}

function requireGhSuccess(result) {
  if (result?.exitCode !== 0) {
    throw commandFailure(result ?? {}, `gh exited with code ${result?.exitCode ?? 'unknown'}${result?.signal ? ` (${result.signal})` : ''}`);
  }
  return result;
}

function assertOnlineSandbox() {
  if (process.env.LOCAL_MCP_CODEX_SANDBOX_MODE !== 'onlineworkspace') throw new Error('gh-issue requires the onlineworkspace MCP sandbox');
}

function within(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

async function assertOutsideWritableRoots(actualPath, isolation, optionName) {
  const configuredRoots = process.env.LOCAL_MCP_ALLOWED_DIRECTORIES === undefined ? [process.cwd()] : JSON.parse(process.env.LOCAL_MCP_ALLOWED_DIRECTORIES);
  if (!Array.isArray(configuredRoots) || configuredRoots.some((root) => typeof root !== 'string' || !isAbsolute(root))) throw new Error('Invalid configured workspace roots');
  const roots = [...configuredRoots, ...(isolation.current()?.roots ?? [])];
  for (const root of roots) {
    if (within(await realpath(root), actualPath)) throw new Error(`${optionName} must be outside writable workspace roots`);
  }
}

async function trustedGhExecutable(config, isolation) {
  const info = await lstat(config.executable);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('--gh-executable must be a non-symbolic-link regular file');
  const executable = await realpath(config.executable);
  await assertOutsideWritableRoots(executable, isolation, '--gh-executable');
  return executable;
}

export function createTokenReader(config, isolation = createBundledIsolation()) {
  if (config.tokenFile === undefined) return async () => config.token;
  let tokenPromise;
  return () => {
    tokenPromise ??= (async () => {
      const info = await lstat(config.tokenFile);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('--token-file must be a non-symbolic-link regular file');
      if (info.size < 1 || info.size > 8192) throw new Error('--token-file must contain from 1 through 8192 bytes');
      const actual = await realpath(config.tokenFile);
      await assertOutsideWritableRoots(actual, isolation, '--token-file');
      const bytes = await readFile(actual);
      if (bytes.length < 1 || bytes.length > 8192) throw new Error('--token-file must contain from 1 through 8192 bytes');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('--token-file must be UTF-8; UTF-16 and invalid UTF-8 are not supported'); }
      const token = text.trim();
      if (token.length === 0 || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new Error('--token-file contains an invalid token');
      return token;
    })();
    return tokenPromise;
  };
}

export function createGhExecutor(config, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn;
  const isolation = options.isolation ?? createBundledIsolation();
  const getToken = options.getToken ?? createTokenReader(config, isolation);
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return async (args, input) => {
    assertOnlineSandbox();
    const cwd = await realpath(isolation.current()?.base ?? process.cwd());
    const executable = await trustedGhExecutable(config, isolation);
    const token = await getToken();
    const env = scrubSecretEnvironment(environmentWithoutBundledIsolationKey());
    // Ignore gh host/repository/debug/socket overrides and inherited credentials.
    for (const name of Object.keys(env)) if (/^(GH_|GITHUB_)/i.test(name)) delete env[name];
    Object.assign(env, {
      GH_TOKEN: token, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1',
      GH_PAGER: '', PAGER: '', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1'
    });
    return new Promise((resolvePromise, reject) => {
      let child;
      let timer;
      let settled = false;
      const stdout = [];
      const stderr = [];
      let total = 0;
      const capturedResult = (exitCode = null, signal = null, extra = {}) => ({
        command: ['gh', ...args], stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal, ...extra
      });
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          const sanitized = new Error(redact(error.message, token));
          sanitized.result = redactResult(error.result ?? capturedResult(), token);
          reject(sanitized);
        }
        else resolvePromise(result);
      };
      try {
        child = spawnProcess(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
      } catch (error) { finish(new Error(`Unable to start gh: ${error.message}`)); return; }
      timer = setTimeout(() => {
        child.kill();
        const error = new Error('gh timed out; a write may already have reached GitHub. Inspect the Issue before retrying.');
        error.result = capturedResult(null, null, { timedOut: true });
        finish(error);
      }, timeoutMs);
      const collect = (target) => (chunk) => {
        if (settled) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += data.length;
        if (total > maxOutputBytes) {
          child.kill();
          finish(new Error('gh output exceeded the size limit; inspect the Issue before retrying a write.'));
        } else target.push(data);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', (error) => finish(new Error(`Unable to start gh: ${error.message}`)));
      child.once('close', (code, signal) => {
        const result = capturedResult(code, signal);
        if (code !== 0) finish(commandFailure(result, `gh exited with code ${code}${signal ? ` (${signal})` : ''}`));
        else finish(null, redactResult(result, token));
      });
      // EPIPE can occur when gh exits before consuming the body; close/error owns the result.
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') { child.kill(); finish(error); }
      });
      child.stdin.end(input === undefined ? undefined : input, 'utf8');
    });
  };
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const bodySchema = { type: 'string', maxLength: 65536, description: 'Literal UTF-8 text; multiline content is preserved.' };
const issueSchema = { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Issue number in the selected repository. URLs and pull requests are not accepted.' };
const outputSchema = {
  type: 'object', properties: { ok: { type: 'boolean' }, result: { type: 'object' }, error: { type: 'string' } },
  required: ['ok'], additionalProperties: false
};

function toolSchemas(config) {
  const repositorySchema = { type: 'string', description: 'Public github.com repository in OWNER/REPO format.' };
  if (config.repositories.length) repositorySchema.enum = config.repositories;
  if (config.repositories.length === 1) repositorySchema.default = config.repositories[0];
  const input = (properties, required = []) => ({
    type: 'object', properties: { repository: repositorySchema, ...properties },
    required: [...(config.repositories.length === 1 ? [] : ['repository']), ...required], additionalProperties: false
  });
  return [
    { name: 'create_issue', description: 'Create an Issue in a public repository using gh issue create.',
      inputSchema: input({ title: { type: 'string', minLength: 1, maxLength: 256 }, body: bodySchema }, ['title', 'body']), annotations: write },
    { name: 'view_issue', description: 'Read one public Issue, optionally including comments, using gh issue view.',
      inputSchema: input({ issueNumber: issueSchema, comments: { type: 'boolean', default: false } }, ['issueNumber']), annotations: readOnly },
    { name: 'list_issues', description: 'List Issues in one public repository using gh issue list.',
      inputSchema: input({ state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }), annotations: readOnly },
    { name: 'comment_issue', description: 'Post a new comment to a public Issue using gh issue comment.',
      inputSchema: input({ issueNumber: issueSchema, body: { ...bodySchema, minLength: 1 } }, ['issueNumber', 'body']), annotations: write },
    { name: 'close_issue', description: 'Close a public Issue using gh issue close.',
      inputSchema: input({ issueNumber: issueSchema, reason: { type: 'string', enum: ['completed', 'not planned'], default: 'completed' } }, ['issueNumber']),
      annotations: { ...write, destructiveHint: true, idempotentHint: true } },
    { name: 'edit_issue', description: 'Replace the body and/or title of an existing public Issue using gh issue edit. On failure, the original gh error and process output are returned.',
      inputSchema: input({ issueNumber: issueSchema, body: bodySchema,
        title: { type: 'string', minLength: 1, maxLength: 256 } }, ['issueNumber']),
      annotations: { ...write, destructiveHint: true, idempotentHint: true } }
  ].map((tool) => ({ ...tool, outputSchema }));
}

function textArgument(value, name, maxLength, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.trim().length === 0)
      || /\0/.test(value) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) {
    throw new Error(`${name} must be valid text of at most ${maxLength} characters${allowEmpty ? '' : ', with non-whitespace content'}`);
  }
  return value;
}

function selectedRepository(value, config) {
  const selected = repository(value ?? (config.repositories.length === 1 ? config.repositories[0] : undefined));
  if (config.repositories.length && !config.repositories.some((name) => name.toLowerCase() === selected.toLowerCase())) {
    throw new Error('repository is outside the configured allowlist');
  }
  return selected;
}

function planForTool(name, args, config, schemas) {
  const schema = schemas.find((tool) => tool.name === name);
  if (!schema) throw new Error('Unknown tool');
  if (Object.keys(args).some((key) => !Object.hasOwn(schema.inputSchema.properties, key))) throw new Error('Unsupported tool argument');
  const repo = selectedRepository(args.repository, config);
  const number = args.issueNumber;
  if (schema.inputSchema.properties.issueNumber && (!Number.isSafeInteger(number) || number < 1 || number > 2147483647)) {
    throw new Error('issueNumber must be a positive integer at most 2147483647');
  }
  const base = ['issue', name.split('_')[0], ...(number === undefined ? [] : [String(number)]), '--repo', `github.com/${repo}`];
  switch (name) {
    case 'create_issue': {
      const title = textArgument(args.title, 'title', 256);
      if (/[\r\n]/.test(title)) throw new Error('title must be a single line');
      return { repo, command: [...base, `--title=${title}`, '--body-file', '-'], input: textArgument(args.body, 'body', 65536, true) };
    }
    case 'view_issue':
      if (args.comments !== undefined && typeof args.comments !== 'boolean') throw new Error('comments must be a boolean');
      return { repo, number, command: [...base, '--json', `${ISSUE_FIELDS}${args.comments ? ',comments' : ''}`] };
    case 'list_issues': {
      const state = args.state ?? 'open';
      const limit = args.limit ?? 30;
      if (!['open', 'closed', 'all'].includes(state)) throw new Error('state must be open, closed, or all');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100');
      return { repo, command: [...base, '--state', state, '--limit', String(limit), '--json', LIST_FIELDS] };
    }
    case 'comment_issue':
      return { repo, number, command: [...base, '--body-file', '-'], input: textArgument(args.body, 'body', 65536) };
    case 'close_issue': {
      const reason = args.reason ?? 'completed';
      if (!['completed', 'not planned'].includes(reason)) throw new Error('reason must be completed or not planned');
      return { repo, number, command: [...base, '--reason', reason] };
    }
    case 'edit_issue': {
      const hasBody = Object.hasOwn(args, 'body');
      const hasTitle = Object.hasOwn(args, 'title');
      if (!hasBody && !hasTitle) throw new Error('edit_issue requires body and/or title');
      const command = [...base];
      if (hasTitle) {
        const title = textArgument(args.title, 'title', 256);
        if (/[\r\n]/.test(title)) throw new Error('title must be a single line');
        command.push(`--title=${title}`);
      }
      if (hasBody) command.push('--body-file', '-');
      return { repo, number, command, ...(hasBody ? { input: textArgument(args.body, 'body', 65536, true) } : {}) };
    }
    default: throw new Error('Unknown tool');
  }
}

function jsonOutput(result) {
  requireGhSuccess(result);
  try { return JSON.parse(result.stdout); } catch (cause) {
    const error = new Error(`gh returned invalid JSON: ${cause.message}`);
    error.result = result;
    throw error;
  }
}

function assertIssue(value, repo, number) {
  const expected = `https://github.com/${repo}/issues/${number}`;
  if (!value || value.number !== number || typeof value.url !== 'string' || value.url.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Target is not an Issue in the selected repository');
  }
}

async function callTool(plan, name, execute) {
  // Check each time, including reads. Never cache visibility across tool calls.
  const info = jsonOutput(await execute(['repo', 'view', `github.com/${plan.repo}`, '--json', 'nameWithOwner,visibility,url']));
  if (info?.visibility !== 'PUBLIC') throw new Error('Only public repositories are allowed');
  if (typeof info.nameWithOwner !== 'string' || info.nameWithOwner.toLowerCase() !== plan.repo.toLowerCase()
      || typeof info.url !== 'string' || info.url.toLowerCase() !== `https://github.com/${plan.repo}`.toLowerCase()) {
    throw new Error('Repository identity changed or is not on github.com');
  }
  if (name === 'comment_issue' || name === 'close_issue' || name === 'edit_issue') {
    assertIssue(jsonOutput(await execute(['issue', 'view', String(plan.number), '--repo', `github.com/${plan.repo}`, '--json', 'number,url'])), plan.repo, plan.number);
  }
  const result = await execute(plan.command, plan.input);
  requireGhSuccess(result);
  if (name === 'view_issue') {
    const issue = jsonOutput(result);
    assertIssue(issue, plan.repo, plan.number);
    return { repository: plan.repo, issue };
  }
  if (name === 'list_issues') {
    const issues = jsonOutput(result);
    if (!Array.isArray(issues)) throw new Error('gh returned an invalid Issue list');
    for (const issue of issues) {
      if (!Number.isSafeInteger(issue?.number) || issue.number < 1) throw new Error('gh returned an invalid Issue number');
      assertIssue(issue, plan.repo, issue.number);
    }
    return { repository: plan.repo, issues };
  }
  return { repository: plan.repo, ...result };
}

const response = (id, result) => ({ jsonrpc: '2.0', id, result });
const protocolError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolResult = (value, isError = false) => ({ content: [{ type: 'text', text: isError ? value.error : JSON.stringify(value) }], structuredContent: value, isError });

export function createServer(options = {}) {
  const config = parseStartupArguments(options.argv ?? process.argv.slice(2));
  if (config.help) throw new Error('Use --help from the command line');
  assertOnlineSandbox();
  const isolation = options.isolation ?? createBundledIsolation();
  const getToken = createTokenReader(config, isolation);
  const execute = options.execute ?? createGhExecutor(config, { isolation, getToken });
  const schemas = toolSchemas(config);
  let initialized = false;
  return async (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return protocolError(request?.id, -32600, 'Invalid Request');
    const notification = request.id === undefined;
    if (notification) return null;
    if (request.method === 'initialize') {
      initialized = true;
      return response(request.id, {
        protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'gh-issue', version: '1.1.0' },
        instructions: 'Only six Issue operations on public github.com repositories, including body/title editing. Authentication uses the configured read-only token file or legacy startup token. Failed tools return the concrete error and available stdout/stderr/exitCode; preserve these details instead of replacing them with a generic operation fault. Never retry an uncertain create/comment automatically; inspect the Issue first.'
      });
    }
    if (!initialized) return protocolError(request.id, -32002, 'Server not initialized');
    if (request.method === 'ping') return response(request.id, {});
    if (request.method === 'tools/list') return response(request.id, { tools: schemas });
    if (request.method === 'tools/call') {
      let token;
      try {
        const result = await isolation.run(request.params?.arguments ?? {}, async (args) => {
          const plan = planForTool(request.params?.name, args, config, schemas);
          token = await getToken();
          return callTool(plan, request.params.name, execute);
        });
        const value = redactResult({ ok: true, result }, token);
        return response(request.id, toolResult(value));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failure = { ok: false, error: message, ...(error?.result ? { result: error.result } : {}) };
        return response(request.id, toolResult(token === undefined ? failure : redactResult(failure, token), true));
      }
    }
    return protocolError(request.id, -32601, 'Method not found');
  };
}

export function startStdio(input = process.stdin, output = process.stdout, options = {}) {
  const handle = createServer(options);
  let buffer = '';
  let discarding = false;
  let pending = Promise.resolve();
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (discarding) { discarding = false; continue; }
      if (!line.trim()) continue;
      let request;
      try {
        if (Buffer.byteLength(line, 'utf8') > MAX_INPUT_BYTES) throw new Error('Input size limit');
        request = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(protocolError(null, -32700, 'Invalid or oversized JSON input'))}\n`);
        continue;
      }
      // Ordered requests avoid initialization races and concurrent writes.
      pending = pending.then(() => handle(request)).then((reply) => {
        if (reply) output.write(`${JSON.stringify(reply)}\n`);
      }).catch(() => output.write(`${JSON.stringify(protocolError(request?.id, -32603, 'Internal error'))}\n`));
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_INPUT_BYTES) {
      buffer = '';
      if (!discarding) output.write(`${JSON.stringify(protocolError(null, -32700, 'Input size limit'))}\n`);
      discarding = true;
    }
  });
  return { settled: () => pending };
}

if (directExecution) {
  try {
    const config = parseStartupArguments(process.argv.slice(2));
    if (config.help) process.stdout.write(GH_ISSUE_MCP_HELP);
    else startStdio();
  } catch (error) {
    // Startup validators never include supplied argument values.
    process.stderr.write(`gh-issue: ${error.message}\n`);
    process.exitCode = 1;
  }
}
