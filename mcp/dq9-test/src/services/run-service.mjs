import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { documentedBattleHandlers } from '../cdp/desmume-adapter.mjs';
import { RelayError, asRelayError } from '../util/errors.mjs';
import { isPlainObject, parseJson } from '../util/json.mjs';

const allowedHandlers = new Set(documentedBattleHandlers);

export const validateSuite = (suite) => {
  if (!isPlainObject(suite) || !Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new RelayError('INVALID_SUITE', 'Suite must be an object with a non-empty cases array');
  }
  return suite.cases.map((testCase, index) => {
    if (!isPlainObject(testCase) || !Array.isArray(testCase.steps) || testCase.steps.length === 0) {
      throw new RelayError('INVALID_SUITE', `Case ${index} must contain a non-empty steps array`);
    }
    if (testCase.reloadState !== undefined && typeof testCase.reloadState !== 'boolean') {
      throw new RelayError('INVALID_SUITE', `Case ${index}.reloadState must be boolean`);
    }
    return {
      id: typeof testCase.id === 'string' && testCase.id ? testCase.id : `case-${index + 1}`,
      reloadState: testCase.reloadState === true,
      entities: Array.isArray(testCase.entities) ? testCase.entities : [],
      steps: testCase.steps.map((step, stepIndex) => {
        if (!isPlainObject(step) || typeof step.handler !== 'string' || !allowedHandlers.has(step.handler)) {
          throw new RelayError('HANDLER_NOT_ALLOWED', `Case ${index} step ${stepIndex} uses an unsupported handler`, { handler: step?.handler, allowed: documentedBattleHandlers });
        }
        if (step.params !== undefined && !isPlainObject(step.params)) throw new RelayError('INVALID_SUITE', `Case ${index} step ${stepIndex}.params must be an object`);
        return { handler: step.handler, params: step.params ?? {}, timeoutMs: step.timeoutMs };
      })
    };
  });
};

export class RunService {
  constructor({ runtimeManager, artifactStore, readFileImpl = readFile } = {}) {
    this.runtimeManager = runtimeManager;
    this.artifactStore = artifactStore;
    this.readFileImpl = readFileImpl;
    this.runs = new Map();
    this.runtimeManager.onStopping?.(() => this.#markStopped());
  }

  async start(suitePath) {
    if (typeof suitePath !== 'string' || !suitePath) throw new RelayError('INVALID_SUITE_PATH', 'suitePath must be a local JSON file path');
    const resolvedPath = resolve(suitePath);
    let source;
    try { source = await this.readFileImpl(resolvedPath, 'utf8'); }
    catch { throw new RelayError('SUITE_NOT_FOUND', 'Suite file is not readable', { path: resolvedPath }); }
    const cases = validateSuite(parseJson(source, 'Suite'));
    const runId = crypto.randomUUID();
    const run = { runId, suitePath: resolvedPath, status: 'queued', createdAt: new Date().toISOString(), cases: [], error: null };
    this.runs.set(runId, run);
    void this.#execute(run, cases);
    return { runId, status: run.status };
  }

  getStatus(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new RelayError('RUN_NOT_FOUND', 'Run was not found', { runId });
    return { ...run };
  }

  async #execute(run, cases) {
    run.status = 'running';
    try {
      await this.runtimeManager.withRuntime(async (runtime) => {
        for (const testCase of cases) {
          const caseResult = { id: testCase.id, status: 'running', steps: [] };
          run.cases.push(caseResult);
          if (testCase.reloadState) {
            const recovery = await runtime.adapter.applyExactStateAndReset(this.runtimeManager.config.statePath, runtime.roles);
            runtime.roles = recovery.registry;
            runtime.scriptId = runtime.roles.command.scriptId;
            await runtime.adapter.resumeOnly();
            await runtime.adapter.pollCommandReady(runtime.roles);
            const sessionId = `${run.runId}-${testCase.id}`;
            const configured = await runtime.adapter.callRole(runtime.roles, 'observer', 'observerConfigure', { sessionId, sessionKind: 'rewind', profile: runtime.profilePayload }, 90000, 100000);
            if (!['recovered', 'captured'].includes(configured.value.initialSeed?.initialSeedStatus)) throw new RelayError('INITIAL_SEED_UNRESOLVED', 'Initial seed must be unique before semantic action', { initialSeed: configured.value.initialSeed });
            await runtime.adapter.callRole(runtime.roles, 'incident', 'incidentConfigure', { profile: runtime.profilePayload, initialSeedK: configured.value.initialSeed.initialSeedK }, 90000, 100000);
            const incident = await runtime.adapter.callRole(runtime.roles, 'incident', 'incidentStatus', {}, 10000, 15000);
            if (incident.value.armed || incident.value.hookInventory?.active !== 0) throw new RelayError('INCIDENT_ACTIVE_DURING_NORMAL_RUN', 'Incident detail hooks are active during normal run');
          }
          for (const step of testCase.steps) {
            if (['confirmCommand', 'listOptions', 'confirmOption'].includes(step.handler)) await runtime.adapter.pollCommandReady(runtime.roles);
            if (step.handler === 'confirmOption') {
              if (testCase.entities.length === 0) throw new RelayError('OBSERVER_ENTITIES_REQUIRED', 'Semantic action requires bounded entities');
              const checkpointReference = `turn-${run.runId}-${testCase.id}-${caseResult.steps.length}`;
              caseResult.turnCheckpoint = await runtime.adapter.createTurnCheckpoint(checkpointReference);
              await runtime.adapter.pollCommandReady(runtime.roles);
              await runtime.adapter.callRole(runtime.roles, 'observer', 'observerArm', { actionId: `${testCase.id}-${caseResult.steps.length}`, caseId: testCase.id, checkpointReference, entities: testCase.entities }, 10000, 15000);
            }
            const response = await runtime.adapter.callBattle(runtime.scriptId, step.handler, step.params, step.timeoutMs);
            const stepResult = { handler: step.handler, transportOk: response.transport.ok, handlerStatus: response.handlerStatus };
            caseResult.steps.push(stepResult);
            if (response.handlerStatus !== 'ok') {
              caseResult.status = 'handler-outcome';
              run.status = 'failed';
              return;
            }
            if (step.handler === 'confirmOption') {
              const observer = await runtime.adapter.callRole(runtime.roles, 'observer', 'observerRead', {}, 10000, 15000);
              const events = observer.value.events ?? [];
              const concrete = (event) => event.complete && event.hpMutations?.some((mutation) => mutation.delta?.some((item) => item.hp !== 0));
              const event = events.find(concrete) ?? events.find((item) => item.complete);
              const ui = await runtime.adapter.callRole(runtime.roles, 'command', 'seeUi', {}, 10000, 15000);
              if (!event?.complete || event.boundary?.completion !== 'primary_handler_after' || !ui.value.lastOperation) throw new RelayError('ACTION_COMPLETION_UNPROVEN', 'Expected transition, observer completion, and lastOperation conjunction is incomplete');
              caseResult.observerEvent = event;
            }
          }
          caseResult.status = 'passed';
          if (caseResult.observerEvent) {
            caseResult.caseArtifactPath = await this.artifactStore.saveCase({
              caseArtifactId: `${run.runId}-${testCase.id}`,
              runId: run.runId,
              caseId: testCase.id,
              kind: 'normal-observer',
              turnCheckpoint: caseResult.turnCheckpoint,
              event: caseResult.observerEvent
            });
          }
        }
        run.status = 'completed';
      });
    } catch (error) {
      if (run.status !== 'stopped') {
        run.status = 'failed';
        run.error = asRelayError(error).code;
      }
    } finally {
      run.finishedAt = new Date().toISOString();
      await this.artifactStore.saveRun(run);
    }
  }

  #markStopped() {
    for (const run of this.runs.values()) {
      if (run.status === 'queued' || run.status === 'running') {
        run.status = 'stopped';
        run.error = 'RUNTIME_STOPPED';
        run.finishedAt = new Date().toISOString();
      }
    }
  }
}
