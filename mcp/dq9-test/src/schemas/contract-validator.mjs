import { RelayError } from '../util/errors.mjs';
import { isPlainObject } from '../util/json.mjs';

export const contractVersion = 'dq9-test-contract-v1';
export const confidenceValues = Object.freeze(['confirmed', 'supported', 'candidate', 'unknown', 'rejected']);
export const exitCategories = Object.freeze(['ok', 'invalidRequest', 'configuration', 'dependencyMismatch', 'buildFailed', 'executionFailed', 'artifactCommitFailed', 'internal']);
export const publicTools = Object.freeze(['prepare_test_runtime', 'run_cases', 'get_run_status', 'rerun_incident', 'stop_test_runtime']);

const maxArrayLength = 256;
const maxStringLength = 4096;
const forbiddenBodyKey = /(?:^|_)(?:rom|save|state|memory)(?:_|$).*(?:body|bytes|dump|data)|(?:body|bytes|dump|data).*(?:rom|save|state|memory)/i;
const fail = (message) => { throw new RelayError('CONTRACT_VALIDATION_FAILED', message); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const string = (value, label, nullable = false) => {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxStringLength) fail(`${label} must be a bounded non-empty string${nullable ? ' or null' : ''}`);
};
const integer = (value, label, nullable = false) => {
  if (nullable && value === null) return;
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer${nullable ? ' or null' : ''}`);
};
const boolean = (value, label, nullable = false) => {
  if (nullable && value === null) return;
  if (typeof value !== 'boolean') fail(`${label} must be boolean${nullable ? ' or null' : ''}`);
};
const object = (value, label, nullable = false) => {
  if (nullable && value === null) return;
  if (!isPlainObject(value)) fail(`${label} must be an object${nullable ? ' or null' : ''}`);
  if (Object.keys(value).length > maxArrayLength) fail(`${label} has too many properties`);
};
const array = (value, label, nullable = false) => {
  if (nullable && value === null) return;
  if (!Array.isArray(value) || value.length > maxArrayLength) fail(`${label} must be a bounded array${nullable ? ' or null' : ''}`);
};
const hex = (value, label, nullable = false) => {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/.test(value)) fail(`${label} must be a lowercase 0x string${nullable ? ' or null' : ''}`);
};
const timestamp = (value, label, nullable = false) => {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) fail(`${label} must be an RFC3339 UTC timestamp${nullable ? ' or null' : ''}`);
};
const enumValue = (value, label, values, nullable = false) => {
  if (nullable && value === null) return;
  if (!values.includes(value)) fail(`${label} must be one of ${values.join(', ')}${nullable ? ' or null' : ''}`);
};
const boundedJson = (value, label, depth = 0) => {
  if (depth > 8) fail(`${label} is nested too deeply`);
  if (typeof value === 'string') return string(value, label);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') return integer(value, label);
  if (Array.isArray(value)) { array(value, label); value.forEach((entry, index) => boundedJson(entry, `${label}[${index}]`, depth + 1)); return; }
  object(value, label);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenBodyKey.test(key)) fail(`${label}.${key} must not contain a prohibited data body`);
    boundedJson(child, `${label}.${key}`, depth + 1);
  }
};
const fields = (value, label, definitions) => {
  object(value, label);
  const allowed = new Set(Object.keys(definitions));
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key} is not defined by ${contractVersion}`);
  for (const [key, checker] of Object.entries(definitions)) {
    if (!own(value, key)) fail(`${label}.${key} is required; use null when the contract permits unavailable data`);
    checker(value[key], `${label}.${key}`);
  }
  return value;
};
const nullableString = (value, label) => string(value, label, true);
const nullableInteger = (value, label) => integer(value, label, true);
const nullableBoolean = (value, label) => boolean(value, label, true);
const nullableObject = (value, label) => object(value, label, true);
const nullableHex = (value, label) => hex(value, label, true);
const nullableTimestamp = (value, label) => timestamp(value, label, true);
const nullableArray = (value, label) => array(value, label, true);
const requiredObject = (value, label) => { object(value, label); boundedJson(value, label); };
const requiredArray = (value, label) => { array(value, label); value.forEach((entry, index) => boundedJson(entry, `${label}[${index}]`)); };

const common = {
  schemaVersion: (value, label) => enumValue(value, label, [contractVersion]),
  createdAt: timestamp,
  provenance: string,
  confidence: (value, label) => enumValue(value, label, confidenceValues)
};
const withCommon = (definition) => ({ ...common, ...definition });
const stateValues = ['queued', 'running', 'stopping', 'completed', 'failed', 'stopped'];
const suiteKinds = ['random', 'coverage', 'parser'];
const fileRef = nullableString;

const recordValidators = {
  run: (value) => fields(value, 'run', withCommon({
    runId: string, runtimeId: string, runtimeEpoch: string, suiteId: string, suiteKind: (v, l) => enumValue(v, l, suiteKinds), suiteRef: string,
    requestedConcurrency: integer, effectiveConcurrency: integer, stopOnFirstMismatch: boolean, incidentPolicy: (v, l) => enumValue(v, l, ['save-only', 'enqueue-rerun']),
    state: (v, l) => enumValue(v, l, stateValues), dispatchOpen: boolean, statusVersion: integer, caseCounts: requiredObject, incidentIds: requiredArray,
    stopTriggerCaseId: nullableString, startedAt: nullableTimestamp, completedAt: nullableTimestamp, durationMs: nullableInteger,
    buildId: string, baselineId: string, staticContractSetId: string
  })),
  workerLane: (value) => fields(value, 'workerLane', withCommon({
    workerId: string, laneId: string, runtimeEpoch: string, state: string, health: string, recoveryGeneration: integer, leaseId: nullableString,
    browserPid: nullableInteger, browserStartedAt: nullableTimestamp, childPid: nullableInteger, cdpEndpointRef: string, portLeases: requiredObject,
    profileDir: string, workDir: string, stateNamespace: string, baselineSlot: string, lastHeartbeatAt: nullableTimestamp, lastError: nullableObject, quarantineReason: nullableString
  })),
  case: (value) => fields(value, 'case', withCommon({
    caseId: string, runId: string, suiteOrdinal: integer, suiteKind: (v, l) => enumValue(v, l, suiteKinds), inputRef: string, inputSha256: string, parserProfile: string,
    seed: nullableHex, initialRngPosition: nullableHex, expectedRef: fileRef, actualRef: fileRef, workerId: nullableString, leaseId: string, attempt: integer,
    state: string, outcome: string, firstMismatchId: nullableString, startedAt: nullableTimestamp, completedAt: nullableTimestamp, durationMs: nullableInteger, exit: nullableObject
  })),
  build: (value) => fields(value, 'build', withCommon({
    buildId: string, profile: string, configuredAt: timestamp, builtAt: timestamp, cmakePath: string, cmakeVersion: string, ninjaVersion: string, ninjaPath: nullableString,
    sourceRootRef: string, configureArgs: requiredArray, targets: requiredArray, executables: requiredArray, sourceFingerprint: string, staticAssetFingerprints: requiredObject,
    validationState: string, validationErrors: requiredArray
  })),
  state: (value) => fields(value, 'state', withCommon({
    stateId: string, kind: string, slotName: string, workerId: string, runtimeEpoch: string, fileRef, sha256: nullableString, byteLength: nullableInteger,
    romIdentity: string, romSha256: string, frame: nullableInteger, stateLoadSerial: nullableInteger, fileTransactionSerial: nullableInteger,
    windowId: nullableString, rngSeed: nullableHex, rngPosition: nullableHex, partySummary: requiredObject, enemySummary: requiredObject,
    captureComplete: boolean, serializable: nullableBoolean, failureReason: nullableString
  })),
  actionEvent: (value) => fields(value, 'actionEvent', withCommon({
    eventId: string, eventOrdinal: integer, checkpoint: string, windowId: string, side: string, actionId: nullableInteger, selector: nullableInteger,
    lookupId: nullableInteger, handlerAddress: nullableHex, damage: nullableInteger, allyHpAfter: nullableInteger, enemyHpAfter: nullableInteger,
    status: requiredObject, rngPositionAfter: nullableHex, regions: requiredArray, complete: boolean, violation: nullableString, overflow: boolean
  })),
  rngCall: (value) => fields(value, 'rngCall', withCommon({
    callOrdinal: integer, api: string, entry: hex, complete: boolean, incompleteReason: nullableString, caller: requiredObject, arguments: requiredObject,
    region: string, seedBefore: nullableHex, seedAfter: nullableHex, advanceCount: nullableInteger, advances: requiredArray
  })),
  mismatch: (value) => fields(value, 'mismatch', withCommon({
    mismatchId: string, caseId: string, eventOrdinal: integer, comparisonOrdinal: integer, field: string, classification: string,
    expected: boundedJson, actual: boundedJson, expectedEventRef: string, actualEventRef: string, rngFirstDifference: nullableObject, stopOnFirstMismatchTriggered: boolean
  })),
  incident: (value) => fields(value, 'incident', withCommon({
    incidentId: string, caseId: string, mismatchId: string, commitState: (v, l) => enumValue(v, l, ['staged', 'closed', 'committed', 'failed']),
    beforeStateId: nullableString, afterStateId: nullableString, failureStateId: nullableString, reproduceRef: string, expectedRef: string, actualRef: string,
    staticContractRef: string, rngCallsRef: nullableString, rngAgentSummaryRef: nullableString, unknownCallers: requiredArray,
    classification: string, firstDifference: requiredObject, traceComplete: nullableBoolean, overflow: boolean, rerunId: nullableString, rerunWorkerId: nullableString,
    rerunAttempt: nullableInteger, debugRouteRef: nullableString
  })),
  clionDebugRoute: (value) => fields(value, 'clionDebugRoute', withCommon({
    routeId: string, incidentId: string, runConfiguration: string, target: string, executableRef: string, arguments: requiredArray, workingDirectory: string,
    primaryBreakpoint: requiredObject, secondarySymbols: requiredArray, watches: requiredArray,
    regionRoute: (v, l) => enumValue(v, l, ['damage', 'postAction', 'outside', 'selector-or-rng-rounding']), launchPolicy: (v, l) => enumValue(v, l, ['manual-on-demand'])
  }))
};

const requestValidators = {
  prepare_test_runtime: (value) => fields(value, 'prepare_test_runtime request', {
    laneCount: (v, l) => { integer(v, l); if (v < 1 || v > 5) fail(`${l} must be 1 through 5`); }, buildProfile: string, artifactRoot: string,
    suiteBaseline: requiredObject, forceReprepare: boolean
  }),
  run_cases: (value) => fields(value, 'run_cases request', {
    runtimeId: string, suite: requiredObject, concurrency: (v, l) => { integer(v, l); if (v < 1 || v > 5) fail(`${l} must be 1 through 5`); },
    stopOnFirstMismatch: boolean, incidentPolicy: (v, l) => enumValue(v, l, ['save-only', 'enqueue-rerun'])
  }),
  get_run_status: (value) => fields(value, 'get_run_status request', { runId: string, caseCursor: nullableString, caseLimit: (v, l) => { integer(v, l); if (v < 1 || v > 256) fail(`${l} must be 1 through 256`); } }),
  rerun_incident: (value) => fields(value, 'rerun_incident request', { incidentId: string, traceMode: (v, l) => enumValue(v, l, ['detailed-rng']), laneHint: nullableString, priority: (v, l) => enumValue(v, l, ['incident']) }),
  stop_test_runtime: (value) => fields(value, 'stop_test_runtime request', { runtimeId: string, mode: (v, l) => enumValue(v, l, ['graceful']), graceMs: (v, l) => { integer(v, l); if (v < 0) fail(`${l} must not be negative`); } })
};

const errorCodes = new Set(['invalidRequest', 'prepareBusy', 'buildFailed', 'executableMissing', 'cdpClientUnavailable', 'browserLaunchFailed', 'apiContractMismatch', 'baselineRejected', 'insufficientReadyLanes', 'runtimeNotPrepared', 'runtimeEpochMismatch', 'suiteInvalid', 'concurrencyUnavailable', 'runAdmissionClosed', 'artifactCommitFailed', 'runNotFound', 'invalidCursor', 'artifactReadFailed', 'incidentNotFound', 'incidentNotCommitted', 'beforeStateUnavailable', 'identityMismatch', 'noHealthyLane', 'traceContractViolation', 'traceOverflow', 'rerunFailed', 'runtimeNotFound', 'stopTimeout', 'processOwnershipMismatch', 'notImplementedForMilestone']);
export const validateToolEnvelope = (toolName, direction, value) => {
  if (!publicTools.includes(toolName)) fail(`Unknown public tool ${toolName}`);
  if (direction === 'request') return requestValidators[toolName](value);
  if (direction !== 'response') fail('Envelope direction must be request or response');
  object(value, `${toolName} response`);
  if (value.ok === true) {
    fields(value, `${toolName} response`, { ok: boolean, value: requiredObject });
    return value;
  }
  fields(value, `${toolName} response`, {
    ok: boolean,
    error: (error, label) => {
      fields(error, label, { code: (code, codeLabel) => { string(code, codeLabel); if (!errorCodes.has(code)) fail(`${codeLabel} is not a frozen error code`); }, message: string, recoverable: boolean, details: requiredObject });
    }
  });
  if (value.ok !== false) fail(`${toolName} response.ok must be true or false`);
  return value;
};

export const validateContractRecord = (recordType, value) => {
  const validator = recordValidators[recordType];
  if (!validator) fail(`Unknown contract record type ${recordType}`);
  validator(value);
  return value;
};
