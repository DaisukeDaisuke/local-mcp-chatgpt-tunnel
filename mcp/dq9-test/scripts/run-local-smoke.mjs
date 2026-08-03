import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createTools } from '../src/mcp/tools.mjs';
import { loadConfig } from '../src/services/config-loader.mjs';
import { RuntimeManager } from '../src/services/runtime-manager.mjs';
import { RunService } from '../src/services/run-service.mjs';
import { ArtifactStore } from '../src/runtime/artifact-store.mjs';

const configPath = new URL('../config/local-runtime.json', import.meta.url);
const config = await loadConfig(configPath);
const stderrProgress = ({ stage, event, code }) => process.stderr.write(`[smoke] ${stage} ${event}${code ? ` ${code}` : ''}\n`);
const runtimeManager = new RuntimeManager({ config, progress: stderrProgress, stageTimeouts: { browserLaunch: 30000, browserEndpoint: 30000, navigation: 60000, romLoad: 60000, stateLoad: 60000, scriptLoad: 30000, handlerPublication: 60000 } });
const examplesRoot = fileURLToPath(new URL('../examples', import.meta.url));
const runService = new RunService({ runtimeManager, artifactStore: new ArtifactStore(config.runtimeDirectory), allowedSuiteRoots: [examplesRoot] });
const tools = createTools({ runtimeManager, runService });
const summaryPath = new URL('../../agent_work/20260802-071718-dq9-mcp-foundation/node-cdp-foundation/integration-summary.json', import.meta.url);

const withDeadline = (stage, timeoutMs, operation) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${stage} deadline exceeded`)), timeoutMs);
  operation.then(resolve, reject).finally(() => clearTimeout(timer));
});
const pollRun = async (runId) => {
  for (let attempts = 0; attempts < 120; attempts += 1) {
    const status = await tools.call('get_run_status', { runId });
    const value = status.structuredContent.result.status;
    if (['completed', 'failed', 'stopped'].includes(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('suite status deadline exceeded');
};

let summary = { prepared: false, runId: null, terminalStatus: null, stopped: false, error: null, failedStage: null };
try {
  process.stderr.write('[smoke] overall start\n');
  const prepared = await withDeadline('prepare', 180000, tools.call('prepare_test_runtime', {}));
  if (!prepared.structuredContent.ok) {
    const error = new Error(prepared.structuredContent.error.code);
    error.details = prepared.structuredContent.error.details;
    throw error;
  }
  summary.prepared = true;
  process.stderr.write('[smoke] suite start\n');
  const started = await tools.call('run_cases', { suitePath: fileURLToPath(new URL('../examples/actions.example.json', import.meta.url)) });
  if (!started.structuredContent.ok) {
    const error = new Error(started.structuredContent.error.code);
    error.details = started.structuredContent.error.details;
    throw error;
  }
  summary.runId = started.structuredContent.result.runId;
  summary.terminalStatus = await withDeadline('suite', 70000, pollRun(summary.runId));
} catch (error) {
  summary.error = error.message;
  summary.failedStage = error.details?.stage ?? (error.message.includes('suite') ? 'suite' : 'prepare');
  process.stderr.write(`[smoke] ${summary.failedStage} error ${summary.error}\n`);
} finally {
  const stopped = await withDeadline('stop', 15000, tools.call('stop_test_runtime', {}));
  summary.stopped = stopped.structuredContent.ok === true;
  process.stderr.write('[smoke] stop complete\n');
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}
if (summary.error || summary.terminalStatus !== 'completed') process.exitCode = 1;
