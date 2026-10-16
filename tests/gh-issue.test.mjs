import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createGhExecutor, createServer, createTokenReader, normalizeCommentRepository, parseBodyLimit, parseStartupArguments, startStdio } from '../mcp/gh-issue/server.mjs';
import { createBundledIsolation, signBundledIsolationContext } from '../app/bundled-isolation.mjs';
import { loadGatewayConfig } from '../app/server-config.mjs';
import { parseToml } from '../app/toml-lite.mjs';

const TOKEN = 'ghp_test_secret_only';
const REPO = 'other-owner/public-repo';
const ghDirectory = await mkdtemp(join(tmpdir(), 'gh-issue-trusted-'));
const GH_EXECUTABLE = join(ghDirectory, process.platform === 'win32' ? 'gh.exe' : 'gh');
const tokenDirectory = await mkdtemp(join(tmpdir(), 'gh-issue-token-'));
const TOKEN_FILE = join(tokenDirectory, 'token.txt');
await writeFile(TOKEN_FILE, `${TOKEN}\n`, 'utf8');
await writeFile(GH_EXECUTABLE, 'test placeholder; never executed\n', 'utf8');
const canonicalGhExecutable = await realpath(GH_EXECUTABLE);
// Unit tests simulate the marker; they do not claim to launch a real OS sandbox.
process.env.LOCAL_MCP_CODEX_SANDBOX_MODE = 'onlineworkspace';
const startup = (extra = []) => [`--token-file=${TOKEN_FILE}`, `--gh-executable=${GH_EXECUTABLE}`, `--edit-comments=${REPO}`, ...extra];
const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const json = (value) => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });
const issue = (number = 7) => ({ number, url: `https://github.com/${REPO}/issues/${number}`, title: '題名' });
const COMMENT_ID = 3653399145;
const apiComment = (id = COMMENT_ID, body = '元のコメント\n本文') => ({
  id, body, url: `https://api.github.com/repos/${REPO}/issues/comments/${id}`,
  issue_url: `https://api.github.com/repos/${REPO}/issues/7`,
  html_url: `https://github.com/${REPO}/issues/7#issuecomment-${id}`,
  user: { login: 'comment-author' }, created_at: '2026-10-12T03:00:00Z', updated_at: '2026-10-12T03:00:00Z'
});
const publicRepo = () => json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` });

async function fixture(extra = [], custom) {
  const commands = [];
  const server = createServer({ argv: startup(extra), execute: async (args, input) => {
    commands.push({ args, input });
    if (custom) return custom(args, input);
    if (args[0] === 'repo') return json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` });
    if (args[1] === 'view') return json(issue(Number(args[2])));
    if (args[1] === 'list') return json([issue()]);
    return { stdout: `https://github.com/${REPO}/issues/7\n`, stderr: '', exitCode: 0 };
  } });
  await server(request(1, 'initialize'));
  const call = (name, args = {}) => server(request(2, 'tools/call', { name, arguments: { repository: REPO, ...args } }));
  return { server, commands, call };
}

test('token-file is supported, legacy token arguments remain compatible, and errors do not echo secrets', () => {
  assert.throws(() => parseStartupArguments([]), /--token-file or --token is required/);
  assert.equal(parseStartupArguments([`--token=${TOKEN}`, `--gh-executable=${GH_EXECUTABLE}`]).token, TOKEN);
  assert.equal(parseStartupArguments(['--token', TOKEN, `--gh-executable=${GH_EXECUTABLE}`]).token, TOKEN);
  assert.throws(() => parseStartupArguments([`--token=${TOKEN}`, `--token=${TOKEN}`]), /only once/);
  assert.throws(() => parseStartupArguments(['--token=bad token', `--gh-executable=${GH_EXECUTABLE}`]), /invalid token/);
  assert.throws(() => parseStartupArguments([`--token-file=${TOKEN_FILE}`, `--token-file=${TOKEN_FILE}`]), /only once/);
  assert.throws(() => parseStartupArguments(['--token-file=relative.txt']), /absolute path/);
  assert.throws(() => parseStartupArguments([`--unknown=${TOKEN}`]), (error) => !error.message.includes(TOKEN));
  assert.throws(() => parseStartupArguments([`--token-file=${TOKEN_FILE}`, '--gh-executable=relative.exe']), /absolute path/);
  assert.throws(() => parseStartupArguments(startup(['--repository=https://github.com/a/b'])), /OWNER\/REPO/);
  assert.throws(() => parseStartupArguments(startup(['--repository=a/b;command'])), /OWNER\/REPO/);
  assert.deepEqual(parseStartupArguments(['--help']), { help: true });
  assert.throws(() => parseStartupArguments([`--token-file=${TOKEN_FILE}`]), /--gh-executable is required/);
  assert.throws(() => parseStartupArguments([`--token-file=${TOKEN_FILE}`, `--gh-executable=${join(ghDirectory, 'node')}`]), /--gh-executable is required/);
  assert.equal(parseStartupArguments(['--token-file', TOKEN_FILE, `--gh-executable=${GH_EXECUTABLE}`]).tokenFile, TOKEN_FILE);
  assert.equal(Object.hasOwn(parseStartupArguments(startup()), 'token'), false);
  assert.equal(JSON.stringify(startup()).includes(TOKEN), false);
  assert.deepEqual(parseStartupArguments(startup(['--repository=A/B', '--repository=a/b'])).repositories, ['a/b']);
});

test('max-body accepts PR-compatible byte units and rejects invalid or duplicate settings', () => {
  for (const [value, expected] of [
    ['10', 10], ['10B', 10], ['10K', 10240], ['10KB', 10240], ['10KiB', 10240], ['10kib', 10240],
    ['1M', 1048576], ['1MB', 1048576], ['1MiB', 1048576], ['1048576', 1048576]
  ]) {
    assert.equal(parseBodyLimit(value), expected);
    assert.equal(parseStartupArguments(startup([`--max-body=${value}`])).maxBodyBytes, expected);
  }
  assert.equal(parseStartupArguments(startup()).maxBodyBytes, 10240);
  assert.equal(parseStartupArguments(startup(['--max-body', '10B'])).maxBodyBytes, 10);
  for (const value of ['', '0', '0B', '-1', '1.5K', '1e6', 'NaN', '10GB', '10K;echo', '2M', '1048577']) {
    assert.throws(() => parseStartupArguments(startup([`--max-body=${value}`])), /--max-body/);
  }
  assert.throws(() => parseStartupArguments(startup(['--max-body'])), /requires a value/);
  assert.throws(() => parseStartupArguments(startup(['--max-body=10B', '--max-body=10K'])), /only once/);
});

test('write body limits count UTF-8 bytes, accept exact boundaries, and reject before any gh execution', async () => {
  for (const [name, args] of [
    ['create_issue', { title: 'A title longer than the body byte limit' }],
    ['comment_issue', { issueNumber: 7 }],
    ['edit_issue', { issueNumber: 7 }],
    ['edit_issue_comment', { commentId: COMMENT_ID }]
  ]) {
    const { server, call, commands } = await fixture(['--max-body=10B'], (command, input) => {
      if (command[0] === 'repo') return publicRepo();
      if (command[0] === 'api') return json(apiComment(COMMENT_ID, input === undefined ? 'Existing body exceeding ten bytes' : JSON.parse(input).body));
      if (command[1] === 'view') return json(issue());
      return { stdout: `https://github.com/${REPO}/issues/7\n`, stderr: '', exitCode: 0 };
    });
    const schemas = (await server(request(3, 'tools/list'))).result.tools;
    assert.equal(schemas.find((tool) => tool.name === name).inputSchema.properties.body.maxLength, 10);
    for (const body of ['a'.repeat(11), 'あいうab', '😀😀abc']) {
      const result = (await call(name, { ...args, body })).result;
      assert.equal(result.isError, true, name);
      assert.match(result.structuredContent.error, /body exceeds 10 UTF-8 bytes/);
    }
    assert.equal(commands.length, 0, `${name} must reject before preflight or mutation`);
    for (const body of ['a'.repeat(10), 'あいうa', '😀😀ab', 'a'.repeat(9) + '\n']) {
      const result = (await call(name, { ...args, body })).result;
      assert.equal(result.isError, false, `${name}: ${result.content[0].text}`);
      const sent = commands.at(-1).input;
      assert.equal(name === 'edit_issue_comment' ? JSON.parse(sent).body : sent, body);
    }
  }
});

test('max-body does not limit read bodies, titles, title-only edits, close, or empty Issue bodies', async () => {
  const body = '本文😀\n'.repeat(3000);
  const { call, commands } = await fixture(['--max-body=1B'], (args) => {
    if (args[0] === 'repo') return publicRepo();
    if (args[0] === 'api') return json(args.at(-1).includes('/issues/7/comments?') ? [apiComment(COMMENT_ID, body)] : apiComment(COMMENT_ID, body));
    if (args[1] === 'view') return json({ ...issue(), body, comments: [{ body }] });
    if (args[1] === 'list') return json([issue()]);
    return { stdout: `https://github.com/${REPO}/issues/7\n`, stderr: '', exitCode: 0 };
  });
  const viewed = (await call('view_issue', { issueNumber: 7, comments: true })).result;
  assert.equal(viewed.isError, false);
  assert.equal(viewed.structuredContent.result.issue.body, body);
  assert.equal(viewed.structuredContent.result.issue.comments[0].body, body);
  const listed = (await call('list_issue_comments', { issueNumber: 7 })).result;
  assert.equal(listed.isError, false);
  assert.equal(listed.structuredContent.result.comments[0].body, body);
  const comment = (await call('view_issue_comment', { commentId: COMMENT_ID })).result;
  assert.equal(comment.isError, false);
  assert.equal(comment.structuredContent.result.comment.body, body);
  assert.equal((await call('list_issues')).result.isError, false);
  assert.equal((await call('close_issue', { issueNumber: 7 })).result.isError, false);
  assert.equal((await call('edit_issue', { issueNumber: 7, title: 'Title longer than one byte' })).result.isError, false);
  assert.equal(commands.at(-1).input, undefined);
  assert.equal((await call('create_issue', { title: 'Title longer than one byte', body: '' })).result.isError, false);
  assert.equal((await call('edit_issue', { issueNumber: 7, body: '' })).result.isError, false);
  for (const [name, args] of [['comment_issue', { issueNumber: 7 }], ['edit_issue_comment', { commentId: COMMENT_ID }]]) {
    assert.equal((await call(name, { ...args, body: '' })).result.isError, true);
  }
});

test('oversized bodies are rejected before reading the configured token file', async () => {
  const server = createServer({
    argv: [`--token-file=${join(tokenDirectory, 'missing-max-body-token.txt')}`, `--gh-executable=${GH_EXECUTABLE}`, '--max-body=1B'],
    execute: async () => { assert.fail('gh must not execute'); }
  });
  await server(request(1, 'initialize'));
  const result = (await server(request(2, 'tools/call', {
    name: 'create_issue', arguments: { repository: REPO, title: 'title', body: 'ab' }
  }))).result;
  assert.equal(result.isError, true);
  assert.match(result.structuredContent.error, /body exceeds 1 UTF-8 bytes/);
});

test('legacy token authentication executes the same fixed commands and token-file takes precedence', async () => {
  const legacyArgs = [`--token=${TOKEN}`, `--gh-executable=${GH_EXECUTABLE}`];
  assert.equal(await createTokenReader(parseStartupArguments(legacyArgs))(), TOKEN);
  assert.equal(await createTokenReader(parseStartupArguments(startup(['--token=ignored_legacy_token'])))(), TOKEN);
  let sawCall = false;
  const server = createServer({ argv: legacyArgs, execute: async (args) => {
    sawCall = true;
    return args[0] === 'repo' ? json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` }) : json([]);
  } });
  await server(request(1, 'initialize'));
  const result = await server(request(2, 'tools/call', { name: 'list_issues', arguments: { repository: REPO } }));
  assert.equal(result.result.isError, false);
  assert.equal(sawCall, true);
});

test('edit-comments accepts repeated normalized GitHub repository identities and deduplicates them', () => {
  const equivalent = [
    'ZevyaDev/dqix-decomp-kit', 'ZEVYADEV/DQIX-DECOMP-KIT', 'github.com/ZevyaDev/dqix-decomp-kit',
    'https://github.com/ZevyaDev/dqix-decomp-kit.git/', 'git@github.com:ZevyaDev/dqix-decomp-kit.git'
  ];
  for (const value of equivalent) assert.equal(normalizeCommentRepository(value), 'zevyadev/dqix-decomp-kit');
  const config = parseStartupArguments(startup(equivalent.map((value) => `--edit-comments=${value}`)));
  assert.deepEqual(config.editCommentRepositories, [REPO, 'zevyadev/dqix-decomp-kit']);
  assert.equal(parseStartupArguments(startup(['--edit-comments', 'Second/Repo'])).editCommentRepositories.at(-1), 'second/repo');
  for (const value of [
    'https://evil.invalid/ZevyaDev/dqix-decomp-kit', 'https://github.com/ZevyaDev/dqix-decomp-kit?x=1',
    'https://github.com/user:secret@evil.invalid/a/b', 'https://github.com/ZevyaDev/dqix-decomp-kit#fragment',
    'ZevyaDev/dqix-decomp-kit/extra', 'ZevyaDev/dqix-decomp-kit;command', 'ZevyaDev\\dqix-decomp-kit'
  ]) assert.throws(() => parseStartupArguments(startup([`--edit-comments=${value}`])));
});

test('unlisted comment edits are denied before gh and leave all other tools unrestricted', async () => {
  let executions = 0;
  const server = createServer({ argv: startup().filter((argument) => !argument.startsWith('--edit-comments=')), execute: async (args) => {
    executions += 1;
    if (args[0] === 'repo') return publicRepo();
    if (args[0] === 'api') return json(args.some((argument) => argument.includes('/issues/7/comments?')) ? [apiComment()] : apiComment());
    if (args[1] === 'view') return json(issue());
    if (args[1] === 'list') return json([issue()]);
    return { stdout: `https://github.com/${REPO}/issues/7#issuecomment-${COMMENT_ID}\n`, stderr: '', exitCode: 0 };
  } });
  await server(request(1, 'initialize'));
  const call = (name, args) => server(request(2, 'tools/call', { name, arguments: { repository: REPO, ...args } }));
  const denied = (await call('edit_issue_comment', { commentId: COMMENT_ID, body: 'a' })).result;
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Comment editing is not allowed/);
  assert.equal(executions, 0);
  for (const [name, args] of [
    ['create_issue', { title: '新しいIssue', body: '本文' }],
    ['view_issue', { issueNumber: 7 }],
    ['list_issues', {}],
    ['comment_issue', { issueNumber: 7, body: '投稿' }],
    ['close_issue', { issueNumber: 7 }],
    ['edit_issue', { issueNumber: 7, body: 'Issue本文' }],
    ['list_issue_comments', { issueNumber: 7 }],
    ['view_issue_comment', { commentId: COMMENT_ID }]
  ]) assert.equal((await call(name, args)).result.isError, false, `${name} must not require --edit-comments`);
});

test('comment edit whitelist compares normalized full repository identities without prefix matches', async () => {
  const { call, commands } = await fixture([], (args, input) => {
    if (args[0] === 'repo') return publicRepo();
    if (args[0] === 'issue') return json(issue());
    return json(apiComment(COMMENT_ID, args.includes('PATCH') ? JSON.parse(input).body : '元の本文'));
  });
  const allowed = await call('edit_issue_comment', { repository: REPO.toUpperCase(), commentId: COMMENT_ID, body: '編集' });
  assert.equal(allowed.result.isError, false);
  const count = commands.length;
  for (const repository of [`${REPO}-extra`, REPO.replace('other-owner', 'different-owner'), 'other-owner/another']) {
    const denied = await call('edit_issue_comment', { repository, commentId: COMMENT_ID, body: 'a' });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /Comment editing is not allowed/);
  }
  assert.equal(commands.length, count);
});

test('token file accepts UTF-8 with a trailing newline and rejects empty, oversized, invalid, or UTF-16 content', async () => {
  assert.equal(await createTokenReader(parseStartupArguments(startup()))(), TOKEN);
  for (const [index, bytes] of [
    Buffer.alloc(0), Buffer.from(' '.repeat(3)), Buffer.from('bad secret token'), Buffer.from('a'.repeat(8193)),
    Buffer.from('a'.repeat(4097)), Buffer.from([0xff, 0xfe, 0x61, 0, 0x61, 0]), Buffer.from([0xc3, 0x28])
  ].entries()) {
    const path = join(tokenDirectory, `invalid-${index}.txt`);
    await writeFile(path, bytes);
    let executions = 0;
    const execute = createGhExecutor(parseStartupArguments([`--token-file=${path}`, `--gh-executable=${GH_EXECUTABLE}`]), {
      spawnProcess: () => { executions += 1; }
    });
    await assert.rejects(execute(['issue', 'list']), (error) => error.message.includes('--token-file') && !error.message.includes('bad secret token'));
    assert.equal(executions, 0);
  }
  const missing = createTokenReader(parseStartupArguments([`--token-file=${join(tokenDirectory, 'missing.txt')}`, `--gh-executable=${GH_EXECUTABLE}`]));
  await assert.rejects(missing(), /ENOENT/);
});

test('token file rejects symbolic links', async (t) => {
  const link = join(tokenDirectory, 'linked.txt');
  try { await symlink(TOKEN_FILE, link); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('OS does not permit test symlink creation'); return; }
    throw error;
  }
  const readToken = createTokenReader(parseStartupArguments([`--token-file=${link}`, `--gh-executable=${GH_EXECUTABLE}`]));
  await assert.rejects(readToken(), /non-symbolic-link regular file/);
});

test('token file inside writable roots is refused before gh can run', async () => {
  const readToken = createTokenReader(parseStartupArguments(startup()), {
    current: () => ({ base: tokenDirectory, roots: [tokenDirectory] })
  });
  await assert.rejects(readToken(), /--token-file must be outside writable workspace roots/);
});

test('discovery exposes exactly nine Issue operations with accurate annotations', async () => {
  const { server } = await fixture();
  const result = await server(request(3, 'tools/list'));
  const tools = result.result.tools;
  assert.deepEqual(tools.map((entry) => entry.name), ['create_issue', 'view_issue', 'list_issues', 'comment_issue', 'close_issue', 'edit_issue', 'list_issue_comments', 'view_issue_comment', 'edit_issue_comment']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.token, undefined);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.ok(tool.inputSchema.required.includes('repository'));
  }
  assert.equal(tools[0].annotations.idempotentHint, false);
  assert.equal(tools[1].annotations.readOnlyHint, true);
  assert.equal(tools[2].annotations.readOnlyHint, true);
  assert.equal(tools[3].annotations.idempotentHint, false);
  assert.equal(tools[4].annotations.destructiveHint, true);
  assert.equal(tools[5].annotations.destructiveHint, true);
  assert.equal(tools[5].annotations.idempotentHint, true);
  assert.equal(tools[6].annotations.readOnlyHint, true);
  assert.equal(tools[7].annotations.readOnlyHint, true);
  assert.equal(tools[8].annotations.destructiveHint, true);
  assert.equal(tools[8].annotations.idempotentHint, true);
});

test('all five operations use fixed gh commands and literal multiline stdin', async () => {
  const { commands, call } = await fixture();
  const body = '# 本文\n改行と $(do-not-run) `literal`\n末尾\n';
  for (const [name, args] of [
    ['create_issue', { title: '--help; literal title', body }],
    ['view_issue', { issueNumber: 7, comments: true }],
    ['list_issues', { state: 'all', limit: 5 }],
    ['comment_issue', { issueNumber: 7, body }],
    ['close_issue', { issueNumber: 7, reason: 'not planned' }]
  ]) assert.equal((await call(name, args)).result.isError, false);
  assert.equal(commands.filter((entry) => entry.args[0] === 'repo').length, 5);
  const create = commands.find((entry) => entry.args[1] === 'create');
  assert.deepEqual(create, { args: ['issue', 'create', '--repo', `github.com/${REPO}`, '--title=--help; literal title', '--body-file', '-'], input: body });
  const commentIndex = commands.findIndex((entry) => entry.args[1] === 'comment');
  assert.deepEqual(commands[commentIndex - 1].args, ['issue', 'view', '7', '--repo', `github.com/${REPO}`, '--json', 'number,url']);
  assert.deepEqual(commands[commentIndex], { args: ['issue', 'comment', '7', '--repo', `github.com/${REPO}`, '--body-file', '-'], input: body });
  const closeIndex = commands.findIndex((entry) => entry.args[1] === 'close');
  assert.equal(commands[closeIndex - 1].args[1], 'view');
  assert.deepEqual(commands[closeIndex].args, ['issue', 'close', '7', '--repo', `github.com/${REPO}`, '--reason', 'not planned']);
  assert.equal(commands.some((entry) => entry.args.includes(TOKEN)), false);
});

test('edit_issue replaces body/title independently and preserves literal UTF-8 stdin', async () => {
  for (const [args, suffix, expectedInput] of [
    [{ body: '# 修正\n$(literal)\n最後\n' }, ['--body-file', '-'], '# 修正\n$(literal)\n最後\n'],
    [{ title: '--help; 修正題名' }, ['--title=--help; 修正題名'], undefined],
    [{ title: '新題名', body: '' }, ['--title=新題名', '--body-file', '-'], '']
  ]) {
    const { commands, call } = await fixture();
    const reply = await call('edit_issue', { issueNumber: 7, ...args });
    assert.equal(reply.result.isError, false);
    assert.equal(commands.length, 3);
    assert.deepEqual(commands[1].args, ['issue', 'view', '7', '--repo', `github.com/${REPO}`, '--json', 'number,url']);
    assert.deepEqual(commands[2], { args: ['issue', 'edit', '7', '--repo', `github.com/${REPO}`, ...suffix], input: expectedInput });
  }
});

test('edit_issue rejects invalid input, private targets, and PRs before mutation', async () => {
  const valid = await fixture();
  for (const args of [
    { issueNumber: 7 }, { issueNumber: 7, body: null }, { issueNumber: 7, title: '' },
    { issueNumber: 7, title: 'a\nb' }, { issueNumber: 7, body: '\ud800' },
    { issueNumber: 7, body: 'a', command: 'node' }, { issueNumber: '--help', body: 'a' }
  ]) assert.equal((await valid.call('edit_issue', args)).result.isError, true);
  assert.equal(valid.commands.length, 0);
  const privateRepo = await fixture([], () => json({ visibility: 'PRIVATE' }));
  assert.equal((await privateRepo.call('edit_issue', { issueNumber: 7, body: 'a' })).result.isError, true);
  assert.equal(privateRepo.commands.length, 1);
  const pr = await fixture([], (args) => args[0] === 'repo'
    ? json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` })
    : json({ number: 7, url: `https://github.com/${REPO}/pull/7` }));
  assert.equal((await pr.call('edit_issue', { issueNumber: 7, body: 'a' })).result.isError, true);
  assert.equal(pr.commands.length, 2);
});

test('edit failure reaches the agent verbatim with stdout, stderr, and exitCode', async () => {
  const stderr = 'GraphQL: Resource not accessible by personal access token (updateIssue)\n詳細: 権限不足\n';
  const stdout = 'GitHub request was sent\n';
  const { call, commands } = await fixture([], (args) => {
    if (args[0] === 'repo') return json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` });
    if (args[1] === 'view') return json(issue());
    return { stdout, stderr, exitCode: 1, signal: null };
  });
  const reply = (await call('edit_issue', { issueNumber: 7, body: '編集本文' })).result;
  assert.equal(reply.isError, true);
  assert.equal(reply.content[0].text, stderr);
  assert.equal(reply.structuredContent.ok, false);
  assert.equal(reply.structuredContent.error, stderr);
  assert.deepEqual(reply.structuredContent.result, { stdout, stderr, exitCode: 1, signal: null });
  assert.equal(commands.length, 3);
  assert.equal(reply.content[0].text.includes('operation fault'), false);
});

test('preflight and stdout-only failures keep their original output and do not retry', async () => {
  for (const failedPhase of ['repo', 'view', 'edit']) {
    const stdout = `HTTP 403: ${failedPhase} denied\n`;
    const { call, commands } = await fixture([], (args) => {
      if ((failedPhase === 'repo' && args[0] === 'repo') || (args[0] === 'issue' && args[1] === failedPhase)) return { stdout, stderr: '', exitCode: 4 };
      return args[0] === 'repo' ? json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` }) : json(issue());
    });
    const reply = (await call('edit_issue', { issueNumber: 7, body: 'a' })).result;
    assert.equal(reply.content[0].text, stdout);
    assert.equal(reply.structuredContent.result.exitCode, 4);
    assert.equal(commands.length, { repo: 1, view: 2, edit: 3 }[failedPhase]);
  }
});

test('real gh executor failure is preserved through the MCP tool result with token redaction', async () => {
  const config = parseStartupArguments(startup());
  const stderr = `HTTP 403: updateIssue denied\ncredential: ${TOKEN}\n`;
  const execute = createGhExecutor(config, { spawnProcess: fakeProcess((child, executable, args) => {
    if (args[0] === 'repo') child.stdout.write(JSON.stringify({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` }));
    else if (args[1] === 'view') child.stdout.write(JSON.stringify(issue()));
    else {
      child.stdout.write('request-id: 123\n');
      child.stderr.write(stderr);
    }
    child.emit('close', args[1] === 'edit' ? 1 : 0, null);
  }) });
  const server = createServer({ argv: startup(), execute });
  await server(request(1, 'initialize'));
  const reply = (await server(request(2, 'tools/call', { name: 'edit_issue', arguments: { repository: REPO, issueNumber: 7, body: 'a' } }))).result;
  assert.equal(reply.content[0].text, stderr.replace(TOKEN, '[REDACTED]'));
  assert.equal(reply.structuredContent.result.stdout, 'request-id: 123\n');
  assert.equal(reply.structuredContent.result.stderr, stderr.replace(TOKEN, '[REDACTED]'));
  assert.equal(reply.structuredContent.result.exitCode, 1);
  assert.deepEqual(reply.structuredContent.result.command, ['gh', 'issue', 'edit', '7', '--repo', `github.com/${REPO}`, '--body-file', '-']);
  assert.equal(JSON.stringify(reply).includes(TOKEN), false);
});

test('stdio delivers edit failure details as an MCP tool result without converting them to a protocol fault', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let received = '';
  output.on('data', (chunk) => { received += chunk; });
  const stderr = 'HTTP 422: Validation Failed\nbody is too long\n';
  const stdio = startStdio(input, output, { argv: startup(), execute: async (args) => {
    if (args[0] === 'repo') return json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` });
    if (args[1] === 'view') return json(issue());
    return { stdout: '', stderr, exitCode: 1 };
  } });
  input.write(`${JSON.stringify(request(1, 'initialize'))}\n${JSON.stringify(request(2, 'tools/call', {
    name: 'edit_issue', arguments: { repository: REPO, issueNumber: 7, body: 'a' }
  }))}\n`);
  await stdio.settled();
  const reply = JSON.parse(received.trim().split('\n')[1]);
  assert.equal(reply.error, undefined);
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.content[0].text, stderr);
  assert.equal(reply.result.structuredContent.error, stderr);
  assert.equal(reply.result.structuredContent.result.stderr, stderr);
  assert.equal(reply.result.structuredContent.result.exitCode, 1);
});

test('list_issue_comments returns complete bodies and numeric IDs with explicit pagination', async () => {
  const { call, commands } = await fixture([], (args) => {
    if (args[0] === 'repo') return publicRepo();
    if (args[0] === 'issue') return json(issue());
    return args.at(-1).endsWith('page=1') ? json([apiComment(), apiComment(COMMENT_ID + 1, '次のコメント')]) : json([]);
  });
  const first = (await call('list_issue_comments', { issueNumber: 7, perPage: 2 })).result;
  assert.equal(first.isError, false);
  assert.equal(first.structuredContent.result.nextPage, 2);
  assert.deepEqual(first.structuredContent.result.comments.map((comment) => [comment.commentId, comment.body, comment.author]), [
    [COMMENT_ID, '元のコメント\n本文', 'comment-author'], [COMMENT_ID + 1, '次のコメント', 'comment-author']
  ]);
  assert.deepEqual(commands[2].args, ['api', '--hostname', 'github.com', '--method', 'GET', '--header', 'Accept: application/vnd.github+json', `repos/${REPO}/issues/7/comments?per_page=2&page=1`]);
  const second = (await call('list_issue_comments', { issueNumber: 7, perPage: 2, page: 2 })).result;
  assert.deepEqual(second.structuredContent.result.comments, []);
  assert.equal(second.structuredContent.result.nextPage, null);
});

test('view_issue_comment looks up an exact REST ID above 32 bits and returns full content', async () => {
  const { call, commands } = await fixture([], (args) => {
    if (args[0] === 'repo') return publicRepo();
    if (args[0] === 'issue') return json(issue());
    return json(apiComment());
  });
  const reply = (await call('view_issue_comment', { commentId: COMMENT_ID })).result;
  assert.equal(reply.isError, false);
  assert.equal(reply.structuredContent.result.comment.commentId, COMMENT_ID);
  assert.equal(reply.structuredContent.result.comment.body, '元のコメント\n本文');
  assert.equal(reply.structuredContent.result.comment.issueNumber, 7);
  assert.equal(commands.length, 3);
  assert.equal(commands[1].args.at(-1), `repos/${REPO}/issues/comments/${COMMENT_ID}`);
  assert.equal(commands.some((entry) => entry.args.includes('PATCH')), false);
});

test('edit_issue_comment patches only the chosen ID and sends the replacement body as literal JSON stdin', async () => {
  const body = '# 編集後\n$(literal) `literal`\n引用: "内容"\n';
  const { call, commands } = await fixture([], (args, input) => {
    if (args[0] === 'repo') return publicRepo();
    if (args[0] === 'issue') return json(issue());
    return json(apiComment(COMMENT_ID, args.includes('PATCH') ? JSON.parse(input).body : '元の本文'));
  });
  const reply = (await call('edit_issue_comment', { commentId: COMMENT_ID, body })).result;
  assert.equal(reply.isError, false);
  assert.equal(reply.structuredContent.result.comment.commentId, COMMENT_ID);
  assert.equal(reply.structuredContent.result.comment.body, body);
  assert.equal(commands.length, 4);
  assert.deepEqual(commands[2].args, ['issue', 'view', '7', '--repo', `github.com/${REPO}`, '--json', 'number,url']);
  assert.deepEqual(commands[3], { args: ['api', '--hostname', 'github.com', '--method', 'PATCH', '--header', 'Accept: application/vnd.github+json',
    `repos/${REPO}/issues/comments/${COMMENT_ID}`, '--header', 'Content-Type: application/json', '--input', '-'], input: JSON.stringify({ body }) });
  assert.equal(commands.some((entry) => entry.args.includes('--edit-last')), false);
});

test('comment_issue returns the created comment ID and body without a second write', async () => {
  const body = '新しいコメント\n改行';
  const { call, commands } = await fixture([], (args) => {
    if (args[0] === 'repo') return publicRepo();
    if (args[1] === 'view') return json(issue());
    return { stdout: `https://github.com/${REPO}/issues/7#issuecomment-${COMMENT_ID}\n`, stderr: '', exitCode: 0 };
  });
  const reply = (await call('comment_issue', { issueNumber: 7, body })).result;
  assert.equal(reply.isError, false);
  assert.equal(reply.structuredContent.result.commentId, COMMENT_ID);
  assert.equal(reply.structuredContent.result.comment.body, body);
  assert.equal(reply.structuredContent.result.lookupRequired, false);
  assert.equal(commands.length, 3);
  assert.equal(commands.filter((entry) => entry.args[1] === 'comment').length, 1);
  const unrecognized = await fixture();
  const unknown = (await unrecognized.call('comment_issue', { issueNumber: 7, body })).result;
  assert.equal(unknown.isError, false);
  assert.equal(unknown.structuredContent.result.posted, true);
  assert.equal(unknown.structuredContent.result.lookupRequired, true);
  assert.equal(unknown.structuredContent.result.commentId, null);
  assert.match(unknown.structuredContent.result.lookupMessage, /do not repost/);
  assert.equal(unrecognized.commands.length, 3);
});

test('comment tools reject invalid IDs and arbitrary endpoint/method/script inputs before execution', async () => {
  const { call, commands } = await fixture();
  for (const id of [0, -1, 1.5, '3653399145', 'IC_node_id', Number.MAX_SAFE_INTEGER + 1]) {
    for (const name of ['view_issue_comment', 'edit_issue_comment']) {
      assert.equal((await call(name, { commentId: id, ...(name === 'edit_issue_comment' ? { body: 'a' } : {}) })).result.isError, true);
    }
  }
  for (const args of [
    { commentId: COMMENT_ID, body: 'a', endpoint: '/user' }, { commentId: COMMENT_ID, body: 'a', method: 'DELETE' },
    { commentId: COMMENT_ID, body: 'a', script: 'anything' }, { commentId: COMMENT_ID, body: '\ud800' },
    { commentId: COMMENT_ID, body: ' ' }
  ]) assert.equal((await call('edit_issue_comment', args)).result.isError, true);
  for (const args of [{ issueNumber: 7, page: 0 }, { issueNumber: 7, perPage: 101 }, { issueNumber: 7, perPage: '--paginate' }]) {
    assert.equal((await call('list_issue_comments', args)).result.isError, true);
  }
  assert.equal(commands.length, 0);
});

test('comment edits refuse wrong repository, wrong ID, and PR comments before PATCH', async () => {
  for (const value of [
    { ...apiComment(), id: COMMENT_ID + 1 },
    { ...apiComment(), issue_url: 'https://api.github.com/repos/other/repo/issues/7' },
    { ...apiComment(), html_url: `https://github.com/${REPO}/pull/7#issuecomment-${COMMENT_ID}` },
    { ...apiComment(), url: `https://api.github.com/repos/${REPO}/pulls/comments/${COMMENT_ID}` }
  ]) {
    const { call, commands } = await fixture([], (args) => args[0] === 'repo' ? publicRepo() : json(value));
    assert.equal((await call('edit_issue_comment', { commentId: COMMENT_ID, body: 'a' })).result.isError, true);
    assert.equal(commands.some((entry) => entry.args.includes('PATCH')), false);
  }
  const pr = await fixture([], (args) => args[0] === 'repo' ? publicRepo()
    : args[0] === 'api' ? json(apiComment()) : json({ number: 7, url: `https://github.com/${REPO}/pull/7` }));
  assert.equal((await pr.call('edit_issue_comment', { commentId: COMMENT_ID, body: 'a' })).result.isError, true);
  assert.equal(pr.commands.length, 3);
  const privateRepo = await fixture([], () => json({ visibility: 'PRIVATE' }));
  assert.equal((await privateRepo.call('edit_issue_comment', { commentId: COMMENT_ID, body: 'a' })).result.isError, true);
  assert.equal(privateRepo.commands.length, 1);
});

test('comment lookup and PATCH failures preserve the exact GitHub error and exitCode without retries', async () => {
  for (const method of ['GET', 'PATCH']) {
    const stderr = `HTTP 403: Resource not accessible by personal access token (${method} comment)\n`;
    const { call, commands } = await fixture([], (args) => {
      if (args[0] === 'repo') return publicRepo();
      if (args[0] === 'issue') return json(issue());
      return args.includes(method) ? { stdout: 'request-id: 456\n', stderr, exitCode: 1 } : json(apiComment());
    });
    const reply = (await call('edit_issue_comment', { commentId: COMMENT_ID, body: 'a' })).result;
    assert.equal(reply.isError, true);
    assert.equal(reply.content[0].text, stderr);
    assert.equal(reply.structuredContent.error, stderr);
    assert.equal(reply.structuredContent.result.stderr, stderr);
    assert.equal(reply.structuredContent.result.stdout, 'request-id: 456\n');
    assert.equal(reply.structuredContent.result.exitCode, 1);
    assert.equal(commands.length, method === 'GET' ? 2 : 4);
  }
});

test('comment listing refuses entries belonging to another Issue', async () => {
  const { call } = await fixture([], (args) => args[0] === 'repo' ? publicRepo()
    : args[0] === 'issue' ? json(issue()) : json([{ ...apiComment(), issue_url: `https://api.github.com/repos/${REPO}/issues/8`,
      html_url: `https://github.com/${REPO}/issues/8#issuecomment-${COMMENT_ID}` }]));
  assert.equal((await call('list_issue_comments', { issueNumber: 7 })).result.isError, true);
});

test('optional allowlist works without restricting other public repos by default', async () => {
  const { server, call, commands } = await fixture([`--repository=${REPO}`]);
  const result = await server(request(2, 'tools/call', { name: 'list_issues', arguments: {} }));
  assert.equal(result.result.isError, false);
  const count = commands.length;
  assert.equal((await call('list_issues', { repository: 'another/repo' })).result.isError, true);
  assert.equal(commands.length, count);
  const tools = (await server(request(3, 'tools/list'))).result.tools;
  assert.deepEqual(tools[0].inputSchema.properties.repository.enum, [REPO]);
  const multi = await fixture([`--repository=${REPO}`, '--repository=a/b']);
  assert.equal((await multi.server(request(2, 'tools/call', { name: 'list_issues', arguments: {} }))).result.isError, true);
  assert.equal(multi.commands.length, 0);
});

test('private/internal repos, unexpected redirects, and malformed preflight JSON fail closed', async () => {
  for (const info of [
    { visibility: 'PRIVATE', nameWithOwner: REPO },
    { visibility: 'INTERNAL', nameWithOwner: REPO },
    { isPrivate: false, nameWithOwner: REPO },
    { visibility: 'PUBLIC', nameWithOwner: 'other/redirect', url: 'https://github.com/other/redirect' },
    { visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://enterprise.invalid/${REPO}` }
  ]) {
    const { call, commands } = await fixture([], () => json(info));
    assert.equal((await call('create_issue', { title: 'a', body: 'b' })).result.isError, true);
    assert.equal(commands.length, 1);
  }
  const malformed = await fixture([], () => ({ stdout: 'not-json', exitCode: 0 }));
  assert.equal((await malformed.call('list_issues')).result.isError, true);
  assert.equal(malformed.commands.length, 1);
});

test('comment and close cannot mutate PRs or transferred issues', async () => {
  for (const name of ['comment_issue', 'close_issue']) {
    for (const url of [`https://github.com/${REPO}/pull/7`, 'https://github.com/other/repo/issues/7']) {
      const { call, commands } = await fixture([], (args) => args[0] === 'repo'
        ? json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` }) : json({ number: 7, url }));
      const args = name === 'comment_issue' ? { issueNumber: 7, body: 'a' } : { issueNumber: 7 };
      assert.equal((await call(name, args)).result.isError, true);
      assert.equal(commands.length, 2);
    }
  }
});

test('invalid tool arguments and unexposed commands are rejected before any gh process', async () => {
  const { call, commands } = await fixture();
  for (const [name, args] of [
    ['create_issue', { title: 'x', body: 'b', token: TOKEN }],
    ['create_issue', { title: 'x\ny', body: 'b' }],
    ['create_issue', { title: ' ', body: 'b' }],
    ['create_issue', { title: 'x', body: '\ud800' }],
    ['comment_issue', { issueNumber: 7, body: ' ' }],
    ['view_issue', { issueNumber: '--help' }],
    ['view_issue', { issueNumber: 'https://github.com/a/b/issues/7' }],
    ['view_issue', { issueNumber: -1 }],
    ['view_issue', { issueNumber: 7, comments: 'yes' }],
    ['list_issues', { state: '--web' }],
    ['list_issues', { limit: 101 }],
    ['list_issues', { root: '/tmp' }],
    ['list_issues', { command: 'node' }],
    ['list_issues', { executable: 'node' }],
    ['list_issues', { script: 'anything.mjs' }],
    ['list_issues', { env: { NODE_OPTIONS: '--import=anything.mjs' } }],
    ['list_issues', { repository: 'enterprise.invalid/a/b' }],
    ['close_issue', { issueNumber: 7, reason: 'reopen' }],
    ['edit_issue', { issueNumber: 7 }],
    ['run', { command: 'anything' }]
  ]) assert.equal((await call(name, args)).result.isError, true, name);
  assert.equal(commands.length, 0);
});

test('read outputs are structured and validate Issue repository identity', async () => {
  const { call } = await fixture();
  assert.deepEqual((await call('view_issue', { issueNumber: 7 })).result.structuredContent.result.issue, issue());
  assert.deepEqual((await call('list_issues')).result.structuredContent.result.issues, [issue()]);
  const badList = await fixture([], (args) => args[0] === 'repo'
    ? json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` }) : json([{ number: 7, url: `https://github.com/${REPO}/pull/7` }]));
  assert.equal((await badList.call('list_issues')).result.isError, true);
});

test('write errors and nested output redact the startup token without retrying', async () => {
  const failed = await fixture([], () => { throw new Error(`authentication failed: ${TOKEN}`); });
  const result = await failed.call('create_issue', { title: 'a', body: 'b' });
  assert.equal(result.result.isError, true);
  assert.ok(JSON.stringify(result).includes('[REDACTED]'));
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(failed.commands.length, 1);
  const tokenWithQuotes = 'secret"with\\quotes';
  const quotedTokenFile = join(tokenDirectory, 'quoted.txt');
  await writeFile(quotedTokenFile, tokenWithQuotes, 'utf8');
  const server = createServer({ argv: [`--token-file=${quotedTokenFile}`, `--gh-executable=${GH_EXECUTABLE}`], execute: async (args) => args[0] === 'repo'
    ? json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` }) : json({ ...issue(), body: tokenWithQuotes }) });
  await server(request(1, 'initialize'));
  const view = await server(request(2, 'tools/call', { name: 'view_issue', arguments: { repository: REPO, issueNumber: 7 } }));
  assert.equal(view.result.structuredContent.result.issue.body, '[REDACTED]');
});

test('Gateway signature is required when enabled and selects the isolated cwd', async () => {
  const key = 'k'.repeat(64);
  const isolation = createBundledIsolation({ key });
  const context = { isolatedId: 'issue-task', base: resolve('.'), roots: [resolve('.')] };
  const envelope = { ...context, version: 1, signature: signBundledIsolationContext(key, context) };
  let seen;
  const server = createServer({ argv: startup(), isolation, execute: async (args) => {
    seen = isolation.current();
    return args[0] === 'repo' ? json({ visibility: 'PUBLIC', nameWithOwner: REPO, url: `https://github.com/${REPO}` }) : json([]);
  } });
  await server(request(1, 'initialize'));
  const call = (args) => server(request(2, 'tools/call', { name: 'list_issues', arguments: args }));
  assert.equal((await call({ repository: REPO })).result.isError, true);
  assert.equal(seen, undefined);
  assert.equal((await call({ repository: REPO, __localMcpIsolation: envelope })).result.isError, false);
  assert.deepEqual(seen, context);
  assert.equal((await call({ repository: REPO, __localMcpIsolation: { ...envelope, signature: '0'.repeat(64) } })).result.isError, true);
});

function fakeProcess(callback) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
    queueMicrotask(() => callback(child, executable, args, options));
    return child;
  };
}

test('gh executor uses shell=false, exact UTF-8 stdin, isolated cwd, and sanitized credentials', async () => {
  const config = parseStartupArguments(startup());
  const body = '日本語\n$(literal)\n';
  const previous = { GH_DEBUG: process.env.GH_DEBUG, GH_HOST: process.env.GH_HOST, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  Object.assign(process.env, { GH_DEBUG: 'api', GH_HOST: 'evil.invalid', GITHUB_TOKEN: 'wrong-token' });
  try {
    const execute = createGhExecutor(config, { spawnProcess: fakeProcess((child, executable, args, options) => {
      assert.equal(executable, canonicalGhExecutable);
      assert.equal(options.shell, false);
      assert.equal(options.cwd, resolve('.'));
      assert.equal(options.env.GH_TOKEN, TOKEN);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env.GH_DEBUG, undefined);
      assert.equal(options.env.GH_HOST, 'github.com');
      assert.equal(options.env.LOCAL_MCP_GATEWAY_ISOLATION_KEY, undefined);
      assert.equal(child.stdin.read().toString('utf8'), body);
      child.stdout.write(`ok ${TOKEN}`);
      child.emit('close', 0, null);
    }) });
    assert.equal((await execute(['issue', 'comment'], body)).stdout, 'ok [REDACTED]');
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('gh executor bounds output/time and reports start or command failures without secrets', async () => {
  const config = parseStartupArguments(startup());
  const tooBig = createGhExecutor(config, { maxOutputBytes: 4, spawnProcess: fakeProcess((child) => child.stdout.write('12345')) });
  await assert.rejects(tooBig(['issue', 'list']), /size limit/);
  const slow = createGhExecutor(config, { timeoutMs: 5, spawnProcess: fakeProcess(() => {}) });
  await assert.rejects(slow(['issue', 'create']), /timed out/);
  const missing = createGhExecutor(config, { spawnProcess: () => { throw new Error(`ENOENT ${TOKEN}`); } });
  await assert.rejects(missing(['issue', 'list']), (error) => error.message.includes('[REDACTED]') && !error.message.includes(TOKEN));
  const failed = createGhExecutor(config, { spawnProcess: fakeProcess((child) => { child.stderr.write(`401 ${TOKEN}`); child.emit('close', 1); }) });
  await assert.rejects(failed(['issue', 'list']), /401 \[REDACTED\]/);
});

test('server refuses non-online modes and executable paths inside a writable root', async () => {
  const previousMode = process.env.LOCAL_MCP_CODEX_SANDBOX_MODE;
  try {
    for (const mode of ['never', 'elevated', 'unelevated', undefined]) {
      if (mode === undefined) delete process.env.LOCAL_MCP_CODEX_SANDBOX_MODE;
      else process.env.LOCAL_MCP_CODEX_SANDBOX_MODE = mode;
      assert.throws(() => createServer({ argv: startup(), execute: async () => json([]) }), /requires the onlineworkspace/);
    }
  } finally { process.env.LOCAL_MCP_CODEX_SANDBOX_MODE = previousMode; }
  let executions = 0;
  const execute = createGhExecutor(parseStartupArguments(startup()), {
    isolation: { current: () => ({ base: ghDirectory, roots: [ghDirectory] }) },
    spawnProcess: () => { executions += 1; }
  });
  await assert.rejects(execute(['issue', 'list']), /outside writable workspace roots/);
  assert.equal(executions, 0);
});

test('stdio handles fragmented JSON, parse failures, notifications, and ordered requests', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const stdio = startStdio(input, output, { argv: startup() });
  input.write('{bad}\n{"jsonrpc":"2.0","id":1,"method":"initial');
  input.write('ize"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.write(`${JSON.stringify(request(2, 'tools/list'))}\n`);
  await stdio.settled();
  const replies = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies.length, 3);
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].result.serverInfo.name, 'gh-issue');
  assert.equal(replies[2].result.tools.length, 9);
  assert.equal(text.includes(TOKEN), false);
  input.write(`${'x'.repeat(1024 * 1024 + 1)}`);
  input.write(`tail\n${JSON.stringify(request(3, 'ping'))}\n`);
  await stdio.settled();
  assert.equal(JSON.parse(text.trim().split('\n').at(-1)).id, 3);
});

test('stdio accepts configured 1MiB bodies with overhead and worst-case JSON escaping', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  const bodies = [];
  output.on('data', (chunk) => { text += chunk; });
  const stdio = startStdio(input, output, { argv: startup(['--max-body=1M']), execute: async (args, body) => {
    if (args[0] === 'repo') return publicRepo();
    bodies.push(body);
    return { stdout: `https://github.com/${REPO}/issues/7\n`, stderr: '', exitCode: 0 };
  } });
  input.write(`${JSON.stringify(request(1, 'initialize'))}\n`);
  const expected = ['a'.repeat(1048576), '\u0001'.repeat(1048576)];
  for (const [index, body] of expected.entries()) {
    const line = `${JSON.stringify(request(index + 2, 'tools/call', { name: 'create_issue', arguments: { repository: REPO, title: 'title', body } }))}\n`;
    input.write(line.slice(0, 1048577));
    input.write(line.slice(1048577));
  }
  await stdio.settled();
  assert.deepEqual(bodies, expected);
  const replies = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies.length, 3);
  for (const reply of replies.slice(1)) assert.equal(reply.result.isError, false);
});

test('Gateway enforces onlineworkspace, fixes gh as a read-only trust input, and disables example by default', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gh-issue-config-'));
  const path = join(directory, 'gateway.toml');
  const entry = {
    command: process.execPath, args: [resolve('mcp/gh-issue/server.mjs'), ...startup()], cwd: resolve('.'),
    prefix: 'gh_issue', sandbox: 'onlineworkspace', codex_executable: join(tmpdir(), 'gh-issue-codex.cmd'),
    annotation_config: false, allowed_directories: [resolve('.')]
  };
  await writeFile(path, `private_use_only = true\n[mcp_servers.gh_issue]\n${Object.entries(entry).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`, 'utf8');
  const config = await loadGatewayConfig(path);
  assert.equal(config.servers[0].isBundled, true);
  assert.equal(config.servers[0].sandbox, 'onlineworkspace');
  assert.deepEqual(config.servers[0].sandboxReadOnlyFiles, [GH_EXECUTABLE, TOKEN_FILE]);
  const missingAuthArgs = entry.args.filter((argument) => !argument.startsWith('--token-file='));
  await writeFile(path, `private_use_only = true\n[mcp_servers.gh_issue]\n${Object.entries({ ...entry, args: missingAuthArgs }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`, 'utf8');
  await assert.rejects(loadGatewayConfig(path), /requires --token-file/);
  for (const args of [[...missingAuthArgs, `--token=${TOKEN}`], [...entry.args, `--token=${TOKEN}`]]) {
    await writeFile(path, `private_use_only = true\n[mcp_servers.gh_issue]\n${Object.entries({ ...entry, args }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`, 'utf8');
    assert.equal((await loadGatewayConfig(path)).servers[0].sandbox, 'onlineworkspace');
  }
  for (const sandbox of ['never', 'elevated', 'unelevated']) {
    await writeFile(path, `private_use_only = true\n[mcp_servers.gh_issue]\n${Object.entries({ ...entry, sandbox }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`, 'utf8');
    await assert.rejects(loadGatewayConfig(path), /must be onlineworkspace for gh-issue/);
  }
  await writeFile(path, `private_use_only = true\n[mcp_servers.gh_issue]\n${Object.entries({ ...entry, allowed_directories: [resolve('.'), ghDirectory] }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`, 'utf8');
  await assert.rejects(loadGatewayConfig(path), /outside allowed_directories/);
  await writeFile(path, `private_use_only = true\n[mcp_servers.gh_issue]\n${Object.entries({ ...entry, allowed_directories: [resolve('.'), tokenDirectory] }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`, 'utf8');
  await assert.rejects(loadGatewayConfig(path), /fixed trust files must be outside allowed_directories/);
  const example = parseToml(await readFile(new URL('../config/gateway.gh-issue.example.toml', import.meta.url), 'utf8'));
  assert.equal(example.mcp_servers.gh_issue.enabled, false);
  assert.equal(example.mcp_servers.gh_issue.sandbox, 'onlineworkspace');
  assert.ok(example.mcp_servers.gh_issue.args.some((argument) => argument.startsWith('--token-file=')));
  assert.equal(example.mcp_servers.gh_issue.args.some((argument) => argument.startsWith('--token=')), false);
  assert.ok(example.mcp_servers.gh_issue.args.includes('--max-body=10K'));
});

test('actual stdio process discovers nine tools with a simulated sandbox marker and no network', async () => {
  const child = spawn(process.execPath, ['mcp/gh-issue/server.mjs', ...startup()], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  const exited = new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code));
  });
  child.stdin.end(`${JSON.stringify(request(1, 'initialize'))}\n${JSON.stringify(request(2, 'tools/list'))}\n`);
  assert.equal(await exited, 0, errors);
  const replies = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies[0].result.serverInfo.name, 'gh-issue');
  assert.equal(replies[1].result.tools.length, 9);
  assert.equal(output.includes(TOKEN), false);
});
