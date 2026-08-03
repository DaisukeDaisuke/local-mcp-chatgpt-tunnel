import { RelayError, errorEnvelope } from '../util/errors.mjs';

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const definitions = [
  { name: 'prepare_test_runtime', description: 'Prepare the single local Chrome/CDP battle runtime.', inputSchema: schema({ laneCount: { type: 'integer', minimum: 1 }, concurrency: { type: 'integer', minimum: 1 } }) },
  { name: 'run_cases', description: 'Start an asynchronous local JSON battle-command suite.', inputSchema: schema({ suitePath: { type: 'string', minLength: 1 } }, ['suitePath']) },
  { name: 'get_run_status', description: 'Get bounded status and results for one run.', inputSchema: schema({ runId: { type: 'string', minLength: 1 } }, ['runId']) },
  { name: 'rerun_incident', description: 'Reserved for later incident reruns; unsupported in this milestone.', inputSchema: schema({ incidentId: { type: 'string' } }) },
  { name: 'stop_test_runtime', description: 'Idempotently close admission and stop this runtime-owned Chrome process.', inputSchema: schema({}) }
];

const content = (envelope) => ({ content: [{ type: 'text', text: JSON.stringify(envelope) }], structuredContent: envelope, isError: !envelope.ok });

export const createTools = ({ runtimeManager, runService }) => ({
  list: () => definitions,
  async call(name, args = {}) {
    try {
      let result;
      switch (name) {
        case 'prepare_test_runtime': result = await runtimeManager.prepare(args); break;
        case 'run_cases': result = await runService.start(args.suitePath); break;
        case 'get_run_status': result = runService.getStatus(args.runId); break;
        case 'rerun_incident': return content(errorEnvelope(new RelayError('notImplementedForMilestone', 'Incident reruns are not implemented in this milestone')));
        case 'stop_test_runtime': result = await runtimeManager.stop(); break;
        default: return content(errorEnvelope({ code: 'TOOL_NOT_FOUND', message: `Unknown tool: ${name}` }));
      }
      return content({ ok: true, result });
    } catch (error) {
      return content(errorEnvelope(error));
    }
  }
});
