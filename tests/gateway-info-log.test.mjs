import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayInfoLogger, gatewayLogFileName } from '../app/gateway-info-log.mjs';

test('gateway INFO file logging writes the same INFO records without unrelated stderr noise', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gateway-info-log-'));
  let stderr = '';
  const startedAt = new Date(2026, 7, 11, 17, 12, 34, 56);
  const logger = createGatewayInfoLogger({
    enabled: true,
    directory,
    startedAt,
    pid: 4242,
    stderr: { write(chunk) { stderr += String(chunk); } }
  });

  logger.info('tool exposure: found=3 disabled=1 published=2');
  logger.info('tool call: name="files__read_text" arguments={"path":"a.txt"}');
  const unrelatedNoise = '[tunnel-client] connected\n';
  stderr += unrelatedNoise;

  const expectedName = gatewayLogFileName(startedAt, 4242);
  assert.deepEqual(await readdir(directory), [expectedName]);
  assert.equal(logger.filePath, join(directory, expectedName));
  assert.equal(await readFile(logger.filePath, 'utf8'), [
    '[gateway] INFO tool exposure: found=3 disabled=1 published=2',
    '[gateway] INFO tool call: name="files__read_text" arguments={"path":"a.txt"}',
    ''
  ].join('\n'));
  assert.equal(stderr.endsWith(unrelatedNoise), true);
});

test('gateway INFO file logging does not create a logs directory when disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gateway-info-log-disabled-'));
  const directory = join(root, 'logs');
  let stderr = '';
  const logger = createGatewayInfoLogger({
    enabled: false,
    directory,
    stderr: { write(chunk) { stderr += String(chunk); } }
  });
  logger.info('still visible on stderr');
  assert.equal(logger.filePath, null);
  await assert.rejects(readdir(directory), (error) => error?.code === 'ENOENT');
  assert.equal(stderr, '[gateway] INFO still visible on stderr\n');
});
