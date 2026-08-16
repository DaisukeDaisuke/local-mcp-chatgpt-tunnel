import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayPathPolicyArguments } from '../app/gateway-path-arguments.mjs';

test('default gateway argument policy preserves all tool arguments', () => {
  const input = { path: '/tmp/example', command: ['/remote/path'] };
  assert.equal(gatewayPathPolicyArguments({ gatewayArgumentPolicy: 'default' }, 'tool', input), input);
});

test('codespace ssh excludes remote command tokens from local path-policy inspection', () => {
  const input = { codespaceId: 'existing-space-123', command: ['ls', '/workspaces/project'], timeoutMs: 1000 };
  assert.deepEqual(gatewayPathPolicyArguments({ gatewayArgumentPolicy: 'codespace' }, 'ssh', input), {
    codespaceId: 'existing-space-123'
  });
});

test('codespace remote git/search paths are not mistaken for local Gateway paths', () => {
  assert.deepEqual(gatewayPathPolicyArguments({ gatewayArgumentPolicy: 'codespace' }, 'git_root', {
    codespaceId: 'existing-space-123',
    path: '/workspaces/project'
  }), { codespaceId: 'existing-space-123' });
  assert.deepEqual(gatewayPathPolicyArguments({ gatewayArgumentPolicy: 'codespace' }, 'search_text', {
    codespaceId: 'existing-space-123',
    searchBase: '/workspaces/project',
    query: '/etc/passwd',
    globs: ['**/*.js']
  }), { codespaceId: 'existing-space-123' });
});

test('codespace copy keeps local source selectors but excludes remote destination from local path-policy inspection', () => {
  const input = {
    codespaceId: 'existing-space-123',
    sourceDirectory: 'C:\\work\\project',
    paths: ['src/index.js'],
    remoteDestination: '/workspaces/project',
    timeoutMs: 1000
  };
  assert.deepEqual(gatewayPathPolicyArguments({ gatewayArgumentPolicy: 'codespace' }, 'copy_to_codespace', input), {
    sourceDirectory: 'C:\\work\\project',
    paths: ['src/index.js']
  });
});

test('codespace non-remote tools keep normal gateway path-policy inspection', () => {
  const input = { codespaceId: 'existing-space-123', port: 3000 };
  assert.equal(gatewayPathPolicyArguments({ gatewayArgumentPolicy: 'codespace' }, 'open_temporary_public_deployment', input), input);
});
