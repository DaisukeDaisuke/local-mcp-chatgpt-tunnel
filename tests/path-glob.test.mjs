import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findDisallowedPathGlob,
  normalizeDisallowedPathGlobs,
  normalizePathForGlob
} from '../app/path-glob.mjs';

test('double-star path globs match across separators on Windows, macOS, and Linux', () => {
  assert.deepEqual(
    findDisallowedPathGlob('C:\\Users\\owner\\.SSH\\id_ed25519', ['**.ssh**'], 'win32'),
    { pattern: '**.ssh**', path: 'C:/Users/owner/.SSH/id_ed25519' }
  );
  assert.deepEqual(
    findDisallowedPathGlob('/Users/owner/.ssh/id_ed25519', ['**.ssh**'], 'darwin'),
    { pattern: '**.ssh**', path: '/Users/owner/.ssh/id_ed25519' }
  );
  assert.deepEqual(
    findDisallowedPathGlob('/home/owner/.ssh/id_ed25519', ['**.ssh**'], 'linux'),
    { pattern: '**.ssh**', path: '/home/owner/.ssh/id_ed25519' }
  );
});

test('single star stays within one path component while double star crosses separators', () => {
  assert.equal(findDisallowedPathGlob('/work/private/file.txt', ['*/private/*'], 'linux'), null);
  assert.ok(findDisallowedPathGlob('/work/private/file.txt', ['**/private/**'], 'linux'));
  assert.ok(findDisallowedPathGlob('/work/a.env', ['**/*.env'], 'linux'));
  assert.equal(findDisallowedPathGlob('/work/deep/a.env', ['/*.env'], 'linux'), null);
});

test('path glob case handling follows the operating system', () => {
  assert.ok(findDisallowedPathGlob('C:\\WORK\\.SSH\\ID', ['**.ssh**'], 'win32'));
  assert.equal(findDisallowedPathGlob('/work/.SSH/id', ['**.ssh**'], 'linux'), null);
  assert.equal(findDisallowedPathGlob('/work/.SSH/id', ['**.ssh**'], 'darwin'), null);
  assert.equal(normalizePathForGlob('/work/name\\part', 'linux'), '/work/name\\part');
});

test('disallowed path glob configuration rejects malformed arrays', () => {
  assert.deepEqual(normalizeDisallowedPathGlobs(['**.ssh**', '**.ssh**']), ['**.ssh**']);
  assert.throws(() => normalizeDisallowedPathGlobs('**.ssh**'), /array of strings/);
  assert.throws(() => normalizeDisallowedPathGlobs(['']), /non-empty/);
  assert.throws(() => normalizeDisallowedPathGlobs(['bad\npattern']), /control characters/);
});
