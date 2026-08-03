import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpClient } from '../src/cdp/cdp-client.mjs';
import { FakeWebSocket, latestSocket } from './fixtures/fake-cdp-server.mjs';

test('CDP client correlates out-of-order responses', async () => {
  const client = new CdpClient({ WebSocketImpl: FakeWebSocket });
  await client.connect('ws://fake');
  const first = client.request('Runtime.evaluate');
  const second = client.request('Page.navigate');
  const socket = latestSocket();
  socket.reply(socket.sent[1].id, { second: true });
  socket.reply(socket.sent[0].id, { first: true });
  assert.deepEqual(await first, { first: true });
  assert.deepEqual(await second, { second: true });
});

test('CDP client rejects timed-out and closed requests', async () => {
  const client = new CdpClient({ WebSocketImpl: FakeWebSocket, defaultTimeoutMs: 5 });
  await client.connect('ws://fake-timeout');
  await assert.rejects(client.request('Runtime.evaluate'), { code: 'CDP_TIMEOUT' });
  const pending = client.request('Page.enable', {}, { timeoutMs: 1000 });
  latestSocket().close();
  await assert.rejects(pending, { code: 'CDP_SESSION_CLOSED' });
});

test('CDP discovery selects a page endpoint', async () => {
  const url = await CdpClient.discover(9222, { fetchImpl: async () => ({ ok: true, json: async () => [{ type: 'other' }, { type: 'page', webSocketDebuggerUrl: 'ws://page' }] }) });
  assert.equal(url, 'ws://page');
});
