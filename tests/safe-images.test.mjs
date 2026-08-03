import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlLsAAAAASUVORK5CYII=', 'base64');
const threeByTwoJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAACAAMBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==', 'base64');
const fourByThreeWebp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoEAAMAAgA0JaQAA3AA/vuUAAA=', 'base64');

async function serverFor(root, suffix, env = {}) {
  process.env.SAFE_IMAGES_ROOTS = JSON.stringify([root]);
  process.env.LOCAL_MCP_DISALLOWED_PATH_GLOBS = JSON.stringify(env.disallowedPathGlobs ?? []);
  if (env.maxBytes === undefined) delete process.env.SAFE_IMAGES_MAX_BYTES;
  else process.env.SAFE_IMAGES_MAX_BYTES = String(env.maxBytes);
  if (env.maxPixels === undefined) delete process.env.SAFE_IMAGES_MAX_PIXELS;
  else process.env.SAFE_IMAGES_MAX_PIXELS = String(env.maxPixels);
  const { createServer } = await import(`../mcp/safe-images/server.mjs?test=${suffix}-${Date.now()}-${Math.random()}`);
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

test('safe-images exposes only the read_image tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-images-'));
  const server = await serverFor(root, 'surface');
  const listed = await server(request(2, 'tools/list', {}));
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['read_image']);
  assert.equal(listed.result.tools[0].outputSchema?.type, 'object');
  assert.equal(listed.result.tools[0].annotations.readOnlyHint, true);
});

test('read_image returns MCP image content and metadata without duplicating base64 in structuredContent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-images-'));
  const imagePath = join(root, 'pixel.png');
  await writeFile(imagePath, onePixelPng);
  const server = await serverFor(root, 'png');
  const read = await server(request(2, 'tools/call', { name: 'read_image', arguments: { path: 'pixel.png' } }));
  assert.equal(read.result.isError, false);
  assert.equal(read.result.content[1].type, 'image');
  assert.equal(read.result.content[1].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(read.result.content[1].data, 'base64'), onePixelPng);
  assert.equal(read.result.structuredContent.result.width, 1);
  assert.equal(read.result.structuredContent.result.height, 1);
  assert.equal(read.result.structuredContent.result.bytes, onePixelPng.length);
  assert.equal(typeof read.result.structuredContent.result.sha256, 'string');
  assert.equal(JSON.stringify(read.result.structuredContent).includes(read.result.content[1].data), false);
});

test('read_image detects JPEG and WebP dimensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-images-'));
  await writeFile(join(root, 'sample.jpg'), threeByTwoJpeg);
  await writeFile(join(root, 'sample.webp'), fourByThreeWebp);
  const server = await serverFor(root, 'jpeg-webp');
  const jpeg = await server(request(2, 'tools/call', { name: 'read_image', arguments: { path: 'sample.jpg' } }));
  assert.equal(jpeg.result.isError, false);
  assert.equal(jpeg.result.structuredContent.result.mimeType, 'image/jpeg');
  assert.equal(jpeg.result.structuredContent.result.width, 3);
  assert.equal(jpeg.result.structuredContent.result.height, 2);
  const webp = await server(request(3, 'tools/call', { name: 'read_image', arguments: { path: 'sample.webp' } }));
  assert.equal(webp.result.isError, false);
  assert.equal(webp.result.structuredContent.result.mimeType, 'image/webp');
  assert.equal(webp.result.structuredContent.result.width, 4);
  assert.equal(webp.result.structuredContent.result.height, 3);
});

test('read_image rejects extension mismatch, unsupported formats, and oversized files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-images-'));
  await writeFile(join(root, 'wrong.jpg'), onePixelPng);
  await writeFile(join(root, 'vector.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8');
  await writeFile(join(root, 'large.png'), onePixelPng);
  const server = await serverFor(root, 'validation');
  const mismatch = await server(request(2, 'tools/call', { name: 'read_image', arguments: { path: 'wrong.jpg' } }));
  assert.equal(mismatch.result.isError, true);
  assert.match(mismatch.result.structuredContent.error, /does not match/);
  const unsupported = await server(request(3, 'tools/call', { name: 'read_image', arguments: { path: 'vector.svg' } }));
  assert.equal(unsupported.result.isError, true);
  assert.match(unsupported.result.structuredContent.error, /Unsupported image extension/);
  const sizeLimitedServer = await serverFor(root, 'size-limit', { maxBytes: 32 });
  const oversized = await sizeLimitedServer(request(4, 'tools/call', { name: 'read_image', arguments: { path: 'large.png' } }));
  assert.equal(oversized.result.isError, true);
  assert.match(oversized.result.structuredContent.error, /exceeds 32 bytes/);
});

test('read_image rejects paths outside the configured root and symbolic-link paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'safe-images-'));
  const outside = await mkdtemp(join(tmpdir(), 'safe-images-outside-'));
  const outsideImage = join(outside, 'outside.png');
  await writeFile(outsideImage, onePixelPng);
  const server = await serverFor(root, 'paths');
  const escaped = await server(request(2, 'tools/call', { name: 'read_image', arguments: { path: outsideImage } }));
  assert.equal(escaped.result.isError, true);
  assert.match(escaped.result.structuredContent.error, /outside/);
  const linkPath = join(root, 'link.png');
  if (!await createSymlinkOrSkip(t, outsideImage, linkPath)) return;
  const linked = await server(request(3, 'tools/call', { name: 'read_image', arguments: { path: 'link.png' } }));
  assert.equal(linked.result.isError, true);
  assert.match(linked.result.structuredContent.error, /Symbolic-link/);
});

test('read_image rejects a configured path glob and reports the matched target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-images-glob-'));
  await writeFile(join(root, 'preview.ssh.png'), onePixelPng);
  const server = await serverFor(root, 'path-glob', { disallowedPathGlobs: ['**.ssh**'] });
  const refused = await server(request(2, 'tools/call', {
    name: 'read_image', arguments: { path: 'preview.ssh.png' }
  }));
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.structuredContent.error, /glob filter disallowed_path_globs/);
  assert.match(refused.result.structuredContent.error, /preview\.ssh\.png/);
});

test('read_image validates its argument surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safe-images-'));
  await writeFile(join(root, 'pixel.png'), onePixelPng);
  const server = await serverFor(root, 'args');
  const extra = await server(request(2, 'tools/call', { name: 'read_image', arguments: { path: 'pixel.png', other: true } }));
  assert.equal(extra.result.isError, true);
  assert.match(extra.result.structuredContent.error, /only the path argument/);
  const unknown = await server(request(3, 'tools/call', { name: 'delete_image', arguments: { path: 'pixel.png' } }));
  assert.equal(unknown.result.isError, true);
  assert.match(unknown.result.structuredContent.error, /Unknown tool/);
});