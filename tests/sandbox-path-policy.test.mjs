import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { assertSandboxPathPolicyCompatible } from '../app/sandbox-path-policy.mjs';

function policy(root) {
  return {
    directories: [{ canonical: root }],
    files: [],
    disallowedDirectories: [],
    disallowedFiles: [{ canonical: join(root, 'private.txt') }],
    protectedFiles: [{ canonical: join(root, 'config', 'gateway.toml') }]
  };
}

test('sandboxed bundled MCP keeps its internal deny policy while using the outer Codex sandbox', () => {
  const root = join(process.cwd(), 'workspace');
  assert.doesNotThrow(() => assertSandboxPathPolicyCompatible({
    name: 'files',
    sandbox: 'elevated',
    sandboxDelegated: false,
    isBundled: true,
    disallowedPathGlobs: ['**.ssh**']
  }, policy(root)));
});

test('sandboxed external MCP allows exact deny holes that Codex can enforce', () => {
  const root = join(process.cwd(), 'workspace');
  assert.doesNotThrow(() => assertSandboxPathPolicyCompatible({
    name: 'external',
    sandbox: 'elevated',
    sandboxDelegated: false,
    isBundled: false,
    disallowedPathGlobs: []
  }, policy(root)));
});

test('sandboxed external MCP rejects only Gateway glob semantics that are not translated safely', () => {
  const root = join(process.cwd(), 'workspace');
  assert.throws(() => assertSandboxPathPolicyCompatible({
    name: 'external',
    sandbox: 'elevated',
    sandboxDelegated: false,
    isBundled: false,
    disallowedPathGlobs: ['**.ssh**']
  }, policy(root)), /cannot safely translate Gateway disallowed_path_globs/);
});