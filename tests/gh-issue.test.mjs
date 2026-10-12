import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createGhExecutor, createServer, createTokenReader, parseStartupArguments, startStdio } from '../mcp/gh-issue/server.mjs';
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
const startup = (extra = []) => [`--token-file=${TOKEN_FILE}`, `--gh-executable=${GH_EXECUTABLE}`, ...extra];
const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });
const json = (value) => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });
const issue = (number = 7) => ({ number, url: `https://github.com/${REPO}/issues/${number}`, title: '題名' });

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

test('startup token-file is mandatory, raw tokens are rejected, and errors do not echo secrets', () => {
  assert.throws(() => parseStartupArguments([]), /--token-file is required/);
  assert.throws(() => parseStartupArguments([`--token=${TOKEN}`]), (error) => error.message.includes('Unsupported') && !error.message.includes(TOKEN));
  assert.throws(() => parseStartupArguments(['--token', TOKEN]), (error) => !error.message.includes(TOKEN));
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

test('discovery exposes exactly the five operations with accurate annotations', async () => {
  const { server } = await fixture();
  const result = await server(request(3, 'tools/list'));
  const tools = result.result.tools;
  assert.deepEqual(tools.map((entry) => entry.name), ['create_issue', 'view_issue', 'list_issues', 'comment_issue', 'close_issue']);
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
  assert.equal(replies[2].result.tools.length, 5);
  assert.equal(text.includes(TOKEN), false);
  input.write(`${'x'.repeat(1024 * 1024 + 1)}`);
  input.write(`tail\n${JSON.stringify(request(3, 'ping'))}\n`);
  await stdio.settled();
  assert.equal(JSON.parse(text.trim().split('\n').at(-1)).id, 3);
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
  for (const args of [
    entry.args.filter((argument) => !argument.startsWith('--token-file=')),
    [...entry.args, `--token=${TOKEN}`]
  ]) {
    await writeFile(path, `private_use_only = true\n[mcp_servers.gh_issue]\n${Object.entries({ ...entry, args }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`, 'utf8');
    await assert.rejects(loadGatewayConfig(path), (error) => /requires --token-file|raw token arguments/.test(error.message) && !error.message.includes(TOKEN));
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
});

test('actual stdio process discovers five tools with a simulated sandbox marker and no network', async () => {
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
  assert.equal(replies[1].result.tools.length, 5);
  assert.equal(output.includes(TOKEN), false);
});
