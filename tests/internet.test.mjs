import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

async function internetServer(root, suffix) {
  process.env.LOCAL_MCP_ALLOWED_DIRECTORIES = JSON.stringify([root]);
  process.env.LOCAL_MCP_ALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_DIRECTORIES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_FILES = '[]';
  process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = '[]';
  const imported = await import(`../mcp/internet/server.mjs?test=${suffix}-${Date.now()}-${Math.random()}`);
  const server = imported.createServer();
  await server(request(1, 'initialize', {}));
  return server;
}

test('internet downloader follows HTTP redirects and writes only the requested workspace file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'internet-mcp-'));
  const http = createHttpServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/payload' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.from([0, 1, 2, 3, 255]));
  });
  await new Promise((resolvePromise) => http.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => http.close());
  const address = http.address();
  const server = await internetServer(root, 'download');
  const result = await server(request(2, 'tools/call', {
    name: 'download_file',
    arguments: {
      url: `http://127.0.0.1:${address.port}/redirect`,
      destinationPath: 'payload.bin'
    }
  }));
  assert.equal(result.result.isError, false);
  assert.equal(result.result.structuredContent.result.bytes, 5);
  assert.equal(result.result.structuredContent.result.redirects, 1);
  assert.deepEqual(await readFile(join(root, 'payload.bin')), Buffer.from([0, 1, 2, 3, 255]));
});

test('internet downloader refuses destinations outside its configured workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'internet-mcp-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'internet-mcp-outside-'));
  const server = await internetServer(root, 'outside');
  const result = await server(request(2, 'tools/call', {
    name: 'download_file',
    arguments: { url: 'https://example.invalid/file', destinationPath: join(outside, 'file.bin') }
  }));
  assert.equal(result.result.isError, true);
  assert.match(result.result.structuredContent.error, /outside|Allowed directories/);
});
