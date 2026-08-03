import { createMcpServer } from './src/mcp/stdio-server.mjs';
import { createTools } from './src/mcp/tools.mjs';
import { loadConfig } from './src/services/config-loader.mjs';
import { RuntimeManager } from './src/services/runtime-manager.mjs';
import { RunService } from './src/services/run-service.mjs';
import { ArtifactStore } from './src/runtime/artifact-store.mjs';

const configPath = process.env.DQ9_TEST_CONFIG ?? new URL('./config/local-runtime.json', import.meta.url);
const allowedSuiteRoots = JSON.parse(process.env.DQ9_ALLOWED_SUITE_ROOTS ?? '[]');
const workspaceRootMarker = process.env.DQ9_WORKSPACE_ROOT_MARKER ?? '.chatgpt-local-mcp-root';
const config = await loadConfig(configPath);
const runtimeManager = new RuntimeManager({ config });
const runService = new RunService({
  runtimeManager,
  artifactStore: new ArtifactStore(config.runtimeDirectory),
  allowedSuiteRoots,
  workspaceRootMarker
});
const server = createMcpServer({ tools: createTools({ runtimeManager, runService }) });

server.start(process.stdin, process.stdout);

const shutdown = async () => {
  await runtimeManager.stop();
  process.exitCode = 0;
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
