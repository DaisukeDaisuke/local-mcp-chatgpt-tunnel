import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ToolPathPolicy, pathPolicyInternals } from '../app/path-policy.mjs';

test('path policy allows directory descendants and exact files with Windows separators', async () => {
  const policy = new ToolPathPolicy({
    serverName: 'chrome',
    platform: 'win32',
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
    platform: 'win32',
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
    platform: 'linux',
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
    platform: 'win32',
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

for (const platform of ['linux', 'darwin']) {
  test(`path policy uses POSIX path rules on ${platform}`, async () => {
    const policy = new ToolPathPolicy({
      serverName: 'files',
      platform,
      cwd: '/workspace',
      allowedDirectories: ['/workspace'],
      allowedFiles: [],
      disallowedDirectories: ['/workspace/private'],
      disallowedFiles: ['/workspace/.env']
    });

    await assert.doesNotReject(policy.assertToolArguments('read', { path: 'private\\secret.txt' }));
    await assert.rejects(policy.assertToolArguments('read', { path: 'private/secret.txt' }), /denied by disallowed/);
    await assert.rejects(policy.assertToolArguments('read', { path: '.env' }), /denied by disallowed/);
    assert.equal(pathPolicyInternals.looksLikePath('C:\\Users\\owner\\file.txt', platform), false);
    assert.equal(pathPolicyInternals.looksLikePath('/etc/passwd', platform), true);
    assert.deepEqual(
      pathPolicyInternals.normalizeLexical('folder\\name.txt', '/workspace', platform),
      { style: 'posix', path: '/workspace/folder\\name.txt' }
    );
    assert.deepEqual(
      pathPolicyInternals.normalizeLexical('name\\', '/workspace', platform),
      { style: 'posix', path: '/workspace/name\\' }
    );
    assert.deepEqual(
      pathPolicyInternals.normalizeLexical('file:///C:/temp/file.txt', '/workspace', platform),
      { style: 'posix', path: '/C:/temp/file.txt' }
    );
  });
}

test('POSIX path policy rejects Windows-only absolute allowlist entries', async () => {
  const policy = new ToolPathPolicy({
    serverName: 'files',
    platform: 'linux',
    cwd: '/workspace',
    allowedDirectories: ['C:\\workspace'],
    allowedFiles: []
  });

  await assert.rejects(policy.allowed(), /allowed_directories entries must be absolute paths/);
});

for (const [platform, cwd, deniedPath, allowedPath] of [
  ['win32', 'C:\\work', 'C:\\work\\project\\.SSH\\id_ed25519', 'C:\\work\\project\\src\\index.js'],
  ['darwin', '/work', '/work/project/.ssh/id_ed25519', '/work/project/src/index.js'],
  ['linux', '/work', '/work/project/.ssh/id_ed25519', '/work/project/src/index.js']
]) {
  test(`path policy applies configured disallowed_path_globs on ${platform}`, async () => {
    const policy = new ToolPathPolicy({
      serverName: 'files',
      platform,
      cwd,
      allowedDirectories: [platform === 'win32' ? 'C:\\work\\project' : '/work/project'],
      disallowedPathGlobs: ['**.ssh**']
    });
    await assert.doesNotReject(policy.assertToolArguments('read', { path: allowedPath }));
    await assert.rejects(
      policy.assertToolArguments('read', { path: deniedPath }),
      (error) => /glob filter disallowed_path_globs/.test(error.message)
        && error.message.includes('**.ssh**')
        && error.message.toLowerCase().includes('.ssh')
    );
  });
}
