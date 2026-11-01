'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// In-memory runtimes and temporary synthetic files only; no actual process,
// probe, music, device, profile or player is launched or controlled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');
const {createBackendManager, isVerifiedBackendChildExit, isVerifiedInProcessOutputScope} = require('../src/main/backend');
const {createFoobarService} = require('../src/main/foobar');
const {createFoobarSessionService} = require('../src/main/foobar-session');
const {createPlaybackCoordinator, isExplicitAppleHandoffContext} = require('../src/main/playback-coordinator');
const {createOwnedOutputHandoffStore} = require('../src/main/owned-output-handoff');
const {writeSyntheticBackendRuntime} = require('./helpers/synthetic-backend-runtime');
const endpoint = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-owned-handoff-')), backendDir = path.join(root, 'backend'), dataDir = path.join(root, 'data');
  await writeSyntheticBackendRuntime(root);
  const files = [];
  for (const relativePath of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    const file = path.join(backendDir, relativePath), bytes = Buffer.from(`Synthetic bytes ${relativePath}`);
    await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, bytes);
    files.push({relativePath, sha256: digest(bytes), mutable: false});
  }
  await fs.mkdir(path.join(backendDir, 'profile/beefweb'), {recursive: true});
  await fs.writeFile(path.join(backendDir, 'backend-manifest.json'), JSON.stringify({schemaVersion: 1, privateUseOnly: true, backendId: 'fixture-owned',
    sourceDir: 'C:\\Original-do-not-touch', executable: 'foobar2000.exe', configuration: {port: 18880}, files}));
  await fs.writeFile(path.join(backendDir, 'profile/beefweb/config.json'), JSON.stringify({port: 18880, allowRemote: false, musicDirs: ['C:\\Music']}));
  const probePath = path.join(root, 'synthetic-probe.exe'); await fs.writeFile(probePath, 'SYNTHETIC NOT EXECUTABLE');
  let running = options.reused === true, pid = 200, child, playback = options.noActive ? 'stopped' : 'playing', playlistId = 'old-list', exitMode = options.exitMode || 'event';
  let queue = options.queue || [], volume = -18, order = 0, appleStarts = 0, exitCalls = 0;
  let spawnCount = 0;
  let onProbe = null;
  let onQuery = null;
  const calls = [], rows = [{path: 'C:\\Music\\a.cue', subsong: 1}, {path: 'C:\\Music\\b.flac', subsong: 0}, {path: 'C:\\Music\\a.cue', subsong: 1}];
  const output = {types: [{id: options.outputType || 'output', name: options.outputFamily || 'Output', devices: [{id: options.outputDevice || '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB', name: 'Synthetic DAC'}]}],
    active: {typeId: options.outputType || 'output', deviceId: options.outputDevice || '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB'}};
  const columns = row => [row.path, String(row.subsong), 'Synthetic', 'Synthetic artist', 'Synthetic album', '240'];
  const player = () => ({info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: playback,
    activeItem: options.missingActive ? undefined : options.noActive ? null : {playlistId, index: 2, position: 10, duration: 240, columns: columns(rows[2])},
    volume: {type: 'db', min: -100, max: 0, value: volume}, options: [{id: 'playbackOrder', type: 'enum', value: order, enumNames: ['Default', 'Repeat']} ]});
  const fetcher = async (url, init) => {
    const parsed = new URL(url), route = parsed.pathname.replace('/api/', ''); calls.push({route, method: init.method});
    if (route === 'query') await onQuery?.();
    if (options.hangQueue && route === 'playqueue/clear') return new Promise(() => {});
    if (options.hangAudio && route === 'player/stop') return new Promise(() => {});
    let value;
    if (route === 'query') value = {player: player(), outputs: output, playQueue: options.missingQueue ? undefined : queue};
    else if (route === 'player' && init.method === 'GET') value = {player: player()};
    else if (route === 'browser/roots') value = {roots: [{path: 'C:\\Music'}]};
    else if (route === 'playlists') value = {playlists: [{id: playlistId, title: 'Synthetic current context', itemCount: rows.length}]};
    else if (/^playlists\/[^/]+\/items\//.test(route)) {
      const match = route.match(/items\/(\d+):(\d+)/); value = {playlistItems: {offset: Number(match[1]), totalCount: rows.length,
        items: rows.slice(Number(match[1]), Number(match[1]) + Number(match[2])).map(row => ({columns: columns(row)}))}};
    } else if (route === 'player/stop') {playback = 'stopped'; value = null;}
    else if (route === 'playqueue') value = {playQueue: queue};
    else if (route === 'outputs') value = {outputs: output};
    else throw new Error(`Unexpected synthetic route ${route}`);
    return {ok: true, text: async () => value === null ? '' : JSON.stringify(value)};
  };
  const managerOptions = {backendDir, runtimeRoot: root, probePath, platform: 'win32', fetch: fetcher, quietRestartPolicy: options.quiet !== false ? 'stopped-owned-exit' : undefined,
    ownedExitOutputPolicy: options.outputPolicy !== false ? 'dx1-wasapi-in-process-v1' : undefined,
    pollMs: 2, startupTimeoutMs: 100, shutdownTimeoutMs: 40,
    inspectSystem: async args => ({processes: running ? [{pid, executablePath: path.join(backendDir, 'foobar2000.exe')}] : [],
      listeners: running ? [{pid, address: '127.0.0.1'}] : [], pidCheck: args.pid ? {pid: args.pid, present: running} : null}),
    spawn() {running = true; pid++; spawnCount++; child = new EventEmitter(); child.pid = pid; child.exitCode = null; return child;},
    execFile: async (_file, args) => {
      if (args[1] === 'shared') {
        onProbe?.();
        const successful = options.probeSuccess === true, busy = options.classification === 'busy';
        return {stdout: JSON.stringify({endpoint: options.trusted === false ? 'untrusted' : options.endpoint || endpoint,
          operation: 'Initialize', mode: 'shared', initialized: successful, deviceInUse: busy,
          hresult: successful ? '0x00000000' : busy ? '0x8889000A' : '0x887C001A', startCalled: false})};
      }
      assert.deepEqual(args, ['/exit']); exitCalls++;
      if (options.exitGate) await options.exitGate;
      if (exitMode === 'event') {running = false; child.exitCode = 0; child.emit('exit', 0);}
      else if (exitMode === 'pid-only') running = false;
      return {stdout: ''};
    }};
  const manager = createBackendManager(managerOptions);
  const releaseEvidence = {classification: options.classification || 'unknown', trustedEndpoint: options.trusted !== false,
    endpoint: options.endpoint || endpoint, hresult: '0x887C001A', operation: 'Initialize', mode: 'shared', startCalled: false,
    probeChildExited: true, initializeCalled: true, aborted: false, timedOut: false};
  const makeLocal = backend => createFoobarSessionService({createService: createFoobarService, backend,
    serviceOptions: {dataDir, foobarDir: backendDir, baseUrl: 'http://127.0.0.1:18880/api/', fetch: fetcher, pollIntervalMs: 0,
      persistOutputSelection: false, verifyPollMs: 1, verifyTimeoutMs: 100,
      onAudioDispatch: options.onAudioDispatch,
      timeoutMs: 50, handoffTimeoutMs: options.hangQueue ? 25 : 1000,
      probeOutputState: async () => ({endpoint, operation: 'GetState', mode: 'state', clientActivated: false, initializeCalled: false,
        startCalled: false, actualDacRate: null, deviceFound: true, state: 1, active: true, hresult: '0x00000000'}),
      waitForOutputRelease: args => backend.waitForOutputRelease({...args, timeoutMs: 25})}});
  const local = makeLocal(manager), extraLifetimes = [];
  await local.connect(await manager.initialize());
  const oldSession = manager.getSession();
  const apple = {cancelPending: async () => {}, stop: async () => {}, releaseOutput: async () => ({released: true}),
    getState: async () => ({available: true, state: appleStarts ? 'playing' : 'stopped', position: 0, duration: 1}),
    play: async () => {appleStarts++; return {state: 'playing'};}};
  const coordinator = createPlaybackCoordinator({engines: {local, apple}});
  t.after(async () => {exitMode = 'event'; for (const life of extraLifetimes) {await life.manager.close().catch(() => {}); await life.local.close().catch(() => {});} await coordinator.close().catch(() => {}); await manager.close().catch(() => {}); await local.close().catch(() => {}); await fs.rm(root, {recursive: true, force: true});});
  return {manager, local, coordinator, dataDir, backendDir, oldSession, calls, rows, releaseEvidence,
    appleStarts: () => appleStarts, exitCalls: () => exitCalls, setVolume: value => {volume = value;},
    spawnCount: () => spawnCount,
    remap: () => {playlistId = 'new-list';}, setQueue: value => {queue = value;}, onProbe: fn => {onProbe = fn;}, onQuery: fn => {onQuery = fn;}, setRunning: value => {running = value;},
    newLifetime() {const manager = createBackendManager(managerOptions), local = makeLocal(manager); const life = {manager, local}; extraLifetimes.push(life); return life;}};
}

test('unknown shared probe releases only after production branded owned-child exit; snapshot preserves duplicate occurrences', async t => {
  const f = await fixture(t);
  assert.equal((await f.coordinator.play({source: 'apple', input: {id: 'synthetic'}})).source, 'apple');
  assert.equal(f.exitCalls(), 1); assert.equal(f.appleStarts(), 1);
  const proof = f.manager.getExitEvidence(f.oldSession);
  assert.equal(isVerifiedBackendChildExit(proof, f.oldSession), true);
  assert.equal(isVerifiedBackendChildExit({...proof}, f.oldSession), false);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'owned-output-handoff.json'), 'utf8'));
  assert.deepEqual(saved.snapshot.items.map(row => row.occurrence), [0, 0, 1]); assert.equal(saved.snapshot.currentIndex, 2);
  assert.deepEqual(saved.snapshot.queue, []); assert.equal(saved.snapshot.volume.value, -18); assert.equal(saved.snapshot.order, 0);
  assert.equal(f.local.getHandoffStatus().current.releaseEvidence.classification, 'unknown');
  assert.equal(f.manager.getInfo().status, 'standby'); assert.equal(f.manager.getInfo().available, false);
  await f.manager.initialize(); assert.equal(f.manager.getSession(), null, 'background initialize does not restart standby');
  f.remap(); const info = await f.manager.ensureStarted({explicitLocalPlay: true}); await f.local.connect(info);
  const restored = await f.local.verifyHandoffRestore(); assert.equal(restored.currentPlaylistId, 'new-list');
  assert.equal(f.calls.some(row => row.method === 'POST' && /volume|outputs\/active|playqueue\//.test(row.route)), false);
});

test('normal shared-probe success never exits the owned backend', async t => {
  const f = await fixture(t, {probeSuccess: true}); await f.coordinator.play({source: 'apple'});
  assert.equal(f.exitCalls(), 0); assert.equal(f.appleStarts(), 1);
});

for (const [name, options] of Object.entries({nonemptyQueue: {queue: [{playlistId: 'old-list', itemIndex: 1}]},
  reused: {reused: true}, knownBusy: {classification: 'busy'}, untrustedEndpoint: {trusted: false},
  wrongEndpoint: {endpoint: '{0.0.0.00000000}.{116F9F0C-AFE4-4072-9018-CCEBB576B4CB}'}, quietUnverified: {quiet: false}})) {
  test(`owned fallback fails closed for ${name}`, async t => {
    const f = await fixture(t, options); await assert.rejects(f.coordinator.play({source: 'apple'}));
    assert.equal(f.exitCalls(), 0); assert.equal(f.appleStarts(), 0);
    assert.equal(f.calls.some(row => row.route === 'playqueue/clear'), false);
  });
}

test('a PID-absence report without the production owned-child exit event never releases Apple', async t => {
  const f = await fixture(t, {exitMode: 'pid-only'}); await assert.rejects(f.coordinator.play({source: 'apple'}));
  assert.equal(f.appleStarts(), 0); assert.equal(isVerifiedBackendChildExit(f.manager.getExitEvidence(f.oldSession), f.oldSession), false);
});

test('new profile/context choices are not overwritten during explicit-local handoff recovery', async t => {
  const f = await fixture(t); await f.coordinator.play({source: 'apple'});
  f.setVolume(-9); await f.local.connect(await f.manager.ensureStarted({explicitLocalPlay: true}));
  await assert.rejects(f.local.verifyHandoffRestore(), {code: 'STILL_HANDOFF_CONTEXT_CHANGED'});
  assert.equal(f.calls.some(row => row.method === 'POST' && row.route === 'player'), false);
});

test('writes are fenced during the context lease and nonempty late queue changes prevent exit', async t => {
  const f = await fixture(t), controller = new AbortController(), context = {signal: controller.signal, check() {assert.equal(controller.signal.aborted, false);}};
  await f.local.prepareOutputHandoff(context);
  await assert.rejects(f.local.queueClear(), {code: 'STILL_HANDOFF_BUSY'});
  await assert.rejects(f.local.setVolume(0.1), {code: 'STILL_HANDOFF_BUSY'});
  assert.equal(f.calls.some(row => row.route === 'playqueue/clear' || row.method === 'POST' && row.route === 'player'), false);
  f.local.finishOutputHandoff(context);
  f.onProbe(() => f.setQueue([{playlistId: 'old-list', itemIndex: 0}]));
  await assert.rejects(f.coordinator.play({source: 'apple'}), {code: 'STILL_HANDOFF_QUEUE_NOT_EMPTY'});
  assert.equal(f.exitCalls(), 0); assert.equal(f.appleStarts(), 0);
});

test('closed configuration edits block reopening; normal startup byte changes are checked semantically', async t => {
  const f = await fixture(t);
  const database = path.join(f.backendDir, 'profile/config.sqlite'); await fs.writeFile(database, 'synthetic old bytes');
  await f.coordinator.play({source: 'apple'});
  await fs.writeFile(database, 'external change while closed');
  await assert.rejects(f.manager.ensureStarted({explicitLocalPlay: true}), /关闭期间/);
  await fs.writeFile(database, 'synthetic old bytes');
  await f.local.connect(await f.manager.ensureStarted({explicitLocalPlay: true}));
  await fs.writeFile(database, 'legitimate startup registration bytes');
  assert.equal((await f.local.verifyHandoffRestore()).verified, true);
});

test('a cancelled transition waits for its already-requested child exit and never starts Apple late', async t => {
  let release; const exitGate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, {exitGate});
  const first = f.coordinator.play({source: 'apple'}); const firstError = first.catch(error => error);
  while (!f.exitCalls()) await tick();
  const cancellation = f.coordinator.cancelPending();
  assert.equal((await firstError).code, 'STILL_CANCELLED'); assert.equal(f.appleStarts(), 0);
  release(); await cancellation; await tick();
  assert.equal(isVerifiedBackendChildExit(f.manager.getExitEvidence(f.oldSession), f.oldSession), true);
  assert.equal(f.appleStarts(), 0);
  await f.local.connect(await f.manager.ensureStarted({explicitLocalPlay: true}));
  assert.equal((await f.local.verifyHandoffRestore()).verified, true);
});

test('persisted handoff is metadata only and cannot manufacture a source-exit proof', async t => {
  const f = await fixture(t); await f.coordinator.play({source: 'apple'});
  const store = createOwnedOutputHandoffStore({dataDir: f.dataDir});
  assert.equal((await store.initialize()).pending, true);
  const saved = store.current(); assert.equal(saved.status, 'awaiting-local');
  assert.equal(isVerifiedBackendChildExit(saved, f.oldSession), false);
  assert.equal(store.verify({...saved.snapshot, playlistId: 'fresh-real-id'}).currentPlaylistId, 'fresh-real-id');
  assert.throws(() => store.verify({...saved.snapshot, items: [...saved.snapshot.items].reverse()}), /重复曲目|不一致/);
});

test('an unsettled queue write fails the bounded capture barrier without stop, exit or Apple start', async t => {
  const f = await fixture(t, {hangQueue: true});
  const queued = f.local.queueClear(); queued.catch(() => {}); await tick();
  await assert.rejects(f.coordinator.play({source: 'apple'}), {code: 'STILL_HANDOFF_DRAIN_UNVERIFIED'});
  assert.equal(f.exitCalls(), 0); assert.equal(f.appleStarts(), 0);
  assert.equal(f.calls.some(row => row.route === 'player/stop'), false);
  // Only the production manager's real synthetic child exit can end the old
  // transport lifetime for fixture cleanup; no fabricated JSON proof is used.
  const result = await f.manager.close(); f.local.markBackendExited(result.exitEvidence);
  await queued.catch(() => {});
});

test('a newer Apple intent can consume the exact completed child proof after an older transition was cancelled', async t => {
  let release; const gate = new Promise(resolve => {release = resolve;});
  const f = await fixture(t, {exitGate: gate});
  const first = f.coordinator.play({source: 'apple'}); const failed = first.catch(error => error);
  while (!f.exitCalls()) await tick();
  const cancelling = f.coordinator.cancelPending(); assert.equal((await failed).code, 'STILL_CANCELLED');
  release(); await cancelling;
  while (f.local.getHandoffStatus().exitUnverified) await tick();
  const readCount = f.calls.length;
  assert.equal((await f.coordinator.play({source: 'apple'})).source, 'apple');
  assert.equal(f.appleStarts(), 1); assert.equal(f.exitCalls(), 1);
  assert.equal(f.calls.slice(readCount).some(row => row.route === 'player/stop'), false, 'No stop is sent into the retired transport');
  assert.equal(f.local.getHandoffStatus().current.sourceExited, true);
});

test('cancellation after saving but before the exit command marks only the uncommitted snapshot aborted', async t => {
  const f = await fixture(t), controller = new AbortController(), context = {signal: controller.signal};
  await f.local.prepareOutputHandoff(context); await f.local.stop();
  f.onQuery(async () => {
    if (await fs.stat(path.join(f.dataDir, 'owned-output-handoff.json')).catch(() => null)) controller.abort();
  });
  await assert.rejects(f.local.releaseOutput(context), {code: 'STILL_CANCELLED'});
  f.local.finishOutputHandoff(context);
  assert.equal(f.exitCalls(), 0); assert.equal(f.appleStarts(), 0);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'owned-output-handoff.json'), 'utf8'));
  assert.equal(saved.status, 'aborted');
  const reloaded = createOwnedOutputHandoffStore({dataDir: f.dataDir}); assert.equal((await reloaded.initialize()).pending, false);
});

for (const [name, options] of Object.entries({unapprovedPolicy: {outputPolicy: false},
  otherDriver: {outputDevice: '11111111-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB'},
  otherOutputType: {outputType: 'third-party'},
  asioHost: {outputFamily: 'ASIO external host'}, dsdHost: {outputFamily: 'DSD'}, externalHost: {outputFamily: 'External renderer'}})) {
  test(`a source PID exit is not sufficient for ${name} output scope`, async t => {
    const f = await fixture(t, options); await assert.rejects(f.coordinator.play({source: 'apple'}));
    assert.equal(f.exitCalls(), 0); assert.equal(f.appleStarts(), 0);
    assert.equal(f.manager.getSession(), f.oldSession);
  });
}

test('in-process output scope is current-session branded and cannot be forged from a tuple or JSON copy', async t => {
  const f = await fixture(t), output = {typeId: 'output', deviceId: '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB'};
  const scope = f.manager.verifyOwnedOutputScope(f.oldSession, output);
  assert.equal(isVerifiedInProcessOutputScope(scope, f.oldSession), true);
  assert.equal(isVerifiedInProcessOutputScope({...scope}, f.oldSession), false);
  await assert.rejects(f.manager.retireForOutputHandoff(f.oldSession, {outputScope: {...scope}}), {code: 'STILL_HANDOFF_OUTPUT_SCOPE_UNVERIFIED'});
  assert.equal(f.exitCalls(), 0);
});

test('an actual branded source exit ends an unresolved audio dispatch; a caller timeout does not', async t => {
  const dispositions = [], f = await fixture(t, {hangAudio: true, onAudioDispatch: () => ({settle: value => {dispositions.push(value);}})});
  const stopping = f.local.stop(); stopping.catch(() => {});
  while (!f.local.getAudioTransportStatus().pending) await tick();
  await assert.rejects(stopping, {code: 'STILL_TRANSPORT_UNCERTAIN'});
  assert.equal(f.local.getAudioTransportStatus().pending, true); assert.deepEqual(dispositions, []);
  const result = await f.manager.close(); f.local.markBackendExited(result.exitEvidence);
  assert.equal(f.local.getAudioTransportStatus().pending, false);
  await tick(); assert.deepEqual(dispositions, ['uncertain']);
});

test('a new application lifetime with only persisted metadata has no source-exit brand and cannot use unpermitted recovery methods', async t => {
  const f = await fixture(t); await f.coordinator.play({source: 'apple'});
  let requests = 0, processCalls = 0;
  const manager = createBackendManager({backendDir: f.backendDir, quietRestartPolicy: 'stopped-owned-exit', ownedExitOutputPolicy: 'dx1-wasapi-in-process-v1',
    fetch: async () => {requests++; throw new Error('No HTTP allowed from pending metadata');},
    inspectSystem: async () => {processCalls++; throw new Error('No implicit startup inspection');},
    spawn: () => {processCalls++; throw new Error('No implicit start');}});
  const fresh = createFoobarSessionService({createService: createFoobarService, backend: manager,
    serviceOptions: {dataDir: f.dataDir, foobarDir: f.backendDir, baseUrl: 'http://127.0.0.1:18880/api/', pollIntervalMs: 0,
      fetch: async () => {requests++; throw new Error('No stale bridge GET');}}});
  assert.equal((await fresh.initializeHandoff()).pending, true);
  assert.equal(fresh.getHandoffStatus().current.sourceExited, null);
  assert.equal(manager.getSession(), null); assert.equal(manager.getInfo().canStartOnDemand, false);
  await assert.rejects(fresh.prepareOutputHandoff(), {code: 'STILL_HANDOFF_SESSION_UNVERIFIED'});
  await assert.rejects(fresh.releaseOutput(), {code: 'STILL_HANDOFF_SESSION_UNVERIFIED'});
  await assert.rejects(fresh.verifyHandoffRestore(), {code: 'STILL_HANDOFF_SESSION_UNVERIFIED'});
  assert.equal(requests, 0); assert.equal(processCalls, 0);
  await fresh.close();
});

test('even a real owned-child exit does not certify release of an external audio host', async t => {
  const f = await fixture(t, {outputFamily: 'ASIO external host'});
  const actualExit = await f.manager.close();
  assert.equal(isVerifiedBackendChildExit(actualExit.exitEvidence, f.oldSession), true);
  f.local.markBackendExited(actualExit.exitEvidence);
  await assert.rejects(f.local.releaseOutput(), {code: 'STILL_HANDOFF_SESSION_UNVERIFIED'});
  await assert.rejects(f.coordinator.play({source: 'apple'}), {code: 'STILL_HANDOFF_SESSION_UNVERIFIED'});
  assert.equal(f.appleStarts(), 0);
});

async function coldFixture(t, options = {}) {
  const f = await fixture(t, options); await f.coordinator.play({source: 'apple'});
  await f.coordinator.close(); await f.manager.close();
  if (options.prepared) {
    const file = path.join(f.dataDir, 'owned-output-handoff.json'), record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.status = 'prepared'; await fs.writeFile(file, JSON.stringify(record));
  }
  if (options.reusedCold) f.setRunning(true);
  if (options.changedCold) f.setVolume(-9);
  if (options.changedFingerprint) await fs.writeFile(path.join(f.backendDir, 'profile/config.sqlite'), 'changed while closed');
  const life = f.newLifetime(); await life.local.initializeHandoff(); await life.manager.initialize({start: false});
  let appleStarts = 0, prepares = 0, capturedContext;
  const apple = {cancelPending: async () => {}, stop: async () => {}, releaseOutput: async () => ({released: true}),
    getState: async () => ({available: true, state: appleStarts ? 'playing' : 'stopped'}), play: async () => {appleStarts++;}};
  const coordinator = createPlaybackCoordinator({engines: {local: life.local, apple}, prepareAppleHandoff: async context => {
    prepares++; capturedContext = context; assert.equal(isExplicitAppleHandoffContext(context), true);
    if (options.beforeRestore) await options.beforeRestore;
    context.check();
    const info = await life.manager.ensureStarted({explicitHandoffRestore: context, signal: context.signal}); context.check();
    await life.local.connect(info); context.check();
    if (options.afterConnect) await options.afterConnect;
    context.check(); await life.local.verifyHandoffRestore(context); context.check();
  }});
  t.after(() => coordinator.close().catch(() => {}));
  return {f, life, coordinator, appleStarts: () => appleStarts, prepares: () => prepares, context: () => capturedContext};
}

test('cold complete awaiting-local metadata uses one permitted stopped restore and a new branded exit before direct Apple play', async t => {
  const c = await coldFixture(t), beforeSpawns = c.f.spawnCount(), beforeExits = c.f.exitCalls();
  assert.equal(c.life.local.getHandoffStatus().current.sourceExited, null);
  assert.equal(c.life.local.needsColdHandoffRestore(), true);
  const result = await c.coordinator.play({source: 'apple'});
  assert.equal(result.source, 'apple'); assert.equal(c.appleStarts(), 1); assert.equal(c.prepares(), 1);
  assert.equal(c.f.spawnCount(), beforeSpawns + 1); assert.equal(c.f.exitCalls(), beforeExits + 1);
  assert.equal(c.life.local.getHandoffStatus().current.sourceExited, true);
  assert.equal(c.life.local.needsColdHandoffRestore(), false);
  assert.equal(isExplicitAppleHandoffContext(c.context()), false, 'The private permit expires after its preparation callback');
  await assert.rejects(c.life.manager.ensureStarted({explicitHandoffRestore: true}), {code: 'STILL_HANDOFF_RESTORE_UNVERIFIED'});
});

for (const [name, options] of Object.entries({prepared: {prepared: true}, reused: {reusedCold: true}, semanticMismatch: {changedCold: true}, closedFingerprintMismatch: {changedFingerprint: true}})) {
  test(`cold direct Apple preparation fails closed for ${name}`, async t => {
    const c = await coldFixture(t, options), exits = c.f.exitCalls();
    await assert.rejects(c.coordinator.play({source: 'apple'}));
    assert.equal(c.appleStarts(), 0); assert.equal(c.f.exitCalls(), exits, 'A failed recovery does not exit a different/reused or changed session');
    if (name === 'prepared') assert.equal(c.prepares(), 0);
  });
}

test('a newer intent cancels cold preparation before it can start or mutate a new session', async t => {
  let release; const beforeRestore = new Promise(resolve => {release = resolve;});
  const c = await coldFixture(t, {beforeRestore}), spawns = c.f.spawnCount();
  const playing = c.coordinator.play({source: 'apple'}); playing.catch(() => {});
  while (!c.prepares()) await tick(); await c.coordinator.cancelPending(); release();
  await assert.rejects(playing, {code: 'STILL_CANCELLED'}); await tick();
  assert.equal(c.appleStarts(), 0); assert.equal(c.f.spawnCount(), spawns); assert.equal(c.life.manager.getSession(), null);
});

test('a cancelled older cold callback never exits the newly connected session and the latest intent reuses it', async t => {
  let release; const afterConnect = new Promise(resolve => {release = resolve;});
  const c = await coldFixture(t, {afterConnect}), beforeSpawns = c.f.spawnCount();
  const older = c.coordinator.play({source: 'apple'}); older.catch(() => {});
  while (!c.life.manager.getSession()) await tick();
  const newSession = c.life.manager.getSession(); await c.coordinator.cancelPending(); release();
  await assert.rejects(older, {code: 'STILL_CANCELLED'}); await tick();
  assert.equal(c.life.manager.getSession(), newSession); assert.equal(c.f.spawnCount(), beforeSpawns + 1);
  assert.equal(c.appleStarts(), 0);
  assert.equal((await c.coordinator.play({source: 'apple'})).source, 'apple');
  assert.equal(c.f.spawnCount(), beforeSpawns + 1, 'The latest intent reuses the verified stopped warm instance');
  assert.equal(c.appleStarts(), 1);
});

test('explicit null active item plus stopped and complete empty queue preserves every playlist and can retire safely', async t => {
  const f = await fixture(t, {noActive: true});
  assert.equal((await f.coordinator.play({source: 'apple'})).source, 'apple');
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'owned-output-handoff.json'), 'utf8'));
  assert.equal(saved.snapshot.contextMode, 'none'); assert.equal(saved.snapshot.currentIndex, null);
  assert.deepEqual(saved.snapshot.items, []); assert.equal(saved.snapshot.playlists.length, 1);
  assert.deepEqual(saved.snapshot.playlists[0].items.map(row => row.occurrence), [0, 0, 1]);
  assert.equal(f.exitCalls(), 1); assert.equal(f.calls.some(row => /^player\/play/.test(row.route)), false);
});

test('cold direct Apple recovery also accepts a complete stopped no-current context without playing any old item', async t => {
  const c = await coldFixture(t, {noActive: true});
  assert.equal((await c.coordinator.play({source: 'apple'})).source, 'apple');
  assert.equal(c.appleStarts(), 1); assert.equal(c.f.calls.some(row => /^player\/play/.test(row.route)), false);
});

for (const options of [{missingActive: true}, {noActive: true, missingQueue: true}]) test('missing current-item or queue data is not a known-none snapshot', async t => {
  const f = await fixture(t, options); await assert.rejects(f.coordinator.play({source: 'apple'}));
  assert.equal(f.exitCalls(), 0); assert.equal(f.appleStarts(), 0);
});
