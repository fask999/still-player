'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {pathToFileURL} = require('node:url');
const {createHash} = require('node:crypto');
const backendModule = require('../src/main/backend');
const {createLibraryService} = require('../src/main/library');
const {createRuntimeLog, installRuntimeFailureHandlers, sanitizeRuntimeLog} = require('../src/main/runtime-log');
const {createRuntimePoll} = require('../src/main/runtime-poll');
const {createShutdownCoverGc} = require('../src/main/shutdown-cover-gc');
const {createSyntheticOwnedBackend} = require('./helpers/synthetic-owned-backend');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64');
const filename = bytes => `${createHash('sha256').update(bytes).digest('hex')}.png`;
const coverUrl = bytes => `still-cover://art/${filename(bytes)}`;
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const flush = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {if (Date.now() > deadline) throw new Error('Synthetic shutdown did not reach its expected state'); await flush();}
}

// Real main.run + real library GC + branded real-manager synthetic exit proof.
// Electron, networking, process creation, settings and Apple are DI boundaries.
async function mainFixture(t, {mode = 'owned', holdPlan = false, holdUnlink = false, failUnlink = false,
  failClose = false, failDrain = false, holdDrain = false, playerCover = '', budgetMs = 100, smoke = false, caught = false} = {}) {
  const root = await fs.mkdtemp(path.join(__dirname, '.tmp-shutdown-cover-gc-'));
  const dataDir = path.join(root, 'data'), coversDir = path.join(dataDir, 'covers');
  const owned = await createSyntheticOwnedBackend(t, {root: path.join(root, 'owned'), running: mode === 'adopted'});
  const calls = [], exits = [], intervals = new Map(), ipc = new Map(), operations = [];
  const planGate = deferred(), planEntered = deferred(), unlinkGate = deferred(), unlinkEntered = deferred(), drainGate = deferred();
  const log = createRuntimeLog({sink: () => {}});
  let mainWindow, library, options, timerId = 0, armed = false, deletes = 0, closes = 0, backendCloses = 0;
  const io = {...fs, async readdir(target, settings) {
    if (armed && target === coversDir && holdPlan) {calls.push('plan-entered'); planEntered.resolve(); await planGate.promise;}
    return fs.readdir(target, settings);
  }, async unlink(target) {
    if (armed && path.dirname(target) === coversDir) {
      deletes++; calls.push('unlink-entered'); unlinkEntered.resolve();
      if (holdUnlink) await unlinkGate.promise;
      if (failUnlink) throw new Error('RAW GC PATH SECRET');
    }
    return fs.unlink(target);
  }};
  const backend = {getInfo: () => {
    const info = owned.manager.getInfo();
    return mode === 'unknown' ? {...info, owned: false} : info;
  }, getSession: () => {
    const session = owned.manager.getSession();
    return mode === 'copied-session' && session ? {...session} : session;
  }, initialize: async () => backend.getInfo(), async close() {
    calls.push('backend-close'); backendCloses++;
    if (failClose && backendCloses === 1) throw new Error('RAW BACKEND SECRET');
    const result = await owned.manager.close();
    return mode === 'copied-proof' ? {...result, exitEvidence: {...result.exitEvidence}} : result;
  }, preparePaths: async () => ({}), getSafeOwnedExitTarget: () => ({available: false, refused: true})};
  const processTarget = new EventEmitter(); Object.assign(processTarget, {env: {STILL_DATA_DIR: dataDir, ...(smoke ? {STILL_SMOKE_TEST: '1'} : {})}, argv: ['node', 'entry.js', ...(smoke ? ['--smoke'] : [])],
    versions: {node: process.versions.node}, exit: code => exits.push(code)});
  const app = new EventEmitter(); Object.assign(app, {isPackaged: false, getPath: () => path.join(root, 'Still.exe'), setPath() {},
    requestSingleInstanceLock: () => true, whenReady: async () => {}, getVersion: () => '1.0.1', exit: code => exits.push(code),
    quit() {let prevented = false; app.emit('before-quit', {preventDefault() {prevented = true;}}); if (!prevented) calls.push('normal-exit');}});
  class Window extends EventEmitter {
    constructor() {super(); mainWindow = this; this.webContents = new EventEmitter(); this.webContents.mainFrame = {url: ''};
      Object.assign(this.webContents, {setWindowOpenHandler() {}, setAudioMuted() {}, send() {},
        session: {setPermissionRequestHandler() {}, setPermissionCheckHandler() {}}});}
    async loadFile(file) {this.webContents.mainFrame.url = pathToFileURL(file).href; if (caught) throw new Error('RAW CAUGHT STARTUP SECRET');}
    isDestroyed() {return false;} show() {} focus() {} isMinimized() {return false;}
  }
  const raw = new EventEmitter(); Object.assign(raw, {initializeHandoff: async () => {}, getHandoffStatus: () => null, connect: async () => ({available: true}),
    getState: async () => ({available: true, backendReachable: true, state: 'stopped', position: 0, duration: 0,
      currentTrack: playerCover ? {id: 'old-player-dto', coverUrl: playerCover} : null}), audioDetails: async () => ({}), capabilities: () => ({}),
    getAudioTransportStatus: () => ({}), transportStatus: () => ({}), sessionBound: () => mode !== 'adopted', cancelPending: async () => {},
    markBackendExited() {}, close: async () => {calls.push('raw-close'); if (holdDrain) await drainGate.promise;},
    beginShutdownWrites: () => ({stop: async () => {calls.push('shutdown-stop');}})});
  const apple = {getStatus: () => ({available: false, capabilities: {}}), getState: async () => ({available: false, state: 'unavailable'}),
    initialize: async () => {}, cancelPending: async () => {}, close: async () => {calls.push('apple-close');}};
  const native = {app, BrowserWindow: Window, ipcMain: {handle: (channel, fn) => ipc.set(channel, fn)},
    protocol: {registerSchemesAsPrivileged() {}, handle() {}, unhandle() {}}, net: {fetch() {throw new Error('No real native fetch');}},
    session: {fromPartition: () => ({fetch() {throw new Error('No real network');}, closeAllConnections: async () => {}})},
    dialog: {showErrorBox: () => calls.push('error-box')}, shell: {}, Menu: {setApplicationMenu() {}},
    screen: {getPrimaryDisplay: () => ({workAreaSize: {width: 1024, height: 768}})}, nativeTheme: {}};
  const overrides = {
    electron: native,
    'node:fs/promises': {mkdir: async () => {}, readFile: async () => {throw Object.assign(new Error('No build fixture'), {code: 'ENOENT'});}},
    './runtime-log': {createRuntimeLog: () => log, installRuntimeFailureHandlers: config => installRuntimeFailureHandlers({...config, processTarget})},
    './runtime-poll': {createRuntimePoll: config => createRuntimePoll({...config, setIntervalFn: fn => {intervals.set(++timerId, fn); return timerId;}, clearIntervalFn: id => intervals.delete(id)})},
    './shutdown-cover-gc': {...require('../src/main/shutdown-cover-gc'), createShutdownCoverGc: config => createShutdownCoverGc({...config, budgetMs})},
    './settings': {createSettingsService: () => ({initialize: async () => {}, get: () => ({onlineCovers: {}}), async close() {
      calls.push('settings-close'); if (failDrain) throw new Error('RAW DRAIN SECRET');
    }})},
    './library': {createLibraryService: config => {
      options = config; library = createLibraryService({...config, fileSystem: io, metadataParser: async () => ({common: {picture: [{data: PNG}]}})});
      const close = library.close, collect = library.collectCovers;
      library.close = async () => {closes++; calls.push('library-close'); await close(); calls.push('library-drained');};
      library.collectCovers = settings => {calls.push('gc-start'); const operation = collect(settings); operations.push(operation); return operation;};
      return library;
    }},
    './backend': {...backendModule, createBackendManager: () => backend}, './foobar': {createFoobarService: () => {throw new Error('Real bridge factory forbidden');}},
    './foobar-session': {createFoobarSessionService: () => raw}, './apple-music': {createOfficialAppleMusicService: () => apple},
    './apple-artwork': {createAppleArtworkService: () => ({urlFor: () => '', handleRequest: () => ({}), close: async () => {calls.push('artwork-drained');}})},
    './metadata-covers': {createMetadataCoverService: () => ({initialize: async () => {}, decorateTrack: value => value, forgetTracks() {},
      close: async () => {calls.push('metadata-drained');}})},
    './spectrum-client': {createSpectrumClient: () => ({getDiagnostics: () => ({}), dispose() {}}), DEFAULT_READER_PATH: 'SYNTHETIC'},
    './player-spectrum': {createPlayerSpectrumService: () => ({refresh() {}, read: async () => ({}), dispose() {calls.push('spectrum-dispose');}}), emptySpectrum: () => ({})},
    './lyrics': {createLyricsService: () => ({initialize: async () => {}, close: async () => {calls.push('lyrics-drained');}})},
    './qq-lyrics': {createQqLyricsClient: () => ({})},
    './smoke': {...require('../src/main/smoke'), runDesktopSmoke: async () => ({passed: true})}
  };
  const mainFile = path.resolve(__dirname, '../src/main/main.js'), source = await fs.readFile(mainFile, 'utf8'), mod = {exports: {}};
  const load = name => Object.hasOwn(overrides, name) ? overrides[name] : name.startsWith('./') ? require(path.resolve(path.dirname(mainFile), name)) : require(name);
  vm.runInNewContext(source, {module: mod, exports: mod.exports, require: load, __dirname: path.dirname(mainFile), process: processTarget,
    URL, Headers, Response, AbortController, Buffer, setTimeout, clearTimeout, setInterval, clearInterval}, {filename: mainFile});
  await mod.exports.run(); await flush();
  t.after(async () => {
    planGate.resolve(); unlinkGate.resolve(); drainGate.resolve();
    await Promise.allSettled(operations); await library?.close(); await owned.manager.close().catch(() => {});
    processTarget.removeAllListeners(); intervals.clear();
    assert.equal(path.dirname(root), path.resolve(__dirname)); assert.ok(path.basename(root).startsWith('.tmp-shutdown-cover-gc-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  const addCover = async bytes => {await fs.writeFile(path.join(coversDir, filename(bytes)), bytes);};
  return {root, dataDir, coversDir, calls, exits, operations, log, library, options, app, processTarget, intervals,
    arm: () => {armed = true;}, addCover, planEntered: planEntered.promise, unlinkEntered: unlinkEntered.promise,
    releasePlan: planGate.resolve, releaseUnlink: unlinkGate.resolve, releaseDrain: drainGate.resolve,
    deletes: () => deletes, closes: () => closes,
    invoke: (channel, payload = {}) => ipc.get(channel)({sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame}, payload)};
}

test('actual normal quit collects only after owned tree exit and every cover writer drains, preserving refs and the cached player URL', async t => {
  const playerBytes = Buffer.concat([PNG, Buffer.from('cached-player')]), orphan = Buffer.concat([PNG, Buffer.from('orphan')]);
  const f = await mainFixture(t, {playerCover: coverUrl(playerBytes), holdDrain: true});
  const track = path.join(f.root, 'referenced.wav'); await fs.writeFile(track, 'synthetic'); await f.library.importFiles([track]);
  await f.addCover(playerBytes); await f.addCover(orphan); await fs.writeFile(path.join(f.coversDir, 'user-photo.png'), PNG);
  f.arm(); f.app.quit(); await waitFor(() => f.calls.includes('library-drained'));
  assert.equal(f.operations.length, 0, 'one outstanding service drain blocks GC');
  f.releaseDrain(); await waitFor(() => f.calls.includes('normal-exit'));
  assert.equal(f.operations.length, 1); assert.equal(f.deletes(), 1);
  for (const event of ['backend-close', 'library-drained', 'metadata-drained', 'artwork-drained', 'lyrics-drained']) assert.ok(f.calls.indexOf(event) < f.calls.indexOf('gc-start'), event);
  assert.ok(f.calls.indexOf('gc-start') < f.calls.indexOf('spectrum-dispose'));
  for (const bytes of [PNG, playerBytes]) assert.deepEqual(await fs.readFile(path.join(f.coversDir, filename(bytes))), bytes);
  assert.deepEqual(await fs.readFile(path.join(f.coversDir, 'user-photo.png')), PNG);
  await assert.rejects(fs.access(path.join(f.coversDir, filename(orphan))), {code: 'ENOENT'});
});

test('a timed-out plan may resume after normal quit but its aborted operation never unlinks', async t => {
  const f = await mainFixture(t, {holdPlan: true}); await f.addCover(PNG); f.arm(); f.app.quit();
  await f.planEntered; await waitFor(() => f.calls.includes('normal-exit'));
  assert.deepEqual(f.operations[0].getState(), {phase: 'planning', pendingDeletes: 0, settled: false});
  assert.equal(f.deletes(), 0); assert.ok(f.log.snapshot().entries.some(row => row.event === 'cover-gc-expired'));
  const next = createLibraryService({dataDir: f.dataDir, metadataParser: async () => ({common: {picture: [{data: PNG}]}})});
  const track = path.join(f.root, 'new-session-reference.wav'); await fs.writeFile(track, 'synthetic'); await next.importFiles([track]);
  try {f.releasePlan(); await f.operations[0]; assert.equal(f.deletes(), 0);}
  finally {await next.close();}
  assert.deepEqual(await fs.readFile(path.join(f.coversDir, filename(PNG))), PNG);
});

test('a timed-out physical unlink keeps one read-only poll and diagnostics; retries observe the same operation until it really settles', async t => {
  const f = await mainFixture(t, {holdUnlink: true});
  await f.addCover(PNG); await f.addCover(Buffer.concat([PNG, Buffer.from('future')])); f.arm(); f.app.quit();
  await f.unlinkEntered; await waitFor(() => f.calls.includes('error-box'));
  const operation = f.operations[0]; assert.equal(operation.getState().pendingDeletes, 1); assert.equal(operation.getState().settled, false);
  assert.equal(f.calls.includes('normal-exit'), false); assert.equal(f.intervals.size, 1); assert.equal(f.calls.includes('spectrum-dispose'), false);
  assert.equal((await f.invoke('settings:update', {patch: {}})).ok, false);
  assert.equal((await f.invoke('app:exportDiagnostics')).ok, true);
  const firstCloses = f.closes(); f.app.quit(); await waitFor(() => f.calls.filter(value => value === 'error-box').length === 2);
  assert.equal(f.operations.length, 1); assert.equal(f.operations[0], operation); assert.equal(f.deletes(), 1);
  assert.equal(f.closes(), firstCloses); assert.equal(f.intervals.size, 1);
  f.releaseUnlink(); await operation; f.app.quit(); await waitFor(() => f.calls.includes('normal-exit'));
  assert.equal(f.operations.length, 1); assert.equal(f.deletes(), 1); assert.equal(f.closes(), firstCloses);
  assert.equal(operation.getState().pendingDeletes, 0); assert.equal(operation.getState().settled, true);
  assert.equal(f.calls.filter(value => value === 'normal-exit').length, 1); assert.equal(f.intervals.size, 0);
  assert.equal((await fs.readdir(f.coversDir)).length, 1);
});

for (const mode of ['adopted', 'unknown', 'copied-proof', 'copied-session']) test(`normal quit with ${mode} ownership or proof never starts GC`, async t => {
  const f = await mainFixture(t, {mode}); await f.addCover(PNG); f.arm(); f.app.quit(); await waitFor(() => f.calls.includes('normal-exit'));
  assert.equal(f.operations.length, 0); assert.equal(f.deletes(), 0);
});

for (const status of [{status: 'read-only', readOnly: true}, {status: 'recovered', recovered: true}]) test(`normal quit with ${status.status} library skips GC`, async t => {
  const f = await mainFixture(t); f.library.getStatus = () => status;
  await f.addCover(PNG); f.arm(); f.app.quit(); await waitFor(() => f.calls.includes('normal-exit')); assert.equal(f.operations.length, 0);
});

test('a prior normal shutdown failure permanently prevents a new GC on its later successful retry', async t => {
  const f = await mainFixture(t, {failClose: true}); await f.addCover(PNG); f.arm(); f.app.quit(); await waitFor(() => f.calls.includes('error-box'));
  f.app.quit(); await waitFor(() => f.calls.includes('normal-exit')); assert.equal(f.operations.length, 0); assert.equal(f.deletes(), 0);
});

test('a failed cover-writer drain does not start GC or dispose read services', async t => {
  const f = await mainFixture(t, {failDrain: true}); await f.addCover(PNG); f.arm(); f.app.quit(); await waitFor(() => f.calls.includes('error-box'));
  assert.equal(f.operations.length, 0); assert.equal(f.calls.includes('spectrum-dispose'), false); assert.equal(f.intervals.size, 1);
});

test('settled GC errors remain sanitized maintenance records and preserve successful normal quit', async t => {
  const f = await mainFixture(t, {failUnlink: true}); await f.addCover(PNG); f.arm(); f.app.quit(); await waitFor(() => f.calls.includes('normal-exit'));
  assert.equal(f.calls.includes('error-box'), false); assert.equal(f.operations.length, 1);
  const rows = f.log.snapshot().entries; assert.ok(rows.some(row => row.event === 'cover-gc-failed' && row.failures === 1));
  assert.equal(JSON.stringify(rows).includes('SECRET'), false); assert.equal(JSON.stringify(rows).includes(f.root), false);
});

test('fatal during a pending plan synchronously aborts future deletion and cannot resume normal quit', async t => {
  const f = await mainFixture(t, {holdPlan: true}); await f.addCover(PNG); f.arm(); f.app.quit(); await f.planEntered;
  f.processTarget.emit('uncaughtException', new Error('RAW FATAL SECRET')); f.releasePlan(); await f.operations[0];
  await waitFor(() => f.exits.includes(1)); assert.equal(f.calls.includes('normal-exit'), false); assert.equal(f.deletes(), 0);
});

test('caught startup cleanup and fatal cleanup never create a cover collection', async t => {
  const caught = await mainFixture(t, {caught: true}); assert.deepEqual(caught.exits, [1]); assert.equal(caught.operations.length, 0);
  const fatal = await mainFixture(t); fatal.processTarget.emit('uncaughtException', new Error('SECRET')); await waitFor(() => fatal.exits.includes(1));
  assert.equal(fatal.operations.length, 0);
});

test('caught-startup read-only recovery can later finish one normal user quit without starting GC', async t => {
  const f = await mainFixture(t, {caught: true, failClose: true});
  assert.deepEqual(f.exits, []); assert.equal(f.intervals.size, 1); assert.equal(f.calls.includes('error-box'), true);
  await f.addCover(PNG); f.arm(); f.app.quit(); await waitFor(() => f.calls.includes('normal-exit'));
  assert.equal(f.operations.length, 0); assert.equal(f.deletes(), 0); assert.equal(f.intervals.size, 0);
  assert.equal(f.calls.filter(value => value === 'normal-exit').length, 1);
});

test('read-only smoke quit never creates a cover collection', async t => {
  const f = await mainFixture(t, {smoke: true}); await waitFor(() => f.exits.length > 0); assert.equal(f.operations.length, 0);
});

test('GC logging retains only fixed events and bounded counters', () => {
  const log = createRuntimeLog({sink: () => {}});
  log.record('cover-gc-pending', {message: 'SECRET', path: 'C:/SECRET', collected: 2, pendingDeletes: 1, failures: 3});
  log.record('cover-gc-complete', {collected: Infinity, pendingDeletes: -1});
  const safe = sanitizeRuntimeLog(log.snapshot()); assert.equal(JSON.stringify(safe).includes('SECRET'), false);
  assert.equal(safe.entries[0].pendingDeletes, 1); assert.equal(safe.entries[0].collected, 2);
  assert.equal(Object.hasOwn(safe.entries[1], 'collected'), false); assert.equal(Object.hasOwn(safe.entries[1], 'pendingDeletes'), false);
});
