'use strict';

// Transport pinned to the official Beefweb v0.10 API and foobar2000 adapter.
// No audio decoding, component installation, profile changes, or fallback engine.
const { EventEmitter, setMaxListeners } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isVerifiedBackendSession, isVerifiedBackendExit, endpointForOutput } = require('./backend');
const {validateSnapshot, contextIdentity, handoffError} = require('./owned-output-handoff');
const executeFile = promisify(execFile);

const COLUMNS = ['%path%', '%subsong%', '[%title%]', '[%artist%]', '[%album%]',
  '%length_seconds_fp%', '[%codec%]', '[%samplerate%]', '[$info(bitspersample)]',
  '[$info(channels)]', '[%album artist%]', '[%tracknumber%]', '[%discnumber%]'];
const INSTALL_HELP = '专属 foobar2000 播放内核未就绪，请查看 STILL 后端诊断和 docs/foobar-bridge.md。STILL 只管理其自带的专属内核，不安装组件或修改用户原 foobar2000。';
const cancelled = () => Object.assign(new Error('播放请求已被较新的播放或控制操作取消。'), { code: 'STILL_CANCELLED' });
const isCancelled = error => error?.code === 'STILL_CANCELLED';
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
  if (!raw || !Array.isArray(raw.types)) throw new Error('Beefweb 输出响应格式无效。');
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
  const foobarDir = options.foobarDir || 'D:\\foobar2000';
  const dataDir = options.dataDir || path.join(foobarDir, 'Still-data');
  const base = new URL(options.baseUrl || 'http://127.0.0.1:8880/api/');
  if (base.protocol !== 'http:' || !['127.0.0.1', '[::1]', '::1', 'localhost'].includes(base.hostname) || base.username || base.password) {
    throw new Error('Beefweb bridge 只允许本机 HTTP 地址。');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const fetcher = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || 4000;
  const verifyTimeoutMs = options.verifyTimeoutMs || 8000;
  const pollMs = options.pollIntervalMs ?? 700;
  const stateFile = path.join(dataDir, 'foobar-service.json');
  const outputSelectionFile = path.join(dataDir, 'foobar-output-selection.json');
  const probePath = options.probePath || path.resolve(__dirname, '../../scripts/foobar-coreaudio-probe.exe');
  let identity = { instanceId: randomUUID(), storeId: null, storeTitle: null };
  let closed = false, timer = null, mutation = Promise.resolve(), pollBusy = false;
  let transport = Promise.resolve(), queueTransport = Promise.resolve(), generation = 0, intent = null, readSequence = 0, publishedRead = 0;
  let transportFault = null, pendingControlRequests = 0, controlEpoch = 0;
  let pendingAudioRequests = 0;
  let backendSession = options.backendSession || null, backendExitEvidence = null, disposal = null;
  const verifiedExitController = new AbortController();
  setMaxListeners(0, verifiedExitController.signal);
  const backendExitedError = () => Object.assign(new Error('已核验本次专属播放内核进程退出；旧连接已终结。'), { code: 'STILL_BACKEND_EXITED' });
  let identityWrite = Promise.resolve(), storePending = null, roots = null, identityPersisted = false;
  let cleanupPending = null, cleanupTimer = null, ownedDiscovered = false;
  let selectedOutput = null, selectionEpoch = 0, outputSelectionWrite = Promise.resolve();
  let outputCacheRead = null;
  let connectionPending = null, connectionSequence = 0, publishedConnection = 0, retryRequired = false, emittedConnectionKey = null;
  const connectionController = new AbortController();
  let connection = { status: 'unknown', endpointId: null, lastCheckedAt: null, retryRequired: false,
    message: '尚未读回所选音频设备。', output: null, selectionMatches: null, actualDacRate: null };
  const sourceCache = new Map(), ownedDecks = new Map(), pins = new Map(), operations = new Set(), preparationControllers = new Set();
  const serialControllers = new Set();
  const pendingDeckTitles = new Map();
  const keepDecks = Number.isInteger(options.keepDecks) ? Math.max(0, options.keepDecks) : 2;
  const cleanupBatchSize = Math.max(1, Math.min(10, options.cleanupBatchSize || 4));
  let rawPlayer = null, lastOutputs = null, lastError = null, state = offline();
  let handoffLease = null;
  function offline(error) { return { available: false, state: 'unavailable', position: 0, duration: 0,
    volume: null, currentTrack: null, playbackOrder: null, playbackOrders: [],
    error: error || `无法连接本机 foobar2000。${INSTALL_HELP}`, help: INSTALL_HELP }; }
  const sameOutput = (a, b) => Boolean(a && b && a.typeId === b.typeId && a.deviceId === b.deviceId);
  function connectionSnapshot() {
    const selectionMatches = lastOutputs && selectedOutput ? sameOutput(lastOutputs.active, selectedOutput) : null;
    return { ...connection, output: selectedOutput && { ...selectedOutput }, retryRequired: retryRequired || selectionMatches === false, selectionMatches };
  }
  function decorate(value) { return { ...value, backendReachable: value.available === true,
    controlUncertain: Boolean(transportFault) && !backendExitEvidence, outputConnection: connectionSnapshot() }; }
  function publish(value) {
    state = decorate(value);
    events.emit('player', state);
    options.onUpdate?.(state);
    return state;
  }
  function updateConnection(value) {
    const previous = connectionSnapshot();
    connection = value;
    if (value.endpointId && value.status !== 'connected' && value.lastCheckedAt) retryRequired = true;
    const next = connectionSnapshot();
    // Losing the selected endpoint cancels obsolete preparation/verification,
    // but never aborts an already-dispatched POST or claims the player stopped.
    if (value.endpointId && value.status !== 'connected' && previous.status === 'connected') intent?.controller.abort(
      Object.assign(new Error(value.message), { code: value.status === 'disconnected' ? 'STILL_OUTPUT_DISCONNECTED' : 'STILL_OUTPUT_UNKNOWN' }));
    state = decorate(state);
    const relevant = item => JSON.stringify([item.status, item.endpointId, item.retryRequired, item.selectionMatches, item.message]);
    const nextKey = relevant(next);
    if (emittedConnectionKey !== nextKey) { emittedConnectionKey = nextKey; events.emit('output-connection', next); }
    return next;
  }
  function rememberOutput(output, { persist = true } = {}) {
    if (!output || ![output.typeId, output.deviceId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value))) return;
    if (sameOutput(selectedOutput, output)) return;
    selectedOutput = { id: JSON.stringify([output.typeId, output.deviceId]), typeId: output.typeId,
      deviceId: output.deviceId, name: clean(output.name), typeName: clean(output.typeName),
      configuredExclusive: output.configuredExclusive === true ? true : null };
    ++selectionEpoch; retryRequired = false;
    updateConnection({ status: 'unknown', endpointId: endpointForOutput(selectedOutput), lastCheckedAt: null,
      message: '正在核对所选音频设备连接。', actualDacRate: null });
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
  async function probeOutputState(output, endpointId) {
    if (typeof options.probeOutputState === 'function') return options.probeOutputState({ output: { ...output }, endpointId, signal: connectionController.signal });
    const { stdout } = await executeFile(probePath, [endpointId, 'state'], {
      windowsHide: true, timeout: options.outputProbeTimeoutMs || 1500, maxBuffer: 64 * 1024, signal: connectionController.signal });
    return JSON.parse(String(stdout).trim());
  }
  async function refreshOutputConnection() {
    const output = selectedOutput, epoch = selectionEpoch, endpointId = endpointForOutput(output);
    if (closed) return connectionSnapshot();
    if (!endpointId) return updateConnection({ status: 'unknown', endpointId: null, lastCheckedAt: null,
      message: output ? '此输出无法精确映射到 CoreAudio 端点；连接状态未知。' : '尚未读回所选音频设备。', actualDacRate: null });
    if (connectionPending?.epoch === epoch) return connectionPending.promise;
    const sequence = ++connectionSequence;
    const promise = (async () => {
      let next;
      try {
        const result = await probeOutputState(output, endpointId);
        if (result?.endpoint?.toLowerCase() !== endpointId.toLowerCase() || result.operation !== 'GetState' || result.mode !== 'state' ||
            result.clientActivated !== false || result.initializeCalled !== false || result.startCalled !== false || result.actualDacRate !== null) {
          throw new Error('CoreAudio 工具未提供同端点、无音频初始化的 GetState 证据。');
        }
        const missing = result.deviceFound === false && result.deviceNotFound === true && result.hresult === '0x80070490' && result.state === null;
        const known = result.hresult === '0x00000000' && result.deviceFound === true && Number.isInteger(result.state) && result.state > 0 &&
          (result.state & ~15) === 0 && result.active === Boolean(result.state & 1);
        if (!missing && !known) throw new Error(`CoreAudio 连接状态未确认（${clean(result.hresult)}）。`);
        const connected = known && result.active;
        next = { status: connected ? 'connected' : 'disconnected', endpointId,
          lastCheckedAt: new Date().toISOString(), message: connected ? '所选音频设备已连接；播放需由用户明确发起。' : '所选音频设备已断开或不可用，请连接原设备后重试。',
          evidence: { probe: 'IMMDevice.GetState', result: { ...result }, initializeCalled: false, startCalled: false }, actualDacRate: null };
      } catch (error) {
        next = { status: 'unknown', endpointId, lastCheckedAt: new Date().toISOString(),
          message: '无法确认所选音频设备连接，请检查设备与诊断后重试。', probeError: clean(error.message).slice(0, 600), actualDacRate: null };
      }
      if (closed || epoch !== selectionEpoch || sequence < publishedConnection) return connectionSnapshot();
      publishedConnection = sequence;
      return updateConnection(next);
    })();
    connectionPending = { epoch, promise };
    return promise.finally(() => { if (connectionPending?.promise === promise) connectionPending = null; });
  }
  async function requirePlaybackOutput(context, { readBackend = false, clearRetry = false } = {}) {
    if (readBackend) await readState({ strict: true, context });
    const output = await refreshOutputConnection();
    context?.check();
    if (!selectedOutput || !lastOutputs?.active) throw Object.assign(new Error('尚未确认后端选定的音频输出，请检查输出后重试。'), { code: 'STILL_OUTPUT_UNKNOWN' });
    if (output.endpointId && output.status !== 'connected') throw Object.assign(new Error(output.message), {
      code: output.status === 'disconnected' ? 'STILL_OUTPUT_DISCONNECTED' : 'STILL_OUTPUT_UNKNOWN' });
    if (selectedOutput && lastOutputs && !sameOutput(lastOutputs.active, selectedOutput)) throw Object.assign(
      new Error('后端当前输出与原选定设备不一致；请明确选择输出后重试，未自动切换设备。'), { code: 'STILL_OUTPUT_CHANGED' });
    if (clearRetry && retryRequired) { retryRequired = false; updateConnection(connection); }
    return connectionSnapshot();
  }
  function notifyError(error) {
    if (isCancelled(error)) return;
    lastError = error.message;
    events.emit('diagnostic', { message: error.message, at: new Date().toISOString() });
    options.onError?.(error);
  }
  async function request(route, body, extra = {}) {
    if (body !== undefined && handoffLease && route !== 'player/stop') throw handoffError('STILL_HANDOFF_BUSY', '音频交接正在核验；未发送新的队列、输出或播放写入。');
    if (backendExitEvidence) throw backendExitedError();
    if (closed) throw new Error('foobar bridge 已关闭。');
    extra.context?.check();
    const url = new URL(route.replace(/^\//, ''), base);
    const signals = [AbortSignal.timeout(extra.timeoutMs || timeoutMs), verifiedExitController.signal];
    if (extra.context) signals.push(extra.context.signal);
    // A POST deadline only ends the caller's wait. Aborting its socket cannot
    // revoke a backend commit. Keep the real settlement as a fence, including
    // response-body consumption, so a later confirmed stop is always ordered last.
    const audioKind = body === undefined ? null : /^player\/play(?:\/|$)/.test(route) ? 'play'
      : ['player/pause', 'player/stop', 'player/next', 'player/previous'].includes(route) ? route.slice(7)
      : route === 'player' && body?.position != null ? 'seek' : null;
    let audioObserver = null, fetchInvoked = false, audioPending = false, observerSettled = false;
    const ignoreObserverPromise = value => {try {if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});} catch {}};
    const settleObserver = disposition => {
      if (observerSettled) return; observerSettled = true;
      try {ignoreObserverPromise(audioObserver?.(disposition));} catch {}
    };
    const http = Promise.resolve().then(async () => {
      if (body !== undefined && handoffLease && route !== 'player/stop') throw handoffError('STILL_HANDOFF_BUSY', '音频交接正在核验；旧准备操作未发送新写入。');
      if (backendExitEvidence) throw backendExitedError();
      extra.context?.check();
      extra.settlementContext?.check();
      const requestOptions = { method: body === undefined ? 'GET' : 'POST',
        redirect: 'error', headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: body === undefined ? AbortSignal.any(signals) : verifiedExitController.signal };
      if (audioKind) {
        try {
          const observer = options.onAudioDispatch;
          if (typeof observer === 'function') {
            const observation = observer({kind: audioKind, source: 'local'});
            ignoreObserverPromise(observation);
            if (observation && typeof observation.then !== 'function' && typeof observation.settle === 'function') audioObserver = observation.settle.bind(observation);
          }
        } catch {}
      }
      // The observer is synchronous and is never a media gate. Recheck only
      // the existing guards in case it synchronously triggered a newer real
      // media intent or observed the branded source exit. No await occurs
      // between these checks, the observer and the actual fetch invocation.
      if (body !== undefined && handoffLease && route !== 'player/stop') throw handoffError('STILL_HANDOFF_BUSY', '音频交接正在核验；未发送旧音频写入。');
      if (backendExitEvidence) throw backendExitedError();
      extra.context?.check(); extra.settlementContext?.check();
      if (audioKind) {audioPending = true; ++pendingAudioRequests;}
      fetchInvoked = true;
      const response = await fetcher(url, requestOptions);
      const text = await response.text();
      if (backendExitEvidence) throw backendExitedError();
      if (!response.ok) {
        const hint = response.status === 403 ? ` 请在 foobar2000 的 Beefweb 设置中允许该音乐文件所在目录（musicDirs）；当前目录读回：${JSON.stringify(roots?.items ?? '尚未读取')}。桥接器不会改动配置或自动启动 foobar2000。` : '';
        if (response.status === 403) roots = null;
        throw Object.assign(new Error(`Beefweb ${response.status}: ${text.slice(0, 600)}${hint}`), { status: response.status });
      }
      let value = null;
      if (text) { try { value = JSON.parse(text); } catch { throw new Error('本机端口返回的不是有效 Beefweb JSON。'); } }
      extra.onResult?.(value);
      return value;
    });
    // Ordinary intent/close never revokes a POST. Only an authenticated,
    // session-matched owned-process exit ends its causal lifetime. The race also
    // handles an adapter which cannot promptly reject its now-defunct socket.
    let onVerifiedExit;
    const ended = new Promise((resolve, reject) => {
      onVerifiedExit = () => reject(backendExitedError());
      if (backendExitEvidence) onVerifiedExit();
      else verifiedExitController.signal.addEventListener('abort', onVerifiedExit, { once: true });
    });
    const actual = Promise.race([http, ended]).then(value => {
      settleObserver(fetchInvoked ? 'dispatched' : 'not-dispatched'); return value;
    }, failure => {
      settleObserver(fetchInvoked ? 'uncertain' : 'not-dispatched'); throw failure;
    }).finally(() => {
      if (audioPending) --pendingAudioRequests;
      verifiedExitController.signal.removeEventListener('abort', onVerifiedExit);
    });
    let deadline;
    if (body !== undefined) {
      const owner = extra.context || extra.settlementContext;
      const control = /^(?:player(?:\/|$)|outputs\/active$)/.test(route);
      if (control) ++pendingControlRequests;
      owner?.pendingPosts.add(actual);
      actual.finally(() => { if (control) --pendingControlRequests; owner?.pendingPosts.delete(actual); extra.onSettled?.(); }).catch(() => {});
    }
    try {
      const value = body === undefined ? await actual : await Promise.race([actual, new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(Object.assign(new Error('HTTP 操作等待超时；已发送的操作仍可能由后端完成，后续控制将等待其真实完成。'), { code: 'STILL_HTTP_TIMEOUT' })), extra.timeoutMs || timeoutMs);
      })]);
      extra.context?.check();
      return value;
    } catch (error) {
      extra.context?.check();
      if (error.status || ['STILL_HTTP_TIMEOUT', 'STILL_BACKEND_EXITED', 'STILL_HANDOFF_BUSY'].includes(error.code)) throw error;
      throw new Error(`本机 foobar2000/Beefweb 连接中断（${error.message}）。${INSTALL_HELP}`, { cause: error });
    } finally { if (deadline) clearTimeout(deadline); }
  }
  function checkPlayer(player) {
    if (!player || !['playing', 'paused', 'stopped'].includes(player.playbackState) ||
        !/^foobar2000$/i.test(player.info?.name || '') || !/^0\.10(?:\D|$)/.test(player.info?.pluginVersion || '')) {
      throw new Error('本机服务与已核验的 foobar2000 / Beefweb 0.10 接口不匹配。');
    }
  }
  async function readState({ strict = false, context } = {}) {
    const sequence = ++readSequence;
    await loadOutputSelection();
    const connectionEpoch = selectionEpoch;
    const connectionRead = refreshOutputConnection();
    try {
      const result = await request(`query?player=true&outputs=true&trcolumns=${encodeURIComponent(COLUMNS.join(','))}`, undefined, { context });
      checkPlayer(result?.player);
      const player = result.player, outputs = normalizeOutputs(result.outputs);
      if (sequence >= publishedRead && !closed) {
        lastOutputs = outputs;
        if (!selectedOutput && outputs.selected) rememberOutput(outputs.selected);
      }
      await connectionRead;
      if (connectionEpoch !== selectionEpoch) await refreshOutputConnection();
      context?.check();
      const active = player.activeItem || {};
      const track = trackFromColumns(active.columns);
      const current = { available: true, state: player.playbackState,
        position: numberOrNull(active.position) ?? 0, duration: numberOrNull(active.duration) ?? 0,
        volume: normalizedVolume(player.volume), volumeInfo: { ...player.volume },
        currentTrack: track.path ? track : null, output: outputs.selected,
        ...normalizeOrders(player), backend: player.info,
        permissions: player.permissions || null, readAt: new Date().toISOString(),
        controlUncertain: Boolean(transportFault), ...(transportFault ? { error: transportFault.message } : {}) };
      if (sequence >= publishedRead && !closed) {
        publishedRead = sequence; rawPlayer = player; lastOutputs = outputs; lastError = null;
        publish(current);
      }
      return sequence < publishedRead ? state : decorate(current);
    } catch (error) {
      await connectionRead;
      if (isCancelled(error)) throw error;
      if (sequence < publishedRead) return state;
      if (sequence >= publishedRead && !closed) {
        publishedRead = sequence; notifyError(error); publish(offline(error.message));
      }
      if (strict) throw error;
      return state;
    }
  }
  async function waitFor(read, accepts, message, context) {
    const until = Date.now() + verifyTimeoutMs;
    let result;
    do {
      context?.check();
      result = await read();
      context?.check();
      if (accepts(result)) return result;
      await delay(options.verifyPollMs || 100, context?.signal);
    } while (!closed && Date.now() < until);
    throw new Error(`${message}（请求已发出，但读回未确认；未切换其他输出或播放器）。`);
  }
  function serial(action) {
    const serialEpoch = controlEpoch;
    const promise = mutation.then(() => runPreparation(action, { serialEpoch }));
    mutation = promise.catch(() => {});
    return promise;
  }
  function newIntent() {
    invalidateSerialControls();
    intent?.controller.abort();
    const controller = new AbortController(), id = ++generation;
    const context = { id, controller, signal: controller.signal, pendingPosts: new Set(), finished: false,
      check() {
        if (controller.signal.aborted && /^STILL_OUTPUT_/.test(controller.signal.reason?.code || '')) throw controller.signal.reason;
        if (closed || controller.signal.aborted || id !== generation) throw cancelled();
      } };
    intent = context;
    return context;
  }
  function runIntent(action) {
    const context = newIntent();
    let onAbort;
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => reject(/^STILL_OUTPUT_/.test(context.signal.reason?.code || '') ? context.signal.reason : cancelled());
      context.signal.addEventListener('abort', onAbort, { once: true });
    });
    const work = Promise.resolve().then(() => { context.check(); if (transportFault) throw transportFault; return action(context); });
    operations.add(work);
    work.finally(() => { context.finished = true; operations.delete(work); scheduleCleanup(); }).catch(() => {});
    return Promise.race([work, interrupted]).catch(error => { notifyError(error); throw error; })
      .finally(() => context.signal.removeEventListener('abort', onAbort));
  }
  function invalidateSerialControls() {
    ++controlEpoch;
    for (const controller of serialControllers) controller.abort();
  }
  function runPreparation(action, { serialEpoch } = {}) {
    const controller = new AbortController();
    const context = { signal: controller.signal, pendingPosts: new Set(), finished: false,
      check() { if (closed || controller.signal.aborted || (serialEpoch !== undefined && serialEpoch !== controlEpoch)) throw cancelled(); } };
    preparationControllers.add(controller);
    if (serialEpoch !== undefined) serialControllers.add(controller);
    const work = Promise.resolve().then(() => { context.check(); return action(context); });
    operations.add(work);
    return work.catch(error => { notifyError(error); throw error; }).finally(() => {
      context.finished = true; operations.delete(work); preparationControllers.delete(controller); serialControllers.delete(controller); scheduleCleanup();
    });
  }
  function commit(context, action, { startsPlayback = false } = {}) {
    const dispatch = transport.then(async () => {
      context.check();
      if (transportFault) throw transportFault;
      if (startsPlayback) await requirePlaybackOutput(context, { readBackend: true, clearRetry: true });
      context.check();
      const foreground = action();
      foreground.catch(() => {});
      const settlement = Promise.allSettled([...context.pendingPosts]).then(results => {
        const failed = results.find(item => item.status === 'rejected' && !isCancelled(item.reason) && !['STILL_BACKEND_EXITED', 'STILL_HANDOFF_BUSY'].includes(item.reason?.code) &&
          !(item.reason?.status >= 400 && item.reason.status < 500));
        if (failed && !backendExitEvidence) {
          transportFault = Object.assign(new Error('播放控制连接在确认前丢失，无法证明旧请求已撤回。已禁用后续播放控制；请安全关闭并重新启动专属播放内核后重连，不能把当前读回当作已完成停止。'),
            { code: 'STILL_TRANSPORT_UNCERTAIN', cause: failed.reason });
          notifyError(transportFault);
        }
      });
      return { foreground, settlement };
    });
    transport = dispatch.then(turn => turn.settlement).catch(() => {});
    return dispatch.then(turn => turn.foreground);
  }
  function queueAction(action) {
    return runPreparation(context => {
      const foreground = queueTransport.then(() => { context.check(); return action(context); });
      // Queue commands also retain timed-out POST settlement, independently of
      // playback. A late queue/add must not land after an already-confirmed clear.
      queueTransport = foreground.finally(() => Promise.allSettled([...context.pendingPosts])).catch(() => {});
      return foreground;
    });
  }
  function pin(id) { pins.set(id, (pins.get(id) || 0) + 1); }
  function unpin(id) { const count = (pins.get(id) || 0) - 1; if (count > 0) pins.set(id, count); else pins.delete(id); }
  function releasePin(id, context) {
    Promise.allSettled([...context.pendingPosts, transport]).then(() => { if (!transportFault) unpin(id); scheduleCleanup(); });
  }
  const deckTitle = title => typeof title === 'string' && title.startsWith('STILL · Playback ') && title.endsWith(`[${identity.instanceId}]`);
  const ownedTitle = title => deckTitle(title) || title === identity.storeTitle;
  // Old STILL instances are excluded from source scans, but can never be deleted
  // by this identity. Avoid rescanning their potentially large immutable decks.
  const anyStillTitle = title => /^STILL · (?:Playback .+|Queue sources) \[[0-9a-f-]{36}\]$/i.test(title || '');
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
  async function playbackContext({signal, maxItems = 500, pageSize = 100} = {}) {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 500 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('Invalid playback context limits.');
    const readSignal = signal || AbortSignal.timeout(2500);
    const context = {signal: readSignal, check() {if (closed || backendExitEvidence || readSignal.aborted) throw cancelled();}};
    const unavailable = (reason, status = 'unknown') => ({status, playlist: null, currentIndex: null, items: [], reason});
    const anchor = async () => {
      context.check();
      // These GETs intentionally omit outputs: a context read must never run
      // the selected-device/CoreAudio probe performed by readState().
      const value = await request(`query?player=true&playlists=true&playQueue=true&trcolumns=${encodeURIComponent(COLUMNS.join(','))}`, undefined, {context});
      checkPlayer(value?.player);
      const active = value.player.activeItem;
      if (!Array.isArray(value.playlists) || value.playlists.length > 10000) return null;
      if (typeof active?.playlistId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(active.playlistId) || !Number.isInteger(active.index) || active.index < 0) return null;
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
        predictable, predictionSignature: predictable ? JSON.stringify([order.value, ...flags.map(row => row.value), value.playQueue]) : null};
    };
    const sameAnchor = (a, b) => a && b && a.playlistId === b.playlistId && a.currentIndex === b.currentIndex && a.name === b.name && a.count === b.count && locationKey(a.track) === locationKey(b.track);
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
      if (!items || locationKey(items[first.currentIndex] || {}) !== locationKey(first.track)) return unavailable('context-changed');
      const repeated = await readItems(first);
      const last = await anchor();
      if (!repeated || JSON.stringify(items) !== JSON.stringify(repeated) || !sameAnchor(first, last)) return unavailable('context-changed');
      context.check();
      return {status: 'ready', playlist: {id: first.playlistId, name: first.name}, currentIndex: first.currentIndex, items,
        predictNeighbors: first.predictable && last.predictable && first.predictionSignature === last.predictionSignature};
    } catch (error) {
      return unavailable(readSignal.aborted ? 'context-timeout' : ['STILL_BACKEND_EXITED', 'STILL_CANCELLED'].includes(error.code) ? 'backend-unavailable' : 'context-read-failed', 'unavailable');
    }
  }
  async function handoffSnapshot(context) {
    context?.check?.();
    const result = await request(`query?player=true&outputs=true&playQueue=true&trcolumns=${encodeURIComponent(COLUMNS.join(','))}`, undefined, {context});
    checkPlayer(result?.player);
    if (!Array.isArray(result.playQueue)) throw handoffError('STILL_HANDOFF_QUEUE_UNKNOWN', '临时队列未完整回读；保留队列和内核。');
    if (result.playQueue.length) throw handoffError('STILL_HANDOFF_QUEUE_NOT_EMPTY', '临时队列非空；保留完整队列，当前不允许退出内核交接。');
    const player = result.player, active = player.activeItem, output = normalizeOutputs(result.outputs).selected;
    const endpoint = endpointForOutput(output);
    if (!endpoint) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '当前输出未完整核验；未退出。');
    const prefs = {queue: [], output: {typeId: output.typeId, deviceId: output.deviceId, name: output.name || '', typeName: output.typeName || ''}, endpoint,
      volume: {type: player.volume?.type, min: player.volume?.min, max: player.volume?.max, value: player.volume?.value}, order: normalizeOrders(player).playbackOrder?.id, playbackState: player.playbackState};
    const lists = await playlists(context);
    if (active === null && player.playbackState === 'stopped') {
      if (lists.length > 50 || lists.some(row => !Number.isInteger(row.itemCount) || row.itemCount < 0) || lists.reduce((sum, row) => sum + row.itemCount, 0) > 500) throw handoffError('STILL_HANDOFF_SNAPSHOT_TOO_LARGE', '无当前曲的完整列表保全超过上限；未退出。');
      const saved = [];
      for (const list of lists) saved.push({id: list.id, name: list.title, items: await snapshotItems(list)});
      return validateSnapshot({schemaVersion: 1, contextMode: 'none', playlistId: null, playlistName: null, currentIndex: null, items: [], playlists: saved, ...prefs});
    }
    if (!active || typeof active.playlistId !== 'string' || !Number.isSafeInteger(active.index)) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '当前播放列表引用未完整核验；未退出。');
    const matching = lists.filter(row => row.id === active.playlistId);
    if (matching.length !== 1 || !Number.isInteger(matching[0].itemCount) || matching[0].itemCount < 1 || matching[0].itemCount > 500) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '当前列表为空、过大或引用不唯一；未退出。');
    async function snapshotItems(list) {
    const rows = [], counts = new Map();
    while (rows.length < list.itemCount) {
      const count = Math.min(100, list.itemCount - rows.length);
      const page = await itemPage(list.id, rows.length, count, context);
      if (page.total !== list.itemCount || !page.items.length || page.items.length > count) throw handoffError('STILL_HANDOFF_CONTEXT_CHANGED', '交接列表分页已改变或超限；未继续读取或退出。');
      rows.push(...page.items);
    }
    if (rows.length !== list.itemCount || !rows.every(row => row.supported)) throw handoffError('STILL_HANDOFF_SNAPSHOT_UNVERIFIED', '列表曲目或子曲身份不完整；未退出。');
    return rows.map(row => {
      const key = locationKey(row), occurrence = counts.get(key) || 0; counts.set(key, occurrence + 1);
      return {path: row.path, subsong: row.subsong, occurrence};
    });
    }
    const items = await snapshotItems(matching[0]);
    if (locationKey(items[active.index] || {}) !== locationKey(trackFromColumns(active.columns))) throw handoffError('STILL_HANDOFF_CONTEXT_CHANGED', '当前曲与有序列表不一致；未退出。');
    return validateSnapshot({schemaVersion: 1, contextMode: 'active', playlistId: active.playlistId, playlistName: matching[0].title,
      currentIndex: active.index, items, ...prefs});
  }
  async function stableHandoffSnapshot(context) {
    const first = await handoffSnapshot(context), second = await handoffSnapshot(context);
    if (first.playlistId !== second.playlistId || contextIdentity(first) !== contextIdentity(second)) throw handoffError('STILL_HANDOFF_CONTEXT_CHANGED', '交接双次回读内容已改变；保留现有上下文，未退出。');
    return second;
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
        const key = locationKey(wanted), item = cached.byKey.get(key);
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
          if (wanted.has(index) && locationKey(page.items[index - first] || {}) !== locationKey(wanted.get(index))) {
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
  async function materialize(locations, context, retry = true) {
    context?.check();
    const byKey = await sources(locations, context);
    const missing = locations.filter(item => !byKey.has(locationKey(item)));
    if (missing.length) {
      const allowed = await musicRoots(context);
      if (!allowed.length) {
        const directories = [...new Set(missing.map(item => path.win32.dirname(item.path)))];
        throw new Error(`Beefweb 音乐允许目录为空（GET /browser/roots: []），无法导入新路径：${missing[0].path}。请手动在 foobar2000 的 Beefweb 音乐目录设置（musicDirs 字符串数组）中允许文件所在目录，例如 ${directories.join('、')}，再重试。现有列表内的精确曲目仍可使用。未调用 CLI /add，因为其目标受 Shell Integration 设置影响，无法保证不改动用户原列表。`);
      }
      context?.check();
      const archive = await store();
      context?.check();
      const uniquePaths = [...new Map(missing.map(item => [canonicalPath(item.path), item.path])).values()];
      await request(`playlists/${encodeURIComponent(archive.id)}/items/add`, { items: uniquePaths, async: true, replace: false, play: false }, { context });
      sourceCache.delete(archive.id);
      const loaded = await waitFor(() => playlistItems(archive.id, context), items => missing.every(wanted => items.some(item => item.supported && locationKey(item) === locationKey(wanted))),
        '精确曲目/子曲未加载完成或该子曲不受支持', context);
      for (const item of loaded) if (item.supported) byKey.set(locationKey(item), item);
    }
    const refs = locations.map(item => {
      const found = byKey.get(locationKey(item));
      if (!found) throw new Error(`无法精确定位子曲 ${item.subsong}: ${item.path}`);
      return found;
    });
    if (!await verifyRefs(refs, context)) {
      if (retry) return materialize(locations, context, false);
      throw new Error('源播放列表的曲目索引已改变；未开始播放，请重试。');
    }
    return refs;
  }
  async function verifyPlayback(expected, context) {
    let priorPosition = null, priorAt = 0;
    return waitFor(() => readState({ strict: true, context }), current => {
      if (current.state !== 'playing' || !current.currentTrack || locationKey(current.currentTrack) !== locationKey(expected)) return false;
      const now = Date.now();
      if (priorPosition != null && now > priorAt && current.position > priorPosition + 0.025) return true;
      if (priorPosition == null) { priorPosition = current.position; priorAt = now; }
      return false;
    }, '后端未确认目标曲目正在播放且时间前进；请检查 foobar2000 控制台、文件或输出设备', context);
  }
  async function simpleStateCommand(command, desired, context) {
    await commit(context, () => request(`player/${command}`, {}, { context }));
    return waitFor(() => readState({ strict: true, context }), item => !desired || desired(item), '后端状态未确认', context);
  }
  async function copyRefs(refs, deck, context) {
    let batch = [], sourceId = null;
    async function flush() {
      if (!batch.length) return;
      await request(`playlists/${encodeURIComponent(sourceId)}/${encodeURIComponent(deck.id)}/items/copy`, { items: batch }, { context });
      batch = [];
    }
    for (const ref of refs) {
      // foobar's item selection is a bit mask: arbitrary input order and repeated
      // indexes are not guaranteed by the API. Increasing runs batch safely while
      // preserving occurrences such as [A, B, A] as [A, B] then [A].
      if (batch.length && (ref.playlistId !== sourceId || ref.itemIndex <= batch.at(-1) || batch.length >= 500)) await flush();
      sourceId = ref.playlistId; batch.push(ref.itemIndex);
    }
    await flush();
  }
  function scheduleCleanup() {
    if (handoffLease) return;
    if (closed || cleanupTimer) return;
    cleanupTimer = setTimeout(() => { cleanupTimer = null; cleanupOwnedDecks().catch(notifyError); }, options.cleanupDelayMs ?? 25);
    cleanupTimer.unref?.();
  }
  async function cleanupOwnedDecks() {
    if (closed) return { removed: [], retained: [...ownedDecks.keys()] };
    if (cleanupPending) return cleanupPending;
    cleanupPending = performCleanup().finally(() => { cleanupPending = null; });
    return cleanupPending;
  }
  async function performCleanup() {
    const current = await playlists(), byId = new Map(current.map(item => [item.id, item]));
    if (!ownedDiscovered) {
      for (const item of current) if (deckTitle(item.title)) ownedDecks.set(item.id, { id: item.id, title: item.title, createdAt: 0 });
      ownedDiscovered = true;
    }
    for (const [id, deck] of ownedDecks) if (byId.get(id)?.title !== deck.title) ownedDecks.delete(id);
    async function protectedIds() {
      const result = await request('query?player=true&playQueue=true');
      checkPlayer(result?.player);
      if (!Array.isArray(result.playQueue)) throw new Error('清理前无法确认播放队列；保留 STILL 播放列表。');
      return new Set([result.player.activeItem?.playlistId, ...result.playQueue.map(item => item.playlistId), ...pins.keys(),
        ...[...ownedDecks.values()].filter(deck => pendingDeckTitles.has(deck.title)).map(deck => deck.id)].filter(Boolean));
    }
    const protectedSet = await protectedIds();
    const candidates = [...ownedDecks.values()].filter(item => !protectedSet.has(item.id)).sort((a, b) => a.createdAt - b.createdAt);
    const remove = candidates.slice(0, Math.max(0, candidates.length - keepDecks)).slice(0, cleanupBatchSize);
    const removed = [];
    for (const deck of remove) {
      // Recheck actual queue and active references immediately before each delete.
      // Never clear a live deck; deleting one item would shift queued indexes.
      if ((await protectedIds()).has(deck.id)) continue;
      const actual = (await playlists()).find(item => item.id === deck.id);
      if (!actual || actual.title !== deck.title || !deckTitle(actual.title) || pins.has(deck.id) || pendingDeckTitles.has(deck.title)) continue;
      await request(`playlists/remove/${encodeURIComponent(deck.id)}`, {});
      ownedDecks.delete(deck.id); sourceCache.delete(deck.id); removed.push(deck.id);
    }
    if (candidates.length - keepDecks > cleanupBatchSize && removed.length) scheduleCleanup();
    return { removed, retained: [...ownedDecks.keys()] };
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
    getState: () => readState(), playbackContext, librarySnapshot, cleanupOwnedDecks,
    async acquireOutputHandoff({signal, check} = {}) {
      if (handoffLease) throw handoffError('STILL_HANDOFF_BUSY', '另一音频交接尚未完成。');
      const lease = {}; handoffLease = lease;
      if (cleanupTimer) clearTimeout(cleanupTimer); cleanupTimer = null;
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
          await Promise.race([Promise.allSettled([service.cancelPending(), mutation, transport, queueTransport, cleanupPending].filter(Boolean)), aborted]);
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
    transportStatus: () => ({ closed, controlUncertain: Boolean(transportFault), backendExited: Boolean(backendExitEvidence), pendingControlRequests }),
    getAudioTransportStatus: () => ({pending: !backendExitEvidence && pendingAudioRequests > 0}),
    async outputConnection() { await loadOutputSelection(); return refreshOutputConnection(); },
    async retryOutput() {
      // Explicit diagnostic retry only. Never select a fallback, dispatch play,
      // or turn a new GET into settlement proof for a lost control connection.
      await service.cancelPending();
      await readState({ strict: true });
      if (transportFault) throw transportFault;
      if (closed) throw backendExitEvidence ? backendExitedError() : new Error('foobar bridge 已关闭。');
      await requirePlaybackOutput(null, { clearRetry: true });
      return { ready: true, backendReachable: state.available === true, outputConnection: connectionSnapshot(), state: decorate(state) };
    },
    bindBackendSession(session) {
      if (closed || !isVerifiedBackendSession(session, { foobarDir, baseUrl: base.href })) throw new Error('未收到同目录、同端口的已核验专属后端 session；不能绑定退出证据。');
      if (backendSession && backendSession !== session) throw new Error('此桥接器已绑定另一进程 session；新后端必须使用新的桥接器，不能替换旧连接的退出证明。');
      backendSession = session;
      return { sessionId: session.sessionId, pid: session.pid };
    },
    markBackendExited(evidence) {
      if (!isVerifiedBackendExit(evidence, backendSession, { foobarDir, baseUrl: base.href })) throw new Error('退出证据未匹配本桥接器的已核验 owned PID/session；保留 HTTP 执行屏障。');
      if (backendExitEvidence) return { backendExited: true, exitEvidence: backendExitEvidence };
      backendExitEvidence = evidence;
      closed = true; ++generation; intent?.controller.abort(); intent = null;
      connectionController.abort();
      for (const controller of preparationControllers) controller.abort();
      if (timer) clearInterval(timer); timer = null;
      if (cleanupTimer) clearTimeout(cleanupTimer); cleanupTimer = null;
      publishedRead = ++readSequence;
      verifiedExitController.abort(backendExitedError());
      publish({ ...offline('本次专属播放内核进程已确认退出。'), backendExited: true, controlUncertain: false,
        exitEvidence: { sessionId: evidence.sessionId, pid: evidence.pid, verifiedBy: evidence.verifiedBy } });
      return { backendExited: true, exitEvidence: evidence };
    },
    cancelPending() { intent?.controller.abort(); invalidateSerialControls(); ++generation; intent = null;
      return transport.then(() => {
        if (backendExitEvidence) return { backendExited: true, exitEvidence: backendExitEvidence };
        if (transportFault) throw transportFault;
      }); },
    async releaseOutput({ signal } = {}) {
      await service.cancelPending();
      if (signal?.aborted) throw cancelled();
      const stopped = await service.stop();
      if (signal?.aborted) throw cancelled();
      if (typeof options.waitForOutputRelease !== 'function') throw new Error('未配置同端点的独占释放探测；stopped 读回不能证明音频设备已释放。');
      const proof = await options.waitForOutputRelease({ output: stopped.output, signal });
      if (signal?.aborted) throw cancelled();
      if (proof?.released !== true) throw new Error('尚未确认本地音频设备已释放。');
      return { ...proof, state: stopped };
    },
    prepareLocations(input) { return runPreparation(async context => {
      const locations = normalizeLocations(Array.isArray(input) ? input : input?.locations || input?.paths);
      await materialize(locations, context);
      return { prepared: true, count: locations.length, locations };
    }); },
    play(input = {}) { return runIntent(async context => {
      const locations = normalizeLocations(input.locations || input.paths);
      const startIndex = input.startIndex ?? 0;
      if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= locations.length) throw new Error('起始曲目索引无效。');
      await requirePlaybackOutput(context, { readBackend: true });
      const refs = await materialize(locations, context);
      // New immutable deck: clearing a playlist would invalidate real queue references.
      const deck = await addPlaylist(`STILL · Playback ${new Date().toISOString()} ${randomUUID()} [${identity.instanceId}]`, context);
      try {
        context.check();
        await copyRefs(refs, deck, context);
        const copied = await playlistItems(deck.id, context);
        if (copied.length !== locations.length || copied.some((item, index) => locationKey(item) !== locationKey(locations[index]))) {
          for (const ref of refs) sourceCache.delete(ref.playlistId);
          throw new Error('播放列表复制后的子曲身份不匹配；未开始播放，请重试。');
        }
        await commit(context, () => request(`player/play/${encodeURIComponent(deck.id)}/${startIndex}`, {}, { context }), { startsPlayback: true });
        return await verifyPlayback(locations[startIndex], context);
      } finally { releasePin(deck.id, context); }
    }); },
    toggle() { return runIntent(async context => {
      const before = await readState({ strict: true, context });
      if (before.state === 'playing') return simpleStateCommand('pause', item => item.state === 'paused', context);
      await commit(context, () => request('player/play', {}, { context }), { startsPlayback: true });
      if (before.currentTrack) return verifyPlayback(before.currentTrack, context);
      const first = await waitFor(() => readState({ strict: true, context }), item => item.state === 'playing' && item.currentTrack, '没有可恢复的曲目', context);
      return verifyPlayback(first.currentTrack, context);
    }); },
    pause: () => runIntent(context => simpleStateCommand('pause', item => item.state === 'paused' || item.state === 'stopped', context)),
    stop: () => runIntent(context => simpleStateCommand('stop', item => item.state === 'stopped', context)),
    next: () => runIntent(async context => {
      await requirePlaybackOutput(context, { readBackend: true });
      await commit(context, () => request('player/next', {}, { context }), { startsPlayback: true }); const now = await readState({ strict: true, context });
      return now.state === 'stopped' ? now : verifyPlayback(now.currentTrack || {}, context);
    }),
    previous: () => runIntent(async context => {
      await requirePlaybackOutput(context, { readBackend: true });
      await commit(context, () => request('player/previous', {}, { context }), { startsPlayback: true }); const now = await readState({ strict: true, context });
      return now.state === 'stopped' ? now : verifyPlayback(now.currentTrack || {}, context);
    }),
    seek(position) { return runIntent(async context => {
      const before = await readState({ strict: true, context });
      if (!Number.isFinite(position) || position < 0 || (before.duration > 0 && position > before.duration)) throw new Error('播放位置无效。');
      if (!['playing', 'paused'].includes(before.state)) throw new Error('当前没有可跳转的播放曲目。');
      await commit(context, () => request('player', { position }, { context }));
      return waitFor(() => readState({ strict: true, context }), item => Math.abs(item.position - position) < 1, '后端未确认跳转位置', context);
    }); },
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
    async queueList() {
      const result = await request(`playqueue?columns=${encodeURIComponent(COLUMNS.join(','))}`);
      if (!Array.isArray(result?.playQueue)) throw new Error('Beefweb 队列响应格式无效。');
      return { items: result.playQueue.map((item, index) => ({ ...trackFromColumns(item.columns), index,
        playlistId: item.playlistId, itemIndex: item.itemIndex })), source: 'foobar2000' };
    },
    queueAdd(input) { return queueAction(async context => {
      const locations = normalizeLocations(Array.isArray(input) ? input : input?.locations || input?.paths);
      const refs = await materialize(locations, context);
      const before = await service.queueList();
      for (const ref of refs) await request('playqueue/add', { plref: ref.playlistId, itemIndex: ref.itemIndex }, { context });
      return waitFor(() => service.queueList(), queue => queue.items.length >= before.items.length + refs.length &&
        locations.every((item, index) => locationKey(queue.items[before.items.length + index]) === locationKey(item)), '后端未确认排队曲目；播放中的队列可能已消费条目', context);
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
      lastOutputs = normalizeOutputs((await request('outputs', undefined, { context }))?.outputs);
      if (!selectedOutput && lastOutputs.selected) rememberOutput(lastOutputs.selected);
      await refreshOutputConnection();
      return { ...lastOutputs, outputConnection: connectionSnapshot() };
    },
    selectOutput(id) { return serial(async context => {
      const before = await service.outputs({ context });
      const wanted = before.outputs.find(item => item.id === id || (id && typeof id === 'object' && item.typeId === id.typeId && item.deviceId === id.deviceId));
      if (!wanted) throw new Error('输出标识无效或设备已断开；未选择其他输出。');
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
      installedOrReachable: state.available, playback: Boolean(state.available && selectedOutput && lastOutputs?.active && !closed && !transportFault &&
        (!connection.endpointId || connection.status === 'connected') && sameOutput(lastOutputs.active, selectedOutput)),
      playlists: true, queue: true, outputSelection: true, outputConnection: true, retryOutput: true,
      subsong: true, subsongStrategy: 'read-and-verify-exact-playlist-index', playbackOrder: true,
      cancellablePlayback: true, prepareLocations: true, ownedDeckCleanup: true,
      localImport: { strategy: 'beefweb-allowed-directories', roots: roots?.items ?? null, cli: false },
      mediaLibraryEnumeration: false, measuresHardwareFormat: false, measuresExclusiveOwnership: false }; },
    restoreInfo() { return { foobarDir, dataDir, baseUrl: base.href,
      backupDir: path.join(foobarDir, 'Still-backup-20261028-before-beefweb'),
      guide: path.resolve(__dirname, '../../docs/foobar-bridge.md'),
      automaticInstallation: false, automaticLaunch: false, lastError }; },
    close() { if (disposal) return disposal;
      closed = true; intent?.controller.abort(); for (const controller of preparationControllers) controller.abort();
      connectionController.abort();
      if (timer) clearInterval(timer); timer = null;
      if (cleanupTimer) clearTimeout(cleanupTimer); cleanupTimer = null;
      disposal = Promise.allSettled([...operations, mutation, transport, queueTransport, identityWrite, outputSelectionWrite, cleanupPending, connectionPending?.promise].filter(Boolean)).then(() => {
        // Backend lifetime belongs to its manager. Disposing a bridge alone is
        // never evidence that an unresolved playback POST cannot still execute.
        events.removeAllListeners();
      });
      return disposal;
    },
  };
  return service;
}

module.exports = { createFoobarService, trackFromColumns, normalizedVolume, backendVolume,
  normalizeOutputs, normalizeOrders, normalizeLocations, locationKey, COLUMNS, INSTALL_HELP };
