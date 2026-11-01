'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// Full main.run wiring with virtual Electron, IO and all service/process boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {EventEmitter} = require('node:events');
const runtime = require('../src/main/runtime-log');
const {createRuntimePoll} = require('../src/main/runtime-poll');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, {startupUncertain = false, failNormalClose = true, loadFailure = false, lateReadyOnClose = false, resetLibrary = false, initialTracks = []} = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'still-main-runtime-'));
  t.after(() => fs.rm(dataDir, {recursive: true, force: true}));
  const calls = [], exits = [], ipc = new Map(), intervals = new Map(); let timerId = 0, mainWindow, failedStartup = false, closed = false, backendCloseCount = 0,
    nativeReadySeen = !startupUncertain;
  const processTarget = new EventEmitter(); Object.assign(processTarget, {env: {STILL_DATA_DIR: dataDir}, argv: ['node', 'entry.js', ...(resetLibrary ? ['--reset-library'] : [])], versions: {node: process.versions.node}, exit: code => exits.push(code)});
  const app = new EventEmitter(); Object.assign(app, {isPackaged: false, getPath: () => path.join(dataDir, 'Still.exe'), setPath() {},
    requestSingleInstanceLock: () => true, whenReady: async () => {}, getVersion: () => '1.0.1', exit: code => exits.push(code),
    quit() {let prevented = false; app.emit('before-quit', {preventDefault() {prevented = true;}}); if (!prevented) calls.push('normal-exit');}});
  class Window extends EventEmitter {
    constructor(options) {
      super(); mainWindow = this; this.options = options;
      this.webContents = new EventEmitter(); this.webContents.mainFrame = {url: ''};
      Object.assign(this.webContents, {setWindowOpenHandler: fn => {this.open = fn;}, setAudioMuted() {},
        send: (event, value) => calls.push({event, value}), session: {setPermissionRequestHandler() {}, setPermissionCheckHandler() {}}});
    }
    async loadFile(file) {this.webContents.mainFrame.url = pathToFileURL(file).href; if (loadFailure) throw new Error('Caught window load error');}
    isDestroyed() {return false;} show() {} focus() {} isMinimized() {return false;}
  }
  const getInfo = () => ({available: !startupUncertain && !closed, owned: true, managed: true, status: closed ? 'closed' : failedStartup ? 'failed' : 'ready',
    startupCreated: failedStartup, abnormalStartupExitRequired: failedStartup && !nativeReadySeen, nativeReadySeen, sessionId: failedStartup ? null : 'previously-ready-session',
    foobarDir: path.join(dataDir, 'backend'), baseUrl: startupUncertain ? null : 'http://127.0.0.1:18880/api/'});
  const startupError = Object.assign(new Error('RAW STARTUP SECRET'), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN', abnormalStartupExitRequired: true});
  const backend = {getInfo, getSession: () => null, async initialize() {if (startupUncertain) {failedStartup = true; throw startupError;} return getInfo();},
    async close() {calls.push('backend-close'); backendCloseCount++; if (failedStartup) {if (lateReadyOnClose) nativeReadySeen = true; throw startupError;}
      if (failNormalClose && backendCloseCount === 1) throw new Error('RAW EXIT SECRET'); closed = true; return {exitEvidence: {fixture: true}};},
    preparePaths: async () => ({}), getSafeOwnedExitTarget: () => ({available: false, refused: true, code: 'STILL_BACKEND_OWNERSHIP_UNVERIFIED', selectionToken: null, target: null})};
  const raw = new EventEmitter();
  Object.assign(raw, {initializeHandoff: async () => {}, getHandoffStatus: () => null, connect: async () => ({available: true}),
    getState: async () => ({available: !closed && !startupUncertain, backendReachable: !closed && !startupUncertain, state: closed ? 'unavailable' : 'stopped', position: 0, duration: 0}),
    audioDetails: async () => ({}), capabilities: () => ({}), getAudioTransportStatus: () => ({}), transportStatus: () => ({}),
    sessionBound: () => true, cancelPending: async () => {}, stop: async () => {calls.push('shutdown-stop');},
    markBackendExited() {}, close: async () => {calls.push('raw-close');}, beginShutdownWrites: () => ({stop: async () => {calls.push('shutdown-stop');}})});
  const apple = {getStatus: () => ({available: false, capabilities: {}}), getState: async () => ({available: false, state: 'unavailable'}),
    initialize: async () => {}, cancelPending: async () => {}, close: async () => {calls.push('apple-close');}};
  const libraryStream = '11111111-2222-4333-8444-555555555555';
  const snapshot = {tracks: initialTracks, playlists: [], folders: [], revision: 4, status: {status: 'ready'}, eventCursors: {library: {streamId: libraryStream, sequence: 7}}};
  let libraryOptions, metadataOptions, initializationOptions, listOverride = null, settingsValue = {onlineCovers: {musicBrainzContact: ''}};
  const library = {initialize: async options => {initializationOptions = options;}, list: () => listOverride ? listOverride() : snapshot,
    getTracks: ids => snapshot.tracks.filter(track => ids.includes(track.id)), close: async () => {calls.push('library-close');}};
  const native = {app, BrowserWindow: Window, ipcMain: {handle: (channel, fn) => ipc.set(channel, fn)},
    protocol: {registerSchemesAsPrivileged() {}, handle() {}, unhandle() {}}, net: {fetch() {throw new Error('No native fetch allowed');}},
    session: {fromPartition: () => ({fetch() {throw new Error('No network allowed');}, closeAllConnections: async () => {}})},
    dialog: {showErrorBox: () => calls.push('error-box')}, shell: {}, Menu: {setApplicationMenu() {}}, screen: {getPrimaryDisplay: () => ({workAreaSize: {width: 1024, height: 768}})}, nativeTheme: {}};
  const overrides = {
    electron: native,
    'node:fs/promises': {mkdir: async () => {}, readFile: async () => {throw Object.assign(new Error('No build fixture'), {code: 'ENOENT'});}},
    './runtime-log': {...runtime, createRuntimeLog: () => runtime.createRuntimeLog({sink: () => {}}),
      installRuntimeFailureHandlers: options => runtime.installRuntimeFailureHandlers({...options, processTarget})},
    './runtime-poll': {createRuntimePoll: options => createRuntimePoll({...options, setIntervalFn: fn => {intervals.set(++timerId, fn); return timerId;}, clearIntervalFn: id => intervals.delete(id)})},
    './settings': {createSettingsService: () => ({initialize: async () => {}, get: () => settingsValue, update: async patch => {settingsValue = {...settingsValue, ...patch}; return settingsValue;}, close: async () => {calls.push('settings-close');}})},
    './library': {createLibraryService: options => {libraryOptions = options; return library;}}, './foobar': {createFoobarService: () => {throw new Error('Real bridge factory forbidden');}},
    './backend': {createBackendManager: () => backend}, './foobar-session': {createFoobarSessionService: () => raw},
    './apple-music': {createOfficialAppleMusicService: () => apple},
    './apple-artwork': {createAppleArtworkService: () => ({urlFor: () => '', handleRequest: () => ({}), close: async () => {}})},
    './metadata-covers': {createMetadataCoverService: options => {metadataOptions = options; return {initialize: async () => {}, decorateTrack: value => value,
      forgetTracks: ids => calls.push({forgot: ids}), setContact: contact => calls.push({contact}), close: async () => {}};}},
    './spectrum-client': {createSpectrumClient: () => ({getDiagnostics: () => ({}), dispose() {}}), DEFAULT_READER_PATH: 'SYNTHETIC'},
    './player-spectrum': {createPlayerSpectrumService: () => ({refresh() {}, read: async () => ({}), dispose() {calls.push('spectrum-dispose');}}), emptySpectrum: () => ({})},
    './lyrics': {createLyricsService: () => ({initialize: async () => {}, close: async () => {}})}, './qq-lyrics': {createQqLyricsClient: () => ({})}
  };
  const mainFile = path.resolve(__dirname, '../src/main/main.js'), source = await fs.readFile(mainFile, 'utf8'), mod = {exports: {}};
  const load = name => Object.hasOwn(overrides, name) ? overrides[name] : name.startsWith('./') ? require(path.resolve(path.dirname(mainFile), name)) : require(name);
  vm.runInNewContext(source, {module: mod, exports: mod.exports, require: load, __dirname: path.dirname(mainFile), process: processTarget,
    URL, Headers, Response, AbortController, Buffer, setTimeout, clearTimeout, setInterval, clearInterval}, {filename: mainFile});
  const running = mod.exports.run(); await running; await flush();
  t.after(() => {
    processTarget.removeAllListeners(); intervals.clear();
  });
  const invoke = (channel, payload = {}) => ipc.get(channel)({sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame}, payload);
  return {app, processTarget, calls, exits, intervals, invoke, mainWindow, libraryOptions, metadataOptions, initializationOptions, snapshot, libraryStream,
    setLibraryList: read => {listOverride = read;}};
}

test('actual main.run normal READY quit failure never exits, preserves manual diagnostics and a single read-only timer', async t => {
  const f = await fixture(t); assert.equal(f.intervals.size, 1);
  f.app.quit(); await flush(); await flush();
  assert.deepEqual(f.exits, []); assert.equal(f.intervals.size, 1);
  assert.equal(f.calls.includes('spectrum-dispose'), false); assert.equal(f.calls.includes('raw-close'), false);
  const denied = await f.invoke('settings:update', {patch: {}}); assert.equal(denied.ok, false); assert.match(denied.error, /只读/);
  const diagnostics = await f.invoke('app:exportDiagnostics', {}); assert.equal(diagnostics.ok, true);
  const raw = await fs.readFile(diagnostics.value.filePath, 'utf8'); assert.equal(raw.includes('SECRET'), false);
  const artifact = JSON.parse(raw); assert.equal(artifact.runtimeLog.entries.at(-1).event, 'shutdown-failed');
  const state = await f.invoke('player:state'); assert.equal(state.value.controlsReady, false); assert.match(state.value.error, /只读/);
  f.app.quit(); await flush(); await flush();
  assert.deepEqual(f.exits, []); assert.equal(f.intervals.size, 0); assert.equal(f.calls.includes('normal-exit'), true);
  assert.equal(f.calls.includes('spectrum-dispose'), true);
});

test('actual main.run true fatal failure gates controls immediately and exits nonzero even after READY cleanup fails', async t => {
  const f = await fixture(t); f.processTarget.emit('uncaughtException', new Error('SECRET'));
  assert.equal(f.intervals.size, 0);
  assert.equal((await f.invoke('settings:update', {patch: {}})).ok, false);
  await flush(); await flush(); assert.deepEqual(f.exits, [1]);
});

test('actual main.run created never-READY uncertainty exits abnormally rather than keeping an unusable startup alive', async t => {
  const f = await fixture(t, {startupUncertain: true}); await flush(); await flush();
  assert.deepEqual(f.exits, [1]); assert.equal(f.intervals.size, 0); assert.equal(f.calls.includes('normal-exit'), false);
});

test('actual main.run caught startup failure after native READY keeps a failed graceful close read-only without abnormal exit', async t => {
  const f = await fixture(t, {loadFailure: true});
  assert.deepEqual(f.exits, []); assert.equal(f.intervals.size, 1); assert.equal(f.calls.includes('spectrum-dispose'), false);
  assert.equal((await f.invoke('settings:update', {patch: {}})).ok, false);
  assert.equal((await f.invoke('app:exportDiagnostics', {})).ok, true);
});

test('actual main.run rechecks late native READY during caught startup cleanup and revokes abnormal exit', async t => {
  const f = await fixture(t, {startupUncertain: true, lateReadyOnClose: true}); await flush(); await flush();
  assert.deepEqual(f.exits, []); assert.equal(f.intervals.size, 1); assert.equal(f.calls.includes('spectrum-dispose'), false);
  assert.equal((await f.invoke('settings:update', {patch: {}})).ok, false);
  assert.equal((await f.invoke('app:exportDiagnostics', {})).ok, true);
});

test('actual main.run wires explicit reset, library deltas, fixed metadata cursors, removal invalidation and configured contact', async t => {
  const f = await fixture(t, {resetLibrary: true, initialTracks: [{id: 'one', path: 'C:/fixture.wav', subsong: 0, title: 'Fixture'}]});
  assert.equal(f.libraryOptions.returnDeltas, true); assert.equal(typeof f.libraryOptions.onDelta, 'function'); assert.equal(f.libraryOptions.onUpdate, undefined);
  assert.equal(f.initializationOptions.reset, true); assert.equal(f.metadataOptions.contact, '');
  await f.metadataOptions.onChange({trackIds: ['one']});
  const patch = f.calls.filter(row => row.event === 'library').at(-1).value;
  assert.equal(patch.kind, 'library-delta'); assert.match(patch.eventId, /^metadata:[a-f0-9-]{36}:1$/);
  assert.equal(patch.baseRevision, 4); assert.equal(patch.revision, 4); assert.equal(patch.tracks.length, 1); assert.equal(patch.trackIds, undefined);
  const bootstrap = (await f.invoke('app:bootstrap')).value;
  assert.deepEqual(bootstrap.library.eventCursors.library, {streamId: f.libraryStream, sequence: 7});
  assert.equal(bootstrap.library.eventCursors.metadata.sequence, 1);
  assert.equal(patch.eventId, `metadata:${bootstrap.library.eventCursors.metadata.streamId}:1`);
  const delta = {kind: 'library-delta', eventId: `library:${f.libraryStream}:8`, baseRevision: 4, revision: 5,
    tracks: [], removedTrackIds: ['one'], trackIds: [], status: {status: 'ready'}};
  f.snapshot.tracks = []; f.snapshot.revision = 5; f.snapshot.eventCursors.library.sequence = 8;
  f.libraryOptions.onDelta(delta); assert.deepEqual(f.calls.find(row => row.forgot).forgot, ['one']);
  const count = f.calls.filter(row => row.event === 'library').length;
  f.libraryOptions.onDelta(delta); await f.metadataOptions.onChange({trackIds: ['one']});
  assert.equal(f.calls.filter(row => row.event === 'library').length, count);
  assert.equal((await f.invoke('settings:update', {patch: {onlineCovers: {musicBrainzContact: 'contact@example.test'}}})).ok, true);
  assert.equal(f.calls.find(row => row.contact).contact, 'contact@example.test');
  const next = (await f.invoke('app:bootstrap')).value;
  assert.equal(next.library.eventCursors.metadata.streamId, bootstrap.library.eventCursors.metadata.streamId);
  assert.equal(next.library.eventCursors.metadata.sequence, 1);
});

for (const update of ['persistent-revision', 'same-revision-status']) test(`actual main.run retains a newer ${update} delta when an older list snapshot resumes after the await`, async t => {
  const f = await fixture(t, {initialTracks: [{id: 'a', path: 'C:/a.flac', subsong: 0}]});
  const oldSnapshot = structuredClone(f.snapshot);
  const delta = {kind: 'library-delta', eventId: `library:${f.libraryStream}:8`, baseRevision: 4,
    revision: update === 'persistent-revision' ? 5 : 4, tracks: update === 'persistent-revision' ? [{id: 'b', path: 'C:/b.flac', subsong: 0}] : [],
    removedTrackIds: [], status: update === 'persistent-revision' ? {status: 'ready'} : {status: 'read-only', readOnly: true}};
  f.setLibraryList(() => {
    // list captures the old source snapshot; its queued delta wins the microtask
    // race before main's await continuation attempts to replace the live view.
    queueMicrotask(() => f.libraryOptions.onDelta(delta));
    return oldSnapshot;
  });
  const result = await f.invoke('library:list'); assert.equal(result.ok, true);
  assert.equal(result.value.revision, delta.revision);
  assert.equal(result.value.eventCursors.library.sequence, 8);
  assert.equal(result.value.tracks.map(track => track.id).join(','), update === 'persistent-revision' ? 'a,b' : 'a');
  assert.equal(result.value.status.readOnly, update === 'persistent-revision' ? undefined : true);
  // Another stale explicit resync response must return that same newer view.
  f.setLibraryList(async () => oldSnapshot);
  const again = await f.invoke('library:list'); assert.equal(again.value.eventCursors.library.sequence, 8);
  assert.equal(again.value.revision, delta.revision); assert.equal(again.value.status.readOnly, result.value.status.readOnly);
});
