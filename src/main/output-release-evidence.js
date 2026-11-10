'use strict';

// Pure parser/classifier. Importing or calling this module never accesses an
// endpoint or starts a process. Probe-child exit is not source-owner exit.
const ENDPOINT = /^\{0\.0\.0\.00000000\}\.\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}$/i;
const STAGES = new Set(['CreateDeviceEnumerator', 'GetDevice', 'GetId', 'GetState', 'Activate', 'CastAudioClient',
  'GetMixFormat', 'ReadMixFormat', 'Initialize', 'Complete']);
const SOURCES = new Set(['native-return', 'managed-exception', 'not-called']);
const ZERO = '0x00000000', IN_USE = '0x8889000A', NOT_FOUND = '0x80070490';
const DEVICE_STATES = new Set([1, 2, 4, 8]);
const text = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : null;
const stage = value => STAGES.has(value) ? value : null;
const integer = (value, max = 0xffffffff) => Number.isInteger(value) && value >= 0 && value <= max ? value : null;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeHresult(value) {
  let number = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^(?:0x[0-9a-f]{1,8}|-?\d{1,10})$/i.test(trimmed)) return null;
    number = Number(trimmed);
  }
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0xffffffff) return null;
  return `0x${(number >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

function describeHresult(value) {
  const hresult = normalizeHresult(value);
  if (hresult === null) return {hresult: null, facility: null, facilityName: null, statusCode: null, symbolName: null};
  const bits = Number(hresult), facility = (bits >>> 16) & 0x1fff;
  return {hresult, facility,
    // winerror.h facility names identify a number, not the failure's cause.
    facilityName: ({0: 'FACILITY_NULL', 7: 'FACILITY_WIN32', 2172: 'FACILITY_DIRECT3D11', 2185: 'FACILITY_AUDCLNT'})[facility] || null,
    statusCode: bits & 0xffff,
    symbolName: ({'0x00000000': 'S_OK', '0x80070490': 'ERROR_NOT_FOUND', '0x8889000A': 'AUDCLNT_E_DEVICE_IN_USE',
      '0x88890004': 'AUDCLNT_E_DEVICE_INVALIDATED', '0x88890008': 'AUDCLNT_E_UNSUPPORTED_FORMAT',
      '0x88890010': 'AUDCLNT_E_SERVICE_NOT_RUNNING'})[hresult] || null};
}

/**
 * result: JSON object or stdout whose last nonempty line is a JSON object.
 * Returns {classification: 'released'|'busy'|'unknown', trustedEndpoint, evidence}.
 * Unknown is always non-releasing. Another module may separately establish a
 * source-owner exit using its own branded proof; this module never does so.
 */
function parseOutputReleaseEvidence(input, {expectedEndpoint, processExited = false, exitCode = 0,
  aborted = false, timedOut = false} = {}) {
  let result = input, malformed = false;
  if (typeof result === 'string') {
    try {
      if (result.length > 65536) throw new Error('oversized probe output');
      result = JSON.parse(result.trim().split(/\r?\n/).filter(Boolean).at(-1));
    } catch { result = null; malformed = true; }
  }
  if (!record(result)) { result = {}; malformed = true; }
  const endpoint = text(result.endpoint, 100);
  const trustedEndpoint = !malformed && typeof expectedEndpoint === 'string' && ENDPOINT.test(expectedEndpoint) &&
    typeof endpoint === 'string' && ENDPOINT.test(endpoint) && endpoint.toLowerCase() === expectedEndpoint.toLowerCase() &&
    result.operation === 'Initialize' && result.mode === 'shared';
  const legacy = result.schemaVersion == null || result.schemaVersion === 1;
  const nativeResults = Array.isArray(result.nativeResults) ? result.nativeResults.slice(0, 12)
    .filter(record).map(row => ({stage: stage(row.stage), hresult: normalizeHresult(row.hresult)})) : [];
  const cleanupFailures = Array.isArray(result.cleanupFailures) ? result.cleanupFailures.slice(0, 12)
    .filter(record).map(row => ({resource: text(row.resource, 60), hresult: normalizeHresult(row.hresult), error: text(row.error)})) : [];
  const inferredNative = legacy && trustedEndpoint && !result.error && typeof result.initialized === 'boolean' &&
    (result.stage === undefined || result.stage === 'Initialize') &&
    (result.failureStage == null || result.failureStage === 'Initialize') &&
    (result.hresultSource === undefined || result.hresultSource === 'native-return') &&
    result.initializeCalled !== false && result.clientActivated !== false;
  const evidence = {schemaVersion: legacy ? 1 : integer(result.schemaVersion, 100), endpoint,
    observedEndpoint: typeof result.observedEndpoint === 'string' && ENDPOINT.test(result.observedEndpoint) ? result.observedEndpoint : null,
    endpointState: DEVICE_STATES.has(result.endpointState) ? result.endpointState : null,
    endpointStatus: 'unknown', endpointStatusVerified: false, initializeBoundaryVerified: false,
    operation: text(result.operation, 40), mode: text(result.mode, 30),
    stage: legacy && inferredNative ? 'Initialize' : stage(result.stage),
    failureStage: legacy && inferredNative && result.initialized === false ? 'Initialize' : stage(result.failureStage),
    ...describeHresult(result.hresult),
    hresultSource: inferredNative ? 'legacy-native-return-inferred' : SOURCES.has(result.hresultSource) ? result.hresultSource : null,
    nativeResults, clientActivated: inferredNative ? true : typeof result.clientActivated === 'boolean' ? result.clientActivated : null,
    initializeCalled: inferredNative ? true : typeof result.initializeCalled === 'boolean' ? result.initializeCalled : null,
    startCalled: legacy && result.startCalled === undefined ? false : typeof result.startCalled === 'boolean' ? result.startCalled : null,
    initialized: result.initialized === true, cleanupComplete: result.cleanupComplete === true,
    probeResourcesReleased: result.released === true, cleanupFailures,
    formatKind: text(result.formatKind, 80), mixRate: integer(result.mixRate),
    mixBits: integer(result.mixBits, 65535), mixChannels: integer(result.mixChannels, 65535),
    probeChildExited: processExited === true, probeExitCode: Number.isInteger(exitCode) ? exitCode : null,
    aborted: aborted === true, timedOut: timedOut === true, error: text(result.error),
    threadApartment: text(result.threadApartment, 20), actualDacRate: null,
    legacyInference: inferredNative, released: false, classification: 'unknown', reason: 'incomplete-evidence',
    exitMeaning: 'probe child only; no source-owner exit or identity proof'};
  const exitedCleanly = evidence.probeChildExited && evidence.probeExitCode === 0 && !evidence.aborted && !evidence.timedOut;
  const cleanupArrayValid = Array.isArray(result.cleanupFailures) && result.cleanupFailures.length === 0;
  const exactNativeSequence = (names, finalHresult = ZERO) => Array.isArray(result.nativeResults) &&
    result.nativeResults.length === names.length && nativeResults.length === names.length &&
    names.every((name, index) => nativeResults[index].stage === name &&
      nativeResults[index].hresult === (index === names.length - 1 ? finalHresult : ZERO));
  const cleanupVerified = evidence.cleanupComplete && evidence.probeResourcesReleased && cleanupArrayValid && !evidence.error;
  const noAudioClient = evidence.clientActivated === false && evidence.initializeCalled === false &&
    result.initialized === false && evidence.startCalled === false;
  const v3Identity = result.schemaVersion === 3 && result.deviceFound === true && result.deviceNotFound === false &&
    evidence.observedEndpoint?.toLowerCase() === endpoint?.toLowerCase() && evidence.endpointState !== null;
  // A native endpoint observation never proves audio availability. It can only
  // explain why Initialize was not attempted; source-owner retirement needs its
  // own independently branded session, stopped snapshot and process-tree exit.
  const missingEndpoint = [2, 3].includes(result.schemaVersion) && evidence.probeExitCode === 1 &&
    evidence.stage === 'GetDevice' && evidence.failureStage === 'GetDevice' && evidence.hresult === NOT_FOUND &&
    evidence.hresultSource === 'native-return' && exactNativeSequence(['GetDevice'], NOT_FOUND) && noAudioClient &&
    (!Object.hasOwn(result, 'deviceFound') || result.deviceFound === false) &&
    (!Object.hasOwn(result, 'deviceNotFound') || result.deviceNotFound === true) && result.observedEndpoint == null && result.endpointState == null &&
    (result.schemaVersion === 2 || result.deviceFound === false && result.deviceNotFound === true &&
      result.observedEndpoint === null && result.endpointState === null);
  const inactiveEndpoint = v3Identity && exitedCleanly && evidence.stage === 'GetState' && result.failureStage === null &&
    evidence.hresult === ZERO && evidence.hresultSource === 'native-return' && exactNativeSequence(['GetDevice', 'GetId', 'GetState']) &&
    evidence.endpointState !== 1 && noAudioClient;
  const observationBoundary = trustedEndpoint && evidence.probeChildExited && !evidence.aborted && !evidence.timedOut && cleanupVerified;
  if (observationBoundary && (missingEndpoint || inactiveEndpoint)) {
    evidence.endpointStatus = missingEndpoint ? 'missing' : 'inactive'; evidence.endpointStatusVerified = true;
  }
  const expectedStages = result.schemaVersion === 3
    ? ['GetDevice', 'GetId', 'GetState', 'Activate', 'GetMixFormat', 'Initialize']
    : ['GetDevice', 'Activate', 'GetMixFormat', 'Initialize'];
  const nativeSequenceValid = exactNativeSequence(expectedStages, evidence.hresult);
  const v2Boundary = result.schemaVersion === 2 && evidence.stage === 'Initialize' && evidence.hresultSource === 'native-return' &&
    nativeSequenceValid && evidence.clientActivated === true && evidence.initializeCalled === true && evidence.startCalled === false &&
    evidence.cleanupComplete && evidence.probeResourcesReleased && cleanupArrayValid && !evidence.error &&
    evidence.formatKind === 'Windows shared mix format' && evidence.mixRate > 0 && evidence.mixBits > 0 && evidence.mixChannels > 0;
  const v3Boundary = result.schemaVersion === 3 && v3Identity && evidence.endpointState === 1 &&
    evidence.stage === 'Initialize' && evidence.hresultSource === 'native-return' && nativeSequenceValid &&
    evidence.clientActivated === true && evidence.initializeCalled === true && evidence.startCalled === false && cleanupVerified &&
    evidence.formatKind === 'Windows shared mix format' && evidence.mixRate > 0 && evidence.mixBits > 0 && evidence.mixChannels > 0;
  const initializeResultCoherent = evidence.hresult === ZERO
    ? result.initialized === true && result.failureStage === null
    : evidence.hresult !== null && (Number(evidence.hresult) >>> 31) === 1 &&
      result.initialized === false && result.failureStage === 'Initialize';
  evidence.initializeBoundaryVerified = trustedEndpoint && exitedCleanly && (v2Boundary || v3Boundary) && initializeResultCoherent;
  if (trustedEndpoint && exitedCleanly && v3Boundary) {
    evidence.endpointStatus = 'active'; evidence.endpointStatusVerified = true;
  }
  // Legacy compatibility matches the frozen helper's previous S_OK gate. That
  // helper's cleanup boundary is child-process termination, not a reported flag.
  const legacyBoundary = legacy && inferredNative && evidence.startCalled === false &&
    result.cleanupComplete !== false && result.released !== false && !result.error &&
    (!Array.isArray(result.cleanupFailures) || result.cleanupFailures.length === 0);
  let classification = 'unknown';
  if (trustedEndpoint && exitedCleanly && (v2Boundary || v3Boundary || legacyBoundary)) {
    if (evidence.hresult === ZERO && result.initialized === true && (legacy || result.failureStage === null)) classification = 'released';
    else if (evidence.hresult === IN_USE && result.initialized === false && (legacy || result.failureStage === 'Initialize')) classification = 'busy';
  }
  evidence.classification = classification;
  evidence.released = classification === 'released';
  if (classification !== 'unknown') evidence.reason = classification === 'released' ? 'same-endpoint-shared-initialize-succeeded' : 'exact-native-initialize-device-in-use';
  else if (malformed) evidence.reason = 'malformed-result';
  else if (!trustedEndpoint) evidence.reason = 'endpoint-or-operation-mismatch';
  else if (evidence.aborted || evidence.timedOut) evidence.reason = 'probe-interrupted';
  else if (!exitedCleanly) evidence.reason = 'probe-child-exit-unconfirmed-or-failed';
  else if (evidence.hresult !== ZERO && evidence.hresult !== IN_USE) evidence.reason = 'unrecognized-or-other-hresult';
  if (evidence.endpointStatusVerified && evidence.endpointStatus !== 'active') {
    evidence.reason = evidence.endpointStatus === 'missing' ? 'selected-endpoint-not-found' : 'selected-endpoint-not-active';
  }
  return {classification, trustedEndpoint, evidence};
}

module.exports = {parseOutputReleaseEvidence, normalizeHresult, describeHresult};
