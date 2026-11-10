'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// Full main.run wiring with virtual Electron, IO and all service/process boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {pathToFileURL} = require('node:url');
const {EventEmitter} = require('node:events');
const runtime = require('../src/main/runtime-log');
const {createRuntimePoll} = require('../src/main/runtime-poll');
const {isVerifiedBackendSession} = require('../src/main/backend');
const {createSyntheticOwnedBackend} = require('./helpers/synthetic-owned-backend');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, {startupUncertain = false, failNormalClose = true, loadFailure = false, lateReadyOnClose = false, resetLibrary = false,
  initialTracks = [], firstBridgeReadFails = false, uncertainControl = false, publicMode = false, publicAutomatic = false,
  publicPrepared = false, foobarOverride = false, invalidDesktopPin = false, holdCueClose = false, dacEnabled = false,
  dacDialog = async () => ({response: 0}), ownsBackend = true, failCueGuardClose = false, fastStartupDrain = false} = {}) {
  const {root: dataDir, parent: tempParent} = createCanonicalTemp('still-main-runtime-');
  t.after(async () => {assert.equal(path.dirname(dataDir), tempParent); assert.ok(path.basename(dataDir).startsWith('still-main-runtime-')); await fs.rm(dataDir, {recursive: true, force: true});});
  const calls = [], exits = [], ipc = new Map(), intervals = new Map(), desktopObservations = {players: [], sources: [], settings: []}; let timerId = 0, mainWindow, failedStartup = false, closed = false, backendCloseCount = 0, desktopOptions,
    nativeReadySeen = !startupUncertain;
  let cueOptions, cueClosing = null, releaseCueClose;
  const dacCalls = [], dacPrompts = []; let dacOptions;
  const recoveryShown = Promise.withResolvers();
  const cueRequests = [], cueCloseGate = new Promise(resolve => {releaseCueClose = resolve;});
  if (!holdCueClose) releaseCueClose();
  t.after(() => releaseCueClose());
  const recoveryBackend = firstBridgeReadFails ? await createSyntheticOwnedBackend(t) : null;
  const backendSession = recoveryBackend?.session || null;
  let selectedSession = backendSession, boundSession = null, pendingRestore = false, bridgeHealthy = !firstBridgeReadFails, rawOptions, backendAvailable = true,
    backendOptions, setupPrepared = publicPrepared, setupReady = false, backendInitializationOptions;
  const readLocalState = async () => {
    calls.push('local-read');
    const available = bridgeHealthy && !closed && !startupUncertain;
    const state = {available, backendReachable: available, connectionStatus: available ? 'connected' : 'offline',
      controlUncertain: uncertainControl, state: available ? 'stopped' : 'unavailable', position: 0, duration: 0,
      ...(!available ? {error: 'Synthetic initial GET failure', code: 'STILL_HTTP_READ_FAILED'} : {})};
    rawOptions?.onUpdate(state); return state;
  };
  const processTarget = new EventEmitter(); Object.assign(processTarget, {env: {STILL_DATA_DIR: dataDir, ...(foobarOverride ? {STILL_FOOBAR_DIR: 'C:\\OriginalNeverUse'} : {})}, argv: ['node', 'entry.js', ...(resetLibrary ? ['--reset-library'] : [])], versions: {node: process.versions.node}, exit: code => exits.push(code)});
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
  const getInfo = () => ({available: backendAvailable && !startupUncertain && !closed, owned: ownsBackend, managed: true, status: closed ? 'closed' : failedStartup ? 'failed' : 'ready',
    startupCreated: failedStartup, abnormalStartupExitRequired: failedStartup && !nativeReadySeen, nativeReadySeen,
    sessionId: failedStartup ? null : backendSession?.sessionId || 'previously-ready-session', pid: backendSession?.pid,
    foobarDir: backendSession?.foobarDir || path.join(dataDir, 'backend'), baseUrl: startupUncertain ? null : backendSession?.baseUrl || 'http://127.0.0.1:18880/api/'});
  const startupError = Object.assign(new Error('RAW STARTUP SECRET'), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN', abnormalStartupExitRequired: true});
  const backend = {getInfo, getSession: () => selectedSession, async initialize(options) {backendInitializationOptions = options; calls.push('backend-initialize'); if (startupUncertain) {failedStartup = true; throw startupError;} return getInfo();},
    async close() {calls.push('backend-close'); backendCloseCount++; if (failedStartup) {if (lateReadyOnClose) nativeReadySeen = true; throw startupError;}
      if (failNormalClose && backendCloseCount === 1) throw new Error('RAW EXIT SECRET'); closed = true; return {exitEvidence: {fixture: true}};},
    preparePaths: async () => ({}), getSafeOwnedExitTarget: () => ({available: false, refused: true, code: 'STILL_BACKEND_OWNERSHIP_UNVERIFIED', selectionToken: null, target: null})};
  const raw = new EventEmitter();
  Object.assign(raw, {initializeHandoff: async () => {}, getHandoffStatus: () => pendingRestore ? {pendingRestore: true} : null,
    connect: async () => {calls.push('local-connect'); boundSession = selectedSession; return readLocalState();}, getState: readLocalState,
    canReadSession: session => Boolean(session && session === boundSession),
    audioDetails: async () => ({}), outputs: async () => {calls.push('local-output-read'); return {outputs: []};},
    selectOutput: async () => {calls.push('output-select'); return {};},
    capabilities: () => ({playback: bridgeHealthy && !uncertainControl}), getAudioTransportStatus: () => ({}), transportStatus: () => ({controlUncertain: uncertainControl}),
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
    dialog: {showErrorBox: title => {calls.push('error-box'); if (title === 'STILL 启动未完成') recoveryShown.resolve();},
      showMessageBox: (owner, options) => {dacPrompts.push({owner, options}); return dacDialog(options);}},
    ...(dacEnabled ? {safeStorage: {isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`synthetic:${value}`), decryptString: bytes => bytes.toString().slice(10)}} : {}),
    shell: {}, Menu: {setApplicationMenu() {}}, screen: {getPrimaryDisplay: () => ({workAreaSize: {width: 1024, height: 768}})}, nativeTheme: {}, nativeImage: {createFromBuffer() {throw new Error('No image decoding in main wiring fixture');}}};
  const overrides = {
    electron: native,
    './cue-inspector': {createCueInspector: options => {
      cueOptions = options;
      return {inspect(request) {if (cueClosing) return Promise.reject(new Error('Synthetic inspector closed')); cueRequests.push(request); return Promise.resolve({verified: true, items: [{path: request.path, subsong: 7, supported: true, title: 'SYNTHETIC CUE fixture'}]});},
        close() {if (!cueClosing) {calls.push('cue-close'); cueClosing = cueCloseGate.then(() => {calls.push('cue-closed');});} return cueClosing;}};
    }},
    './backend-job': {readDesktopMediaRuntimeAssets: async () => {if (invalidDesktopPin) throw Object.assign(new Error('Fixture pin mismatch'), {code: 'STILL_DESKTOP_RUNTIME_ASSET_UNVERIFIED'}); return {desktopMediaManifest: {sha256: 'a'.repeat(64)}};}},
    './desktop-artwork': {createDesktopArtworkReader: () => async () => null},
    './desktop-integration': {desktopWindowOptions: () => ({options: {width: 1024, height: 768}}), createDesktopIntegration: options => {
      desktopOptions = options; let shutdown = null;
      return {restoreWindow() {calls.push('desktop-restore');}, observePlayer: value => desktopObservations.players.push(value),
        observeSources: value => desktopObservations.sources.push(value), observeSettings: value => desktopObservations.settings.push(value),
        handlers: {'desktop:status': () => ({available: !shutdown, readOnly: Boolean(shutdown)}), 'desktop:sleepTimer:set': () => ({}), 'desktop:sleepTimer:cancel': () => ({})},
        beginShutdown() {if (!shutdown) {calls.push('desktop-shutdown'); shutdown = Promise.resolve();} return shutdown;}};
    }},
    './public-installation': {readPublicInstallation: async () => publicMode ? {backendBootstrapManifest: 'manifests/public-backend.json'} : null,
      assertPublicDataPaths: async () => {calls.push('public-path-check');},
      publicInstallationPaths: () => ({dataDir, backendDir: path.join(dataDir, 'backend/foobar2000')})},
    './backend-bootstrap': {createBackendBootstrap: () => ({initialize: async () => {calls.push('setup-initialize');},
      getExpectedFiles: () => [],
      getStatus: () => ({prepared: setupPrepared, ready: setupReady, required: !setupReady, automatic: publicAutomatic, state: setupReady ? 'ready' : setupPrepared ? 'prepared' : 'setup-required'}),
      begin: async () => {calls.push('setup-begin');}, complete: async () => {setupPrepared = true; calls.push('setup-prepared');},
      markReady() {setupReady = true; calls.push('setup-ready');}, cancel: () => ({}), close: async () => {calls.push('setup-close');}})},
    'node:fs/promises': {mkdir: async () => {}, readFile: async () => {throw Object.assign(new Error('No build fixture'), {code: 'ENOENT'});}},
    './runtime-log': {...runtime, createRuntimeLog: () => runtime.createRuntimeLog({sink: () => {}}),
      installRuntimeFailureHandlers: options => runtime.installRuntimeFailureHandlers({...options, processTarget})},
    './runtime-poll': {createRuntimePoll: options => createRuntimePoll({...options, setIntervalFn: fn => {intervals.set(++timerId, fn); return timerId;}, clearIntervalFn: id => intervals.delete(id)})},
    './settings': {createSettingsService: () => ({initialize: async () => {}, get: () => settingsValue, update: async patch => {settingsValue = {...settingsValue, ...patch}; return settingsValue;}, close: async () => {calls.push('settings-close');}})},
    './library': {createLibraryService: options => {libraryOptions = options; return library;}}, './foobar': {createFoobarService: () => {throw new Error('Real bridge factory forbidden');}},
    './backend': {createBackendManager: options => {backendOptions = options; return backend;}, isVerifiedBackendSession},
    './foobar-session': {createFoobarSessionService: options => {rawOptions = options; return raw;}},
    './apple-music': {createOfficialAppleMusicService: () => apple},
    './apple-artwork': {createAppleArtworkService: () => ({urlFor: () => '', handleRequest: () => ({}), close: async () => {}})},
    './metadata-covers': {createMetadataCoverService: options => {metadataOptions = options; return {initialize: async () => {}, decorateTrack: value => value,
      forgetTracks: ids => calls.push({forgot: ids}), setContact: contact => calls.push({contact}), close: async () => {}};}},
    './spectrum-client': {createSpectrumClient: () => ({getDiagnostics: () => ({}), dispose() {}}), DEFAULT_READER_PATH: 'SYNTHETIC'},
    './player-spectrum': {createPlayerSpectrumService: () => ({refresh() {}, read: async () => ({}), dispose() {calls.push('spectrum-dispose');}}), emptySpectrum: () => ({})},
    './lyrics': {createLyricsService: () => ({initialize: async () => {}, close: async () => {}})}, './qq-lyrics': {createQqLyricsClient: () => ({})}
  };
  if (failCueGuardClose) overrides['./cue-playback-guard'] = {createCuePlaybackGuard: () => ({
    beginShutdown() {calls.push('cue-guard-quiesce');}, async close() {calls.push('cue-guard-unverified'); throw new Error('SYNTHETIC HOLDER EXIT UNVERIFIED');}
  })};
  if (dacEnabled) overrides['./dac-authorization'] = {createDacAuthorizationService(options) {
    dacOptions = options;
    const preview = {capabilities: ['exclusive-check'], validationFormat: {sampleRate: 48000, bits: 24, channels: 2}}, grant = {authorizationId: '11111111-1111-4111-8111-111111111111'};
    let challenge, sequence = 0;
    return {invalidate() {challenge = null; dacCalls.push(['invalidate']);}, list: () => [],
      prepare(input, caller) {
        dacCalls.push(['prepare', input, caller]);
        challenge = {token: Buffer.alloc(32, ++sequence).toString('base64url'), preview: {...preview, scope: input.scope}, caller};
        return {token: challenge.token, preview: challenge.preview, expiresAt: 90000};
      },
      async confirm(input, caller) {
        dacCalls.push(['confirm', input, caller]);
        const bound = challenge;
        if (!bound || bound.token !== input.token || bound.caller.sender !== caller.sender || bound.caller.windowGeneration !== caller.windowGeneration) throw new Error('Synthetic confirmation expired');
        challenge = null;
        if (!await options.confirmUser(bound.preview, caller)) throw new Error('Synthetic confirmation declined');
        return {...grant, scope: bound.preview.scope};
      },
      revoke() {return {revoked: true};}, issueUsePermit(input) {dacCalls.push(['issue', input]); return Promise.resolve({syntheticPermit: true});},
      consumeUsePermit(permit, input) {dacCalls.push(['consume', input, permit]); return {syntheticAuthorization: true};}};
  }};
  const mainFile = path.resolve(__dirname, '../src/main/main.js'), source = await fs.readFile(mainFile, 'utf8'), mod = {exports: {}};
  const load = name => Object.hasOwn(overrides, name) ? overrides[name] : name.startsWith('./') ? require(path.resolve(path.dirname(mainFile), name)) : require(name);
  vm.runInNewContext(source, {module: mod, exports: mod.exports, require: load, __dirname: path.dirname(mainFile), process: processTarget,
    URL, Headers, Response, AbortController, Buffer, setTimeout: fastStartupDrain ? (fn, ms) => setTimeout(fn, ms === 10000 ? 20 : ms) : setTimeout,
    clearTimeout, setInterval, clearInterval}, {filename: mainFile});
  const running = mod.exports.run(); await running; await flush();
  t.after(() => {
    processTarget.removeAllListeners(); intervals.clear();
  });
  const invoke = (channel, payload = {}, event = {sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame}) => ipc.get(channel)(event, payload);
  return {app, processTarget, calls, exits, intervals, invoke, mainWindow, libraryOptions, metadataOptions, initializationOptions, snapshot, libraryStream, desktopOptions, desktopObservations, cueOptions, cueRequests, releaseCueClose, dacCalls, dacPrompts, dacOptions,
    recoveryShown: recoveryShown.promise,
    setLibraryList: read => {listOverride = read;}, setBridgeHealthy: value => {bridgeHealthy = value;},
    setBoundSession: value => {boundSession = value;}, setSelectedSession: value => {selectedSession = value;},
    setPendingRestore: value => {pendingRestore = value;}, setBackendAvailable: value => {backendAvailable = value;}, backendSession, backendOptions,
    getBackendInitializationOptions: () => backendInitializationOptions};
}

test('actual main DAC IPC binds the trusted main frame and invalidates a pending native confirmation on reload', async t => {
  const gate = Promise.withResolvers(), f = await fixture(t, {publicMode: true, dacEnabled: true, dacDialog: () => gate.promise});
  assert.ok(f.dacOptions); assert.equal((await f.invoke('app:bootstrap')).value.capabilities.dacAuthorization, true);
  const payload = {scope: 'windows-endpoint', capabilities: ['exclusive-check'], validationFormat: {sampleRate: 48000, bits: 24, channels: 2}};
  const foreignFrame = {sender: f.mainWindow.webContents, senderFrame: {...f.mainWindow.webContents.mainFrame}};
  assert.equal((await f.invoke('dac:prepare', payload, foreignFrame)).ok, false);
  assert.equal((await f.invoke('dac:prepare', {...payload, windowGeneration: 3})).ok, false);
  assert.equal(f.dacCalls.some(row => row[0] === 'prepare'), false);
  const challenge = await f.invoke('dac:prepare', payload), prepare = f.dacCalls.find(row => row[0] === 'prepare');
  assert.equal(challenge.ok, true); assert.equal(challenge.value.preview.scope, payload.scope);
  assert.equal(prepare[2].sender, f.mainWindow.webContents); assert.ok(Number.isSafeInteger(prepare[2].windowGeneration));
  assert.equal((await f.invoke('dac:confirm', {token: challenge.value.token, scope: 'hardware-instance'})).ok, false);
  assert.equal(f.dacCalls.some(row => row[0] === 'confirm'), false);
  assert.equal((await f.invoke('dac:confirm', {token: 'z'.repeat(43)})).ok, false);
  assert.equal(f.dacPrompts.length, 0);
  const confirming = f.invoke('dac:confirm', {token: challenge.value.token}); await flush();
  assert.equal(f.dacPrompts.length, 1); assert.equal(f.dacPrompts[0].owner, f.mainWindow);
  assert.match(f.dacPrompts[0].options.title, /Windows 端点授权/);
  assert.match(f.dacPrompts[0].options.detail, /Windows 无法区分替换后的物理设备/);
  const acceptedCaller = f.dacCalls.find(row => row[0] === 'confirm' && row[1].token === challenge.value.token)[2];
  assert.equal(acceptedCaller.windowGeneration, prepare[2].windowGeneration);
  assert.equal(acceptedCaller.sender, prepare[2].sender);
  f.mainWindow.webContents.emit('did-start-navigation', {isMainFrame: true});
  assert.equal(f.dacPrompts[0].options.signal.aborted, true); gate.resolve({response: 1}); assert.equal((await confirming).ok, false);
  await f.invoke('dac:prepare', payload);
  assert.ok(f.dacCalls.filter(row => row[0] === 'prepare').at(-1)[2].windowGeneration > prepare[2].windowGeneration);
});

test('main consumes a DAC use permit with the original backend operation context and never provides dynamic authorization to private installs', async t => {
  const f = await fixture(t, {publicMode: true, dacEnabled: true});
  const controller = new AbortController(); let checks = 0;
  const input = {session: {}, output: {}, capability: 'exclusive-check', signal: controller.signal, context: {check() {checks++;}}};
  assert.equal((await f.backendOptions.authorizeDacOutput(input)).syntheticAuthorization, true);
  assert.equal(f.dacCalls.find(row => row[0] === 'issue')[1], input); assert.equal(f.dacCalls.find(row => row[0] === 'consume')[1], input);
  assert.equal(checks, 2);
  const local = await fixture(t, {dacEnabled: true});
  assert.equal(local.backendOptions.authorizeDacOutput, undefined); assert.equal((await local.invoke('app:bootstrap')).value.capabilities.dacAuthorization, false);
});

test('public main.run opens setup-required without backend reads/spawn and connects only after explicit preparation', async t => {
  const f = await fixture(t, {publicMode: true});
  assert.equal(f.calls.includes('setup-initialize'), true); assert.equal(f.calls.includes('backend-initialize'), false);
  assert.equal(f.calls.includes('local-connect'), false); assert.equal(f.calls.includes('local-read'), false);
  assert.equal(f.backendOptions.requireOwnedSession, true); assert.equal(f.backendOptions.requirePublicProvenance, true);
  assert.equal(f.backendOptions.startStopped, true);
  assert.equal(f.backendOptions.ownedExitOutputPolicy, undefined);
  const initial = await f.invoke('backend:setupStatus'); assert.equal(initial.value.public, true); assert.equal(initial.value.ready, false);
  const restore = await f.invoke('app:restoreInfo'); assert.match(restore.value.guide, /public-installer\.md$/);
  await f.invoke('backend:setupComplete');
  assert.ok(f.calls.indexOf('setup-prepared') < f.calls.indexOf('backend-initialize'));
  assert.ok(f.calls.indexOf('local-connect') < f.calls.indexOf('setup-ready'));
  assert.equal((await f.invoke('backend:setupStatus')).value.ready, true);
});
test('schema2 main.run automatically prepares the isolated source before the normal stopped Job/bridge startup', async t => {
  const f = await fixture(t, {publicMode: true, publicAutomatic: true}); await flush(); await flush();
  assert.equal(f.calls.filter(value => value === 'setup-begin').length, 1);
  assert.ok(f.calls.indexOf('setup-begin') < f.calls.indexOf('setup-prepared'));
  assert.ok(f.calls.indexOf('setup-prepared') < f.calls.indexOf('backend-initialize'));
  assert.ok(f.calls.indexOf('local-connect') < f.calls.indexOf('setup-ready'));
  assert.equal(f.backendOptions.startStopped, true); assert.equal(f.backendOptions.ownedExitOutputPolicy, undefined);
  assert.equal((await f.invoke('backend:setupStatus')).value.ready, true);
});
test('a public first-read failure can reach actual setup readiness from the same branded read recovery', async t => {
  const f = await fixture(t, {publicMode: true, publicAutomatic: true, firstBridgeReadFails: true});
  assert.equal((await f.invoke('backend:setupStatus')).value.ready, false);
  f.setBridgeHealthy(true);
  assert.equal((await f.invoke('source:status')).value.sources.local.connected, true);
  assert.equal((await f.invoke('backend:setupStatus')).value.ready, true);
});
test('public reopen ignores the legacy private foobar diagnostic path instead of disabling its isolated startup', async t => {
  const f = await fixture(t, {publicMode: true, publicAutomatic: true, publicPrepared: true, foobarOverride: true});
  assert.equal(f.getBackendInitializationOptions().start, true);
  assert.doesNotMatch(f.backendOptions.backendDir, /OriginalNeverUse/);
  assert.equal((await f.invoke('backend:setupStatus')).value.ready, true);
});

test('actual main.run retries only reads after the first bound branded bridge GET fails, then recovers without reconnecting or playing', async t => {
  const f = await fixture(t, {firstBridgeReadFails: true});
  const failed = (await f.invoke('source:status')).value.sources.local;
  assert.equal(failed.connected, false); assert.equal(failed.capabilities.playback, false);
  assert.equal((await f.invoke('audio:select', {id: 'synthetic-output'})).ok, false);
  assert.equal(f.calls.includes('output-select'), false);
  assert.equal((await f.invoke('audio:outputs')).ok, true, 'Verified GET output enumeration stays usable');
  const before = f.calls.filter(row => row === 'local-read').length;
  f.setBridgeHealthy(true);
  for (const tick of f.intervals.values()) tick();
  await flush(); await flush();
  assert.ok(f.calls.filter(row => row === 'local-read').length > before, 'Runtime poll retries the failed first read');
  const recovered = (await f.invoke('source:status')).value.sources.local;
  assert.equal(recovered.connected, true); assert.equal(recovered.backendStatus, 'ready');
  assert.equal(recovered.backendDiagnostic, null);
  assert.equal(f.calls.filter(row => row === 'local-connect').length, 1);
  assert.equal(f.calls.includes('output-select'), false); assert.equal(f.calls.includes('shutdown-stop'), false);
  assert.deepEqual(f.exits, []);
});

test('read recovery preserves uncertain control and never enables playback from a successful GET', async t => {
  const f = await fixture(t, {firstBridgeReadFails: true, uncertainControl: true});
  f.setBridgeHealthy(true);
  const recovered = (await f.invoke('source:status')).value.sources.local;
  assert.equal(recovered.connected, true); assert.equal(recovered.controlUncertain, true);
  assert.equal(recovered.status, 'control-unconfirmed'); assert.equal(recovered.capabilities.playback, false);
  assert.equal(f.calls.filter(row => row === 'local-connect').length, 1);
});

test('the source status request that first recovers a bound GET does not retain its earlier backend error', async t => {
  const f = await fixture(t, {firstBridgeReadFails: true});
  f.setBridgeHealthy(true);
  // No timer is pumped: this request itself causes the first fresh read.
  const recovered = (await f.invoke('source:status')).value.sources.local;
  assert.equal(recovered.connected, true); assert.equal(recovered.backendStatus, 'ready');
  assert.equal(recovered.backendDiagnostic, null);
  assert.equal(f.calls.filter(row => row === 'local-connect').length, 1);
});

for (const reason of ['unbound', 'copied-session', 'pending-handoff', 'backend-unavailable', 'shutdown']) {
  test(`initial read recovery stays closed for ${reason}`, async t => {
    const f = await fixture(t, {firstBridgeReadFails: true}); f.setBridgeHealthy(true);
    if (reason === 'unbound') f.setBoundSession(null);
    if (reason === 'copied-session') {const copy = {...f.backendSession}; f.setSelectedSession(copy); f.setBoundSession(copy);}
    if (reason === 'pending-handoff') f.setPendingRestore(true);
    if (reason === 'backend-unavailable') f.setBackendAvailable(false);
    if (reason === 'shutdown') {f.app.quit(); await flush(); await flush();}
    const before = f.calls.filter(row => row === 'local-read').length;
    const state = await f.invoke('source:status');
    assert.equal(state.ok, true); assert.equal(state.value.sources.local.connected, false);
    assert.equal(f.calls.filter(row => row === 'local-read').length, before);
    assert.equal(f.calls.includes('output-select'), false);
  });
}

test('actual main.run normal READY quit failure never exits, preserves manual diagnostics and a single read-only timer', async t => {
  const f = await fixture(t); assert.equal(f.intervals.size, 1);
  f.app.quit(); await flush(); await flush();
  assert.ok(f.calls.indexOf('desktop-shutdown') < f.calls.indexOf('backend-close'));
  assert.ok(f.calls.indexOf('cue-close') < f.calls.indexOf('backend-close'));
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
  assert.ok(f.calls.indexOf('desktop-shutdown') < f.calls.indexOf('settings-close'));
  assert.ok(f.calls.indexOf('cue-closed') < f.calls.indexOf('settings-close'));
  assert.equal((await f.invoke('desktop:sleepTimer:set', {minutes: 1})).ok, false);
});

test('actual main.run true fatal failure gates controls immediately and exits nonzero even after READY cleanup fails', async t => {
  const f = await fixture(t); f.processTarget.emit('uncaughtException', new Error('SECRET'));
  assert.equal(f.calls.includes('desktop-shutdown'), true);
  assert.equal(f.calls.includes('cue-close'), true);
  assert.equal(f.intervals.size, 0);
  assert.equal((await f.invoke('settings:update', {patch: {}})).ok, false);
  await flush(); await flush(); assert.deepEqual(f.exits, [1]);
});

test('actual main.run created never-READY uncertainty exits abnormally rather than keeping an unusable startup alive', async t => {
  const f = await fixture(t, {startupUncertain: true}); await flush(); await flush();
  assert.deepEqual(f.exits, [1]); assert.equal(f.intervals.size, 0); assert.equal(f.calls.includes('normal-exit'), false);
});

test('caught startup with no primary owned process stays read-only while the isolated CUE inspector has not drained', {timeout: 1000}, async t => {
  const f = await fixture(t, {loadFailure: true, ownsBackend: false, holdCueClose: true, fastStartupDrain: true});
  await f.recoveryShown;
  assert.equal(f.calls.includes('cue-close'), true); assert.equal(f.calls.includes('cue-closed'), false);
  assert.deepEqual(f.exits, []); assert.equal(f.intervals.size, 1);
  assert.equal((await f.invoke('settings:update', {patch: {}})).ok, false);
  assert.equal((await f.invoke('app:exportDiagnostics', {})).ok, true);
  f.releaseCueClose(); await flush(); assert.deepEqual(f.exits, []);
  f.app.quit(); await flush(); await flush(); assert.equal(f.calls.includes('normal-exit'), true);
});

test('caught never-READY shortcut refuses abnormal exit while the CUE playback holder cannot prove cleanup', {timeout: 1000}, async t => {
  const f = await fixture(t, {startupUncertain: true, failCueGuardClose: true}); await f.recoveryShown;
  assert.equal(f.calls.includes('cue-guard-unverified'), true); assert.deepEqual(f.exits, []);
  assert.equal(f.intervals.size, 1); assert.equal((await f.invoke('settings:update', {patch: {}})).ok, false);
  assert.equal((await f.invoke('app:exportDiagnostics', {})).ok, true);
});

test('actual main.run caught startup failure after native READY keeps a failed graceful close read-only without abnormal exit', async t => {
  const f = await fixture(t, {loadFailure: true});
  assert.deepEqual(f.exits, []); assert.equal(f.intervals.size, 1); assert.equal(f.calls.includes('spectrum-dispose'), false);
  assert.equal((await f.invoke('settings:update', {patch: {}})).ok, false);
  assert.equal((await f.invoke('app:exportDiagnostics', {})).ok, true);
  assert.ok(f.calls.indexOf('desktop-shutdown') < f.calls.indexOf('backend-close'));
  assert.ok(f.calls.indexOf('cue-close') < f.calls.indexOf('backend-close'));
  assert.equal((await f.invoke('desktop:status')).ok, true);
  assert.equal((await f.invoke('desktop:sleepTimer:cancel')).ok, false);
});

test('actual main.run wires desktop observations, trusted manifest pin and the native cover transform', async t => {
  const f = await fixture(t);
  assert.equal(typeof f.libraryOptions.coverTransform, 'function'); assert.equal(f.desktopOptions.mediaManifestSha256, 'a'.repeat(64));
  assert.equal(f.desktopOptions.enabled, true); assert.equal(f.calls.includes('desktop-restore'), true);
  await f.invoke('player:state'); await f.invoke('source:status');
  assert.ok(f.desktopObservations.players.length > 0); assert.ok(f.desktopObservations.sources.length > 0);
  const current = await f.desktopOptions.getPlayer(); assert.equal(typeof current.generation, 'number'); assert.equal(current.simulatedUIFixture, undefined);
  await f.invoke('settings:update', {patch: {desktop: {preventSleep: false}}});
  assert.equal(f.desktopObservations.settings.at(-1).desktop.preventSleep, false);
  assert.equal((await f.invoke('desktop:status')).ok, true);
});

test('actual main.run injects one lazy CUE inspector and forwards only its read-only progress event', async t => {
  const f = await fixture(t);
  assert.equal(f.cueOptions.enabled, true); assert.equal(f.cueOptions.runtimeRoot, path.resolve(__dirname, '..')); assert.equal(f.cueRequests.length, 0);
  assert.equal(typeof f.libraryOptions.cueInspector, 'function');
  const request = {path: 'C:/SYNTHETIC/album.cue', references: ['C:/SYNTHETIC/album.flac'], trackCount: 1, authorizationRoot: 'C:/SYNTHETIC', encoding: 'utf-8', contentHash: 'a'.repeat(64)};
  const found = await f.libraryOptions.cueInspector(request);
  assert.equal(f.cueRequests[0], request); assert.equal(found.verified, true); assert.equal(found.items[0].subsong, 7);
  const progress = {state: 'discovering', pending: 1}; f.cueOptions.onProgress(progress);
  assert.equal(f.calls.find(row => row.event === 'cue-discovery').value, progress);
  assert.equal(f.calls.includes('shutdown-stop'), false); assert.equal(f.calls.includes('output-select'), false);
});

test('normal shutdown aborts CUE work synchronously and waits for its physical close before library/settings drain', async t => {
  const f = await fixture(t, {holdCueClose: true, failNormalClose: false});
  f.app.quit(); assert.equal(f.calls.includes('cue-close'), true); await flush();
  assert.equal(f.calls.includes('library-close'), false); assert.equal(f.calls.includes('settings-close'), false);
  f.releaseCueClose(); await flush(); await flush();
  assert.ok(f.calls.indexOf('cue-closed') < f.calls.indexOf('library-close')); assert.ok(f.calls.indexOf('cue-closed') < f.calls.indexOf('settings-close'));
  assert.equal(f.calls.includes('normal-exit'), true);
});

test('fatal shutdown starts CUE cancellation before any await and waits before exiting', async t => {
  const f = await fixture(t, {holdCueClose: true}); f.processTarget.emit('uncaughtException', new Error('SYNTHETIC FATAL'));
  assert.equal(f.calls.includes('cue-close'), true); await flush(); assert.ok(f.calls.indexOf('cue-close') < f.calls.indexOf('backend-close'));
  assert.deepEqual(f.exits, []); f.releaseCueClose(); await flush(); await flush(); assert.deepEqual(f.exits, [1]);
});

test('actual main.run never substitutes an adjacent manifest digest when trusted desktop pin verification fails', async t => {
  const f = await fixture(t, {invalidDesktopPin: true});
  assert.equal(f.desktopOptions.mediaManifestSha256, undefined); assert.equal((await f.invoke('app:bootstrap')).ok, true);
});

test('actual renderer shutdown invalidates desktop callbacks before the error dialog and backend drain', async t => {
  const f = await fixture(t); f.mainWindow.webContents.emit('render-process-gone', {}, {exitCode: 2, reason: 'fixture-only'});
  assert.ok(f.calls.indexOf('desktop-shutdown') < f.calls.indexOf('error-box')); await flush();
  assert.ok(f.calls.indexOf('desktop-shutdown') < f.calls.indexOf('backend-close'));
  assert.ok(f.calls.indexOf('cue-close') < f.calls.indexOf('error-box'));
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
