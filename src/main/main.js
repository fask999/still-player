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
const {createNativeCoverTransform} = require('./native-cover-transform');
const {createDesktopIntegration, desktopWindowOptions} = require('./desktop-integration');
const {createDesktopArtworkReader} = require('./desktop-artwork');
const {readDesktopMediaRuntimeAssets} = require('./backend-job');
const {createCueInspector} = require('./cue-inspector');
const {createCuePlaybackGuard} = require('./cue-playback-guard');
const {verifyExistingContextScope} = require('./existing-context-scope');
const {createDacAuthorizationService} = require('./dac-authorization');
const {createDacAuthorizationStore} = require('./dac-authorization-store');
const {createDacIdentityReader, DAC_IDENTITY_PROBE_SHA256} = require('./dac-identity');
const dacContextChanged = () => Object.assign(new Error('当前设备或会话已改变，请重新发起 DAC 授权。'), {code: 'STILL_DAC_CONTEXT_CHANGED'});
function sameDacState(left, right) {
  return Boolean(left && right && left.session === right.session && left.selectionEpoch === right.selectionEpoch &&
    left.output.typeId === right.output.typeId && left.output.deviceId === right.output.deviceId && left.output.endpoint === right.output.endpoint);
}
function currentOwnedDacState(rawFoobar, backend) {
  const state = rawFoobar.getDacAuthorizationState?.(), info = backend.getInfo();
  return state?.session && info.owned === true && info.available === true && !info.pendingHandoff && state.session === backend.getSession?.() ? state : null;
}
function createDacCurrentReaders({rawFoobar, backend, coordinator, isActive}) {
  function getCurrent() {
    if (!isActive()) return null;
    const state = currentOwnedDacState(rawFoobar, backend);
    const versionScope = state && backend.getDacVersionScope?.(state.session);
    return versionScope ? {...state, generation: coordinator.currentGeneration(), versionScope} : null;
  }
  return {getCurrent, async readCurrent({signal} = {}) {
    const before = getCurrent();
    if (!before || signal?.aborted) return null;
    const fresh = await rawFoobar.readDacAuthorizationState({signal}), current = getCurrent();
    return !signal?.aborted && sameDacState(before, fresh) && sameDacState(before, current) && before.generation === current.generation &&
      JSON.stringify(before.versionScope) === JSON.stringify(current.versionScope) ? current : null;
  }};
}
function createDacWindowConfirmation({dialog, getWindow, getGeneration, getSignal, isActive}) {
  return async (preview, caller) => {
    const window = getWindow(), signal = getSignal();
    const current = () => !signal.aborted && isActive() && window && window === getWindow() && !window.isDestroyed() &&
      window.webContents === caller.sender && caller.windowGeneration === getGeneration();
    if (!current() || !['hardware-instance', 'windows-endpoint'].includes(preview?.scope)) return false;
    const endpointOnly = preview.scope === 'windows-endpoint';
    const labels = {'exclusive-check': '短暂申请所选 PCM 格式的独占音频流并释放',
      'owned-exit-fallback': '交接条件满足时正常关闭 STILL 的专属播放内核'};
    const scopeDetail = endpointOnly ? [
      '本次授权只绑定这台电脑上当前的 Windows 音频端点。',
      '此范围可用于缺少可确认的稳定唯一标识的设备。',
      '换接口、端点 GUID 变化或设备重新枚举后，需要再次确认。',
      '如果 Windows 无法区分替换后的物理设备，这项授权也无法区分。'
    ] : [
      '此授权绑定经核验的 USB 硬件实例和当前 Windows 音频端点。',
      '换接口、端点 GUID 变化或设备重新枚举后，需要重新核验并确认。'
    ];
    const detail = [...scopeDetail, ...preview.capabilities.map(capability => labels[capability]),
      `验证格式为 48 kHz、${preview.validationFormat.bits} 位、双声道 PCM。`, '授权期限为 30 天，可在音频设置中撤销。'].join('\n');
    const result = await dialog.showMessageBox(window, {type: 'warning', title: endpointOnly ? 'USB DAC Windows 端点授权' : 'USB DAC 硬件实例授权',
      message: endpointOnly ? '授权 STILL 使用这台电脑上的当前 Windows 音频端点？' : '授权 STILL 使用这台 USB 设备和当前 Windows 音频端点？',
      detail, buttons: ['取消', '确认授权'], cancelId: 0, defaultId: 0, noLink: true, signal});
    return Boolean(current() && result?.response === 1);
  };
}
async function verifyAppleOutputRelease({rawFoobar, backend, isActive, readFixedOutput}, {context, signal, check: externalCheck} = {}) {
  if (!context || typeof context !== 'object') throw dacContextChanged();
  let expected;
  const check = () => {
    externalCheck?.();
    context?.check?.();
    if (signal?.aborted || !isActive() || expected && !sameDacState(expected, currentOwnedDacState(rawFoobar, backend))) throw dacContextChanged();
  };
  check();
  if (readFixedOutput) {
    const output = await readFixedOutput(); check();
    if (!output) throw dacContextChanged();
    const proof = await backend.waitForExclusiveAccess({output, context, signal, check});
    check(); return proof;
  }
  const before = currentOwnedDacState(rawFoobar, backend);
  if (!before) throw dacContextChanged();
  const fresh = await rawFoobar.readDacAuthorizationState({signal}); check();
  if (!sameDacState(before, fresh)) throw dacContextChanged();
  expected = fresh; check();
  const proof = await backend.waitForExclusiveAccess({session: fresh.session, output: fresh.output, context, signal, check});
  check(); return proof;
}
function beginCueShutdown(cueDiscovery) {
  let closing;
  try {closing = Promise.resolve(cueDiscovery?.close());}
  catch (error) {closing = Promise.reject(error);}
  // Closing invalidates discovery synchronously. Retain a failure for the
  // shutdown waiter even when backend exit takes longer than this promise.
  closing.catch(() => {});
  return closing;
}
async function waitForShutdownServices(...services) {
  const settled = await Promise.allSettled(services), failure = settled.find(value => value.status === 'rejected');
  if (failure) throw failure.reason;
}
function createDesktopPlaybackCallbacks({coordinator, mapState = value => value, getRuntimeState = () => ({})}) {
  const checkWritable = () => {
    const permission = commandAvailability('player:stop', getRuntimeState());
    if (!permission.ok) throw new Error(permission.error);
  };
  const mapCurrentState = state => {
    if (typeof coordinator.currentGeneration === 'function' && state.generation !== coordinator.currentGeneration()) {
      throw Object.assign(new Error('当前播放来源或状态已改变。'), {code: 'STILL_CONTEXT_CHANGED'});
    }
    return mapState(state);
  };
  return {
    async performAction({action, source, generation, position} = {}) {
      checkWritable();
      if (!['play', 'pause', 'toggle', 'stop', 'next', 'previous', 'seek'].includes(action) ||
          !['local', 'apple'].includes(source) || !Number.isSafeInteger(generation) || generation < 0 ||
          action === 'seek' && (!Number.isFinite(position) || position < 0 || position > 604800)) throw new Error('桌面播放操作无效。');
      return mapCurrentState(await coordinator.commandForCurrentSource(source, generation, action === 'play' ? 'toggle' : action,
        ...(action === 'seek' ? [position] : [])));
    },
    async stopAndRelease(input) {
      checkWritable();
      if (typeof input?.isCurrent !== 'function') throw new Error('定时停止上下文无效。');
      const result = await coordinator.stopAndReleaseForCurrentSource(input);
      if (input.signal?.aborted || !input.isCurrent()) throw Object.assign(new Error('定时停止已取消。'), {code: 'STILL_CANCELLED'});
      return {...result, state: mapCurrentState(result.state)};
    }
  };
}
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
async function prepareLocalPlaybackLifecycle({backend, foobar, bridge, isBridgeReady, onBridgeReady, getCuePlaybackRequests}, input, context) {
  context.check();
  const cueRequests = getCuePlaybackRequests ? await getCuePlaybackRequests(input.locations) : [];
  context.check();
  const paths = [...new Set([...input.locations.map(item => item.path), ...cueRequests.flatMap(request => [request.path, ...request.references])])];
  const prepared = await backend.preparePaths({paths, deferRestart: true}); context.check();
  const before = backend.getInfo();
  let connected = false;
  if (prepared.restartRequired || !before.available || !isBridgeReady()) {
    // A retired handoff lifetime has no state or device to probe. Only the
    // explicit local-play request below may construct its fresh replacement.
    if (!before.pendingHandoff) {
      await foobar.cancelPending(); context.check();
      const current = await foobar.getState(); context.check();
      if (current.available) {await foobar.stop(context); context.check();}
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
  const canRead = () => {const info = getBackendInfo(); return !info.pendingHandoff && info.status !== 'standby' &&
    ((info.verified ?? info.available) || info.readVerified === true);};
  const canAccess = () => {const info = getBackendInfo(); return !info.pendingHandoff && info.status !== 'standby' &&
    info.available === true && (info.verified ?? true);};
  const offline = async () => {
    const info = getBackendInfo();
    return {available: false, state: 'unavailable', position: 0, duration: 0, volume: null, currentTrack: null,
      backendReachable: false, ...(!info.pendingHandoff && info.status !== 'standby' && typeof service.outputConnection === 'function' ? {outputConnection: await service.outputConnection()} : {}),
      error: info.error || (info.status === 'starting' ? '专属本地内核正在启动。' : '专属本地内核尚未通过进程与端口核验。')};
  };
  return new Proxy(service, {get(target, name) {
    if (name === 'playbackContext') return (...args) => canRead() ? target.playbackContext(...args) :
      Promise.resolve({status: 'unavailable', playlist: null, currentIndex: null, items: [], reason: 'backend-unavailable'});
    if (name === 'getState') return () => canRead() ? target.getState() : offline();
    if (name === 'audioDetails') return () => target.audioDetails({readBackend: Boolean(canRead())});
    if (name === 'capabilities') return () => ({...target.capabilities(), ...(!canAccess() ? {playback: false, installedOrReachable: false} : {})});
    const value = target[name];
    if (typeof value !== 'function') return value;
    if (['initialize', 'cancelPending', 'close', 'restoreInfo', 'on', 'off', 'disposeAfterProcessExit', 'outputConnection', 'transportStatus',
      'getHandoffStatus', 'finishOutputHandoff', 'prepareOutputHandoff', 'releaseOutput', 'getAudioTransportStatus', 'needsColdHandoffRestore'].includes(name)) return value.bind(target);
    if (['outputs', 'queueList', 'librarySnapshot'].includes(name)) return (...args) => {
      if (!canRead()) return offline().then(state => {throw new Error(state.error);});
      return value.apply(target, args);
    };
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
async function shutdownDesktop({coordinator, foobar, backend, desktop, cueDiscovery, cuePlaybackGuard, closeServices = [], syncPromise, smokeMode = false,
  bridgeSessionBound = true, stopGraceMs = 500, drainTimeoutMs = 5000}) {
  const desktopDone = desktop?.beginShutdown();
  const cueDone = beginCueShutdown(cueDiscovery);
  cuePlaybackGuard?.beginShutdown();
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
  let result;
  try {result = await backend.close();}
  finally {await waitForShutdownServices(desktopDone, cueDone, cuePlaybackGuard?.close());}
  if (result?.exitEvidence && bridgeSessionBound) foobar.markBackendExited(result.exitEvidence);
  else if (owned && bridgeSessionBound) throw new Error('专属后端未提供经核验的退出证据；未宣称关闭成功。');
  const drains = Promise.resolve(desktopDone).then(() => Promise.all([coordinatorDone, foobar.close(), ...closeServices.map(close => close()), Promise.resolve(syncPromise)]));
  const outcome = await settleWithin(drains, drainTimeoutMs);
  if (!outcome.settled) throw new Error('专属进程退出后，仍未确认所有控制与数据保存结束。窗口保留，可查看诊断后再次退出。');
  if (outcome.error) throw outcome.error;
  return result;
}
async function run({runtimeBoundary} = {}) {
  // Install synchronously before Electron import, filesystem IO or any await.
  let runtimeApp = null, mainWindow, desktop, cueDiscovery, cuePlaybackGuard, pollController, backendStartupController, quiesceWrites = () => {}, cancelCoverCollection = () => {};
  let dacAuthorization, windowGeneration = 0, dacDialogController = new AbortController();
  const dacOperations = new Set();
  const drainDacOperations = () => Promise.allSettled([...dacOperations]);
  function invalidateDacAuthorization(windowChanged = false) {
    if (windowChanged) windowGeneration++;
    dacDialogController.abort(); dacDialogController = new AbortController();
    dacAuthorization?.invalidate();
  }
  const fatalServices = [];
  let shuttingDown = false, shutdownComplete = false, shutdownFailure = null,
    fatalCleanup = async () => {await waitForShutdownServices(desktop?.beginShutdown(), beginCueShutdown(cueDiscovery)); return Promise.allSettled(fatalServices.map(close => Promise.resolve().then(close)));};
  let caughtCleanup = async () => {await waitForShutdownServices(desktop?.beginShutdown(), beginCueShutdown(cueDiscovery)); return Promise.allSettled(fatalServices.map(close => Promise.resolve().then(close)));}, backendForRecovery = null,
    caughtFailureWork = null, disposeReadServices = () => {};
  const runtimeLog = runtimeBoundary?.log || createRuntimeLog();
  const onFatal = () => {
    invalidateDacAuthorization(true);
    desktop?.beginShutdown();
    beginCueShutdown(cueDiscovery);
    cuePlaybackGuard?.beginShutdown();
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
    invalidateDacAuthorization(true);
    desktop?.beginShutdown();
    const cueDone = beginCueShutdown(cueDiscovery);
    cuePlaybackGuard?.beginShutdown();
    shuttingDown = true; pollController?.stop(); backendStartupController?.abort(); quiesceWrites(); cancelCoverCollection();
    runtimeLog.record('startup-failed', {level: 'error'});
    caughtFailureWork = (async () => {
      // The primary manager's ownership says nothing about an isolated CUE
      // child or a retained read holder. Obtain separate drain evidence within
      // the same startup cleanup budget before considering a shortcut exit.
      const cueDrain = settleWithin(waitForShutdownServices(cueDone, cuePlaybackGuard?.close()).then(() => true), 10000);
      const outcome = await settleWithin(Promise.resolve().then(caughtCleanup), 10000);
      const cueOutcome = await cueDrain;
      const cueDrained = cueOutcome.settled && cueOutcome.value === true;
      // Read the private manager again at the actual exit decision. Native READY
      // may arrive during cleanup and permanently revokes the never-READY exception.
      const info = backendForRecovery?.getInfo();
      const noOwnedProcess = !info || info.owned === false;
      const neverReady = backendForRecovery && requiresAbnormalStartupExit(backendForRecovery, error);
      if (neverReady && cueDrained) {
        // No await between the fresh native-READY check and abnormal exit.
        disposeReadServices(); failures.dispose();
        runtimeApp ? runtimeApp.exit(1) : process.exit(1);
        return;
      }
      if ((outcome.settled && !Object.hasOwn(outcome, 'error')) || (noOwnedProcess && cueDrained)) {
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
  const {app, BrowserWindow, ipcMain, protocol, net, session, dialog, shell, Menu, screen, safeStorage, nativeTheme, nativeImage, powerSaveBlocker, globalShortcut} = require('electron');
  runtimeApp = app;
  registerApplicationSchemes(protocol);
  const root = path.resolve(__dirname, '../..');
  const runtimeRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : root;
  const {readPublicInstallation, publicInstallationPaths, assertPublicDataPaths} = require('./public-installation');
  const publicInstallation = await readPublicInstallation(root); assertActive();
  const publicPaths = publicInstallation ? publicInstallationPaths({marker: publicInstallation,
    localAppData: process.env.LOCALAPPDATA, dataOverride: process.env.STILL_DATA_DIR}) : null;
  const diagnosticFoobarOverride = !publicInstallation && Boolean(process.env.STILL_FOOBAR_DIR);
  const dataDir = publicPaths?.dataDir || (process.env.STILL_DATA_DIR ? path.resolve(process.env.STILL_DATA_DIR) : path.join(runtimeRoot, 'data'));
  // The product never discovers or launches the original ancestor installation.
  // STILL_FOOBAR_DIR is an explicit developer diagnostic override only.
  const foobarDir = publicPaths?.backendDir || await resolveFoobarDir(runtimeRoot, process.env.STILL_FOOBAR_DIR); assertActive();
  if (publicInstallation) {await assertPublicDataPaths(dataDir); assertActive();}
  // Keep Chromium cache and user preferences portable too.
  await fs.mkdir(path.join(dataDir, 'electron', 'session'), {recursive: true}); assertActive();
  if (publicInstallation) {await assertPublicDataPaths(dataDir); assertActive();}
  app.setPath('userData', path.join(dataDir, 'electron'));
  app.setPath('sessionData', path.join(dataDir, 'electron', 'session'));
  if (!app.requestSingleInstanceLock()) {runtimeLog.record('single-instance', {level: 'error'}); failures.dispose(); app.exit(process.env.STILL_SMOKE_TEST === '1' ? 1 : 0); return;}
  const smokeMode = process.env.STILL_SMOKE_TEST === '1';
  const dacWritable = () => !smokeMode && !shuttingDown && !shutdownFailure && !failures.isFatal();
  const metadataStreamUUID = randomUUID(); let metadataSequence = 0;
  let spectrumClient = null;
  let lastState = '', lastSources = '', syncedBackend = false, syncPromise = null, syncRetryAt = 0, libraryView = null, connectionEpoch = 0, wasAvailable = false;
  let coordinator, emittedGeneration = -1, emittedRevision = -1, cachedPlayer = null, spectrumService = null;
  const rememberPlayer = value => {
    if (shuttingDown || failures.isFatal() || value.simulatedUIFixture === true) return;
    if (value.generation < (coordinator?.currentGeneration() ?? 0) || (cachedPlayer && (value.generation < cachedPlayer.generation ||
        (value.generation === cachedPlayer.generation && value.revision < cachedPlayer.revision)))) return;
    cachedPlayer = value;
    desktop?.observePlayer(value);
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
  cueDiscovery = createCueInspector({runtimeRoot: root, dataDir, enabled: !smokeMode, onProgress: value => emit('cue-discovery', value)});
  const {createLibraryService} = require('./library');
  const {createFoobarService} = require('./foobar');
  const {createBackendManager, isVerifiedBackendSession} = require('./backend');
  const {createLyricsService} = require('./lyrics');
  const {createQqLyricsClient} = require('./qq-lyrics');
  let metadataCovers = null;
  const decorateTrack = value => metadataCovers && !shuttingDown && !shutdownFailure && !failures.isFatal() ? metadataCovers.decorateTrack(value) : value;
  const decorateLibrarySnapshot = value => ({...value, tracks: value.tracks.map(decorateTrack),
    eventCursors: {...value.eventCursors, metadata: {streamId: metadataStreamUUID, sequence: metadataSequence}}});
  libraryView = createLibraryView();
  const library = createLibraryService({dataDir, coverTransform: createNativeCoverTransform(nativeImage),
    cueInspector: request => cueDiscovery.inspect(request), verifyExistingContextScope, returnDeltas: true, onDelta: delta => {
    if (!libraryView.apply(delta)) return;
    if (delta.removedTrackIds?.length) metadataCovers?.forgetTracks(delta.removedTrackIds);
    emit('library', {...delta, tracks: delta.tracks.map(decorateTrack)});
  }, dialog, shell});
  fatalServices.push(() => library.close());
  const shutdownCoverGc = createShutdownCoverGc({library, record: (event, details) => runtimeLog.record(event, details)});
  cancelCoverCollection = shutdownCoverGc.cancel;
  const bootstrap = publicInstallation ? require('./backend-bootstrap').createBackendBootstrap({appRoot: root, dataDir,
    backendDir: foobarDir, manifestPath: publicInstallation.backendBootstrapManifest,
    onUpdate: value => {lastSources = ''; emit('backend-setup', value);}}) : null;
  if (bootstrap) {fatalServices.push(() => bootstrap.close()); await bootstrap.initialize(); assertActive();}
  const probePath = path.join(root, 'scripts', 'foobar-coreaudio-probe.exe');
  const backend = createBackendManager({dataDir, backendDir: foobarDir,
    quietRestartPolicy: 'stopped-owned-exit',
    ...(publicInstallation ? {requireOwnedSession: true, requirePublicProvenance: true, startStopped: true,
      publicFiles: bootstrap.getExpectedFiles(), dacProbeSha256: DAC_IDENTITY_PROBE_SHA256,
      async authorizeDacOutput(input) {
        if (!dacAuthorization || !dacWritable()) return null;
        const check = () => {input.context?.check?.(); if (input.signal?.aborted || !dacWritable()) throw dacContextChanged();};
        check(); const permit = await dacAuthorization.issueUsePermit(input); check();
        return dacAuthorization.consumeUsePermit(permit, input);
      }} : {ownedExitOutputPolicy: 'dx1-wasapi-in-process-v1'}), probePath});
  backendForRecovery = backend;
  const getCuePlaybackRequests = (locations, options) => library.getCuePlaybackRequests(locations, options);
  cuePlaybackGuard = createCuePlaybackGuard({runtimeRoot: root, getRequests: getCuePlaybackRequests,
    getTreeExitEvidence: token => backend.getVerifiedOwnedTreeExit?.(token),
    onTreeExit: listener => backend.subscribeVerifiedOwnedTreeExit?.(listener),
    onError: ({code}) => runtimeLog.record('cue-playback-guard', {code})});
  fatalCleanup = async () => {
    const desktopDone = desktop?.beginShutdown();
    const cueDone = beginCueShutdown(cueDiscovery);
    cuePlaybackGuard.beginShutdown();
    coordinator?.beginShutdown(); closeSpectrum(); closePlaybackContext();
    try {await backend.close();} finally {await waitForShutdownServices(desktopDone, cueDone, cuePlaybackGuard.close());}
    await Promise.allSettled(fatalServices.map(close => Promise.resolve().then(close)));
  };
  caughtCleanup = async () => {
    const desktopDone = desktop?.beginShutdown();
    const cueDone = beginCueShutdown(cueDiscovery);
    cuePlaybackGuard.beginShutdown();
    coordinator?.beginShutdown();
    try {await backend.close();} finally {await waitForShutdownServices(desktopDone, cueDone, cuePlaybackGuard.close());}
    await Promise.all(fatalServices.map(close => Promise.resolve().then(close)));
  };
  backendStartupController = new AbortController();
  let backendStartup = null, backendStarting = true, bridgeReady = false, bridgeReachable = false, backendInitError = null;
  let publicSetupWork = null, publicSetupController = null, publicSetupConnecting = false;
  let getCachedLocalHandoff = () => null, localReadHealth = {};
  const getSafeOwnedExitTarget = () => typeof backend.getSafeOwnedExitTarget === 'function' ? backend.getSafeOwnedExitTarget() :
    {available: false, refused: true, code: 'STILL_BACKEND_OWNERSHIP_UNVERIFIED',
      reason: '未找到本次应用创建记录与实时身份均可核验的后台。', selectionToken: null, target: null};
  const getBackendInfo = () => {
    const info = backend.getInfo(), pendingRestore = getCachedLocalHandoff()?.pendingRestore === true;
    if (bootstrap && !bootstrap.getStatus().prepared) return {...info, available: false, verified: false,
      readVerified: false, status: 'setup-required', setupRequired: true, error: '请先完成本地播放内核的首次设置。'};
    const session = backend.getSession?.();
    // Read admission belongs to an already-bound, current branded lifetime.
    // It survives a failed first GET, without admitting controls or adopting a
    // different process. Handoff/retirement/quit close it synchronously.
    const readVerified = !backendStarting && !shuttingDown && !shutdownFailure && !failures.isFatal() &&
      !pendingRestore && !info.pendingHandoff && info.available === true && info.owned === true && info.status === 'ready' &&
      rawFoobar.canReadSession?.(session) === true && isVerifiedBackendSession(session, {foobarDir: info.foobarDir, baseUrl: info.baseUrl}) &&
      session.pid === info.pid;
    return {...info, ...localReadHealth, available: info.available && bridgeReady && bridgeReachable && !pendingRestore,
      verified: info.available && bridgeReady && !pendingRestore, readVerified, pendingHandoff: info.pendingHandoff === true || pendingRestore,
      ...(backendStarting ? {status: 'starting'} : {}), ...(backendInitError ? {error: backendInitError} : {}),
      ...(shutdownFailure ? {available: false, status: 'failed', error: shutdownFailure} : {})};
  };
  let lastPrivateOutput = null;
  const rawFoobar = createFoobarSessionService({createService: createFoobarService, backend,
    serviceOptions: {dataDir, foobarDir, cuePlaybackGuard, pollIntervalMs: 0, persistOutputSelection: !smokeMode,
      onDacAuthorizationInvalidated: invalidateDacAuthorization,
      onAudioDispatch: event => spectrumService?.onAudioDispatch(event),
      onControlTrace: event => runtimeLog.record('local-control-trace', event),
      probePath,
      waitForOutputRelease: args => backend.waitForOutputRelease(args)},
    onUpdate: state => {
      localReadHealth = {connectionStatus: state.connectionStatus, stale: state.stale,
        consecutiveReadFailures: state.consecutiveReadFailures, lastGoodAt: state.lastGoodAt};
      bridgeReachable = state.backendReachable ?? state.available === true;
      if (bridgeReachable && state.available === true && state.stale !== true && getBackendInfo().readVerified) {
        bridgeReady = true;
        if (bootstrap && !bootstrap.getStatus().ready && state.controlUncertain !== true) bootstrap.markReady(backend.getSession(), backend.getInfo());
        if (state.controlUncertain !== true) backendInitError = null;
      }
      if (!publicInstallation && state.output) lastPrivateOutput = state.output;
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
      verifyOutputReleased: args => verifyAppleOutputRelease({rawFoobar, backend, isActive: dacWritable,
        readFixedOutput: publicInstallation ? undefined : async () => (await foobar.getState()).output || lastPrivateOutput}, args)}});
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
  if (publicInstallation && !smokeMode) {
    try {
      const requireEncryption = () => {
        if (safeStorage?.isEncryptionAvailable() !== true || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('DAC 授权需要可用的系统加密。');
      };
      requireEncryption();
      const store = createDacAuthorizationStore({dataDir,
        seal: value => {requireEncryption(); return safeStorage.encryptString(value);},
        unseal: value => {requireEncryption(); return safeStorage.decryptString(value);}});
      dacAuthorization = createDacAuthorizationService({store, readIdentity: createDacIdentityReader({probePath, probeSha256: DAC_IDENTITY_PROBE_SHA256}),
        ...createDacCurrentReaders({rawFoobar, backend, coordinator, isActive: dacWritable}), isVerifiedSession: isVerifiedBackendSession,
        confirmUser: createDacWindowConfirmation({dialog, getWindow: () => mainWindow, getGeneration: () => windowGeneration,
          getSignal: () => dacDialogController.signal, isActive: dacWritable})});
      fatalServices.push(drainDacOperations);
    } catch {runtimeLog.record('service-unavailable');}
  }
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
    if (bootstrap && !bootstrap.getStatus().prepared) {backendStarting = false; return getBackendInfo();}
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
          if (bridgeReady && bootstrap) bootstrap.markReady(backend.getSession(), info);
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
    if (bootstrap && !bootstrap.getStatus().prepared) throw new Error('请先完成本地播放内核的首次设置。');
    if (shuttingDown) throw new Error('程序正在关闭，不能重连播放内核。');
    if (getBackendInfo().pendingHandoff) throw new Error('本地内核正在待命；请明确选择本地曲目播放以核验恢复。');
    invalidateDacAuthorization();
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
  function completePublicBackendSetup() {
    if (publicSetupWork) return publicSetupWork;
    const controller = new AbortController(); publicSetupController = controller;
    const checkSetup = () => {
      if (controller.signal.aborted || shuttingDown || shutdownFailure || failures.isFatal()) throw Object.assign(new Error('内置内核准备已暂停，可稍后重试。'), {code: 'STILL_SETUP_CANCELLED'});
    };
    publicSetupWork = (async () => {
      checkSetup();
      if (bootstrap.getStatus().automatic && !bootstrap.getStatus().prepared) {await bootstrap.begin(); checkSetup();}
      const musicDirs = [...new Set(libraryView.tracks().map(track => path.win32.dirname(track.path)))];
      await bootstrap.complete({musicDirs}); checkSetup();
      publicSetupConnecting = true;
      const info = await startBackend();
      checkSetup();
      // A recoverable first bridge GET is not a failed native Job lifetime.
      // Keep the bound read path alive; branded fresh recovery can mark ready.
      return {...bootstrap.getStatus(), backendReady: info.available === true};
    })().finally(() => {publicSetupConnecting = false; publicSetupWork = null; if (publicSetupController === controller) publicSetupController = null;});
    return publicSetupWork;
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
  const placement = desktopWindowOptions({settings: settings.get(), screen});
  mainWindow = new BrowserWindow({...placement.options, show: false, title: 'STILL · 静室', backgroundColor: '#222421', autoHideMenuBar: true,
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, autoplayPolicy: 'user-gesture-required'}});
  mainWindow.once('ready-to-show', () => {if (!mainWindow.isDestroyed()) mainWindow.show();});
  invalidateDacAuthorization(true);
  mainWindow.once('closed', () => invalidateDacAuthorization(true));
  mainWindow.webContents.on('did-start-navigation', (details, _url, _inPlace, isMainFrame) => {
    if (details?.isMainFrame === true || isMainFrame === true) invalidateDacAuthorization(true);
  });
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
    invalidateDacAuthorization(true);
    runtimeLog.record('renderer-exited', {level: 'error', exitCode: details.exitCode});
    if (!smokeMode && !shuttingDown) {desktop?.beginShutdown(); beginCueShutdown(cueDiscovery); cuePlaybackGuard?.beginShutdown(); dialog.showErrorBox('STILL 界面异常退出', `界面进程已退出：${details.reason}。请重新打开 STILL；你的音乐和 foobar2000 设置保留。`); app.quit();}
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  const getRestoreInfo = async () => ({dataDir, foobarDir, audioEngine: 'foobar2000',
    guide: path.join(root, 'docs', publicInstallation ? 'public-installer.md' : 'foobar-install-restore.md'), runtimeRoot,
    message: publicInstallation ? 'STILL 数据与首次准备的播放内核保存在当前用户的本地 STILL 目录；不会自动发现或改动其他 foobar2000 安装和资料。' :
      'STILL 的库、列表、歌词绑定和偏好在 data。专属 foobar2000 后端在 backend/foobar2000，正常打开 STILL 时由应用管理；不会自动发现或启动原来的 foobar2000。',
    nativeDiagnostics: '若 Beefweb 未返回原始输出错误，则失败原因未确认；不能据此判断设备独占占用。输出与 DAC 实测结果见独立验收记录。',
    backendError: backendInitError || null, managedBackend: getBackendInfo(), library: libraryView.summary(),
    safeOwnedExit: {label: '安全退出遗留后台', ...await getSafeOwnedExitTarget()},
    backend: typeof foobar.restoreInfo === 'function' ? await foobar.restoreInfo() : null});
  let handlers = createHandlers({library, foobar, apple, coordinator, lyrics, settings, dialog, shell, dataDir, emit, window: () => mainWindow, version: app.getVersion(), getRestoreInfo, dacAuthorization,
    backendSetup: bootstrap ? {status: () => ({...bootstrap.getStatus(), public: true,
      code: bootstrap.getStatus().code || (bootstrap.getStatus().prepared && !bootstrap.getStatus().ready && backendInitError ? 'STILL_BACKEND_CONNECTION_FAILED' : null),
      busy: Boolean(publicSetupWork) || bootstrap.getStatus().busy, connecting: publicSetupConnecting}),
    begin: () => bootstrap.getStatus().automatic ? completePublicBackendSetup() : bootstrap.begin(), complete: completePublicBackendSetup,
    cancel: () => {
      if (publicSetupConnecting) throw new Error('正在核验已启动的内核连接；需要离开时请正常退出 STILL。');
      publicSetupController?.abort(); return bootstrap.cancel();
    }} : null,
    getLibrarySnapshot: async () => {
      const expectedVersion = libraryView.version();
      libraryView.replace(await library.list(), {expectedVersion});
      return libraryView.snapshot();
    },
    getLibraryTracks: () => libraryView.tracks(), getPlayerTracks: state => libraryView.playerTracks(state),
    getQueueTracks: queue => libraryView.queueTracks(queue), getLibraryPlaylist: id => libraryView.getPlaylist(id), libraryReturnsDeltas: true,
    onSettingsChanged: value => {metadataCovers?.setContact(value.onlineCovers?.musicBrainzContact || ''); desktop?.observeSettings(value);}, getBackendInfo,
    getSafeOwnedExitTarget, requestSafeOwnedExit: typeof backend.requestSafeOwnedExit === 'function' ? selection => backend.requestSafeOwnedExit(selection) : undefined,
    getRuntimeState: () => ({readOnly: Boolean(shutdownFailure), fatal: failures.isFatal(), shuttingDown}), getLyricsTrack, decorateLibrarySnapshot, decorateTrack,
    readSpectrum: () => spectrumService ? spectrumService.read() : emptySpectrum({reason: 'reader-unavailable'}),
    spectrumSupported: spectrumService !== null,
    persistUIState: !smokeMode,
    exportDiagnostics: smokeMode ? undefined : options => diagnosticExport.exportSnapshot(options),
    observeDiagnosticPlayer: state => {rememberPlayer(state); diagnosticExport.observePlayer(state);},
    observeDiagnosticSources: value => {desktop?.observeSources(value); diagnosticExport.observeSources(value);},
    observeAppleRead: value => diagnosticExport.observeAppleRead(value),
    retryBackend: smokeMode || diagnosticFoobarOverride ? undefined : retryLocalBackend,
    prepareLibraryPaths: locations => bootstrap && !bootstrap.getStatus().ready ?
      Promise.resolve({prepared: false, pending: true, setupRequired: true, restartRequired: false}) : backend.preparePaths({paths: locations, deferRestart: true}),
    prepareLocalPlayback: (input, context) => {
      if (bootstrap && !bootstrap.getStatus().ready) throw new Error('请先完成本地播放内核的首次设置。');
      return prepareLocalPlaybackLifecycle({backend, foobar, bridge: rawFoobar, getCuePlaybackRequests,
        isBridgeReady: () => bridgeReady, onBridgeReady: value => {bridgeReady = value;}}, input, context);
    }});
  closePlaybackContext = handlers.closePlaybackContext;
  const invalidatePlaybackContext = handlers.invalidatePlaybackContext;
  rawFoobar.on('handoff', () => {invalidatePlaybackContext(); lastSources = '';});
  const getActualPlayer = handlers['player:state'];
  let mediaManifestSha256;
  try {mediaManifestSha256 = (await readDesktopMediaRuntimeAssets(root)).desktopMediaManifest.sha256;}
  catch (error) {runtimeLog.record('desktop-integration', {code: error.code || 'STILL_DESKTOP_RUNTIME_ASSET_UNVERIFIED'});}
  assertActive();
  const desktopCallbacks = createDesktopPlaybackCallbacks({coordinator,
    getRuntimeState: () => ({readOnly: Boolean(shutdownFailure), fatal: failures.isFatal(), shuttingDown}),
    mapState: state => {
      const mapped = mapPlayer(state, libraryView.playerTracks(state), decorateTrack);
      rememberPlayer(mapped); diagnosticExport.observePlayer(mapped); return mapped;
    }});
  desktop = createDesktopIntegration({window: mainWindow, screen, settings, powerSaveBlocker, globalShortcut,
    runtimeRoot: root, mediaManifestSha256, enabled: !smokeMode, readOnly: false,
    getPlayer: () => getActualPlayer({}), getSources: () => handlers['source:status']({}), ...desktopCallbacks,
    getArtwork: createDesktopArtworkReader({net, nativeImage}), emit,
    onError: ({code}) => runtimeLog.record('desktop-integration', {code})});
  desktop.restoreWindow();
  Object.assign(handlers, desktop.handlers);
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
    const dacCaller = channel.startsWith('dac:') ? {sender: event.sender, windowGeneration} : undefined;
    const work = invokeSafely(handler, payload, dacCaller);
    const trackDac = dacCaller && channel !== 'dac:list';
    if (trackDac) dacOperations.add(work);
    let response;
    try {response = await work;} finally {if (trackDac) dacOperations.delete(work);}
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
    if (!shutdownWork) shutdownWork = shutdownDesktop({coordinator, foobar: rawFoobar, backend, desktop, cueDiscovery, cuePlaybackGuard, syncPromise, smokeMode,
      bridgeSessionBound: rawFoobar.sessionBound(),
      closeServices: [closeMetadataCovers, closeAppleArtwork, () => settings.close(),
        () => library.close(), () => lyrics.close(), () => apple.close(), closePublicFetch, drainDacOperations]
    }).finally(() => {shutdownWork = null;});
    return shutdownWork;
  };
  fatalCleanup = () => {closeSpectrum(); closePlaybackContext(); return beginShutdown();};
  caughtCleanup = beginShutdown;
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shuttingDown || failures.isFatal()) return;
    invalidateDacAuthorization(true);
    desktop?.beginShutdown();
    beginCueShutdown(cueDiscovery);
    cuePlaybackGuard?.beginShutdown();
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
  }, initialize: () => bootstrap?.getStatus().automatic && !bootstrap.getStatus().prepared && !smokeMode ?
    completePublicBackendSetup() : startBackend({start: !smokeMode && !diagnosticFoobarOverride})});
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
module.exports = {APPLE_PLAYBACK_MAINTENANCE, createHandlers, invokeSafely, mapPlayer, mapQueue, safeCoverPath, resolveFoobarDir, initializeBackend, requiresAbnormalStartupExit, prepareLocalPlaybackLifecycle, prepareAppleHandoffLifecycle, revealBeforeBackend, guardFoobarService, settleWithin, shutdownDesktop, createDesktopPlaybackCallbacks, createDacCurrentReaders, createDacWindowConfirmation, verifyAppleOutputRelease, createAppleAdapter, unavailableAppleService, withSmokeLyricsFixture, windowSize, validateDiagnosticLayout, validateSmokePlan, runDesktopSmoke, registerApplicationSchemes, createAppleMusicIntegration, createLyricsTrackResolver, isTrustedApplicationSender, isApprovedPublicRequest, createPublicFetchService, run};
