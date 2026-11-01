'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const {createRuntimeLog, sanitizeRuntimeLog, installRuntimeFailureHandlers} = require('../src/main/runtime-log');
const {createRuntimePoll} = require('../src/main/runtime-poll');
const {createHandlers, createLibraryView, commandAvailability, validateSafeOwnedExitPayload} = require('../src/main/ipc-handlers');
const {createDiagnosticsService} = require('../src/main/diagnostics');
const {createFoobarService} = require('../src/main/foobar');
const {createFakeBeefwebHttp} = require('./helpers/fake-beefweb-http');
const {initializeBackend, requiresAbnormalStartupExit, shutdownDesktop} = require('../src/main/main');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
function timers() {
  let sequence = 0;
  const active = new Map(), old = new Map();
  return {active, old, set(fn) {const id = ++sequence; active.set(id, fn); old.set(id, fn); return id;},
    clear(id) {active.delete(id);}, fire() {for (const fn of [...active.values()]) fn();}};
}

test('runtime log retains the latest 200 detached fixed records and rejects arbitrary secrets/accessors/serialization hooks', () => {
  let reads = 0, serializations = 0, clock = 0;
  const sent = [], log = createRuntimeLog({now: () => ++clock, sink: value => sent.push(value)});
  const input = {level: 'error', line: 1, source: 'C:/arbitrary-secret/preload.js', code: 'STILL_RUNTIME_FATAL',
    message: 'SECRET WITHOUT A MARKER', provider: {token: 'SECRET WITHOUT A MARKER'}, headers: {authorization: 'SECRET WITHOUT A MARKER'}};
  Object.defineProperty(input, 'exitCode', {get() {reads++; return 99;}});
  input.toJSON = () => {serializations++; return {message: 'SECRET WITHOUT A MARKER'};};
  const first = log.record('preload-error', input); input.line = 999; first.line = 888; sent[0].line = 777;
  assert.equal(log.snapshot().entries[0].line, 1);
  for (let i = 0; i < 250; i++) log.record('renderer-console', {level: 'warning', line: i, source: 'arbitrary-secret', message: 'SECRET WITHOUT A MARKER'});
  log.record('SECRET WITHOUT A MARKER', {code: 'SECRET WITHOUT A MARKER'});
  const snapshot = log.snapshot();
  assert.equal(snapshot.entries.length, 200); assert.equal(snapshot.dropped, 52);
  assert.equal(snapshot.entries[0].line, 51); assert.equal(snapshot.entries.at(-1).event, 'runtime-event');
  snapshot.entries[0].message = 'outside mutation';
  assert.equal(JSON.stringify(log.snapshot()).includes('SECRET'), false);
  assert.equal(JSON.stringify(log.snapshot()).includes('arbitrary-secret'), false);
  assert.equal(JSON.stringify(log.snapshot()).includes('outside mutation'), false);
  assert.equal(reads, 0); assert.equal(serializations, 0);
  const hostile = {entries: [input], dropped: 0};
  Object.defineProperty(hostile, 'provider', {get() {reads++; throw new Error('SECRET');}});
  assert.equal(JSON.stringify(sanitizeRuntimeLog(hostile)).includes('SECRET'), false); assert.equal(reads, 0);
});

test('fatal handlers gate synchronously, ignore raw Error/rejection values and safely exit exactly once with nonzero status', async () => {
  const target = new EventEmitter(), gate = deferred(), exits = [], clock = timers();
  let closed = false, calls = 0;
  const log = createRuntimeLog({sink: () => {}});
  const handlers = installRuntimeFailureHandlers({processTarget: target, log, onFatal() {closed = true; calls++; return gate.promise;},
    exit: code => exits.push(code), setTimeoutFn: fn => clock.set(fn), clearTimeoutFn: id => clock.clear(id)});
  const secret = new Error('SECRET WITHOUT A MARKER');
  Object.defineProperty(secret, 'cause', {get() {throw new Error('Must not inspect cause');}});
  target.emit('uncaughtException', secret);
  assert.equal(closed, true); assert.equal(handlers.isFatal(), true); assert.equal(target.exitCode, 1);
  assert.equal(commandAvailability('settings:update', {fatal: handlers.isFatal()}).ok, false);
  target.emit('unhandledRejection', {toJSON() {throw new Error('Must not serialize');}});
  assert.equal(calls, 1); assert.deepEqual(exits, []);
  gate.resolve(); await handlers.completion(); assert.deepEqual(exits, [1]); assert.equal(clock.active.size, 0);
  assert.equal(JSON.stringify(log.snapshot()).includes('SECRET'), false);
  handlers.dispose(); assert.equal(target.listenerCount('uncaughtException'), 0); assert.equal(target.listenerCount('unhandledRejection'), 0);
});

test('fatal cleanup has a bounded injected deadline even if shutdown never settles or rejects', async () => {
  for (const cleanup of [() => new Promise(() => {}), () => Promise.reject(new Error('SECRET'))]) {
    const target = new EventEmitter(), exits = [], clock = timers(), log = createRuntimeLog({sink: () => {}});
    const handlers = installRuntimeFailureHandlers({processTarget: target, log, onFatal: cleanup, exit: code => exits.push(code),
      setTimeoutFn: fn => clock.set(fn), clearTimeoutFn: id => clock.clear(id)});
    target.emit('unhandledRejection', 'SECRET'); clock.fire(); await handlers.completion();
    clock.fire(); target.emit('uncaughtException', new Error('SECRET')); await flush();
    assert.deepEqual(exits, [1]); assert.equal(log.snapshot().entries.at(-1).event, 'fatal-shutdown-failed');
    assert.equal(JSON.stringify(log.snapshot()).includes('SECRET'), false); handlers.dispose();
  }
});

test('poll restart uses one timer and one global in-flight request; stale callbacks/results cannot publish or overlap', async () => {
  const clock = timers(), gate = deferred(); let reads = 0, errors = 0;
  const published = [], poll = createRuntimePoll({setIntervalFn: fn => clock.set(fn), clearIntervalFn: id => clock.clear(id),
    read: async current => {reads++; if (reads === 1) await gate.promise; return {current: current()};},
    publish: value => published.push(value), onError: () => {errors++;}});
  poll.start(); poll.start(); assert.equal(clock.active.size, 1);
  const oldTimer = [...clock.active.keys()][0], old = poll.tick();
  poll.stop(); poll.start(); assert.equal(clock.active.size, 1);
  clock.old.get(oldTimer)(); clock.fire(); await poll.tick(); assert.equal(reads, 1);
  gate.resolve(); await old; assert.deepEqual(published, []); assert.equal(errors, 0);
  await poll.tick(); assert.deepEqual(published, [{current: true}]); assert.equal(reads, 2);
  poll.stop(); clock.old.get(oldTimer)(); clock.fire(); await flush(); assert.equal(reads, 2);
  assert.equal(clock.active.size, 0);
});

test('a stale rejected poll cannot clear a replacement flight, report an error or revive a stopped timer', async () => {
  const clock = timers(), gate = deferred(), second = deferred(); let reads = 0, errors = 0;
  const poll = createRuntimePoll({setIntervalFn: fn => clock.set(fn), clearIntervalFn: id => clock.clear(id),
    read: async () => {if (++reads === 1) {await gate.promise; throw new Error('old failure');} await second.promise; return reads;},
    publish: () => {}, onError: () => {errors++;}});
  poll.start(); const old = poll.tick(); poll.stop(); poll.start();
  gate.resolve(); await old; assert.equal(errors, 0);
  const next = poll.tick(); clock.old.get(1)(); clock.fire(); await poll.tick(); assert.equal(reads, 2);
  second.resolve(); await next; poll.stop(); assert.equal(clock.active.size, 0);
});

test('quit failure retains live read services and recovers read-only polling without reopening business controls', async () => {
  const clock = timers(), calls = []; let closed = false, readOnly = false, polls = 0, backendCloses = 0;
  const poll = createRuntimePoll({setIntervalFn: fn => clock.set(fn), clearIntervalFn: id => clock.clear(id),
    read: async () => ++polls, publish: () => {}});
  const coordinator = {beginShutdown: () => {closed = true; return {settled: Promise.resolve()};}};
  const options = {coordinator, foobar: {stop: async () => {}, close: async () => {calls.push('foobar-close');}},
    backend: {getInfo: () => ({owned: false}), close: async () => {if (++backendCloses === 1) throw new Error('owned exit unverified'); return {};}},
    closeServices: [async () => calls.push('save-data')]};
  poll.start(); poll.stop();
  await assert.rejects(shutdownDesktop(options)); readOnly = true; poll.start(); await poll.tick();
  assert.equal(closed, true); assert.equal(clock.active.size, 1); assert.equal(polls, 1); assert.deepEqual(calls, []);
  for (const channel of ['player:play', 'queue:add', 'library:remove', 'settings:update', 'lyrics:bind', 'backend:retry', 'apple:authorize', 'app:safeOwnedExit']) {
    assert.equal(commandAvailability(channel, {readOnly}).ok, false, channel);
  }
  for (const channel of ['source:status', 'player:state', 'app:exportDiagnostics', 'app:restoreInfo']) assert.equal(commandAvailability(channel, {readOnly}).ok, true);
  poll.stop(); await shutdownDesktop(options); assert.deepEqual(calls, ['foobar-close', 'save-data']);
});

test('a late data-drain rejection keeps manual diagnostics usable and only one read-only poll timer', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'still-runtime-drain-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const diagnostic = createDiagnosticsService({dataDir: directory, getSnapshot: () => ({player: {state: 'unavailable'}})});
  const clock = timers(); let readOnly = false, spectrumDisposed = false, contextDisposed = false;
  const poll = createRuntimePoll({setIntervalFn: fn => clock.set(fn), clearIntervalFn: id => clock.clear(id),
    read: async () => ({available: false}), publish: () => {}});
  poll.start(); poll.stop();
  try {
    await shutdownDesktop({coordinator: {beginShutdown: () => ({settled: Promise.resolve()})},
      foobar: {close: async () => {}}, backend: {getInfo: () => ({owned: false}), close: async () => ({})},
      closeServices: [async () => {await flush(); throw new Error('data flush failed');}]});
    spectrumDisposed = true; contextDisposed = true; await diagnostic.close();
    assert.fail('The late drain must fail');
  } catch {readOnly = true; poll.start();}
  poll.start(); await poll.tick();
  assert.equal(spectrumDisposed, false); assert.equal(contextDisposed, false); assert.equal(clock.active.size, 1);
  assert.equal(commandAvailability('settings:update', {readOnly}).ok, false);
  const saved = await diagnostic.exportSnapshot(); assert.equal(saved.saved, true);
  poll.stop(); await diagnostic.close();
});

test('shutdown synchronously quiesces a real queued removal before its old GET can dispatch a POST', async () => {
  const entered = deferred(), gate = deferred(), calls = [];
  const http = createFakeBeefwebHttp(async ({route, call, send}) => {
    calls.push(call);
    if (route !== 'playqueue') throw new Error('Unexpected request');
    entered.resolve(); await gate.promise;
    send({playQueue: [{playlistId: 'fixture', itemIndex: 0, columns: ['C:/fixture.wav', '0', 'Fixture', '', '', '100']}]});
  });
  const service = createFoobarService({foobarDir: 'C:/Fixture', baseUrl: http.baseUrl, fetch: http.fetch, pollIntervalMs: 0});
  const pending = service.queueRemove(0); pending.catch(() => {}); await entered.promise;
  const closing = shutdownDesktop({foobar: service, bridgeSessionBound: false,
    coordinator: {beginShutdown: () => ({settled: service.cancelPending()})}, backend: {getInfo: () => ({owned: false}), close: async () => ({})}});
  assert.equal(service.transportStatus().writesQuiesced, true);
  gate.resolve(); await assert.rejects(pending); await closing;
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('read-only recovery is explicit in player/source results and late dialog completion cannot start a fatal-time write', async () => {
  let state = {}, imports = 0; const dialogGate = deferred();
  const h = createHandlers({library: {list: () => ({tracks: []}), importFiles: async () => {imports++; return {tracks: []};}},
    getRuntimeState: () => state, settings: {get: () => ({})}, dialog: {showOpenDialog: () => dialogGate.promise}, window: () => ({}),
    foobar: {capabilities: () => ({})}, coordinator: {getState: async () => ({source: 'local', state: 'playing', generation: 1, revision: 1}),
      getEngineState: async () => ({available: true, backendReachable: true}), currentGeneration: () => 1, currentRevision: () => 1}});
  const pending = h['library:import']({kind: 'files'}); state = {fatal: true};
  dialogGate.resolve({canceled: false, filePaths: ['C:/fixture.flac']}); await assert.rejects(pending); assert.equal(imports, 0);
  state = {readOnly: true};
  const player = await h['player:state']({}), sources = await h['source:status']({});
  assert.equal(player.controlsReady, false); assert.equal(player.errorCode, 'STILL_SHUTDOWN_FAILED');
  assert.match(player.error, /只读/); assert.equal(sources.sources.local.capabilities.playback, false);
  assert.equal(sources.sources.apple.capabilities.authorize, false); assert.match(sources.sources.local.message, /只读/);
  h.closePlaybackContext();
});

test('main preserves degraded read health and prioritizes uncertain controls without advancing the cached position', async () => {
  let controlUncertain = false;
  const local = () => ({available: true, backendReachable: false, state: 'playing', connectionStatus: 'degraded', stale: true,
    consecutiveReadFailures: 2, lastGoodAt: '2026-11-01T00:00:00.000Z', position: 12.25, readAt: '2026-11-01T00:00:00.000Z', controlUncertain});
  const h = createHandlers({library: {list: () => ({tracks: []})}, foobar: {},
    coordinator: {getState: async () => ({...local(), source: 'local', generation: 1, revision: 1}), getEngineState: async () => local()}});
  const player = await h['player:state']({}), source = (await h['source:status']({})).sources.local;
  assert.equal(player.connectionStatus, 'degraded'); assert.equal(player.position, 12.25); assert.equal(player.readAt, local().readAt);
  assert.equal(source.status, 'degraded'); assert.equal(source.stale, true); assert.equal(source.consecutiveReadFailures, 2);
  controlUncertain = true;
  const uncertain = (await h['source:status']({})).sources.local;
  assert.equal(uncertain.status, 'control-unconfirmed'); assert.equal(uncertain.capabilities.playback, false); assert.match(uncertain.message, /控制/);
  h.closePlaybackContext();
});

test('safe legacy exit IPC accepts only an empty status query or a UUID selection, never renderer ownership claims', async () => {
  let status = 0, dispatches = 0;
  const token = '11111111-2222-4333-8444-555555555555';
  const h = createHandlers({library: {list: () => ({tracks: []})}, foobar: {}, getSafeOwnedExitTarget: () => {
    status++; return {available: true, selectionToken: token};}, requestSafeOwnedExit: value => {dispatches++; assert.deepEqual(value, {selectionToken: token}); return {exited: true};}});
  assert.deepEqual(await h['app:safeOwnedExitStatus']({}), {available: true, selectionToken: token});
  for (const input of [{pid: 1}, {selectionToken: token, owned: true}, {selectionToken: token, path: 'C:/any.exe'}, {selectionToken: 'forged'}, {selectionToken: null}]) {
    assert.throws(() => validateSafeOwnedExitPayload(input, true));
  }
  let getters = 0; const accessor = {};
  Object.defineProperty(accessor, 'selectionToken', {get() {getters++; return token;}});
  assert.throws(() => validateSafeOwnedExitPayload(accessor, true)); assert.equal(getters, 0);
  await assert.rejects(h['app:safeOwnedExitStatus']({pid: 1}));
  assert.deepEqual(await h['app:safeOwnedExit']({selectionToken: token}), {exited: true});
  assert.equal(status, 1); assert.equal(dispatches, 1); h.closePlaybackContext();
  const disabled = createHandlers({library: {list: () => ({tracks: []})}, foobar: {}});
  assert.equal((await disabled['app:safeOwnedExitStatus']({})).available, false);
  await assert.rejects(disabled['app:safeOwnedExit']({selectionToken: token})); disabled.closePlaybackContext();
});

test('manual diagnostics reconstruct the latest runtime ring, read health and spectrum cooldown without raw objects or tokens', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'still-runtime-diag-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const log = createRuntimeLog({sink: () => {}}); let reads = 0;
  for (let line = 0; line < 210; line++) log.record('poll-failed', {line, message: 'SECRET'});
  const service = createDiagnosticsService({dataDir: directory, getRuntimeLog: () => log.snapshot(),
    getSpectrumDiagnostics: () => ({consecutiveFailures: 4, coolingDown: true, retryInMs: 2000, childActive: false, reason: 'reader-cooldown', provider: 'SECRET'}),
    getSnapshot: () => {reads++; return {player: {connectionStatus: 'degraded', stale: true, consecutiveReadFailures: 2, lastGoodAt: '2026-11-01T00:00:00.000Z'},
      backend: {safeOwnedExit: {available: false, refused: true, code: 'STILL_BACKEND_OWNERSHIP_UNVERIFIED', selectionToken: 'SECRET', headers: 'SECRET', target: null}}};}});
  assert.deepEqual(await fs.readdir(directory), []); assert.equal(reads, 0);
  const saved = await service.exportSnapshot(), text = await fs.readFile(saved.filePath, 'utf8'), artifact = JSON.parse(text);
  assert.equal(reads, 1); assert.equal(artifact.runtimeLog.entries.length, 200); assert.equal(artifact.runtimeLog.entries[0].line, 10);
  assert.equal(artifact.runtimeLog.dropped, 10); assert.equal(artifact.spectrumTransport.retryInMs, 2000);
  assert.equal(artifact.snapshot.player.connectionStatus, 'degraded'); assert.equal(artifact.snapshot.player.stale, true);
  assert.equal(artifact.snapshot.backend.safeOwnedExit.code, 'STILL_BACKEND_OWNERSHIP_UNVERIFIED'); assert.equal(text.includes('SECRET'), false);
  await service.close();
});

test('only the backend never-ready ownership uncertainty requests abnormal startup exit', async () => {
  const getInfo = () => ({available: false, startupCreated: true, abnormalStartupExitRequired: true, nativeReadySeen: false, sessionId: null});
  const uncertain = Object.assign(new Error('SECRET'), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN', abnormalStartupExitRequired: true});
  await assert.rejects(initializeBackend({getInfo, initialize: async () => {throw uncertain;}}, {}), error => error === uncertain);
  const ordinary = Object.assign(new Error('offline'), {code: 'STILL_BACKEND_OWNERSHIP_UNVERIFIED', abnormalStartupExitRequired: false});
  assert.equal((await initializeBackend({getInfo, initialize: async () => {throw ordinary;}}, {})).available, false);
  for (const changed of [{startupCreated: false}, {available: true}, {sessionId: 'a previously READY session'}, {abnormalStartupExitRequired: false}, {nativeReadySeen: true}, {nativeReadySeen: undefined}]) {
    assert.equal(requiresAbnormalStartupExit({getInfo: () => ({...getInfo(), ...changed})}, uncertain), false);
  }
});

test('main preserves compatible split module exports and importing it installs no global failure handlers', () => {
  const before = [process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')];
  const main = require('../src/main/main'), ipc = require('../src/main/ipc-handlers'), smoke = require('../src/main/smoke'), network = require('../src/main/public-fetch');
  for (const name of ['createHandlers', 'invokeSafely', 'mapPlayer', 'safeCoverPath', 'isTrustedApplicationSender']) assert.equal(main[name], ipc[name]);
  assert.equal(main.runDesktopSmoke, smoke.runDesktopSmoke); assert.equal(main.createPublicFetchService, network.createPublicFetchService);
  assert.deepEqual([process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')], before);
});

test('library view applies one committed delta and status-only event without a full clone or persistent revision inflation', () => {
  const streamId = '11111111-2222-4333-8444-555555555555', view = createLibraryView();
  const tracks = Array.from({length: 20000}, (_, id) => ({id: String(id), path: `C:/fixture/${id}.flac`, subsong: 0, title: `Track ${id}`}));
  view.replace({tracks, revision: 10, status: {status: 'ready'}, eventCursors: {library: {streamId, sequence: 80}}});
  const before = view.tracks();
  const delta = {kind: 'library-delta', eventId: `library:${streamId}:81`, baseRevision: 10, revision: 11,
    tracks: [{...tracks[123], title: 'Changed'}], removedTrackIds: []};
  assert.equal(view.apply(delta), true); assert.equal(view.apply(delta), false);
  assert.equal(view.playerTracks({currentTrackId: '123'})[0].title, 'Changed');
  assert.equal(view.queueTracks({items: [{path: tracks[123].path, subsong: 0}]}).length, 1);
  const after = view.tracks(); assert.notEqual(after, before); assert.equal(after[124], before[124]);
  assert.equal(view.apply({kind: 'library-delta', eventId: `library:${streamId}:82`, baseRevision: 11, revision: 11,
    tracks: [], removedTrackIds: [], status: {status: 'read-only', readOnly: true}}), true);
  assert.equal(view.tracks(), after); assert.equal(view.summary().revision, 11); assert.equal(view.summary().status.readOnly, true);
  assert.deepEqual(view.snapshot().eventCursors.library, {streamId, sequence: 82});
  assert.equal(view.apply({...delta, eventId: 'library:99999999-2222-4333-8444-555555555555:83', baseRevision: 11, revision: 12}), false);
});

test('library replacement preserves monotonic revision/cursors and guards legacy async snapshots without adding protocol aliases', () => {
  const view = createLibraryView(), streamId = '11111111-2222-4333-8444-555555555555';
  const legacy = {tracks: [{id: 'a'}], revision: 1, status: {status: 'ready'}};
  assert.equal(view.replace(legacy), true);
  const expectedVersion = view.version();
  assert.equal(view.apply({kind: 'library-delta', baseRevision: 1, revision: 1, tracks: [], removedTrackIds: [], status: {status: 'read-only'}}), true);
  assert.equal(view.replace(legacy, {expectedVersion}), false); assert.equal(view.summary().status.status, 'read-only');
  assert.equal(view.replace({...legacy, eventCursors: {library: {streamId, sequence: 1}}}, {expectedVersion}), false);
  assert.equal(view.replace({...legacy, revision: 0}), false);
  // Legacy callers may still explicitly replace an unchanged view, and then
  // upgrade to the one authoritative production cursor schema.
  assert.equal(view.replace(legacy, {expectedVersion: view.version()}), true);
  assert.equal(view.replace({...legacy, eventCursors: {library: {streamId, sequence: 3}}}), true);
  assert.equal(view.replace({...legacy, revision: 999}), false);
  assert.equal(view.replace({...legacy, eventCursors: {library: {streamId, sequence: 2}}}), false);
  assert.equal(view.replace({...legacy, revision: 0, eventCursors: {library: {streamId, sequence: 99}}}), false);
  assert.equal(view.replace({...legacy, eventCursors: {library: {streamId: '99999999-2222-4333-8444-555555555555', sequence: 99}}}), false);
  assert.equal(view.replace({...legacy, status: {status: 'read-only'}, eventCursors: {library: {streamId, sequence: 4}}}), true);
  assert.equal(view.summary().revision, 1); assert.equal(view.summary().status.status, 'read-only');
  assert.deepEqual(view.snapshot().eventCursors, {library: {streamId, sequence: 4}});
});

test('runtime mutation replies preserve the broadcast delta event ID and avoid full snapshot decoration or duplicate emission', async () => {
  let snapshots = 0, decorations = 0, changedSettings;
  const delta = {kind: 'library-delta', eventId: 'library:11111111-2222-4333-8444-555555555555:2', baseRevision: 1, revision: 2,
    tracks: [{id: 'one', title: 'Changed'}], removedTrackIds: []};
  const emitted = [], h = createHandlers({library: {refresh: async () => delta}, foobar: {}, libraryReturnsDeltas: true,
    dialog: {showOpenDialog: async () => ({canceled: true, filePaths: []})}, window: () => ({}),
    getLibrarySnapshot: () => {snapshots++; throw new Error('Full snapshot is forbidden');},
    decorateLibrarySnapshot: () => {decorations++; throw new Error('Full decoration is forbidden');},
    decorateTrack: value => ({...value, coverUrl: 'still-cover://art/fixture.jpg'}),
    settings: {update: async () => ({onlineCovers: {musicBrainzContact: 'contact@example.test'}})}, onSettingsChanged: value => {changedSettings = value;},
    emit: (...row) => emitted.push(row)});
  const result = await h['library:refresh']({});
  assert.equal(result.eventId, delta.eventId); assert.equal(result.tracks.length, 1); assert.equal(snapshots, 0); assert.equal(decorations, 0); assert.deepEqual(emitted, []);
  assert.equal(await h['library:import']({kind: 'files'}), null); assert.equal(snapshots, 0);
  await h['settings:update']({patch: {onlineCovers: {musicBrainzContact: 'contact@example.test'}}});
  assert.equal(changedSettings.onlineCovers.musicBrainzContact, 'contact@example.test'); h.closePlaybackContext();
});

test('product entry installs one boundary before application imports and passes that same boundary to main.run', async () => {
  const vm = require('node:vm'), source = await fs.readFile(path.join(__dirname, '../src/main/entry.js'), 'utf8');
  const target = new EventEmitter(), log = createRuntimeLog({sink: () => {}}), mod = {exports: {}}, exits = [];
  let observed, loadCount = 0;
  const loader = name => {
    if (name === './runtime-log') return {createRuntimeLog: () => log,
      installRuntimeFailureHandlers: options => installRuntimeFailureHandlers({...options, processTarget: target, exit: code => exits.push(code)})};
    assert.equal(name, './main'); loadCount++;
    assert.equal(target.listenerCount('uncaughtException'), 1); assert.equal(target.listenerCount('unhandledRejection'), 1);
    return {run: async ({runtimeBoundary}) => {observed = runtimeBoundary;}};
  };
  vm.runInNewContext(source, {require: loader, module: mod, process: {versions: {}}});
  await mod.exports.launch(); assert.equal(loadCount, 1); assert.equal(observed.log, log);
  observed.failures.configure({onFatal: async () => {}}); target.emit('unhandledRejection', 'SECRET'); await observed.failures.completion();
  assert.deepEqual(exits, [1]); observed.failures.dispose();
});
