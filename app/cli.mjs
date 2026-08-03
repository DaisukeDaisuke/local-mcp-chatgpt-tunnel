import { Agent, run, setDefaultOpenAIClient, setOpenAIAPI } from '@openai/agents';
import { loadAppConfig, assertBillableApiEnabled } from './config.mjs';
import { createMcpServers } from './mcp-servers.mjs';
import { createOpenAIClient } from './openai-client.mjs';

const prompt = process.argv.slice(2).join(' ').trim();
if (!prompt) throw new Error('Pass one prompt, for example: npm run ask -- "Prepare the DQ9 runtime and inspect the current page"');

const config = await loadAppConfig();
assertBillableApiEnabled(config);
setDefaultOpenAIClient(await createOpenAIClient(config));
setOpenAIAPI('responses');

const servers = createMcpServers();
await Promise.all(servers.map((server) => server.connect()));
try {
  const agent = new Agent({
    name: 'Local DQ9 Development Assistant',
    model: config.model,
    instructions: [
      'Use only the attached MCP tools.',
      'There is no host shell or arbitrary-command tool.',
      'Use the files server only inside its configured roots and keep all text UTF-8.',
      'Call dq9 prepare_test_runtime before using Chrome tools against the DeSmuME page.',
      'The DQ9 runtime is single-lane. Never request parallel DQ9 or Chrome mutations.',
      'Never call Ghidra run_ghidra_script or run_script_inline; those tools are blocked.',
      'Do not reveal secrets, certificate material, API keys, or SSH key contents.'
    ].join('\n'),
    mcpServers: servers,
    mcpConfig: { includeServerInToolNames: true },
    modelSettings: { parallelToolCalls: false }
  });
  const result = await run(agent, prompt, {
    maxTurns: config.maxTurns,
    toolExecution: { maxFunctionToolConcurrency: 1 }
  });
  process.stdout.write(`${result.finalOutput ?? ''}\n`);
} finally {
  await Promise.allSettled(servers.map((server) => server.close()));
}
