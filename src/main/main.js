'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {pathToFileURL} = require('node:url');
const {randomUUID} = require('node:crypto');
const {APPLE_PLAYBACK_MAINTENANCE, createHandlers, createLibraryView, invokeSafely, mapPlayer, mapQueue, safeCoverPath, createAppleAdapter, unavailableAppleService, windowSize, validateDiagnosticLayout, registerApplicationSchemes, createLyricsTrackResolver, isTrustedApplicationSender, commandAvailability} = require('./ipc-handlers');
const {withSmokeLyricsFixture, SMOKE_READ_CHANNELS, validateSmokePlan, runDesktopSmoke} = require('./smoke');
const {isApprovedPublicRequest, createPublicFetchService} = require('./public-fetch');
const {createRuntimeLog, installRuntimeFailureHandlers} = require('./runtime-log');
const {createRuntimePoll} = require('./runtime-poll');
const {createShutdownCoverGc, retainedPlayerCoverUrls} = require('./shutdown-cover-gc');
const {createSettingsService} = require('./settings');
const {createPlaybackCoordinator} = require('./playback-coordinator');
const {createFoobarSessionService} = require('./foobar-session');
const {readAppleDiagnosticSnapshot, createDiagnosticSnapshotReader} = require('./apple-diagnostics');
const {createPlayerSpectrumService, emptySpectrum} = require('./player-spectrum');
async function createAppleMusicIntegration({protocol, createArtworkService, createMusicService, serviceOptions = {}}) {
  const artwork = createArtworkService();
  let registered = false, cleanup;
  const closeArtwork = () => {
    if (!cleanup) cleanup = (async () => {
      try {if (registered) {protocol.unhandle('still-apple-art'); registered = false;}}
      finally {await artwork.close();}
    })();
    return cleanup;
  };
  try {
    // Only URLs registered by the trusted Apple adapter can resolve. The
    // renderer receives opaque IDs; no IPC accepts a remote artwork URL.
    protocol.handle('still-apple-art', request => artwork.handleRequest(request));
    registered = true;
    const artworkUrlFor = value => artwork.urlFor(value);
    const apple = createMusicService({...serviceOptions, artworkUrlFor});
    return {apple, artworkUrlFor, closeArtwork};
  } catch (error) {await closeArtwork(); throw error;}
}
async function resolveFoobarDir(startDirectory, override) {
  if (override) return path.resolve(override);
  return path.join(path.resolve(startDirectory), 'backend', 'foobar2000');
}
async function initializeBackend(backend, options) {
  try {return await backend.initialize(backend.getInfo?.().pendingHandoff ? {...options, start: false} : options);}
  catch (error) {
    if (requiresAbnormalStartupExit(backend, error) || requiresGracefulStartupFailure(backend)) throw error;
    return {...backend.getInfo(), available: false, error: error.message};
  }
}
function requiresAbnormalStartupExit(backend, error) {
  const info = backend.getInfo();
  return error?.code === 'STILL_BACKEND_STARTUP_UNCERTAIN' && error.abnormalStartupExitRequired === true &&
    info.startupCreated === true && info.abnormalStartupExitRequired === true && info.available !== true &&
    info.nativeReadySeen === false && info.sessionId == null && !backend.getSession?.();
}
function requiresGracefulStartupFailure(backend) {
  const info = backend.getInfo();
  return info.owned === true && info.nativeReadySeen === true;
}
async function prepareLocalPlaybackLifecycle({backend, foobar, bridge, isBridgeReady, onBridgeReady}, input, context) {
  const paths = input.locations.map(item => item.path);
  const prepared = await backend.preparePaths({paths, deferRestart: true}); context.check();
  const before = backend.getInfo();
  let connected = false;
  if (prepared.restartRequired || !before.available || !isBridgeReady()) {
    // A retired handoff lifetime has no state or device to probe. Only the
    // explicit local-play request below may construct its fresh replacement.
    if (!before.pendingHandoff) {
      await foobar.cancelPending(); context.check();
      const current = await foobar.getState(); context.check();
      if (current.available) {await foobar.stop(); context.check();}
    }
    onBridgeReady(false);
    const info = await backend.ensureStarted({paths, allowRestart: true, explicitLocalPlay: true, signal: context.signal}); context.check();
    const state = await bridge.connect(info); context.check();
    if (state.available !== true) throw new Error(state.error || '重载后的专属播放连接尚未就绪。');
    connected = true;
  }
  await bridge.verifyHandoffRestore(context); context.check();
  if (connected) onBridgeReady(true);
}
async function prepareAppleHandoffLifecycle({backend, bridge, onBridgeReady}, context) {
  context.check(); onBridgeReady(false);
  const info = await backend.ensureStarted({explicitHandoffRestore: context, signal: context.signal}); context.check();
  await bridge.connect(info); context.check();
  await bridge.verifyHandoffRestore(context); context.check();
  onBridgeReady(true);
}
async function revealBeforeBackend({openWindow, initialize}) {
  await openWindow();
  // Do not adopt/await this promise: the visible UI and its quit handler must
  // remain usable throughout slow process inspection and backend startup.
  return {completion: Promise.resolve().then(initialize)};
}
function guardFoobarService(service, getBackendInfo) {
  const canAccess = () => {const info = getBackendInfo(); return !info.pendingHandoff && info.status !== 'standby' && (info.verified ?? info.available);};
  const offline = async () => {
    const info = getBackendInfo();
    return {available: false, state: 'unavailable', position: 0, duration: 0, volume: null, currentTrack: null,
      backendReachable: false, ...(!info.pendingHandoff && info.status !== 'standby' && typeof service.outputConnection === 'function' ? {outputConnection: await service.outputConnection()} : {}),
      error: info.error || (info.status === 'starting' ? '专属本地内核正在启动。' : '专属本地内核尚未通过进程与端口核验。')};
  };
  return new Proxy(service, {get(target, name) {
    if (name === 'playbackContext') return (...args) => canAccess() ? target.playbackContext(...args) :
      Promise.resolve({status: 'unavailable', playlist: null, currentIndex: null, items: [], reason: 'backend-unavailable'});
    if (name === 'getState') return () => canAccess() ? target.getState() : offline();
    if (name === 'audioDetails') return () => target.audioDetails({readBackend: Boolean(canAccess())});
    if (name === 'capabilities') return () => ({...target.capabilities(), ...(!canAccess() ? {playback: false, installedOrReachable: false} : {})});
    const value = target[name];
    if (typeof value !== 'function') return value;
    if (['initialize', 'cancelPending', 'close', 'restoreInfo', 'on', 'off', 'disposeAfterProcessExit', 'outputConnection', 'transportStatus',
      'getHandoffStatus', 'finishOutputHandoff', 'prepareOutputHandoff', 'releaseOutput', 'getAudioTransportStatus', 'needsColdHandoffRestore'].includes(name)) return value.bind(target);
    return (...args) => {
      if (!canAccess()) return offline().then(state => {throw new Error(state.error);});
      return value.apply(target, args);
    };
  }});
}
function settleWithin(promise, milliseconds) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({settled: false}), milliseconds);
    Promise.resolve(promise).then(value => {clearTimeout(timer); resolve({settled: true, value});}, error => {clearTimeout(timer); resolve({settled: true, error});});
  });
}
async function shutdownDesktop({coordinator, foobar, backend, closeServices = [], syncPromise, smokeMode = false,
  bridgeSessionBound = true, stopGraceMs = 500, drainTimeoutMs = 5000}) {
  // Quiesce every queued write lane synchronously before coordinator cancellation.
  const hasShutdownPermit = typeof foobar.beginShutdownWrites === 'function';
  const shutdownWrites = hasShutdownPermit ? foobar.beginShutdownWrites() : null;
  // Cancellation is synchronous. Never await a possibly blocked HTTP fence
  // before giving the independently verified owned process its graceful exit.
  const {settled: coordinatorDone} = coordinator.beginShutdown();
  const owned = backend.getInfo().owned === true;
  if (!smokeMode && owned) await settleWithin(Promise.resolve().then(() => {
    if (!hasShutdownPermit) return foobar.stop(); // Compatibility for old DI stubs only.
    if (typeof shutdownWrites?.stop !== 'function') throw new Error('专属后端未提供安全退出控制许可。');
    return shutdownWrites.stop();
  }), stopGraceMs);
  const result = await backend.close();
  if (result?.exitEvidence && bridgeSessionBound) foobar.markBackendExited(result.exitEvidence);
  else if (owned && bridgeSessionBound) throw new Error('专属后端未提供经核验的退出证据；未宣称关闭成功。');
  const drains = Promise.all([coordinatorDone, foobar.close(), ...closeServices.map(close => close()), Promise.resolve(syncPromise)]);
  const outcome = await settleWithin(drains, drainTimeoutMs);
  if (!outcome.settled) throw new Error('专属进程退出后，仍未确认所有控制与数据保存结束。窗口保留，可查看诊断后再次退出。');
  if (outcome.error) throw outcome.error;
  return result;
}
async function run({runtimeBoundary} = {}) {
  // Install synchronously before Electron import, filesystem IO or any await.
  let runtimeApp = null, mainWindow, pollController, backendStartupController, quiesceWrites = () => {}, cancelCoverCollection = () => {};
  const fatalServices = [];
  let shuttingDown = false, shutdownComplete = false, shutdownFailure = null,
    fatalCleanup = () => Promise.allSettled(fatalServices.map(close => Promise.resolve().then(close)));
  let caughtCleanup = () => Promise.allSettled(fatalServices.map(close => Promise.resolve().then(close))), backendForRecovery = null,
    caughtFailureWork = null, disposeReadServices = () => {};
  const runtimeLog = runtimeBoundary?.log || createRuntimeLog();
  const onFatal = () => {
    shuttingDown = true; pollController?.stop(); backendStartupController?.abort();
    quiesceWrites(); cancelCoverCollection();
    return fatalCleanup();
  };
  const exit = code => runtimeApp ? runtimeApp.exit(code) : process.exit(code);
  const failures = runtimeBoundary?.failures || installRuntimeFailureHandlers({log: runtimeLog, onFatal, exit});
  if (runtimeBoundary) failures.configure({onFatal, exit});
  const assertActive = () => {if (failures.isFatal()) throw new Error('Application is exiting after a fatal runtime failure');};
  const handleStartupError = error => {
    if (caughtFailureWork) return caughtFailureWork;
    if (failures.isFatal()) return failures.completion();
    if (shuttingDown || shutdownFailure || shutdownComplete) return Promise.resolve();
    shuttingDown = true; pollController?.stop(); backendStartupController?.abort(); quiesceWrites(); cancelCoverCollection();
    runtimeLog.record('startup-failed', {level: 'error'});
    caughtFailureWork = (async () => {
      const outcome = await settleWithin(Promise.resolve().then(caughtCleanup), 10000);
      // Read the private manager again at the actual exit decision. Native READY
      // may arrive during cleanup and permanently revokes the never-READY exception.
      const info = backendForRecovery?.getInfo();
      const noOwnedProcess = !info || info.owned === false;
      const neverReady = backendForRecovery && requiresAbnormalStartupExit(backendForRecovery, error);
      if (neverReady) {
        // No await between the fresh native-READY check and abnormal exit.
        disposeReadServices(); failures.dispose();
        runtimeApp ? runtimeApp.exit(1) : process.exit(1);
        return;
      }
      if ((outcome.settled && !outcome.error) || noOwnedProcess) {
        // All awaited cleanup is above the fresh ownership read. A diagnostic
        // exporter is intentionally left to process teardown on failed startup.
        disposeReadServices(); failures.dispose();
        runtimeApp ? runtimeApp.exit(1) : process.exit(1);
        return;
      }
      shutdownFailure = '启动未完成且安全退出尚待核验；当前仅保留只读状态与诊断，播放和更改操作已关闭。请查看诊断后再次退出。';
      shuttingDown = false; pollController?.start();
      if (mainWindow && !mainWindow.isDestroyed()) {mainWindow.show(); mainWindow.focus();}
      runtimeLog.record('shutdown-failed', {level: 'error', code: 'STILL_SHUTDOWN_FAILED'});
      if (runtimeApp) {
        const {dialog} = require('electron');
        dialog.showErrorBox('STILL 启动未完成', shutdownFailure);
      }
    })();
    return caughtFailureWork;
  };
  try {
  const {app, BrowserWindow, ipcMain, protocol, net, session, dialog, shell, Menu, screen, safeStorage, nativeTheme} = require('electron');
  runtimeApp = app;
  registerApplicationSchemes(protocol);
  const root = path.resolve(__dirname, '../..');
  const dataDir = process.env.STILL_DATA_DIR ? path.resolve(process.env.STILL_DATA_DIR) : path.join(app.isPackaged ? path.dirname(app.getPath('exe')) : root, 'data');
  const runtimeRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : root;
  // The product never discovers or launches the original ancestor installation.
  // STILL_FOOBAR_DIR is an explicit developer diagnostic override only.
  const foobarDir = await resolveFoobarDir(runtimeRoot, process.env.STILL_FOOBAR_DIR); assertActive();
  // Keep Chromium cache and user preferences portable too.
  await fs.mkdir(path.join(dataDir, 'electron', 'session'), {recursive: true}); assertActive();
  app.setPath('userData', path.join(dataDir, 'electron'));
  app.setPath('sessionData', path.join(dataDir, 'electron', 'session'));
  if (!app.requestSingleInstanceLock()) {runtimeLog.record('single-instance', {level: 'error'}); failures.dispose(); app.exit(process.env.STILL_SMOKE_TEST === '1' ? 1 : 0); return;}
  const smokeMode = process.env.STILL_SMOKE_TEST === '1';
  const metadataStreamUUID = randomUUID(); let metadataSequence = 0;
  let spectrumClient = null;
  let lastState = '', lastSources = '', syncedBackend = false, syncPromise = null, syncRetryAt = 0, libraryView = null, connectionEpoch = 0, wasAvailable = false;
  let coordinator, emittedGeneration = -1, emittedRevision = -1, cachedPlayer = null, spectrumService = null;
  const rememberPlayer = value => {
    if (shuttingDown || failures.isFatal()) return;
    if (value.generation < (coordinator?.currentGeneration() ?? 0) || (cachedPlayer && (value.generation < cachedPlayer.generation ||
        (value.generation === cachedPlayer.generation && value.revision < cachedPlayer.revision)))) return;
    cachedPlayer = value;
    spectrumService?.refresh();
  };
  const emit = (name, value) => {
    if (failures.isFatal() || shuttingDown) return;
    if (name === 'player') {
      if (value.generation < (coordinator?.currentGeneration() ?? 0) || value.generation < emittedGeneration ||
          (value.generation === emittedGeneration && value.revision < emittedRevision)) return;
      emittedGeneration = value.generation; emittedRevision = value.revision;
      rememberPlayer(value);
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(name, value);
  };
  app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.on('window-all-closed', () => app.quit());
  await app.whenReady(); assertActive();
  let closeAppleArtwork = async () => {}, closeMetadataCovers = async () => {}, closePublicFetch = async () => {}, closePlaybackContext = () => {}, closeSpectrum = () => {};
  disposeReadServices = () => {closeSpectrum(); closePlaybackContext();};
  try {
  const publicNetwork = createPublicFetchService({session});
  const publicFetch = publicNetwork.fetch;
  closePublicFetch = publicNetwork.close;
  fatalServices.push(closePublicFetch);
  nativeTheme.themeSource = 'dark';
  await fs.mkdir(dataDir, {recursive: true}); assertActive();
  const settings = createSettingsService({dataDir});
  fatalServices.push(() => settings.close());
  await settings.initialize(); assertActive();
  const {createLibraryService} = require('./library');
  const {createFoobarService} = require('./foobar');
  const {createBackendManager} = require('./backend');
  const {createLyricsService} = require('./lyrics');
  const {createQqLyricsClient} = require('./qq-lyrics');
  let metadataCovers = null;
  const decorateTrack = value => metadataCovers && !shuttingDown && !shutdownFailure && !failures.isFatal() ? metadataCovers.decorateTrack(value) : value;
  const decorateLibrarySnapshot = value => ({...value, tracks: value.tracks.map(decorateTrack),
    eventCursors: {...value.eventCursors, metadata: {streamId: metadataStreamUUID, sequence: metadataSequence}}});
  libraryView = createLibraryView();
  const library = createLibraryService({dataDir, returnDeltas: true, onDelta: delta => {
    if (!libraryView.apply(delta)) return;
    if (delta.removedTrackIds?.length) metadataCovers?.forgetTracks(delta.removedTrackIds);
    emit('library', {...delta, tracks: delta.tracks.map(decorateTrack)});
  }, dialog, shell});
  fatalServices.push(() => library.close());
  const shutdownCoverGc = createShutdownCoverGc({library, record: (event, details) => runtimeLog.record(event, details)});
  cancelCoverCollection = shutdownCoverGc.cancel;
  const backend = createBackendManager({dataDir, backendDir: foobarDir,
    quietRestartPolicy: 'stopped-owned-exit',
    ownedExitOutputPolicy: 'dx1-wasapi-in-process-v1',
    probePath: path.join(root, 'scripts', 'foobar-coreaudio-probe.exe')});
  backendForRecovery = backend;
  fatalCleanup = async () => {
    coordinator?.beginShutdown(); closeSpectrum(); closePlaybackContext();
    await backend.close();
    await Promise.allSettled(fatalServices.map(close => Promise.resolve().then(close)));
  };
  caughtCleanup = async () => {
    coordinator?.beginShutdown();
    await backend.close();
    await Promise.all(fatalServices.map(close => Promise.resolve().then(close)));
  };
  backendStartupController = new AbortController();
  let backendStartup = null, backendStarting = true, bridgeReady = false, bridgeReachable = false, backendInitError = null;
  let getCachedLocalHandoff = () => null, localReadHealth = {};
  const getSafeOwnedExitTarget = () => typeof backend.getSafeOwnedExitTarget === 'function' ? backend.getSafeOwnedExitTarget() :
    {available: false, refused: true, code: 'STILL_BACKEND_OWNERSHIP_UNVERIFIED',
      reason: '未找到本次应用创建记录与实时身份均可核验的后台。', selectionToken: null, target: null};
  const getBackendInfo = () => {
    const info = backend.getInfo(), pendingRestore = getCachedLocalHandoff()?.pendingRestore === true;
    return {...info, ...localReadHealth, available: info.available && bridgeReady && bridgeReachable && !pendingRestore,
      verified: info.available && bridgeReady && !pendingRestore, pendingHandoff: info.pendingHandoff === true || pendingRestore,
      ...(backendStarting ? {status: 'starting'} : {}), ...(backendInitError ? {error: backendInitError} : {}),
      ...(shutdownFailure ? {available: false, status: 'failed', error: shutdownFailure} : {})};
  };
  let lastLocalOutput = null;
  const rawFoobar = createFoobarSessionService({createService: createFoobarService, backend,
    serviceOptions: {dataDir, foobarDir, pollIntervalMs: 0, persistOutputSelection: !smokeMode,
      onAudioDispatch: event => spectrumService?.onAudioDispatch(event),
      probePath: path.join(root, 'scripts', 'foobar-coreaudio-probe.exe'),
      waitForOutputRelease: args => backend.waitForOutputRelease(args)},
    onUpdate: state => {
      localReadHealth = {connectionStatus: state.connectionStatus, stale: state.stale,
        consecutiveReadFailures: state.consecutiveReadFailures, lastGoodAt: state.lastGoodAt};
      bridgeReachable = state.backendReachable ?? state.available === true;
      if (state.output) lastLocalOutput = state.output;
      if (!bridgeReachable && state.error) backendInitError = state.error;
    }, onOutputConnection: () => {lastSources = '';}});
  quiesceWrites = () => rawFoobar.beginShutdownWrites?.();
  getCachedLocalHandoff = () => rawFoobar.getHandoffStatus();
  await rawFoobar.initializeHandoff(); assertActive();
  const foobar = guardFoobarService(rawFoobar, getBackendInfo);
  let apple, artworkUrlFor = () => '';
  try {
    const {createOfficialAppleMusicService} = require('./apple-music');
    const {createAppleArtworkService} = require('./apple-artwork');
    if (typeof createOfficialAppleMusicService !== 'function') throw new Error('Official Apple Music host is not yet available');
    const integration = await createAppleMusicIntegration({protocol,
      createArtworkService: () => createAppleArtworkService({cacheDirectory: path.join(dataDir, 'artwork-cache'), fetchImpl: publicFetch}),
      createMusicService: createOfficialAppleMusicService, serviceOptions: {dataDir, safeStorage, emit: () => {lastSources = '';},
      verifyOutputReleased: async args => {
        const current = await foobar.getState();
        return backend.waitForExclusiveAccess({...args, output: current.output || lastLocalOutput});
      }}});
    apple = integration.apple; artworkUrlFor = integration.artworkUrlFor; closeAppleArtwork = integration.closeArtwork;
  } catch {
    runtimeLog.record('service-unavailable');
    apple = unavailableAppleService();
  }
  fatalServices.push(() => apple.close(), () => closeAppleArtwork(), () => closeMetadataCovers());
  try {
    const {createMetadataCoverService} = require('./metadata-covers');
    metadataCovers = createMetadataCoverService({cacheDirectory: path.join(dataDir, 'cover-metadata-cache'), artworkUrlFor, fetchImpl: publicFetch,
      contact: settings.get().onlineCovers?.musicBrainzContact || '',
      onChange: async ({trackIds}) => {
        if (shuttingDown || shutdownFailure || failures.isFatal() || !libraryView.isInitialized()) return;
        const requested = new Map(libraryView.getTracks(trackIds).map(track => [track.id, track]));
        const available = await library.getTracks(trackIds);
        if (shuttingDown || shutdownFailure || failures.isFatal()) return;
        const current = new Map(libraryView.getTracks(trackIds).map(track => [track.id, track]));
        const tracks = available.filter(track => requested.get(track.id) && current.get(track.id) === requested.get(track.id)).map(decorateTrack);
        if (!tracks.length) return;
        const {revision} = libraryView.summary();
        emit('library', {kind: 'library-delta', eventId: 'metadata:' + metadataStreamUUID + ':' + (++metadataSequence),
          baseRevision: revision, revision, tracks, removedTrackIds: []});
      }});
    closeMetadataCovers = () => metadataCovers.close();
    // Cache initialization and public metadata lookups must not delay the
    // window, bootstrap or either playback engine.
    Promise.resolve(metadataCovers.initialize()).catch(() => runtimeLog.record('service-unavailable'));
  } catch {runtimeLog.record('service-unavailable');}
  coordinator = createPlaybackCoordinator({engines: {local: foobar, apple: createAppleAdapter(apple)},
    prepareAppleHandoff: context => prepareAppleHandoffLifecycle({backend, bridge: rawFoobar, onBridgeReady: value => {bridgeReady = value;}}, context)});
  try {
    const {createSpectrumClient, DEFAULT_READER_PATH} = require('./spectrum-client');
    const client = createSpectrumClient({readerPath: DEFAULT_READER_PATH, getBackendSession: () => backend.getSession(),
      onDiagnostic: (event, details) => runtimeLog.record(event, details)});
    spectrumClient = client;
    spectrumService = createPlayerSpectrumService({client, getPlayer: () => cachedPlayer,
      getGeneration: () => coordinator.currentGeneration(), getBackendInfo, getBackendSession: () => backend.getSession(),
      getAudioTransportStatus: () => rawFoobar.getAudioTransportStatus()});
    closeSpectrum = () => spectrumService.dispose();
  } catch {runtimeLog.record('service-unavailable');}
  const {createDiagnosticsService} = require('./diagnostics');
  let readBuildDiagnostic = null;
  const loadBuildDiagnostic = () => {
    if (!readBuildDiagnostic) readBuildDiagnostic = fs.readFile(path.join(runtimeRoot, 'BUILD-INFO.json'), 'utf8').then(JSON.parse).catch(() => null);
    return readBuildDiagnostic;
  };
  const getBuildSnapshot = async () => {
    const info = await loadBuildDiagnostic();
    return {version: app.getVersion(), electronVersion: process.versions.electron,
      sourceFrozenSnapshot: info?.sourceFrozenSnapshot, buildId: info?.sourceFrozenSnapshot, builtAt: info?.builtAt};
  };
  const safeDiagnosticRead = async read => {
    try {return await read();}
    catch {return {available: false, status: 'unavailable'};}
  };
  const diagnosticExport = createDiagnosticsService({dataDir, getRuntimeLog: () => runtimeLog.snapshot(), getSpectrumDiagnostics: () => spectrumClient?.getDiagnostics(), getSnapshot: createDiagnosticSnapshotReader({apple, getBuildSnapshot,
    getHandoffSnapshot: () => coordinator.cachedHandoffStatus?.() ?? null, getGeneralSnapshot: async () => {
    // All reads use the services already owned by this running app. This never
    // attaches to another helper, creates a new host, authorizes an account or
    // accepts a destination path from the renderer.
    const buildInfo = await loadBuildDiagnostic();
    const [playerState, localAudio, appleSnapshot] = await Promise.all([
      safeDiagnosticRead(() => coordinator.getState()), safeDiagnosticRead(() => foobar.audioDetails()),
      readAppleDiagnosticSnapshot(apple)
    ]);
    const managed = getBackendInfo();
    return {player: mapPlayer(playerState, libraryView.playerTracks(playerState), decorateTrack), sources: await handlers['source:status'](),
      backend: {pid: managed.pid, backendId: managed.backendId, sessionId: managed.sessionId, ...localReadHealth,
        safeOwnedExit: await getSafeOwnedExitTarget(),
        status: managed.status, available: managed.available, owned: managed.owned, verified: managed.verified,
        managed: managed.managed, privateUseOnly: managed.privateUseOnly, restartRequired: managed.restartRequired,
        pendingHandoff: managed.pendingHandoff, canStartOnDemand: managed.canStartOnDemand,
        foobarDir, executable: path.join(foobarDir, 'foobar2000.exe'),
        manifestSha256: buildInfo?.hashes?.['backend/foobar2000/backend-manifest.json'],
        executableSha256: buildInfo?.hashes?.['backend/foobar2000/foobar2000.exe']},
      apple: appleSnapshot.apple, audio: localAudio,
      build: await getBuildSnapshot()};
  }})});
  const getLyricsTrack = createLyricsTrackResolver({library, apple});
  const lyrics = createLyricsService({dataDir, getTrack: getLyricsTrack, getSettings: () => settings.get(), fetchImpl: publicFetch,
    fallbackClient: createQqLyricsClient({fetchImpl: publicFetch})});
  fatalServices.push(() => lyrics.close(), () => diagnosticExport.close?.());
  await library.initialize({reset: process.argv?.includes('--reset-library') === true}); assertActive();
  libraryView.replace(await library.list()); assertActive();
  await lyrics.initialize(); assertActive();
  async function startBackend({start = true, restartOwned = false} = {}) {
    if (backendStartup) return backendStartup;
    backendStarting = true; backendInitError = null; bridgeReady = false; bridgeReachable = false; lastSources = '';
    connectionEpoch++; syncedBackend = false;
    backendStartup = (async () => {
      if (shuttingDown || shutdownFailure || failures.isFatal()) return getBackendInfo();
      const info = await initializeBackend(backend, {start, restartOwned, signal: backendStartupController.signal});
      if (requiresAbnormalStartupExit(backend, info) || (info.available !== true && requiresGracefulStartupFailure(backend))) {
        void handleStartupError(info); return getBackendInfo();
      }
      if (shuttingDown || shutdownFailure || failures.isFatal()) return getBackendInfo();
      backendInitError = info.error || null;
      if (info.available) {
        try {
          const state = await rawFoobar.connect(info);
          if (shuttingDown || shutdownFailure || failures.isFatal()) return getBackendInfo();
          bridgeReady = state.available === true;
          if (!bridgeReady) backendInitError = state.error || '专属内核尚未读回就绪状态。';
        } catch (error) {bridgeReady = false; backendInitError = error.message;}
      } else bridgeReady = false;
      return getBackendInfo();
    })().catch(error => {
      if (requiresAbnormalStartupExit(backend, error) || requiresGracefulStartupFailure(backend)) void handleStartupError(error);
      throw error;
    }).finally(() => {backendStarting = false; backendStartup = null; lastSources = '';});
    return backendStartup;
  }
  async function retryLocalBackend() {
    if (shuttingDown) throw new Error('程序正在关闭，不能重连播放内核。');
    if (getBackendInfo().pendingHandoff) throw new Error('本地内核正在待命；请明确选择本地曲目播放以核验恢复。');
    // Invalidate immediately, but do not await a potentially hung HTTP fence
    // before retiring this app's independently verified owned process.
    coordinator.cancelPending().catch(() => {});
    const transport = rawFoobar.transportStatus();
    const mustRetire = transport.controlUncertain || transport.pendingControlRequests > 0;
    if (mustRetire && !backend.getInfo().owned && !transport.backendExited) {
      throw new Error('旧控制请求尚未证实结束，且此内核不由本次程序拥有。请先安全关闭该专属内核后重启 STILL；未退出其他进程。');
    }
    const result = await startBackend({start: true, restartOwned: mustRetire});
    if (result.available) await rawFoobar.retryOutput();
    return getBackendInfo();
  }
  async function syncBackend() {
    const epoch = connectionEpoch;
    if (typeof foobar.librarySnapshot === 'function' && typeof library.importFoobar === 'function') {
      const value = await foobar.librarySnapshot();
      if (shuttingDown || shutdownFailure || failures.isFatal() || epoch !== connectionEpoch) return;
      await library.importFoobar(value);
    }
    if (epoch === connectionEpoch) syncedBackend = true;
  }
  function startBackendSync() {
    if (syncPromise || syncedBackend || Date.now() < syncRetryAt || shuttingDown || shutdownFailure || failures.isFatal()) return;
    syncPromise = syncBackend().catch(error => {
      syncRetryAt = Date.now() + 30000;
      emit('error', {channel: 'library:sync', message: `无法同步 foobar2000 播放列表：${error.message}`});
    }).finally(() => {syncPromise = null;});
  }
  protocol.handle('still-cover', async request => {
    try { return await net.fetch(pathToFileURL(await safeCoverPath(request.url, path.join(dataDir, 'covers'))).href); }
    catch { return new Response('Cover unavailable', {status: 404}); }
  });
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({...windowSize(screen.getPrimaryDisplay().workAreaSize), show: false, title: 'STILL · 静室', backgroundColor: '#222421', autoHideMenuBar: true,
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, autoplayPolicy: 'user-gesture-required'}});
  mainWindow.once('ready-to-show', () => {if (!mainWindow.isDestroyed()) mainWindow.show();});
  mainWindow.on('close', event => {if (!shutdownComplete) {event.preventDefault(); app.quit();}});
  const rendererFile = path.join(root, 'src/renderer/index.html');
  const expectedUrl = pathToFileURL(rendererFile).href;
  mainWindow.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  mainWindow.webContents.setAudioMuted(true);
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault());
  mainWindow.webContents.on('console-message', event => runtimeLog.record('renderer-console', {level: event.level, source: event.sourceId, line: event.lineNumber}));
  mainWindow.webContents.on('preload-error', (_event, file) => runtimeLog.record('preload-error', {level: 'error', source: file}));
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    runtimeLog.record('renderer-exited', {level: 'error', exitCode: details.exitCode});
    if (!smokeMode && !shuttingDown) {dialog.showErrorBox('STILL 界面异常退出', `界面进程已退出：${details.reason}。请重新打开 STILL；你的音乐和 foobar2000 设置保留。`); app.quit();}
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  const getRestoreInfo = async () => ({dataDir, foobarDir, audioEngine: 'foobar2000',
    guide: path.join(root, 'docs', 'foobar-install-restore.md'), runtimeRoot,
    message: 'STILL 的库、列表、歌词绑定和偏好在 data。专属 foobar2000 后端在 backend/foobar2000，正常打开 STILL 时由应用管理；不会自动发现或启动原来的 foobar2000。',
    nativeDiagnostics: '若 Beefweb 未返回原始输出错误，则失败原因未确认；不能据此判断设备独占占用。输出与 DAC 实测结果见独立验收记录。',
    backendError: backendInitError || null, managedBackend: getBackendInfo(), library: libraryView.summary(),
    safeOwnedExit: {label: '安全退出遗留后台', ...await getSafeOwnedExitTarget()},
    backend: typeof foobar.restoreInfo === 'function' ? await foobar.restoreInfo() : null});
  let handlers = createHandlers({library, foobar, apple, coordinator, lyrics, settings, dialog, shell, dataDir, emit, window: () => mainWindow, version: app.getVersion(), getRestoreInfo,
    getLibrarySnapshot: async () => {
      const expectedVersion = libraryView.version();
      libraryView.replace(await library.list(), {expectedVersion});
      return libraryView.snapshot();
    },
    getLibraryTracks: () => libraryView.tracks(), getPlayerTracks: state => libraryView.playerTracks(state),
    getQueueTracks: queue => libraryView.queueTracks(queue), getLibraryPlaylist: id => libraryView.getPlaylist(id), libraryReturnsDeltas: true,
    onSettingsChanged: value => metadataCovers?.setContact(value.onlineCovers?.musicBrainzContact || ''), getBackendInfo,
    getSafeOwnedExitTarget, requestSafeOwnedExit: typeof backend.requestSafeOwnedExit === 'function' ? selection => backend.requestSafeOwnedExit(selection) : undefined,
    getRuntimeState: () => ({readOnly: Boolean(shutdownFailure), fatal: failures.isFatal(), shuttingDown}), getLyricsTrack, decorateLibrarySnapshot, decorateTrack,
    readSpectrum: () => spectrumService ? spectrumService.read() : emptySpectrum({reason: 'reader-unavailable'}),
    spectrumSupported: spectrumService !== null,
    persistUIState: !smokeMode,
    exportDiagnostics: smokeMode ? undefined : options => diagnosticExport.exportSnapshot(options),
    observeDiagnosticPlayer: state => {rememberPlayer(state); diagnosticExport.observePlayer(state);},
    observeDiagnosticSources: value => diagnosticExport.observeSources(value),
    observeAppleRead: value => diagnosticExport.observeAppleRead(value),
    retryBackend: smokeMode || process.env.STILL_FOOBAR_DIR ? undefined : retryLocalBackend,
    prepareLibraryPaths: locations => backend.preparePaths({paths: locations, deferRestart: true}),
    prepareLocalPlayback: (input, context) => prepareLocalPlaybackLifecycle({backend, foobar, bridge: rawFoobar,
      isBridgeReady: () => bridgeReady, onBridgeReady: value => {bridgeReady = value;}}, input, context)});
  closePlaybackContext = handlers.closePlaybackContext;
  const invalidatePlaybackContext = handlers.invalidatePlaybackContext;
  rawFoobar.on('handoff', () => {invalidatePlaybackContext(); lastSources = '';});
  const getActualPlayer = handlers['player:state'];
  const simulatedUIFixture = process.env.STILL_SMOKE_LYRICS_FIXTURE === '1';
  handlers = withSmokeLyricsFixture(handlers, {enabled: simulatedUIFixture, smokeMode,
    track: smokeMode ? libraryView.tracks().find(item => item.valid !== false && item.coverUrl && /[\u3400-\u9fff]/.test(item.title)) || libraryView.tracks().find(item => item.valid !== false) : undefined});
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, async (event, payload) => {
    if (!isTrustedApplicationSender(event, mainWindow, expectedUrl)) return {ok: false, error: 'Untrusted application sender'};
    const permission = commandAvailability(channel, {fatal: failures.isFatal(), shuttingDown, readOnly: Boolean(shutdownFailure)});
    if (!permission.ok) return permission;
    if (smokeMode && !SMOKE_READ_CHANNELS.has(channel)) {
      const error = `Read-only desktop smoke blocked command: ${channel}`;
      runtimeLog.record('smoke-blocked', {level: 'error'}); return {ok: false, error};
    }
    const response = await invokeSafely(handler, payload);
    if (!response.ok) emit('error', {channel, message: response.error});
    return response;
  });
  pollController = createRuntimePoll({
    read: async current => {
      const sources = await handlers['source:status']();
      if (!current()) return null;
      const state = await handlers['player:state']();
      return {sources, state};
    },
    publish({sources, state}) {
      if (shuttingDown || failures.isFatal()) return;
      const serializedSources = JSON.stringify(sources);
      if (serializedSources !== lastSources) {lastSources = serializedSources; emit('source', sources);}
      const localAvailable = sources.sources.local.available;
      if (localAvailable) {if (!wasAvailable) syncRetryAt = 0; backendInitError = null; startBackendSync();}
      else {if (wasAvailable) connectionEpoch++; syncedBackend = false;}
      wasAvailable = localAvailable;
      const serialized = JSON.stringify(state);
      if (serialized !== lastState) {lastState = serialized; emit('player', state);}
    },
    onError() {
      runtimeLog.record('poll-failed');
      emit('player', {available: false, state: 'unavailable', source: null, position: 0, duration: 0, volume: null,
        generation: coordinator.currentGeneration(), revision: coordinator.currentRevision(), error: shutdownFailure || '读取播放状态失败。'});
    }
  });
  let shutdownWork = null, normalShutdownDrained = false, normalShutdownResult;
  const beginShutdown = () => {
    if (!shutdownWork) shutdownWork = shutdownDesktop({coordinator, foobar: rawFoobar, backend, syncPromise, smokeMode,
      bridgeSessionBound: rawFoobar.sessionBound(),
      closeServices: [closeMetadataCovers, closeAppleArtwork, () => settings.close(),
        () => library.close(), () => lyrics.close(), () => apple.close(), closePublicFetch]
    }).finally(() => {shutdownWork = null;});
    return shutdownWork;
  };
  fatalCleanup = () => {closeSpectrum(); closePlaybackContext(); return beginShutdown();};
  caughtCleanup = beginShutdown;
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shuttingDown || failures.isFatal()) return;
    // Capture only already-held player artwork before library.close clears its
    // session DTO retention. Current library references remain protected by GC.
    const coverSession = backend.getSession?.(), coverInfo = backend.getInfo();
    const coverEligible = !smokeMode && !shutdownFailure && !caughtFailureWork && coverInfo.owned === true &&
      coverInfo.managed === true && coverInfo.nativeReadySeen === true;
    const retainUrls = retainedPlayerCoverUrls(cachedPlayer);
    // A caught-startup recovery can still finish a later user-requested quit.
    // Its sticky failure blocks new GC above, not the quit continuation itself.
    const currentNormalShutdown = () => shuttingDown && !failures.isFatal();
    shuttingDown = true; backendStartupController.abort(); pollController?.stop();
    // A completed cover-writer drain remains valid in read-only recovery. A
    // retry observes the original GC directly instead of library.close waiting
    // for it again on the shared data-service queue.
    const drained = normalShutdownDrained ? Promise.resolve(normalShutdownResult) : beginShutdown().then(result => {
      normalShutdownDrained = true; normalShutdownResult = result; return result;
    });
    drained.then(async result => {
      if (!currentNormalShutdown()) return;
      const {isVerifiedBackendTreeExit} = require('./backend');
      await shutdownCoverGc.finish({eligible: coverEligible && typeof isVerifiedBackendTreeExit === 'function' &&
        isVerifiedBackendTreeExit(result?.exitEvidence, coverSession), retainUrls, isCurrent: currentNormalShutdown});
      if (!currentNormalShutdown()) return;
      closeSpectrum(); closePlaybackContext();
      await diagnosticExport.close();
      if (!currentNormalShutdown()) return;
      shutdownComplete = true; failures.dispose();
      smokeMode ? app.exit(process.exitCode || 0) : app.quit();
    }).catch(() => {
      shutdownFailure = '安全退出尚未完成；当前仅保留只读状态与诊断，播放和更改操作已关闭。请查看诊断后再次退出。';
      runtimeLog.record('shutdown-failed', {level: 'error', code: 'STILL_SHUTDOWN_FAILED'});
      if (failures.isFatal()) return;
      if (smokeMode) {process.exitCode = 1; app.exit(1); return;}
      shuttingDown = false;
      // Keep live read services until backend exit is verified. Never reopen the coordinator.
      pollController?.start();
      if (mainWindow && !mainWindow.isDestroyed()) {mainWindow.show(); mainWindow.focus();}
      emit('error', {channel: 'app:shutdown', message: shutdownFailure});
      dialog.showErrorBox('STILL 尚未完成退出', shutdownFailure);
    });
  });
  const startup = await revealBeforeBackend({openWindow: async () => {
    await mainWindow.loadFile(rendererFile);
    if (!mainWindow.isDestroyed()) mainWindow.show();
  }, initialize: () => startBackend({start: !smokeMode && !process.env.STILL_FOOBAR_DIR})});
  startup.completion.catch(error => {
    if (requiresAbnormalStartupExit(backend, error) || requiresGracefulStartupFailure(backend)) {void handleStartupError(error); return;}
    backendInitError = '专属播放内核未能就绪，可查看诊断后重试。'; backendStarting = false; lastSources = '';
  });
  Promise.resolve().then(() => {if (!shuttingDown && !shutdownFailure && !failures.isFatal()) return apple.initialize();}).catch(() => {lastSources = '';});
  if (!shuttingDown && !shutdownComplete) {pollController.start(); await pollController.tick();}
  assertActive();
  if (smokeMode) {
    let report;
    try {
      const plan = process.env.STILL_SMOKE_PLAN ? JSON.parse(await fs.readFile(path.resolve(process.env.STILL_SMOKE_PLAN), 'utf8')) : undefined;
      report = await runDesktopSmoke({mainWindow, dataDir, version: app.getVersion(), getState: handlers['player:state'], getActualState: getActualPlayer, simulatedUIFixture, diagnostics: runtimeLog.snapshot().entries, plan});
      runtimeLog.record('smoke-complete', {level: report.passed ? 'info' : 'error'});
    } catch (error) {
      report = {passed: false, error: '界面只读检查失败。', diagnostics: runtimeLog.snapshot().entries};
      await fs.writeFile(path.join(dataDir, 'desktop-smoke.json'), JSON.stringify(report, null, 2));
    } finally {process.exitCode = report?.passed ? 0 : 1; app.quit();}
  }
  } catch (error) {
    if (!failures.isFatal() && (shuttingDown || shutdownFailure || shutdownComplete)) return;
    pollController?.stop();
    await handleStartupError(error);
  }
  } catch (error) {await handleStartupError(error);}
}
module.exports = {APPLE_PLAYBACK_MAINTENANCE, createHandlers, invokeSafely, mapPlayer, mapQueue, safeCoverPath, resolveFoobarDir, initializeBackend, requiresAbnormalStartupExit, prepareLocalPlaybackLifecycle, prepareAppleHandoffLifecycle, revealBeforeBackend, guardFoobarService, settleWithin, shutdownDesktop, createAppleAdapter, unavailableAppleService, withSmokeLyricsFixture, windowSize, validateDiagnosticLayout, validateSmokePlan, runDesktopSmoke, registerApplicationSchemes, createAppleMusicIntegration, createLyricsTrackResolver, isTrustedApplicationSender, isApprovedPublicRequest, createPublicFetchService, run};
