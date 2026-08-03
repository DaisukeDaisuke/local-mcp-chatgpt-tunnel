import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadAllowedSuiteFile } from '../mcp/dq9-test/src/services/suite-file-policy.mjs';

async function markedRoot(prefix = 'dq9-suite-root-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(root, '.chatgpt-local-mcp-root'), 'allowed\n', 'utf8');
  return root;
}

test('DQ9 suites are read only from marked workspace roots', async () => {
  const root = await markedRoot();
  const suite = join(root, 'suite.json');
  await writeFile(suite, '{"cases":[]}\n', 'utf8');
  const loaded = await loadAllowedSuiteFile(suite, { roots: [root] });
  assert.equal(loaded.path, suite);
  assert.equal(loaded.text, '{"cases":[]}\n');
  const outside = join(await mkdtemp(join(tmpdir(), 'dq9-suite-outside-')), 'outside.json');
  await writeFile(outside, '{}\n', 'utf8');
  await assert.rejects(loadAllowedSuiteFile(outside, { roots: [root] }), /outside all marked workspace roots/);
});

test('DQ9 suite policy rejects credential paths, symlink escapes, secrets, and UTF-16', async () => {
  const root = await markedRoot();
  const fakeRuntimeKey = ['sk', 'proj', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');
  await mkdir(join(root, '.ssh'));
  await writeFile(join(root, '.ssh', 'suite.json'), '{}\n', 'utf8');
  await assert.rejects(loadAllowedSuiteFile(join(root, '.ssh', 'suite.json'), { roots: [root] }), /Credential-like suite paths/);
  const outside = join(await mkdtemp(join(tmpdir(), 'dq9-suite-target-')), 'target.json');
  await writeFile(outside, '{}\n', 'utf8');
  const link = join(root, 'linked.json');
  await symlink(outside, link);
  await assert.rejects(loadAllowedSuiteFile(link, { roots: [root] }), /escaped the marked workspace root/);
  const secret = join(root, 'secret-suite.json');
  await writeFile(secret, `${JSON.stringify({ token: fakeRuntimeKey })}\n`, 'utf8');
  await assert.rejects(loadAllowedSuiteFile(secret, { roots: [root] }), /resembles a credential/);
  const utf16 = join(root, 'utf16.json');
  await writeFile(utf16, Buffer.from('\uFEFF{"cases":[]}', 'utf16le'));
  await assert.rejects(loadAllowedSuiteFile(utf16, { roots: [root] }), /UTF-8, not UTF-16/);
});
