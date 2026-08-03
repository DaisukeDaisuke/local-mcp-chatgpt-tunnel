import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { contractVersion, publicTools, validateContractRecord, validateToolEnvelope } from '../src/schemas/contract-validator.mjs';

const common = { schemaVersion: contractVersion, createdAt: '2026-08-02T00:00:00.000Z', provenance: 'phase-0-fixture', confidence: 'confirmed' };
const fixtures = {
  run: { ...common, runId: 'run-1', runtimeId: 'runtime-1', runtimeEpoch: 'epoch-1', suiteId: 'suite-1', suiteKind: 'random', suiteRef: 'suite.json', requestedConcurrency: 1, effectiveConcurrency: 1, stopOnFirstMismatch: true, incidentPolicy: 'save-only', state: 'queued', dispatchOpen: true, statusVersion: 0, caseCounts: {}, incidentIds: [], stopTriggerCaseId: null, startedAt: null, completedAt: null, durationMs: null, buildId: 'build-1', baselineId: 'baseline-1', staticContractSetId: 'static-1' },
  workerLane: { ...common, workerId: 'worker-1', laneId: 'lane-1', runtimeEpoch: 'epoch-1', state: 'ready', health: 'healthy', recoveryGeneration: 0, leaseId: null, browserPid: null, browserStartedAt: null, childPid: null, cdpEndpointRef: 'cdp-ref', portLeases: {}, profileDir: 'profile', workDir: 'work', stateNamespace: 'state', baselineSlot: 'baseline', lastHeartbeatAt: null, lastError: null, quarantineReason: null },
  case: { ...common, caseId: 'case-1', runId: 'run-1', suiteOrdinal: 0, suiteKind: 'random', inputRef: 'input.json', inputSha256: 'a'.repeat(64), parserProfile: 'default', seed: null, initialRngPosition: null, expectedRef: null, actualRef: null, workerId: null, leaseId: 'lease-1', attempt: 1, state: 'queued', outcome: 'pending', firstMismatchId: null, startedAt: null, completedAt: null, durationMs: null, exit: null },
  build: { ...common, buildId: 'build-1', profile: 'release-with-debug-info', configuredAt: '2026-08-02T00:00:00.000Z', builtAt: '2026-08-02T00:00:01.000Z', cmakePath: 'cmake', cmakeVersion: '1', ninjaVersion: '1', ninjaPath: null, sourceRootRef: 'source', configureArgs: [], targets: [], executables: [], sourceFingerprint: 'fingerprint', staticAssetFingerprints: {}, validationState: 'not-run', validationErrors: [] },
  state: { ...common, stateId: 'state-1', kind: 'baseline', slotName: 'slot', workerId: 'worker-1', runtimeEpoch: 'epoch-1', fileRef: null, sha256: null, byteLength: null, romIdentity: 'rom', romSha256: 'b'.repeat(64), frame: null, stateLoadSerial: null, fileTransactionSerial: null, windowId: null, rngSeed: null, rngPosition: null, partySummary: {}, enemySummary: {}, captureComplete: false, serializable: null, failureReason: null },
  actionEvent: { ...common, eventId: 'event-1', eventOrdinal: 0, checkpoint: 'before', windowId: 'window-1', side: 'ally', actionId: null, selector: null, lookupId: null, handlerAddress: null, damage: null, allyHpAfter: null, enemyHpAfter: null, status: {}, rngPositionAfter: null, regions: [], complete: true, violation: null, overflow: false },
  rngCall: { ...common, callOrdinal: 0, api: 'next', entry: '0x0010', complete: false, incompleteReason: null, caller: {}, arguments: {}, region: 'damage', seedBefore: null, seedAfter: null, advanceCount: null, advances: [] },
  mismatch: { ...common, mismatchId: 'mismatch-1', caseId: 'case-1', eventOrdinal: 0, comparisonOrdinal: 0, field: 'damage', classification: 'difference', expected: null, actual: null, expectedEventRef: 'expected.json', actualEventRef: 'actual.json', rngFirstDifference: null, stopOnFirstMismatchTriggered: true },
  incident: { ...common, incidentId: 'incident-1', caseId: 'case-1', mismatchId: 'mismatch-1', commitState: 'committed', beforeStateId: null, afterStateId: null, failureStateId: null, reproduceRef: 'reproduce.json', expectedRef: 'expected.json', actualRef: 'actual.json', staticContractRef: 'static.json', rngCallsRef: null, rngAgentSummaryRef: null, unknownCallers: [], classification: 'difference', firstDifference: {}, traceComplete: null, overflow: false, rerunId: null, rerunWorkerId: null, rerunAttempt: null, debugRouteRef: null },
  clionDebugRoute: { ...common, routeId: 'route-1', incidentId: 'incident-1', runConfiguration: 'debug', target: 'target', executableRef: 'runner.exe', arguments: [], workingDirectory: 'work', primaryBreakpoint: {}, secondarySymbols: [], watches: [], regionRoute: 'damage', launchPolicy: 'manual-on-demand' }
};

const requests = {
  prepare_test_runtime: { laneCount: 1, buildProfile: 'release-with-debug-info', artifactRoot: 'C:\\artifacts', suiteBaseline: {}, forceReprepare: false },
  run_cases: { runtimeId: 'runtime-1', suite: {}, concurrency: 1, stopOnFirstMismatch: true, incidentPolicy: 'save-only' },
  get_run_status: { runId: 'run-1', caseCursor: null, caseLimit: 100 },
  rerun_incident: { incidentId: 'incident-1', traceMode: 'detailed-rng', laneHint: null, priority: 'incident' },
  stop_test_runtime: { runtimeId: 'runtime-1', mode: 'graceful', graceMs: 30000 }
};

test('Phase-0 schema parses and every record fixture round-trips with required nulls', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/dq9-test-contract-v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.$id, 'https://local.invalid/dq9-test-contract-v1.schema.json');
  for (const [recordType, fixture] of Object.entries(fixtures)) {
    const roundTrip = JSON.parse(JSON.stringify(fixture));
    assert.equal(validateContractRecord(recordType, roundTrip), roundTrip, recordType);
  }
});

test('all record families reject omitted required-null fields and unsafe integers', () => {
  for (const [recordType, fixture] of Object.entries(fixtures)) {
    const missing = structuredClone(fixture);
    const requiredKey = Object.keys(missing).find((key) => missing[key] === null) ?? Object.keys(missing)[0];
    delete missing[requiredKey];
    assert.throws(() => validateContractRecord(recordType, missing), { code: 'CONTRACT_VALIDATION_FAILED' }, `${recordType} omitted ${requiredKey}`);
  }
  assert.throws(() => validateContractRecord('run', { ...fixtures.run, requestedConcurrency: Number.MAX_SAFE_INTEGER + 1 }), { code: 'CONTRACT_VALIDATION_FAILED' });
  assert.throws(() => validateContractRecord('rngCall', { ...fixtures.rngCall, entry: '0X10' }), { code: 'CONTRACT_VALIDATION_FAILED' });
});

test('five public tool envelope families accept round-trips and reject malformed required values', () => {
  assert.deepEqual(publicTools, ['prepare_test_runtime', 'run_cases', 'get_run_status', 'rerun_incident', 'stop_test_runtime']);
  for (const toolName of publicTools) {
    const request = JSON.parse(JSON.stringify(requests[toolName]));
    assert.equal(validateToolEnvelope(toolName, 'request', request), request);
    const success = { ok: true, value: { accepted: true } };
    const failure = { ok: false, error: { code: 'artifactCommitFailed', message: 'commit failed', recoverable: true, details: {} } };
    assert.equal(validateToolEnvelope(toolName, 'response', success), success);
    assert.equal(validateToolEnvelope(toolName, 'response', failure), failure);
    const missing = structuredClone(request);
    delete missing[Object.keys(missing)[0]];
    assert.throws(() => validateToolEnvelope(toolName, 'request', missing), { code: 'CONTRACT_VALIDATION_FAILED' });
  }
  assert.throws(() => validateToolEnvelope('run_cases', 'response', { ok: false, error: { code: 'unknown', message: 'x', recoverable: false, details: {} } }), { code: 'CONTRACT_VALIDATION_FAILED' });
});
