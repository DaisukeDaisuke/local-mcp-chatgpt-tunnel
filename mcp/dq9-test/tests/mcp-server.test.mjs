import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createMcpServer } from '../src/mcp/stdio-server.mjs';
import { createTools } from '../src/mcp/tools.mjs';

const outputLines = async (server, input, output, requests) => {
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  server.start(input, output);
  input.write(`${requests.map(JSON.stringify).join('\n')}\n`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return text.trim().split('\n').filter(Boolean).map(JSON.parse);
};

test('stdio MCP lifecycle lists exactly five tools and keeps stdout protocol-only', async () => {
  const runtimeManager = { prepare: async () => ({ ready: true }), stop: async () => ({ state: 'stopped' }) };
  const runService = { start: async () => ({ runId: 'run', status: 'queued' }), getStatus: () => ({ runId: 'run', status: 'completed' }) };
  const server = createMcpServer({ tools: createTools({ runtimeManager, runService }) });
  const responses = await outputLines(server, new PassThrough(), new PassThrough(), [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rerun_incident', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'stop_test_runtime', arguments: {} } }
  ]);
  assert.equal(responses.length, 4);
  assert.equal(responses[1].result.tools.length, 5);
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['prepare_test_runtime', 'run_cases', 'get_run_status', 'rerun_incident', 'stop_test_runtime']);
  assert.equal(responses[2].result.isError, true);
  assert.equal(responses[2].result.structuredContent.error.code, 'notImplementedForMilestone');
  assert.equal(responses[3].result.structuredContent.ok, true);
});

test('stdio MCP returns protocol errors for malformed lifecycle requests', async () => {
  const server = createMcpServer({ tools: { list: () => [], call: async () => ({}) } });
  const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(response.error.code, -32002);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 2, method: 'unknown' })).error.code, -32002);
});
