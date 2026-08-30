import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GATEWAY_CHILD_ASYNC_PROMOTION_MS,
  GATEWAY_CHILD_ASYNC_WARNING,
  createGatewayChildAsyncRegistry,
  gatewayChildAsyncPromotionMcpResult
} from '../app/gateway-child-async.mjs';

test('Gateway child async registry returns fast child MCP responses synchronously', async () => {
  const registry = createGatewayChildAsyncRegistry({ promotionMs: 20 });
  const resolved = await registry.resolveOrPromote({
    tool: 'files__read_text',
    prefix: 'files',
    isolatedId: 'alpha',
    promise: Promise.resolve({ content: [{ type: 'text', text: 'ok' }], isError: false })
  });
  assert.equal(resolved.promoted, false);
  assert.equal(resolved.result.content[0].text, 'ok');
});

test('Gateway child async registry promotes a slow request and keeps its UUID inside the isolation', async () => {
  let finish;
  const pending = new Promise((resolvePromise) => { finish = resolvePromise; });
  const registry = createGatewayChildAsyncRegistry({
    promotionMs: 5,
    createId: () => '11111111-1111-4111-8111-111111111111'
  });
  const promoted = await registry.resolveOrPromote({
    tool: 'git__status',
    prefix: 'git',
    isolatedId: 'alpha',
    promise: pending
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.status.status, 'running');
  assert.equal(promoted.status.isolatedId, 'alpha');
  assert.throws(
    () => registry.status(promoted.status.asyncId, 'beta'),
    /different isolated workspace context/
  );

  finish({ content: [{ type: 'text', text: 'done' }], isError: false });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const completed = registry.status(promoted.status.asyncId, 'alpha');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.hasResult, true);
  assert.equal(completed.result.content[0].text, 'done');
});

test('Gateway child async emergency response uses the requested AI-facing error text and status tool name', () => {
  assert.equal(GATEWAY_CHILD_ASYNC_PROMOTION_MS, 11_000);
  assert.match(GATEWAY_CHILD_ASYNC_WARNING, /10秒以上の同期リクエスト/);
  assert.match(GATEWAY_CHILD_ASYNC_WARNING, /gateway_childs_mcp_async_status/);
  const result = gatewayChildAsyncPromotionMcpResult({
    asyncId: '11111111-1111-4111-8111-111111111111',
    prefix: 'files',
    tool: 'files__read_text',
    isolatedId: 'alpha',
    status: 'running',
    promotedAfterMs: 11_000
  });
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, GATEWAY_CHILD_ASYNC_WARNING);
  assert.match(result.content[1].text, /11111111-1111-4111-8111-111111111111/);
});

test('Gateway child async registry can retain an already-promoted aggregate and expose its completion promise', async () => {
  let finish;
  const pending = new Promise((resolvePromise) => { finish = resolvePromise; });
  const registry = createGatewayChildAsyncRegistry({
    promotionMs: 20,
    createId: () => '22222222-2222-4222-8222-222222222222'
  });
  const status = registry.promote({
    tool: 'gateway__multi_step_read',
    prefix: 'gateway',
    isolatedId: 'alpha',
    promise: pending
  });
  assert.equal(status.status, 'running');
  assert.equal(status.asyncId, '22222222-2222-4222-8222-222222222222');
  const completion = registry.completion(status.asyncId, 'alpha');
  finish({ content: [{ type: 'text', text: 'aggregate-done' }], isError: false });
  const result = await completion;
  assert.equal(result.content[0].text, 'aggregate-done');
  assert.equal(registry.status(status.asyncId, 'alpha').status, 'completed');
});
