import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolPathPolicy, pathPolicyInternals } from '../app/path-policy.mjs';

test('path policy allows directory descendants and exact files with Windows separators', async () => {
  const policy = new ToolPathPolicy({
    serverName: 'chrome',
    cwd: 'C:\\work\\project',
    allowedDirectories: ['C:\\work\\project'],
    allowedFiles: ['C:\\Users\\owner\\Downloads\\upload.png']
  });
  await assert.doesNotReject(policy.assertToolArguments('read_file', { path: 'src\\index.js' }));
  await assert.doesNotReject(policy.assertToolArguments('upload_file', {
    filePath: '"C:\\\\Users\\\\owner\\\\Downloads\\\\upload.png"'
  }));
  await assert.doesNotReject(policy.assertToolArguments('upload_file', {
    filePath: 'C:\\\\Users\\\\owner\\\\Downloads\\\\upload.png'
  }));
  await assert.doesNotReject(policy.assertToolArguments('upload_file', {
    filePath: 'file:///C:/Users/owner/Downloads/upload.png'
  }));
  await assert.rejects(
    policy.assertToolArguments('upload_file', { filePath: 'C:\\Users\\owner\\.ssh\\id_ed25519' }),
    /outside allowed_directories and allowed_files/
  );
});

test('path policy detects nested path arrays but ignores ordinary web URLs', async () => {
  const policy = new ToolPathPolicy({
    serverName: 'browser',
    cwd: 'C:\\work',
    allowedDirectories: [],
    allowedFiles: ['C:\\uploads\\one.png', 'C:\\uploads\\two.png']
  });
  await assert.doesNotReject(policy.assertToolArguments('navigate', { url: 'https://example.com/a/b' }));
  await assert.doesNotReject(policy.assertToolArguments('route', { path: 'https://example.com/a/b' }));
  await assert.doesNotReject(policy.assertToolArguments('upload', {
    files: ['C:\\uploads\\one.png', 'C:/uploads/two.png']
  }));
  await assert.rejects(policy.assertToolArguments('upload', { files: ['C:\\uploads\\three.png'] }), /allowed_files/);
});

test('path-shaped values are checked even when the argument key is unfamiliar', async () => {
  const policy = new ToolPathPolicy({
    serverName: 'unknown',
    cwd: '/workspace',
    allowedDirectories: ['/workspace/project'],
    allowedFiles: []
  });
  await assert.doesNotReject(policy.assertToolArguments('tool', { value: '/workspace/project/a.txt' }));
  await assert.rejects(policy.assertToolArguments('tool', { value: '/etc/passwd' }), /outside allowed_directories/);
  assert.equal(pathPolicyInternals.looksLikePath('https://example.com/a'), false);
});

test('path policy resolves symlinks before allowing a path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'path-policy-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'path-policy-outside-'));
  const secret = join(outside, 'secret.txt');
  const link = join(root, 'linked.txt');
  await writeFile(secret, 'secret', 'utf8');
  try {
    await symlink(secret, link);
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`Symbolic links are unavailable in this Windows environment: ${error.code}`);
      return;
    }
    throw error;
  }
  const policy = new ToolPathPolicy({ serverName: 'files', cwd: root, allowedDirectories: [root], allowedFiles: [] });

test('disallowed paths override allowed directories', async () => {
  const policy = new ToolPathPolicy({
    serverName: 'files',
    cwd: 'C:\\work\\project',
    allowedDirectories: ['C:\\work\\project'],
    allowedFiles: [],
    disallowedDirectories: ['C:\\work\\project\\private'],
    disallowedFiles: ['C:\\work\\project\\.env']
  });
  await assert.doesNotReject(policy.assertToolArguments('read', { path: 'src\\index.js' }));
  await assert.rejects(policy.assertToolArguments('read', { path: 'private\\secret.txt' }), /denied by disallowed/);
  await assert.rejects(policy.assertToolArguments('read', { path: '.env' }), /denied by disallowed/);
});
  await assert.rejects(policy.assertToolArguments('read', { path: link }), /outside allowed_directories/);
});