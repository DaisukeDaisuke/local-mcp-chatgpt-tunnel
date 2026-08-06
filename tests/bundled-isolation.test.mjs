import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  BUNDLED_ISOLATION_ARGUMENT,
  assertNoPublicRootOverride,
  createBundledIsolation,
  environmentWithoutBundledIsolationKey,
  signBundledIsolationContext
} from '../app/bundled-isolation.mjs';

const KEY = '0123456789abcdef'.repeat(4);
const CONTEXT = {
  base: resolve('test-workspaces', 'alpha'),
  roots: [resolve('test-workspaces', 'alpha'), resolve('test-workspaces', 'shared')]
};

function envelope(context = CONTEXT) {
  return {
    version: 1,
    base: context.base,
    roots: context.roots,
    signature: signBundledIsolationContext(KEY, context)
  };
}

test('bundled isolation accepts a signed context and hides it from the tool', async () => {
  const isolation = createBundledIsolation({ key: KEY });
  const result = await isolation.run({
    path: 'README.md',
    [BUNDLED_ISOLATION_ARGUMENT]: envelope()
  }, async (args) => ({ args, context: isolation.current() }));

  assert.deepEqual(result.args, { path: 'README.md' });
  assert.deepEqual(result.context, CONTEXT);
  assert.equal(isolation.current(), null);
});

test('the signature authorizes only base and roots, not public tool arguments', async () => {
  const isolation = createBundledIsolation({ key: KEY });
  const signedContext = envelope();
  const first = await isolation.run({ path: 'first.txt', [BUNDLED_ISOLATION_ARGUMENT]: signedContext }, (args) => args);
  const second = await isolation.run({ path: 'second.txt', [BUNDLED_ISOLATION_ARGUMENT]: signedContext }, (args) => args);
  assert.deepEqual(first, { path: 'first.txt' });
  assert.deepEqual(second, { path: 'second.txt' });
});

test('bundled isolation rejects unsigned and modified path contexts', async () => {
  const isolation = createBundledIsolation({ key: KEY });
  await assert.rejects(
    isolation.run({ path: '.', [BUNDLED_ISOLATION_ARGUMENT]: { ...envelope(), roots: [...CONTEXT.roots].reverse() } }, () => null),
    /signature/
  );
  await assert.rejects(isolation.run({ path: '.' }, () => null), /Missing private Gateway isolation context/);
  await assert.rejects(
    isolation.run({ root: resolve('outside'), [BUNDLED_ISOLATION_ARGUMENT]: envelope() }, () => null),
    /workspace roots are controlled only by isolated__create/
  );
});

test('public root and workspace arguments are always reserved', () => {
  assert.throws(() => assertNoPublicRootOverride({ root: resolve('outside') }), /reserved/);
  assert.throws(() => assertNoPublicRootOverride({ allowedRoots: [resolve('outside')] }), /reserved/);
  assert.throws(() => assertNoPublicRootOverride({ workspaceRootPath: resolve('outside') }), /reserved/);
  assert.throws(() => assertNoPublicRootOverride({ nested: { workspaceRoots: [resolve('outside')] } }), /reserved/);
  assert.doesNotThrow(() => assertNoPublicRootOverride({ repositoryPath: '.', parentDirectory: '.' }));
});

test('bundled isolation key is removed from descendant process environments', () => {
  assert.deepEqual(environmentWithoutBundledIsolationKey({
    PATH: 'safe',
    LOCAL_MCP_GATEWAY_ISOLATION_KEY: 'secret'
  }), { PATH: 'safe' });
});
