import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { access, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function serverFor(root, suffix, limits = {}) {
  process.env.SAFE_DOWNLOAD_ROOTS = JSON.stringify([root]);
  process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = JSON.stringify(limits.disallowedPathGlobs ?? []);
  process.env.SAFE_DOWNLOAD_MAX_FILES = String(limits.maxFiles ?? 500);
  process.env.SAFE_DOWNLOAD_MAX_INPUT_BYTES = String(limits.maxInputBytes ?? 16 * 1024 * 1024);
  process.env.SAFE_DOWNLOAD_MAX_ZIP_BYTES = String(limits.maxZipBytes ?? 20 * 1024 * 1024);
  const { createServer } = await import(`../mcp/safe-download/server.mjs?test=${suffix}-${Date.now()}-${Math.random()}`);
  const server = createServer();
  await server(request(1, 'initialize', {}));
  return server;
}

function zipEntries(bytes) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    const flags = bytes.readUInt16LE(offset + 6);
    const method = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    assert.equal(flags & 0x0800, 0x0800);
    const nameStart = offset + 30;
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    assert.ok(content, `unsupported ZIP method ${method}`);
    assert.equal(content.length, uncompressedSize);
    entries.set(name, content);
    offset = dataStart + compressedSize;
  }
  return entries;
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

test('safe-download exposes only download_zip with a declared output schema', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-download-'));
  const server = await serverFor(root, 'surface');
  const listed = await server(request(2, 'tools/list', {}));
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['download_zip']);
  assert.equal(listed.result.tools[0].outputSchema?.type, 'object');
  assert.deepEqual(listed.result.tools[0].annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
});

test('download_zip returns one JS file as a ZIP resource without duplicating base64 in structuredContent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-download-'));
  await writeFile(join(root, 'server.mjs'), 'export const value = 1;\n', 'utf8');
  const server = await serverFor(root, 'single');
  const downloaded = await server(request(2, 'tools/call', {
    name: 'download_zip', arguments: { path: 'server.mjs', archiveName: 'server-source.zip' }
  }));
  assert.equal(downloaded.result.isError, false);
  const metadata = downloaded.result.structuredContent.result;
  assert.equal(metadata.name, 'server-source.zip');
  assert.equal(metadata.mimeType, 'application/zip');
  assert.equal(metadata.files, 1);
  assert.equal(Object.hasOwn(metadata, 'blob'), false);
  const resource = downloaded.result.content.find((part) => part.type === 'resource');
  assert.equal(resource.resource.mimeType, 'application/zip');
  const zip = Buffer.from(resource.resource.blob, 'base64');
  assert.equal(zip.length, metadata.zipBytes);
  const entries = zipEntries(zip);
  assert.deepEqual([...entries.keys()], ['server.mjs']);
  assert.equal(entries.get('server.mjs').toString('utf8'), 'export const value = 1;\n');
});

test('download_zip lists directories with ripgrep, supports safe globs and exact exclusions, and never includes .git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-download-'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'ignored'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'src', 'omit'));
  await writeFile(join(root, '.gitignore'), 'ignored/\n', 'utf8');
  await writeFile(join(root, '.git', 'config'), 'private', 'utf8');
  await writeFile(join(root, 'ignored', 'ignored.js'), 'ignored', 'utf8');
  await writeFile(join(root, 'src', 'a.js'), 'a', 'utf8');
  await writeFile(join(root, 'src', 'b.txt'), 'b', 'utf8');
  await writeFile(join(root, 'src', 'omit', 'skip.js'), 'skip', 'utf8');
  await writeFile(join(root, 'src', 'omit-file.js'), 'skip', 'utf8');
  const server = await serverFor(root, 'directory');
  const downloaded = await server(request(2, 'tools/call', {
    name: 'download_zip',
    arguments: {
      path: '.',
      archiveName: 'source.zip',
      includeIgnored: true,
      globs: ['**/*.js'],
      excludePaths: ['ignored', 'src/omit', 'src/omit-file.js']
    }
  }));
  assert.equal(downloaded.result.isError, false);
  const resource = downloaded.result.content.find((part) => part.type === 'resource');
  const entries = zipEntries(Buffer.from(resource.resource.blob, 'base64'));
  assert.deepEqual([...entries.keys()], ['src/a.js']);
  assert.ok(![...entries.keys()].some((name) => name.startsWith('.git/')));
});

test('download_zip rejects scope, option, archive-name, blocked-file, and shell-injection attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-download-injection-'));
  await mkdir(join(root, '--aaa'));
  await mkdir(join(root, 'semi;name'));
  await writeFile(join(root, '--aaa', 'inside.js'), 'safe', 'utf8');
  await writeFile(join(root, 'semi;name', 'inside.js'), 'safe', 'utf8');
  await writeFile(join(root, 'game.nds'), 'not-a-rom', 'utf8');
  const server = await serverFor(root, 'injection');
  let id = 2;
  for (const path of ['--aaa', 'semi;name']) {
    const result = await server(request(id++, 'tools/call', {
      name: 'download_zip', arguments: { path, archiveName: 'literal.zip' }
    }));
    assert.equal(result.result.isError, false, path);
  }
  for (const argumentsValue of [
    { path: '.', archiveName: '../escape.zip' },
    { path: '.', archiveName: 'bad|name.zip' },
    { path: '.', globs: ['--no-ignore'] },
    { path: '.', globs: ['../../*'] },
    { path: '.', excludePaths: ['../outside'] },
    { path: 'foo\n--no-ignore' },
    { path: 'foo\0bar' },
    { path: 'game.nds' },
    { path: 'missing;touch injected' }
  ]) {
    const refused = await server(request(id++, 'tools/call', {
      name: 'download_zip', arguments: argumentsValue
    }));
    assert.equal(refused.result.isError, true, JSON.stringify(argumentsValue));
  }
  await assert.rejects(access(join(root, 'injected')));
});

test('safe-download refuses the entire directory before filters when any file or folder matches a configured path glob', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-download-glob-'));
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, 'src.js'), 'safe', 'utf8');
  const server = await serverFor(root, 'path-glob', { disallowedPathGlobs: ['**.ssh**'] });
  const refused = await server(request(2, 'tools/call', {
    name: 'download_zip',
    arguments: {
      path: '.',
      globs: ['**/*.js'],
      excludePaths: ['.ssh'],
      archiveName: 'source.zip'
    }
  }));
  assert.equal(refused.result.isError, true);
  const error = refused.result.structuredContent.error;
  assert.match(error, /safe-download directory scan/);
  assert.match(error, /glob filter disallowed_path_globs/);
  assert.match(error, /\*\*\.ssh\*\*/);
  assert.match(error, /\.ssh/);
  assert.equal(refused.result.content.some((part) => part.type === 'resource'), false);
});

test('safe-download reports the matching glob and target for a directly requested file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-download-glob-file-'));
  await writeFile(join(root, 'backup.ssh.txt'), 'safe', 'utf8');
  const server = await serverFor(root, 'path-glob-file', { disallowedPathGlobs: ['**.ssh**'] });
  const refused = await server(request(2, 'tools/call', {
    name: 'download_zip', arguments: { path: 'backup.ssh.txt' }
  }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /download_zip path/);
  assert.match(refused.result.structuredContent.error, /backup\.ssh\.txt/);
});

test('download_zip enforces file-count, input-size, ZIP-size, and symlink boundaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'safe-download-'));
  const outside = await mkdtemp(join(tmpdir(), 'safe-download-outside-'));
  await writeFile(join(root, 'a.txt'), 'aaaaaaaa', 'utf8');
  await writeFile(join(root, 'b.txt'), 'bbbbbbbb', 'utf8');
  await writeFile(join(outside, 'outside.txt'), 'outside', 'utf8');

  const countServer = await serverFor(root, 'count-limit', { maxFiles: 1 });
  const count = await countServer(request(2, 'tools/call', { name: 'download_zip', arguments: { path: '.' } }));
  assert.equal(count.result.isError, true);
  assert.match(count.result.structuredContent.error, /file count/i);

  const inputServer = await serverFor(root, 'input-limit', { maxInputBytes: 4 });
  const input = await inputServer(request(3, 'tools/call', { name: 'download_zip', arguments: { path: 'a.txt' } }));
  assert.equal(input.result.isError, true);
  assert.match(input.result.structuredContent.error, /input bytes/i);

  const zipServer = await serverFor(root, 'zip-limit', { maxZipBytes: 16 });
  const zip = await zipServer(request(4, 'tools/call', { name: 'download_zip', arguments: { path: 'a.txt' } }));
  assert.equal(zip.result.isError, true);
  assert.match(zip.result.structuredContent.error, /ZIP bytes/i);

  const link = join(root, 'outside-link.txt');
  if (!await createSymlinkOrSkip(t, join(outside, 'outside.txt'), link)) return;
  const linkServer = await serverFor(root, 'symlink');
  const linked = await linkServer(request(5, 'tools/call', { name: 'download_zip', arguments: { path: 'outside-link.txt' } }));
  assert.equal(linked.result.isError, true);
  assert.match(linked.result.structuredContent.error, /symbolic|escaped/i);
});