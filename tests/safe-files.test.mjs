import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

test('safe-files exposes no command-execution tool and rejects UTF-16', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  process.env.SAFE_FILES_ROOTS = JSON.stringify([root]);
  const { createServer } = await import(`../mcp/safe-files/server.mjs?test=${Date.now()}`);
  const server = createServer();
  await server(request(1, 'initialize', {}));
  const listed = await server(request(2, 'tools/list', {}));
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names.sort(), ['create_directory', 'list_directory', 'read_text_file', 'replace_text', 'roots', 'write_text_file']);
  await writeFile(join(root, 'utf16.txt'), Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  const result = await server(request(3, 'tools/call', { name: 'read_text_file', arguments: { path: 'utf16.txt' } }));
  assert.equal(result.result.isError, true);
  assert.match(result.result.structuredContent.error, /UTF-16/);
});

test('safe-files refuses symlink escape and performs exact replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'safe-files-outside-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.txt'), 'alpha alpha', 'utf8');
  await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
  await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  process.env.SAFE_FILES_ROOTS = JSON.stringify([root]);
  const { createServer } = await import(`../mcp/safe-files/server.mjs?test=${Date.now()}x`);
  const server = createServer();
  await server(request(1, 'initialize', {}));
  const escaped = await server(request(2, 'tools/call', { name: 'read_text_file', arguments: { path: 'escape.txt' } }));
  assert.equal(escaped.result.isError, true);
  const replaced = await server(request(3, 'tools/call', { name: 'replace_text', arguments: { path: 'src/a.txt', oldText: 'alpha', newText: 'beta', expectedOccurrences: 2 } }));
  assert.equal(replaced.result.isError, false);
  assert.equal(await readFile(join(root, 'src', 'a.txt'), 'utf8'), 'beta beta');
});
