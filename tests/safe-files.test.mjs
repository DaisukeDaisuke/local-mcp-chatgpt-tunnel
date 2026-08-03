import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function serverFor(root, suffix) {
  process.env.SAFE_FILES_ROOTS = JSON.stringify([root]);
  const { createServer } = await import(`../mcp/safe-files/server.mjs?test=${suffix}-${Date.now()}`);
  const server = createServer();
  await server(request(1, 'initialize', {}));
  return server;
}

test('safe-files exposes only bounded UTF-8 and patch tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  const server = await serverFor(root, 'surface');
  const listed = await server(request(2, 'tools/list', {}));
  const names = listed.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'apply_patch', 'create_directory', 'get_working_directory', 'list_directory',
    'read_text_file', 'replace_text', 'roots', 'set_working_directory', 'write_text_file'
  ]);
  assert.ok(!names.some((name) => ['execute', 'shell', 'start_command', 'without_sandbox'].includes(name)));
  await writeFile(join(root, 'utf16.txt'), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  const result = await server(request(3, 'tools/call', { name: 'read_text_file', arguments: { path: 'utf16.txt' } }));
  assert.equal(result.result.isError, true);
  assert.match(result.result.structuredContent.error, /UTF-16/);
});

test('working directory changes relative path resolution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  await mkdir(join(root, 'project'));
  await writeFile(join(root, 'project', 'a.txt'), 'alpha', 'utf8');
  const server = await serverFor(root, 'cwd');
  const changed = await server(request(2, 'tools/call', { name: 'set_working_directory', arguments: { path: 'project' } }));
  assert.equal(changed.result.isError, false);
  const read = await server(request(3, 'tools/call', { name: 'read_text_file', arguments: { path: 'a.txt' } }));
  assert.equal(read.result.structuredContent.result.content, 'alpha');
});

test('structured apply_patch updates and adds UTF-8 files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  await writeFile(join(root, 'a.txt'), 'alpha\nomega\n', 'utf8');
  const server = await serverFor(root, 'structured');
  const patch = [
    '*** Begin Patch',
    '*** Update File: a.txt',
    '@@',
    '-alpha',
    '+beta',
    ' omega',
    '*** Add File: b.txt',
    '+created',
    '*** End Patch'
  ].join('\n');
  const dry = await server(request(2, 'tools/call', { name: 'apply_patch', arguments: { patch, dryRun: true } }));
  assert.equal(dry.result.isError, false);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'alpha\nomega\n');
  const applied = await server(request(3, 'tools/call', { name: 'apply_patch', arguments: { patch } }));
  assert.equal(applied.result.isError, false);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'beta\nomega\n');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'created\n');
});

test('unified apply_patch uses fixed git apply and blocks .git internals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  await writeFile(join(root, 'a.txt'), 'old\n', 'utf8');
  const server = await serverFor(root, 'unified');
  const patch = ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
  const applied = await server(request(2, 'tools/call', { name: 'apply_patch', arguments: { patch } }));
  assert.equal(applied.result.isError, false);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'new\n');
  const unsafe = ['diff --git a/.git/config b/.git/config', '--- a/.git/config', '+++ b/.git/config', '@@ -1 +1 @@', '-a', '+b', ''].join('\n');
  const refused = await server(request(3, 'tools/call', { name: 'apply_patch', arguments: { patch: unsafe } }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /\.git/);
  const structuredUnsafe = ['*** Begin Patch', '*** Add File: .git/config', '+bad', '*** End Patch'].join('\n');
  const structuredRefused = await server(request(4, 'tools/call', { name: 'apply_patch', arguments: { patch: structuredUnsafe } }));
  assert.equal(structuredRefused.result.isError, true);
  assert.match(structuredRefused.result.structuredContent.error, /\.git/);
  const symlinkPatch = ['diff --git a/link b/link', 'new file mode 120000', '--- /dev/null', '+++ b/link', '@@ -0,0 +1 @@', '+..\\outside', ''].join('\n');
  const symlinkRefused = await server(request(5, 'tools/call', { name: 'apply_patch', arguments: { patch: symlinkPatch } }));
  assert.equal(symlinkRefused.result.isError, true);
  assert.match(symlinkRefused.result.structuredContent.error, /Symlink/);
});

test('safe-files refuses symlink escape and performs exact replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'safe-files-outside-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.txt'), 'alpha alpha', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
  await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  const server = await serverFor(root, 'symlink');
  const escaped = await server(request(2, 'tools/call', { name: 'read_text_file', arguments: { path: 'escape.txt' } }));
  assert.equal(escaped.result.isError, true);
  const replaced = await server(request(3, 'tools/call', { name: 'replace_text', arguments: { path: 'src/a.txt', oldText: 'alpha', newText: 'beta', expectedOccurrences: 2 } }));
  assert.equal(replaced.result.isError, false);
  assert.equal(await readFile(join(root, 'src', 'a.txt'), 'utf8'), 'beta beta');
});