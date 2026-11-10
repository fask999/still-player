'use strict';
// Non-UI acceptance. Default invocation only prints a plan. Importing this
// module does not load an application runtime or create a process/socket/file.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {createRequire} = require('node:module');
const {createMediaFileReader, normalized, isWithin} = require('../src/main/media-file-safety');
const {createCueReader, validateCueItems} = require('../src/main/cue-import');
const {selection, inventoryRows, sanitizedOutputs, createOutputGuard} = require('./verify-public-backend');
const ROOT = path.resolve(__dirname, '..');
const EVIDENCE = path.join(ROOT, 'review-evidence/20261108-public-release/cue-inspector/native-runs');
const DATA = path.join(ROOT, 'review-evidence/cue-qa');
const retainedOwners = new Set();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), {code});
const assert = (condition, code) => {if (!condition) throw fail(code);};
const safeCode = error => /^(?:CUE_VERIFY|ERR_CUE|STILL)_[A-Z0-9_]{1,100}$/u.test(error?.code || '') ? error.code : 'CUE_VERIFY_OPERATION_FAILED';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameOutput = (a, b) => a?.typeId === b?.typeId && a?.deviceId === b?.deviceId;

function plan() {
  return {mode: 'plan-only', executes: false, sample: {seconds: 90, sampleRate: 44100, bits: 16, channels: 2, pcm: 'all-zero', cueTracks: 2, cueTrackSeconds: 45},
    stages: ['verify-new-candidate-entire-file-inventory-and-four-runtime-pins', 'create-fresh-owned-main-with-only-directory-A',
      'explicitly-play-self-generated-WAV-A-through-session-and-coordinator', 'capture-all-main-playlist-items-queue-source-roots-and-config',
      'import-original-CUE-B-through-library-and-Windows-read-lease-with-Null-output', 'prove-main-unchanged-and-progressing-through-discovery',
      'prove-indexer-and-holder-physically-exited', 'explicit-returned-CUE-play-through-library-guard-and-pending-root-lifecycle',
      'prove-old-main-tree-exit-new-session-roots-B-and-exact-native-CUE-playback-progress', 'stop-and-prove-final-owned-main-tree-exit'],
    forbidden: ['r6-modification', 'Electron-run-or-GUI', 'installer-GUI', 'user-installations-profiles-or-media', 'system-keys-volume-power-or-routing', 'kill-or-PID-disappearance-as-exit-proof'],
    admission: 'A reviewed new candidate, exact BUILD-INFO SHA-256 and an approved enumerated shared-output tuple are required; real execution is separately scheduled.'};
}
function parseArguments(argv) {
  const result = {mode: 'plan', candidate: null, buildSha256: null, typeId: null, deviceId: null}; let explicitMode = false;
  const values = {'--candidate': 'candidate', '--build-sha256': 'buildSha256', '--type-id': 'typeId', '--device-id': 'deviceId'};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--plan', '--check', '--run'].includes(arg) && !explicitMode) {result.mode = arg.slice(2); explicitMode = true;}
    else if (values[arg] && result[values[arg]] === null && argv[index + 1] && !argv[index + 1].startsWith('--')) result[values[arg]] = argv[++index];
    else throw fail('CUE_VERIFY_ARGUMENT');
  }
  if (result.mode === 'plan') assert(Object.values(result).filter(value => value !== null).length === 1, 'CUE_VERIFY_ARGUMENT');
  else {
    assert(typeof result.candidate === 'string' && /^[a-f0-9]{64}$/u.test(result.buildSha256 || ''), 'CUE_VERIFY_CANDIDATE_PIN_REQUIRED');
    const absolute = path.resolve(result.candidate), relative = path.relative(path.join(ROOT, 'dist'), absolute);
    assert(!relative.includes(path.sep) && /^Still-public-1\.1\.0-candidate-20261108-r(?:[7-9]|[1-9][0-9]+)$/u.test(relative), 'CUE_VERIFY_NEW_CANDIDATE_REQUIRED');
    result.candidate = absolute;
    if (result.mode === 'run') selection(result.typeId, result.deviceId);
    else assert(result.typeId === null && result.deviceId === null, 'CUE_VERIFY_ARGUMENT');
  }
  return Object.freeze(result);
}
async function checkCandidate(input) {
  const reader = createMediaFileReader(), root = input.candidate;
  await reader.assertDirectory(root);
  const build = await reader.read(path.join(root, 'BUILD-INFO.json'), {maxBytes: 1024 * 1024});
  assert(digest(build.bytes) === input.buildSha256, 'CUE_VERIFY_BUILD_PIN');
  const value = JSON.parse(build.bytes.toString('utf8'));
  assert(value.schemaVersion === 1 && value.version === '1.1.0' && value.platform === 'win32' && value.arch === 'x64' &&
    value.publicDistribution === true && value.privateUseOnly === false && value.files && !Array.isArray(value.files), 'CUE_VERIFY_BUILD_SCHEMA');
  const pins = inventoryRows(value.files), expected = new Map(pins.map(row => [row.relativePath, row]));
  assert(pins.length > 0 && pins.length <= 4096, 'CUE_VERIFY_INVENTORY_LIMIT');
  const sum = await reader.read(path.join(root, 'BUILD-INFO.sha256'), {maxBytes: 256});
  assert(sum.bytes.toString('utf8').trim() === `${input.buildSha256}  BUILD-INFO.json`, 'CUE_VERIFY_BUILD_SUM');
  const seen = new Set(); let total = 0, entries = 0;
  async function walk(directory, depth = 0) {
    assert(depth <= 32, 'CUE_VERIFY_INVENTORY_LIMIT'); await reader.assertDirectory(directory);
    for await (const item of await fsp.opendir(directory)) {
      assert(++entries <= 8192, 'CUE_VERIFY_INVENTORY_LIMIT'); const filename = path.join(directory, item.name);
      const stat = await fsp.lstat(filename, {bigint: true});
      assert(!stat.isSymbolicLink(), 'CUE_VERIFY_INVENTORY_LINK');
      if (stat.isDirectory()) {await walk(filename, depth + 1); continue;}
      assert(stat.isFile() && stat.nlink === 1n, 'CUE_VERIFY_INVENTORY_LINK');
      const relative = path.relative(root, filename).split(path.sep).join('/');
      if (['BUILD-INFO.json', 'BUILD-INFO.sha256'].includes(relative)) continue;
      const pin = expected.get(relative); assert(pin && !seen.has(relative) && Number(stat.size) === pin.bytes, 'CUE_VERIFY_INVENTORY'); seen.add(relative);
      total += pin.bytes; assert(total <= 1024 * 1024 * 1024, 'CUE_VERIFY_INVENTORY_LIMIT');
      const before = await reader.inspect(filename), handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat({bigint: true}), identity = row => [row.dev, row.ino, row.size, row.mtimeNs, row.ctimeNs].map(String).join(':');
        assert(identity(opened) === before.identity && opened.nlink === 1n, 'CUE_VERIFY_INVENTORY_CHANGED');
        const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let count = 0;
        while (true) {const result = await handle.read(buffer, 0, buffer.length, count); if (!result.bytesRead) break;
          count += result.bytesRead; assert(count <= pin.bytes, 'CUE_VERIFY_INVENTORY_CHANGED'); hash.update(buffer.subarray(0, result.bytesRead));}
        assert(count === pin.bytes && hash.digest('hex') === pin.sha256 && identity(await handle.stat({bigint: true})) === before.identity &&
          (await reader.inspect(filename)).identity === before.identity, 'CUE_VERIFY_INVENTORY_CHANGED');
      } finally {await handle.close();}
    }
  }
  await walk(root); assert(seen.size === expected.size, 'CUE_VERIFY_INVENTORY');
  const appRoot = path.join(root, 'resources/app');
  for (const relative of ['src/main/cue-inspector.js', 'src/main/cue-read-lease.js', 'src/main/cue-playback-guard.js',
    'src/main/existing-context-scope.js', 'src/main/library.js', 'src/main/main.js', 'src/main/foobar-session.js', 'src/main/playback-coordinator.js']) {
    assert(expected.has(`resources/app/${relative}`), 'CUE_VERIFY_REQUIRED_MODULE');
  }
  const registry = JSON.parse((await reader.read(path.join(appRoot, 'src/main/runtime-assets.json'), {maxBytes: 16384})).bytes.toString('utf8'));
  assert(registry.schemaVersion === 1 && registry.assets && Object.keys(registry.assets).length === 4 &&
    ['backendLauncher', 'backendOutputPolicy', 'desktopMediaManifest', 'cueReadLeaseManifest'].every(name => registry.assets[name]), 'CUE_VERIFY_FOUR_RUNTIME_PINS');
  for (const pin of Object.values(registry.assets)) assert(pin && typeof pin.relativePath === 'string' &&
    expected.get(`resources/app/${pin.relativePath}`)?.sha256 === pin.sha256, 'CUE_VERIFY_RUNTIME_PIN');
  return {appRoot, files: pins.length + 2, bytes: total + build.bytes.length + sum.bytes.length, buildInfoSha256: input.buildSha256};
}
function wave(seconds = 90) {
  const size = seconds * 44100 * 2 * 2, bytes = Buffer.alloc(size + 44);
  bytes.write('RIFF'); bytes.writeUInt32LE(size + 36, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(size, 40); return bytes;
}
async function makeScope() {
  const reader = createMediaFileReader();
  await reader.assertDirectory(path.dirname(EVIDENCE)); await fsp.mkdir(EVIDENCE).catch(error => {if (error.code !== 'EEXIST') throw error;});
  await reader.assertDirectory(EVIDENCE); let count = 0;
  for await (const _entry of await fsp.opendir(EVIDENCE)) assert(++count < 4, 'CUE_VERIFY_RETAINED_RUN_QUOTA');
  const id = randomUUID(), runDir = path.join(EVIDENCE, id); await fsp.mkdir(runDir); await reader.assertDirectory(runDir);
  // Keep the temporary native program and plugin paths short. The evidence
  // path is intentionally descriptive and can exceed the Win32 path limit
  // after the indexer's own namespace and component names are appended.
  await reader.assertDirectory(path.dirname(DATA)); await fsp.mkdir(DATA).catch(error => {if (error.code !== 'EEXIST') throw error;});
  await reader.assertDirectory(DATA);
  const dataRoot = path.join(DATA, id); await fsp.mkdir(dataRoot); await reader.assertDirectory(dataRoot);
  const scope = {id, runDir, dataRoot, directoryA: path.join(dataRoot, 'media-a'), directoryB: path.join(dataRoot, 'media-b'),
    mainData: path.join(dataRoot, 'main'), indexerData: path.join(dataRoot, 'indexer')};
  for (const name of [scope.directoryA, scope.directoryB, scope.mainData, scope.indexerData]) {await fsp.mkdir(name, {recursive: true}); await reader.assertDirectory(name);}
  scope.waveA = path.join(scope.directoryA, 'main-silence.wav'); scope.waveB = path.join(scope.directoryB, 'cue-silence.wav'); scope.cue = path.join(scope.directoryB, 'album.cue');
  const bytes = wave(); await fsp.writeFile(scope.waveA, bytes, {flag: 'wx'}); await fsp.writeFile(scope.waveB, bytes, {flag: 'wx'});
  await fsp.writeFile(scope.cue, 'PERFORMER "CUE Inspector"\nTITLE "CUE Inspector Album"\nFILE "cue-silence.wav" WAVE\n  TRACK 01 AUDIO\n    TITLE "CUE Inspector First"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "CUE Inspector Second"\n    INDEX 01 00:45:00\n', {flag: 'wx'});
  scope.sampleSha256 = digest(bytes); scope.request = (await createCueReader()(scope.cue, {authorizationRoot: scope.directoryB})).request; return scope;
}
const healthy = state => state?.available === true && state.backendReachable === true && state.stale !== true && state.controlUncertain !== true && state.source === 'local' && state.state === 'playing' && Number.isFinite(state.position);
function assertContinuity(before, current) {
  assert(healthy(current.state) && current.fingerprint === before.fingerprint && current.state.position >= before.state.position,
    'CUE_VERIFY_MAIN_CHANGED_DURING_DISCOVERY');
}

// Only the unit-test orchestration accepts a fake API. The CLI constructs the
// reviewed runtime directly, with no spawn/fetch/session/brand DI arguments.
async function runLifecycle({api, scope, wanted, emit = () => {}, wait = pause, signal}) {
  let main, inspector, primary = null, snapshot, discovered, inspectorClosed = false, mainClosed = false;
  let observing = true, observation = null, observationError = null; const observerTasks = [];
  const controller = new AbortController();
  const cancel = () => {controller.abort(fail('CUE_VERIFY_CANCELLED')); try {main?.cancel?.();} catch (error) {primary ||= error;}};
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, {once: true});
  const result = {schemaVersion: 1, status: 'failed', mainUnchangedDuringDiscovery: false, mainProgressedDuringDiscovery: false,
    indexerClosed: false, holderClosed: false, mainRestartedForNewRoot: false, exactCuePlayback: false, cueProgressed: false,
    finalMainChildExited: false, finalMainTreeExited: false, requiresExecutorRetention: false, volumeWrites: 0, uiOperations: 0};
  const record = (type, value = {}) => {
    try {const returned = emit({type, ...value}); if (returned?.then) observerTasks.push(Promise.resolve(returned).catch(() => {primary ||= fail('CUE_VERIFY_EVIDENCE_FAILED');}));}
    catch {primary ||= fail('CUE_VERIFY_EVIDENCE_FAILED');}
  };
  const check = () => {if (controller.signal.aborted) throw controller.signal.reason; if (observationError) throw observationError; if (primary) throw primary;};
  async function observe() {
    if (!snapshot || !observing) return;
    const current = await main.snapshot(); assertContinuity(snapshot, current);
    observation = current; record('main-progress-during-discovery', {position: current.state.position, source: current.state.source});
  }
  try {
    check(); main = api.createMain(scope, wanted, record, controller.signal); await main.initialize(); check();
    const started = await main.play([{path: scope.waveA, subsong: 0}]);
    check();
    assert(healthy(started) && normalized(started.currentTrack?.path || '') === normalized(scope.waveA) && started.currentTrack.subsong === 0,
      'CUE_VERIFY_MAIN_WAVE_NOT_PLAYING');
    snapshot = await main.snapshot(); assert(healthy(snapshot.state), 'CUE_VERIFY_MAIN_WAVE_NOT_PLAYING');
    assert(snapshot.roots.length === 1 && normalized(snapshot.roots[0]) === normalized(scope.directoryA), 'CUE_VERIFY_MAIN_INITIAL_ROOTS');
    inspector = api.createInspector(scope, value => {
      record('indexer-progress', value);
      if (value.state === 'discovering') observerTasks.push(observe().catch(error => {observationError = error; controller.abort(error);}));
    }, main);
    const discovery = inspector.inspect(scope.request, {signal: controller.signal});
    let done = false; discovery.finally(() => {done = true;}).catch(() => {});
    while (!done) {await observe(); check(); if (!done) await wait(200);}
    discovered = await discovery; check(); await Promise.all(observerTasks); check();
    await observe(); assert(observation && observation.state.position > snapshot.state.position + 0.1, 'CUE_VERIFY_MAIN_PROGRESS_REQUIRED');
    result.mainUnchangedDuringDiscovery = true; result.mainProgressedDuringDiscovery = true;
    const items = validateCueItems(discovered, scope.request);
    assert(items.length === 2 && items[1].title === 'CUE Inspector Second' && Math.abs(items[1].duration - 45) < 0.05, 'CUE_VERIFY_DISCOVERED_METADATA');
    await inspector.close(); inspectorClosed = true; result.indexerClosed = true; result.holderClosed = true;
    record('indexer-and-holder-closed'); observing = false; check();
    const before = main.sessionId(), playing = await main.play([{path: items[1].path, subsong: items[1].subsong}]); check();
    assert(main.sessionId() !== before && main.previousTreeExitVerified() === true, 'CUE_VERIFY_NEW_ROOT_RESTART_REQUIRED');
    result.mainRestartedForNewRoot = true;
    const final = await main.snapshot();
    assert(final.roots.length === 2 && [scope.directoryA, scope.directoryB].every(directory =>
      final.roots.some(name => normalized(name) === normalized(directory))), 'CUE_VERIFY_NEW_ROOT_NOT_APPLIED');
    const exact = state => healthy(state) && normalized(state.currentTrack?.path || '') === normalized(items[1].path) &&
      state.currentTrack.subsong === items[1].subsong && state.currentTrack.title === items[1].title && Math.abs(state.duration - items[1].duration) < 0.05;
    assert(exact(playing), 'CUE_VERIFY_EXACT_CUE_PLAYBACK'); result.exactCuePlayback = true;
    let after = playing;
    for (let count = 0; count < 20 && after.position < playing.position + 0.5; count++) {
      await wait(200); after = (await main.snapshot()).state; assert(exact(after), 'CUE_VERIFY_EXACT_CUE_PLAYBACK');
    }
    assert(after.position >= playing.position + 0.5, 'CUE_VERIFY_CUE_PROGRESS_REQUIRED'); result.cueProgressed = true;
    record('cross-profile-cue-playback-verified', {path: items[1].path, subsong: items[1].subsong, title: items[1].title, duration: items[1].duration, position: after.position});
  } catch (error) {primary ||= error; controller.abort(error);}
  finally {
    observing = false;
    if (inspector && !inspectorClosed) {try {await inspector.close(); inspectorClosed = true;} catch (error) {primary ||= error;}}
    if (main) {
      try {const proof = await main.close(); mainClosed = proof.drained === true &&
        (proof.startAttempted === false || proof.childExited === true && proof.treeExited === true);
        result.finalMainChildExited = proof.childExited === true; result.finalMainTreeExited = proof.treeExited === true;
        if (proof.failureCode) primary ||= fail(proof.failureCode);
        assert(mainClosed, 'CUE_VERIFY_MAIN_EXIT_UNVERIFIED');}
      catch (error) {primary ||= error;}
    }
    await Promise.all(observerTasks);
    signal?.removeEventListener('abort', cancel);
    result.requiresExecutorRetention = Boolean(inspector && !inspectorClosed || main && !mainClosed);
    if (result.requiresExecutorRetention) retainedOwners.add({main, inspector, scope});
    record('cleanup', {indexerClosed: inspectorClosed, mainClosed, requiresExecutorRetention: result.requiresExecutorRetention});
    await Promise.all(observerTasks);
  }
  result.status = primary ? 'failed' : 'passed'; result.code = primary ? safeCode(primary) : null; return result;
}

function productionApi(appRoot) {
  const load = createRequire(path.join(appRoot, 'package.json')), imported = new Set(Object.keys(require.cache));
  const bootstrapApi = load('./src/main/backend-bootstrap'), backendApi = load('./src/main/backend'), foobarApi = load('./src/main/foobar');
  const {createFoobarSessionService} = load('./src/main/foobar-session'), {createPlaybackCoordinator} = load('./src/main/playback-coordinator');
  const {prepareLocalPlaybackLifecycle} = load('./src/main/main'), {createCueInspector} = load('./src/main/cue-inspector');
  const {createCuePlaybackGuard} = load('./src/main/cue-playback-guard'), {createLibraryService} = load('./src/main/library');
  const {verifyExistingContextScope} = load('./src/main/existing-context-scope');
  for (const file of Object.keys(require.cache).filter(name => !imported.has(name))) assert(isWithin(appRoot, file) &&
    !/[\\/]node_modules[\\/]electron[\\/]/u.test(file) && !/[\\/]entry\.js$/u.test(file), 'CUE_VERIFY_FORBIDDEN_MODULE');
  return {
    createInspector(scope, onProgress, main) {
      const native = createCueInspector({runtimeRoot: appRoot, dataDir: scope.indexerData, onProgress});
      return {inspect: (request, {signal}) => main.importCue(request, native, signal), close: () => native.close()};
    },
    createMain(scope, wanted, record, signal) {
      const backendDir = path.join(scope.mainData, 'backend/foobar2000'), reader = createMediaFileReader();
      const bootstrap = bootstrapApi.createBackendBootstrap({appRoot, dataDir: scope.mainData, backendDir});
      let backend, bridge, coordinator, inspection, bridgeReady = false, currentSession = null, previousExit = false, startAttempted = false;
      const library = createLibraryService({dataDir: scope.mainData, verifyExistingContextScope, cueInspector: async request => {
        assert(inspection && !inspection.result && request.path === inspection.request.path && request.contentHash === inspection.request.contentHash &&
          request.authorizationRoot === inspection.request.authorizationRoot, 'CUE_VERIFY_LIBRARY_INSPECTION');
        try {inspection.result = await inspection.native.inspect(request, {signal: inspection.signal});}
        catch (error) {record('native-inspection-failed', {code: safeCode(error), causeCode: safeCode(error?.cause)}); throw error;}
        return inspection.result;
      }});
      const getCuePlaybackRequests = (...args) => library.getCuePlaybackRequests(...args);
      const cuePlaybackGuard = createCuePlaybackGuard({runtimeRoot: appRoot, getRequests: getCuePlaybackRequests,
        getTreeExitEvidence: token => backend.getVerifiedOwnedTreeExit(token), onTreeExit: listener => backend.subscribeVerifiedOwnedTreeExit(listener),
        onError: code => record('playback-guard-error', {code})});
      const checkOpen = () => {if (signal?.aborted) throw signal.reason || fail('CUE_VERIFY_CANCELLED');};
      async function owned() {
        const info = backend.getInfo(), token = backend.getSession();
        assert(backendApi.isVerifiedBackendSession(token, {foobarDir: backendDir, baseUrl: info.baseUrl}) && info.available === true && info.owned === true && info.pid === token.pid,
          'CUE_VERIFY_MAIN_SESSION'); currentSession = token; return info;
      }
      async function get(route) {
        const info = await owned(), response = await fetch(new URL(route, info.baseUrl), {redirect: 'error', signal: AbortSignal.timeout(2000)});
        assert(response.ok, 'CUE_VERIFY_MAIN_READ'); const stream = response.body.getReader(), chunks = []; let size = 0;
        try {while (true) {const row = await stream.read(); if (row.done) break; size += row.value.byteLength;
          assert(size <= 1024 * 1024, 'CUE_VERIFY_MAIN_READ_LIMIT'); chunks.push(Buffer.from(row.value));}}
        catch (error) {Promise.resolve(stream.cancel()).catch(() => {}); throw error;} finally {stream.releaseLock();}
        return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      }
      return {
        async initialize() {
          await library.initialize(); checkOpen(); await library.importFiles([scope.waveA]); checkOpen();
          checkOpen(); const initial = await bootstrap.initialize(); checkOpen(); assert(initial.automatic && !initial.prepared, 'CUE_VERIFY_FRESH_MAIN_REQUIRED');
          await bootstrap.begin(); checkOpen(); await bootstrap.complete({musicDirs: [scope.directoryA]}); checkOpen();
          backend = backendApi.createBackendManager({backendDir, dataDir: scope.mainData, requireOwnedSession: true,
            requirePublicProvenance: true, publicFiles: bootstrap.getExpectedFiles(), startStopped: true});
          startAttempted = true;
          const info = await backend.initialize({start: true, signal}); checkOpen(); await owned(); checkOpen(); bootstrap.markReady(currentSession, info);
          bridge = createFoobarSessionService({createService: foobarApi.createFoobarService, backend,
            serviceOptions: {dataDir: scope.mainData, foobarDir: backendDir, cuePlaybackGuard, pollIntervalMs: 0, persistOutputSelection: true,
              probePath: path.join(appRoot, 'scripts/foobar-coreaudio-probe.exe')}});
          const state = await bridge.connect(info); checkOpen(); assert(state.state === 'stopped' && (await bridge.queueList()).items.length === 0, 'CUE_VERIFY_INITIAL_MAIN_NOT_QUIET'); checkOpen(); bridgeReady = true;
          const outputs = sanitizedOutputs(await bridge.outputs()); checkOpen();
          assert(outputs.filter(row => row.sharedEligible && sameOutput(row, wanted)).length === 1, 'CUE_VERIFY_APPROVED_SHARED_OUTPUT_REQUIRED');
          const selected = await bridge.selectOutput(wanted); checkOpen();
          const connection = selected.outputConnection, endpoint = `{0.0.0.00000000}.{${wanted.deviceId.split(':')[1]}}`;
          assert(sameOutput(selected.selected, wanted) && connection?.status === 'connected' && connection.selectionMatches === true &&
            connection.endpointId?.toLowerCase() === endpoint.toLowerCase(), 'CUE_VERIFY_OUTPUT_READBACK');
          record('shared-output-verified', {typeId: wanted.typeId, deviceId: wanted.deviceId, endpoint: connection.endpointId});
          coordinator = createPlaybackCoordinator({engines: {local: bridge}}); record('main-ready', {sessionId: currentSession.sessionId});
        },
        async importCue(request, native, importSignal) {
          checkOpen(); assert(!inspection && request === scope.request, 'CUE_VERIFY_LIBRARY_INSPECTION');
          const operation = {request, native, signal: importSignal, result: null}; inspection = operation;
          try {
            const saved = await library.importFiles([request.path]); checkOpen();
            const items = validateCueItems(operation.result, request);
            assert(saved.tracks.filter(track => track.cueTrack === true).length === items.length && items.every(item =>
              saved.tracks.some(track => track.cueTrack === true && track.valid === true && track.path === item.path &&
                track.subsong === item.subsong && track.title === item.title)), 'CUE_VERIFY_LIBRARY_IMPORT');
            const requests = await getCuePlaybackRequests(items.map(item => ({path: item.path, subsong: item.subsong}))); checkOpen();
            assert(requests.length === 1 && requests[0].path === request.path && requests[0].contentHash === request.contentHash,
              'CUE_VERIFY_LIBRARY_PLAYBACK_REQUEST');
            record('library-import-verified', {tracks: items.length, cueRequests: requests.length});
            return operation.result;
          } finally {inspection = null;}
        },
        async play(locations) {
          checkOpen(); const old = backend.getSession();
          const state = await coordinator.play({source: 'local', input: {locations}, beforeStart: (input, context) =>
            prepareLocalPlaybackLifecycle({backend, foobar: bridge, bridge, getCuePlaybackRequests,
              isBridgeReady: () => bridgeReady, onBridgeReady: value => {bridgeReady = value;}}, input, context)});
          checkOpen(); await owned();
          if (old !== currentSession) {const proof = backend.getExitEvidence(old); previousExit = backendApi.isVerifiedBackendChildExit(proof, old) &&
            backendApi.isVerifiedBackendTreeExit(proof, old) && backend.isOwnedTreeExited(old) === true; assert(previousExit, 'CUE_VERIFY_OLD_MAIN_TREE_EXIT');}
          return state;
        },
        cancel() {
          try {bootstrap.cancel();} finally {
            if (coordinator) coordinator.beginShutdown();
            else Promise.resolve(bridge?.cancelPending({intent: 'quit'})).catch(() => {});
          }
        },
        sessionId: () => currentSession?.sessionId, previousTreeExitVerified: () => previousExit,
        async snapshot() {
          await owned(); const state = await coordinator.getState(), value = await get('query?player=true&playlists=true&playQueue=true&outputs=true');
          assert(sameOutput(value.outputs?.active, wanted) && sameOutput(state.output, wanted), 'CUE_VERIFY_SHARED_OUTPUT_CHANGED');
          assert(Array.isArray(value.playlists) && value.playlists.length <= 16 && Array.isArray(value.playQueue), 'CUE_VERIFY_MAIN_SNAPSHOT');
          const lists = [];
          for (const row of value.playlists) {
            assert(typeof row.id === 'string' && Number.isInteger(row.itemCount) && row.itemCount >= 0 && row.itemCount <= 100, 'CUE_VERIFY_MAIN_SNAPSHOT');
            const page = (await get(`playlists/${encodeURIComponent(row.id)}/items/0:101?columns=${encodeURIComponent(foobarApi.COLUMNS.join(','))}`))?.playlistItems;
            assert(page && page.offset === 0 && page.totalCount === row.itemCount && Array.isArray(page.items) && page.items.length === row.itemCount, 'CUE_VERIFY_MAIN_SNAPSHOT');
            lists.push({id: row.id, title: row.title, isCurrent: row.isCurrent, items: page.items});
          }
          const roots = (await get('browser/roots'))?.roots;
          assert(Array.isArray(roots) && roots.length <= 2 && roots.every(row => typeof row.path === 'string'), 'CUE_VERIFY_MAIN_SNAPSHOT');
          const config = await reader.read(path.join(backendDir, 'profile/beefweb/config.json'), {maxBytes: 16384});
          const active = value.player?.activeItem;
          return {state, roots: roots.map(row => row.path), fingerprint: JSON.stringify({sessionId: currentSession.sessionId, lists, queue: value.playQueue,
            source: state.source, location: {path: state.currentTrack?.path, subsong: state.currentTrack?.subsong},
            active: {playlistId: active?.playlistId, index: active?.index, columns: active?.columns}, output: value.outputs?.active,
            roots, configIdentity: config.identity, configHash: digest(config.bytes)})};
        },
        async close() {
          let primary = null, proof = null, token = backend?.getSession() || currentSession;
          let setupClosed = false, bridgeClosed = !bridge, coordinatorDrained = !coordinator, guardClosed = false, libraryClosed = false;
          cuePlaybackGuard.beginShutdown();
          try {await bootstrap.close(); setupClosed = true;} catch (error) {primary ||= error;}
          if (coordinator) {try {await coordinator.close(); coordinatorDrained = true;} catch (error) {primary ||= error;}}
          if (bridge && backendApi.isVerifiedBackendSession(token)) {
            try {await bridge.beginShutdownWrites().stop(); assert((await bridge.getState()).state === 'stopped' && (await bridge.getState()).state === 'stopped', 'CUE_VERIFY_MAIN_STOP');}
            catch (error) {primary ||= error;}
          }
          let childExited = false, treeExited = false;
          if (backend) {
            try {proof = (await backend.close())?.exitEvidence;
              childExited = backendApi.isVerifiedBackendChildExit(proof, token); treeExited = backendApi.isVerifiedBackendTreeExit(proof, token) && backend.isOwnedTreeExited(token);
              assert(childExited && treeExited, 'CUE_VERIFY_MAIN_EXIT_UNVERIFIED');
              if (bridge && token) {bridge.markBackendExited(proof); await bridge.close(); bridgeClosed = true;}
              else if (bridge) {await bridge.close(); bridgeClosed = true;}}
            catch (error) {primary ||= error;}
          }
          try {await cuePlaybackGuard.close(); guardClosed = true;} catch (error) {primary ||= error;}
          try {await library.close(); libraryClosed = true;} catch (error) {primary ||= error;}
          return {startAttempted, childExited, treeExited, drained: setupClosed && bridgeClosed && coordinatorDrained && guardClosed && libraryClosed,
            failureCode: primary ? safeCode(primary) : null};
        }
      };
    }
  };
}

async function main(argv, output) {
  const input = parseArguments(argv);
  if (input.mode === 'plan') {output.write('stdout', JSON.stringify(plan(), null, 2) + '\n'); return;}
  const checked = await checkCandidate(input);
  if (input.mode === 'check') {output.write('stdout', JSON.stringify({mode: 'checked', ...checked}) + '\n'); return;}
  const scope = await makeScope(), logPath = path.join(scope.runDir, 'events.jsonl'), descriptor = fs.openSync(logPath, 'wx'); let written = 0, result;
  const keepAlive = setInterval(() => {}, 1000);
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const emit = event => {const line = JSON.stringify(event) + '\n'; written += Buffer.byteLength(line); assert(written <= 2 * 1024 * 1024, 'CUE_VERIFY_LOG_LIMIT'); fs.writeSync(descriptor, line);};
  let started = false;
  try {
    await fsp.writeFile(path.join(scope.runDir, 'owner.json'), JSON.stringify({executorPid: process.pid, runId: scope.id, dataRoot: scope.dataRoot}) + '\n', {flag: 'wx'});
    const api = productionApi(checked.appRoot), wanted = selection(input.typeId, input.deviceId);
    started = true;
    result = await runLifecycle({api, scope, wanted, emit, signal: controller.signal});
    await checkCandidate(input); fs.fsyncSync(descriptor);
    output.write('stdout', JSON.stringify({runId: scope.id, status: result.status, code: result.code, requiresExecutorRetention: result.requiresExecutorRetention}) + '\n');
    await output.flush();
    if (output.failed()) {result.status = 'failed'; result.code ||= 'CUE_VERIFY_EVIDENCE_FAILED';}
    await fsp.writeFile(path.join(scope.runDir, 'result.json'), JSON.stringify({...result, runId: scope.id, candidate: input.candidate,
      dataRoot: scope.dataRoot, buildInfoSha256: input.buildSha256, sampleSha256: scope.sampleSha256}, null, 2) + '\n', {flag: 'wx'});
    if (result.status !== 'passed') process.exitCode = 1;
  } finally {
    try {fs.closeSync(descriptor);} finally {
      if (started && (!result || result.requiresExecutorRetention || retainedOwners.size)) {
        output.write('stderr', 'CUE_VERIFY_EXECUTOR_RETAINED_FOR_UNPROVEN_LIFETIME\n');
      } else {clearInterval(keepAlive); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);}
    }
  }
}
module.exports = {plan, parseArguments, checkCandidate, wave, runLifecycle};
if (require.main === module) {
  const output = createOutputGuard(process.stdout, process.stderr, () => {process.exitCode = 1;});
  main(process.argv.slice(2), output).catch(error => {output.write('stderr', safeCode(error) + '\n'); process.exitCode = 1;});
}
