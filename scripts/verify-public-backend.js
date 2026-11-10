'use strict';
// Non-UI verifier. Importing this file has no effects. Default CLI is plan-only.
// Live runs load only the fixed r6 package, never Electron/main/entry or live DI.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {createRequire} = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const POLICY = Object.freeze({
  packageRoot: path.join(ROOT, 'dist/Still-public-1.1.0-candidate-20261108-r6'),
  evidenceRoot: path.join(ROOT, 'review-evidence/20261108-public-release/non-ui-baseline'),
  wavePath: path.join(ROOT, 'review-evidence/20261108-public-release/qa-media-auto-20261108/STILL-QA-silence-44100-stereo.wav'),
  buildSha256: '4ea5c13f3cd0399f46c84260b388bd6ee8bbd2ecc831196801ad0a3d86f70550',
  packageFiles: 511, packageBytes: 395052707,
  waveSha256: '6f9d38879c041d549646d87ddd563a34b95c14d77ec3df2f14bbebd317d794cb', waveBytes: 2116844,
  sharedProvider: 'D41D2423-FBB0-4635-B233-7054F79814AB'
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => path.resolve(value).toLowerCase();
const failure = code => Object.assign(new Error(code), {code});
const assert = (condition, code) => {if (!condition) throw failure(code);};
const safeCode = error => {
  try {const value = error?.code; return typeof value === 'string' && /^(?:VERIFY|STILL)_[A-Z0-9_]{1,100}$/.test(value) ? value : 'VERIFY_OPERATION_FAILED';}
  catch {return 'VERIFY_OPERATION_FAILED';}
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const BOOTSTRAP_STATES = new Set(['setup-required', 'creating-target', 'target-created', 'verifying-source', 'extracting-core',
  'committing-core', 'core-prepared', 'validating-installation', 'preparing-profile', 'prepared', 'ready', 'retry-required']);

function requiresExecutorRetention(lifetime) {
  if (lifetime.exitVerified === true || !lifetime.backend) return false;
  // startupCreated=false means no accepted JS witness, not an OS no-create
  // proof. Once initialize was attempted, only actual tree proof releases us.
  if (lifetime.startAttempted === true) return true;
  try {
    const info = lifetime.backend.getInfo();
    // A seen session or unknown manager state needs actual exit proof, even if
    // a subsequent JSON/status snapshot says owned=false.
    return Boolean(lifetime.session || info?.owned !== false || info?.startupCreated !== false);
  } catch {return true;}
}
function backendSnapshot(backend) {
  if (!backend) return null;
  try {
    const info = backend.getInfo(), boolean = value => typeof value === 'boolean' ? value : null;
    return {available: boolean(info.available), owned: boolean(info.owned), creationWitnessObserved: boolean(info.startupCreated),
      nativeReadySeen: boolean(info.nativeReadySeen), abnormalStartupExitRequired: boolean(info.abnormalStartupExitRequired),
      pid: Number.isInteger(info.pid) && info.pid > 0 && info.pid <= 0xffffffff ? info.pid : null,
      status: ['unprepared', 'checking', 'starting', 'ready', 'failed', 'closed', 'shutdown-failed', 'offline'].includes(info.status) ? info.status : 'unknown'};
  } catch {return {snapshotUnavailable: true};}
}
function protectLifetime(lifetime, timers = {setInterval, clearInterval}) {
  // Armed before constructors/startup, so an unexpected rejection or evidence
  // failure cannot let Node disappear before a returned result exists.
  const handle = timers.setInterval(() => {}, 1000);
  return {finish() {
    const retained = requiresExecutorRetention(lifetime);
    if (!retained) timers.clearInterval(handle);
    return retained;
  }};
}
function markObserverFailure(result) {
  result.observerFailed = true; result.status = 'failed'; result.code ||= 'VERIFY_OBSERVER_FAILED';
}
function createOutputGuard(stdout, stderr, onFailure = () => {}) {
  let failed = false;
  const pending = new Set();
  const fail = () => {failed = true; try {onFailure();} catch { /* Observer only. */ }};
  for (const stream of [stdout, stderr]) stream.on('error', fail);
  return {
    failed: () => failed,
    write(channel, text) {
      let settle;
      const done = new Promise(resolve => {settle = resolve;}); pending.add(done);
      try {(channel === 'stderr' ? stderr : stdout).write(text, error => {if (error) fail(); pending.delete(done); settle();});}
      catch {fail(); pending.delete(done); settle();}
    },
    async flush() {
      if (!pending.size) return;
      let timer;
      const settled = await Promise.race([Promise.all([...pending]).then(() => true),
        new Promise(resolve => {timer = setTimeout(() => resolve(false), 100);})]);
      clearTimeout(timer); if (!settled) fail();
    },
    dispose() {for (const stream of [stdout, stderr]) stream.off('error', fail);}
  };
}

function relativeFile(value) {
  assert(typeof value === 'string' && value && !/[\\:\0-\x1f]/.test(value) && !value.startsWith('/') &&
    value.split('/').every(part => part && !['.', '..'].includes(part) && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'VERIFY_UNSAFE_RELATIVE_PATH');
  return value;
}
function inside(root, filename) {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function noLinks(filename, io = fs) {
  for (let current = path.resolve(filename); ; current = path.dirname(current)) {
    const stat = await io.lstat(current).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
    if (stat) {
      assert(!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink === 1), 'VERIFY_LINK_REJECTED');
      assert(canonical(await io.realpath(current)) === canonical(current), 'VERIFY_PATH_ALIAS_REJECTED');
    }
    if (path.dirname(current) === current) break;
  }
}
async function checkedFile(filename, pin, {read = false} = {}) {
  await noLinks(filename);
  const before = await fs.lstat(filename, {bigint: true});
  assert(before.isFile() && before.nlink === 1n && before.size === BigInt(pin.bytes), 'VERIFY_FILE_SHAPE');
  const handle = await fs.open(filename, 'r');
  let bytes;
  try {
    const opened = await handle.stat({bigint: true});
    assert(opened.ino === before.ino && opened.dev === before.dev && opened.size === before.size, 'VERIFY_FILE_CHANGED');
    const hash = createHash('sha256'), chunks = [];
    for await (const chunk of handle.createReadStream({autoClose: false})) {hash.update(chunk); if (read) chunks.push(chunk);}
    assert(hash.digest('hex') === pin.sha256, 'VERIFY_FILE_HASH');
    if (read) bytes = Buffer.concat(chunks);
  } finally {await handle.close();}
  const after = await fs.lstat(filename, {bigint: true});
  assert(before.ino === after.ino && before.dev === after.dev && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && after.nlink === 1n, 'VERIFY_FILE_CHANGED');
  await noLinks(filename); return bytes;
}
async function inventory(root) {
  const found = [];
  async function walk(directory, prefix = '') {
    await noLinks(directory);
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const relativePath = relativeFile(prefix + entry.name), filename = path.join(root, relativePath);
      assert(inside(root, filename), 'VERIFY_PACKAGE_ESCAPE'); await noLinks(filename);
      if (entry.isDirectory()) await walk(filename, relativePath + '/');
      else {
        const stat = await fs.lstat(filename);
        assert(entry.isFile() && stat.isFile() && stat.nlink === 1, 'VERIFY_PACKAGE_ENTRY');
        found.push({relativePath, bytes: stat.size});
      }
    }
  }
  await walk(root); return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
async function verifyRuntime() {
  await noLinks(POLICY.packageRoot);
  const buildPath = path.join(POLICY.packageRoot, 'BUILD-INFO.json'), stat = await fs.lstat(buildPath);
  assert(stat.size < 1024 * 1024, 'VERIFY_BUILDINFO_SIZE');
  const bytes = await checkedFile(buildPath, {bytes: stat.size, sha256: POLICY.buildSha256}, {read: true});
  const build = JSON.parse(bytes.toString('utf8'));
  assert(build.schemaVersion === 1 && build.version === '1.1.0' && build.platform === 'win32' && build.arch === 'x64' &&
    build.publicDistribution === true && build.privateUseOnly === false && build.files && !Array.isArray(build.files), 'VERIFY_BUILDINFO_SCHEMA');
  const rows = inventoryRows(build.files);
  assert(rows.length === 509, 'VERIFY_BUILDINFO_FILE_COUNT');
  const actual = await inventory(POLICY.packageRoot);
  const expected = new Set([...rows.map(row => row.relativePath), 'BUILD-INFO.json', 'BUILD-INFO.sha256']);
  assert(actual.length === POLICY.packageFiles && actual.every(row => expected.has(row.relativePath)) &&
    actual.reduce((sum, row) => sum + row.bytes, 0) === POLICY.packageBytes, 'VERIFY_PACKAGE_INVENTORY');
  for (const row of rows) await checkedFile(path.join(POLICY.packageRoot, row.relativePath), row);
  const sumPath = path.join(POLICY.packageRoot, 'BUILD-INFO.sha256'); await noLinks(sumPath);
  const sum = await fs.readFile(sumPath, 'utf8');
  assert(sum.trim() === `${POLICY.buildSha256}  BUILD-INFO.json`, 'VERIFY_BUILDINFO_SUM');
  const appRoot = path.join(POLICY.packageRoot, 'resources/app');
  const publicManifest = JSON.parse(await fs.readFile(path.join(appRoot, 'manifests/public-backend.json'), 'utf8'));
  assert(publicManifest.schemaVersion === 2 && publicManifest.deployment === 'extract-original-installer', 'VERIFY_GUI_INSTALLER_BRANCH_FORBIDDEN');
  return {appRoot, files: actual.length, bytes: POLICY.packageBytes};
}
function inventoryRows(files) {
  const seen = new Set();
  return Object.entries(files).map(([relativePath, pin]) => {
    relativeFile(relativePath);
    assert(!seen.has(relativePath.toLowerCase()) && pin && Number.isSafeInteger(pin.bytes) && pin.bytes >= 0 &&
      /^[a-f0-9]{64}$/.test(pin.sha256), 'VERIFY_INVALID_FILE_PIN');
    seen.add(relativePath.toLowerCase()); return {relativePath, bytes: pin.bytes, sha256: pin.sha256};
  });
}
function verifyWave(bytes, pin = {bytes: POLICY.waveBytes, sha256: POLICY.waveSha256}) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= 44 && bytes.length === pin.bytes && sha256(bytes) === pin.sha256, 'VERIFY_WAVE_PIN');
  assert(bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString('ascii', 8, 16) === 'WAVEfmt ' && bytes.readUInt32LE(16) === 16 && bytes.readUInt16LE(20) === 1 &&
    bytes.readUInt16LE(22) === 2 && bytes.readUInt32LE(24) === 44100 && bytes.readUInt32LE(28) === 176400 &&
    bytes.readUInt16LE(32) === 4 && bytes.readUInt16LE(34) === 16 && bytes.toString('ascii', 36, 40) === 'data' &&
    bytes.readUInt32LE(40) === 2116800 && bytes.subarray(44).every(value => value === 0), 'VERIFY_WAVE_NOT_APPROVED_SILENCE');
  return {bytes: bytes.length, sha256: pin.sha256, seconds: 12, sampleRate: 44100, bits: 16, channels: 2, allZeroPcm: true};
}
function selection(typeId, deviceId) {
  const parts = typeof deviceId === 'string' ? deviceId.split(':') : [];
  assert(typeId === 'output' && parts.length === 2 && parts[0].toUpperCase() === POLICY.sharedProvider &&
    GUID.test(parts[1]) && parts[1].toLowerCase() !== ZERO_GUID, 'VERIFY_EXPLICIT_SHARED_OUTPUT_REQUIRED');
  return {typeId, deviceId};
}
const selectedEndpoint = wanted => `{0.0.0.00000000}.{${wanted.deviceId.split(':')[1].toUpperCase()}}`;
const exactEndpoint = (value, wanted) => typeof value === 'string' && value.toLowerCase() === selectedEndpoint(wanted).toLowerCase();
function sanitizedOutputs(result) {
  assert(Array.isArray(result?.outputs) && result.outputs.length <= 300, 'VERIFY_OUTPUT_RESPONSE');
  return result.outputs.map(row => {
    assert(typeof row.typeId === 'string' && row.typeId.length <= 200 && typeof row.deviceId === 'string' &&
      row.deviceId.length <= 1024 && !/[\0\r\n]/.test(row.typeId + row.deviceId), 'VERIFY_OUTPUT_RESPONSE');
    let sharedEligible = false;
    try {selection(row.typeId, row.deviceId); sharedEligible = row.configuredExclusive !== true;} catch { /* Not selectable. */ }
    return {typeId: row.typeId, deviceId: row.deviceId, name: typeof row.name === 'string' ? row.name.replace(/[\0-\x1f]/g, '').slice(0, 160) : '', sharedEligible};
  });
}
function sameOutput(a, b) {return a?.typeId === b?.typeId && a?.deviceId === b?.deviceId;}
function stateEvidence(state, wavePath, wanted) {
  return {healthy: state?.available === true && state.backendReachable === true && state.stale !== true && state.controlUncertain !== true,
    state: ['playing', 'paused', 'stopped', 'unavailable'].includes(state?.state) ? state.state : 'unavailable',
    position: Number.isFinite(state?.position) && state.position >= 0 && state.position <= 13 ? state.position : null,
    exactOwnWave: Boolean(typeof state?.currentTrack?.path === 'string' && canonical(state.currentTrack.path) === canonical(wavePath) && state.currentTrack.subsong === 0),
    exactOutput: wanted ? sameOutput(state?.output, wanted) : null};
}
function parseArguments(argv) {
  const value = {execute: false, check: false, stage: null, enumerationId: null, typeId: null, deviceId: null};
  let explicitPlan = false;
  const flags = {'--stage': 'stage', '--enumeration-id': 'enumerationId', '--type-id': 'typeId', '--device-id': 'deviceId'};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--execute' && !value.execute) value.execute = true;
    else if (arg === '--check' && !value.check) value.check = true;
    else if (arg === '--plan' && !explicitPlan) explicitPlan = true;
    else if (flags[arg] && value[flags[arg]] === null && typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--')) value[flags[arg]] = argv[++index];
    else throw failure('VERIFY_INVALID_ARGUMENT');
  }
  assert(!(value.execute && value.check) && !(explicitPlan && (value.execute || value.check)) &&
    !(value.check && value.stage) && (!value.stage || ['enumerate', 'play'].includes(value.stage)), 'VERIFY_INVALID_ARGUMENT');
  if (value.execute) assert(value.stage !== null, 'VERIFY_EXPLICIT_STAGE_REQUIRED');
  if (value.stage === 'play') {
    selection(value.typeId, value.deviceId); assert(UUID.test(value.enumerationId || ''), 'VERIFY_ENUMERATION_RECORD_REQUIRED');
  } else assert(value.typeId === null && value.deviceId === null && value.enumerationId === null, 'VERIFY_INVALID_ARGUMENT');
  return value;
}

// This orchestration accepts a fake API only for unit tests. The real CLI below
// never accepts DI/process/fetch/brand overrides and always constructs r6 APIs.
async function runLifecycle({api, scope, stage, wanted, emit = () => {}, pause = sleep, now = Date.now, cancelled = () => false, lifetime = {}}) {
  let backend, service, bootstrap, session = null, stopVerified = false, exited = false, primary = null;
  let observerFailed = false;
  const observers = new Set();
  const observerFailure = () => {observerFailed = true; primary ||= failure('VERIFY_OBSERVER_FAILED');};
  const observe = (phase, fields) => {
    try {
      const work = emit(phase, fields);
      if (work && typeof work.then === 'function') {
        const pending = Promise.resolve(work).catch(observerFailure); observers.add(pending);
        pending.then(() => observers.delete(pending));
      }
    } catch {observerFailure();}
  };
  const result = {schemaVersion: 1, stage, buildInfoSha256: POLICY.buildSha256, silenceSha256: POLICY.waveSha256,
    ready: false, stoppedVerified: false, childExitVerified: false, treeExitVerified: false, volumeWrites: 0, outputs: [], progress: []};
  const check = () => {assert(!observerFailed, 'VERIFY_OBSERVER_FAILED'); assert(!cancelled(), 'VERIFY_CANCELLED');};
  try {
    bootstrap = api.createBootstrap(scope, value => {
      try {observe('bootstrap-status', {state: BOOTSTRAP_STATES.has(value.state) ? value.state : 'unknown',
        code: value.code ? safeCode({code: value.code}) : null,
        completed: Number.isInteger(value.progress?.completed) && value.progress.completed >= 0 && value.progress.completed <= 500 ? value.progress.completed : null,
        total: Number.isInteger(value.progress?.total) && value.progress.total >= 0 && value.progress.total <= 500 ? value.progress.total : null});}
      catch {observerFailure();}
    });
    const initial = await bootstrap.initialize(); check();
    assert(initial.automatic === true && initial.prepared === false, 'VERIFY_FRESH_AUTOMATIC_SETUP_REQUIRED');
    await bootstrap.begin(); check(); await bootstrap.complete({musicDirs: [scope.mediaDir]}); check();
    assert(bootstrap.getStatus().prepared === true, 'VERIFY_CORE_NOT_PREPARED'); observe('core-prepared'); check();
    backend = api.createBackend(scope, bootstrap.getExpectedFiles());
    lifetime.backend = backend;
    lifetime.startAttempted = true;
    const info = await backend.initialize({start: true}); session = backend.getSession(); lifetime.session = session; check();
    assert(info.available === true && info.owned === true && info.nativeReadySeen === true && info.status === 'ready' &&
      Number.isInteger(info.pid) && info.pid > 0 && api.isSession(session, {foobarDir: scope.backendDir, baseUrl: info.baseUrl}) &&
      info.pid === session.pid, 'VERIFY_REAL_OWNED_SESSION_REQUIRED');
    const address = new URL(info.baseUrl);
    assert(address.protocol === 'http:' && address.hostname === '127.0.0.1' && Number(address.port) >= 1024 && address.port !== '8880', 'VERIFY_LOOPBACK_OWNER_REQUIRED');
    result.pid = info.pid; result.port = Number(address.port); observe('backend-ready', {pid: result.pid, port: result.port, owned: true, brandedSession: true}); check();
    service = api.createService(scope, info);
    service.on?.('error', error => observe('bridge-error', {code: safeCode(error)}));
    service.bindBackendSession(session);
    const initialState = stateEvidence(await service.initialize(), scope.wavePath, null);
    assert(initialState.healthy && initialState.state === 'stopped', 'VERIFY_INITIAL_STOPPED_REQUIRED');
    bootstrap.markReady(session, info);
    assert(bootstrap.getStatus().ready === true, 'VERIFY_BOOTSTRAP_READY_REQUIRED'); result.ready = true;
    const outputs = await service.outputs(); result.outputs = sanitizedOutputs(outputs); observe('outputs-enumerated', {count: result.outputs.length}); check();
    if (stage === 'play') {
      assert(result.outputs.some(row => row.sharedEligible && sameOutput(row, wanted)), 'VERIFY_APPROVED_OUTPUT_MISSING');
      const selected = await service.selectOutput(wanted); check();
      assert(sameOutput(selected.selected, wanted) && selected.outputConnection?.status === 'connected' &&
        selected.outputConnection?.selectionMatches === true && exactEndpoint(selected.outputConnection.endpointId, wanted), 'VERIFY_OUTPUT_READBACK_REQUIRED');
      const retry = await service.retryOutput(); check();
      assert(retry.ready === true && retry.outputConnection?.status === 'connected' && retry.outputConnection?.retryRequired === false &&
        retry.outputConnection?.selectionMatches === true && exactEndpoint(retry.outputConnection.endpointId, wanted), 'VERIFY_OUTPUT_CONNECTION_REQUIRED');
      observe('output-selected', {typeId: wanted.typeId, deviceId: wanted.deviceId, endpointId: retry.outputConnection.endpointId || null}); check();
      const first = stateEvidence(await service.play({paths: [scope.wavePath]}), scope.wavePath, wanted); check();
      const started = now(); result.progress.push(first); observe('playback-observed', first); check();
      assert(first.healthy && first.state === 'playing' && first.exactOwnWave && first.exactOutput && first.position !== null,
        'VERIFY_PLAYBACK_IDENTITY_OR_STATE');
      while (now() - started < 6000) {
        await pause(250); check();
        const current = stateEvidence(await service.getState(), scope.wavePath, wanted);
        result.progress.push(current); observe('playback-observed', current); check();
        assert(current.healthy && current.state === 'playing' && current.exactOwnWave && current.exactOutput && current.position !== null,
          'VERIFY_PLAYBACK_IDENTITY_OR_STATE');
        if (result.progress.length >= 3 && first.position !== null && current.position >= first.position + 1 && now() > started) break;
      }
      assert(first.healthy && first.state === 'playing' && first.exactOwnWave && first.exactOutput && first.position !== null &&
        result.progress.length >= 3 && result.progress.at(-1).position >= first.position + 1, 'VERIFY_REAL_PROGRESS_REQUIRED');
    }
    const stopped = stateEvidence(await service.stop(), scope.wavePath, wanted);
    const confirmed = stateEvidence(await service.getState(), scope.wavePath, wanted);
    assert(stopped.healthy && stopped.state === 'stopped' && confirmed.healthy && confirmed.state === 'stopped', 'VERIFY_STOP_READBACK_REQUIRED');
    stopVerified = true; result.stoppedVerified = true; observe('stopped', {state: 'stopped', readbacks: 2});
  } catch (error) {
    primary ||= error; result.backendAtFailure = backendSnapshot(backend);
    observe('failed', {code: safeCode(error), backend: result.backendAtFailure});
  }
  finally {
    if (service) {
      try {
        const permit = service.beginShutdownWrites();
        if (!stopVerified) {
          const stopped = stateEvidence(await permit.stop(), scope.wavePath, wanted);
          result.cleanupStopVerified = stopped.healthy && stopped.state === 'stopped';
        }
      } catch (error) {primary ||= error; observe('cleanup-failed', {code: safeCode(error)});}
    }
    if (backend) {
      try {
        const closed = await backend.close(), proof = closed?.exitEvidence;
        assert(session && api.isChildExit(proof, session) && api.isTreeExit(proof, session) && backend.isOwnedTreeExited(session) === true,
          'VERIFY_OWNED_TREE_EXIT_REQUIRED');
        result.childExitVerified = true; result.treeExitVerified = true; exited = true; lifetime.exitVerified = true;
        service?.markBackendExited(proof); observe('exit-verified', {pid: session.pid, child: true, tree: true});
      } catch (error) {primary ||= error; observe('cleanup-failed', {code: safeCode(error)});}
    }
    if (service && exited) {
      try {await service.close();} catch (error) {primary ||= error; observe('cleanup-failed', {code: safeCode(error)});}
    }
    if (bootstrap) {
      try {await bootstrap.close();} catch (error) {primary ||= error; observe('cleanup-failed', {code: safeCode(error)});}
    }
  }
  if (observers.size) {
    let timer;
    const settled = await Promise.race([Promise.all([...observers]).then(() => true),
      new Promise(resolve => {timer = setTimeout(() => resolve(false), 100);})]);
    clearTimeout(timer); if (!settled) observerFailure();
  }
  result.status = primary ? 'failed' : stage === 'play' ? 'passed' : 'enumerated';
  result.code = primary ? safeCode(primary) : null;
  result.observerFailed = observerFailed;
  result.requiresExecutorRetention = requiresExecutorRetention(lifetime);
  result.retentionReason = result.requiresExecutorRetention ? lifetime.startAttempted ? 'initialize-attempt-without-tree-proof' :
    'owned-or-unknown-manager' : lifetime.exitVerified ? 'verified-tree-exit' : 'no-manager-start-attempt';
  return result;
}

function productionApi(appRoot) {
  const requireFrozen = createRequire(path.join(appRoot, 'package.json'));
  const before = new Set(Object.keys(require.cache));
  const bootstrap = requireFrozen('./src/main/backend-bootstrap');
  const backend = requireFrozen('./src/main/backend');
  const foobar = requireFrozen('./src/main/foobar');
  for (const filename of Object.keys(require.cache).filter(value => !before.has(value))) {
    assert(inside(appRoot, filename) && !/[\\/](?:main|entry)\.js$/.test(filename) && !/[\\/]node_modules[\\/]electron[\\/]/.test(filename), 'VERIFY_MODULE_OUTSIDE_FROZEN_RUNTIME');
  }
  // The imports above are fixed sibling modules and builtins. No create/launch
  // callback, fetch, platform or brand DI is passed to the actual constructors.
  return {
    createBootstrap: (scope, onUpdate) => bootstrap.createBackendBootstrap({appRoot, dataDir: scope.dataDir, backendDir: scope.backendDir, onUpdate}),
    createBackend: (scope, publicFiles) => backend.createBackendManager({dataDir: scope.dataDir, backendDir: scope.backendDir,
      requireOwnedSession: true, requirePublicProvenance: true, startStopped: true, publicFiles,
      probePath: path.join(appRoot, 'scripts/foobar-coreaudio-probe.exe')}),
    createService: (scope, info) => foobar.createFoobarService({dataDir: scope.dataDir, foobarDir: scope.backendDir,
      baseUrl: info.baseUrl, pollIntervalMs: 0, probePath: path.join(appRoot, 'scripts/foobar-coreaudio-probe.exe')}),
    isSession: backend.isVerifiedBackendSession, isChildExit: backend.isVerifiedBackendChildExit, isTreeExit: backend.isVerifiedBackendTreeExit
  };
}
function scopePaths(runId) {
  assert(UUID.test(runId || ''), 'VERIFY_SCOPE_ID');
  const runDir = path.join(POLICY.evidenceRoot, runId), dataDir = path.join(runDir, 'data');
  assert(inside(POLICY.evidenceRoot, runDir), 'VERIFY_SCOPE_ESCAPE');
  const mediaDir = path.join(dataDir, 'qa-media');
  return {runId, runDir, dataDir, mediaDir, backendDir: path.join(dataDir, 'backend/foobar2000'),
    wavePath: path.join(mediaDir, 'STILL-QA-silence-44100-stereo.wav')};
}
async function createScope(waveBytes, output) {
  await noLinks(POLICY.evidenceRoot); await fs.mkdir(POLICY.evidenceRoot, {recursive: true}); await noLinks(POLICY.evidenceRoot);
  const {runId, runDir, dataDir, mediaDir, backendDir, wavePath} = scopePaths(randomUUID());
  await fs.mkdir(runDir); await noLinks(runDir);
  await fs.mkdir(dataDir); await fs.mkdir(mediaDir);
  await fs.writeFile(wavePath, waveBytes, {flag: 'wx'});
  const log = await fs.open(path.join(runDir, 'events.jsonl'), 'wx');
  let writes = Promise.resolve(), logFailed = false;
  return {runId, runDir, dataDir, mediaDir, backendDir, wavePath,
    emit(phase, values = {}) {
      const line = JSON.stringify({at: new Date().toISOString(), phase, ...values}) + '\n';
      output.write('stdout', line); writes = writes.then(() => log.write(line)); writes.catch(() => {logFailed = true;});
      return writes;
    },
    logFailed: () => logFailed,
    async finish(result) {
      try {await writes;} catch {logFailed = true;}
      try {await log.close();} catch {logFailed = true;}
      if (logFailed || output.failed()) markObserverFailure(result);
      await noLinks(runDir);
      await fs.writeFile(path.join(runDir, 'result.json'), JSON.stringify({...result, runId, simulated: false}, null, 2) + '\n', {flag: 'wx'});
    }};
}
function checkEnumerationRecord(record, input) {
  assert(record && typeof record === 'object' && !Array.isArray(record), 'VERIFY_ENUMERATION_RECORD_REQUIRED');
  assert(record.schemaVersion === 1 && record.stage === 'enumerate' && record.status === 'enumerated' && record.simulated === false &&
    record.runId === input.enumerationId && record.buildInfoSha256 === POLICY.buildSha256 && record.silenceSha256 === POLICY.waveSha256 &&
    record.ready === true && record.stoppedVerified === true && record.treeExitVerified === true && record.childExitVerified === true &&
    Array.isArray(record.outputs), 'VERIFY_ENUMERATION_RECORD_REQUIRED');
  const wanted = selection(input.typeId, input.deviceId);
  assert(record.outputs.some(row => row.sharedEligible === true && sameOutput(row, wanted)), 'VERIFY_OUTPUT_NOT_PREVIOUSLY_ENUMERATED');
  return wanted; // Selection metadata only; never deserializes a session/exit brand.
}
async function enumerationSelection(input) {
  const filename = path.join(POLICY.evidenceRoot, input.enumerationId, 'result.json'); await noLinks(filename);
  const stat = await fs.lstat(filename); assert(stat.isFile() && stat.size < 128 * 1024, 'VERIFY_ENUMERATION_RECORD_REQUIRED');
  return checkEnumerationRecord(JSON.parse(await fs.readFile(filename, 'utf8')), input);
}
async function main(argv, output) {
  const input = parseArguments(argv);
  if (!input.execute && !input.check) {
    output.write('stdout', JSON.stringify({mode: 'plan-only', requestedStage: input.stage, policy: POLICY,
      effects: 'No process/network/audio/UI/setup execution. Actual execution requires reviewed --execute plus explicit stage.'}, null, 2) + '\n');
    await output.flush(); assert(!output.failed(), 'VERIFY_OBSERVER_FAILED'); return;
  }
  assert(process.platform === 'win32' && process.arch === 'x64', 'VERIFY_WINDOWS_X64_REQUIRED');
  const runtime = await verifyRuntime();
  const waveBytes = await checkedFile(POLICY.wavePath, {bytes: POLICY.waveBytes, sha256: POLICY.waveSha256}, {read: true});
  const wave = verifyWave(waveBytes);
  if (input.check) {
    output.write('stdout', JSON.stringify({mode: 'read-only-check', runtimeFiles: runtime.files, runtimeBytes: runtime.bytes, wave}) + '\n');
    await output.flush(); assert(!output.failed(), 'VERIFY_OBSERVER_FAILED'); return;
  }
  const wanted = input.stage === 'play' ? await enumerationSelection(input) : null;
  const scope = await createScope(waveBytes, output), controller = new AbortController();
  const abort = () => controller.abort(); process.on('SIGINT', abort); process.on('SIGTERM', abort);
  const lifetime = {}, protection = protectLifetime(lifetime);
  let result;
  try {
    try {
      const api = productionApi(runtime.appRoot);
      scope.emit('scope-created', {runId: scope.runId});
      scope.emit('runtime-verified', {buildInfoSha256: POLICY.buildSha256, files: runtime.files});
      scope.emit('media-verified', wave);
      result = await runLifecycle({api, scope, stage: input.stage, wanted, emit: scope.emit, lifetime,
        cancelled: () => controller.signal.aborted || scope.logFailed() || output.failed()});
    } catch (error) {
      // Unexpected control/observer errors still have the independent manager
      // reference. Do not deserialize evidence or retry a failed graceful exit.
      result = {schemaVersion: 1, stage: input.stage, buildInfoSha256: POLICY.buildSha256, silenceSha256: POLICY.waveSha256,
        status: 'failed', code: safeCode(error), ready: false, stoppedVerified: false,
        childExitVerified: lifetime.exitVerified === true, treeExitVerified: lifetime.exitVerified === true};
    }
    await output.flush();
    if (output.failed() || scope.logFailed()) markObserverFailure(result);
    result.requiresExecutorRetention = requiresExecutorRetention(lifetime);
    output.write('stdout', JSON.stringify({phase: 'evidence-finalizing', runId: scope.runId, stoppedVerified: result.stoppedVerified,
      childExitVerified: result.childExitVerified, treeExitVerified: result.treeExitVerified}) + '\n');
    await output.flush();
    if (output.failed()) markObserverFailure(result);
    await scope.finish(result);
  } finally {
    if (protection.finish()) {
      // This decision does not depend on result assignment or report writing.
      process.exitCode = 1;
      output.write('stderr', 'VERIFY_OWNED_EXIT_UNCONFIRMED_EXECUTOR_RETAINED\n');
    } else {process.off('SIGINT', abort); process.off('SIGTERM', abort);}
  }
  if (result.status === 'failed') process.exitCode = 1;
  // An unverified owned lifetime is never turned into a forced process exit.
}
module.exports = {POLICY, relativeFile, inside, noLinks, inventoryRows, verifyWave, selection, sanitizedOutputs, stateEvidence,
  parseArguments, runLifecycle, scopePaths, checkEnumerationRecord, safeCode, requiresExecutorRetention, protectLifetime, createOutputGuard, markObserverFailure,
  backendSnapshot, verifyRuntime, checkedFile};
if (require.main === module) {
  const output = createOutputGuard(process.stdout, process.stderr, () => {process.exitCode = 1;});
  main(process.argv.slice(2), output).catch(error => {output.write('stderr', safeCode(error) + '\n'); process.exitCode = 1;});
}
