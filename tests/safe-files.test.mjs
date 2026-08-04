import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function serverFor(root, suffix, options = {}) {
  process.env.SAFE_FILES_ROOTS = JSON.stringify([root]);
  process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES = JSON.stringify(options.disallowedDirectories ?? []);
  process.env.LOCAL_MCP_DISALLOWED_FILES = JSON.stringify(options.disallowedFiles ?? []);
  process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = JSON.stringify(options.disallowedPathGlobs ?? []);
  const { createServer } = await import(`../mcp/safe-files/server.mjs?test=${suffix}-${Date.now()}`);
  const server = createServer();
  await server(request(1, 'initialize', {}));
  return server;
}

async function createSymlinkOrSkip(t, target, path) {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`Symbolic links are unavailable in this Windows environment: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('safe-files exposes only bounded UTF-8 and patch tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  const server = await serverFor(root, 'surface');
  const listed = await server(request(2, 'tools/list', {}));
  const names = listed.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'apply_patch', 'create_directory', 'file_info', 'get_working_directory', 'list_directory',
    'list_files', 'read_file_chunk', 'read_text_file', 'read_text_lines', 'replace_text', 'roots', 'search_text',
    'set_working_directory', 'write_file', 'write_text_file'
  ]);
  assert.ok(listed.result.tools.every((tool) => tool.outputSchema?.type === 'object'));
  const expectedAnnotationKeys = ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'];
  for (const tool of listed.result.tools) {
    assert.deepEqual(Object.keys(tool.annotations).sort(), expectedAnnotationKeys, `${tool.name} should expose all tool hints`);
    assert.equal(tool.annotations.openWorldHint, false, `${tool.name} should remain inside the configured local workspace`);
  }
  const expectAnnotations = (toolNames, expected) => {
    for (const name of toolNames) {
      const tool = listed.result.tools.find((candidate) => candidate.name === name);
      assert.deepEqual(tool.annotations, expected, `${name} annotations`);
    }
  };
  expectAnnotations([
    'roots', 'get_working_directory', 'list_directory', 'list_files', 'search_text',
    'read_text_file', 'read_text_lines', 'file_info', 'read_file_chunk'
  ], { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  expectAnnotations([
    'set_working_directory', 'create_directory'
  ], { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  expectAnnotations([
    'write_file', 'write_text_file'
  ], { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
  expectAnnotations([
    'replace_text', 'apply_patch'
  ], { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
  assert.ok(!names.some((name) => ['execute', 'shell', 'start_command', 'without_sandbox'].includes(name)));
  const applyPatch = listed.result.tools.find((tool) => tool.name === 'apply_patch');
  assert.match(applyPatch.description, /workspace-relative/);
  assert.match(applyPatch.inputSchema.properties.patch.description, /Do not use absolute paths/);
  await writeFile(join(root, 'utf16.txt'), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  const result = await server(request(3, 'tools/call', { name: 'read_text_file', arguments: { path: 'utf16.txt' } }));
  assert.equal(result.result.isError, true);
  assert.match(result.result.structuredContent.error, /UTF-16/);
});

test('read_text_lines returns an inclusive range, clamps the end line, and rejects an impossible start line precisely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-lines-'));
  const path = join(root, 'lines.txt');
  await writeFile(path, 'first\r\nsecond\nthird\n', 'utf8');
  await writeFile(join(root, 'empty.txt'), '', 'utf8');
  const server = await serverFor(root, 'read-lines');

  const clamped = await server(request(2, 'tools/call', {
    name: 'read_text_lines', arguments: { path: 'lines.txt', startLine: 2, endLine: 999 }
  }));
  assert.equal(clamped.result.isError, false);
  assert.deepEqual(clamped.result.structuredContent.result, {
    path,
    startLine: 2,
    endLine: 3,
    requestedEndLine: 999,
    lineCount: 3,
    content: 'second\nthird'
  });

  const impossible = await server(request(3, 'tools/call', {
    name: 'read_text_lines', arguments: { path: 'lines.txt', startLine: 4, endLine: 8 }
  }));
  assert.equal(impossible.result.isError, true);
  assert.equal(
    impossible.result.structuredContent.error,
    `Start line is out of range for ${path}: got 4, expected a maximum of 3`
  );

  const empty = await server(request(4, 'tools/call', {
    name: 'read_text_lines', arguments: { path: 'empty.txt', startLine: 1, endLine: 1 }
  }));
  assert.equal(empty.result.isError, true);
  assert.equal(
    empty.result.structuredContent.error,
    `Start line is out of range for ${join(root, 'empty.txt')}: got 1, expected a maximum of 0`
  );

  const fakeRuntimeKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
  await writeFile(join(root, 'credential.txt'), `safe\n${fakeRuntimeKey}\n`, 'utf8');
  const credential = await server(request(5, 'tools/call', {
    name: 'read_text_lines', arguments: { path: 'credential.txt', startLine: 1, endLine: 1 }
  }));
  assert.equal(credential.result.isError, true);
  assert.match(credential.result.structuredContent.error, /credential/i);
});

test('file_info batches paths and reports type, bytes, line availability, censorship, prohibition, and binary likelihood without returning content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-info-'));
  const textPath = join(root, 'text.txt');
  const binaryPath = join(root, 'binary.bin');
  const credentialPath = join(root, 'credential.txt');
  const prohibitedPath = join(root, 'blocked.pem');
  const deniedPath = join(root, 'denied.txt');
  const utf16Path = join(root, 'utf16.txt');
  const fakeRuntimeKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
  await mkdir(join(root, 'directory'));
  await writeFile(textPath, 'alpha\nbeta\n', 'utf8');
  await writeFile(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0xff]));
  await writeFile(credentialPath, fakeRuntimeKey, 'utf8');
  await writeFile(prohibitedPath, 'public certificate placeholder', 'utf8');
  await writeFile(deniedPath, 'denied metadata only', 'utf8');
  await writeFile(utf16Path, Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  const server = await serverFor(root, 'file-info', { disallowedFiles: [deniedPath] });

  const batch = await server(request(2, 'tools/call', {
    name: 'file_info',
    arguments: {
      paths: [
        'text.txt', 'binary.bin', 'credential.txt', 'blocked.pem',
        'denied.txt', 'directory', 'utf16.txt', 'missing.txt'
      ]
    }
  }));
  assert.equal(batch.result.isError, false);
  assert.equal(batch.result.structuredContent.result.count, 8);
  const items = Object.fromEntries(batch.result.structuredContent.result.items.map((item) => [item.requestedPath, item]));

  const text = items['text.txt'];
  assert.equal(text.ok, true);
  assert.equal(text.type, 'file');
  assert.equal(text.bytes, Buffer.byteLength('alpha\nbeta\n'));
  assert.equal(text.hasLineCount, true);
  assert.equal(text.lineCount, 2);
  assert.equal(text.censored, false);
  assert.equal(text.prohibited, false);
  assert.equal(text.binaryLikely, false);
  assert.equal(text.textEncoding, 'utf-8');
  assert.equal('content' in text, false);

  const binary = items['binary.bin'];
  assert.equal(binary.ok, true);
  assert.equal(binary.binaryLikely, true);
  assert.equal(binary.binaryReason, 'nul_byte');
  assert.equal(binary.hasLineCount, false);
  assert.equal(binary.lineCount, null);

  const credential = items['credential.txt'];
  assert.equal(credential.ok, true);
  assert.equal(credential.censored, true);
  assert.equal(credential.hasLineCount, true);
  assert.equal(credential.lineCount, 1);

  const prohibited = items['blocked.pem'];
  assert.equal(prohibited.ok, true);
  assert.equal(prohibited.prohibited, true);
  assert.ok(prohibited.prohibitedReasons.includes('blocked_transfer_extension:.pem'));

  const denied = items['denied.txt'];
  assert.equal(denied.ok, true);
  assert.equal(denied.prohibited, true);
  assert.ok(denied.prohibitedReasons.includes('disallowed_files'));
  const deniedRead = await server(request(3, 'tools/call', { name: 'read_text_file', arguments: { path: 'denied.txt' } }));
  assert.equal(deniedRead.result.isError, true);

  const directory = items.directory;
  assert.equal(directory.ok, true);
  assert.equal(directory.type, 'directory');
  assert.equal(directory.hasLineCount, false);
  assert.equal(directory.binaryChecked, 'not_applicable');
  assert.equal(typeof directory.bytes, 'number');

  const utf16 = items['utf16.txt'];
  assert.equal(utf16.ok, true);
  assert.equal(utf16.binaryLikely, false);
  assert.equal(utf16.textEncoding, 'utf-16-le');
  assert.equal(utf16.hasLineCount, false);

  const missing = items['missing.txt'];
  assert.equal(missing.ok, false);
  assert.match(missing.error, /ENOENT/);
});

test('list_files uses fixed ripgrep listing, honors ignore files, and excludes exact files or directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-list-'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'ignored-directory'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'src', 'omit'));
  await writeFile(join(root, '.gitignore'), 'ignored.txt\nignored-directory/\n', 'utf8');
  await writeFile(join(root, '.hidden.txt'), 'hidden', 'utf8');
  await writeFile(join(root, '.git', 'config'), 'git-internal', 'utf8');
  await writeFile(join(root, 'ignored.txt'), 'ignored', 'utf8');
  await writeFile(join(root, 'ignored-directory', 'ignored.js'), 'ignored', 'utf8');
  await writeFile(join(root, 'src', 'a.js'), 'a', 'utf8');
  await writeFile(join(root, 'src', 'b.txt'), 'b', 'utf8');
  await writeFile(join(root, 'src', 'omit', 'skip.js'), 'skip', 'utf8');
  await writeFile(join(root, 'src', 'omit-file.js'), 'skip', 'utf8');
  await writeFile(join(root, 'src', 'space ; name.js'), 'safe', 'utf8');
  const server = await serverFor(root, 'list-files');

  const defaultList = await server(request(2, 'tools/call', {
    name: 'list_files', arguments: { path: '.', maxResults: 100 }
  }));
  assert.equal(defaultList.result.isError, false);
  const defaultRelative = defaultList.result.structuredContent.result.files.map((file) => file.relativePath);
  assert.ok(defaultRelative.includes('.hidden.txt'));
  assert.ok(defaultRelative.includes('src/a.js'));
  assert.ok(!defaultRelative.includes('ignored.txt'));
  assert.ok(!defaultRelative.some((path) => path.startsWith('ignored-directory/')));
  assert.ok(!defaultRelative.some((path) => path.startsWith('.git/')));
  assert.deepEqual(defaultRelative, [...defaultRelative].sort((a, b) => a.localeCompare(b)));

  const filtered = await server(request(3, 'tools/call', {
    name: 'list_files',
    arguments: {
      path: '.',
      includeIgnored: true,
      globs: ['**/*.js'],
      excludePaths: ['ignored-directory', 'src/omit', 'src/omit-file.js'],
      maxResults: 100
    }
  }));
  assert.equal(filtered.result.isError, false);
  assert.deepEqual(filtered.result.structuredContent.result.files.map((file) => file.relativePath), [
    'src/a.js',
    'src/space ; name.js'
  ]);

  const truncated = await server(request(4, 'tools/call', {
    name: 'list_files', arguments: { path: 'src', maxResults: 1 }
  }));
  assert.equal(truncated.result.isError, false);
  assert.equal(truncated.result.structuredContent.result.count, 1);
  assert.equal(truncated.result.structuredContent.result.truncated, true);
});

test('list_files rejects option and scope injection while treating shell metacharacters as literal path data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-injection-'));
  const literalDirectories = ['--aaa', 'semi;name', 'amp&name', 'dollar$(name)', 'back`tick'];
  if (process.platform !== 'win32') literalDirectories.push('pipe|name');
  for (const directory of literalDirectories) {
    await mkdir(join(root, directory));
    await writeFile(join(root, directory, 'inside.txt'), directory, 'utf8');
  }
  const server = await serverFor(root, 'list-injection');
  let id = 2;
  for (const directory of literalDirectories) {
    const listed = await server(request(id++, 'tools/call', {
      name: 'list_files', arguments: { path: directory }
    }));
    assert.equal(listed.result.isError, false, directory);
    assert.deepEqual(listed.result.structuredContent.result.files.map((file) => file.relativePath), ['inside.txt']);
  }
  await assert.rejects(access(join(root, 'injected')));

  for (const glob of ['--no-ignore', '../../*', '/tmp/**', 'C:/outside/**', 'foo\n--no-ignore', 'foo\0bar']) {
    const refused = await server(request(id++, 'tools/call', {
      name: 'list_files', arguments: { path: '.', globs: [glob] }
    }));
    assert.equal(refused.result.isError, true, glob);
  }
  for (const path of ['missing;touch injected', 'foo\n--no-ignore', 'foo\0bar']) {
    const refused = await server(request(id++, 'tools/call', {
      name: 'list_files', arguments: { path }
    }));
    assert.equal(refused.result.isError, true, path);
  }
  const outsideExclude = await server(request(id++, 'tools/call', {
    name: 'list_files', arguments: { path: '.', excludePaths: ['../outside'] }
  }));
  assert.equal(outsideExclude.result.isError, true);
  await assert.rejects(access(join(root, 'injected')));
});

test('safe-files rejects direct access and listings when a configured path glob matches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-glob-'));
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'id_ed25519.txt'), 'dummy', 'utf8');
  await writeFile(join(root, 'ordinary.txt'), 'safe', 'utf8');
  const server = await serverFor(root, 'path-glob', { disallowedPathGlobs: ['**.ssh**'] });

  const direct = await server(request(2, 'tools/call', {
    name: 'read_text_file', arguments: { path: '.ssh/id_ed25519.txt' }
  }));
  assert.equal(direct.result.isError, true);
  assert.match(direct.result.structuredContent.error, /glob filter disallowed_path_globs/);
  assert.match(direct.result.structuredContent.error, /\*\*\.ssh\*\*/);
  assert.match(direct.result.structuredContent.error, /\.ssh/);

  const info = await server(request(3, 'tools/call', {
    name: 'file_info', arguments: { paths: ['.ssh/id_ed25519.txt'] }
  }));
  assert.equal(info.result.isError, false);
  assert.equal(info.result.structuredContent.result.items[0].ok, true);
  assert.equal(info.result.structuredContent.result.items[0].prohibited, true);
  assert.ok(info.result.structuredContent.result.items[0].prohibitedReasons.includes('disallowed_path_globs:**.ssh**'));

  const directory = await server(request(4, 'tools/call', {
    name: 'list_directory', arguments: { path: '.' }
  }));
  assert.equal(directory.result.isError, true);
  assert.match(directory.result.structuredContent.error, /list_directory entry/);
  assert.match(directory.result.structuredContent.error, /\.ssh/);

  const recursive = await server(request(5, 'tools/call', {
    name: 'list_files', arguments: { path: '.', includeIgnored: true }
  }));
  assert.equal(recursive.result.isError, true);
  assert.match(recursive.result.structuredContent.error, /list_files entry/);
  assert.match(recursive.result.structuredContent.error, /\.ssh/);
});

test('ripgrep search and file transfer stay inside an explicitly configured workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.txt'), 'alpha\nbeta\n', 'utf8');
  const server = await serverFor(root, 'search-transfer');
  const searched = await server(request(2, 'tools/call', { name: 'search_text', arguments: { query: 'beta', path: 'src', fixedStrings: true } }));
  assert.equal(searched.result.isError, false);
  assert.equal(searched.result.structuredContent.result.count, 1);
  assert.equal(searched.result.structuredContent.result.matches[0].line, 2);
  assert.match(searched.result.structuredContent.result.matches[0].text, /beta/);
  const transferred = await server(request(3, 'tools/call', { name: 'read_file_chunk', arguments: { path: 'src/a.txt', length: 5 } }));
  assert.equal(transferred.result.isError, false);
  assert.equal(Buffer.from(transferred.result.structuredContent.result.dataBase64, 'base64').toString('utf8'), 'alpha');
  const written = await server(request(4, 'tools/call', {
    name: 'write_file',
    arguments: { path: 'src/image.bin', dataBase64: Buffer.from([0, 1, 2, 3]).toString('base64') }
  }));
  assert.equal(written.result.isError, false);
  assert.deepEqual(await readFile(join(root, 'src', 'image.bin')), Buffer.from([0, 1, 2, 3]));
});

test('the explicit workspace is not name-blacklisted, while detected credential content is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  const fakeRuntimeKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'ordinary.txt'), 'public information', 'utf8');
  await writeFile(join(root, 'notes.txt'), fakeRuntimeKey, 'utf8');
  const server = await serverFor(root, 'credentials');
  const ordinary = await server(request(2, 'tools/call', { name: 'read_text_file', arguments: { path: '.ssh/ordinary.txt' } }));
  assert.equal(ordinary.result.isError, false);
  assert.equal(ordinary.result.structuredContent.result.content, 'public information');
  const contentRefused = await server(request(3, 'tools/call', { name: 'read_text_file', arguments: { path: 'notes.txt' } }));
  assert.equal(contentRefused.result.isError, true);
  assert.match(contentRefused.result.structuredContent.error, /credential/i);
  const outsideRefused = await server(request(4, 'tools/call', { name: 'search_text', arguments: { query: 'anything', path: join(tmpdir(), 'outside.txt') } }));
  assert.equal(outsideRefused.result.isError, true);
  assert.match(outsideRefused.result.structuredContent.error, /outside/);
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
  assert.equal((await readFile(join(root, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'new\n');
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

test('apply_patch explains that absolute patch paths must be workspace-relative', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-absolute-patch-'));
  const server = await serverFor(root, 'absolute-patch');
  const absolute = process.platform === 'win32' ? 'C:\\workspace\\a.txt' : '/workspace/a.txt';
  const patch = ['*** Begin Patch', `*** Add File: ${absolute}`, '+bad', '*** End Patch'].join('\n');
  const refused = await server(request(2, 'tools/call', { name: 'apply_patch', arguments: { patch } }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /workspace-relative path/);
  assert.match(refused.result.structuredContent.error, /absolute path/);
});

test('safe-files refuses symlink escape and performs exact replacement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'safe-files-outside-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.txt'), 'alpha alpha', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
  if (!await createSymlinkOrSkip(t, join(outside, 'secret.txt'), join(root, 'escape.txt'))) return;
  const server = await serverFor(root, 'symlink');
  const escaped = await server(request(2, 'tools/call', { name: 'read_text_file', arguments: { path: 'escape.txt' } }));
  assert.equal(escaped.result.isError, true);
  const replaced = await server(request(3, 'tools/call', { name: 'replace_text', arguments: { path: 'src/a.txt', oldText: 'alpha', newText: 'beta', expectedOccurrences: 2 } }));
  assert.equal(replaced.result.isError, false);
  assert.equal(await readFile(join(root, 'src', 'a.txt'), 'utf8'), 'beta beta');
});
