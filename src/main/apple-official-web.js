'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');

const MESSAGES = Object.freeze({
  'official-host-missing': 'Apple Music 官方会话组件尚未构建，当前不能播放。',
  'webview2-runtime-missing': '未检测到 Microsoft Edge WebView2 Runtime，当前不能打开 Apple Music 官方会话。',
  'session-closed': '打开 Apple Music 官方会话并自行登录；本程序无需 Apple Developer 会员或额外付费播放后端。',
  'needs-auth': '请在真实 Apple Music 官方会话窗口中自行登录并完成授权。',
  'needs-user-interaction': '官网浏览器尚未允许播放，请在 Apple Music 官方会话窗口中完成必要点击，然后重试。',
  'official-player-not-ready': 'Apple Music 官方播放器尚未就绪，请稍后重试。',
  'official-origin-required': '官方会话离开了允许的 Apple Music 来源，当前操作已停止。',
  'official-operation-failed': 'Apple Music 官网未确认操作；请检查官方会话中的账号、订阅及提示。',
  'official-api-unavailable': '官网当前未暴露可用的公开 MusicKit API，当前功能已停用。',
  'official-invalid-response': '官网返回了无法核验的公开数据，未把操作标记为成功。',
  'official-control-unavailable': '官网当前未提供此公开控制能力。',
  'official-queue-unavailable': '官网当前未提供可读取的公开 MusicKit 队列。',
  'unsupported-item': '此内容尚无已确认的公开播放方式；当前只播放明确的歌曲或有真实目录映射的曲库歌曲。',
  'official-track-unconfirmed': '未从官网播放器回读到所选歌曲的真实播放状态，未将播放标记为成功。',
  'official-stop-unconfirmed': '尚未确认官网会话已停止并释放音频输出。',
  'official-audio-cleanup-unverified': '尚未确认已授权播放的官方会话已关闭并停止发声；未允许新的播放或另一引擎接管。',
  'host-timeout': 'Apple Music 官方会话未及时返回，请检查窗口后手动重试。',
  'host-exited': 'Apple Music 官方会话已关闭。',
  'host-initialization-failed': 'Apple Music 官方会话无法初始化，请检查 WebView2 Runtime。',
  'official-navigation-failed': '无法打开真实 Apple Music 官方网站，请检查网络或稍后重试。',
  'official-bridge-unavailable': '官网公开播放器互操作入口不可用，当前不能控制播放。',
  'official-process-failed': 'Apple Music 官方会话的网页进程已停止。',
  'invalid-input': 'Apple Music 操作参数无效。',
  'invalid-item': 'Apple Music 内容 ID 无效。',
  'closed': 'Apple Music 服务已关闭。',
});
const ERROR_ORIGINS = new Set(['node-startup-timeout', 'node-page-not-ready', 'native-ready-guard', 'native-origin-guard', 'native-sdk-ready-timeout', 'bridge-instance']);
function error(code, origin) {return Object.assign(new Error(MESSAGES[code] || MESSAGES['official-operation-failed']), {code, officialError: true,
  ...(ERROR_ORIGINS.has(origin) ? {origin} : {})});}
function cancelled() {return Object.assign(new Error('播放请求已被较新的操作取消。'), {code: 'STILL_CANCELLED', officialError: true});}
function safeError(value) {return value?.officialError ? value : error('official-operation-failed');}
const ID = /^[A-Za-z0-9._-]{1,200}$/;
const TYPES = new Set(['songs', 'albums', 'artists', 'playlists', 'music-videos', 'library-songs', 'library-albums', 'library-artists', 'library-playlists']);
const METHODS = new Set(['probe', 'state', 'search', 'library', 'queue', 'play', 'pause', 'resume', 'stop', 'seek', 'volume', 'order', 'next', 'previous', 'cancel', 'show', 'hide', 'close']);
const AUTOPLAY_DECISIONS = new Set(['not-seen', 'awaiting-request', 'revoked', 'allow-pending', 'allow-session', 'deny-kind', 'deny-core', 'deny-origin', 'deny-navigation', 'deny-revoked', 'deny-nonce', 'deny-expired', 'temporary-policy-unavailable', 'handler-unavailable']);
const PUBLIC_METHODS = ['play', 'pause', 'stop', 'next', 'previous', 'seek', 'setQueue', 'apiMusic', 'queue', 'volume', 'albumPlayback', 'order'];
const ALBUM_TRACK_LIMIT = 500;
const PLAYBACK_ORDERS = ['顺序', '列表循环', '单曲循环', '随机', '随机 · 列表循环', '随机 · 单曲循环'];
function playbackOrder(id) {return Number.isSafeInteger(id) && PLAYBACK_ORDERS[id] ? {id, name: PLAYBACK_ORDERS[id]} : null;}
function queueIds(value) {
  return Array.isArray(value) && value.length <= ALBUM_TRACK_LIMIT &&
    Array.from(value).every(id => typeof id === 'string' && ID.test(id)) ? value : null;
}
function sameQueue(actual, expected) {return actual?.length === expected.length && expected.every((id, index) => id === actual[index]);}
function sameTracks(actual, expected) {return actual?.length === expected.length && sameQueue([...actual].sort(), [...expected].sort());}
function albumMatches(actual, expected, orderId) {return orderId >= 3 ? sameTracks(actual, expected) : sameQueue(actual, expected);}
function cleanText(value, length = 500) {return typeof value === 'string' ? value.slice(0, length).replace(/[\u0000-\u001f]/g, '') : '';}
function integer(value, min, max) {if (!Number.isSafeInteger(value) || value < min || value > max) throw error('invalid-input'); return value;}
function numeric(value, min, max) {if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw error('invalid-input'); return value;}
function artworkUrl(value, artworkUrlFor) {
  if (typeof artworkUrlFor !== 'function' || typeof value !== 'string' || value.length > 2048 || /[\s\\%?#]/.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/^is[1-5]-ssl\.mzstatic\.com$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash) return '';
    if (!/^\/image\/thumb\/(?:[A-Za-z0-9._~-]+\/)+512x512(?:bb)?\.(?:jpe?g|png)$/.test(url.pathname)) return '';
    const local = artworkUrlFor(url.href);
    return typeof local === 'string' && /^still-apple-art:\/\/art\/[a-f0-9]{64}$/.test(local) ? local : '';
  } catch {return '';}
}
function item(raw, artworkUrlFor) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID.test(raw.id) || !TYPES.has(raw.type)) return null;
  return {id: raw.id, type: raw.type, source: 'apple', title: cleanText(raw.title) || '未命名', artist: cleanText(raw.artist), album: cleanText(raw.album),
    duration: Number.isFinite(raw.duration) && raw.duration >= 0 ? raw.duration : null, coverUrl: artworkUrl(raw.coverUrl, artworkUrlFor),
    catalogId: typeof raw.catalogId === 'string' && ID.test(raw.catalogId) ? raw.catalogId : null,
    playable: raw.playable === true && ['songs', 'library-songs'].includes(raw.type)};
}
function list(value, artworkUrlFor, strict = false) {
  if (!value || !Array.isArray(value.items) || value.items.length > 200) throw error('official-invalid-response');
  const items = Array.from(value.items, raw => item(raw, artworkUrlFor)).filter(Boolean);
  if (strict && items.length !== value.items.length) throw error('official-invalid-response');
  return {kind: cleanText(value.kind, 50), items, offset: Number.isSafeInteger(value.offset) ? value.offset : 0,
    limit: Number.isSafeInteger(value.limit) ? value.limit : items.length, hasMore: value.hasMore === true,
    ...(Number.isSafeInteger(value.nextOffset) && value.nextOffset >= 0 ? {nextOffset: value.nextOffset} : {}),
    ...(typeof value.albumPlayback === 'boolean' ? {albumPlayback: value.albumPlayback} : {}),
    ...(Number.isSafeInteger(value.total) && value.total >= 0 ? {total: value.total} : {}),
    ...(Number.isSafeInteger(value.position) ? {position: value.position} : {})};
}

function createNativeOfficialHost({hostPath, profileDir, bridgePath = path.join(path.dirname(hostPath), 'official-bridge.js'), spawnImpl = spawn, mkdirImpl = fs.mkdir} = {}) {
  let child = null, ready = null, readyResolve, readyReject, exitPromise = Promise.resolve(), id = 0;
  let running = false, starting = null, closing = null, lifecycle = 0, browserExitConfirmed = false, runtime = null;
  let pageReady = false;
  let autoplayPolicy = {configured: false, seen: false, decision: 'not-seen'};
  const pending = new Map();
  const unsettledStarts = new Set();
  function rejectPending(reason, owner) {
    for (const [requestId, operation] of pending) {
      if (owner && operation.owner !== owner) continue;
      clearTimeout(operation.timer); operation.reject(reason); pending.delete(requestId);
    }
  }
  function send(method, data = {}, timeout = 20000) {
    if (!METHODS.has(method)) return Promise.reject(error('invalid-input'));
    if (!child || !running || !child.stdin.writable) return Promise.reject(error('host-exited'));
    const ownChild = child;
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {pending.delete(requestId); reject(error('host-timeout'));}, timeout);
      pending.set(requestId, {method, resolve, reject, timer, owner: ownChild});
      if (method === 'play' || method === 'resume') unsettledStarts.add(requestId);
      // RPC correlation is separate from the Apple Music content identifier.
      const line = JSON.stringify({...data, rpcId: requestId, method});
      if (Buffer.byteLength(line) > 65536) {clearTimeout(timer); pending.delete(requestId); reject(error('invalid-input')); return;}
      ownChild.stdin.write(`${line}\n`, failure => {
        if (failure && pending.has(requestId)) {clearTimeout(timer); pending.delete(requestId); reject(error('host-exited'));}
      });
    });
  }
  async function spawnSession({show}, epoch) {
    await mkdirImpl(profileDir, {recursive: true});
    if (epoch !== lifecycle) throw cancelled();
    ready = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
    const ownReadyResolve = readyResolve, ownReadyReject = readyReject, ownReady = ready;
    ready.catch(() => {}); browserExitConfirmed = false; pageReady = false; autoplayPolicy = {configured: false, seen: false, decision: 'not-seen'};
    child = spawnImpl(hostPath, [profileDir, bridgePath, ...(show ? ['--show'] : [])], {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    const ownChild = child; running = true;
    const startupTimer = setTimeout(() => ownReadyReject(error('official-player-not-ready', 'node-startup-timeout')), 30000);
    ownChild.stderr.on('data', () => {}); // Never forward runtime/auth diagnostics.
    let bytesInLine = 0;
    const lines = readline.createInterface({input: ownChild.stdout, crlfDelay: Infinity});
    ownChild.stdout.on('data', chunk => {
      bytesInLine += chunk.length;
      if (chunk.includes(10)) bytesInLine = chunk.length - chunk.lastIndexOf(10) - 1;
      if (bytesInLine > 2097152) {rejectPending(error('official-invalid-response'), ownChild); ownChild.kill();}
    });
    lines.on('line', line => {
      if (Buffer.byteLength(line) > 2097152) return rejectPending(error('official-invalid-response'), ownChild);
      let message; try {message = JSON.parse(line);} catch {return;}
      if (message.type === 'ready' && message.origin === 'https://music.apple.com') {
        if (child !== ownChild || epoch !== lifecycle) return;
        pageReady = true; runtime = cleanText(message.runtime, 80); clearTimeout(startupTimer); ownReadyResolve({runtime});
      } else if (message.type === 'phase' && message.phase === 'loading') {
        if (child === ownChild && epoch === lifecycle) pageReady = false;
      } else if (message.type === 'autoplay-policy') {
        if (child === ownChild && epoch === lifecycle && AUTOPLAY_DECISIONS.has(message.decision)) autoplayPolicy = {
          configured: message.configured === true, seen: message.seen === true, decision: message.decision};
      } else if (message.type === 'response' && Number.isSafeInteger(message.rpcId)) {
        unsettledStarts.delete(message.rpcId);
        const operation = pending.get(message.rpcId); if (!operation) return;
        if (operation.owner !== ownChild) return;
        pending.delete(message.rpcId); clearTimeout(operation.timer);
        if (operation.method === 'close') browserExitConfirmed = message.value?.browserProcessExited === true;
        if (message.ok === true) operation.resolve(message.value);
        else operation.reject(message.code === 'cancelled' ? cancelled() : error(message.code, message.origin));
      } else if (message.type === 'error') {
        if (child === ownChild) pageReady = false;
        clearTimeout(startupTimer); ownReadyReject(error(message.code, message.origin)); rejectPending(error(message.code, message.origin), ownChild);
      }
    });
    ownChild.on('error', () => {clearTimeout(startupTimer); ownReadyReject(error('host-initialization-failed')); rejectPending(error('host-initialization-failed'), ownChild);});
    exitPromise = new Promise(resolve => ownChild.once('close', () => {
      clearTimeout(startupTimer); lines.close();
      if (child === ownChild) {running = false; child = null; pageReady = false;}
      unsettledStarts.clear(); ownReadyReject(error('host-exited')); rejectPending(error('host-exited'), ownChild); resolve();
    }));
    return ownReady;
  }
  async function start({show = false} = {}) {
    while (closing) await closing;
    if (starting) {const value = await starting; if (show && running) await send('show'); return value;}
    if (running) {await ready; if (show) await send('show'); return {runtime};}
    const epoch = ++lifecycle;
    const work = spawnSession({show}, epoch);
    starting = work;
    try {return await work;}
    catch (value) {
      if (epoch === lifecycle && running) await close();
      throw value;
    } finally {if (starting === work) starting = null;}
  }
  async function close(expectedChild) {
    if (expectedChild && child !== expectedChild) return {closed: false, sessionChanged: true, browserProcessExited: false, helperExited: false};
    if (closing) return closing;
    const pendingStart = starting;
    lifecycle++;
    pageReady = false;
    autoplayPolicy = {...autoplayPolicy, decision: ['temporary-policy-unavailable', 'handler-unavailable'].includes(autoplayPolicy.decision) ? autoplayPolicy.decision : 'revoked'};
    readyReject?.(cancelled());
    if (!running && !pendingStart) return {closed: true, browserProcessExited: browserExitConfirmed, helperExited: true};
    closing = (async () => {
      // A mkdir-delayed startup sees the epoch fence and never spawns after
      // close. If already spawned, close that exact process without waiting
      // for the website to finish loading or for a new start request.
      if (!running && pendingStart) await pendingStart.catch(() => {});
      if (!running) return {closed: true, browserProcessExited: browserExitConfirmed, helperExited: true};
      const ownChild = child;
      const ownExit = exitPromise;
      try {await send('close', {}, 7500);} catch {}
      const exited = await Promise.race([ownExit.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1500))]);
      if (!exited && ownChild && ownChild.exitCode === null) {ownChild.kill(); await Promise.race([ownExit, new Promise(resolve => setTimeout(resolve, 1500))]);}
      if (pendingStart) await pendingStart.catch(() => {});
      return {closed: true, browserProcessExited: browserExitConfirmed, helperExited: child !== ownChild || !running};
    })().finally(() => {closing = null;});
    return closing;
  }
  async function request(method, data, timeout) {
    // A command waiting on the old close must never be forwarded to whatever
    // child a newer explicit intent has created in the meantime.
    if (closing) {await closing; throw cancelled();}
    if (starting) throw error('official-player-not-ready', 'node-page-not-ready');
    if (running && !pageReady) throw error('official-player-not-ready', 'node-page-not-ready');
    return send(method, data, timeout);
  }
  return {start, request, close, isRunning: () => running, isReady: () => running && pageReady, isClosing: () => Boolean(closing), isStarting: () => Boolean(starting),
    autoplayPolicy: () => ({...autoplayPolicy}),
    hasUnsettledStart: () => unsettledStarts.size > 0, runtime: () => runtime,
    captureSession: () => child,
    closeSession(owner) {
      if (!owner || child !== owner) return Promise.resolve({closed: false, sessionChanged: true, browserProcessExited: false, helperExited: false});
      return close(owner);
    },
    cancelPending({preserveStarting = false, preservePlaybackPermission = false} = {}) {
      if (closing) return closing;
      if (starting && unsettledStarts.size === 0) return preserveStarting ? Promise.resolve() : close();
      if (!running) return closing || Promise.resolve();
      const mustDispose = unsettledStarts.size > 0;
      // Dispose an owned context containing an unfinished start, rather than
      // pretending an async MusicKit setQueue/play can be undone by a Promise.
      if (mustDispose) return close();
      return send('cancel', preservePlaybackPermission ? {preservePlaybackPermission: true} : {}, 5000);
    }};
}

async function detectRuntime() {
  if (process.platform !== 'win32') return null;
  const application = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'EdgeWebView', 'Application');
  try {return (await fs.readdir(application)).filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, {numeric: true}))[0] || null;}
  catch {return null;}
}

function createOfficialAppleMusicService({dataDir, hostPath = path.resolve(__dirname, '..', '..', 'native', 'apple-host', 'bin', 'StillAppleHost.exe'),
  hostFactory = createNativeOfficialHost, verifyOutputReleased, emit = () => {}, runtimeDetector = detectRuntime,
  verificationTimeout = 10000, pollInterval = 200, artworkUrlFor} = {}) {
  if (typeof dataDir !== 'string') throw new Error('Apple Music dataDir is required');
  const host = hostFactory({hostPath, profileDir: path.join(dataDir, 'apple-music', 'official-webview-profile')});
  let built = false, runtime = null, methods = {}, authorized = false, issue = null, closed = false, selectedVerified = false, authorizedAudio = false;
  let generation = 0, audioAttempt = 0, writes = Promise.resolve(), cleanupTail = Promise.resolve(), readSequence = 0, publishedRead = 0, lastState = null;
  let audioSafetyFailure = null, audioRisk = false, audioSession = null, closingService = false, closeWork = null;
  let lastOperation = null, operationSequence = 0;
  let activeAlbumIds = null;
  const operationHistory = [];
  let cancellationTail = Promise.resolve(), reopenPermit = null, reopening = null, pendingAudioOperation = null, retiringContexts = 0;
  const known = new Map();
  function beginOperation(method, stage = 'dispatch', selection) {
    const reporting = {method, sequence: ++operationSequence, generation,
      ...(method === 'play' && ['songs', 'library-songs'].includes(selection?.kind) && typeof selection.id === 'string' && ID.test(selection.id)
        ? {kind: selection.kind, id: selection.id} : {})};
    recordOperation(reporting, stage); return reporting;
  }
  function recordOperation(reporting, stage, failure) {
    const code = failure ? failure.code === 'STILL_CANCELLED' ? 'STILL_CANCELLED' : Object.hasOwn(MESSAGES, failure.code) ? failure.code : 'official-operation-failed' : null;
    const failedFromStage = stage === 'failed' ? reporting.failedFromStage || reporting.lastStage : null;
    if (stage === 'failed') reporting.failedFromStage = failedFromStage;
    reporting.lastStage = stage;
    const value = {method: reporting.method, stage, code,
      ...(failedFromStage ? {failedFromStage} : {}), ...(ERROR_ORIGINS.has(failure?.origin) ? {origin: failure.origin} : {}),
      ...(reporting.kind ? {kind: reporting.kind, id: reporting.id} : {})};
    operationHistory.push({...value, operationId: reporting.sequence, generation: reporting.generation});
    if (operationHistory.length > 16) operationHistory.shift();
    if (reporting.sequence === operationSequence) lastOperation = value;
  }
  function uncertainAudio() {
    audioSafetyFailure = {session: audioSession, pending: false};
    authorizedAudio = false; selectedVerified = false; activeAlbumIds = null; issue = 'official-audio-cleanup-unverified';
  }
  function acceptAudioExit(result, owner) {
    if (result?.browserProcessExited !== true || result?.helperExited !== true) return false;
    // Exit evidence belongs to the exact session whose audio was authorized.
    if (audioRisk && audioSession !== owner) return false;
    audioRisk = false; audioSession = null; audioSafetyFailure = null;
    authorizedAudio = false; selectedVerified = false; lastState = null; activeAlbumIds = null;
    if (issue === 'official-audio-cleanup-unverified') issue = null;
    return true;
  }
  function status() {
    const session = host.isRunning();
    const pageReady = host.isReady?.() !== false;
    if (audioRisk && !session && !host.isClosing?.() && !retiringContexts) uncertainAudio();
    const pending = Boolean(pendingAudioOperation || reopening || retiringContexts || host.isClosing?.() || host.isStarting?.() || session && !pageReady);
    const controlsReady = !pending && selectedVerified && authorizedAudio && session && !audioSafetyFailure && !closed && !closingService;
    const capability = name => session && pageReady && authorized && methods[name] === true && !closed && !closingService;
    const reason = closed ? 'closed' : !built ? 'official-host-missing' : !runtime ? 'webview2-runtime-missing' : issue || (!session ? 'session-closed' : !authorized ? 'needs-auth' : null);
    const canPlay = capability('play') && methods.setQueue === true && !host.isClosing?.() && !retiringContexts && !reopening && !audioSafetyFailure;
    const canOrder = capability('order') && !pending && !audioSafetyFailure;
    const canSubmitPlayIntent = !closed && !closingService && !audioSafetyFailure &&
      Boolean(reopenPermit?.generation === generation && reopenPermit.session || reopening?.permit.generation === generation);
    return {id: 'apple', name: 'Apple Music', provider: 'officialWeb', configured: authorized, available: canPlay,
      status: closed || !built || !runtime ? 'unavailable' : issue === 'needs-user-interaction' ? 'needs-user-interaction' : !session ? 'session-closed' : !authorized ? 'authorization-required' : selectedVerified ? 'ready' : 'session-unverified',
      actionLabel: '打开 Apple Music 会话',
      message: reason ? MESSAGES[reason] || MESSAGES['official-operation-failed'] : selectedVerified ? '已回读官网所选歌曲的播放状态。订阅全曲及实际 DAC 输出仍以真实播放验收为准。' : '官方会话已登录；公开接口存在，尚未验证本次订阅全曲。',
      reasonCodes: reason ? [reason] : selectedVerified ? ['subscription-full-song-unverified'] : ['protected-playback-unverified'],
      credentials: null,
      runtime: {provider: 'Microsoft WebView2', available: !!runtime, version: runtime, hostBuilt: built, sessionOpen: session, origin: 'https://music.apple.com'},
      controlled: host.isRunning() && pageReady && authorizedAudio && !retiringContexts && !host.isClosing?.(),
      audioReleaseUnverified: !!audioSafetyFailure,
      pending, controlsReady,
      playbackOrder: canOrder && lastState?.playbackOrder ? {...lastState.playbackOrder} : null,
      playbackOrders: canOrder ? PLAYBACK_ORDERS.map((_name, id) => playbackOrder(id)) : [],
      lifecyclePhase: host.isClosing?.() ? 'closing' : reopening || host.isStarting?.() || session && !pageReady ? 'starting' : session ? 'ready' : 'closed',
      autoplayPolicy: host.autoplayPolicy?.() || {configured: false, seen: false, decision: 'not-seen'},
      methodSupport: Object.fromEntries(PUBLIC_METHODS.map(name => [name, methods[name] === true])),
      lastOperation: lastOperation ? {...lastOperation} : null,
      operationHistory: operationHistory.map(row => ({...row})),
      verification: {publicCatalogRead: 'evidence/apple-official-catalog-probe-20261030/webview2-eme.json', selectedPlaybackReadback: selectedVerified, subscriptionFullSong: false, actualDacRate: null},
      capabilities: {configure: false, configureKey: false, importToken: false, pairing: false, authorize: !closed && built && !!runtime,
        library: capability('apiMusic'), search: session && pageReady && methods.apiMusic === true && !closed, playback: canPlay,
        albumPlayback: methods.albumPlayback === true && (canPlay || canSubmitPlayIntent),
        canSubmitPlayIntent, playIntentTypes: canSubmitPlayIntent ? ['songs', 'library-songs'] : [],
        queue: capability('queue'), queueActions: [], toggle: controlsReady && capability('pause') && methods.play === true,
        previous: controlsReady && capability('previous'), next: controlsReady && capability('next'), seek: controlsReady && capability('seek'), volume: capability('volume') && !pending, order: canOrder, lyrics: false,
        playableTypes: canPlay ? ['songs', 'library-songs'] : [],
        detailKinds: capability('apiMusic') ? ['album-songs', 'playlist-songs', 'artist-albums'] : []}};
  }
  function publish() {const value = status(); emit('source', value); return value;}
  function check(op) {if (closed || closingService) throw error('closed'); if (op.generation !== generation || op.context?.signal?.aborted || op.audioAttempt !== undefined && op.audioAttempt !== audioAttempt) throw cancelled(); op.context?.check?.();}
  function op(context) {return {generation, context};}
  async function waitForLifecycle(operation, allowReopen = false) {
    await cancellationTail; await cleanupTail; check(operation);
    if (audioSafetyFailure) throw error('official-audio-cleanup-unverified');
    if (reopening) {await reopening.work; check(operation);}
    if (host.isRunning()) return;
    const permit = reopenPermit;
    if (!allowReopen || !permit || permit.generation !== generation || !permit.confirmed || permit.consumed) throw error('session-closed');
    permit.consumed = true;
    const opening = {permit, work: null};
    opening.work = Promise.resolve().then(() => host.start({show: false}));
    reopening = opening;
    try {await opening.work; check(operation);}
    finally {
      if (reopening === opening) reopening = null;
      if (reopenPermit === permit) reopenPermit = null;
    }
  }
  function failed(value) {const safe = safeError(value); if (safe.code !== 'STILL_CANCELLED') {issue = safe.code; publish();} return safe;}
  function remember(items) {for (const row of items) known.set(`${row.type}:${row.id}`, {...row}); while (known.size > 10000) known.delete(known.keys().next().value);}
  function canSubmitPlayIntent(input = {}) {
    if (!status().capabilities.canSubmitPlayIntent || !input || typeof input !== 'object') return false;
    const kind = input.kind || input.type || 'songs', id = input.id ?? input.ids?.[0];
    if (!['songs', 'library-songs'].includes(kind) || typeof id !== 'string' || !ID.test(id) ||
        input.kind !== undefined && input.type !== undefined && input.kind !== input.type ||
        input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length !== 1 || input.ids[0] !== id)) return false;
    const reference = known.get(`${kind}:${id}`);
    return reference?.playable === true && (kind === 'songs' || typeof reference.catalogId === 'string' && ID.test(reference.catalogId));
  }
  function lookupMetadata(input = {}) {
    if (!input || typeof input !== 'object') return null;
    const {id, kind = 'songs'} = input;
    if (typeof id !== 'string' || !ID.test(id) || !['songs', 'library-songs'].includes(kind)) return null;
    const current = lastState?.currentTrack;
    let row = current?.id === id && current.type === kind ? current : known.get(`${kind}:${id}`);
    if (!row && kind === 'songs') {
      // A catalog alias exists only when an actually-read public catalogId
      // points to exactly one previously observed library song. Do not infer
      // mappings from i.* strings, titles or matches from another item type.
      const candidates = new Map();
      for (const candidate of [...known.values(), current]) {
        if (candidate?.type === 'library-songs' && candidate.catalogId === id) candidates.set(candidate.id, candidate);
      }
      if (candidates.size === 1) row = candidates.values().next().value;
    }
    return row ? {id, type: kind, source: 'apple', title: cleanText(row.title), artist: cleanText(row.artist), album: cleanText(row.album),
      duration: Number.isFinite(row.duration) && row.duration >= 0 ? row.duration : null} : null;
  }
  function acceptProbe(probe) {
    if (!probe || !probe.methods || !probe.state || typeof probe.state.authorized !== 'boolean') throw error('official-invalid-response');
    methods = Object.fromEntries(PUBLIC_METHODS.map(name => [name, probe.methods[name] === true]));
    authorized = probe.state.authorized; runtime = host.runtime() || runtime;
    return mapState(probe.state, typeof probe.outputMuted === 'boolean' ? probe.outputMuted : null);
  }
  function cloneState(value) {
    return {...value, currentTrack: value.currentTrack ? {...value.currentTrack} : null,
      playbackOrder: value.playbackOrder ? {...value.playbackOrder} : null};
  }
  function mapState(raw, muted = typeof raw?.outputMuted === 'boolean' ? raw.outputMuted : null) {
    if (!raw || typeof raw.authorized !== 'boolean' || typeof raw.isPlaying !== 'boolean') throw error('official-invalid-response');
    const currentTrack = item(raw.currentTrack, artworkUrlFor);
    const controlled = authorizedAudio && muted === false;
    // A revoked logical permission is not evidence of browser muting. Preserve
    // physical SDK playback and actual/unknown output mute state after failure.
    const state = muted === true && (raw.isPlaying || raw.playbackState === 3) ? 'muted' : raw.isPlaying ? 'playing' : raw.playbackState === 3 ? 'paused' : [0, 4, 5, 9].includes(raw.playbackState) ? 'stopped' : 'loading';
    const audible = raw.isPlaying ? muted === true ? false : muted === false ? true : null : false;
    return {available: raw.authorized === true || raw.isPlaying && muted !== true || !!audioSafetyFailure, source: 'apple', provider: 'officialWeb', state,
      position: Number.isFinite(raw.position) && raw.position >= 0 ? raw.position : 0,
      duration: Number.isFinite(raw.duration) && raw.duration >= 0 ? raw.duration : currentTrack?.duration || 0,
      volume: Number.isFinite(raw.volume) && raw.volume >= 0 && raw.volume <= 1 ? raw.volume : null,
      currentTrackId: currentTrack?.type === 'library-songs' && currentTrack.catalogId ? currentTrack.catalogId : currentTrack?.id || null, currentTrack,
      queuePosition: Number.isSafeInteger(raw.queuePosition) && raw.queuePosition >= 0 ? raw.queuePosition : null,
      playbackOrder: playbackOrder(raw.playbackOrderId),
      outputMuted: muted, controlled, authorizedAudio: controlled, authorizationRequired: raw.authorized !== true,
      audible, mayBeAudible: raw.isPlaying && muted !== true, audioReleaseUnverified: !!audioSafetyFailure,
      ...(audioSafetyFailure ? {errorCode: 'official-audio-cleanup-unverified', error: MESSAGES['official-audio-cleanup-unverified']} : {}),
      audio: {engine: 'Apple Music official web / WebView2', audible, exclusive: null, actualDacRate: null}, fullSongVerified: false};
  }
  async function readState(operation) {
    if (operation) check(operation);
    const sequence = ++readSequence;
    let probe;
    const includeQueue = operation?.readQueue === true;
    try {probe = await host.request('probe', includeQueue ? {includeQueue: true} : {}, 10000);}
    catch (value) {if (sequence < publishedRead) throw cancelled(); throw value;}
    if (operation) check(operation);
    if (includeQueue) {
      operation.queueReadback = queueIds(probe?.state?.queueIds);
      // Use the same fresh probe for queue identity and playback position even
      // when a newer background probe has already been published.
      if (sequence < publishedRead) return mapState(probe.state, typeof probe.outputMuted === 'boolean' ? probe.outputMuted : null);
    }
    // A late pre-cancellation read must not overwrite a newer session state.
    if (sequence < publishedRead) return lastState ? cloneState(lastState)
      : mapState(probe.state, typeof probe.outputMuted === 'boolean' ? probe.outputMuted : null);
    const value = acceptProbe(probe); publishedRead = sequence; lastState = cloneState(value);
    if (!audioSafetyFailure && issue !== 'needs-user-interaction') issue = null;
    return value;
  }
  async function refreshAuthorization(operation) {
    // Signing in happens in the already-open official window. Never make a
    // fresh user action depend on the previous probe's authorization cache.
    try {await readState(operation);}
    catch (value) {
      if (audioRisk && value?.code !== 'STILL_CANCELLED') uncertainAudio();
      throw failed(value);
    }
  }
  function mutate(method, data, operation, prepare, settle) {
    const lifecycleBarrier = cancellationTail;
    const task = writes.then(async () => {
      await lifecycleBarrier;
      await cleanupTail;
      check(operation);
      if (operation.audioAttempt !== undefined && audioSafetyFailure) throw error('official-audio-cleanup-unverified');
      if (!host.isRunning()) throw error('session-closed');
      const verify = prepare ? await prepare(operation) : null;
      if (prepare) check(operation);
      if (operation.audioAttempt !== undefined) {
        operation.session = host.captureSession?.();
        audioSession = operation.session; audioRisk = true; authorizedAudio = true;
        operation.dispatched = true;
      }
      const reply = await host.request(method, data);
      return settle ? settle(verify) : reply;
    });
    writes = task.catch(() => {}); return task;
  }
  function currentAudioAttempt(operation) {
    return !closed && operation.generation === generation && !operation.context?.signal?.aborted && operation.audioAttempt === audioAttempt;
  }
  async function cleanFailedAudio(operation) {
    if (!currentAudioAttempt(operation)) throw cancelled();
    if (!operation.dispatched) {authorizedAudio = false; return true;}
    // Capture/check the exact native session without an intervening await. A
    // delayed old failure may never dispose a newly authorized/reopened host.
    const owner = operation.session;
    if (host.captureSession && host.captureSession() !== owner) throw cancelled();
    audioSafetyFailure = {session: owner, pending: true};
    issue = 'official-audio-cleanup-unverified'; publish();
    let closing;
    try {closing = host.closeSession ? host.closeSession(owner) : host.close();}
    catch (value) {closing = Promise.reject(value);}
    const cleanup = Promise.resolve(closing).catch(() => null).then(result => {
      const confirmed = result?.browserProcessExited === true && result?.helperExited === true;
      if (confirmed) {
        acceptAudioExit(result, owner);
        if (audioSafetyFailure?.session === owner) audioSafetyFailure = null;
        if (currentAudioAttempt(operation)) {authorizedAudio = false; selectedVerified = false; lastState = null;}
      } else {
        audioSafetyFailure = {session: owner, pending: false};
        if (currentAudioAttempt(operation)) {authorizedAudio = false; selectedVerified = false;}
        issue = 'official-audio-cleanup-unverified';
      }
      return confirmed;
    });
    cleanupTail = cleanup.then(() => {});
    const confirmed = await cleanup;
    if (!currentAudioAttempt(operation)) throw cancelled();
    if (confirmed) return true;
    publish();
    // Do not infer silence if native cleanup failed. Subsequent getState reads
    // retain the SDK's isPlaying and actual outputMuted, or report unknown.
    return false;
  }
  async function waitFor(predicate, operation, code) {
    const until = Date.now() + verificationTimeout;
    do {
      check(operation); const state = await readState(operation); check(operation);
      if (predicate(state)) return state;
      if (Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } while (Date.now() <= until);
    throw error(code);
  }
  async function control(method, data, predicate, operation, prepare) {
    const reporting = beginOperation(method);
    try {
      check(operation);
      if (method === 'resume') {
        if (!status().controlsReady) throw error('official-control-unavailable');
        if (audioSafetyFailure) throw error('official-audio-cleanup-unverified');
        operation.audioAttempt = ++audioAttempt;
        pendingAudioOperation = operation;
      }
      await waitForLifecycle(operation);
      const readback = verify => {
        check(operation); recordOperation(reporting, 'readback');
        return waitFor(verify, operation, 'official-operation-failed');
      };
      let value;
      if (prepare) value = await mutate(method, data, operation, prepare, readback);
      else {await mutate(method, data, operation); value = await readback(predicate);}
      if (method === 'resume' && audioSafetyFailure) throw error('official-operation-failed');
      recordOperation(reporting, 'complete');
      publish(); return value;
    }
    catch (value) {
      recordOperation(reporting, 'failed', value);
      if (operation.generation !== generation || operation.context?.signal?.aborted || operation.audioAttempt !== undefined && operation.audioAttempt !== audioAttempt) throw cancelled();
      if (method === 'resume' && operation.audioAttempt !== undefined && !await cleanFailedAudio(operation)) {
        const failure = error('official-audio-cleanup-unverified'); recordOperation(reporting, 'failed', failure); throw failure;
      }
      throw failed(value);
    } finally {if (pendingAudioOperation === operation) {pendingAudioOperation = null; publish();}}
  }
  async function navigate(method, context) {
    if (!status().controlsReady) throw error('official-control-unavailable');
    const next = method === 'next';
    return control(method, {}, null, op(context), async operation => {
      // A newer skip must snapshot the position only after any prior physical
      // skip has settled and immediately before its own serialized dispatch.
      const album = activeAlbumIds;
      operation.readQueue = !!album;
      const before = await readState(operation);
      const restarted = state => before.position > 3 && state.position < 1.5;
      if (!album) return state => state.currentTrackId !== before.currentTrackId || (next ? state.state === 'stopped' : restarted(state));
      const ids = operation.queueReadback;
      if (!albumMatches(ids, album, before.playbackOrder?.id) || before.queuePosition === null || ids[before.queuePosition] !== before.currentTrackId) throw error('official-track-unconfirmed');
      let target = before.queuePosition + (next ? 1 : -1);
      if (before.playbackOrder?.id % 3 === 1) target = (target + ids.length) % ids.length;
      const at = (state, index) => state.queuePosition === index && state.currentTrackId === ids[index];
      return state => sameQueue(operation.queueReadback, ids) && state.playbackOrder?.id === before.playbackOrder?.id &&
        (target < 0 ? at(state, 0) && (before.position <= 3 || restarted(state)) :
          target >= ids.length ? state.state === 'stopped' || at(state, before.queuePosition) : at(state, target));
    });
  }
  const service = {
    async initialize() {built = !!(await fs.stat(hostPath).catch(() => null))?.isFile(); runtime = await runtimeDetector(); return status();},
    status, getStatus: status, lookupMetadata, canSubmitPlayIntent,
    async authorize() {
      if (closed || closingService) throw error('closed');
      if (!built || !runtime) throw error(!built ? 'official-host-missing' : 'webview2-runtime-missing');
      await cancellationTail; await cleanupTail;
      if (closed || closingService) throw error('closed');
      if (audioRisk && !host.isRunning()) uncertainAudio();
      if (audioSafetyFailure) throw error('official-audio-cleanup-unverified');
      try {await host.start({show: true}); await readState(); issue = null; return publish();}
      catch (value) {throw failed(value);}
    },
    async getState() {
      if (retiringContexts || host.isClosing?.() || reopening || host.isStarting?.() || host.isRunning() && host.isReady?.() === false) return {
        available: audioRisk, source: 'apple', provider: 'officialWeb', state: audioRisk ? 'unknown' : 'loading', pending: true, controlsReady: false,
        position: null, duration: null, volume: null, currentTrack: null, currentTrackId: null, outputMuted: null,
        audible: null, mayBeAudible: audioRisk, controlled: false, authorizedAudio: false, audioReleaseUnverified: Boolean(audioSafetyFailure)};
      if (audioRisk && !host.isRunning()) uncertainAudio();
      if (audioSafetyFailure && (closed || !host.isRunning())) return {available: true, source: 'apple', provider: 'officialWeb', state: 'unknown',
        position: 0, duration: 0, volume: null, outputMuted: null, audible: null, mayBeAudible: true, controlled: false, authorizedAudio: false,
        audioReleaseUnverified: true, errorCode: 'official-audio-cleanup-unverified', error: MESSAGES['official-audio-cleanup-unverified']};
      if (closed || !host.isRunning()) return {available: false, source: 'apple', provider: 'officialWeb', state: 'unavailable', position: 0, duration: 0, volume: null,
        errorCode: closed ? 'closed' : 'session-closed', error: closed ? MESSAGES.closed : status().message};
      try {
        const value = await readState();
        const {controlsReady, playbackOrders} = status();
        return {...value, controlsReady, playbackOrders};
      }
      catch (value) {
        if (audioRisk && value?.code !== 'STILL_CANCELLED') uncertainAudio();
        const safe = audioSafetyFailure ? error('official-audio-cleanup-unverified') : failed(value);
        return {available: !!audioSafetyFailure, source: 'apple', provider: 'officialWeb', state: audioSafetyFailure ? 'unknown' : 'unavailable',
          position: 0, duration: 0, volume: null, outputMuted: null, audible: null, mayBeAudible: !!audioSafetyFailure,
          audioReleaseUnverified: !!audioSafetyFailure, errorCode: Object.hasOwn(MESSAGES, safe.code) ? safe.code : 'official-operation-failed', error: safe.message};
      }
    },
    async search({term, types = ['songs'], limit = 25, offset = 0} = {}) {
      if (!host.isRunning()) throw error('session-closed');
      if (typeof term !== 'string' || !term.trim() || term.length > 200) throw error('invalid-input');
      if (typeof types === 'string') types = types.split(',');
      if (!Array.isArray(types) || !types.length || types.length > 4 || types.some(type => !['songs', 'albums', 'artists', 'playlists'].includes(type))) throw error('invalid-input');
      integer(limit, 1, 25); integer(offset, 0, 1000000);
      const reporting = beginOperation('search');
      try {const result = list(await host.request('search', {term: term.trim(), types: [...new Set(types)], limit, offset}), artworkUrlFor); remember(result.items); recordOperation(reporting, 'complete'); return result;}
      catch (value) {recordOperation(reporting, 'failed', value); throw failed(value);}
    },
    async library({kind = 'songs', id, limit = 50, offset = 0} = {}) {
      if (!host.isRunning()) throw error('session-closed');
      if (!['songs', 'albums', 'artists', 'playlists', 'album-songs', 'playlist-songs', 'artist-albums'].includes(kind)) throw error('invalid-input');
      if (['album-songs', 'playlist-songs', 'artist-albums'].includes(kind) && (typeof id !== 'string' || !ID.test(id))) throw error('invalid-item');
      integer(limit, 1, 100); integer(offset, 0, 1000000);
      const reporting = beginOperation('library', 'authorization-check');
      try {
        await refreshAuthorization(op()); if (!authorized) throw error('needs-auth');
        recordOperation(reporting, 'dispatch');
        const result = list(await host.request('library', {kind, ...(id ? {id} : {}), limit, offset}), artworkUrlFor, kind === 'album-songs');
        remember(result.items); recordOperation(reporting, 'complete'); return result;
      }
      catch (value) {recordOperation(reporting, 'failed', value); throw failed(value);}
    },
    async getQueue({limit = 50, offset = 0} = {}) {
      if (!host.isRunning()) throw error('session-closed'); integer(limit, 1, 200); integer(offset, 0, 1000000);
      try {return list(await host.request('queue', {limit, offset}), artworkUrlFor, true);} catch (value) {throw failed(value);}
    },
    queue() {return Promise.reject(error('official-control-unavailable'));},
    async play(input = {}, context) {
      const operation = op(context), kind = input.kind || input.type || 'songs';
      const id = input.id ?? input.ids?.[0];
      if (typeof id !== 'string' || !ID.test(id) || input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length !== 1 || input.ids[0] !== id)) throw error('invalid-item');
      let album;
      if (input.album !== undefined) {
        if (!input.album || typeof input.album !== 'object' || Array.isArray(input.album) ||
          typeof input.album.id !== 'string' || !ID.test(input.album.id) || input.album.id === '.' || input.album.id === '..') throw error('invalid-item');
        album = {id: input.album.id, index: integer(input.album.index, 0, ALBUM_TRACK_LIMIT - 1)};
      }
      const reporting = beginOperation('play', 'authorization-check', {kind, id});
      const reference = known.get(`${kind}:${id}`), catalogId = kind === 'songs' ? id : kind === 'library-songs' && reference?.playable ? reference.catalogId : null;
      if (!catalogId || reference?.playable === false) {const failure = error('unsupported-item'); recordOperation(reporting, 'failed', failure); throw failure;}
      check(operation); operation.audioAttempt = ++audioAttempt;
      pendingAudioOperation = operation;
      try {
        await waitForLifecycle(operation, true); await refreshAuthorization(operation);
        if (!authorized) throw error('needs-auth');
        check(operation);
        if (album && methods.albumPlayback !== true) throw error('official-control-unavailable');
      } catch (value) {recordOperation(reporting, 'failed', value); if (pendingAudioOperation === operation) pendingAudioOperation = null; throw value;}
      try {
        check(operation);
        selectedVerified = false; activeAlbumIds = null;
        recordOperation(reporting, 'dispatch');
        const started = await mutate('play', {id: catalogId, kind: 'songs', ...(album ? {album} : {})}, operation); check(operation);
        let originalIds, expectedIds, expectedPosition;
        if (album) {
          originalIds = queueIds(started?.albumIds); expectedIds = queueIds(started?.queueIds); expectedPosition = started?.queuePosition;
          const shuffled = playbackOrder(started?.playbackOrderId)?.id >= 3;
          if (originalIds?.[album.index] !== catalogId || !Number.isSafeInteger(expectedPosition) || expectedPosition < 0 ||
            expectedIds?.[expectedPosition] !== catalogId || (shuffled ? !sameTracks(expectedIds, originalIds) || originalIds.indexOf(catalogId) !== originalIds.lastIndexOf(catalogId) :
              expectedPosition !== album.index || !sameQueue(expectedIds, originalIds))) throw error('official-track-unconfirmed');
          operation.readQueue = true;
        }
        recordOperation(reporting, 'readback');
        let firstPlayingPosition = null;
        const state = await waitFor(value => {
          if (value.state !== 'playing' || value.currentTrackId !== catalogId || value.outputMuted || album &&
            (value.outputMuted !== false || value.queuePosition !== expectedPosition || !sameQueue(operation.queueReadback, expectedIds) ||
              (value.playbackOrder?.id ?? null) !== (started.playbackOrderId ?? null) ||
              !['songs', 'library-songs'].includes(value.currentTrack?.type))) {
            if (album) firstPlayingPosition = null;
            return false;
          }
          if (firstPlayingPosition === null) {firstPlayingPosition = value.position; return false;}
          return value.position > firstPlayingPosition + 0.05;
        }, operation, 'official-track-unconfirmed');
        if (audioSafetyFailure) throw error('official-track-unconfirmed');
        activeAlbumIds = originalIds || null;
        selectedVerified = true; issue = null; recordOperation(reporting, 'complete'); publish(); return state;
      } catch (value) {
        recordOperation(reporting, 'failed', value);
        if (!currentAudioAttempt(operation)) throw cancelled();
        if (!await cleanFailedAudio(operation)) {
          const failure = error('official-audio-cleanup-unverified'); recordOperation(reporting, 'failed', failure); throw failure;
        }
        throw failed(value);
      } finally {if (pendingAudioOperation === operation) {pendingAudioOperation = null; publish();}}
    },
    pause: context => control('pause', {}, state => !['playing', 'loading'].includes(state.state), op(context)),
    resume: context => control('resume', {}, state => state.state === 'playing' && !state.outputMuted, op(context)),
    seek(position, context) {numeric(position, 0, 86400); if (!status().controlsReady) return Promise.reject(error('official-control-unavailable')); return control('seek', {position}, state => Math.abs(state.position - position) <= 1.5, op(context));},
    setVolume(volume, context) {numeric(volume, 0, 1); return control('volume', {volume}, state => state.volume !== null && Math.abs(state.volume - volume) <= 0.011, op(context));},
    async setOrder(id, context) {
      if (!playbackOrder(id)) throw error('invalid-input');
      if (!status().capabilities.order) throw error('official-control-unavailable');
      return control('order', {order: id}, null, op(context), async operation => {
        const album = activeAlbumIds;
        operation.readQueue = true;
        const before = await readState(operation);
        const ids = operation.queueReadback;
        if (album && !sameTracks(ids, album)) throw error('official-track-unconfirmed');
        const changesShuffle = (before.playbackOrder?.id >= 3) !== (id >= 3);
        return state => state.playbackOrder?.id === id &&
          (album ? albumMatches(operation.queueReadback, album, id) : !ids || sameTracks(operation.queueReadback, ids)) &&
          (!before.currentTrackId || state.currentTrackId === before.currentTrackId && (before.queuePosition === null ||
            (changesShuffle ? operation.queueReadback?.[state.queuePosition] === before.currentTrackId : state.queuePosition === before.queuePosition)));
      });
    },
    next: context => navigate('next', context),
    previous: context => navigate('previous', context),
    async stop(context) {
      const barrier = service.cancelPending(), operation = op(context); await barrier; check(operation);
      authorizedAudio = false;
      if (!host.isRunning()) {
        if (audioRisk || audioSafetyFailure) {uncertainAudio(); throw error('official-audio-cleanup-unverified');}
        return {available: true, source: 'apple', provider: 'officialWeb', state: 'stopped', position: 0, duration: 0, volume: null};
      }
      return control('stop', {}, state => !['playing', 'loading'].includes(state.state) && state.outputMuted, operation);
    },
    cancelPending(hint = {}) {
      generation++; publishedRead = ++readSequence;
      const owner = audioSession;
      const explicitSameSourcePlay = hint.intent === 'play' && hint.source === 'apple' && !closed && !closingService;
      const unsettled = host.hasUnsettledStart?.() === true;
      const preservePlaybackPermission = hint.intent === 'command' && hint.source === 'apple' && ['setVolume', 'seek', 'next', 'previous', 'setOrder'].includes(hint.method) &&
        !unsettled && !host.isClosing?.() && authorizedAudio;
      const retiring = unsettled || host.isClosing?.() || host.isStarting?.() && !explicitSameSourcePlay;
      const session = host.captureSession?.();
      if (explicitSameSourcePlay) {
        if (unsettled && session && session === owner) reopenPermit = {session, generation, confirmed: false, consumed: false};
        else if (reopenPermit) reopenPermit.generation = generation;
        else if (reopening) {reopenPermit = reopening.permit; reopenPermit.generation = generation;}
      } else reopenPermit = null;
      const permit = reopenPermit;
      if (retiring) retiringContexts++;
      const barrier = Promise.resolve(host.cancelPending({preserveStarting: explicitSameSourcePlay, preservePlaybackPermission})).then(result => {
        const accepted = acceptAudioExit(result, owner);
        if (permit && permit.session === session && result?.browserProcessExited === true && result?.helperExited === true) permit.confirmed = true;
        if (retiring && !accepted && audioRisk && audioSession === owner) uncertainAudio();
        return result;
      }, failure => {if (retiring && audioRisk && audioSession === owner) uncertainAudio(); throw failure;})
        .finally(() => {if (retiring) retiringContexts--;});
      cancellationTail = Promise.allSettled([cancellationTail, writes, barrier, cleanupTail]);
      return cancellationTail;
    },
    async releaseOutput() {
      const barrier = service.cancelPending(), operation = op(); await barrier;
      try {
        check(operation); authorizedAudio = false; const owner = audioSession, closedHost = await host.close(); check(operation);
        if (acceptAudioExit(closedHost, owner)) return {released: true, evidence: {provider: 'officialWeb', ownedBrowserProcessExited: true, ownedHelperExited: true, actualDacRate: null}};
        if (audioRisk || audioSafetyFailure) {uncertainAudio(); publish(); return {released: false, evidence: {provider: 'officialWeb', reason: 'official-audio-cleanup-unverified'}};}
        if (typeof verifyOutputReleased === 'function') {const independent = await verifyOutputReleased({provider: 'officialWeb'}); check(operation); return {released: independent?.released === true, evidence: {provider: 'officialWeb', independent: independent?.evidence || null, actualDacRate: null}};}
        return {released: false, evidence: {provider: 'officialWeb', reason: 'owned-browser-exit-unverified'}};
      } catch (value) {
        if (audioRisk || audioSafetyFailure) {uncertainAudio(); publish();}
        return {released: false, evidence: {provider: 'officialWeb', reason: audioSafetyFailure ? 'official-audio-cleanup-unverified' : safeError(value).code}};
      }
    },
    close() {
      if (closed) return Promise.resolve();
      if (closeWork) return closeWork;
      closingService = true;
      closeWork = Promise.resolve().then(async () => {
        try {
          await service.cancelPending();
          const owner = audioSession, result = await host.close();
          if (!acceptAudioExit(result, owner) && (audioRisk || audioSafetyFailure)) {
            uncertainAudio(); publish(); throw error('official-audio-cleanup-unverified');
          }
          closed = true; known.clear(); lastState = null;
        } catch (value) {
          if (audioRisk || audioSafetyFailure) {uncertainAudio(); publish(); throw error('official-audio-cleanup-unverified');}
          throw value;
        } finally {closingService = false; closeWork = null;}
      });
      return closeWork;
    }
  };
  return service;
}

module.exports = {createOfficialAppleMusicService, createNativeOfficialHost, detectRuntime, MESSAGES};
