import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sandboxDotPathFindings,
  sandboxDotPathWarningLines,
  sandboxHiddenPathWarningInternals
} from '../app/sandbox-hidden-path-warning.mjs';

test('dot-prefixed path detection accepts both slash styles but ignores . and .. traversal components', () => {
  const { dotPrefixedComponents } = sandboxHiddenPathWarningInternals;
  assert.deepEqual(dotPrefixedComponents('C:\\Users\\owner\\.ssh\\id_ed25519'), ['.ssh']);
  assert.deepEqual(dotPrefixedComponents('/home/user/.config/tool'), ['.config']);
  assert.deepEqual(dotPrefixedComponents('C:\\repo\\.git\\objects\\.cache'), ['.git', '.cache']);
  assert.deepEqual(dotPrefixedComponents('../repo/./file.txt'), []);
});

test('warning reports sandboxed startup args and allowed directories with the loaded config path', () => {
  const config = {
    canonicalConfigPath: 'C:\\config\\gateway.toml',
    servers: [
      {
        name: 'codespace',
        sandbox: 'onlineworkspace',
        args: ['server.mjs', '--ssh-key-file=C:\\Users\\owner\\.ssh\\id_ed25519'],
        allowedDirectories: ['C:\\Users\\owner\\Documents\\.private-workspace']
      },
      {
        name: 'legacy',
        sandbox: 'never',
        args: ['--file=C:\\Users\\owner\\.ignored\\file.txt'],
        allowedDirectories: ['C:\\Users\\owner\\.ignored']
      }
    ]
  };

  assert.deepEqual(sandboxDotPathFindings(config), [
    {
      field: 'mcp_servers.codespace.args[1]',
      components: ['.ssh'],
      value: undefined
    },
    {
      field: 'mcp_servers.codespace.allowed_directories[0]',
      components: ['.private-workspace'],
      value: 'C:\\Users\\owner\\Documents\\.private-workspace'
    }
  ]);

  const warning = sandboxDotPathWarningLines(config).join('\n');
  assert.match(warning, /Codex sandbox ABSOLUTELY NEVER/);
  assert.match(warning, /Configuration: C:\\config\\gateway\.toml/);
  assert.match(warning, /mcp_servers\.codespace\.args\[1\].*"\.ssh"/);
  assert.doesNotMatch(warning, /id_ed25519/);
  assert.match(warning, /mcp_servers\.codespace\.allowed_directories\[0\].*\.private-workspace/);
  assert.doesNotMatch(warning, /mcp_servers\.legacy/);
});

test('warning is empty when sandboxed configuration has no dot-prefixed path components', () => {
  const config = {
    configPath: '/config/gateway.toml',
    servers: [{ name: 'files', sandbox: 'elevated', args: ['server.mjs'], allowedDirectories: ['/workspaces/project'] }]
  };
  assert.deepEqual(sandboxDotPathWarningLines(config), []);
});
