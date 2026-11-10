'use strict';

// Pure snapshot/observation storage. No engine imports, network or process APIs.
const fs = require('node:fs/promises');
const path = require('node:path');
const {constants} = require('node:fs');
const {randomUUID} = require('node:crypto');
const {sanitizeRuntimeLog} = require('./runtime-log');
const TRACE_LIMIT = 240;
const MAX_BYTES = 512 * 1024;
const HANDOFF_CODES = new Set(['STILL_HANDOFF_BUSY', 'STILL_HANDOFF_DRAIN_UNVERIFIED', 'STILL_HANDOFF_QUEUE_UNKNOWN', 'STILL_HANDOFF_QUEUE_NOT_EMPTY', 'STILL_HANDOFF_SNAPSHOT_UNVERIFIED',
  'STILL_HANDOFF_SNAPSHOT_TOO_LARGE', 'STILL_HANDOFF_CONTEXT_CHANGED', 'STILL_HANDOFF_STATE_PATH', 'STILL_HANDOFF_STATE_UNVERIFIED',
  'STILL_HANDOFF_SESSION_UNVERIFIED', 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED', 'STILL_HANDOFF_QUIET_RESTART_UNVERIFIED', 'STILL_HANDOFF_NOT_STOPPED', 'STILL_HANDOFF_EXIT_UNVERIFIED',
  'STILL_HANDOFF_RESTORE_REQUIRED', 'STILL_HANDOFF_RESTORE_CONFLICT', 'STILL_HANDOFF_RESTORE_UNVERIFIED',
  'STILL_OUTPUT_RELEASE_UNVERIFIED', 'STILL_OUTPUT_RELEASE_BUSY', 'STILL_OUTPUT_RELEASE_UNKNOWN', 'STILL_CANCELLED']);
const HANDOFF_PHASES = new Set(['snapshot', 'shared-probe', 'released', 'probe-failed', 'owned-exit', 'standby', 'blocked', 'restored']);
const PROBE_STAGES = new Set(['CreateDeviceEnumerator', 'GetDevice', 'GetId', 'GetState', 'Activate', 'CastAudioClient', 'GetMixFormat', 'ReadMixFormat', 'Initialize', 'Complete']);
const PROBE_HRESULT_SOURCES = new Set(['native-return', 'managed-exception', 'not-called', 'legacy-native-return-inferred']);
const PROBE_RESOURCES = new Set(['MixFormat', 'AudioClient', 'Device', 'Enumerator']);
const SAFE_CODES = new Set([
  ...HANDOFF_CODES,
  'STILL_CANCELLED', 'STILL_BACKEND_EXITED', 'STILL_HTTP_TIMEOUT', 'STILL_TRANSPORT_UNCERTAIN',
  'STILL_SHUTDOWN_FAILED', 'STILL_RUNTIME_FATAL', 'STILL_BACKEND_STARTUP_UNCERTAIN',
  'STILL_BACKEND_OWNERSHIP_UNVERIFIED',
  'STILL_SHUTDOWN_WRITES_CLOSED', 'STILL_SHUTDOWN_NOT_OWNED',
  'STILL_BACKEND_IDENTITY_MISMATCH', 'STILL_BACKEND_INVALID_RESPONSE', 'STILL_BACKEND_ACCESS_DENIED',
  'STILL_BACKEND_REDIRECT_REJECTED', 'STILL_HTTP_READ_FAILED', 'STILL_HTTP_READ_TIMEOUT',
  'STILL_OUTPUT_UNKNOWN', 'STILL_OUTPUT_CHANGED', 'STILL_OUTPUT_DISCONNECTED', 'STILL_BACKEND_COMPONENT_INSTALL_INCOMPLETE',
  'official-host-missing', 'webview2-runtime-missing', 'session-closed', 'needs-auth', 'needs-user-interaction',
  'official-player-not-ready', 'official-origin-required', 'official-operation-failed', 'official-api-unavailable',
  'official-invalid-response', 'official-control-unavailable', 'official-queue-unavailable', 'unsupported-item',
  'official-track-unconfirmed', 'official-stop-unconfirmed', 'official-audio-cleanup-unverified',
  'host-timeout', 'host-exited', 'host-initialization-failed', 'official-navigation-failed',
  'official-bridge-unavailable', 'official-process-failed', 'invalid-input', 'invalid-item', 'closed',
  'protected-playback-unverified', 'subscription-full-song-unverified', 'owned-browser-exit-unverified',
  'playback-control-maintenance', 'cancelled', 'unsupported-method'
]);
const STATES = new Set(['playing', 'paused', 'stopped', 'muted', 'loading', 'unknown', 'unavailable']);
const STATUSES = new Set(['ready', 'offline', 'degraded', 'standby', 'unavailable', 'unknown', 'checking', 'starting', 'restarting', 'closed', 'failed',
  'shutdown-failed', 'unprepared', 'authorization-required', 'session-closed', 'session-unverified', 'needs-user-interaction',
  'connected', 'disconnected', 'device-disconnected', 'device-unknown', 'device-reconnected', 'output-changed', 'control-unconfirmed']);
const TYPES = new Set(['songs', 'albums', 'artists', 'playlists', 'library-songs', 'library-albums', 'library-artists', 'library-playlists']);
const KINDS = new Set(['search', 'songs', 'albums', 'artists', 'playlists', 'album-songs', 'playlist-songs', 'artist-albums']);
const SOURCES = new Set(['local', 'apple']);
const APPLE_OPERATION_METHODS = new Set(['play', 'resume', 'library', 'search', 'pause', 'stop', 'seek', 'volume', 'order', 'next', 'previous']);
const APPLE_OPERATION_STAGES = new Set(['authorization-check', 'dispatch', 'readback', 'complete', 'failed']);
const APPLE_ERROR_ORIGINS = new Set(['node-startup-timeout', 'node-page-not-ready', 'native-ready-guard', 'native-origin-guard', 'native-sdk-ready-timeout', 'bridge-instance']);
const APPLE_AUTOPLAY_DECISIONS = new Set(['not-seen', 'awaiting-request', 'revoked', 'allow-pending', 'allow-session', 'deny-kind', 'deny-core',
  'deny-origin', 'deny-navigation', 'deny-revoked', 'deny-nonce', 'deny-expired', 'temporary-policy-unavailable', 'handler-unavailable']);
const APPLE_OPERATION_CODES = new Set([
  'STILL_CANCELLED', 'official-host-missing', 'webview2-runtime-missing', 'session-closed', 'needs-auth', 'needs-user-interaction',
  'official-player-not-ready', 'official-origin-required', 'official-operation-failed', 'official-api-unavailable',
  'official-invalid-response', 'official-control-unavailable', 'official-queue-unavailable', 'unsupported-item',
  'official-track-unconfirmed', 'official-stop-unconfirmed', 'official-audio-cleanup-unverified', 'host-timeout', 'host-exited',
  'host-initialization-failed', 'official-navigation-failed', 'official-bridge-unavailable', 'official-process-failed', 'invalid-input', 'invalid-item', 'closed'
]);

// Read only own data properties: never invoke a getter or toJSON on supplied data.
function own(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  try {return Object.getOwnPropertyDescriptor(value, key)?.value;} catch {return undefined;}
}
function text(value, limit = 160) {
  if (typeof value !== 'string' || /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)/i.test(value)) return undefined;
  return value.slice(0, limit).replace(/[\u0000-\u001f\u007f]/g, '');
}
const bool = value => typeof value === 'boolean' ? value : value === null ? null : undefined;
const number = (value, max = 86400000) => value === null ? null : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
const enumValue = (value, set) => typeof value === 'string' && set.has(value) ? value : undefined;
const id = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value) ? value : undefined;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : undefined;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : undefined;
const version = value => typeof value === 'string' && /^\d+\.\d+(?:\.\d+){0,2}(?:[-+][a-z0-9.-]+)?$/i.test(value) && value.length <= 80 ? value : undefined;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
function absolutePath(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\0\r\n]/.test(value) || /(?:[a-z][a-z0-9+.-]*:\/\/|^\\\\)/i.test(value)) return undefined;
  return path.isAbsolute(value) || path.win32.isAbsolute(value) ? value : undefined;
}
function compact(value) {for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key]; return value;}
function safeArray(value, maximum, mapper) {
  if (!Array.isArray(value)) return undefined;
  const length = integer(own(value, 'length'), 1000000); if (length === undefined) return undefined;
  const result = [];
  for (let i = 0; i < Math.min(length, maximum); i++) {const item = mapper(own(value, String(i))); if (item !== undefined && item !== null) result.push(item);}
  return result;
}
function metadata(raw, allowPath = false) {
  if (!raw || typeof raw !== 'object') return undefined;
  return compact({id: id(own(raw, 'id')), type: enumValue(own(raw, 'type'), TYPES), title: text(own(raw, 'title')),
    artist: text(own(raw, 'artist')), album: text(own(raw, 'album')), duration: number(own(raw, 'duration')),
    catalogId: id(own(raw, 'catalogId')), playable: bool(own(raw, 'playable')),
    ...(allowPath ? {path: absolutePath(own(raw, 'path')), subsong: integer(own(raw, 'subsong'), 1000000)} : {})});
}
function errorCode(raw) {
  return enumValue(own(raw, 'errorCode'), SAFE_CODES) || enumValue(own(raw, 'code'), SAFE_CODES) || enumValue(own(own(raw, 'error'), 'code'), SAFE_CODES);
}
function output(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const typeId = id(own(raw, 'typeId')), value = own(raw, 'deviceId');
  const deviceId = typeof value === 'string' && /^[A-Za-z0-9._:{}-]{1,200}$/.test(value) ? value : undefined;
  return compact({typeId, deviceId, id: typeId && deviceId ? JSON.stringify([typeId, deviceId]) : undefined,
    name: text(own(raw, 'name')), typeName: text(own(raw, 'typeName'), 80), configuredExclusive: bool(own(raw, 'configuredExclusive'))});
}
function evidence(raw, depth = 0) {
  if (!raw || typeof raw !== 'object') return undefined;
  const result = {actualDacRate: null};
  for (const key of ['released', 'ownedBrowserProcessExited', 'ownedHelperExited', 'processExited', 'exited', 'verified',
    'owned', 'initialized', 'ready', 'startCalled', 'initializeCalled', 'clientActivated', 'formatSupported',
    'deviceFound', 'deviceNotFound', 'active', 'disabled', 'notPresent', 'unplugged', 'deviceInUse']) result[key] = bool(own(raw, key));
  result.operation = enumValue(own(raw, 'operation'), new Set(['GetState', 'Initialize']));
  result.mode = enumValue(own(raw, 'mode'), new Set(['state', 'shared', 'exclusive', 'exclusive-check']));
  result.probe = enumValue(own(raw, 'probe'), new Set(['IMMDevice.GetState', 'IAudioClient.Initialize/shared', 'IAudioClient.Initialize/exclusive']));
  result.reason = enumValue(own(raw, 'reason'), SAFE_CODES);
  const hresult = own(raw, 'hresult'); result.hresult = typeof hresult === 'string' && /^0x[a-f0-9]{8}$/i.test(hresult) ? hresult : undefined;
  if (depth < 1) {result.result = evidence(own(raw, 'result'), depth + 1); result.independent = evidence(own(raw, 'independent'), depth + 1);}
  return compact(result);
}
function connection(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const endpoint = own(raw, 'endpointId');
  return compact({status: enumValue(own(raw, 'status'), STATUSES),
    endpointId: typeof endpoint === 'string' && /^\{0\.0\.0\.00000000\}\.\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/i.test(endpoint) ? endpoint : undefined,
    lastCheckedAt: date(own(raw, 'lastCheckedAt')), retryRequired: bool(own(raw, 'retryRequired')),
    selectionMatches: bool(own(raw, 'selectionMatches')), output: output(own(raw, 'output')),
    evidence: evidence(own(raw, 'evidence')), actualDacRate: null});
}
function verification(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return compact({selectedPlaybackReadback: bool(own(raw, 'selectedPlaybackReadback')),
    subscriptionFullSong: bool(own(raw, 'subscriptionFullSong')), actualDacRate: null});
}
function player(raw, allowLocalPath = true) {
  if (!raw || typeof raw !== 'object') return undefined;
  const result = {state: enumValue(own(raw, 'state'), STATES), source: enumValue(own(raw, 'source'), SOURCES), lastSource: enumValue(own(raw, 'lastSource'), SOURCES),
    generation: integer(own(raw, 'generation')), revision: integer(own(raw, 'revision')),
    position: number(own(raw, 'position')), duration: number(own(raw, 'duration')), volume: number(own(raw, 'volume'), 1),
    currentTrackId: own(raw, 'currentTrackId') === null ? null : id(own(raw, 'currentTrackId')), currentTrack: own(raw, 'currentTrack') === null ? null : metadata(own(raw, 'currentTrack'), allowLocalPath &&
      (own(raw, 'source') === 'local' || own(raw, 'lastSource') === 'local')),
    output: output(own(raw, 'output')), outputConnection: connection(own(raw, 'outputConnection')),
    errorCode: errorCode(raw), fullSongVerified: bool(own(raw, 'fullSongVerified')), actualDacRate: null, ...readHealth(raw)};
  result.pending = bool(own(raw, 'pending')); result.controlsReady = bool(own(raw, 'controlsReady'));
  result.lifecyclePhase = enumValue(own(raw, 'lifecyclePhase'), new Set(['closed', 'starting', 'closing', 'ready']));
  for (const key of ['available', 'backendReachable', 'controlUncertain', 'controlled', 'authorizedAudio', 'authorizationRequired',
    'outputMuted', 'audioReleaseUnverified', 'audible', 'mayBeAudible']) result[key] = bool(own(raw, key));
  result.verification = verification(own(raw, 'verification'));
  return compact(result);
}
function capabilities(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const result = {};
  for (const key of ['configure', 'configureKey', 'importToken', 'pairing', 'authorize', 'library', 'search', 'playback', 'albumPlayback', 'queue',
    'toggle', 'previous', 'next', 'seek', 'volume', 'order', 'lyrics', 'retryBackend', 'canStartOnDemand', 'canSubmitPlayIntent', 'outputSelection', 'exclusiveOutput', 'pcmAccess', 'outputConnection', 'retryOutput', 'subsong']) result[key] = bool(own(raw, key));
  result.playableTypes = safeArray(own(raw, 'playableTypes'), 8, v => enumValue(v, TYPES));
  result.maxPlayItems = integer(own(raw, 'maxPlayItems'), 1000);
  result.playIntentTypes = safeArray(own(raw, 'playIntentTypes'), 2, v => enumValue(v, new Set(['songs', 'library-songs'])));
  result.detailKinds = safeArray(own(raw, 'detailKinds'), 3, v => enumValue(v, KINDS));
  result.queueActions = safeArray(own(raw, 'queueActions'), 3, v => enumValue(v, new Set(['add', 'remove', 'clear'])));
  return compact(result);
}
function methodSupport(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const result = {};
  for (const key of ['play', 'pause', 'stop', 'next', 'previous', 'seek', 'setQueue', 'apiMusic', 'queue', 'volume', 'albumPlayback', 'order']) {
    const value = own(raw, key); if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}
function lastOperation(raw) {
  if (raw === null) return null;
  const method = enumValue(own(raw, 'method'), APPLE_OPERATION_METHODS), stage = enumValue(own(raw, 'stage'), APPLE_OPERATION_STAGES);
  if (!method || !stage) return undefined;
  const inputCode = own(raw, 'code'), code = inputCode === null ? null : enumValue(inputCode, APPLE_OPERATION_CODES);
  if (code === undefined) return undefined;
  const kind = enumValue(own(raw, 'kind'), new Set(['songs', 'library-songs'])), itemId = id(own(raw, 'id'));
  return compact({method, stage, code, ...(method === 'play' && kind && itemId ? {kind, id: itemId} : {}),
    failedFromStage: enumValue(own(raw, 'failedFromStage'), APPLE_OPERATION_STAGES), origin: enumValue(own(raw, 'origin'), APPLE_ERROR_ORIGINS)});
}
function operationHistory(raw) {
  const length = Array.isArray(raw) ? integer(own(raw, 'length'), 1000000) : undefined;
  if (length === undefined) return undefined;
  const result = [];
  for (let index = Math.max(0, length - 16); index < length; index++) {
    const row = own(raw, String(index)), operation = lastOperation(row), operationId = integer(own(row, 'operationId')), generation = integer(own(row, 'generation'));
    if (operation && operationId !== undefined && generation !== undefined) result.push({...operation, operationId, generation});
  }
  return result;
}
function autoplayPolicy(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const configured = own(raw, 'configured'), seen = own(raw, 'seen');
  return compact({configured: typeof configured === 'boolean' ? configured : undefined,
    seen: typeof seen === 'boolean' ? seen : undefined, decision: enumValue(own(raw, 'decision'), APPLE_AUTOPLAY_DECISIONS)});
}
function source(raw, sourceId) {
  if (!raw || typeof raw !== 'object') return undefined;
  const runtime = own(raw, 'runtime');
  return compact({id: sourceId, provider: enumValue(own(raw, 'provider'), new Set(['officialWeb', 'foobar2000'])),
    status: enumValue(own(raw, 'status'), STATUSES), available: bool(own(raw, 'available')), connected: bool(own(raw, 'connected')), configured: bool(own(raw, 'configured')),
    controlled: bool(own(raw, 'controlled')), audioReleaseUnverified: bool(own(raw, 'audioReleaseUnverified')),
    pending: bool(own(raw, 'pending')), controlsReady: bool(own(raw, 'controlsReady')),
    lifecyclePhase: enumValue(own(raw, 'lifecyclePhase'), new Set(['closed', 'starting', 'closing', 'ready'])),
    backendReachable: bool(own(raw, 'backendReachable')), controlUncertain: bool(own(raw, 'controlUncertain')), ...readHealth(raw),
    reasonCodes: safeArray(own(raw, 'reasonCodes'), 8, v => enumValue(v, SAFE_CODES)), capabilities: capabilities(own(raw, 'capabilities')),
    outputConnection: connection(own(raw, 'outputConnection')), verification: verification(own(raw, 'verification')),
    ...(sourceId === 'apple' ? {audioOutput: appleAudioOutput(own(raw, 'audioOutput'))} : {}),
    ...(sourceId === 'apple' ? {methodSupport: methodSupport(own(raw, 'methodSupport')), lastOperation: lastOperation(own(raw, 'lastOperation')),
      operationHistory: operationHistory(own(raw, 'operationHistory')), autoplayPolicy: autoplayPolicy(own(raw, 'autoplayPolicy'))} : {}),
    errorCode: errorCode(raw), runtime: runtime && compact({available: bool(own(runtime, 'available')), version: version(own(runtime, 'version')),
      hostBuilt: bool(own(runtime, 'hostBuilt')), sessionOpen: bool(own(runtime, 'sessionOpen'))})});
}
function appleAudioOutput(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return compact({path: enumValue(own(raw, 'path'), new Set(['webview2-system'])),
    mode: enumValue(own(raw, 'mode'), new Set(['shared'])), exclusiveSupported: bool(own(raw, 'exclusiveSupported')),
    bitPerfectVerified: bool(own(raw, 'bitPerfectVerified')),
    reasonCode: enumValue(own(raw, 'reasonCode'), new Set(['official-web-no-pcm-output']))});
}
function sources(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const collection = own(raw, 'sources') || raw;
  return compact({selectedSource: enumValue(own(raw, 'selectedSource'), SOURCES), sources: compact({local: source(own(collection, 'local'), 'local'), apple: source(own(collection, 'apple'), 'apple')})});
}
function queue(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return compact({items: safeArray(own(raw, 'items'), 5, value => metadata(value)), offset: integer(own(raw, 'offset'), 1000000),
    limit: integer(own(raw, 'limit'), 1000000), total: integer(own(raw, 'total'), 1000000), position: integer(own(raw, 'position'), 1000000),
    hasMore: bool(own(raw, 'hasMore')), errorCode: errorCode(raw)});
}
function backend(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return compact({pid: integer(own(raw, 'pid'), 0x7fffffff), backendId: uuid(own(raw, 'backendId')), sessionId: uuid(own(raw, 'sessionId')),
    executable: absolutePath(own(raw, 'executable')), foobarDir: absolutePath(own(raw, 'foobarDir')), backendDir: absolutePath(own(raw, 'backendDir')),
    status: enumValue(own(raw, 'status'), STATUSES), available: bool(own(raw, 'available')), owned: bool(own(raw, 'owned')), verified: bool(own(raw, 'verified')),
    managed: bool(own(raw, 'managed')), privateUseOnly: bool(own(raw, 'privateUseOnly')), restartRequired: bool(own(raw, 'restartRequired')),
    pendingHandoff: bool(own(raw, 'pendingHandoff')), canStartOnDemand: bool(own(raw, 'canStartOnDemand')), ...readHealth(raw),
    safeOwnedExit: safeOwnedExit(own(raw, 'safeOwnedExit')),
    executableSha256: hash(own(raw, 'executableSha256')), manifestSha256: hash(own(raw, 'manifestSha256')), errorCode: errorCode(raw)});
}
function readHealth(raw) {
  return compact({connectionStatus: enumValue(own(raw, 'connectionStatus'), new Set(['connected', 'degraded', 'offline'])),
    stale: bool(own(raw, 'stale')), consecutiveReadFailures: integer(own(raw, 'consecutiveReadFailures'), 1000000),
    lastGoodAt: own(raw, 'lastGoodAt') === null ? null : date(own(raw, 'lastGoodAt'))});
}
function safeOwnedExit(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const target = own(raw, 'target');
  return compact({available: bool(own(raw, 'available')), refused: bool(own(raw, 'refused')), code: errorCode(raw),
    target: target === null ? null : target && compact({pid: integer(own(target, 'pid'), 0x7fffffff),
      startTime: date(own(target, 'startTime')), executable: absolutePath(own(target, 'executable')), profilePath: absolutePath(own(target, 'profilePath'))})});
}
function spectrumTransport(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return compact({consecutiveFailures: integer(own(raw, 'consecutiveFailures'), 1000), coolingDown: bool(own(raw, 'coolingDown')),
    retryInMs: integer(own(raw, 'retryInMs'), 30000), childActive: bool(own(raw, 'childActive')),
    reason: enumValue(own(raw, 'reason'), new Set(['component-not-connected', 'reader-unavailable', 'reader-cooldown', 'reader-missing',
      'malformed-frame', 'backend-session-unverified', 'platform-unsupported', 'stale-frame', 'awaiting-native-discontinuity']))});
}
function audio(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return compact({available: bool(own(raw, 'available')), backendReachable: bool(own(raw, 'backendReachable')),
    outputConnection: connection(own(raw, 'outputConnection')), selection: output(own(raw, 'selection')), configured: output(own(raw, 'configured')),
    evidence: evidence(own(raw, 'evidence')), release: evidence(own(raw, 'release')), released: bool(own(raw, 'released')),
    actualDacRate: null, measured: {exclusive: null, sampleRate: null, bitsPerSample: null, channels: null}, errorCode: errorCode(raw)});
}
function build(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  return compact({version: version(own(raw, 'version')), appVersion: version(own(raw, 'appVersion')), electron: version(own(raw, 'electron')),
    electronVersion: version(own(raw, 'electronVersion')), platform: enumValue(own(raw, 'platform'), new Set(['win32'])),
    arch: enumValue(own(raw, 'arch'), new Set(['x64', 'arm64'])), builtAt: date(own(raw, 'builtAt')), buildId: hash(own(raw, 'buildId')) || uuid(own(raw, 'buildId')),
    sourceFrozenSnapshot: hash(own(raw, 'sourceFrozenSnapshot')), manifestSha256: hash(own(raw, 'manifestSha256')),
    stillExecutableSha256: hash(own(raw, 'stillExecutableSha256')), nativeAppleHostSha256: hash(own(raw, 'nativeAppleHostSha256')),
    appleAdapterSha256: hash(own(raw, 'appleAdapterSha256')), mainSha256: hash(own(raw, 'mainSha256'))});
}
function handoffProbe(raw) {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const nullableEnum = (value, values) => value === null ? null : enumValue(value, values);
  const hr = value => value === null ? null : typeof value === 'string' && /^0x[a-f0-9]{8}$/i.test(value) ? value : undefined;
  const endpoint = own(raw, 'endpoint'), observedEndpoint = own(raw, 'observedEndpoint'), exitCode = own(raw, 'probeExitCode');
  const endpointId = value => value === null ? null : typeof value === 'string' && /^\{0\.0\.0\.00000000\}\.\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/i.test(value) ? value : undefined;
  const endpointState = own(raw, 'endpointState');
  return compact({classification: enumValue(own(raw, 'classification'), new Set(['released', 'busy', 'unknown', 'disconnected', 'mismatch', 'invalid'])),
    trustedEndpoint: bool(own(raw, 'trustedEndpoint')), endpoint: endpointId(endpoint), observedEndpoint: endpointId(observedEndpoint),
    endpointStatus: enumValue(own(raw, 'endpointStatus'), new Set(['missing', 'inactive', 'active', 'unknown'])),
    endpointStatusVerified: bool(own(raw, 'endpointStatusVerified')),
    endpointState: endpointState === null ? null : [1, 2, 4, 8].includes(endpointState) ? endpointState : undefined,
    hresult: hr(own(raw, 'hresult')), operation: nullableEnum(own(raw, 'operation'), new Set(['Initialize'])),
    mode: nullableEnum(own(raw, 'mode'), new Set(['shared', 'exclusive-check'])), startCalled: bool(own(raw, 'startCalled')),
    stage: nullableEnum(own(raw, 'stage'), PROBE_STAGES), failureStage: nullableEnum(own(raw, 'failureStage'), PROBE_STAGES),
    hresultSource: nullableEnum(own(raw, 'hresultSource'), PROBE_HRESULT_SOURCES),
    nativeResults: safeArray(own(raw, 'nativeResults'), 12, row => row && typeof row === 'object' ? compact({stage: nullableEnum(own(row, 'stage'), PROBE_STAGES), hresult: hr(own(row, 'hresult'))}) : undefined),
    cleanupComplete: bool(own(raw, 'cleanupComplete')),
    cleanupFailures: safeArray(own(raw, 'cleanupFailures'), 12, row => row && typeof row === 'object' ? compact({resource: nullableEnum(own(row, 'resource'), PROBE_RESOURCES), hresult: hr(own(row, 'hresult'))}) : undefined),
    initializeCalled: bool(own(raw, 'initializeCalled')), initializeBoundaryVerified: bool(own(raw, 'initializeBoundaryVerified')),
    clientActivated: bool(own(raw, 'clientActivated')),
    initialized: bool(own(raw, 'initialized')), probeChildExited: bool(own(raw, 'probeChildExited')),
    probeExitCode: exitCode === null ? null : Number.isSafeInteger(exitCode) && exitCode >= -0x80000000 && exitCode <= 0xffffffff ? exitCode : undefined,
    actualDacRate: null});
}
function handoffRecord(raw) {
  if (raw === null) return null;
  const phase = enumValue(own(raw, 'phase'), HANDOFF_PHASES);
  if (!phase || own(raw, 'from') !== 'local' || own(raw, 'to') !== 'apple') return undefined;
  const code = own(raw, 'code'), cleanupCode = own(raw, 'cleanupCode');
  return compact({phase, code: code === null ? null : enumValue(code, HANDOFF_CODES), cleanupCode: cleanupCode === null ? null : enumValue(cleanupCode, HANDOFF_CODES),
    from: 'local', to: 'apple', sourceExited: bool(own(raw, 'sourceExited')), sequence: integer(own(raw, 'sequence')),
    releaseEvidence: handoffProbe(own(raw, 'releaseEvidence'))});
}
function handoff(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const history = own(raw, 'history'), length = Array.isArray(history) ? integer(own(history, 'length'), 1000000) : undefined;
  const retained = length === undefined ? undefined : [];
  if (retained) for (let index = Math.max(0, length - 16); index < length; index++) {
    const record = handoffRecord(own(history, String(index))); if (record) retained.push(record);
  }
  return compact({current: handoffRecord(own(raw, 'current')), history: retained,
    pendingRestore: bool(own(raw, 'pendingRestore')), exitUnverified: bool(own(raw, 'exitUnverified'))});
}
function snapshot(raw, scope) {
  const apple = own(raw, 'apple');
  const appleSnapshot = apple && compact({status: source(own(apple, 'status'), 'apple'), state: player(own(apple, 'state'), false), queue: queue(own(apple, 'queue'))});
  if (scope === 'apple') return compact({apple: appleSnapshot, build: build(own(raw, 'build')), handoff: handoff(own(raw, 'handoff'))});
  return compact({player: player(own(raw, 'player')), sources: sources(own(raw, 'sources')), backend: backend(own(raw, 'backend')),
    apple: appleSnapshot,
    audio: audio(own(raw, 'audio')), build: build(own(raw, 'build')), handoff: handoff(own(raw, 'handoff'))});
}
function layout(raw) {
  const dimension = value => Number.isSafeInteger(value) && value > 0 && value <= 32768 ? value : undefined;
  const boolean = value => typeof value === 'boolean' ? value : undefined;
  const appReducedMotion = boolean(own(raw, 'appReducedMotion')), systemReducedMotion = boolean(own(raw, 'systemReducedMotion'));
  const ratio = own(raw, 'devicePixelRatio'), color = own(raw, 'accentColor');
  return compact({width: dimension(own(raw, 'width')), height: dimension(own(raw, 'height')),
    devicePixelRatio: typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0.25 && ratio <= 16 ? ratio : undefined,
    horizontalOverflow: boolean(own(raw, 'horizontalOverflow')), appReducedMotion, systemReducedMotion,
    effectiveReducedMotion: appReducedMotion !== undefined && systemReducedMotion !== undefined ? appReducedMotion || systemReducedMotion : undefined,
    accentColor: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : undefined});
}
const failure = code => Object.assign(new Error({DIAGNOSTICS_CLOSED: '诊断服务已关闭。', DIAGNOSTICS_SNAPSHOT_FAILED: '无法读取诊断快照。',
  DIAGNOSTICS_UNSAFE_DIRECTORY: '诊断目录边界未通过检查。', DIAGNOSTICS_TOO_LARGE: '诊断快照超过允许大小。', DIAGNOSTICS_WRITE_FAILED: '诊断文件保存失败。'}[code]), {code});
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
async function secureDirectory(directory, create) {
  const resolved = path.resolve(directory), root = path.parse(resolved).root;
  let cursor = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try {stat = await fs.lstat(cursor);} catch (error) {
      if (error.code !== 'ENOENT' || !create) throw failure('DIAGNOSTICS_UNSAFE_DIRECTORY');
      try {await fs.mkdir(cursor);} catch (mkdirError) {if (mkdirError.code !== 'EEXIST') throw failure('DIAGNOSTICS_UNSAFE_DIRECTORY');}
      stat = await fs.lstat(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || canonical(await fs.realpath(cursor)) !== canonical(cursor)) throw failure('DIAGNOSTICS_UNSAFE_DIRECTORY');
  }
  return fs.stat(resolved);
}
function createDiagnosticsService({dataDir, getSnapshot, getRuntimeLog, getSpectrumDiagnostics, now = () => new Date()} = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || /[\0\r\n]/.test(dataDir) || typeof getSnapshot !== 'function' || typeof now !== 'function') throw new TypeError('Diagnostics requires an absolute dataDir and snapshot provider.');
  const directory = path.join(path.resolve(dataDir), 'diagnostics'), trace = [];
  const last = new Map(); let closed = false, exports = Promise.resolve(), dropped = 0, latestLayout;
  function timestamp() {const value = now(); const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString(); return result;}
  function record(event, value, dedupe = true) {
    if (closed || value === undefined) return;
    const serialized = JSON.stringify(value); if (dedupe && last.get(event) === serialized) return;
    if (dedupe) last.set(event, serialized);
    trace.push({recordedAt: timestamp(), event, value});
    if (trace.length > TRACE_LIMIT) {trace.shift(); dropped++;}
  }
  function appleTrace(row) {
    if (row.event === 'apple-read' || row.event === 'layout') return row;
    if (row.event === 'player' && own(row.value, 'source') === 'apple') return {...row, value: player(row.value, false)};
    if (row.event === 'sources') {
      const apple = own(own(row.value, 'sources'), 'apple');
      if (apple) return {...row, value: {sources: {apple: source(apple, 'apple')}}};
    }
    return null;
  }
  async function exportOne(request) {
    if (closed) throw failure('DIAGNOSTICS_CLOSED');
    let raw;
    try {raw = await getSnapshot(request.scope === 'apple' ? {scope: 'apple'} : {});} catch {throw failure('DIAGNOSTICS_SNAPSHOT_FAILED');}
    if (closed) throw failure('DIAGNOSTICS_CLOSED');
    const recordedAt = timestamp(), retained = request.scope === 'apple' ? trace.map(appleTrace).filter(Boolean) : trace.slice();
    const artifact = {schemaVersion: 1, recordedAt, ...(request.scope === 'apple' ? {scope: 'apple'} : {}), snapshot: snapshot(raw, request.scope), traceLimit: TRACE_LIMIT,
      traceDropped: dropped + trace.length - retained.length, trace: retained};
    if (typeof getRuntimeLog === 'function') artifact.runtimeLog = sanitizeRuntimeLog(getRuntimeLog());
    if (request.scope !== 'apple' && typeof getSpectrumDiagnostics === 'function') artifact.spectrumTransport = spectrumTransport(getSpectrumDiagnostics());
    if (request.layout !== undefined) artifact.snapshot.layout = request.layout;
    let serialized = `${JSON.stringify(artifact, null, 2)}\n`;
    while (Buffer.byteLength(serialized) > MAX_BYTES && retained.length) {retained.shift(); artifact.traceDropped++; serialized = `${JSON.stringify(artifact, null, 2)}\n`;}
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw failure('DIAGNOSTICS_TOO_LARGE');
    const filePath = path.join(directory, `still-diagnostics-${recordedAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`);
    let handle;
    try {
      await secureDirectory(directory, true);
      handle = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      await secureDirectory(directory, false);
      if (canonical(await fs.realpath(filePath)) !== canonical(filePath) || !(await handle.stat()).isFile()) throw failure('DIAGNOSTICS_UNSAFE_DIRECTORY');
      await handle.writeFile(serialized, 'utf8'); await handle.sync();
    } catch (error) {throw error?.code === 'DIAGNOSTICS_UNSAFE_DIRECTORY' ? error : failure('DIAGNOSTICS_WRITE_FAILED');}
    finally {if (handle) {try {await handle.close();} catch {throw failure('DIAGNOSTICS_WRITE_FAILED');}}}
    return {saved: true, filePath, recordedAt};
  }
  return {
    observePlayer(value) {record('player', player(value));},
    observeSources(value) {record('sources', sources(value));},
    observeLayout(value) {if (closed) return; latestLayout = layout(value); record('layout', latestLayout);},
    observeAppleRead(value) {
      const operation = enumValue(own(value, 'operation'), new Set(['search', 'library'])); if (!operation || closed) return;
      const input = own(value, 'input'), result = own(value, 'result'), items = own(result, 'items');
      record('apple-read', compact({operation, kind: enumValue(own(result, 'kind'), KINDS) || enumValue(own(input, 'kind'), KINDS) || (operation === 'search' ? 'search' : undefined),
        count: Array.isArray(items) ? integer(own(items, 'length'), 1000000) : undefined,
        limit: integer(own(result, 'limit'), 1000000) ?? integer(own(input, 'limit'), 1000000),
        offset: integer(own(result, 'offset'), 1000000) ?? integer(own(input, 'offset'), 1000000),
        hasMore: bool(own(result, 'hasMore')), samples: safeArray(items, 5, row => metadata(row))}), false);
    },
    exportSnapshot(options) {
      let request;
      try {
        if (arguments.length > 1 || (arguments.length && (!options || typeof options !== 'object' || Array.isArray(options))) ||
            (options && Reflect.ownKeys(options).some(key => key !== 'scope' && key !== 'layout')) ||
            (options && Object.hasOwn(options, 'scope') && own(options, 'scope') !== 'apple') ||
            (options && Object.hasOwn(options, 'layout') && !own(options, 'layout'))) throw failure('DIAGNOSTICS_WRITE_FAILED');
        request = {scope: own(options, 'scope'), layout: options && Object.hasOwn(options, 'layout') ? layout(own(options, 'layout')) : latestLayout};
      } catch {return Promise.reject(failure('DIAGNOSTICS_WRITE_FAILED'));}
      const work = exports.then(() => exportOne(request)); exports = work.catch(() => {}); return work;
    },
    async close() {closed = true; await exports; trace.length = 0; last.clear(); latestLayout = undefined;}
  };
}
module.exports = {createDiagnosticsService, safeDiagnosticErrorCode: errorCode};
