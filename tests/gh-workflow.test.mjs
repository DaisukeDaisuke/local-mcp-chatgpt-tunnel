import assert from 'node:assert/strict';
import test from 'node:test';

const request = (id, method, params = {}) => ({ jsonrpc: '2.0', id, method, params });

async function importGhWorkflow(args, suffix) {
  const previousArgv = process.argv;
  process.argv = [previousArgv[0], 'tests/gh-workflow.test.mjs', ...args];
  try {
    return await import(`../mcp/gh-workflow/server.mjs?test=${suffix}-${Date.now()}`);
  } finally {
    process.argv = previousArgv;
  }
}

test('gh-workflow requires one fixed repository and rejects arbitrary CLI options', async () => {
  await assert.rejects(importGhWorkflow([], 'missing-repository'), /At least one --repository=OWNER\/REPO is required/);
  await assert.rejects(
    importGhWorkflow(['--repository=DaisukeDaisuke/desmume_webassembly', '--command=marker'], 'unknown-option'),
    /Unknown argument/
  );
});

test('gh-workflow rejects malformed repository allowlist values and trailing arguments', async () => {
  const rejectedRepositories = [
    '--repository=aaa\\aaa',
    '--repository=aaa/aaa extra',
    '--repository=aaa/aaa?marker',
    '--repository=aaa/aaa#marker',
    '--repository=aaa/aaa;marker',
    '--repository=aaa/aaa|marker'
  ];
  for (const [index, repository] of rejectedRepositories.entries()) {
    await assert.rejects(
      importGhWorkflow([repository], `invalid-repository-${index}`),
      /repository must be OWNER\/REPO|repository is invalid/
    );
  }
  await assert.rejects(
    importGhWorkflow(['--repository=aaa/aaa', 'marker'], 'trailing-positional'),
    /Unknown argument: marker/
  );
  await assert.rejects(
    importGhWorkflow(['--repository=aaa/aaa', '--marker=true'], 'trailing-option'),
    /Unknown argument: --marker=true/
  );
});

test('gh-workflow accepts repeated repository allowlist entries and requires selection when multiple are configured', async () => {
  const { createServer } = await importGhWorkflow([
    '--repository=DaisukeDaisuke/desmume_webassembly',
    '--repository=DaisukeDaisuke/local-mcp-chatgpt-tunnel'
  ], 'multiple-repositories');
  const commands = [];
  const server = createServer({ execute: async (args) => { commands.push(args); return {}; } });
  await server(request(1, 'initialize'));
  const listed = await server(request(2, 'tools/list'));
  const listRuns = listed.result.tools.find((tool) => tool.name === 'list_runs');
  assert.deepEqual(listRuns.inputSchema.properties.repository.enum, [
    'DaisukeDaisuke/desmume_webassembly',
    'DaisukeDaisuke/local-mcp-chatgpt-tunnel'
  ]);
  assert.ok(listRuns.inputSchema.required.includes('repository'));
  const missing = await server(request(3, 'tools/call', { name: 'list_runs', arguments: {} }));
  assert.equal(missing.result.isError, true);
  const selected = await server(request(4, 'tools/call', {
    name: 'list_runs',
    arguments: { repository: 'DaisukeDaisuke/local-mcp-chatgpt-tunnel' }
  }));
  assert.equal(selected.result.isError, false);
  assert.deepEqual(commands, [[
    'run', 'list', '--repo', 'DaisukeDaisuke/local-mcp-chatgpt-tunnel', '--branch', 'main', '--limit', '3'
  ]]);
});

test('gh-workflow exposes only read-only workflow inspection tools', async () => {
  const { createServer } = await importGhWorkflow(['--repository=DaisukeDaisuke/desmume_webassembly'], 'tools');
  const server = createServer({ execute: async () => ({ stdout: '', stderr: '', exitCode: 0 }) });
  await server(request(1, 'initialize'));
  const listed = await server(request(2, 'tools/list'));
  const names = listed.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    'list_runs',
    'watch_run',
    'view_run',
    'view_run_jobs',
    'view_run_logs',
    'view_failed_logs',
    'list_workflows',
    'view_workflow',
    'view_workflow_yaml'
  ]);
  for (const tool of listed.result.tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    });
  }
});

test('gh-workflow builds the requested fixed gh run commands without a shell', async () => {
  const { createServer } = await importGhWorkflow(['--repository=DaisukeDaisuke/desmume_webassembly'], 'commands');
  const commands = [];
  const server = createServer({
    execute: async (args) => {
      commands.push(args);
      return { command: ['gh', ...args], stdout: '', stderr: '', exitCode: 0 };
    }
  });
  await server(request(1, 'initialize'));
  await server(request(2, 'tools/call', { name: 'list_runs', arguments: {} }));
  await server(request(3, 'tools/call', { name: 'watch_run', arguments: { runId: '123456789' } }));
  await server(request(4, 'tools/call', { name: 'view_run', arguments: { runId: '123456789' } }));
  assert.deepEqual(commands, [
    ['run', 'list', '--repo', 'DaisukeDaisuke/desmume_webassembly', '--branch', 'main', '--limit', '3'],
    ['run', 'watch', '123456789', '--repo', 'DaisukeDaisuke/desmume_webassembly', '--exit-status'],
    ['run', 'view', '123456789', '--repo', 'DaisukeDaisuke/desmume_webassembly']
  ]);
});

test('gh-workflow rejects option-looking and shell-like tool arguments before execution', async () => {
  const { createServer } = await importGhWorkflow(['--repository=DaisukeDaisuke/desmume_webassembly'], 'injection');
  let executions = 0;
  const server = createServer({ execute: async () => { executions += 1; return {}; } });
  await server(request(1, 'initialize'));
  const branch = await server(request(2, 'tools/call', {
    name: 'list_runs',
    arguments: { branch: 'main; marker' }
  }));
  const workflow = await server(request(3, 'tools/call', {
    name: 'view_workflow',
    arguments: { workflow: '--help' }
  }));
  const runId = await server(request(4, 'tools/call', {
    name: 'watch_run',
    arguments: { runId: '1 & marker' }
  }));
  assert.equal(branch.result.isError, true);
  assert.equal(workflow.result.isError, true);
  assert.equal(runId.result.isError, true);
  assert.equal(executions, 0);
});

test('gh-workflow accepts the standard .github/workflows file path form', async () => {
  const { createServer } = await importGhWorkflow(['--repository=DaisukeDaisuke/desmume_webassembly'], 'workflow-path');
  const commands = [];
  const server = createServer({ execute: async (args) => { commands.push(args); return {}; } });
  await server(request(1, 'initialize'));
  const result = await server(request(2, 'tools/call', {
    name: 'view_workflow_yaml',
    arguments: { workflow: '.github/workflows/test.yml' }
  }));
  assert.equal(result.result.isError, false);
  assert.deepEqual(commands, [[
    'workflow', 'view', '.github/workflows/test.yml', '--repo', 'DaisukeDaisuke/desmume_webassembly', '--yaml'
  ]]);
});
