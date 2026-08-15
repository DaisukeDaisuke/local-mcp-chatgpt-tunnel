import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function archiveServer(root, suffix, calls) {
  const roots = Array.isArray(root) ? root : [root];
  process.env.LOCAL_MCP_ALLOWED_DIRECTORIES = JSON.stringify(roots);
  process.env.LOCAL_MCP_ALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = '[]';
  const imported = await import(`../mcp/archive/server.mjs?test=${suffix}-${Date.now()}-${Math.random()}`);
  const server = imported.createServer({
    runSevenZip: async (args, cwd, timeoutMs) => {
      calls.push({ args, cwd, timeoutMs });
      if (args[0] === 'x') {
        const output = args.find((arg) => arg.startsWith('-o')).slice(2);
        await writeFile(join(output, 'inside.txt'), 'extracted', 'utf8');
      } else {
        await writeFile(args[2], `archive:${args[1]}`, 'utf8');
      }
      return { exitCode: 0, signal: null, stdout: 'ok', stderr: '' };
    }
  });
  await server(request(1, 'initialize', {}));
  return server;
}

test('archive MCP maps create_zip and create_7z to fixed 7-Zip argument shapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-mcp-'));
  const source = join(root, 'source.txt');
  await writeFile(source, 'source', 'utf8');
  const calls = [];
  const server = await archiveServer(root, 'create', calls);
  const zip = await server(request(2, 'tools/call', { name: 'create_zip', arguments: { sourcePath: source, archivePath: join(root, 'out.zip') } }));
  const seven = await server(request(3, 'tools/call', { name: 'create_7z', arguments: { sourcePath: source, archivePath: join(root, 'out.7z') } }));
  assert.equal(zip.result.isError, false);
  assert.equal(seven.result.isError, false);
  assert.deepEqual(calls[0].args.slice(0, 2), ['a', '-tzip']);
  assert.deepEqual(calls[1].args.slice(0, 2), ['a', '-t7z']);
  assert.equal(await readFile(join(root, 'out.zip'), 'utf8'), 'archive:-tzip');
  assert.equal(await readFile(join(root, 'out.7z'), 'utf8'), 'archive:-t7z');
});

test('archive extraction creates a new destination and removes it when 7-Zip fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-mcp-extract-'));
  const archive = join(root, 'input.zip');
  await writeFile(archive, 'fake', 'utf8');
  const calls = [];
  const server = await archiveServer(root, 'extract', calls);
  const extracted = await server(request(2, 'tools/call', { name: 'extract_archive', arguments: { archivePath: archive, destinationDirectory: join(root, 'output') } }));
  assert.equal(extracted.result.isError, false);
  assert.equal(await readFile(join(root, 'output', 'inside.txt'), 'utf8'), 'extracted');
  assert.deepEqual(calls[0].args.slice(0, 2), ['x', await realpath(archive)]);

  const imported = await import(`../mcp/archive/server.mjs?test=failure-${Date.now()}-${Math.random()}`);
  const failing = imported.createServer({ runSevenZip: async () => { throw new Error('7-Zip fixture failure'); } });
  await failing(request(3, 'initialize', {}));
  const failed = await failing(request(4, 'tools/call', { name: 'extract_archive', arguments: { archivePath: archive, destinationDirectory: join(root, 'failed-output') } }));
  assert.equal(failed.result.isError, true);
  await assert.rejects(stat(join(root, 'failed-output')));
});

test('archive extraction crosses allowed roots and accepts only an empty existing destination', async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'archive-mcp-source-'));
  const destinationRoot = await mkdtemp(join(tmpdir(), 'archive-mcp-destination-'));
  const archive = join(sourceRoot, 'input.zip');
  await writeFile(archive, 'fake', 'utf8');
  const emptyDestination = join(destinationRoot, 'empty-output');
  await mkdir(emptyDestination);
  const calls = [];
  const server = await archiveServer([sourceRoot, destinationRoot], 'cross-root', calls);

  const extracted = await server(request(2, 'tools/call', { name: 'extract_archive', arguments: { archivePath: archive, destinationDirectory: emptyDestination } }));
  assert.equal(extracted.result.isError, false);
  assert.equal(await readFile(join(emptyDestination, 'inside.txt'), 'utf8'), 'extracted');
  assert.equal(calls[0].args[1], await realpath(archive));
  assert.equal(calls[0].args.find((arg) => arg.startsWith('-o')).slice(2), await realpath(emptyDestination));

  const nonemptyDestination = join(destinationRoot, 'nonempty-output');
  await mkdir(nonemptyDestination);
  await writeFile(join(nonemptyDestination, 'keep.txt'), 'keep', 'utf8');
  const rejected = await server(request(3, 'tools/call', { name: 'extract_archive', arguments: { archivePath: archive, destinationDirectory: nonemptyDestination } }));
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.structuredContent.error, /must be empty before extraction/);
  assert.deepEqual(await readdir(nonemptyDestination), ['keep.txt']);
});

test('archive extraction enforces a bounded destination path length', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-mcp-path-limit-'));
  const archive = join(root, 'input.zip');
  await writeFile(archive, 'fake', 'utf8');
  const calls = [];
  const server = await archiveServer(root, 'path-limit', calls);
  const tooLong = join(root, 'x'.repeat(1100));
  const rejected = await server(request(2, 'tools/call', { name: 'extract_archive', arguments: { archivePath: archive, destinationDirectory: tooLong } }));
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.structuredContent.error, /1024-character path limit/);
  assert.equal(calls.length, 0);
});
