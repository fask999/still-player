'use strict';
// Real hardware acceptance: default invocation only prints a plan. Never runs at startup.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { locationKey, COLUMNS, trackFromColumns } = require('../src/main/foobar');
const { inspectWindows } = require('../src/main/backend');
const { makeSilentWav } = require('./foobar-create-probes');
const ENDPOINT = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';
const DEVICE_ID = '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB';
const RATES = [44100, 48000, 96000, 192000];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invariant = (ok, message) => { if (!ok) throw new Error(message); };
const playlistDigest = p => ({ id: p.id, name: p.name, count: p.items.length, sha256: digest({ name: p.name, items: p.items }) });
const safeOutcome = x => x.status === 'fulfilled' ? { status: x.status, value: x.value } : { status: x.status, error: x.reason?.message || String(x.reason) };
const canonical = value => path.resolve(value).toLowerCase();
const fileHash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const executeFile = promisify(execFile);
const uncertainError = reason => Object.assign(new Error(`Acceptance mutation is uncertain; no further automatic writes are permitted: ${reason}`), { code: 'ACCEPTANCE_POST_UNCERTAIN' });

function createdAt(value) {
  const match = String(value || '').match(/^\/Date\((\d+)\)\/$/);
  const time = match ? Number(match[1]) : Date.parse(value);
  invariant(Number.isFinite(time), 'Backend creation time is missing or invalid');
  return new Date(time).toISOString();
}
function pinSession({ system, process, backendDir, baseUrl, expected }) {
  const executable = path.join(backendDir, 'foobar2000.exe');
  const owners = new Set(system.listeners?.map(item => item.pid));
  invariant(owners.size === 1 && system.listeners.every(item => ['127.0.0.1', '::1'].includes(item.address)), 'Dedicated listener identity/address is missing or ambiguous');
  const pid = [...owners][0];
  invariant(Number.isInteger(pid) && pid > 0 && system.processes?.some(item => item.pid === pid && canonical(item.executablePath) === canonical(executable)) &&
    process?.pid === pid && canonical(process.executablePath) === canonical(executable), 'Dedicated listener does not match the exact executable/PID');
  const result = { pid, executable, createdAt: createdAt(process.createdAt), baseUrl };
  if (expected) invariant(expected.pid === pid && canonical(expected.executable) === canonical(executable) &&
    createdAt(expected.createdAt) === result.createdAt && expected.baseUrl === baseUrl, 'Backend PID/executable/creation-time/session changed; no mutation permitted');
  return result;
}
async function inspectSession({ backendDir, baseUrl, expected }) {
  const system = await inspectWindows({ executable: path.join(backendDir, 'foobar2000.exe'), port: Number(new URL(baseUrl).port), pid: expected?.pid });
  const owners = [...new Set(system.listeners.map(item => item.pid))];
  invariant(owners.length === 1 && Number.isInteger(owners[0]) && owners[0] > 0, 'No single exact backend listener');
  const command = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${owners[0]}" -ErrorAction Stop; if ($null -eq $p) { throw 'Exact backend PID disappeared' }; @{pid=$p.ProcessId; executablePath=$p.ExecutablePath; createdAt=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`;
  const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000 });
  const process = JSON.parse(stdout);
  return { session: pinSession({ system, process, backendDir, baseUrl, expected }), system, process };
}
function createAcceptanceTransport({ fetchImpl = globalThis.fetch, beforePost = async () => {}, onTrace = () => {}, onDispatch = () => {} } = {}) {
  const pending = new Set(); let fault = null;
  function markUncertain(reason) { if (!fault) fault = uncertainError(reason?.message || String(reason)); return fault; }
  function assertMutable() { if (fault) throw fault; }
  function noteCallerFailure(error) {
    if (pending.size || ['STILL_HTTP_TIMEOUT', 'STILL_TRANSPORT_UNCERTAIN', 'ACCEPTANCE_POST_UNCERTAIN'].includes(error?.code)) markUncertain(error);
    return Boolean(fault);
  }
  async function request(url, init = {}) {
    const post = init.method === 'POST';
    if (post) { assertMutable(); await beforePost(); assertMutable(); }
    const trace = { at: new Date().toISOString(), route: new URL(url).pathname + new URL(url).search,
      method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null };
    onTrace(trace);
    const actual = Promise.resolve().then(() => {
      // A caller deadline never aborts a POST socket: that cannot revoke a
      // server-side play. Actual response/body settlement stays observable.
      const result = fetchImpl(url, post ? { ...init, signal: undefined } : init);
      onDispatch(trace); return result;
    }).then(async response => {
      trace.status = response.status;
      if (post || !response.ok) {
        const body = await response.clone().text();
        if (!response.ok) trace.errorBody = body.slice(0, 2000);
      }
      trace.finishedAt = new Date().toISOString(); return response;
    }).catch(error => { trace.error = error.message; if (post) markUncertain(error); throw error; });
    if (post) { pending.add(actual); actual.finally(() => pending.delete(actual)).catch(() => {}); }
    return actual;
  }
  async function directPost(url, body, { timeoutMs = 5000 } = {}) {
    const actual = request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async response => { invariant(response.ok, `Acceptance direct POST HTTP ${response.status}`); const text = await response.text(); return text ? JSON.parse(text) : null; });
    const result = await settleBounded(() => actual, timeoutMs);
    if (!result.settled) throw markUncertain('Direct POST deadline expired; actual HTTP settlement remains pending');
    if (result.status === 'rejected') { if (pending.size || fault) throw markUncertain(result.error); throw result.error; }
    return result.value;
  }
  return { request, directPost, assertMutable, markUncertain, noteCallerFailure,
    status: () => ({ uncertain: Boolean(fault), error: fault?.message || null, pendingPosts: pending.size }) };
}
function settleBounded(action, timeoutMs) {
  let timer;
  const actual = Promise.resolve().then(action).then(value => ({ settled: true, status: 'fulfilled', value }), error => ({ settled: true, status: 'rejected', error }));
  return Promise.race([actual, new Promise(resolve => { timer = setTimeout(() => resolve({ settled: false, status: 'pending' }), timeoutMs); })])
    .finally(() => clearTimeout(timer));
}
function disconnectFeedback({ native, state, details, endpoint = ENDPOINT }) {
  const same = value => value?.endpointId?.toLowerCase() === endpoint.toLowerCase();
  const normalized = value => value?.status === 'disconnected' && same(value) && value.retryRequired === true && Number.isFinite(Date.parse(value.lastCheckedAt));
  const nativeDisconnected = native?.endpoint?.toLowerCase() === endpoint.toLowerCase() && native.active === false &&
    ((native.hresult === '0x00000000' && Number.isInteger(native.state) && native.state > 0 && !(native.state & 1)) ||
      (native.deviceNotFound === true && native.hresult === '0x80070490'));
  const reachabilitySeparate = typeof state?.backendReachable === 'boolean' && state.backendReachable === (state.available === true) &&
    typeof details?.backendReachable === 'boolean' && details.backendReachable === (details.available === true);
  return { nativeDisconnected, playerConnection: normalized(state?.outputConnection), audioDetailsConnection: normalized(details?.outputConnection),
    reachabilitySeparate, hasExplicitDeviceDisconnectFeedback: Boolean(nativeDisconnected && normalized(state?.outputConnection) && normalized(details?.outputConnection) && reachabilitySeparate) };
}
function completePhysicalHotplug(previous, { disconnectedAt, reconnectedAt, sameEndpoint, explicitRetryVerified }) {
  const physicalCycleObserved = Number.isFinite(disconnectedAt) && Number.isFinite(reconnectedAt) && reconnectedAt > disconnectedAt;
  const normalizedDisconnectFeedbackVerified = previous.highLevelDisconnectFeedbackCovered === true;
  const accepted = physicalCycleObserved && sameEndpoint === true && explicitRetryVerified === true && normalizedDisconnectFeedbackVerified;
  const status = accepted ? 'physical-disconnect-reconnect-and-explicit-retry-verified' :
    !physicalCycleObserved ? 'incomplete-user-action-window-ended' :
      !normalizedDisconnectFeedbackVerified ? 'physical-cycle-observed-normalized-feedback-unverified' : 'physical-cycle-observed-retry-or-endpoint-unverified';
  return { ...previous, tested: accepted, passed: accepted, status, physicalCycleObserved, normalizedDisconnectFeedbackVerified,
    sameEndpoint: sameEndpoint === true, explicitRetryVerified: explicitRetryVerified === true,
    nativeDisconnectedDurationMs: physicalCycleObserved ? reconnectedAt - disconnectedAt : null, actualDacRate: null };
}
async function closeAcceptance({ service, transport, evidence, save, record, timeoutMs = 1500 }) {
  evidence.finishedAt = new Date().toISOString();
  evidence.transportSafety = transport.status();
  if (evidence.transportSafety.uncertain) evidence.passed = false;
  // Always publish the failure/observations before waiting on a potentially
  // unbounded service close. No exit/restart proof exists for this user app.
  await save();
  const result = await settleBounded(() => service.close(), timeoutMs);
  const status = transport.status();
  evidence.cleanup = { closeSettled: result.settled, closeStatus: result.status, closeError: result.error?.message || null,
    ...status, clientExitRequired: !result.settled || status.pendingPosts > 0,
    meaning: 'Ending this acceptance client does not revoke server-side requests, stop playback, or prove device release; user application is never exited/restarted' };
  if (!result.settled || result.status === 'rejected' || status.uncertain || status.pendingPosts) evidence.passed = false;
  record('boundedServiceClose', evidence.cleanup); await save(); return evidence.cleanup;
}

function parseArgs(args) {
  const flags = new Map([['--execute', 'execute'], ['--existing-probes', 'existingProbes'],
    ['--stop-initial-paused', 'stopInitialPaused'], ['--restore-initial-paused', 'restoreInitialPaused'], ['--hotplug', 'hotplug'], ['--audio-window-ack', 'audioWindowAck']]);
  const values = new Map([['--backend-dir', 'backendDir'], ['--base-url', 'baseUrl'],
    ['--source-snapshot', 'sourceSnapshot'], ['--source-hashes', 'sourceHashes'], ['--source-baseline', 'sourceBaseline'], ['--probe-bits', 'probeBits'], ['--session-baseline', 'sessionBaseline']]);
  const result = { execute: false, existingProbes: false }; const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; invariant(!seen.has(arg), `Duplicate argument: ${arg}`); seen.add(arg);
    if (flags.has(arg)) { result[flags.get(arg)] = true; continue; }
    invariant(values.has(arg), `Unknown argument: ${arg}`);
    const value = args[++i]; invariant(typeof value === 'string' && value.length > 0 && !value.startsWith('--') && !/[\0\r\n]/.test(value), `Missing or invalid value for ${arg}`);
    result[values.get(arg)] = value;
  }
  invariant(!result.restoreInitialPaused || result.stopInitialPaused, '--restore-initial-paused requires --stop-initial-paused');
  if (result.probeBits !== undefined) invariant(['16', '24', '32'].includes(result.probeBits), '--probe-bits must be 16, 24 or 32');
  result.probeBits = Number(result.probeBits || 16);
  if (result.execute) {
    invariant(result.backendDir && result.baseUrl, '--execute requires explicit --backend-dir and --base-url');
    invariant(result.audioWindowAck && result.sessionBaseline, '--execute requires the released quiet audio window and its reviewed --session-baseline (--audio-window-ack)');
    invariant(path.isAbsolute(result.backendDir), '--backend-dir must be an absolute path');
    result.backendDir = path.resolve(result.backendDir);
    invariant(canonical(result.backendDir) !== canonical(path.resolve(__dirname, '../..')), 'Refusing original foobar2000 installation');
  }
  if (result.baseUrl) {
    const url = new URL(result.baseUrl);
    invariant(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password &&
      !url.search && !url.hash && /^\/api\/?$/.test(url.pathname) && Number(url.port) >= 1024 && Number(url.port) <= 65535 && url.port !== '8880',
    '--base-url must be a dedicated loopback HTTP /api/ URL on a non-original port');
    url.pathname = '/api/'; result.baseUrl = url.href;
  }
  return result;
}

async function preservationContext(options) {
  const manifestPath = path.join(options.backendDir, 'backend-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  invariant(manifest.privateUseOnly === true && manifest.executable === 'foobar2000.exe' && Array.isArray(manifest.files) && manifest.sourceDir,
    'Dedicated backend manifest is missing ownership information');
  invariant(canonical(manifest.sourceDir) !== canonical(options.backendDir), 'Original installation cannot be an acceptance backend');
  invariant(new URL(options.baseUrl).port === String(manifest.configuration?.port), 'Requested API port does not match the private backend manifest');
  invariant(canonical(await fs.realpath(options.backendDir)) === canonical(options.backendDir), 'Backend directory cannot be a link or junction');
  const sourceSnapshot = path.resolve(options.sourceSnapshot || path.join(__dirname, '../docs/evidence/backend-original-before-private-copy-20261030.json'));
  const sourceHashes = path.resolve(options.sourceHashes || path.join(__dirname, '../docs/evidence/backend-private-copy-verification-20261030.json'));
  const snapshot = JSON.parse(await fs.readFile(sourceSnapshot, 'utf8')), hashes = JSON.parse(await fs.readFile(sourceHashes, 'utf8'));
  invariant(snapshot.simulated === false && Array.isArray(snapshot.library?.playlists) && hashes.sourceUnchanged === true &&
    hashes.originalPlaylistsByteEqual === true && Array.isArray(hashes.originalBefore?.playlists), 'Original-source preservation artifacts are incomplete');
  let packagingChain = null;
  if (canonical(hashes.destination) !== canonical(options.backendDir)) {
    const parentManifestPath = path.join(hashes.destination, 'backend-manifest.json');
    const parentManifest = JSON.parse(await fs.readFile(parentManifestPath, 'utf8'));
    invariant(canonical(manifest.destinationDir) === canonical(options.backendDir) && manifest.packagedFromBackendId &&
      manifest.packagedFromBackendId === parentManifest.backendId && canonical(parentManifest.sourceDir) === canonical(manifest.sourceDir),
    'Packaged backend did not prove its exact reviewed parent manifest identity');
    invariant(manifest.files.filter(item => !item.mutable).every(item => parentManifest.files.some(parent =>
      !parent.mutable && parent.relativePath === item.relativePath && parent.sha256 === item.sha256)), 'Packaged immutable manifest differs from its reviewed parent');
    packagingChain = { parentManifestPath, parentBackendId: parentManifest.backendId, packagedFromBackendId: manifest.packagedFromBackendId,
      targetBackendId: manifest.backendId, destinationDir: manifest.destinationDir, parentManifestSha256: await fileHash(parentManifestPath) };
  }
  const artifacts = [];
  for (const file of [manifestPath, sourceSnapshot, sourceHashes]) artifacts.push({ file, sha256: await fileHash(file) });
  let sourceRecords = hashes.originalBefore.playlists.map(item => ({ path: item.path, sha256: item.sha256 }));
  const configHash = hashes.profileSnapshotEvidence?.sourceAfterHash;
  invariant(/^[a-f0-9]{64}$/i.test(configHash || ''), 'Original SQLite source hash is missing');
  sourceRecords.push({ path: 'profile/config.sqlite', sha256: configHash });
  let acknowledgedPretestBaseline = null;
  if (options.sourceBaseline) {
    const file = path.resolve(options.sourceBaseline), baseline = JSON.parse(await fs.readFile(file, 'utf8'));
    invariant(baseline.simulated === false && baseline.phase === 'read-only-pretest-baseline' && canonical(baseline.sourceRoot) === canonical(manifest.sourceDir) &&
      Array.isArray(baseline.sourceRecords) && baseline.sourceRecords.length === sourceRecords.length, 'Explicit pre-test source baseline is incomplete');
    invariant(sourceRecords.every(old => baseline.sourceRecords.some(current => current.path === old.path && current.historicalSha256 === old.sha256 &&
      (old.path === 'profile/config.sqlite' || current.sha256 === old.sha256))), 'Pre-test baseline changed historical playlist identities or hashes');
    acknowledgedPretestBaseline = baseline; sourceRecords = baseline.sourceRecords.map(item => ({ path: item.path, sha256: item.sha256, historicalSha256: item.historicalSha256 }));
    artifacts.push({ file, sha256: await fileHash(file) });
  }
  if (packagingChain) artifacts.push({ file: packagingChain.parentManifestPath, sha256: packagingChain.parentManifestSha256 });
  const backupRoot = path.join(manifest.sourceDir, 'Still-backup-20261028-before-beefweb'), backupManifestPath = path.join(backupRoot, 'manifest.json');
  const backupManifestHash = await fileHash(backupManifestPath);
  invariant(backupManifestHash === hashes.originalBackupVerified?.manifestSha256, 'Fixed original backup manifest hash changed');
  const backupRecords = JSON.parse(await fs.readFile(backupManifestPath, 'utf8'));
  invariant(Array.isArray(backupRecords) && backupRecords.length === 159, 'Fixed original backup record count changed');
  artifacts.push({ file: backupManifestPath, sha256: backupManifestHash });
  const inside = (root, relative) => {
    invariant(typeof relative === 'string' && !path.isAbsolute(relative), 'Hash record path must be relative');
    const file = path.resolve(root, relative), delta = path.relative(root, file);
    invariant(delta && delta !== '..' && !delta.startsWith(`..${path.sep}`) && !path.isAbsolute(delta), 'Hash record escaped its root'); return file;
  };
  async function verifyFiles() {
    const source = [], bundle = [], artifactReadback = [], backup = [];
    for (const record of sourceRecords) { const file = inside(manifest.sourceDir, record.path), sha256 = await fileHash(file);
      source.push({ ...record, actualSha256: sha256, unchanged: sha256 === record.sha256 }); }
    for (const item of manifest.files.filter(item => !item.mutable)) { const file = inside(options.backendDir, item.relativePath), sha256 = await fileHash(file);
      bundle.push({ relativePath: item.relativePath, expectedSha256: item.sha256, actualSha256: sha256, unchanged: sha256 === item.sha256 }); }
    for (const item of artifacts) { const sha256 = await fileHash(item.file); artifactReadback.push({ ...item, actualSha256: sha256, unchanged: sha256 === item.sha256 }); }
    for (const item of backupRecords) { const sha256 = await fileHash(inside(backupRoot, item.path));
      backup.push({ path: item.path, expectedSha256: item.sha256.toLowerCase(), actualSha256: sha256, unchanged: sha256 === item.sha256.toLowerCase() }); }
    return { at: new Date().toISOString(), originalSourceNotStartedByHarness: true, sourceRoot: manifest.sourceDir,
      source, bundle, backup, artifacts: artifactReadback, unchanged: [...source, ...bundle, ...backup, ...artifactReadback].every(item => item.unchanged) };
  }
  return { artifacts, packagingChain, acknowledgedPretestBaseline, sourceRoot: manifest.sourceDir, historicalSnapshot: { at: snapshot.at,
    playlists: snapshot.library.playlists.map(playlistDigest), queue: snapshot.queue, player: snapshot.player,
    originalUserOccurrences: snapshot.library.playlists.filter(p => /^p([1-9]|1[012])$/.test(p.id)).reduce((sum, p) => sum + p.items.length, 0) }, verifyFiles };
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (!options.execute) {
    console.log(JSON.stringify({ executed: false, requires: 'Explicit leader release, then --execute', endpoint: ENDPOINT,
      plan: ['Snapshot every existing playlist and queue; require stopped, empty queue, DX1 exclusive output and 0 dB',
        'New Chinese-path silent PCM imports at 44.1/48/96/192 kHz; exact path/subsong and progress readback',
        'Pause freeze, seek, stop; rapid switch and late playback suppression after stop',
        'Shared Initialize before/during/after foobar exclusive playback',
        'Exclusive Initialize hold without Start; blocked play, release, explicit retry',
        'Stop and compare original playlist hashes/order, queue, output and volume'],
      target: { backendDir: options.backendDir || null, baseUrl: options.baseUrl || null, sessionBaseline: options.sessionBaseline || null,
        requiresExplicitDedicatedBackend: true, requiresAudioWindowAck: true, pinsPidExecutableAndCreationTime: true },
      safety: ['No UI automation or application lifecycle actions', 'POST uncertainty suppresses automatic stop/queue/restore',
        'Evidence saved before bounded close; a client exit never proves a backend stop or revokes an old POST'],
      actualDacRate: null, physicalHotplug: 'requires user action; never simulated', dsdNative: 'unverified', dop: 'unverified', toppingAsio: 'unverified' }, null, 2));
    return;
  }
  const runId = Date.now();
  const existingProbes = options.existingProbes;
  const evidenceDir = path.join(__dirname, 'foobar-evidence', `acceptance-${runId}`);
  const probeDir = path.join(__dirname, 'foobar-probes', `验收-${runId}`);
  await fs.mkdir(evidenceDir, { recursive: true });
  const evidenceFile = path.join(evidenceDir, 'result.json');
  const packagedService = path.resolve(options.backendDir, '../../resources/app/src/main/foobar.js');
  invariant((await fs.stat(packagedService).catch(() => null))?.isFile(), 'Acceptance requires the exact packaged service; no developing-source fallback');
  const serviceModulePath = packagedService;
  const probeExe = path.resolve(path.dirname(serviceModulePath), '../../scripts/foobar-coreaudio-probe.exe');
  const { createFoobarService: createTestedService } = require(serviceModulePath);
  const evidence = { at: new Date().toISOString(), simulated: false, endpoint: ENDPOINT, actualDacRate: null,
    backendDir: options.backendDir, baseUrl: options.baseUrl,
    acceptanceScope: options.hotplug ? 'Physical same-endpoint disconnect/reconnect and playback retry; high-level disconnect feedback assessed separately' : 'Local playback and exclusive ownership',
    probeSha256: await fileHash(probeExe), probeBits: options.probeBits, sourceFixtureBits: 16,
    testedServiceModule: serviceModulePath, serviceSha256: await fileHash(serviceModulePath), harnessSha256: await fileHash(__filename),
    importMode: existingProbes ? 'existing owned probe paths only; new-path import unverified' : 'new non-ASCII owned paths; no fallback on 403',
    physicalHotplug: { tested: false, reason: 'No physical unplug/replug performed' },
    dsdNative: { tested: false }, dop: { tested: false }, toppingAsio: { tested: false, reason: 'No TOPPING ASIO driver; Microsoft usbaudio2 only per environment baseline' },
    quietAudioWindowAcknowledged: options.audioWindowAck === true,
    limitations: ['Packaged service/Beefweb acceptance; no trusted-renderer IPC or GUI inspection', 'No application launch/exit/restart or account/browser access', 'Actual DAC input format remains unknown'],
    steps: [], transport: [], diagnostics: [], passed: false };
  const record = (name, result) => { evidence.steps.push({ name, at: new Date().toISOString(), result }); return result; };
  const save = () => fs.writeFile(evidenceFile, JSON.stringify(evidence, null, 2));
  let playDispatchWaiter;
  const transport = createAcceptanceTransport({ beforePost: async () => { assertNoConflict(); await assertSession(); },
    onTrace: trace => evidence.transport.push(trace), onDispatch: trace => {
      if (trace.method === 'POST' && /\/player\/play\/[^/]+\/\d+$/.test(new URL(trace.route, options.baseUrl).pathname) && playDispatchWaiter) {
        record('realPlayRequestDispatched', { route: trace.route, at: trace.at }); playDispatchWaiter.resolve(); playDispatchWaiter = null;
      }
    } });
  const fetcher = transport.request;
  const service = createTestedService({ foobarDir: options.backendDir, baseUrl: options.baseUrl, dataDir: path.join(evidenceDir, 'service'),
    fetch: fetcher, probePath: probeExe, pollIntervalMs: 0, verifyTimeoutMs: 6000, onUpdate: observeState,
    onError: error => evidence.diagnostics.push({ at: new Date().toISOString(), error: error.message }) });
  let before, initial, initialRaw, originalQueue, mutated = false, holder, sourceContext, ownQueueAttempted = false, locations = [];
  let testPhase = 'setup', interference = null, ambiguousState = null, restorationSucceeded = false, libraryBefore, hotplugMonitoring = false;
  let sessionPin = null, approvedBaseline = null;
  const canWrite = () => !interference && !ambiguousState && !transport.status().uncertain;
  async function assertSession() {
    invariant(sessionPin, 'No verified process-session pin before mutation');
    try { return record('sameBackendSession', await inspectSession({ ...options, expected: sessionPin })); }
    catch (error) {
      if (!interference) interference = { at: new Date().toISOString(), reason: `Backend session identity changed or became unverifiable: ${error.message}` };
      record('stateConflict', interference); throw error;
    }
  }
  async function cleanupStep(name, action, timeoutMs = 6500) {
    if (!canWrite()) return record(`${name}:suppressed`, { reason: 'External/ambiguous state or unresolved POST; no automatic write', transport: transport.status() });
    const result = await settleBounded(action, timeoutMs);
    if (result.settled && result.status === 'fulfilled') return record(name, result.value);
    evidence.passed = false; process.exitCode = 1;
    if (!result.settled || transport.status().pendingPosts || ['STILL_HTTP_TIMEOUT', 'STILL_TRANSPORT_UNCERTAIN', 'ACCEPTANCE_POST_UNCERTAIN'].includes(result.error?.code)) {
      transport.markUncertain(result.error || 'Cleanup did not settle within its bound');
      service.cancelPending().catch(() => {});
    }
    record(`${name}:failed`, { error: result.error?.message || 'Cleanup remains pending', transport: transport.status() });
    await save(); return null;
  }
  async function libraryIndexSnapshot(label) {
    const runtimeRoot = path.resolve(options.backendDir, '../..'), file = path.join(runtimeRoot, 'data/library.json');
    const bytes = await fs.readFile(file), value = JSON.parse(bytes.toString('utf8'));
    await fs.writeFile(path.join(evidenceDir, `still-library-${label}.json`), bytes);
    const tracks = value.tracks || [], playlists = value.playlists || [];
    const testTracks = tracks.filter(track => /[\\/]scripts[\\/]foobar-probes(?:[\\/]|$)/i.test(track.path || ''));
    const testIds = new Set(testTracks.map(track => track.id));
    const temporaryPlaylists = playlists.filter(playlist => /^STILL · (?:Playback|Queue sources)/.test(playlist.name || '') ||
      (playlist.trackIds || []).some(id => testIds.has(id)));
    const coverFiles = (await fs.readdir(path.join(runtimeRoot, 'data/covers'), { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort();
    const summary = { at: new Date().toISOString(), file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      counts: { tracks: tracks.length, playlists: playlists.length, occurrences: playlists.reduce((sum, p) => sum + (p.trackIds || []).length, 0), covers: coverFiles.length },
      testTracks: testTracks.map(track => ({ id: track.id, path: track.path, subsong: track.subsong })),
      temporaryPlaylists: temporaryPlaylists.map(p => ({ id: p.id, name: p.name, sourcePlaylistId: p.sourcePlaylistId, trackIds: p.trackIds })),
      playlists: playlists.map(p => ({ id: p.id, name: p.name, sourcePlaylistId: p.sourcePlaylistId, trackIds: p.trackIds })), coverFiles };
    record(`stillLibrary:${label}`, summary); return summary;
  }
  function observeState(current) {
    if (!initial || testPhase === 'setup' || !current.available) return;
    const reason = current.output?.id !== initial.output?.id && !(hotplugMonitoring && !current.output) ? 'Output selection changed unexpectedly' :
      digest(current.volumeInfo) !== digest(initial.volumeInfo) ? 'Volume or mute state changed unexpectedly' :
      current.playbackOrder?.id !== initial.playbackOrder?.id ? 'Playback order changed unexpectedly' :
      current.currentTrack && testPhase === 'tests' && !locations.some(item => locationKey(item) === locationKey(current.currentTrack)) ? 'Unexpected track selected during silent tests' :
      current.currentTrack && testPhase === 'restore' && locationKey(current.currentTrack) !== locationKey(initial.currentTrack) ? 'Unexpected track selected during restoration' : null;
    if (reason && !interference) { interference = { at: new Date().toISOString(), reason, state: current, cause: 'external or unexpected state change; no cause assumed' }; record('stateConflict', interference); }
  }
  function assertNoConflict() { invariant(!interference && !ambiguousState, interference?.reason || ambiguousState?.reason || 'Unexpected state conflict'); }
  async function api(route, body) {
    if (body !== undefined) { assertNoConflict(); return transport.directPost(new URL(route, options.baseUrl), body); }
    const response = await fetcher(new URL(route, options.baseUrl), { signal: AbortSignal.timeout(5000) });
    invariant(response.ok, `Acceptance API ${route}: HTTP ${response.status}`); const text = await response.text(); return text ? JSON.parse(text) : null;
  }
  async function rawPlayer() { return (await api(`player?columns=${encodeURIComponent(COLUMNS.join(','))}`)).player; }
  async function restoreInitialPaused() {
    assertNoConflict(); testPhase = 'tests';
    transport.assertMutable(); await service.cancelPending();
    await service.getState(); assertNoConflict();
    const ref = initialRaw.activeItem;
    const queue = await service.queueList(); invariant(digest(queue) === digest(originalQueue), 'Queue differs before restoring the original reference');
    const page = (await api(`playlists/${encodeURIComponent(ref.playlistId)}/items/${ref.index}:1?columns=${encodeURIComponent(COLUMNS.join(','))}`)).playlistItems;
    invariant(page?.items?.length === 1 && locationKey(trackFromColumns(page.items[0].columns)) === locationKey(initial.currentTrack), 'Original playlist reference no longer identifies the same track');
    testPhase = 'restore';
    record('restoreExactReference', { playlistId: ref.playlistId, index: ref.index, position: initial.position });
    await api(`player/play/${encodeURIComponent(ref.playlistId)}/${ref.index}`, {});
    // Pause immediately after the play request settles, without waiting for progress.
    await api('player/pause', {});
    const until = Date.now() + 2000; let paused;
    do { paused = await service.getState(); assertNoConflict(); if (paused.state === 'paused' && locationKey(paused.currentTrack || {}) === locationKey(initial.currentTrack)) break; await sleep(40); } while (Date.now() < until);
    invariant(paused.state === 'paused', 'Original track did not pause after the immediate restoration pause');
    record('restoreSeek', await service.seek(initial.position)); assertNoConflict();
    const rawFirst = record('restoreRawReadback', await rawPlayer()); const first = record('restoreStateReadback', await service.getState()); await sleep(500);
    const lastRaw = record('restoreRawFrozenReadback', await rawPlayer()); const last = record('restoreFrozenReadback', await service.getState()); assertNoConflict();
    invariant(rawFirst.activeItem?.playlistId === ref.playlistId && rawFirst.activeItem?.index === ref.index &&
      lastRaw.activeItem?.playlistId === ref.playlistId && lastRaw.activeItem?.index === ref.index && first.state === 'paused' && last.state === 'paused' &&
      locationKey(last.currentTrack || {}) === locationKey(initial.currentTrack) && Math.abs(last.position - initial.position) < 0.05 && Math.abs(first.position - last.position) < 0.01,
    'Exact original reference, paused position or frozen state could not be restored');
    restorationSucceeded = true; record('restorationVerified', { restored: true, playlistId: ref.playlistId, index: ref.index, position: last.position, state: last.state });
  }
  async function runPhysicalHotplug() {
    invariant(!existingProbes, 'Physical hotplug uses its own new 300-second silence fixture');
    invariant(options.probeBits === 32, 'Physical hotplug requires explicit previously supported 32-bit probe format');
    await fs.mkdir(probeDir, { recursive: true });
    const wanted = { path: path.join(probeDir, '物理拔插-48000赫兹-16位-立体声-300秒.wav'), subsong: 0 };
    await fs.writeFile(wanted.path, makeSilentWav(48000, 300), { flag: 'wx' }); locations.push(wanted);
    record('hotplugFixture', { ...wanted, seconds: 300, sourceRate: 48000, sourceBits: 16, channels: 2,
      requestedPCMFormat: { sampleRate: 48000, bits: 32, channels: 2 }, actualDacRate: null });
    const endpointBefore = await probe('state'); invariant(endpointBefore.active === true, 'Exact DX1 endpoint was not ACTIVE before hotplug playback');
    mutated = true; const playing = record('hotplugInitialPlayVerified', await service.play({ locations: [wanted] })); assertNoConflict(); selected(playing);
    invariant(playing.currentTrack?.sampleRate === 48000 && playing.currentTrack?.bitsPerSample === 16 && Math.abs(playing.duration - 300) < 0.1,
      'Long silent source metadata did not match the physical fixture');
    const exclusive = await probe('shared'); invariant(exclusive.deviceInUse === true, 'No initial exclusive ownership evidence before READY');
    record('hotplugReadyAudioDetails', await service.audioDetails());
    const readyAt = Date.now(), deadline = readyAt + 270000;
    evidence.physicalHotplug = { tested: false, status: 'READY-awaiting-user-physical-action', readyAt: new Date(readyAt).toISOString(),
      deadline: new Date(deadline).toISOString(), monitorSeconds: 270, endpoint: ENDPOINT, desiredOutput: initial.output,
      initialNativeEndpointState: endpointBefore, sourceRate: 48000, sourceBits: 16, actualDacRate: null };
    record('hotplugREADY', evidence.physicalHotplug); await save();
    console.log(JSON.stringify({ event: 'HOTPLUG_READY', evidenceFile, session: sessionPin, endpoint: ENDPOINT, source: wanted.path,
      readyAt: new Date(readyAt).toISOString(), maintainUntil: new Date(deadline).toISOString(),
      instruction: 'Only the user should unplug USB, wait about five seconds, and reconnect the same port; monitoring is read-only until native same-endpoint ACTIVE returns',
      stopConditions: ['unexpected track/output/volume/order change', 'native disconnect then reconnect captured', '270-second user-action window elapsed'], actualDacRate: null }));
    hotplugMonitoring = true; let disconnectedAt = null, reconnectedAt = null, priorObservation = null, unexpectedPlaybackSamples = 0;
    while (Date.now() < deadline) {
      await assertSession();
      const native = await probe('state');
      const state = await service.getState(); let outputReadback = null, outputError = null;
      try { outputReadback = await service.outputs(); } catch (error) { outputError = error.message; }
      const row = { at: new Date().toISOString(), nativeEndpointState: native,
        backend: { available: state.available, state: state.state, position: state.position, output: state.output, error: state.error || null,
          currentTrack: state.currentTrack, volumeInfo: state.volumeInfo, playbackOrder: state.playbackOrder },
        backendReachable: state.backendReachable, outputConnection: state.outputConnection, nativeDacConnected: native.active === true,
        selectedRawOutput: outputReadback?.active || null, normalizedSelectedOutput: outputReadback?.selected || null, outputError };
      record('hotplugObservation', row);
      if (!disconnectedAt && native.active === true) {
        if (state.state === 'paused' || state.state === 'stopped') unexpectedPlaybackSamples++; else unexpectedPlaybackSamples = 0;
        if (unexpectedPlaybackSamples >= 2) { ambiguousState = { reason: 'Playback changed without a native endpoint disappearance in two observations; cause not established', row }; record('ambiguousPlaybackState', ambiguousState); }
        if (state.state === 'playing' && priorObservation?.backend.state === 'playing' && priorObservation.nativeDacConnected === true) {
          const delta = state.position - priorObservation.backend.position, elapsed = (Date.parse(row.at) - Date.parse(priorObservation.at)) / 1000;
          if (delta < -0.2 || delta > elapsed + 1.5) { interference = { at: row.at, reason: 'Unexpected position jump while native endpoint remained ACTIVE; no seek overwrite performed', delta, elapsed, row }; record('stateConflict', interference); }
        }
      }
      if (outputReadback?.active && (outputReadback.active.typeId !== initial.output.typeId || outputReadback.active.deviceId !== initial.output.deviceId)) {
        interference = { at: row.at, reason: 'Raw desired output identifier changed during physical hotplug; not overwritten', outputReadback }; record('stateConflict', interference);
      }
      assertNoConflict();
      if (!disconnectedAt && native.active !== true && (native.state != null || native.deviceNotFound === true)) {
        disconnectedAt = Date.now(); evidence.physicalHotplug.status = 'native-disconnected-awaiting-same-endpoint';
        evidence.physicalHotplug.disconnectedAt = new Date(disconnectedAt).toISOString();
        const details = record('hotplugDisconnectedAudioDetails', await service.audioDetails());
        const assessment = disconnectFeedback({ native, state, details });
        const explicitFeedback = assessment.hasExplicitDeviceDisconnectFeedback;
        evidence.physicalHotplug.highLevelDisconnectFeedbackCovered = explicitFeedback;
        if (!explicitFeedback) evidence.capabilityGaps = [...(evidence.capabilityGaps || []), 'Packaged normalized player/audioDetails did not confirm exact-endpoint disconnected/retryRequired separately from backendReachable'];
        record('hotplugDisconnectFeedbackAssessment', { ...assessment, backendReachable: state.backendReachable, nativeDacConnected: false,
          normalizedState: state.state, normalizedOutput: state.output, normalizedError: state.error || null, audioDetails: details,
          hasExplicitDeviceDisconnectFeedback: explicitFeedback,
          capabilityGap: !explicitFeedback ? 'Exact normalized connection fields failed; HTTP failure or error wording does not prove device disconnection' : null });
        console.log(JSON.stringify({ event: 'HOTPLUG_NATIVE_DISCONNECTED', at: row.at, native, normalizedState: state.state, normalizedError: state.error || null,
          selectedRawOutput: row.selectedRawOutput, explicitDeviceDisconnectFeedback: explicitFeedback }));
      } else if (disconnectedAt && native.active === true) {
        reconnectedAt = Date.now(); evidence.physicalHotplug.status = 'same-endpoint-ACTIVE-awaiting-explicit-retry';
        evidence.physicalHotplug.reconnectedAt = new Date(reconnectedAt).toISOString();
        record('hotplugReconnectedAudioDetails', await service.audioDetails()); await save(); break;
      }
      priorObservation = row;
      await save(); await sleep(1000);
    }
    if (!disconnectedAt || !reconnectedAt) {
      evidence.physicalHotplug.status = 'incomplete-user-action-window-ended'; evidence.physicalHotplug.tested = false;
      throw new Error('Physical unplug/replug cycle not fully observed in the user-action window; no hardware failure inferred');
    }
    const beforeRetry = record('hotplugBeforeExplicitRetry', await service.getState()); await sleep(550);
    const beforeRetryEnd = record('hotplugBeforeExplicitRetryEnd', await service.getState()); assertNoConflict();
    const autoProgress = beforeRetry.state === 'playing' && beforeRetryEnd.state === 'playing' && beforeRetryEnd.position > beforeRetry.position + 0.2;
    record('hotplugAutomaticResumeAssessment', { automaticProgressObservedBeforeExplicitRetry: autoProgress,
      interpretation: 'Readback observation before this harness sends a new play; no application auto-play POST is inferred from a state label alone' });
    invariant(!autoProgress, 'Playback progressed after reconnection before explicit retry; automatic resumption cannot be accepted');
    const retry = record('hotplugExplicitReconnectRetry', await service.play({ locations: [wanted] })); assertNoConflict(); selected(retry);
    const p0 = record('hotplugRetryProgressStart', await service.getState()); await sleep(450);
    const p1 = record('hotplugRetryProgressEnd', await service.getState()); assertNoConflict();
    invariant(p1.state === 'playing' && locationKey(p1.currentTrack || {}) === locationKey(wanted) && p1.position > p0.position + 0.2,
      'Same-endpoint explicit retry did not progress after reconnect');
    const sharedDuringRetry = await probe('shared'); invariant(sharedDuringRetry.deviceInUse === true, 'No exclusive ownership differential after reconnect retry');
    record('hotplugRetryAudioDetails', await service.audioDetails());
    record('hotplugFinalTestStop', await service.stop());
    const released = await probe('shared'); invariant(released.initialized === true, 'Endpoint did not release after hotplug test stop');
    const exclusiveAvailable = await probe('exclusive-check'); invariant(exclusiveAvailable.initialized && exclusiveAvailable.released, 'Endpoint exclusive availability did not recover after reconnect');
    evidence.physicalHotplug = { ...completePhysicalHotplug(evidence.physicalHotplug, {
      disconnectedAt, reconnectedAt, sameEndpoint: true, explicitRetryVerified: true }), automaticOutputFallbackObserved: false };
    record('hotplugAcceptanceAssessment', evidence.physicalHotplug);
    hotplugMonitoring = false;
    invariant(evidence.physicalHotplug.passed === true, 'Physical cycle was observed, but complete normalized exact-endpoint feedback/retry acceptance was not verified');
  }
  async function fullSnapshot() {
    // The service intentionally omits owned temporary deck contents from its public
    // library view; preservation acceptance must independently read every item.
    const read = async route => { const response = await fetcher(new URL(route, options.baseUrl), { signal: AbortSignal.timeout(5000) });
      invariant(response.ok, `Preservation snapshot HTTP ${response.status}`); return response.json(); };
    const list = await read('playlists'); invariant(Array.isArray(list.playlists), 'Invalid complete playlist list');
    const result = [];
    for (const playlist of list.playlists) {
      const items = []; let offset = 0, total = Infinity;
      while (offset < total) {
        const page = (await read(`playlists/${encodeURIComponent(playlist.id)}/items/${offset}:500?columns=${encodeURIComponent(COLUMNS.join(','))}`)).playlistItems;
        invariant(page && Array.isArray(page.items) && Number.isInteger(page.totalCount) && page.totalCount >= 0 && page.offset === offset &&
          (total === Infinity || total === page.totalCount), 'Playlist changed while capturing complete preservation snapshot');
        total = page.totalCount;
        items.push(...page.items.map((item, i) => ({ ...trackFromColumns(item.columns), playlistId: playlist.id, itemIndex: offset + i })));
        invariant(page.items.length || offset >= total, 'Incomplete preservation snapshot page'); offset += page.items.length;
      }
      result.push({ id: playlist.id, name: playlist.title, items });
    }
    return { readAt: new Date().toISOString(), playlists: result, source: 'dedicated-foobar2000', scope: 'all-existing-playlist-contents' };
  }
  async function supersedeDispatchedPlay(location, next) {
    let resolve, reject; const sent = new Promise((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => reject(new Error('No real play POST dispatched before supersession test')), 6000);
    playDispatchWaiter = { resolve, reject };
    const first = service.play({ locations: [location] }); first.catch(reject);
    try { await sent; } finally { clearTimeout(timer); playDispatchWaiter = null; }
    // No fake network response or delay: supersede a genuinely dispatched POST.
    return Promise.allSettled([first, next()]);
  }
  async function probe(mode, rate = 48000) {
    if (mode !== 'state') { assertNoConflict(); transport.assertMutable(); await assertSession(); }
    return new Promise((resolve, reject) => {
      const child = spawn(probeExe, [ENDPOINT, mode, String(rate), String(options.probeBits)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('CoreAudio probe timed out')); }, 6000);
      child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); try { const rows = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
        record(`coreAudio:${mode}:${rate}`, { code, rows, stderr }); invariant(code === 0 && rows.length, `CoreAudio probe failed: ${stdout} ${stderr}`); resolve(rows[0]);
      } catch (error) { reject(error); } });
    });
  }
  async function startHold() {
    assertNoConflict(); transport.assertMutable(); await assertSession();
    const child = spawn(probeExe, [ENDPOINT, 'hold', '48000', String(options.probeBits), '30000'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const rows = []; let partial = '', stderr = '', settle;
    const ready = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const timer = setTimeout(() => settle.reject(new Error('Exclusive holder did not report ready')), 5000);
    const exited = new Promise((resolve, reject) => {
      child.stdout.on('data', b => { partial += b; let end; while ((end = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, end).trim(); partial = partial.slice(end + 1); if (!line) continue;
        try { const row = JSON.parse(line); rows.push(row); if (row.ready === true) { clearTimeout(timer); settle.resolve(row); }
          else if (row.initialized === false || row.error) settle.reject(new Error(`Exclusive holder failed: ${line}`));
        } catch (error) { settle.reject(error); }
      } });
      child.stderr.on('data', b => { stderr += b; }); child.on('error', error => { clearTimeout(timer); settle.reject(error); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (!rows.some(row => row.ready)) settle.reject(new Error(`Exclusive holder exited ${code}: ${stderr}`)); resolve({ code, rows, stderr }); });
    });
    // Attach the observer before awaiting ready so spawn failures cannot be unhandled.
    exited.catch(() => {});
    holder = { child, exited, release: async () => { if (child.exitCode == null && !child.killed) child.stdin.end('release\n');
      const result = await exited; record('exclusiveHoldLifecycle', result); holder = null; return result; } };
    const result = await ready; record('exclusiveHoldReady', result); return holder;
  }
  const selected = state => invariant(state.output?.typeId === 'output' && state.output?.deviceId === DEVICE_ID,
    'Selected output changed or is not the exact DX1 exclusive device');
  const stoppedStable = async name => {
    const first = record(`${name}:first`, await service.getState()); await sleep(1000);
    const second = record(`${name}:after1s`, await service.getState());
    invariant(first.state === 'stopped' && second.state === 'stopped', 'Playback revived after stop'); selected(second);
  };
  try {
    approvedBaseline = JSON.parse(await fs.readFile(path.resolve(options.sessionBaseline), 'utf8'));
    invariant(approvedBaseline.readOnly === true && approvedBaseline.simulated === false && approvedBaseline.session &&
      approvedBaseline.queueLength === 0 && ['stopped', 'paused'].includes(approvedBaseline.player?.state), 'Reviewed current-session baseline is missing or unsafe');
    const runtimeBaseline = JSON.parse(await fs.readFile(path.join(path.dirname(path.resolve(options.sessionBaseline)), 'owner-runtime-hashes.json'), 'utf8'));
    const packageRoot = path.resolve(options.backendDir, '../..');
    const buildInfo = JSON.parse(await fs.readFile(path.join(packageRoot, 'BUILD-INFO.json'), 'utf8'));
    invariant(buildInfo.sourceFrozenSnapshot === runtimeBaseline.sourceFrozenSnapshot, 'Packaged frozen snapshot differs from the reviewed runtime baseline');
    const approvedRuntime = [];
    for (const item of runtimeBaseline.runtime) {
      const file = path.resolve(packageRoot, 'resources/app', item.path), delta = path.relative(path.join(packageRoot, 'resources/app'), file);
      invariant(delta && !delta.startsWith('..') && !path.isAbsolute(delta), 'Approved runtime path escapes the package');
      const actual = await fileHash(file);
      approvedRuntime.push({ path: item.path, expected: item.packaged, actual, matches: actual === item.packaged && item.packaged === item.recorded });
    }
    invariant(approvedRuntime.length === 27 && approvedRuntime.every(item => item.matches), 'Approved 27 packaged runtime/native/probe files changed; developing source is not compared');
    const packageHashes = [];
    for (const [relative, expected] of Object.entries(buildInfo.hashes)) {
      const file = path.resolve(packageRoot, relative), delta = path.relative(packageRoot, file);
      invariant(delta && !delta.startsWith('..') && !path.isAbsolute(delta), 'Package hash path escapes its root');
      const actual = await fileHash(file); packageHashes.push({ path: relative, expected, actual, matches: actual === expected });
    }
    invariant(packageHashes.length > 0 && packageHashes.every(item => item.matches), 'Running package immutable/runtime hash mismatch; developing source is not an acceptance target');
    record('packagedFrozenRuntime', { sourceFrozenSnapshot: buildInfo.sourceFrozenSnapshot, builtAt: buildInfo.builtAt,
      approvedRuntime, hashes: packageHashes, comparison: 'Packaged BUILD-INFO and approved package snapshot only; developing source is intentionally independent' });
    const processSnapshot = record('privateBackendProcess', await inspectSession({ ...options, expected: approvedBaseline.session }));
    sessionPin = processSnapshot.session; evidence.boundSession = sessionPin;
    evidence.approvedSessionBaseline = { file: path.resolve(options.sessionBaseline), sha256: await fileHash(path.resolve(options.sessionBaseline)) };
    sourceContext = await preservationContext(options);
    record('originalSourceArtifacts', { artifacts: sourceContext.artifacts, sourceRoot: sourceContext.sourceRoot, historicalSnapshot: sourceContext.historicalSnapshot,
      packagingChain: sourceContext.packagingChain, acknowledgedPretestBaseline: sourceContext.acknowledgedPretestBaseline });
    const filesBefore = record('sourceAndBundleFilesBefore', await sourceContext.verifyFiles());
    invariant(filesBefore.unchanged, 'Original source or private immutable bundle hashes changed before acceptance');
    libraryBefore = await libraryIndexSnapshot('before');
    initial = record('initialState', await service.initialize());
    invariant(initial.available, initial.error || 'Backend unavailable');
    initialRaw = record('initialRawPlayer', await rawPlayer());
    evidence.initialUserState = { state: initial, rawPlayer: initialRaw };
    before = await fullSnapshot(); await fs.writeFile(path.join(evidenceDir, 'playlists-before.json'), JSON.stringify(before, null, 2));
    record('originalPlaylistDigests', before.playlists.map(playlistDigest));
    originalQueue = record('originalQueue', await service.queueList());
    record('originalOutputs', await service.outputs());
    const approvedLists = JSON.parse(await fs.readFile(path.join(path.dirname(path.resolve(options.sessionBaseline)), 'owner-playlists-complete.json'), 'utf8'));
    const approvedDigests = approvedLists.playlists.map(list => playlistDigest({ id: list.id, name: list.title,
      items: list.items.map((item, itemIndex) => ({ ...trackFromColumns(item.columns), playlistId: list.id, itemIndex })) }));
    invariant(digest(approvedDigests) === digest(before.playlists.map(playlistDigest)), 'User playlist contents changed since the reviewed baseline; no playback permitted');
    const approvedOrder = approvedBaseline.player.options?.find(item => item.id === 'playbackOrder')?.value ?? approvedBaseline.player.playbackMode;
    invariant(initial.state === approvedBaseline.player.state && initial.output?.typeId === approvedBaseline.rawOutput?.typeId &&
      initial.output?.deviceId === approvedBaseline.rawOutput?.deviceId && digest(initial.volumeInfo) === digest(approvedBaseline.player.volume) &&
      initial.playbackOrder?.id === approvedOrder && libraryBefore.sha256 === approvedBaseline.library.sha256,
    'User playback/output/order/volume/formal library changed since the reviewed baseline');
    invariant(approvedBaseline.player.path ? locationKey(initial.currentTrack || {}) === locationKey({ path: approvedBaseline.player.path, subsong: Number(approvedBaseline.player.subsong) }) &&
      initialRaw.activeItem?.playlistId === approvedBaseline.player.playlistId && initialRaw.activeItem?.index === approvedBaseline.player.index &&
      (initial.state !== 'paused' || Math.abs(initial.position - approvedBaseline.player.position) < 0.01) : !initial.currentTrack && !initialRaw.activeItem?.columns?.[0],
    'Current user track/reference/paused position differs from the reviewed baseline; no old track restoration or test overwrite permitted');
    const rootsResponse = await fetcher(new URL('browser/roots', options.baseUrl), { signal: AbortSignal.timeout(5000) });
    invariant(rootsResponse.ok, `Cannot read dedicated backend allowed roots: HTTP ${rootsResponse.status}`);
    record('dedicatedBackendAllowedRoots', await rootsResponse.json());
    invariant(originalQueue.items.length === 0, 'User queue is nonempty; refusing playback to preserve it');
    invariant(initial.state === 'stopped' || (initial.state === 'paused' && options.stopInitialPaused), 'Playback must be stopped or explicitly authorized initial paused before acceptance'); selected(initial);
    invariant(initial.volumeInfo?.type === 'db' && initial.volumeInfo.value === 0, 'Baseline is not 0 dB; no volume change permitted');
    if (initial.state === 'paused') {
      invariant(initial.currentTrack && typeof initialRaw.activeItem?.playlistId === 'string' && Number.isInteger(initialRaw.activeItem?.index) && initialRaw.activeItem.index >= 0 &&
        initialRaw.playbackState === 'paused' && Math.abs(initialRaw.activeItem.position - initial.position) < 0.01 &&
        locationKey(trackFromColumns(initialRaw.activeItem.columns)) === locationKey(initial.currentTrack), 'Initial paused raw reference/position does not match the captured user state');
      const preStop = record('initialPausedBeforeAuthorizedStop', await service.getState());
      invariant(preStop.state === 'paused' && locationKey(preStop.currentTrack || {}) === locationKey(initial.currentTrack) &&
        Math.abs(preStop.position - initial.position) < 0.01 && preStop.output?.id === initial.output?.id && digest(preStop.volumeInfo) === digest(initial.volumeInfo) &&
        preStop.playbackOrder?.id === initial.playbackOrder?.id, 'User state changed before authorized initial stop; no mutation performed');
      evidence.initialUserState.queue = originalQueue; mutated = true; testPhase = 'tests';
      record('authorizedTestStop', await service.stop());
      assertNoConflict();
    }
    testPhase = 'tests';
    record('privateBackendBaseline', { playlistCount: before.playlists.length, occurrences: before.playlists.reduce((sum, p) => sum + p.items.length, 0),
      note: 'Private backend can start empty; original user playlists are preserved separately by stored snapshot and file hashes' });
    const atRest = await probe('shared'); invariant(atRest.initialized, 'Shared Initialize at rest did not succeed');
    const exclusiveAtRest = await probe('exclusive-check');
    invariant(exclusiveAtRest.initialized && exclusiveAtRest.released && exclusiveAtRest.startCalled === false, 'Endpoint exclusive availability check failed');
    if (options.hotplug) { await runPhysicalHotplug(); evidence.passed = evidence.physicalHotplug.passed === true; return evidence; }
    if (!existingProbes) await fs.mkdir(probeDir, { recursive: true });
    for (const rate of RATES) {
      const file = existingProbes ? path.join(__dirname, 'foobar-probes', `silence-${rate}-16bit-stereo.wav`) : path.join(probeDir, `静音-${rate}赫兹-16位-立体声.wav`);
      if (existingProbes) {
        invariant(before.playlists.some(p => p.items.some(item => locationKey(item) === locationKey({ path: file, subsong: 0 }))), `Existing owned probe is not already indexed: ${file}`);
        invariant((await fs.readFile(file)).equals(makeSilentWav(rate)), `Existing probe content is not expected silence: ${file}`);
      } else await fs.writeFile(file, makeSilentWav(rate), { flag: 'wx' });
      locations.push({ path: file, subsong: 0 });
    }
    record(existingProbes ? 'existingProbeFiles' : 'newProbeFiles', locations.map((location, i) => ({ ...location, sourceRate: RATES[i], sourcePCMFormat: { sampleRate: RATES[i], bits: 16, channels: 2 },
      requestedPCMFormat: { sampleRate: RATES[i], bits: options.probeBits, channels: 2 }, actualDacRate: null })));
    for (let i = 0; i < RATES.length; i++) {
      assertNoConflict();
      const rate = RATES[i], wanted = locations[i];
      const support = await probe('support', rate); invariant(support.supported, `Exclusive probe PCM format ${rate}/${options.probeBits}/2 unsupported`);
      mutated = true;
      const playing = record(`pcm:${rate}:playVerified`, await service.play({ locations: [wanted] })); selected(playing);
      invariant(locationKey(playing.currentTrack || {}) === locationKey(wanted), 'Exact newly imported path/subsong not selected');
      const p0 = record(`pcm:${rate}:progressStart`, await service.getState()); await sleep(400);
      const p1 = record(`pcm:${rate}:progressEnd`, await service.getState());
      assertNoConflict();
      if (p1.state !== 'playing') { ambiguousState = { reason: 'Unexpected playback state during steady silent progress check; cause not established', state: p1 }; record('ambiguousPlaybackState', ambiguousState); assertNoConflict(); }
      invariant(p1.state === 'playing' && p1.position > p0.position + 0.15, 'Real playback time did not progress');
      invariant(p1.currentTrack?.sampleRate === rate && p1.currentTrack?.bitsPerSample === 16 && p1.currentTrack?.channels === 2,
        'Decoded source metadata did not match the real silent PCM fixture');
      record(`pcm:${rate}:sourceAndRequested`, { sourceRate: p1.currentTrack?.sampleRate ?? null, sourceBits: p1.currentTrack?.bitsPerSample ?? null,
        requestedPCMFormat: { sampleRate: rate, bits: options.probeBits, channels: 2 }, actualDacRate: null, actualDacBits: null });
      const occupied = await probe('shared'); invariant(occupied.deviceInUse && occupied.hresult === '0x8889000A', 'No exclusive ownership differential while playing');
      if (i === 0) {
        record('pauseVerified', await service.pause());
        // Foobar's first paused readback can still report a settling output cursor.
        // Record that transition, require three stable samples within one second,
        // then independently verify a further half-second remains frozen.
        const samples = []; const settleDeadline = Date.now() + 1000; let stable = 0, prior = null, settled;
        do { settled = await service.getState(); assertNoConflict(); samples.push({ at: new Date().toISOString(), state: settled.state, position: settled.position });
          invariant(settled.state === 'paused', 'Pause did not remain paused during cursor settling');
          stable = prior != null && Math.abs(settled.position - prior) < 0.001 ? stable + 1 : 0; prior = settled.position;
          if (stable >= 2) break; await sleep(100);
        } while (Date.now() < settleDeadline);
        record('pauseCursorSettling', samples); invariant(stable >= 2, 'Paused cursor did not settle within one second');
        const frozen = record('pauseStart', settled); await sleep(500);
        const frozenEnd = record('pauseEnd', await service.getState()); invariant(frozen.state === 'paused' && frozenEnd.state === 'paused' && Math.abs(frozen.position - frozenEnd.position) < 0.01, 'Pause position did not freeze');
        const seek = record('seekVerified', await service.seek(3)); invariant(Math.abs(seek.position - 3) < 0.25, 'Seek position not read back');
      }
      record(`pcm:${rate}:stopVerified`, await service.stop()); await sleep(300);
      const released = await probe('shared'); invariant(released.initialized, 'Shared Initialize did not recover after stop');
    }
    ownQueueAttempted = true;
    const queued = record('duplicateQueueAdded', await service.queueAdd([locations[0], locations[0]]));
    invariant(queued.items.length === 2 && queued.items.every(item => locationKey(item) === locationKey(locations[0])), 'Duplicate queue occurrences did not retain exact identity');
    invariant(typeof queued.items[0].playlistId === 'string' && Number.isInteger(queued.items[0].itemIndex) &&
      queued.items[0].playlistId === queued.items[1].playlistId && queued.items[0].itemIndex === queued.items[1].itemIndex,
    'Duplicate queue references were not read back as the same exact source item');
    if (typeof service.cleanupOwnedDecks === 'function') record('cleanupWhileDuplicateQueueAlive', await service.cleanupOwnedDecks());
    const queueAfterCleanup = record('duplicateQueueAfterCleanup', await service.queueList());
    invariant(digest(queued) === digest(queueAfterCleanup), 'Owned-deck cleanup invalidated queued references');
    const oneLeft = record('duplicateQueueRemoveFirst', await service.queueRemove(0));
    invariant(oneLeft.items.length === 1 && locationKey(oneLeft.items[0]) === locationKey(locations[0]) &&
      oneLeft.items[0].playlistId === queued.items[1].playlistId && oneLeft.items[0].itemIndex === queued.items[1].itemIndex,
    'Removing one occurrence invalidated the remaining duplicate reference');
    const emptyQueue = record('duplicateQueueRemoveLast', await service.queueRemove(0)); invariant(emptyQueue.items.length === 0, 'Test queue did not return to original empty state');
    const switched = await supersedeDispatchedPlay(locations[0], () => service.play({ locations: [locations[1]] }));
    record('rapidSwitchOutcomes', switched.map(safeOutcome));
    const last = record('rapidSwitchReadback', await service.getState());
    invariant(last.state === 'playing' && locationKey(last.currentTrack || {}) === locationKey(locations[1]), 'Latest rapid switch did not win'); selected(last);
    const stopped = await supersedeDispatchedPlay(locations[2], () => service.stop());
    record('rapidPlayStopOutcomes', stopped.map(safeOutcome)); await stoppedStable('latePlaySuppressed');
    const hold = await startHold();
    const heldShared = await probe('shared'); invariant(heldShared.deviceInUse, 'Exclusive holder did not block shared Initialize');
    let blockedError = null;
    try { record('heldPlayUnexpectedSuccess', await service.play({ locations: [locations[1]] })); }
    catch (error) { blockedError = error.message; record('heldPlayRejected', { error: error.message, rawOutputErrorAvailable: false,
      interpretation: 'Playback not confirmed while this endpoint was held; Beefweb does not expose the native output error' }); }
    invariant(blockedError, 'Play was confirmed while endpoint was exclusively held');
    const blocked = record('heldPlayReadback', await service.getState()); selected(blocked); invariant(blocked.state === 'stopped', 'Failed output did not settle stopped');
    await hold.release();
    const releasedShared = await probe('shared'); invariant(releasedShared.initialized, 'Holder release did not restore shared Initialize');
    const exclusiveAfterRelease = await probe('exclusive-check');
    invariant(exclusiveAfterRelease.initialized && exclusiveAfterRelease.released, 'Holder release did not restore exclusive availability');
    const retry = record('explicitRetryVerified', await service.play({ locations: [locations[1]] })); selected(retry);
    invariant(retry.state === 'playing', 'Explicit retry failed'); record('finalStop', await service.stop()); await stoppedStable('finalStopped');
    record('audioDetails', await service.audioDetails());
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.message; evidence.passed = false; process.exitCode = 1;
    if (transport.noteCallerFailure(error)) service.cancelPending().catch(() => {});
    evidence.transportSafety = transport.status(); await save();
  }
  finally {
    await save();
    if (holder) {
      const released = await settleBounded(() => holder.release(), 2500);
      if (!released.settled || released.status === 'rejected') { record('holdReleaseError', { error: released.error?.message || 'Owned holder release remains unconfirmed; its native hold is time-limited', applicationLifecycleAction: false }); evidence.passed = false; process.exitCode = 1; }
    }
    if (mutated) await cleanupStep('cleanupStop', () => service.stop());
    if (ownQueueAttempted && originalQueue?.items.length === 0 && canWrite()) {
      await cleanupStep('cleanupOwnQueue', async () => { const queue = await service.queueList();
        if (queue.items.length) {
          invariant(queue.items.every(item => locations.some(location => locationKey(location) === locationKey(item))), 'Queue contains an unexpected item; cannot safely clear it');
          return service.queueClear();
        }
        return { unchangedEmptyQueue: true };
      });
    }
    if (mutated && initial?.state === 'paused' && options.restoreInitialPaused && canWrite()) {
      const restored = await cleanupStep('restoreInitialPaused', () => restoreInitialPaused(), 20000);
      if (!restorationSucceeded) { evidence.restorationError = restored?.error || 'Paused restoration was not confirmed'; evidence.passed = false; process.exitCode = 1; }
    }
    if (initial) try {
      const final = record('finalState', await service.getState()); const queue = record('finalQueue', await service.queueList());
      const finalRaw = record('finalRawPlayer', await rawPlayer());
      const after = await fullSnapshot(); await fs.writeFile(path.join(evidenceDir, 'playlists-after.json'), JSON.stringify(after, null, 2));
      if (before) { const baseline = before.playlists.map(playlistDigest); const afterById = new Map(after.playlists.map(p => [p.id, playlistDigest(p)]));
        const preserved = record('preservation', { originalPlaylistsUnchanged: baseline.every(p => JSON.stringify(p) === JSON.stringify(afterById.get(p.id))),
          before: baseline, after: baseline.map(p => afterById.get(p.id)), queueUnchanged: originalQueue && digest(originalQueue) === digest(queue),
          selectedOutputUnchanged: initial?.output?.id === final.output?.id, volumeUnchanged: digest(initial?.volumeInfo) === digest(final.volumeInfo),
          playbackOrderUnchanged: initial?.playbackOrder?.id === final.playbackOrder?.id,
          currentReferenceUnchanged: initialRaw.activeItem?.playlistId === finalRaw.activeItem?.playlistId && initialRaw.activeItem?.index === finalRaw.activeItem?.index,
          finalStopped: final.state === 'stopped', initialPausedRestored: restorationSucceeded,
          expectedFinalStateVerified: initial.state === 'paused' && options.restoreInitialPaused ? restorationSucceeded && final.state === 'paused' &&
            locationKey(final.currentTrack || {}) === locationKey(initial.currentTrack) && Math.abs(final.position - initial.position) < 0.05 : final.state === 'stopped' });
        if (!preserved.originalPlaylistsUnchanged || !preserved.queueUnchanged || !preserved.selectedOutputUnchanged || !preserved.volumeUnchanged || !preserved.playbackOrderUnchanged || (mutated && !preserved.expectedFinalStateVerified)) {
          evidence.passed = false; evidence.preservationError = 'Original state preservation check failed'; process.exitCode = 1;
        }
        if (!preserved.currentReferenceUnchanged && initial.state === 'stopped') evidence.limitations.push('Stopped baseline controls restored, but foobar retains the last test item reference/metadata; no active-deck deletion was used to erase it');
      }
    } catch (error) { evidence.finalReadbackError = error.message; evidence.passed = false; process.exitCode = 1; }
    evidence.restorationSucceeded = restorationSucceeded; evidence.interference = interference; evidence.ambiguousState = ambiguousState;
    if (interference || ambiguousState) { evidence.passed = false; process.exitCode = 1; }
    if (sourceContext) { try { const filesAfter = record('sourceAndBundleFilesAfter', await sourceContext.verifyFiles());
      if (!filesAfter.unchanged) { evidence.passed = false; evidence.sourcePreservationError = 'Original source or immutable backend files changed'; process.exitCode = 1; }
    } catch (error) { evidence.passed = false; evidence.sourcePreservationError = error.message; process.exitCode = 1; } }
    if (libraryBefore) { try { const libraryAfter = await libraryIndexSnapshot('after');
      const unchanged = libraryBefore.sha256 === libraryAfter.sha256 && digest(libraryBefore.counts) === digest(libraryAfter.counts) && digest(libraryBefore.playlists) === digest(libraryAfter.playlists) &&
        digest(libraryBefore.coverFiles) === digest(libraryAfter.coverFiles) && libraryAfter.testTracks.length === 0 && libraryAfter.temporaryPlaylists.length === 0;
      record('stillLibraryPreservation', { unchanged, expected: { tracks: 217, playlists: 12, occurrences: 324, covers: 92 }, before: libraryBefore.counts, after: libraryAfter.counts,
        testTrackIds: libraryAfter.testTracks.map(item => item.id), temporaryPlaylistIds: libraryAfter.temporaryPlaylists.map(item => item.id) });
      if (!unchanged) { evidence.passed = false; evidence.libraryPreservationError = 'STILL library count/order/cover drift or exact test contamination detected; no live index edits performed'; process.exitCode = 1; }
    } catch (error) { evidence.passed = false; evidence.libraryReadbackError = error.message; process.exitCode = 1; } }
    await closeAcceptance({ service, transport, evidence, save, record });
    if (!evidence.passed) process.exitCode = 1;
    console.log(JSON.stringify({ evidenceFile, simulated: false, passed: evidence.passed, error: evidence.error,
      preservationError: evidence.preservationError, actualDacRate: null }, null, 2));
  }
  return evidence;
}
if (require.main === module) main().then(evidence => {
  // This terminates only our own acceptance client after durable evidence. It
  // is never an application exit/restart or proof that an old POST was revoked.
  if (evidence?.cleanup?.clientExitRequired) process.exit(1);
}).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main, parseArgs, pinSession, createAcceptanceTransport, disconnectFeedback, completePhysicalHotplug, settleBounded, closeAcceptance };
