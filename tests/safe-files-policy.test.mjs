import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { safeFilesInternals } from '../mcp/safe-files/server.mjs';

test('configured deny roots survive sandbox metadata denial', async () => {
  const deniedPath = join(tmpdir(), 'gateway-logs-denied');
  const permissionError = new Error('sandbox denied metadata access');
  permissionError.code = 'EPERM';
  const canonical = await safeFilesInternals.canonicalizeConfiguredDeniedPath(
    deniedPath,
    async () => { throw permissionError; }
  );
  assert.equal(canonical, resolve(deniedPath));
});