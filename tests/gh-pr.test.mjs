import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createRuntime, createServer, parseBodyLimit, parseStartupArguments, startStdio } from '../mcp/gh-pr/server.mjs';
import { createBundledIsolation, signBundledIsolationContext } from '../app/bundled-isolation.mjs';
import { loadGatewayConfig } from '../app/server-config.mjs';
import { codexAppServerInternals } from '../app/codex-app-server.mjs';
import { parseToml } from '../app/toml-lite.mjs';

const REPO = 'Target/repo';
const TOKEN = 'ghp_file_only_private_token';
const KEY = 'fedcba9876543210'.repeat(4);
const root = await mkdtemp(join(tmpdir(), 'gh-pr-work-'));
const secondRoot = await mkdtemp(join(tmpdir(), 'gh-pr-other-'));
const trusted = await mkdtemp(join(tmpdir(), 'gh-pr-trust-'));
const tokenFile = join(trusted, 'token.txt');
const gh = join(trusted, process.platform === 'win32' ? 'gh.exe' : 'gh');
await writeFile(tokenFile, TOKEN + '\n', 'utf8');
await writeFile(gh, 'never executed: unit-test fixture\n', 'utf8');
const argv = (more = []) => [`--repository=${REPO}`, `--token-file=${tokenFile}`, `--gh-executable=${gh}`, ...more];
const env = (more = {}) => ({ LOCAL_MCP_CODEX_SANDBOX_MODE: 'onlineworkspace',
  LOCAL_MCP_ALLOWED_DIRECTORIES: JSON.stringify([root, secondRoot]), LOCAL_MCP_ALLOWED_FILES: '[]', ...more });
const rpc = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const pr = (more = {}) => ({ number: 7, url: `https://github.com/${REPO}/pull/7`, title: 'title', body: 'body', state: 'OPEN',
  isDraft: false, headRefOid: 'a'.repeat(40), baseRefName: 'release', headRefName: 'feature', headRepositoryOwner: { login: 'fork-owner' }, ...more });
const json = (value) => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0, signal: null, writeMayHaveSucceeded: false });
const createArgs = (more = {}) => ({ repository: REPO, title: 'title', body: 'body', base: 'release', head: 'fork-owner:feature', ...more });
function envelope(context = { roots: [root], base: root }) {
  return { version: 1, ...context, signature: signBundledIsolationContext(KEY, context) };
}
async function fixture({ extra = [], environment = env(), execute, prepare } = {}) {
  const calls = [];
  const prepares = [];
  let value = pr();
  const runtime = {
    prepare: async (signal) => { prepares.push(signal); return prepare ? prepare(signal) : { token: TOKEN }; },
    execute: async (args, input, signal, prepared, write) => {
      calls.push({ args, input, write });
      if (execute) return execute(args, input, signal, prepared, write);
      if (args[0] === 'repo') return json({ nameWithOwner: REPO, url: `https://github.com/${REPO}` });
      if (args[1] === 'create') { value.body = input; value.isDraft = args.includes('--draft'); return { ...json({}), stdout: value.url + '\n' }; }
      if (args[1] === 'edit') value.body = input;
      if (args[1] === 'ready') value.isDraft = args.includes('--undo');
      return json(value);
    }
  };
  const server = createServer({ argv: argv(extra), env: environment, runtime });
  await server(rpc(1, 'initialize'));
  const call = async (name, argumentsValue = {}) => (await server(rpc(2, 'tools/call', { name, arguments: argumentsValue }))).result;
  return { server, call, calls, prepares };
}

test('file-only startup, byte units, fixed executable and sanitized errors', () => {
  for (const [input, expected] of [['100B', 100], ['10K', 10240], ['1M', 1048576], ['10KiB', 10240], ['100', 100]]) assert.equal(parseBodyLimit(input), expected);
  for (const input of ['0', '2M', '-1', '1e6', 'NaN', '10K;echo']) assert.throws(() => parseBodyLimit(input));
  assert.equal(parseStartupArguments(argv()).maxBodyBytes, 10240);
  assert.deepEqual(parseStartupArguments(['--help']), { help: true });
  for (const bad of [`--token=${TOKEN}`, `--arbitrary=${TOKEN}`, `--repository=bad;command/repo`]) {
    assert.throws(() => parseStartupArguments(argv([bad])), (error) => !error.message.includes(TOKEN));
  }
  assert.throws(() => parseStartupArguments(argv().filter((arg) => !arg.startsWith('--repository='))));
  assert.throws(() => parseStartupArguments(argv([`--token-file=${tokenFile}`])));
  assert.throws(() => parseStartupArguments(argv().map((arg) => arg.startsWith('--gh-executable=') ? '--gh-executable=gh' : arg)));
  assert.deepEqual(parseStartupArguments(argv(['--repository=target/REPO'])).repositories, ['target/REPO']);
});
test('onlineworkspace is mandatory and present empty/short isolation keys fail closed', () => {
  for (const sandbox of ['never', 'elevated', 'unelevated', undefined]) assert.throws(() => createServer({ argv: argv(), env: env({ LOCAL_MCP_CODEX_SANDBOX_MODE: sandbox }) }), /onlineworkspace/);
  for (const key of ['', 'short']) assert.throws(() => createServer({ argv: argv(), env: env({ LOCAL_MCP_GATEWAY_ISOLATION_KEY: key }) }), /isolation key/);
});
test('allowlist denial precedes prepare, file access, preflight and every gh operation', async () => {
  const f = await fixture({ extra: ['--repository=Second/repo'] });
  for (const [name, args] of [['create_pr', createArgs()], ['edit_pr_body', { prNumber: 7, body: 'new' }],
    ['convert_to_draft', { prNumber: 7 }], ['mark_ready_for_review', { prNumber: 7 }], ['view_pr', { prNumber: 7 }], ['check_review_status', { prNumber: 7 }],
    ['comment_pr', { prNumber: 7, body: 'comment' }], ['list_pr_comments', { prNumber: 7 }], ['edit_pr_comment', { prNumber: 7, commentId: 123, body: 'new' }]]) {
    for (const repository of ['Target/repo-extra', 'Other/repo', 'https://github.com/Target/repo', undefined]) {
      assert.equal((await f.call(name, { ...args, repository })).isError, true);
    }
  }
  assert.equal(f.calls.length, 0); assert.equal(f.prepares.length, 0);
});
const COMMENT_ID = 3653399145;
const comment = (id = COMMENT_ID, body = 'comment body', number = 7) => ({ body, author: { login: 'comment-author' },
  url: `https://github.com/${REPO}/pull/${number}#issuecomment-${id}` });
test('comment add/list/exact ID edit binds to gh pr view before its fixed shared API endpoint', async () => {
  let comments = [comment()];
  const f = await fixture({ execute: async (args, input) => {
    if (args[0] === 'pr' && args[1] === 'view') return json(pr({ comments }));
    if (args[0] === 'pr' && args[1] === 'comment') {
      comments.push(comment(COMMENT_ID + 1, input));
      return { ...json({}), stdout: comments.at(-1).url + '\n' };
    }
    if (args[0] === 'api') {
      assert.ok(args.includes(`repos/${REPO}/issues/comments/${COMMENT_ID}`));
      assert.ok(args.includes('PATCH'));
      const payload = JSON.parse(input);
      assert.deepEqual(Object.keys(payload), ['body']);
      comments[0].body = payload.body;
      return json({ id: COMMENT_ID, body: payload.body });
    }
    throw new Error('Unexpected command');
  } });
  const listed = await f.call('list_pr_comments', { prNumber: 7 });
  assert.equal(listed.structuredContent.result.comments[0].commentId, COMMENT_ID);
  const added = await f.call('comment_pr', { prNumber: 7, body: '追加\n本文' });
  assert.equal(added.isError, false); assert.equal(added.structuredContent.result.comment.commentId, COMMENT_ID + 1);
  const edited = await f.call('edit_pr_comment', { prNumber: 7, commentId: COMMENT_ID, body: '編集\n本文' });
  assert.equal(edited.isError, false); assert.equal(edited.structuredContent.result.comment.body, '編集\n本文');
  assert.deepEqual(f.calls.find((call) => call.args[0] === 'api').args, ['api', '--hostname', 'github.com', '--method', 'PATCH', '--input', '-', '--', `repos/${REPO}/issues/comments/${COMMENT_ID}`]);
  assert.ok(f.calls.some((call) => JSON.stringify(call.args) === JSON.stringify(['pr', 'comment', '--repo', `github.com/${REPO}`, '--body-file', '-', '--', '7'])));
});
test('foreign PR/Issue/review IDs, URLs and missing or capped comments cannot authorize editing', async () => {
  for (const comments of [[comment(COMMENT_ID, 'body', 8)], [{ ...comment(), url: `https://github.com/${REPO}/issues/7#issuecomment-${COMMENT_ID}` }],
    [{ ...comment(), url: `https://github.com/${REPO}/pull/7#discussion_r${COMMENT_ID}` }], [comment(COMMENT_ID + 1)], []]) {
    const f = await fixture({ execute: async () => json(pr({ comments })) });
    const result = await f.call('edit_pr_comment', { prNumber: 7, commentId: COMMENT_ID, body: 'new' });
    assert.equal(result.isError, true); assert.equal(f.calls.some((call) => call.args[0] === 'api'), false);
  }
  const f = await fixture({ execute: async () => json(pr({ comments: Array.from({ length: 100 }, (_, index) => comment(index + 1)) })) });
  assert.equal((await f.call('list_pr_comments', { prNumber: 7 })).structuredContent.result.mayBeTruncated, true);
  assert.equal((await f.call('edit_pr_comment', { prNumber: 7, commentId: COMMENT_ID, body: 'new' })).isError, true);
  assert.equal(f.calls.some((call) => call.args[0] === 'api'), false);
});
test('comment UTF-8 limit, required IDs and public API overrides fail before prepare', async () => {
  const f = await fixture({ extra: ['--max-body=100B'] });
  for (const args of [{ prNumber: 7, commentId: -1, body: 'body' }, { prNumber: 7, commentId: '123', body: 'body' },
    { prNumber: 7, commentId: 123, body: '' }, { prNumber: 7, commentId: 123, body: 'あ'.repeat(34) },
    { prNumber: 7, commentId: 123, body: 'body', endpoint: 'repos/other/repo/issues/7' },
    { prNumber: 7, commentId: 123, body: 'body', method: 'PATCH' }]) assert.equal((await f.call('edit_pr_comment', args)).isError, true);
  assert.equal((await f.call('comment_pr', { prNumber: 7, body: 'あ'.repeat(34) })).isError, true);
  assert.equal(f.prepares.length, 0);
});
test('successful comment PATCH followed by failed verification is explicitly uncertain', async () => {
  let reads = 0;
  const f = await fixture({ execute: async (args, input) => {
    if (args[0] === 'api') return json({ id: COMMENT_ID, body: JSON.parse(input).body });
    return json(pr({ comments: ++reads === 1 ? [comment()] : [] }));
  } });
  const result = await f.call('edit_pr_comment', { prNumber: 7, commentId: COMMENT_ID, body: 'changed' });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.execution.writeMayHaveSucceeded, true);
});
test('all tools expose strict schemas, byte limit and accurate annotations', async () => {
  const f = await fixture();
  const tools = (await f.server(rpc(3, 'tools/list'))).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['create_pr', 'edit_pr_body', 'convert_to_draft', 'mark_ready_for_review', 'view_pr', 'check_review_status', 'comment_pr', 'list_pr_comments', 'edit_pr_comment']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.outputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.properties.result.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, true);
  }
  assert.equal(tools[0].annotations.idempotentHint, false);
  assert.equal(tools[1].annotations.destructiveHint, true);
  assert.equal(tools[5].annotations.readOnlyHint, true);
});
test('exact UTF-8 byte boundaries and injection values are rejected before prepare', async () => {
  const f = await fixture({ extra: ['--max-body=100B'] });
  assert.equal((await f.call('create_pr', createArgs({ body: 'a'.repeat(100) }))).isError, false);
  const count = f.prepares.length;
  for (const body of ['a'.repeat(101), 'あ'.repeat(34), '\ud800', 'abc\0']) assert.equal((await f.call('create_pr', createArgs({ body }))).isError, true);
  for (const more of [{ base: '--help' }, { base: 'main;echo' }, { head: '--help' }, { head: 'owner:foo..bar' }, { draft: 'yes' }, { title: 'line\nbreak' }, { command: 'whoami' }, { nested: { workspace: root } }]) assert.equal((await f.call('create_pr', createArgs(more))).isError, true);
  assert.equal(f.prepares.length, count);
});
test('1M escaped body transport is accepted and body never appears in gh argv', async () => {
  const f = await fixture({ extra: ['--max-body=1M'] });
  const body = ('a\n"\\\t').repeat(200000).slice(0, 1048576);
  const result = await f.call('create_pr', createArgs({ body, draft: true }));
  assert.equal(result.isError, false);
  const command = f.calls.find((call) => call.args[1] === 'create');
  assert.deepEqual(command.args, ['pr', 'create', '--repo', `github.com/${REPO}`, '--base', 'release', '--head', 'fork-owner:feature', '--title=title', '--body-file', '-', '--draft']);
  assert.equal(command.input, body);
  assert.equal(command.args.includes(body), false);
});
test('create/edit/ready/undo use only fixed gh subcommands and verify the result', async () => {
  const f = await fixture();
  assert.equal((await f.call('create_pr', createArgs())).isError, false);
  assert.equal((await f.call('edit_pr_body', { prNumber: 7, body: 'new\nbody' })).structuredContent.result.body, 'new\nbody');
  assert.equal((await f.call('convert_to_draft', { prNumber: 7 })).structuredContent.result.isDraft, true);
  assert.equal((await f.call('mark_ready_for_review', { prNumber: 7 })).structuredContent.result.isDraft, false);
  for (const call of f.calls) assert.ok(call.args[0] === 'repo' && call.args[1] === 'view' || call.args[0] === 'pr' && ['create', 'edit', 'ready', 'view'].includes(call.args[1]));
  assert.ok(f.calls.some((call) => JSON.stringify(call.args) === JSON.stringify(['pr', 'edit', '--repo', `github.com/${REPO}`, '--body-file', '-', '--', '7'])));
  assert.ok(f.calls.some((call) => call.args[1] === 'ready' && call.args.includes('--undo')));
});
test('redirected repository and wrong PR identity fail before a write', async () => {
  for (const name of ['create_pr', 'edit_pr_body', 'convert_to_draft']) {
    const f = await fixture({ execute: async (args) => args[0] === 'repo' ? json({ nameWithOwner: 'Moved/repo', url: 'https://github.com/Moved/repo' }) : json(pr({ url: 'https://github.com/Moved/repo/pull/7' })) });
    const result = await f.call(name, name === 'create_pr' ? createArgs() : { prNumber: 7, body: 'new' });
    assert.equal(result.isError, true);
    assert.equal(f.calls.some((call) => call.write), false);
  }
});
test('review completion distinguishes ready, approved, requests, null and capped data', async () => {
  for (const [more, expected] of [[{ reviewDecision: 'APPROVED', reviewRequests: [] }, true],
    [{ reviewDecision: 'REVIEW_REQUIRED', reviewRequests: [] }, false], [{ reviewDecision: 'CHANGES_REQUESTED', reviewRequests: [] }, false],
    [{ reviewDecision: null, reviewRequests: [] }, null], [{ reviewDecision: '', reviewRequests: [] }, null],
    [{ reviewDecision: 'APPROVED', reviewRequests: [{}] }, false], [{ reviewDecision: 'APPROVED', reviewRequests: [], isDraft: true }, false],
    [{ reviewDecision: 'APPROVED', reviewRequests: [], state: 'MERGED' }, false], [{ reviewDecision: 'APPROVED', reviewRequests: Array(100).fill({}) }, null]]) {
    const f = await fixture({ execute: async () => json(pr(more)) });
    const result = await f.call('check_review_status', { prNumber: 7 });
    assert.equal(result.isError, false); assert.equal(result.structuredContent.result.reviewComplete, expected);
    assert.equal(f.calls.some((call) => call.write), false);
  }
});
test('oversized existing bodies are omitted while editing them to a small body remains possible', async () => {
  let body = 'x'.repeat(101);
  const f = await fixture({ extra: ['--max-body=100B'], execute: async (args, input) => {
    if (args[1] === 'edit') body = input;
    return json(pr({ body }));
  } });
  const viewed = (await f.call('view_pr', { prNumber: 7 })).structuredContent.result;
  assert.equal(viewed.body, null); assert.equal(viewed.bodyBytes, 101); assert.equal(viewed.bodyOmitted, true);
  assert.equal((await f.call('edit_pr_body', { prNumber: 7, body: 'small' })).isError, false);
});
test('every invalid private envelope and nested root override fails before prepare', async () => {
  const f = await fixture({ environment: env({ LOCAL_MCP_GATEWAY_ISOLATION_KEY: KEY }) });
  const valid = envelope();
  const envelopes = [undefined, null, {}, { ...valid, version: 2 }, { ...valid, signature: '' }, { ...valid, signature: '0'.repeat(64) },
    { ...valid, base: secondRoot }, { ...valid, roots: [] }, { ...valid, extra: true }, { ...valid, roots: ['relative'] }];
  for (const value of envelopes) assert.equal((await f.call('view_pr', { prNumber: 7, ...(value === undefined ? {} : { __localMcpIsolation: value }) })).isError, true);
  assert.equal(f.prepares.length, 0);
  assert.equal((await f.call('view_pr', { prNumber: 7, __localMcpIsolation: valid, nested: { allowedRoots: [secondRoot] } })).isError, true);
  assert.equal((await f.call('view_pr', { prNumber: 7, __localMcpIsolation: valid })).isError, false);
  const contextWithId = { isolatedId: 'sdk-current', roots: [root], base: root };
  assert.equal((await f.call('view_pr', { prNumber: 7, __localMcpIsolation: envelope(contextWithId) })).isError, false);
});
test('uncertain post-write verification preserves writeMayHaveSucceeded and redacts token', async () => {
  let reads = 0;
  const f = await fixture({ execute: async (args) => {
    if (args[1] === 'edit') return json({});
    if (++reads === 1) return json(pr());
    return json(pr({ body: `wrong ${TOKEN}` }));
  } });
  const result = await f.call('edit_pr_body', { prNumber: 7, body: 'new' });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.execution.writeMayHaveSucceeded, true);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

async function signedRuntime(environment = env(), options = {}) {
  const isolation = createBundledIsolation({ key: KEY });
  const runtime = createRuntime(parseStartupArguments(argv()), { env: environment, isolation, ...options });
  const run = (operation, context = { roots: [root], base: root }) => isolation.run({ __localMcpIsolation: envelope(context) }, operation);
  return { runtime, run };
}
test('real path policy enforces allow/deny files, directories, globs and signed cwd', async () => {
  for (const override of [{ LOCAL_MCP_DISALLOWED_FILES: JSON.stringify([tokenFile]) }, { LOCAL_MCP_DISALLOWED_FILES: JSON.stringify([gh]) },
    { LOCAL_MCP_DISALLOWED_DIRECTORIES: JSON.stringify([trusted]) }, { LOCAL_MCP_DISALLOWED_PATH_GLOBS: JSON.stringify(['**token.txt']) },
    { LOCAL_MCP_DISALLOWED_PATH_GLOBS: JSON.stringify(['**/gh', '**/gh.exe']) }, { LOCAL_MCP_DISALLOWED_DIRECTORIES: JSON.stringify([root]) }]) {
    const { runtime, run } = await signedRuntime(env(override));
    await assert.rejects(run(() => runtime.prepare()), /allowed_files|outside|denied|disallowed/);
  }
  const { runtime, run } = await signedRuntime();
  assert.equal((await run(() => runtime.prepare())).cwd, root);
  assert.equal((await run(() => runtime.prepare(), { roots: [secondRoot], base: secondRoot })).cwd, secondRoot);
  const link = join(root, 'escape');
  await symlink(secondRoot, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run(() => runtime.prepare(), { roots: [root], base: link }), /escapes signed roots/);
});
test('fixed gh and token are automatically readable with empty allowed_files and do not alter public path policy', async () => {
  const environment = env();
  const { runtime, run } = await signedRuntime(environment);
  const prepared = await run(() => runtime.prepare());
  assert.equal(prepared.executable, gh);
  assert.equal(prepared.token, TOKEN);
  assert.equal(environment.LOCAL_MCP_ALLOWED_FILES, '[]');
  const unrelated = await mkdtemp(join(tmpdir(), 'gh-pr-unallowed-base-'));
  await assert.rejects(run(() => runtime.prepare(), { roots: [unrelated], base: unrelated }), /outside allowed_directories/);
});
test('token file rejects invalid UTF-8, UTF-16LE, size violations, symlinks and writable locations', async () => {
  for (const [index, bytes] of [Buffer.from([255, 254, 65, 0]), Buffer.from([195, 40]), Buffer.from('bad token'), Buffer.alloc(0), Buffer.alloc(8193, 65)].entries()) {
    const file = join(trusted, `invalid-${index}.txt`);
    await writeFile(file, bytes);
    const isolation = createBundledIsolation({ key: KEY });
    const runtime = createRuntime(parseStartupArguments(argv().map((arg) => arg.startsWith('--token-file=') ? `--token-file=${file}` : arg)), {
      isolation, env: env({ LOCAL_MCP_ALLOWED_FILES: JSON.stringify([file, gh]) }) });
    await assert.rejects(isolation.run({ __localMcpIsolation: envelope() }, () => runtime.prepare()));
  }
  const linked = join(trusted, 'token-link.txt'); await symlink(tokenFile, linked);
  const writable = join(root, 'token.txt'); await writeFile(writable, TOKEN, 'utf8');
  for (const file of [linked, writable]) {
    const isolation = createBundledIsolation({ key: KEY });
    const runtime = createRuntime(parseStartupArguments(argv().map((arg) => arg.startsWith('--token-file=') ? `--token-file=${file}` : arg)), {
      isolation, env: env({ LOCAL_MCP_ALLOWED_FILES: JSON.stringify([file, tokenFile, gh]) }) });
    await assert.rejects(isolation.run({ __localMcpIsolation: envelope() }, () => runtime.prepare()));
  }
});
function fakeChild(onStart) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
  setImmediate(() => onStart(child));
  return child;
}
test('executor has fixed executable, no shell, file-only token env, stripped isolation/proxy/debug and closed stdin', async () => {
  let observed;
  const { runtime, run } = await signedRuntime(env({ LOCAL_MCP_GATEWAY_ISOLATION_KEY: KEY, GH_HTTP_UNIX_SOCKET: 'evil', GH_DEBUG: 'api', HTTPS_PROXY: 'evil', NODE_OPTIONS: '--bad', OPENAI_API_KEY: 'private' }), {
    spawnProcess: (file, args, options) => { observed = { file, args, options }; return fakeChild((child) => { child.stdout.write(`ok ${TOKEN}`); child.emit('close', 0, null); }); }
  });
  await run(async () => {
    const prepared = await runtime.prepare();
    const result = await runtime.execute(['pr', 'view', '7', '--repo', `github.com/${REPO}`], undefined, undefined, prepared);
    assert.equal(result.stdout, 'ok [REDACTED]');
  });
  assert.equal(observed.file, gh); assert.equal(observed.options.shell, false); assert.equal(observed.options.cwd, root);
  assert.equal(observed.options.env.GH_TOKEN, TOKEN);
  for (const key of ['LOCAL_MCP_GATEWAY_ISOLATION_KEY', 'GH_HTTP_UNIX_SOCKET', 'GH_DEBUG', 'HTTPS_PROXY', 'NODE_OPTIONS', 'OPENAI_API_KEY']) assert.equal(observed.options.env[key], undefined);
  assert.equal(JSON.stringify(observed.args).includes(TOKEN), false);
});
test('executor terminates and returns bounded structured timeout, overflow, cancellation and nonzero errors', async () => {
  for (const mode of ['timeout', 'overflow', 'cancel', 'exit']) {
    let child;
    const controller = new AbortController();
    const { runtime, run } = await signedRuntime(env(), { timeoutMs: 30, maxOutputBytes: 100,
      spawnProcess: () => (child = fakeChild((instance) => {
        if (mode === 'overflow') instance.stdout.write('x'.repeat(101));
        if (mode === 'cancel') controller.abort();
        if (mode === 'exit') { instance.stderr.write(`forbidden ${TOKEN}`); instance.emit('close', 1, null); }
      })) });
    await run(async () => {
      const prepared = await runtime.prepare();
      await assert.rejects(runtime.execute(['pr', 'edit', '7'], 'body', controller.signal, prepared, true), (error) => {
        assert.equal(error.details.writeMayHaveSucceeded, true);
        assert.equal(JSON.stringify(error.details).includes(TOKEN), false);
        assert.ok(Buffer.byteLength(error.details.stdout) <= 100);
        return true;
      });
    });
    if (mode !== 'exit') assert.equal(child.killed, true);
  }
});
test('cancellation notification bypasses ordered tool queue and prevents queued side effects', async () => {
  let release;
  const f = await fixture({ prepare: async (signal) => { await new Promise((resolvePromise) => { release = resolvePromise; signal.addEventListener('abort', resolvePromise, { once: true }); });
    if (signal.aborted) throw new Error('cancelled'); return { token: TOKEN }; } });
  const active = f.server(rpc(10, 'tools/call', { name: 'view_pr', arguments: { prNumber: 7 } }));
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const queued = f.server(rpc(11, 'tools/call', { name: 'view_pr', arguments: { prNumber: 7 } }));
  await f.server({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 11 } });
  await f.server({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10 } });
  release();
  assert.equal((await active).result.isError, true); assert.equal((await queued).result.isError, true);
  assert.equal(f.calls.length, 0); assert.equal(f.prepares.length, 1);
});
test('stdio emits JSON-RPC only, recovers after oversized frames and preserves split UTF-8', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const replies = []; let buffer = '';
  output.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  const body = 'あいうえお';
  const runtime = { prepare: async () => ({ token: TOKEN }), execute: async (args) => args[0] === 'repo'
    ? json({ nameWithOwner: REPO, url: `https://github.com/${REPO}` }) : args[1] === 'create' ? { ...json({}), stdout: pr().url + '\n' } : json(pr({ body })) };
  const stream = startStdio(input, output, { argv: argv(['--max-body=100B']), env: env(), runtime });
  input.write(JSON.stringify(rpc(1, 'initialize')) + '\n');
  input.write('x'.repeat(66137)); input.write('\n');
  const line = Buffer.from(JSON.stringify(rpc(2, 'tools/call', { name: 'create_pr', arguments: createArgs({ body }) })) + '\n');
  for (let index = 0; index < line.length; index += 7) input.write(line.subarray(index, index + 7));
  await stream.settled();
  for (const line of buffer.trim().split('\n')) replies.push(JSON.parse(line));
  assert.ok(replies.some((reply) => reply.error?.code === -32700));
  assert.equal(replies.find((reply) => reply.id === 2).result.structuredContent.result.body, body);
  stream.close(); input.destroy(); output.destroy();
});
test('stdio accepts a full 1M body even when JSON escaping expands it sixfold', async () => {
  const body = '\u0001'.repeat(1048576);
  const input = new PassThrough(), output = new PassThrough();
  let buffer = '';
  output.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  const runtime = { prepare: async () => ({ token: TOKEN }), execute: async (args) => args[0] === 'repo'
    ? json({ nameWithOwner: REPO, url: `https://github.com/${REPO}` }) : args[1] === 'create' ? { ...json({}), stdout: pr().url + '\n' } : json(pr({ body })) };
  const stream = startStdio(input, output, { argv: argv(['--max-body=1M']), env: env(), runtime });
  input.write(JSON.stringify(rpc(1, 'initialize')) + '\n');
  const line = Buffer.from(JSON.stringify(rpc(2, 'tools/call', { name: 'create_pr', arguments: createArgs({ body }) })) + '\n');
  for (let offset = 0; offset < line.length; offset += 65536) input.write(line.subarray(offset, offset + 65536));
  await stream.settled();
  const result = buffer.trim().split('\n').map((value) => JSON.parse(value)).find((reply) => reply.id === 2);
  assert.equal(result.result.isError, false); assert.equal(result.result.structuredContent.result.bodyBytes, 1048576);
  stream.close(); input.destroy(); output.destroy();
});
test('standalone help never writes nonprotocol text to stdout', async () => {
  const result = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [resolve('mcp/gh-pr/server.mjs'), '--help'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /--max-body/);
});
test('config is TOML-valid, bundled, online-only, and supplies exact read-only trust files', async () => {
  const example = parseToml(await readFile('config/gateway.gh-pr.example.toml', 'utf8'));
  assert.equal(example.mcp_servers.gh_pr.sandbox, 'onlineworkspace');
  for (const key of ['allowed_directories', 'allowed_files', 'disallowed_directories', 'disallowed_files', 'disallowed_path_globs']) assert.ok(Array.isArray(example.mcp_servers.gh_pr[key]));
  const directory = await mkdtemp(join(tmpdir(), 'gh-pr-config-'));
  const path = join(directory, 'gateway.toml');
  for (const sandbox of ['never', 'elevated', 'unelevated', 'onlineworkspace']) {
    await writeFile(path, `private_use_only = true\nprotect_gateway_app = true\n[mcp_servers.gh_pr]\ncommand = '${process.execPath}'\nargs = ['${resolve('mcp/gh-pr/server.mjs')}', '--repository=${REPO}', '--token-file=${tokenFile}', '--gh-executable=${gh}']\ncwd = '${root}'\nsandbox = '${sandbox}'\ncodex_executable = '${join(trusted, 'codex')}'\nallowed_directories = ['${root}']\nallowed_files = []\n`, 'utf8');
    if (sandbox !== 'onlineworkspace') await assert.rejects(loadGatewayConfig(path), /onlineworkspace for gh-pr/);
    else {
      const loaded = await loadGatewayConfig(path);
      assert.equal(loaded.servers[0].isBundled, true);
      assert.deepEqual(loaded.servers[0].allowedFiles, []);
      assert.deepEqual(loaded.servers[0].sandboxReadOnlyFiles, [gh, tokenFile]);
      const profile = codexAppServerInternals.permissionProfileOverrideFor(loaded.servers[0]);
      for (const file of [gh, tokenFile]) {
        assert.ok(profile.includes(`'${file}'='read'`));
        assert.equal(profile.includes(`'${file}'='write'`), false);
      }
    }
  }
});
