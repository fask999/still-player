'use strict';

// Transport pinned to the official Beefweb v0.10 API and foobar2000 adapter.
// No audio decoding, component installation, profile changes, or fallback engine.
const { EventEmitter, setMaxListeners } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHmac, randomUUID } = require('node:crypto');
const { isVerifiedBackendSession, isVerifiedBackendChildExit, endpointForOutput } = require('./backend');
const {contextIdentity, handoffError} = require('./owned-output-handoff');
const {createFoobarTransport, createShutdownWriteGate, boundedMilliseconds, isSafetyError, errorWith} = require('./foobar-transport');
const {createOutputConnection, sameOutput} = require('./foobar-output-connection');
const {createOwnedDecks} = require('./foobar-decks');
const {createHandoffSnapshots} = require('./foobar-handoff');
const {createExistingContextScopeIssuer} = require('./existing-context-scope');
const {stockDacOutput} = require('./dac-identity');

const COLUMNS = ['%path%', '%subsong%', '[%title%]', '[%artist%]', '[%album%]',
  '%length_seconds_fp%', '[%codec%]', '[%samplerate%]', '[$info(bitspersample)]',
  '[$info(channels)]', '[%album artist%]', '[%tracknumber%]', '[%discnumber%]'];
const INSTALL_HELP = '专属 foobar2000 播放内核未就绪，请查看 STILL 后端诊断和 docs/foobar-bridge.md。STILL 只管理其自带的专属内核，不安装组件或修改用户原 foobar2000。';
const cancelled = () => Object.assign(new Error('播放请求已被较新的播放或控制操作取消。'), { code: 'STILL_CANCELLED' });
const isCancelled = error => error?.code === 'STILL_CANCELLED';
const cancellationFor = signal => /^STILL_(?:OUTPUT_|CUE_PLAYBACK_)/u.test(signal.reason?.code || '') ? signal.reason : cancelled();
function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(cancelled()); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
const numberOrNull = value => value !== '' && value !== '?' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const clean = value => value === '?' || value == null ? '' : String(value);
const canonicalPath = value => String(value || '').replace(/^file:\/\//i, '').replace(/\//g, '\\').toLowerCase();
const locationKey = item => `${canonicalPath(item.path)}\u0000${item.subsong}`;
const exactLocationKey = item => JSON.stringify([item?.path, item?.subsong]);
const sameExactLocation = (a, b) => a?.supported && b?.supported && a.path === b.path && a.subsong === b.subsong;

function trackFromColumns(columns = []) {
  const subsong = numberOrNull(columns[1]);
  return { path: clean(columns[0]), subsong: Number.isInteger(subsong) && subsong >= 0 ? subsong : null,
    title: clean(columns[2]), artist: clean(columns[3]), album: clean(columns[4]),
    duration: numberOrNull(columns[5]), codec: clean(columns[6]), sampleRate: numberOrNull(columns[7]),
    bitsPerSample: numberOrNull(columns[8]), channels: numberOrNull(columns[9]),
    albumArtist: clean(columns[10]), trackNumber: numberOrNull(columns[11]), discNumber: numberOrNull(columns[12]),
    supported: Boolean(clean(columns[0])) && Number.isInteger(subsong) && subsong >= 0 };
}

// The UI volume is a normalized slider over the backend's actual reported range.
// It is not an amplitude or loudness measurement. Initialization never sets it.
function normalizedVolume(volume) {
  if (!volume || !['db', 'linear'].includes(volume.type)) return null;
  const { min, max, value } = volume;
  if (![min, max, value].every(Number.isFinite) || max <= min) return null;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}
function backendVolume(value, volume) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('音量必须在 0 到 1 之间。');
  if (normalizedVolume(volume) == null) throw new Error('此输出不支持绝对音量；未改变后端音量。');
  return volume.min + value * (volume.max - volume.min);
}
function normalizeOutputs(raw) {
  const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value);
  if (!raw || !Array.isArray(raw.types) || raw.types.some(type => !type || !identifier(type.id) ||
      type.devices != null && (!Array.isArray(type.devices) || type.devices.some(device => !device || !identifier(device.id)))) ||
      raw.active != null && (!identifier(raw.active.typeId) || !identifier(raw.active.deviceId))) {
    throw errorWith('STILL_BACKEND_INVALID_RESPONSE', 'Beefweb 输出响应格式无效。');
  }
  const outputs = raw.types.flatMap(type => (type.devices || []).map(device => ({
    id: JSON.stringify([type.id, device.id]), typeId: type.id, deviceId: device.id,
    name: device.name, typeName: type.name,
    configuredExclusive: /exclusive|独占/i.test(`${type.name} ${device.name}`) ? true : null,
  })));
  const active = raw.active;
  // Beefweb can retain the selected GUID while omitting an unplugged device
  // from the device list. Preserve that actual active identity for GetState;
  // a missing label/list entry must not erase the DAC gate at cold startup.
  const selected = outputs.find(item => item.typeId === active?.typeId && item.deviceId === active?.deviceId) ||
    (typeof active?.typeId === 'string' && active.typeId && typeof active?.deviceId === 'string' && active.deviceId
      ? { id: JSON.stringify([active.typeId, active.deviceId]), typeId: active.typeId, deviceId: active.deviceId,
        name: '', typeName: raw.types.find(type => type.id === active.typeId)?.name || '', configuredExclusive: null, unavailableInList: true } : null);
  return { outputs, selected, active: raw.active || null, selectionReadback: true };
}
function normalizeOrders(player) {
  const option = player.options?.find(item => item.id === 'playbackOrder' && item.type === 'enum');
  const names = option?.enumNames || player.playbackModes || [];
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) throw errorWith('STILL_BACKEND_INVALID_RESPONSE', 'Beefweb 播放顺序响应格式无效。');
  const value = option?.value ?? player.playbackMode;
  const playbackOrders = names.map((name, id) => ({ id, name }));
  return { playbackOrders, playbackOrder: playbackOrders.find(item => item.id === value) || null,
    orderUsesOptions: Boolean(option) };
}
function normalizeLocations(input) {
  if (!Array.isArray(input) || !input.length) throw new Error('没有选择可播放曲目。');
  return input.map(item => {
    const result = typeof item === 'string' ? { path: item, subsong: 0 } : { path: item?.path, subsong: item?.subsong === undefined ? 0 : item.subsong };
    if (typeof result.path !== 'string' || !result.path || /[\0\r\n]/.test(result.path)) throw new Error('曲目路径无效。');
    if (!Number.isInteger(result.subsong) || result.subsong < 0) throw new Error('子曲索引无效。');
    return result;
  });
}

function createFoobarService(options = {}) {
  const events = new EventEmitter();
  const foobarDir = options.foobarDir || path.resolve(__dirname, '../..');
  const dataDir = options.dataDir || path.join(foobarDir, 'Still-data');
  const base = new URL(options.baseUrl || 'http://127.0.0.1:8880/api/');
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1', 'localhost'].includes(base.hostname) || base.username || base.password) {
    throw new Error('Beefweb bridge 只允许本机 HTTP 地址。');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const fetcher = options.fetch || globalThis.fetch;
  const timeoutMs = boundedMilliseconds(options.timeoutMs, 4000);
  const now = options.clock?.now || Date.now;
  const verifyTimeoutMs = boundedMilliseconds(options.verifyTimeoutMs, 8000);
  const pollMs = options.pollIntervalMs ?? 700;
  const stateFile = path.join(dataDir, 'foobar-service.json');
  const outputSelectionFile = path.join(dataDir, 'foobar-output-selection.json');
  const probePath = options.probePath || path.resolve(__dirname, '../../scripts/foobar-coreaudio-probe.exe');
  const contextSelectionKey = randomUUID();
  const contextBridgeIdentity = Object.freeze({});
  const cueGuard = options.cuePlaybackGuard, cuePermits = new WeakMap(), cueEnded = new WeakSet();
  let nativePermit = null;
  let identity = { instanceId: randomUUID(), storeId: null, storeTitle: null };
  let closed = false, timer = null, mutation = Promise.resolve(), pollBusy = false;
  let transport = Promise.resolve(), queueTransport = Promise.resolve(), generation = 0, intent = null, readSequence = 0, publishedRead = 0;
  let controlEpoch = 0, fatalReadError = null, lastGood = null, consecutiveReadFailures = 0;
  const readFailureThreshold = Number.isInteger(options.readFailureThreshold) ? Math.max(1, Math.min(10, options.readFailureThreshold)) : 3;
  let backendSession = options.backendSession || null, backendExitEvidence = null, disposal = null;
  const verifiedExitController = new AbortController();
  setMaxListeners(0, verifiedExitController.signal);
  const backendExitedError = () => Object.assign(new Error('已核验本次专属播放内核进程退出；旧连接已终结。'), { code: 'STILL_BACKEND_EXITED' });
  let identityWrite = Promise.resolve(), storePending = null, roots = null, identityPersisted = false;
  let selectedOutput = null, selectionEpoch = 0, outputSelectionWrite = Promise.resolve();
  let outputCacheRead = null;
  let emittedConnectionKey = null;
  const sourceCache = new Map(), operations = new Set(), preparationControllers = new Set();
  const serialControllers = new Set();
  let lastOutputs = null, lastError = null, state = offline();
  let handoffLease = null;
  function offline(error) { return { available: false, state: 'unavailable', position: 0, duration: 0,
    volume: null, currentTrack: null, playbackOrder: null, playbackOrders: [],
    error: error || `无法连接本机 foobar2000。${INSTALL_HELP}`, help: INSTALL_HELP }; }
  function connectionSnapshot() {return outputConnection.snapshot();}
  function decorate(value) {return {...value, backendReachable: value.available === true && value.stale !== true,
    connectionStatus: value.connectionStatus || (value.available ? 'connected' : 'offline'),
    stale: value.stale === true, consecutiveReadFailures, lastGoodAt: lastGood?.readAt || null,
    writesQuiesced: shutdownWrites.quiesced,
    controlUncertain: Boolean(transportEngine.fault('control')) && !backendExitEvidence, outputConnection: connectionSnapshot()};}
  function publish(value) {state = decorate(value); events.emit('player', state); options.onUpdate?.(state); return state;}
  function failClosed(error) {
    fatalReadError = error; transportEngine.latch('control', error);
    if (!closed) {publishedRead = ++readSequence; publish({...offline(error.message), code: error.code, connectionStatus: 'offline'});}
    return error;
  }
  const outputConnection = createOutputConnection({getSelected: () => selectedOutput, getOutputs: () => lastOutputs,
    endpointForOutput, isClosed: () => closed, probeOutputState: options.probeOutputState, probePath,
    timeoutMs: options.outputProbeTimeoutMs, ttlMs: options.outputProbeTtlMs, now, clock: options.clock,
    onChange(next, previous) {
      if (next.endpointId && next.status !== 'connected' && previous.status === 'connected') intent?.controller.abort(
        Object.assign(new Error(next.message), {code: next.status === 'disconnected' ? 'STILL_OUTPUT_DISCONNECTED' : 'STILL_OUTPUT_UNKNOWN'}));
      state = decorate(state);
      const key = JSON.stringify([next.status, next.endpointId, next.retryRequired, next.selectionMatches, next.message]);
      if (key !== emittedConnectionKey) {emittedConnectionKey = key; events.emit('output-connection', next);}
    }});
  const refreshOutputConnection = options => outputConnection.refresh(options);
  function invalidateDacAuthorization() {
    try {options.onDacAuthorizationInvalidated?.();} catch {}
  }
  function changedOutputSelection() {
    ++selectionEpoch;
    invalidateDacAuthorization();
  }
  const transportEngine = createFoobarTransport({baseUrl: base.href, timeoutMs,
    fetch(url, init) {
      // The transport calls its final beforeDispatch synchronously immediately
      // before fetch. Only this physical invocation marks a Native read, so
      // cancellation before dispatch does not unnecessarily retain a holder.
      const permit = nativePermit; nativePermit = null;
      permit?.markNativeRead();
      return fetcher(url, init);
    },
    fenceTimeoutMs: options.fenceTimeoutMs, clock: options.clock, exitSignal: verifiedExitController.signal,
    backendExitedError, onAudioDispatch: options.onAudioDispatch, onControlTrace: options.onControlTrace,
    beforeDispatch(route, body, extra) {
      if (body !== undefined) shutdownWrites.assert(route, extra);
      if (body !== undefined && handoffLease && route !== 'player/stop') throw handoffError('STILL_HANDOFF_BUSY', '音频交接正在核验；未发送新的写入。');
      if (backendExitEvidence) throw backendExitedError();
      if (closed) throw cancelled();
      if (body !== undefined && fatalReadError) throw fatalReadError;
      extra.context?.check();
      nativePermit = cuePermits.get(extra.context || extra.settlementContext) || null;
      nativePermit?.check();
    },
    onChange() {state = decorate(state); scheduleCleanup();},
    onSafetyError: failClosed,
    forbiddenHint() {
      const directories = (roots?.items || []).filter(value => typeof value === 'string' && path.win32.isAbsolute(value) &&
        value.length <= 1024 && !/[\0\r\n]/.test(value)).slice(0, 10);
      roots = null;
      return ` 请核对 Beefweb musicDirs 允许目录；当前已核验目录：${JSON.stringify(directories)}。桥接器不会修改配置或调用 CLI。`;
    }});
  const request = transportEngine.request;
  const decks = createOwnedDecks({request, checkPlayer, playlists, sourceCache, getIdentity: () => identity,
    getTransport: () => transport, getTransportFault: () => transportEngine.fault('control') || transportEngine.fault('preparation'),
    isClosed: () => closed || shutdownWrites.quiesced, hasHandoff: () => Boolean(handoffLease), options, notifyError});
  const {ownedDecks, pendingDeckTitles, pin, releasePin, deckTitle, ownedTitle, anyStillTitle, copyRefs, scheduleCleanup, cleanupOwnedDecks} = decks;
  const {stableHandoffSnapshot} = createHandoffSnapshots({request, COLUMNS, checkPlayer, normalizeOutputs,
    endpointForOutput, normalizeOrders, playlists, itemPage, locationKey, trackFromColumns});
  const shutdownWrites = createShutdownWriteGate({
    isOwned: () => !closed && !backendExitEvidence && isVerifiedBackendSession(backendSession, {foobarDir, baseUrl: base.href}),
    onQuiesce() {
      intent?.controller.abort(); intent = null; ++generation; invalidateSerialControls();
      for (const controller of preparationControllers) controller.abort();
      decks.cancelTimer(); outputConnection.invalidate(); state = decorate(state);
    },
    stop(permit) {
      const controller = new AbortController();
      const context = {signal: controller.signal, pendingPosts: new Set(), finished: false,
        check() {if (backendExitEvidence) throw backendExitedError(); if (closed) throw cancelled(); shutdownWrites.assert('player/stop', {shutdownPermit: permit});}};
      const work = Promise.resolve().then(async () => {
        await commit(context, () => request('player/stop', {}, {context, shutdownPermit: permit}));
        return waitFor(() => readState({strict: true, context}), item => item.state === 'stopped', '关闭前停止状态未确认', context);
      });
      operations.add(work); work.finally(() => {context.finished = true; operations.delete(work);}).catch(() => {});
      return work;
    }});
  function rememberOutput(output, { persist = true } = {}) {
    if (!output || ![output.typeId, output.deviceId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value))) return;
    if (sameOutput(selectedOutput, output)) return;
    selectedOutput = { id: JSON.stringify([output.typeId, output.deviceId]), typeId: output.typeId,
      deviceId: output.deviceId, name: clean(output.name), typeName: clean(output.typeName),
      configuredExclusive: output.configuredExclusive === true ? true : null };
    changedOutputSelection(); outputConnection.invalidate({selectionChanged: true});
    if (!persist || options.persistOutputSelection === false) return;
    // This is STILL's last confirmed selection, never a foobar/audio setting.
    const value = JSON.stringify({ version: 1, output: selectedOutput, confirmedAt: new Date().toISOString() }, null, 2);
    outputSelectionWrite = outputSelectionWrite.then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const temporary = `${outputSelectionFile}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, value); await fs.rename(temporary, outputSelectionFile); }
      finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    }).catch(error => notifyError(new Error(`所选输出诊断缓存保存失败：${error.message}`)));
  }
  function loadOutputSelection() {
    if (outputCacheRead) return outputCacheRead;
    outputCacheRead = (async () => {
      try {
        const saved = JSON.parse(await fs.readFile(outputSelectionFile, 'utf8'));
        if (saved.version !== 1 || !saved.output || !Number.isFinite(Date.parse(saved.confirmedAt))) throw new Error('输出诊断缓存格式无效。');
        if (!selectedOutput) rememberOutput(saved.output, { persist: false });
      } catch (error) { if (error.code !== 'ENOENT') notifyError(new Error(`所选输出诊断缓存读取失败：${error.message}`)); }
    })();
    return outputCacheRead;
  }
  async function requirePlaybackOutput(context, { readBackend = false, clearRetry = false, force = false } = {}) {
    if (readBackend) await readState({ strict: true, context });
    let output;
    if (force) {
      context.check();
      const abort = new AbortController();
      const interrupted = new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(cancelled()), {once: true, signal: abort.signal});
      });
      try {
        // A probe that started during pagination may contain an older observation.
        await Promise.race([outputConnection.pending, interrupted]);
        context.check();
        output = await Promise.race([refreshOutputConnection({force: true}), interrupted]);
      } finally {abort.abort();}
    } else output = await refreshOutputConnection();
    context?.check();
    if (!selectedOutput || !lastOutputs?.active) throw Object.assign(new Error('尚未确认后端选定的音频输出，请检查输出后重试。'), { code: 'STILL_OUTPUT_UNKNOWN' });
    if (output.endpointId && output.status !== 'connected') throw Object.assign(new Error(output.message), {
      code: output.status === 'disconnected' ? 'STILL_OUTPUT_DISCONNECTED' : 'STILL_OUTPUT_UNKNOWN' });
    if (selectedOutput && lastOutputs && !sameOutput(lastOutputs.active, selectedOutput)) throw Object.assign(
      new Error('后端当前输出与原选定设备不一致；请明确选择输出后重试，未自动切换设备。'), { code: 'STILL_OUTPUT_CHANGED' });
    if (clearRetry) outputConnection.confirmRetry();
    return connectionSnapshot();
  }
  function notifyError(error) {
    if (isCancelled(error)) return;
    const message = ({STILL_BACKEND_ACCESS_DENIED: '本机播放接口拒绝访问。',
      STILL_HTTP_READ_FAILED: '本机播放状态读取失败。', STILL_HTTP_READ_TIMEOUT: '本机播放状态读取超时。',
      STILL_BACKEND_INVALID_RESPONSE: '本机播放接口返回格式无效。', STILL_BACKEND_REDIRECT_REJECTED: '本机播放接口返回重定向；未接受。',
      STILL_BACKEND_IDENTITY_MISMATCH: '本机播放接口身份不匹配。',
      STILL_TRANSPORT_UNCERTAIN: '相关播放写入尚未确认；已暂停该 lane 的新写入。'})[error.code] || error.message;
    lastError = message;
    events.emit('diagnostic', {message, code: error.code || null, lane: error.lane || null, at: new Date(now()).toISOString()});
    options.onError?.(Object.assign(new Error(message), {code: error.code, lane: error.lane}));
  }
  function checkPlayer(player) {
    if (!player || !['playing', 'paused', 'stopped'].includes(player.playbackState) ||
        !/^foobar2000$/i.test(player.info?.name || '') || !/^0\.10(?:\D|$)/.test(player.info?.pluginVersion || '')) {
      throw failClosed(errorWith('STILL_BACKEND_IDENTITY_MISMATCH', '本机服务与已核验的 foobar2000 / Beefweb 0.10 接口不匹配。'));
    }
  }
  async function readState({ strict = false, context, expectedActive } = {}) {
    const sequence = ++readSequence;
    await loadOutputSelection();
    const connectionEpoch = selectionEpoch;
    const connectionRead = refreshOutputConnection();
    connectionRead.catch(() => {});
    try {
      if (fatalReadError) throw fatalReadError;
      const result = await request(`query?player=true&outputs=true&trcolumns=${encodeURIComponent(COLUMNS.join(','))}`, undefined, { context });
      if (fatalReadError) throw fatalReadError;
      checkPlayer(result?.player);
      const player = result.player, outputs = normalizeOutputs(result.outputs);
      if (sequence >= publishedRead && !closed) {
        if (lastOutputs && !sameOutput(lastOutputs.active, outputs.active)) {outputConnection.invalidate(); changedOutputSelection();}
        lastOutputs = outputs;
        if (!selectedOutput && outputs.selected) rememberOutput(outputs.selected);
      }
      await connectionRead;
      if (connectionEpoch !== selectionEpoch) await refreshOutputConnection();
      context?.check();
      if (fatalReadError) throw fatalReadError;
      const active = player.activeItem || {};
      const track = trackFromColumns(active.columns);
      const current = { available: true, state: player.playbackState,
        position: numberOrNull(active.position) ?? 0, duration: numberOrNull(active.duration) ?? 0,
        volume: normalizedVolume(player.volume), volumeInfo: { ...player.volume },
        currentTrack: track.path ? track : null, output: outputs.selected,
        ...normalizeOrders(player), backend: player.info,
        permissions: player.permissions || null, readAt: new Date(now()).toISOString(), connectionStatus: 'connected', stale: false,
        controlUncertain: Boolean(transportEngine.fault('control')), ...(transportEngine.fault('control') ? {error: transportEngine.fault('control').message} : {}) };
      if (sequence >= publishedRead && !closed) {
        publishedRead = sequence; lastOutputs = outputs; lastError = null;
        consecutiveReadFailures = 0; lastGood = {...current};
        publish(current);
      }
      if (expectedActive && (sequence < publishedRead || active.playlistId !== expectedActive.playlistId ||
          active.index !== expectedActive.itemIndex || !sameExactLocation(track, expectedActive))) return null;
      return sequence < publishedRead ? state : decorate(current);
    } catch (error) {
      if (isCancelled(error)) throw error;
      if (isSafetyError(error) && fatalReadError !== error) failClosed(error);
      const fatal = fatalReadError || error.code === 'STILL_BACKEND_EXITED';
      if (!fatal) await connectionRead;
      if (sequence < publishedRead && !fatal) {if (strict) throw error; return state;}
      if ((sequence >= publishedRead || fatal) && !closed) {
        publishedRead = Math.max(sequence, publishedRead); consecutiveReadFailures++;
        const transient = !fatal && (['STILL_HTTP_READ_FAILED', 'STILL_HTTP_READ_TIMEOUT'].includes(error.code) || error.status >= 500);
        notifyError(error);
        if (transient && lastGood && consecutiveReadFailures < readFailureThreshold) {
          publish({...lastGood, connectionStatus: 'degraded', stale: true, error: error.message, code: error.code});
        } else publish({...offline(error.message), connectionStatus: 'offline', stale: false, code: error.code || 'STILL_HTTP_READ_FAILED'});
      }
      if (strict) throw error;
      return state;
    }
  }
  async function waitFor(read, accepts, message, context, onTimeout) {
    const until = Date.now() + verifyTimeoutMs;
    let result;
    do {
      context?.check();
      result = await read();
      context?.check();
      if (accepts(result)) return result;
      await delay(options.verifyPollMs || 100, context?.signal);
    } while (!closed && Date.now() < until);
    onTimeout?.();
    throw new Error(`${message}（请求已发出，但读回未确认；未切换其他输出或播放器）。`);
  }
  function serial(action) {
    try {shutdownWrites.assert('player'); transportEngine.assertLane('control'); if (fatalReadError) throw fatalReadError;} catch (error) {return Promise.reject(error);}
    const serialEpoch = controlEpoch;
    let expired = false;
    const dispatch = mutation.then(() => {
      if (expired) throw cancelled();
      const foreground = runPreparation(action, {serialEpoch}); foreground.catch(() => {}); return {foreground};
    });
    const promise = dispatch.then(turn => turn.foreground);
    mutation = promise.catch(() => {});
    return transportEngine.waitForFence(dispatch, {lane: 'control', onTimeout() {expired = true;}}).then(turn => turn.foreground);
  }
  function newIntent(externalContext) {
    invalidateSerialControls();
    intent?.controller.abort();
    const controller = new AbortController(), id = ++generation;
    const context = { id, controller, signal: controller.signal, pendingPosts: new Set(), finished: false,
      check() {
        shutdownWrites.assert('player');
        if (controller.signal.aborted) throw cancellationFor(controller.signal);
        if (closed || context.finished || id !== generation) throw cancelled();
        externalContext?.check?.();
      } };
    intent = context;
    return context;
  }
  function runIntent(action, externalContext) {
    // Reject a stale caller before replacing the current adapter intent. A
    // timer cancelled by a newer user command must not cancel that command.
    try {
      if (externalContext?.signal?.aborted) throw cancelled();
      externalContext?.check?.();
    } catch (error) { return Promise.reject(error); }
    const context = newIntent(externalContext);
    const cancelFromExternal = () => context.controller.abort();
    externalContext?.signal?.addEventListener('abort', cancelFromExternal, {once: true});
    let onAbort;
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => reject(cancellationFor(context.signal));
      context.signal.addEventListener('abort', onAbort, { once: true });
    });
    const work = Promise.resolve().then(() => {context.check(); if (fatalReadError) throw fatalReadError; transportEngine.assertLane('control'); return action(context);});
    operations.add(work);
    work.finally(() => { context.finished = true; operations.delete(work); scheduleCleanup(); }).catch(() => {});
    return Promise.race([work, interrupted]).catch(error => { notifyError(error); throw error; })
      .finally(() => {
        context.signal.removeEventListener('abort', onAbort);
        externalContext?.signal?.removeEventListener('abort', cancelFromExternal);
      });
  }
  function invalidateSerialControls() {
    ++controlEpoch;
    for (const controller of serialControllers) controller.abort();
  }
  function runPreparation(action, { serialEpoch } = {}) {
    const controller = new AbortController();
    const context = { controller, signal: controller.signal, pendingPosts: new Set(), finished: false,
      check() {shutdownWrites.assert('playlists'); if (controller.signal.aborted) throw cancellationFor(controller.signal); if (closed || context.finished || (serialEpoch !== undefined && serialEpoch !== controlEpoch)) throw cancelled();} };
    preparationControllers.add(controller);
    if (serialEpoch !== undefined) serialControllers.add(controller);
    const work = Promise.resolve().then(() => { context.check(); return action(context); });
    operations.add(work);
    return work.catch(error => { notifyError(error); throw error; }).finally(() => {
      context.finished = true; operations.delete(work); preparationControllers.delete(controller); serialControllers.delete(controller); scheduleCleanup();
    });
  }
  function commit(context, action, {startsPlayback = false, validateBeforeDispatch} = {}) {
    transportEngine.assertLane('control');
    let expired = false;
    const dispatch = transport.then(async () => {
      context.check(); if (expired) throw cancelled(); transportEngine.assertLane('control');
      if (startsPlayback) await requirePlaybackOutput(context, {readBackend: true, clearRetry: true});
      if (validateBeforeDispatch) {context.check(); if (expired) throw cancelled(); await validateBeforeDispatch();}
      context.check(); if (expired) throw cancelled();
      const foreground = action(); foreground.catch(() => {});
      return {foreground, settlement: Promise.allSettled([...context.pendingPosts])};
    });
    transport = dispatch.then(turn => turn.settlement).catch(() => {});
    return transportEngine.waitForFence(dispatch, {lane: 'control', check: () => context.check(), onTimeout() {expired = true;}}).then(turn => turn.foreground);
  }
  function queueAction(action) {
    try {transportEngine.assertLane('queue');} catch (error) {return Promise.reject(error);}
    return runPreparation(context => {
      let expired = false;
      const dispatch = queueTransport.then(() => {
        context.check(); if (expired) throw cancelled(); transportEngine.assertLane('queue');
        const foreground = Promise.resolve().then(() => action(context)); foreground.catch(() => {}); return {foreground};
      });
      queueTransport = dispatch.then(turn => turn.foreground.finally(() => Promise.allSettled([...context.pendingPosts]))).catch(() => {});
      return transportEngine.waitForFence(dispatch, {lane: 'queue', check: () => context.check(), onTimeout() {expired = true;}}).then(turn => turn.foreground);
    });
  }
  async function playlists(context) {
    const result = await request('playlists', undefined, { context });
    if (!Array.isArray(result?.playlists)) throw new Error('Beefweb 播放列表响应格式无效。');
    return result.playlists;
  }
  async function itemPage(id, offset, count, context) {
    const result = await request(`playlists/${encodeURIComponent(id)}/items/${offset}:${count}?columns=${encodeURIComponent(COLUMNS.join(','))}`, undefined, { context });
    const page = result?.playlistItems;
    if (!page || !Array.isArray(page.items) || !Number.isInteger(page.totalCount) || page.totalCount < 0 || page.offset !== offset || page.items.length > count) throw new Error('Beefweb 曲目分页响应格式无效。');
    return { total: page.totalCount, items: page.items.map((item, index) => ({ ...trackFromColumns(item.columns), playlistId: id, itemIndex: offset + index })) };
  }
  async function playlistItems(id, context) {
    let offset = 0, total = Infinity;
    const items = [];
    while (offset < total) {
      const page = await itemPage(id, offset, 500, context);
      if (total !== Infinity && total !== page.total) throw new Error('读取播放列表时内容发生变化，请重试。');
      total = page.total;
      items.push(...page.items);
      if (!page.items.length && offset < total) throw new Error('读取播放列表时内容发生变化，请重试。');
      offset += page.items.length;
    }
    return items;
  }
  async function playbackContext({signal, maxItems = 500, pageSize = 100, guardContext} = {}, selection, readForControl = false) {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > (readForControl ? 50000 : 500) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Invalid playback context limits.');
    const deadline = AbortSignal.timeout(readForControl ? 10000 : 2500);
    const readSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const context = {signal: readSignal, check() {if (closed || backendExitEvidence || readSignal.aborted) throw cancelled(); guardContext?.check();}};
    const permit = guardContext && cuePermits.get(guardContext);
    if (permit) cuePermits.set(context, permit);
    const unavailable = (reason, status = 'unknown') => ({status, playlist: null, currentIndex: null, items: [], reason});
    const anchor = async (verifyOutput = false) => {
      context.check();
      // Display reads omit outputs. The final pre-POST anchor also checks the
      // actual output against the identity already accepted by the output gate.
      const value = await request(`query?player=true&playlists=true&playQueue=true${verifyOutput ? '&outputs=true' : ''}&trcolumns=${encodeURIComponent(COLUMNS.join(','))}`, undefined, {context});
      checkPlayer(value?.player);
      const active = value.player.activeItem;
      if (!Array.isArray(value.playlists) || value.playlists.length > 10000) return null;
      if (typeof active?.playlistId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(active.playlistId) || ['.', '..'].includes(active.playlistId) ||
          !Number.isInteger(active.index) || active.index < 0) return null;
      const matches = value.playlists.filter(item => item.id === active.playlistId);
      if (matches.length !== 1) return null;
      const playlist = matches[0], track = trackFromColumns(active.columns);
      if (typeof playlist.title !== 'string' || playlist.title.length > 1000 || !Number.isInteger(playlist.itemCount) || playlist.itemCount < 0 ||
          active.index >= playlist.itemCount || !track.supported) return null;
      const options = value.player.options;
      const one = id => Array.isArray(options) && options.filter(row => row?.id === id).length === 1 ? options.find(row => row.id === id) : null;
      const order = one('playbackOrder');
      const flags = ['stopAfterCurrentTrack', 'playbackFollowsCursor', 'cursorFollowsPlayback'].map(id => one(id));
      // Pinned foobar/Beefweb enum id 0 is ordinary order. Never infer it from
      // localized display names, missing cursor flags, or an unknown queue.
      const predictable = order?.type === 'enum' && order.value === 0 && Array.isArray(order.enumNames) && order.enumNames.length > 0 &&
        flags.every(row => row?.type === 'bool' && row.value === false) && Array.isArray(value.playQueue) && value.playQueue.length === 0;
      return {playlistId: active.playlistId, currentIndex: active.index, name: playlist.title, count: playlist.itemCount, track,
        outputMatches: !verifyOutput || sameOutput(normalizeOutputs(value.outputs).active, selection.output),
        predictable, predictionSignature: predictable ? JSON.stringify([order.value, ...flags.map(row => row.value), value.playQueue]) : null};
    };
    const sameAnchor = (a, b) => a && b && a.playlistId === b.playlistId && a.currentIndex === b.currentIndex && a.name === b.name && a.count === b.count && sameExactLocation(a.track, b.track);
    const readItems = async first => {
      const items = [];
      while (items.length < first.count) {
        context.check();
        const page = await itemPage(first.playlistId, items.length, Math.min(pageSize, first.count - items.length), context);
        if (page.total !== first.count || !page.items.length || page.items.length > first.count - items.length) return null;
        items.push(...page.items);
      }
      return items;
    };
    try {
      const first = await anchor();
      if (!first) return unavailable('no-active-playlist', 'unavailable');
      if (first.count > maxItems) return unavailable('context-too-large');
      const items = await readItems(first);
      if (!items || !sameExactLocation(items[first.currentIndex], first.track)) return unavailable('context-changed');
      const repeated = await readItems(first);
      if (!repeated || JSON.stringify(items) !== JSON.stringify(repeated)) return unavailable('context-changed');
      const selectionToken = `local-select:${createHmac('sha256', contextSelectionKey).update(JSON.stringify([
        first.playlistId, first.name, first.currentIndex, items.map(item => [item.path, item.subsong])])).digest('hex')}`;
      const allSupported = items.every(item => item.supported);
      if (selection) {
        const target = items[selection.index];
        if (selectionToken !== selection.token || !allSupported || !target) return unavailable('context-changed');
        await requirePlaybackOutput(context, {force: true});
        // The device check can outlast an external edit to the inactive slot.
        const page = await itemPage(target.playlistId, target.itemIndex, 1, context);
        const actual = page.items[0];
        if (page.total !== first.count || page.items.length !== 1 || actual.playlistId !== target.playlistId ||
            actual.itemIndex !== target.itemIndex || !sameExactLocation(actual, target)) return unavailable('context-changed');
      }
      const last = await anchor(Boolean(selection));
      if (!sameAnchor(first, last)) return unavailable('context-changed');
      context.check();
      if (!last.outputMatches || (selection && !sameOutput(selection.output, selectedOutput))) return unavailable('output-changed');
      return {status: 'ready', playlist: {id: first.playlistId, name: first.name}, currentIndex: first.currentIndex, items, selectionToken,
        capabilities: {select: allSupported && !handoffLease && service.capabilities().playback},
        predictNeighbors: first.predictable && last.predictable && first.predictionSignature === last.predictionSignature};
    } catch (error) {
      if (selection && /^STILL_OUTPUT_/.test(error.code || '')) throw error;
      if (selection && isSafetyError(error) && fatalReadError !== error) failClosed(error);
      return unavailable(readSignal.aborted ? 'context-timeout' : ['STILL_BACKEND_EXITED', 'STILL_CANCELLED'].includes(error.code) ? 'backend-unavailable' : 'context-read-failed', 'unavailable');
    } finally {cuePermits.delete(context);}
  }
  async function librarySnapshot() {
    const result = [];
    for (const playlist of await playlists()) {
      const ownedByStill = anyStillTitle(playlist.title) || ownedTitle(playlist.title);
      const items = ownedByStill ? [] : await playlistItems(playlist.id);
      if (!ownedByStill) sourceCache.set(playlist.id, cacheRecord(playlist, items));
      result.push({ id: playlist.id, name: playlist.title, ownedByStill, items });
    }
    return { playlists: result, source: 'foobar2000', scope: 'existing-playlists',
      mediaLibraryEnumeration: false, readAt: new Date().toISOString() };
  }
  async function persistIdentity() {
    const value = JSON.stringify(identity, null, 2);
    const work = identityWrite.then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const temporary = `${stateFile}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, value); await fs.rename(temporary, stateFile); }
      finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
    identityWrite = work.catch(() => {});
    return work.then(() => { identityPersisted = true; });
  }
  async function addPlaylist(title, context) {
    context?.check();
    if (!identityPersisted) await persistIdentity();
    context?.check();
    // Retain the returned identity even when superseded during this POST, so a
    // late-created deck can be collected after its owning operation finishes.
    const isDeck = deckTitle(title);
    if (isDeck) pendingDeckTitles.set(title, (pendingDeckTitles.get(title) || 0) + 1);
    return request('playlists/add', { title, setCurrent: false }, {
      settlementContext: context,
      onResult(result) {
        if (!result?.id || result.title !== title) throw new Error('创建 STILL 播放列表后未能读回其标识。');
        if (isDeck) {
          ownedDecks.set(result.id, { id: result.id, title, createdAt: Date.now() });
          if (context && !context.finished) pin(result.id);
        }
      },
      onSettled() {
        if (!isDeck) return;
        const count = (pendingDeckTitles.get(title) || 0) - 1;
        if (count) pendingDeckTitles.set(title, count); else pendingDeckTitles.delete(title);
        scheduleCleanup();
      },
    });
  }
  async function store() {
    if (storePending) return storePending;
    storePending = ensureStore().finally(() => { storePending = null; });
    return storePending;
  }
  async function ensureStore() {
    const found = (await playlists()).find(item => item.id === identity.storeId && item.title === identity.storeTitle);
    if (found) return found;
    const title = `STILL · Queue sources [${identity.instanceId}]`;
    const result = await addPlaylist(title);
    identity.storeId = result.id; identity.storeTitle = title;
    await persistIdentity();
    return result;
  }
  const fingerprint = playlist => `${playlist.title}\u0000${playlist.itemCount}`;
  const cacheRecord = (playlist, items) => ({ fingerprint: fingerprint(playlist), items,
    byKey: new Map(items.filter(item => item.supported).map(item => [locationKey(item), item])) });
  function requiresExactLocation(location, context) {
    return cuePermits.get(context)?.requiresExactLocation?.(location) === true;
  }
  function guardedLocationKey(location, context) {
    return requiresExactLocation(location, context) ? exactLocationKey(location) : locationKey(location);
  }
  function matchesLocation(actual, expected, context) {
    if (!actual) return false;
    return requiresExactLocation(expected, context) ? exactLocationKey(actual) === exactLocationKey(expected) : locationKey(actual) === locationKey(expected);
  }
  async function sources(locations, context) {
    const current = await playlists(context), ids = new Set(current.map(item => item.id));
    for (const id of sourceCache.keys()) if (!ids.has(id)) sourceCache.delete(id);
    const byKey = new Map();
    for (const playlist of current) {
      if (anyStillTitle(playlist.title) && playlist.id !== identity.storeId) continue;
      let cached = sourceCache.get(playlist.id);
      if (!cached || cached.fingerprint !== fingerprint(playlist)) {
        cached = cacheRecord(playlist, await playlistItems(playlist.id, context));
        context?.check(); sourceCache.set(playlist.id, cached);
      }
      for (const wanted of locations) {
        const exact = requiresExactLocation(wanted, context), key = guardedLocationKey(wanted, context);
        if (exact && !cached.byExactKey) cached.byExactKey = new Map(cached.items.filter(item => item.supported).map(item => [exactLocationKey(item), item]));
        const item = (exact ? cached.byExactKey : cached.byKey).get(key);
        if (item && !byKey.has(key)) byKey.set(key, item);
      }
    }
    return byKey;
  }
  async function verifyRefs(refs, context) {
    const groups = new Map();
    for (const ref of refs) {
      if (!groups.has(ref.playlistId)) groups.set(ref.playlistId, new Map());
      groups.get(ref.playlistId).set(ref.itemIndex, ref);
    }
    for (const [id, wanted] of groups) {
      const indexes = [...wanted.keys()].sort((a, b) => a - b);
      while (indexes.length) {
        const first = indexes.shift(); let last = first;
        while (indexes.length && indexes[0] - last <= 32 && indexes[0] - first < 500) last = indexes.shift();
        const page = await itemPage(id, first, last - first + 1, context);
        for (let index = first; index <= last; index++) {
          if (wanted.has(index) && !matchesLocation(page.items[index - first], wanted.get(index), context)) {
            sourceCache.delete(id); return false;
          }
        }
      }
    }
    return true;
  }
  async function musicRoots(context) {
    if (roots?.items.length && Date.now() - roots.at < 30000) return roots.items;
    const result = await request('browser/roots', undefined, { context });
    if (!Array.isArray(result?.roots)) throw new Error('Beefweb 音乐目录响应格式无效。');
    roots = { at: Date.now(), items: result.roots.map(item => item.path).filter(item => typeof item === 'string') };
    return roots.items;
  }
  async function bindCuePermit(locations, context, existingContextScope) {
    if (!cueGuard) return;
    context.check();
    if (cueEnded.has(context)) throw cancelled();
    if (cuePermits.has(context)) throw errorWith('STILL_CUE_PLAYBACK_GUARD_UNAVAILABLE', '当前操作已经持有 CUE 播放许可。');
    const permit = await cueGuard.prepare({locations, context, session: backendSession, existingContextScope,
      cancel: error => context.controller.abort(error)});
    try {context.check(); if (cueEnded.has(context)) throw cancelled(); cuePermits.set(context, permit);}
    catch (error) {await permit.release(); throw error;}
  }
  async function releaseCuePermit(context) {
    cueEnded.add(context);
    const permit = cuePermits.get(context);
    cuePermits.delete(context);
    await permit?.release();
  }
  async function withCuePermit(locations, context, action) {
    try {await bindCuePermit(locations, context); return await action();}
    finally {await releaseCuePermit(context);}
  }
  function issueContextScope(context, targets) {
    const session = backendSession, epoch = selectionEpoch;
    const endpoint = JSON.stringify([selectedOutput?.typeId, selectedOutput?.deviceId]);
    const issuer = createExistingContextScopeIssuer({bridge: contextBridgeIdentity, session, endpoint, operation: context,
      isCurrent() {
        context.check();
        return !context.finished && backendSession === session && selectionEpoch === epoch && Boolean(selectedOutput) &&
          JSON.stringify([selectedOutput.typeId, selectedOutput.deviceId]) === endpoint && sameOutput(lastOutputs?.active, selectedOutput);
      }});
    return {scope: issuer.issue(targets), revoke: issuer.revoke};
  }
  async function readValidatedSelection(context, token, index, readForControl = false) {
    const snapshot = await playbackContext({signal: context.signal, maxItems: readForControl ? 50000 : 500, guardContext: context},
      {token, index, output: selectedOutput}, readForControl);
    context.check();
    if (snapshot.reason === 'output-changed') throw errorWith('STILL_OUTPUT_CHANGED', '当前播放输出已改变，请检查输出设备。');
    if (snapshot.status !== 'ready') throw errorWith('STILL_CONTEXT_CHANGED', '当前播放列表、曲目顺序或播放位置已改变，请刷新列表。');
    return snapshot;
  }
  async function prepareCurrentContextCue(context, {currentOnly = false, expected} = {}) {
    if (!cueGuard) return null;
    const initial = await playbackContext({signal: context.signal, maxItems: 50000}, undefined, true);
    context.check();
    const current = initial.items[initial.currentIndex];
    if (initial.status !== 'ready' || !current || expected && !sameExactLocation(current, expected)) {
      throw errorWith('STILL_CONTEXT_CHANGED', '无法核验当前曲目与播放列表，请重新选择曲目。');
    }
    const queue = currentOnly ? [] : (await service.queueList({context})).items;
    context.check();
    const initialItems = JSON.stringify(initial.items), initialQueue = JSON.stringify(queue);
    async function confirm() {
      const latest = await readValidatedSelection(context, initial.selectionToken, initial.currentIndex, true);
      const currentQueue = currentOnly ? [] : (await service.queueList({context})).items;
      context.check();
      if (JSON.stringify(latest.items) !== initialItems || JSON.stringify(currentQueue) !== initialQueue) {
        throw errorWith('STILL_CONTEXT_CHANGED', '当前播放列表或队列已改变，请刷新后重试。');
      }
    }
    await confirm(); context.check();
    const locations = currentOnly ? [current] : [...initial.items, ...queue];
    if (locations.some(item => !item.supported)) throw errorWith('STILL_CONTEXT_CHANGED', '当前播放上下文含未核验曲目，请重新选择曲目。');
    const receipt = issueContextScope(context, locations);
    try {
      await bindCuePermit(locations, context, receipt.scope);
      await cuePermits.get(context).recheck(); await confirm(); context.check();
      return receipt.revoke;
    } catch (error) {receipt.revoke(); await releaseCuePermit(context); throw error;}
  }
  async function commitCurrentContext(context, route, body, options, confirm) {
    let revoke;
    try {
      await commit(context, () => request(route, body, {context, traceOperation: options.traceOperation}), {
        startsPlayback: options.startsPlayback,
        validateBeforeDispatch: cueGuard ? async () => {revoke = await prepareCurrentContextCue(context, options);} : undefined
      });
      return await confirm();
    } finally {revoke?.(); await releaseCuePermit(context);}
  }
  async function materialize(locations, context, retry = true) {
    context?.check();
    const byKey = await sources(locations, context);
    const missing = locations.filter(item => !byKey.has(guardedLocationKey(item, context)));
    if (missing.length) {
      const allowed = await musicRoots(context);
      if (!allowed.length) {
        const directories = [...new Set(missing.map(item => path.win32.dirname(item.path)))];
        throw new Error(`Beefweb 音乐允许目录为空（GET /browser/roots: []），无法导入新路径：${missing[0].path}。请手动在 foobar2000 的 Beefweb 音乐目录设置（musicDirs 字符串数组）中允许文件所在目录，例如 ${directories.join('、')}，再重试。现有列表内的精确曲目仍可使用。未调用 CLI /add，因为其目标受 Shell Integration 设置影响，无法保证不改动用户原列表。`);
      }
      context?.check();
      const archive = await store();
      context?.check();
      const permit = cuePermits.get(context);
      const inputPaths = permit ? await permit.resolveIngestionPaths(missing) : missing.map(item => item.path);
      context?.check();
      const uniquePaths = [...new Map(inputPaths.map(file => [requiresExactLocation({path: file}, context) ? exactLocationKey({path: file}) : canonicalPath(file), file])).values()];
      await request(`playlists/${encodeURIComponent(archive.id)}/items/add`, { items: uniquePaths, async: true, replace: false, play: false }, { context });
      sourceCache.delete(archive.id);
      const loaded = await waitFor(() => playlistItems(archive.id, context), items => missing.every(wanted => items.some(item => item.supported && matchesLocation(item, wanted, context))),
        '精确曲目/子曲未加载完成或该子曲不受支持', context);
      for (const wanted of missing) {
        const item = loaded.find(value => value.supported && matchesLocation(value, wanted, context));
        if (item) byKey.set(guardedLocationKey(wanted, context), item);
      }
    }
    const refs = locations.map(item => {
      const found = byKey.get(guardedLocationKey(item, context));
      if (!found) throw new Error(`无法精确定位子曲 ${item.subsong}: ${item.path}`);
      return found;
    });
    if (!await verifyRefs(refs, context)) {
      if (retry) return materialize(locations, context, false);
      throw new Error('源播放列表的曲目索引已改变；未开始播放，请重试。');
    }
    return refs;
  }
  async function verifyPlayback(expected, context, expectedActive) {
    if (cuePermits.get(context)?.allowsReadback?.(expected) === false) {
      throw errorWith('STILL_CONTEXT_CHANGED', '后端读回的曲目不属于本次已核验上下文，请刷新当前列表。');
    }
    let priorPosition = null, priorAt = 0;
    transportEngine.traceVerification(context, 'verify-start', {timeoutMs: verifyTimeoutMs});
    const result = await waitFor(() => readState({ strict: true, context, expectedActive }), current => {
      if (current?.state !== 'playing' || !matchesLocation(current.currentTrack, expected, context)) {
        if (expectedActive) priorPosition = null;
        return false;
      }
      const now = Date.now();
      if (priorPosition != null && now > priorAt && current.position > priorPosition + 0.025) return true;
      if (priorPosition == null) { priorPosition = current.position; priorAt = now; }
      return false;
    }, '后端未确认目标曲目正在播放且时间前进；请检查 foobar2000 控制台、文件或输出设备', context,
    () => transportEngine.traceVerification(context, 'verify-timeout', {timeoutMs: verifyTimeoutMs}));
    transportEngine.traceVerification(context, 'verify-complete', {timeoutMs: verifyTimeoutMs});
    return result;
  }
  async function simpleStateCommand(command, desired, context) {
    await commit(context, () => request(`player/${command}`, {}, { context }));
    return waitFor(() => readState({ strict: true, context }), item => !desired || desired(item), '后端状态未确认', context);
  }
  function getDacAuthorizationState() {
    if (closed || backendExitEvidence || shutdownWrites.quiesced || fatalReadError || state.available !== true || state.stale === true ||
        transportEngine.fault('control') || transportEngine.status().pendingControlRequests > 0 ||
        !isVerifiedBackendSession(backendSession, {foobarDir, baseUrl: base.href}) || !sameOutput(lastOutputs?.active, selectedOutput) ||
        !sameOutput(lastOutputs?.active, lastOutputs?.selected)) return null;
    const output = stockDacOutput(lastOutputs.selected);
    return output ? {session: backendSession, selectionEpoch, output} : null;
  }
  async function readDacAuthorizationState({signal} = {}) {
    const before = getDacAuthorizationState();
    if (!before || signal?.aborted) return null;
    const context = {signal, check() {
      const current = getDacAuthorizationState();
      if (signal?.aborted || current?.session !== before.session || current.selectionEpoch !== before.selectionEpoch ||
          !sameOutput(current.output, before.output)) throw errorWith('STILL_DAC_CONTEXT_CHANGED', '当前设备或会话已改变，请重新发起 DAC 授权。');
    }};
    let outputs;
    try {outputs = normalizeOutputs((await request('outputs', undefined, {context}))?.outputs);}
    catch (error) {
      if (!signal?.aborted && backendSession === before.session && selectionEpoch === before.selectionEpoch) invalidateDacAuthorization();
      throw error;
    }
    context.check();
    const fresh = stockDacOutput(outputs.selected);
    if (!sameOutput(outputs.active, selectedOutput) || !sameOutput(fresh, before.output)) {
      lastOutputs = outputs;
      outputConnection.invalidate(); changedOutputSelection();
      return null;
    }
    lastOutputs = outputs;
    return getDacAuthorizationState();
  }
  const service = {
    on: events.on.bind(events), off: events.off.bind(events),
    async initialize() {
      try {
        const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
        if (typeof saved.instanceId === 'string' && /^[0-9a-f-]{36}$/i.test(saved.instanceId)) { identity = saved; identityPersisted = true; }
      } catch (error) { if (error.code !== 'ENOENT') notifyError(new Error(`STILL 后端身份文件读取失败：${error.message}`)); }
      await loadOutputSelection();
      const initial = await readState();
      if (!timer && pollMs > 0) {
        timer = setInterval(async () => { if (pollBusy || closed) return; pollBusy = true;
          try { await readState(); } finally { pollBusy = false; } }, pollMs);
        timer.unref?.();
      }
      return initial;
    },
    getState: () => readState(), playbackContext, librarySnapshot, cleanupOwnedDecks, getDacAuthorizationState, readDacAuthorizationState,
    async acquireOutputHandoff({signal, check} = {}) {
      if (handoffLease) throw handoffError('STILL_HANDOFF_BUSY', '另一音频交接尚未完成。');
      const lease = {}; handoffLease = lease;
      decks.cancelTimer();
      for (const controller of preparationControllers) controller.abort();
      const deadlineSignal = AbortSignal.timeout(Math.max(20, Math.min(5000, options.handoffTimeoutMs || 4000)));
      const readSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
      const leaseCheck = () => {if (signal?.aborted) throw cancelled(); check?.(); if (closed || backendExitEvidence || handoffLease !== lease) throw cancelled();};
      const context = {signal: readSignal, check() {leaseCheck(); if (readSignal.aborted) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '交接上下文读取超时；未退出。');}};
      let snapshot = null, snapshotError = null;
      try {
        let onAbort;
        try {
          const aborted = new Promise((_resolve, reject) => {
            onAbort = () => reject(signal?.aborted ? cancelled() : handoffError('STILL_HANDOFF_DRAIN_UNVERIFIED', '旧控制或队列写入在时限内未完成；未执行 stop、退出或新播放。'));
            if (readSignal.aborted) onAbort(); else readSignal.addEventListener('abort', onAbort, {once: true});
          });
          await Promise.race([Promise.allSettled([service.cancelPending(), mutation, transport, queueTransport, transportEngine.drain(), decks.pending].filter(Boolean)), aborted]);
        } finally {readSignal.removeEventListener('abort', onAbort);}
        context.check();
        snapshot = await stableHandoffSnapshot(context);
      } catch (error) {snapshotError = error;}
      return {snapshot, error: snapshotError,
        async verify() {
          leaseCheck(); if (!snapshot) throw snapshotError || handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '交接快照缺失。');
          const deadline = AbortSignal.timeout(4000), verifySignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
          const current = await stableHandoffSnapshot({signal: verifySignal, check() {leaseCheck(); if (deadline.aborted) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '退出前上下文读取超时；未退出。');}});
          if (contextIdentity(current) !== contextIdentity(snapshot)) throw handoffError('STILL_HANDOFF_CONTEXT_CHANGED', '退出前列表、队列、输出、音量或顺序改变；未退出。');
          return current;
        },
        release() {if (handoffLease === lease) handoffLease = null;}
      };
    },
    verifyOutputHandoffContext: ({signal, check} = {}) => stableHandoffSnapshot({signal: signal || AbortSignal.timeout(4000), check() {if (signal?.aborted) throw cancelled(); check?.();}}),
    transportStatus: () => ({closed, writesQuiesced: shutdownWrites.quiesced, backendExited: Boolean(backendExitEvidence), ...transportEngine.status()}),
    beginShutdownWrites: () => shutdownWrites.begin(),
    getAudioTransportStatus: () => transportEngine.audioStatus(),
    async outputConnection(options = {}) {await loadOutputSelection(); return refreshOutputConnection(options);},
    async retryOutput() {
      shutdownWrites.assert('player');
      outputConnection.invalidate();
      // Explicit diagnostic retry only. Never select a fallback, dispatch play,
      // or turn a new GET into settlement proof for a lost control connection.
      await service.cancelPending();
      await readState({ strict: true });
      if (transportEngine.fault('control')) throw transportEngine.fault('control');
      if (closed) throw backendExitEvidence ? backendExitedError() : new Error('foobar bridge 已关闭。');
      await requirePlaybackOutput(null, { clearRetry: true });
      return { ready: true, backendReachable: state.available === true, outputConnection: connectionSnapshot(), state: decorate(state) };
    },
    bindBackendSession(session) {
      if (closed || shutdownWrites.quiesced || !isVerifiedBackendSession(session, { foobarDir, baseUrl: base.href })) throw new Error('未收到同目录、同端口的已核验专属后端 session；不能绑定退出证据。');
      if (backendSession && backendSession !== session) throw new Error('此桥接器已绑定另一进程 session；新后端必须使用新的桥接器，不能替换旧连接的退出证明。');
      if (backendSession !== session) invalidateDacAuthorization();
      backendSession = session;
      return { sessionId: session.sessionId, pid: session.pid };
    },
    markBackendExited(evidence) {
      if (!isVerifiedBackendChildExit(evidence, backendSession, { foobarDir, baseUrl: base.href })) throw new Error('退出证据未匹配本桥接器的已核验 owned PID/session；保留 HTTP 执行屏障。');
      if (backendExitEvidence) return { backendExited: true, exitEvidence: backendExitEvidence };
      backendExitEvidence = evidence;
      invalidateDacAuthorization();
      closed = true; ++generation; intent?.controller.abort(); intent = null;
      outputConnection.close();
      for (const controller of preparationControllers) controller.abort();
      if (timer) clearInterval(timer); timer = null;
      decks.cancelTimer();
      publishedRead = ++readSequence;
      verifiedExitController.abort(backendExitedError());
      publish({ ...offline('本次专属播放内核进程已确认退出。'), backendExited: true, controlUncertain: false,
        exitEvidence: { sessionId: evidence.sessionId, pid: evidence.pid, verifiedBy: evidence.verifiedBy } });
      return { backendExited: true, exitEvidence: evidence };
    },
    cancelPending() { intent?.controller.abort(); invalidateSerialControls(); ++generation; intent = null;
      return transportEngine.waitForFence(transport, {lane: 'control'}).then(() => {
        if (backendExitEvidence) return { backendExited: true, exitEvidence: backendExitEvidence };
        if (transportEngine.fault('control')) throw transportEngine.fault('control');
      }); },
    async releaseOutput({ signal, check } = {}) {
      const verify = () => {
        if (signal?.aborted) throw cancelled();
        check?.();
      };
      verify();
      await service.cancelPending();
      verify();
      const stopped = await service.stop({signal, check: verify});
      verify();
      if (typeof options.waitForOutputRelease !== 'function') throw new Error('未配置同端点的独占释放探测；stopped 读回不能证明音频设备已释放。');
      verify();
      const proof = await options.waitForOutputRelease({ output: stopped.output, signal, check: verify });
      verify();
      if (proof?.released !== true) throw new Error('尚未确认本地音频设备已释放。');
      return { ...proof, state: stopped };
    },
    prepareLocations(input) { return runPreparation(async context => {
      const locations = normalizeLocations(Array.isArray(input) ? input : input?.locations || input?.paths);
      return withCuePermit(locations, context, async () => {
        await materialize(locations, context);
        return {prepared: true, count: locations.length, locations};
      });
    }); },
    async selectPlaybackContext({selectionToken, index} = {}, externalContext) {
      if (typeof selectionToken !== 'string' || !/^local-select:[0-9a-f]{64}$/.test(selectionToken) ||
          !Number.isInteger(index) || index < 0 || index >= 500) {
        throw errorWith('STILL_CONTEXT_INVALID', '当前列表选择参数无效。');
      }
      externalContext?.check?.();
      return runIntent(async context => {
        let target, revoke;
        // The validation runs after older POSTs settle and after the output gate.
        // Starting the request here registers its physical lifetime with commit.
        try {
          await commit(context, () => request(`player/play/${encodeURIComponent(target.playlistId)}/${index}`, {}, {context}), {
            startsPlayback: true,
            async validateBeforeDispatch() {
              const snapshot = await readValidatedSelection(context, selectionToken, index);
              target = snapshot.items[index];
              if (cueGuard) {
                const receipt = issueContextScope(context, [target]); revoke = receipt.revoke;
                await bindCuePermit([target], context, receipt.scope);
                await cuePermits.get(context).recheck();
                const latest = await readValidatedSelection(context, selectionToken, index);
                if (JSON.stringify(latest.items) !== JSON.stringify(snapshot.items)) {
                  throw errorWith('STILL_CONTEXT_CHANGED', '当前播放列表已改变，请刷新后重试。');
                }
                context.check();
              }
            }
          });
          return await verifyPlayback(target, context, target);
        } finally {revoke?.(); await releaseCuePermit(context);}
      }, externalContext);
    },
    play(input = {}, externalContext) { return runIntent(async context => {
      const locations = normalizeLocations(input.locations || input.paths);
      const startIndex = input.startIndex ?? 0;
      if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= locations.length) throw new Error('起始曲目索引无效。');
      return withCuePermit(locations, context, async () => {
        await requirePlaybackOutput(context, {readBackend: true});
        const refs = await materialize(locations, context);
        // Clearing a playlist would invalidate real queue references.
        const deck = await addPlaylist(`STILL · Playback ${new Date().toISOString()} ${randomUUID()} [${identity.instanceId}]`, context);
        try {
          context.check();
          if (cueGuard && !await verifyRefs(refs, context)) throw errorWith('STILL_CONTEXT_CHANGED', '复制前源曲目身份已改变，请重新选择。');
          context.check();
          await copyRefs(refs, deck, context);
          const copied = await playlistItems(deck.id, context);
          if (copied.length !== locations.length || copied.some((item, index) => !matchesLocation(item, locations[index], context))) {
            for (const ref of refs) sourceCache.delete(ref.playlistId);
            throw new Error('播放列表复制后的子曲身份不匹配；未开始播放，请重试。');
          }
          await commit(context, () => request(`player/play/${encodeURIComponent(deck.id)}/${startIndex}`, {}, {context}), {
            startsPlayback: true, validateBeforeDispatch: () => cuePermits.get(context)?.recheck()
          });
          return await verifyPlayback(locations[startIndex], context);
        } finally {releasePin(deck.id, context);}
      });
    }, externalContext); },
    toggle(externalContext) { return runIntent(async context => {
      const before = await readState({ strict: true, context });
      if (before.state === 'playing') return simpleStateCommand('pause', item => item.state === 'paused', context);
      return commitCurrentContext(context, 'player/play', {}, {startsPlayback: true, traceOperation: 'resume', expected: before.currentTrack}, async () => {
        if (before.currentTrack) return verifyPlayback(before.currentTrack, context);
        const first = await waitFor(() => readState({strict: true, context}), item => item.state === 'playing' && item.currentTrack, '没有可恢复的曲目', context);
        return verifyPlayback(first.currentTrack, context);
      });
    }, externalContext); },
    pause: externalContext => runIntent(context => simpleStateCommand('pause', item => item.state === 'paused' || item.state === 'stopped', context), externalContext),
    stop: externalContext => runIntent(context => {
      outputConnection.invalidate();
      return simpleStateCommand('stop', item => item.state === 'stopped', context);
    }, externalContext),
    next: externalContext => runIntent(async context => {
      await requirePlaybackOutput(context, { readBackend: true });
      return commitCurrentContext(context, 'player/next', {}, {startsPlayback: true}, async () => {
        const now = await readState({strict: true, context});
        return now.state === 'stopped' ? now : verifyPlayback(now.currentTrack || {}, context);
      });
    }, externalContext),
    previous: externalContext => runIntent(async context => {
      await requirePlaybackOutput(context, { readBackend: true });
      return commitCurrentContext(context, 'player/previous', {}, {startsPlayback: true}, async () => {
        const now = await readState({strict: true, context});
        return now.state === 'stopped' ? now : verifyPlayback(now.currentTrack || {}, context);
      });
    }, externalContext),
    seek(position, externalContext) { return runIntent(async context => {
      const before = await readState({ strict: true, context });
      if (!Number.isFinite(position) || position < 0 || (before.duration > 0 && position > before.duration)) throw new Error('播放位置无效。');
      if (!['playing', 'paused'].includes(before.state)) throw new Error('当前没有可跳转的播放曲目。');
      return commitCurrentContext(context, 'player', {position}, {currentOnly: true, expected: before.currentTrack},
        () => waitFor(() => readState({strict: true, context}), item => Math.abs(item.position - position) < 1, '后端未确认跳转位置', context));
    }, externalContext); },
    setVolume(volume) { return serial(async context => {
      await readState({ strict: true, context });
      const value = backendVolume(volume, state.volumeInfo);
      await commit(context, () => request('player', { volume: value }, { context }));
      return waitFor(() => readState({ strict: true, context }), item => item.volume != null && Math.abs(item.volume - volume) < 0.015, '后端未确认音量', context);
    }); },
    setOrder(id) { return serial(async context => {
      const before = await readState({ strict: true, context });
      if (!Number.isInteger(id) || !before.playbackOrders.some(item => item.id === id)) throw new Error('请选择后端实际提供的播放顺序。');
      await commit(context, () => request('player', before.orderUsesOptions ? { options: [{ id: 'playbackOrder', value: id }] } : { playbackMode: id }, { context }));
      return waitFor(() => readState({ strict: true, context }), item => item.playbackOrder?.id === id, '后端未确认播放顺序', context);
    }); },
    async queueList({context} = {}) {
      const result = await request(`playqueue?columns=${encodeURIComponent(COLUMNS.join(','))}`, undefined, {context});
      if (!Array.isArray(result?.playQueue)) throw new Error('Beefweb 队列响应格式无效。');
      return { items: result.playQueue.map((item, index) => ({ ...trackFromColumns(item.columns), index,
        playlistId: item.playlistId, itemIndex: item.itemIndex })), source: 'foobar2000' };
    },
    queueAdd(input) { return queueAction(async context => {
      const locations = normalizeLocations(Array.isArray(input) ? input : input?.locations || input?.paths);
      return withCuePermit(locations, context, async () => {
        const refs = await materialize(locations, context);
        const before = await service.queueList({context});
        await cuePermits.get(context)?.recheck(); context.check();
        for (const ref of refs) await request('playqueue/add', {plref: ref.playlistId, itemIndex: ref.itemIndex}, {context});
        return waitFor(() => service.queueList({context}), queue => queue.items.length >= before.items.length + refs.length &&
          locations.every((item, index) => matchesLocation(queue.items[before.items.length + index], item, context)), '后端未确认排队曲目；播放中的队列可能已消费条目', context);
      });
    }); },
    queueRemove(index) { return queueAction(async context => {
      const before = await service.queueList();
      if (!Number.isInteger(index) || index < 0 || index >= before.items.length) throw new Error('队列索引无效。');
      await request('playqueue/remove', { queueIndex: index }, { context });
      const expected = before.items.filter((_, i) => i !== index);
      return waitFor(() => service.queueList(), queue => queue.items.length === expected.length &&
        queue.items.every((item, i) => locationKey(item) === locationKey(expected[i])), '后端未确认队列删除；队列可能已发生变化', context);
    }); },
    queueClear: () => queueAction(async context => { await request('playqueue/clear', {}, { context });
      return waitFor(() => service.queueList(), queue => queue.items.length === 0, '后端未确认清空队列', context); }),
    async outputs({ context } = {}) {
      await loadOutputSelection();
      const outputs = normalizeOutputs((await request('outputs', undefined, { context }))?.outputs);
      if (lastOutputs && !sameOutput(lastOutputs.active, outputs.active)) {outputConnection.invalidate(); changedOutputSelection();}
      lastOutputs = outputs;
      if (!selectedOutput && lastOutputs.selected) rememberOutput(lastOutputs.selected);
      await refreshOutputConnection();
      return { ...lastOutputs, outputConnection: connectionSnapshot() };
    },
    selectOutput(id) { return serial(async context => {
      const before = await service.outputs({ context });
      const wanted = before.outputs.find(item => item.id === id || (id && typeof id === 'object' && item.typeId === id.typeId && item.deviceId === id.deviceId));
      if (!wanted) throw new Error('输出标识无效或设备已断开；未选择其他输出。');
      invalidateDacAuthorization();
      await commit(context, () => request('outputs/active', { typeId: wanted.typeId, deviceId: wanted.deviceId }, { context }));
      const result = await waitFor(() => service.outputs({ context }), result => result.selected?.id === wanted.id, '输出配置未读回所选设备', context);
      rememberOutput(result.selected);
      await refreshOutputConnection();
      return { ...result, outputConnection: connectionSnapshot() };
    }); },
    async audioDetails({ readBackend = true } = {}) {
      let current;
      if (readBackend) current = await readState();
      else {
        await loadOutputSelection(); await refreshOutputConnection();
        current = decorate(offline('播放内核尚未通过连接核验；设备连接状态由独立探测提供。'));
      }
      return { available: current.available, backendReachable: current.available === true,
        outputConnection: connectionSnapshot(), capabilities: { ...service.capabilities(),
          ...(!readBackend ? { installedOrReachable: false, playback: false } : {}) }, selection: selectedOutput || current.output || null,
        source: current.currentTrack || null, configured: readBackend ? lastOutputs?.selected || null : null,
        measured: { exclusive: null, sampleRate: null, bitsPerSample: null, channels: null }, actualDacRate: null,
        unknowns: ['实际独占占用尚未实测', 'DAC 实际接收采样率/位深/通道数未知', 'DSP、重采样、ReplayGain 与 DSD 输出链不由 Beefweb 0.10 报告'],
        evidence: null, error: current.error || null };
    },
    capabilities() { return { backend: 'foobar2000', transport: 'Beefweb 0.10', engine: 'external',
      installedOrReachable: state.available && !state.stale, playback: Boolean(state.available && !state.stale && selectedOutput && lastOutputs?.active && !closed && !shutdownWrites.quiesced && !transportEngine.fault('control') && !fatalReadError &&
        (!connectionSnapshot().endpointId || connectionSnapshot().status === 'connected') && sameOutput(lastOutputs.active, selectedOutput)),
      playlists: true, queue: true, outputSelection: true, outputConnection: true, retryOutput: true,
      subsong: true, subsongStrategy: 'read-and-verify-exact-playlist-index', playbackOrder: true,
      cancellablePlayback: true, prepareLocations: true, ownedDeckCleanup: true,
      localImport: { strategy: 'beefweb-allowed-directories', roots: roots?.items ?? null, cli: false },
      mediaLibraryEnumeration: false, measuresHardwareFormat: false, measuresExclusiveOwnership: false }; },
    restoreInfo() { return { foobarDir, dataDir, baseUrl: base.href,
      backupDir: path.join(foobarDir, 'Still-backup-20261028-before-beefweb'),
      guide: path.resolve(__dirname, '../../docs/foobar-bridge.md'),
      automaticInstallation: false, automaticLaunch: false, lastError }; },
    close() {if (disposal) return transportEngine.waitForFence(disposal, {lane: 'control', allowFault: true});
      closed = true; intent?.controller.abort(); for (const controller of preparationControllers) controller.abort();
      invalidateDacAuthorization();
      outputConnection.close();
      if (timer) clearInterval(timer); timer = null;
      decks.cancelTimer();
      disposal = Promise.allSettled([...operations, mutation, transport, queueTransport, transportEngine.drain(), identityWrite, outputSelectionWrite, decks.pending, outputConnection.pending].filter(Boolean)).then(() => {
        // Backend lifetime belongs to its manager. Disposing a bridge alone is
        // never evidence that an unresolved playback POST cannot still execute.
        events.removeAllListeners();
      });
      return transportEngine.waitForFence(disposal, {lane: 'control', allowFault: true});
    },
  };
  return service;
}

module.exports = { createFoobarService, trackFromColumns, normalizedVolume, backendVolume,
  normalizeOutputs, normalizeOrders, normalizeLocations, locationKey, COLUMNS, INSTALL_HELP };
