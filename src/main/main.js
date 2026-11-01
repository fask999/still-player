'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {pathToFileURL} = require('node:url');
const {randomUUID} = require('node:crypto');
const {createSettingsService} = require('./settings');
const {createPlaybackCoordinator} = require('./playback-coordinator');
const {createFoobarSessionService} = require('./foobar-session');
const {readAppleDiagnosticSnapshot, createDiagnosticSnapshotReader} = require('./apple-diagnostics');
const {createPlaybackContextService} = require('./playback-context');
const {createPlayerSpectrumService, emptySpectrum} = require('./player-spectrum');
// Native start/session/failure cleanup passed independent code review. Enable
// only actual official-session capabilities; account/full-song playback remains
// unverified and Apple queue is still disabled below.
const APPLE_PLAYBACK_MAINTENANCE = false;
const QQ_PUBLIC_REFERER = 'https://y.qq.com/';
const QQ_PUBLIC_USER_AGENT = 'STILL/1.0 (desktop music player; read-only public lyrics client)';

const APPLE_SOURCE = Object.freeze({id: 'apple', name: 'Apple Music', provider: 'official-web', status: 'unavailable', available: false,
  message: 'Apple Music 官方网页尚未连接。此入口使用官网自己的登录与播放流程；当前尚未验证登录后的曲库和全曲播放。',
  reasonCodes: Object.freeze(['official-web-host-unavailable', 'protected-playback-unverified']),
  capabilities: Object.freeze({library: false, playback: false, authorize: false})});

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Command payload must be an object');
  return value;
}
function string(value, label = 'ID') {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error(`Invalid ${label}`);
  return value;
}
function ids(value) {
  if (!Array.isArray(value) || value.length > 50000) throw new Error('Track IDs must be an array');
  return value.map(id => string(id));
}
function numeric(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
function validateDiagnosticLayout(value) {
  const input = record(value), names = ['width', 'height', 'devicePixelRatio', 'horizontalOverflow',
    'appReducedMotion', 'systemReducedMotion', 'effectiveReducedMotion', 'accentColor'];
  if (Object.keys(input).some(key => !names.includes(key))) throw new Error('诊断布局不接受额外字段。');
  const ownValue = key => Object.getOwnPropertyDescriptor(input, key)?.value;
  const result = Object.fromEntries(names.map(key => [key, ownValue(key)]));
  if (!['width', 'height'].every(key => Number.isInteger(result[key]) && result[key] >= 1 && result[key] <= 32768) ||
      typeof result.devicePixelRatio !== 'number' || !Number.isFinite(result.devicePixelRatio) || result.devicePixelRatio < 0.25 || result.devicePixelRatio > 16 ||
      !['horizontalOverflow', 'appReducedMotion', 'systemReducedMotion', 'effectiveReducedMotion'].every(key => typeof result[key] === 'boolean') ||
      typeof result.accentColor !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(result.accentColor) ||
      result.effectiveReducedMotion !== (result.appReducedMotion || result.systemReducedMotion)) throw new Error('诊断布局字段无效。');
  result.accentColor = result.accentColor.toUpperCase();
  return result;
}
function registerApplicationSchemes(protocol) {
  protocol.registerSchemesAsPrivileged(['still-cover', 'still-apple-art'].map(scheme => ({scheme,
    privileges: {standard: true, secure: true, supportFetchAPI: true}})));
}
function isTrustedApplicationSender(event, mainWindow, expectedUrl) {
  const contents = mainWindow?.webContents;
  return Boolean(contents && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === expectedUrl);
}
function isApprovedPublicRequest(input) {
  if (typeof input !== 'string' || input.length > 8192 || /[\\\u0000-\u0020\u007f]/.test(input)) return false;
  let url;
  try {url = new URL(input);} catch {return false;}
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
  const queryKeys = allowed => [...url.searchParams.keys()].every(key => allowed.includes(key));
  if (url.hostname === 'c.y.qq.com') {
    const search = url.pathname === '/soso/fcgi-bin/client_search_cp', lyric = url.pathname === '/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
    if (!search && !lyric) return false;
    const fixed = search ? {format: 'json', n: '10', p: '0', cr: '1', g_tk: '5381'} :
      {g_tk: '5381', loginUin: '0', hostUin: '0', inCharset: 'utf8', outCharset: 'utf-8', notice: '0', platform: 'yqq', needNewCode: '1', format: 'json'};
    if (!queryKeys([...Object.keys(fixed), ...(search ? ['w'] : ['songmid', 'pcachetime'])]) ||
        new Set(url.searchParams.keys()).size !== [...url.searchParams].length ||
        !Object.entries(fixed).every(([key, value]) => url.searchParams.get(key) === value)) return false;
    return search ? !!url.searchParams.get('w')?.trim() && url.searchParams.get('w').length <= 1024 :
      /^[A-Za-z0-9]{5,40}$/.test(url.searchParams.get('songmid') || '') && /^[0-9]{1,16}$/.test(url.searchParams.get('pcachetime') || '');
  }
  if (url.hostname === 'lrclib.net') return /^\/api\/(?:search|get(?:\/[1-9][0-9]{0,15})?)$/.test(url.pathname) &&
    queryKeys(['q', 'track_name', 'artist_name', 'album_name', 'duration']);
  if (url.hostname === 'musicbrainz.org') return url.pathname === '/ws/2/release/' &&
    queryKeys(['query', 'fmt', 'limit']) && url.searchParams.get('fmt') === 'json';
  if (url.search) return false;
  if (/^is[1-5]-ssl\.mzstatic\.com$/.test(url.hostname)) return /^\/image\/thumb\/(?:[A-Za-z0-9._~-]+\/)+512x512(?:bb)?\.(?:jpe?g|png)$/.test(url.pathname);
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
  if (url.hostname === 'coverartarchive.org') return new RegExp(`^/release/${uuid}/front-500$`).test(url.pathname);
  const prefix = url.hostname === 'archive.org' ? '/download' : /^ia[0-9]{6,12}\.(?:us|eu)\.archive\.org$/.test(url.hostname) ? '/[0-9]{1,2}/items' : null;
  return prefix !== null && new RegExp(`^${prefix}/mbid-(${uuid})/mbid-\\1-[1-9][0-9]{0,19}(?:_thumb500|-500)\\.jpg$`).test(url.pathname);
}
function createPublicFetchService({session}) {
  // A fresh, non-persistent partition uses Chromium's system-proxy network
  // stack without sharing the renderer or official Apple account session.
  const publicSession = session.fromPartition(`still-public-${randomUUID()}`, {cache: false});
  let closed = false, closing;
  const failure = code => Object.assign(new Error({PUBLIC_FETCH_CLOSED: '公共网络服务已关闭。',
    PUBLIC_FETCH_FORBIDDEN: '公共网络请求不在允许范围内。'}[code]), {code});
  return {
    async fetch(input, options = {}) {
      if (closed) throw failure('PUBLIC_FETCH_CLOSED');
      if (!isApprovedPublicRequest(input) || (options.method && String(options.method).toUpperCase() !== 'GET') || options.body != null) throw failure('PUBLIC_FETCH_FORBIDDEN');
      let headers;
      try {
        const offered = new Headers(options.headers);
        headers = Object.fromEntries(['accept', 'user-agent'].filter(name => offered.has(name)).map(name => [name, offered.get(name)]));
      } catch {throw failure('PUBLIC_FETCH_FORBIDDEN');}
      const qq = new URL(input).hostname === 'c.y.qq.com';
      if (qq) headers = {accept: 'application/json', 'user-agent': QQ_PUBLIC_USER_AGENT, referer: QQ_PUBLIC_REFERER};
      const response = await publicSession.fetch(input, {method: 'GET', headers, signal: options.signal,
        credentials: 'omit', redirect: 'manual', referrerPolicy: qq ? 'strict-origin' : 'no-referrer',
        referrer: qq ? QQ_PUBLIC_REFERER : '', cache: 'no-store'});
      if (closed) {
        try {await response?.body?.cancel();} catch {}
        throw failure('PUBLIC_FETCH_CLOSED');
      }
      // Keep the original streaming response. Per-service status validation,
      // byte limits, bounded redirects and AbortSignals remain authoritative.
      return response;
    },
    close() {
      closed = true;
      if (!closing) closing = Promise.resolve().then(() => publicSession.closeAllConnections());
      return closing;
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
function createLyricsTrackResolver({library, apple}) {
  const own = (value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    try {return Object.getOwnPropertyDescriptor(value, key)?.value;} catch {return undefined;}
  };
  const publicText = value => typeof value === 'string' ? value.slice(0, 500).replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
  return async trackId => {
    if (typeof trackId !== 'string') return null;
    if (!trackId.startsWith('apple:')) return library.getTrack(trackId);
    const key = /^apple:(songs|library-songs):([A-Za-z0-9._-]{1,200})$/.exec(trackId);
    const lookup = own(apple, 'lookupMetadata');
    if (!key || typeof lookup !== 'function') return null;
    const metadata = lookup.call(apple, {id: key[2], kind: key[1]});
    if (own(metadata, 'id') !== key[2] || own(metadata, 'type') !== key[1] || own(metadata, 'source') !== 'apple') return null;
    const title = publicText(own(metadata, 'title'));
    if (!title) return null;
    const value = own(metadata, 'duration');
    return {id: trackId, type: key[1], source: 'apple', subsong: 0, title,
      artist: publicText(own(metadata, 'artist')), album: publicText(own(metadata, 'album')),
      duration: typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null};
  };
}
function canonical(file) { return path.resolve(file).replaceAll('\\', '/').toLowerCase(); }
async function resolveFoobarDir(startDirectory, override) {
  if (override) return path.resolve(override);
  return path.join(path.resolve(startDirectory), 'backend', 'foobar2000');
}
async function initializeBackend(backend, options) {
  try {return await backend.initialize(backend.getInfo?.().pendingHandoff ? {...options, start: false} : options);}
  catch (error) {return {...backend.getInfo(), available: false, error: error.message};}
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
  // Cancellation is synchronous. Never await a possibly blocked HTTP fence
  // before giving the independently verified owned process its graceful exit.
  const {settled: coordinatorDone} = coordinator.beginShutdown();
  const owned = backend.getInfo().owned === true;
  if (!smokeMode && owned) await settleWithin(Promise.resolve().then(() => foobar.stop()), stopGraceMs);
  const result = await backend.close();
  if (result?.exitEvidence && bridgeSessionBound) foobar.markBackendExited(result.exitEvidence);
  else if (owned && bridgeSessionBound) throw new Error('专属后端未提供经核验的退出证据；未宣称关闭成功。');
  const drains = Promise.all([coordinatorDone, foobar.close(), ...closeServices.map(close => close()), Promise.resolve(syncPromise)]);
  const outcome = await settleWithin(drains, drainTimeoutMs);
  if (!outcome.settled) throw new Error('专属进程退出后，仍未确认所有控制与数据保存结束。窗口保留，可查看诊断后再次退出。');
  if (outcome.error) throw outcome.error;
  return result;
}
function createAppleAdapter(apple) {
  const methods = ['getState', 'play', 'cancelPending', 'pause', 'stop', 'seek', 'setVolume', 'releaseOutput', 'next', 'previous'];
  const adapter = Object.fromEntries(methods.filter(name => typeof apple[name] === 'function').map(name => [name, apple[name].bind(apple)]));
  adapter.toggle = async context => {
    const state = await apple.getState(); context.check();
    return state.state === 'playing' ? apple.pause() : apple.resume();
  };
  return adapter;
}
function unavailableAppleService(message = APPLE_SOURCE.message) {
  const status = {...structuredClone(APPLE_SOURCE), message};
  const unavailable = () => Promise.reject(new Error(message));
  return {initialize: async () => status, getStatus: () => structuredClone(status), status: () => structuredClone(status),
    getState: async () => ({available: false, state: 'unavailable', position: 0, duration: 0, volume: null, error: message}),
    cancelPending: () => Promise.resolve(), play: unavailable, pause: unavailable, resume: unavailable,
    stop: unavailable, releaseOutput: unavailable, close: async () => {}};
}
function withSmokeLyricsFixture(handlers, {enabled, smokeMode, track} = {}) {
  if (!enabled) return handlers;
  if (!smokeMode) throw new Error('The lyric UI fixture is allowed only in read-only desktop smoke');
  if (!track?.id) throw new Error('The lyric UI fixture requires a real existing library track');
  const fixtureLabel = '测试歌词 / 非真实匹配';
  let revision = 0;
  const player = () => ({available: true, state: 'paused', source: 'local', lastSource: 'local',
    position: 17.8, duration: Math.max(track.duration || 0, 40), volume: null, currentTrackId: track.id,
    currentTrack: {...track}, generation: 0, revision: ++revision, simulatedUIFixture: true, fixtureLabel});
  const original = [
    ['这是一段测试歌词', 'These are words composed for this layout test.'],
    ['窗外的风慢慢经过', 'The wind passes slowly beyond the window.'],
    ['让每一行有自己的呼吸', 'Let every line have room to breathe.'],
    ['此刻只校验文字与时间', 'This moment checks words and timing only.'],
    ['原文与译文一起停留', 'Original words and translation remain together.'],
    ['没有真实音频正在播放', 'No real audio is playing in this test.'],
    ['灯光在安静的页面流动', 'Light moves across the quiet page.'],
    ['所有测试内容清楚标记', 'Every test item is explicitly marked.']
  ];
  const document = {trackId: track.id, status: 'ready', kind: 'word', source: 'smoke-fixture',
    title: track.title, artist: track.artist, offsetMs: 0, fromCache: false, local: false, bound: false,
    simulatedUIFixture: true, fixtureLabel, lines: original.map(([text, translation], index) => {
      const startMs = index * 5000, endMs = startMs + 4500, characters = Array.from(text);
      return {startMs, endMs, text, translation, words: characters.map((text, word) => ({text,
        startMs: startMs + Math.floor(word * 4500 / characters.length), endMs: startMs + Math.floor((word + 1) * 4500 / characters.length)}))};
    })};
  return {...handlers,
    'app:bootstrap': async p => ({...await handlers['app:bootstrap'](p), player: player(), simulatedUIFixture: true, fixtureLabel}),
    'player:state': async () => player(),
    'lyrics:resolve': async p => {if (p.trackId !== track.id) throw new Error('测试歌词仅适用于当前测试曲目。'); return structuredClone(document);},
    'lyrics:search': async () => ({results: [], source: 'smoke-fixture', status: 'not-found', simulatedUIFixture: true, fixtureLabel})};
}
function identity(track) { return `${canonical(track.path)}|${Number.isInteger(track.subsong) && track.subsong >= 0 ? track.subsong : 'unknown'}`; }
function mapPlayer(state, tracks, decorateTrack) {
  if (state.source === 'apple' || (!state.source && state.lastSource === 'apple')) return {...state};
  const byPath = new Map(tracks.map(track => [identity(track), track]));
  const current = state.currentTrack;
  const currentPath = current?.path || state.path;
  const match = currentPath ? byPath.get(identity({...current, path: currentPath, subsong: current?.subsong ?? state.subsong})) : tracks.find(track => track.id === state.currentTrackId);
  const result = {...state, ...(match ? {currentTrackId: match.id, currentTrack: {...current, ...match}} : {})};
  // Artwork may arrive between otherwise identical real player readbacks.
  // Enrich only the current identity, leaving transport timing/revisions intact.
  const currentId = result.currentTrackId || result.currentTrack?.id;
  const latest = currentId && tracks.find(track => track.id === currentId);
  if (result.currentTrack && !result.currentTrack.coverUrl && latest?.coverUrl) {
    result.currentTrack = {...result.currentTrack, coverUrl: latest.coverUrl,
      ...(latest.coverMetadataStatus ? {coverMetadataStatus: latest.coverMetadataStatus} : {}),
      ...(latest.coverMetadataSource ? {coverMetadataSource: latest.coverMetadataSource} : {})};
  }
  if (result.currentTrack && typeof decorateTrack === 'function') result.currentTrack = decorateTrack(result.currentTrack);
  return result;
}
function mapQueue(queue, tracks) {
  const byPath = new Map(tracks.map(track => [identity(track), track]));
  return {...queue, items: (queue.items || []).map((item, index) => {
    const track = item.path ? byPath.get(identity(item)) : null;
    return {...item, index: item.index ?? index, ...(track ? {trackId: track.id, title: track.title, artist: track.artist} : {})};
  })};
}
async function safeCoverPath(urlText, coverDir) {
  const url = new URL(urlText);
  if (url.protocol !== 'still-cover:' || url.hostname !== 'art' || url.username || url.password || url.port || url.search || url.hash) throw new Error('Invalid cover URL');
  const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
  if (!relative || relative.includes('\\') || relative.split('/').includes('..') || path.isAbsolute(relative)) throw new Error('Invalid cover path');
  const base = await fs.realpath(coverDir);
  const file = await fs.realpath(path.join(base, relative));
  const resolved = path.relative(base, file);
  if (resolved.startsWith('..') || path.isAbsolute(resolved) || !/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(file)) throw new Error('Cover access denied');
  if (!(await fs.stat(file)).isFile()) throw new Error('Cover is not a file');
  return file;
}
function windowSize(workArea) {
  const width = Math.max(1, Math.floor(workArea.width));
  const height = Math.max(1, Math.floor(workArea.height));
  // Permit a real narrow/portrait window on a secondary display. Native Windows
  // frame/DPI handling stays enabled; renderer breakpoints use its client size.
  return {width: Math.min(1440, width), height: Math.min(940, height), minWidth: Math.min(480, width), minHeight: Math.min(680, height)};
}
function playbackLocation(track) {
  // Legacy regular files may omit subsong. An explicitly unresolved identifier must never become zero.
  const subsong = track.subsong === undefined ? 0 : track.subsong;
  if (!Number.isSafeInteger(subsong) || subsong < 0) throw new Error(`Exact subsong is unavailable: ${track.title || track.path}`);
  return {path: track.path, subsong};
}
function createHandlers({library, foobar, apple, lyrics, settings, dialog, shell, dataDir, emit = () => {}, window, version, getRestoreInfo, getLibrarySnapshot, coordinator, getBackendInfo, retryBackend, prepareLibraryPaths, prepareLocalPlayback, persistUIState = true,
  exportDiagnostics, observeDiagnosticPlayer, observeDiagnosticSources, observeAppleRead, getLyricsTrack, decorateLibrarySnapshot = value => value, decorateTrack, readSpectrum, spectrumSupported = false}) {
  const playback = coordinator || createPlaybackCoordinator({engines: {local: foobar || {}, ...(apple ? {apple: createAppleAdapter(apple)} : {})}});
  let selectedSource = 'local';
  const snapshot = async () => decorateLibrarySnapshot(await (getLibrarySnapshot ? getLibrarySnapshot() : library.list()));
  const tracks = async () => (await snapshot()).tracks;
  const playbackContext = createPlaybackContextService({local: foobar, apple, getTracks: tracks, decorateTrack,
    getGeneration: () => playback.currentGeneration?.(), getRevision: () => playback.currentRevision?.()});
  const appleStatus = () => {
    const status = structuredClone(apple ? (apple.getStatus?.() ?? apple.status()) : APPLE_SOURCE);
    const capabilities = {...status.capabilities, queue: false, queueActions: []};
    if (APPLE_PLAYBACK_MAINTENANCE) Object.assign(capabilities, {playback: false, canSubmitPlayIntent: false, playIntentTypes: [], toggle: false, previous: false, next: false, seek: false, volume: false, playableTypes: []});
    return {...status, id: 'apple', name: 'Apple Music', capabilities,
      ...(APPLE_PLAYBACK_MAINTENANCE && status.capabilities?.playback ? {available: false,
        message: '官方会话可浏览；本次构建的自定义播放控制暂在维护，尚未启用。',
        reasonCodes: [...(status.reasonCodes || []), 'playback-control-maintenance']} : {})};
  };
  function requireApple(capability) {
    const status = appleStatus();
    if (!apple || !status.capabilities?.[capability]) throw new Error(status.message || 'Apple Music 后端尚未连接或未授权此能力。');
    return apple;
  }
  const player = async () => {
    let state;
    try { state = await playback.getState(); }
    catch (error) { state = {available: false, state: 'unavailable', source: null, position: 0, duration: 0, volume: null,
      generation: playback.currentGeneration(), revision: playback.currentRevision(), error: error.message}; }
    const mapped = mapPlayer(state, await tracks(), decorateTrack);
    observeDiagnosticPlayer?.(mapped);
    return mapped;
  };
  const sourceStatus = async () => {
    const backend = getBackendInfo?.() || {};
    const standby = backend.status === 'standby' && backend.pendingHandoff === true;
    const canStartOnDemand = standby && backend.canStartOnDemand === true;
    const local = standby ? {available: false, backendReachable: false} : await playback.getEngineState('local');
    const reachable = !standby && (local.backendReachable ?? local.available === true);
    const output = local.outputConnection || null;
    const outputUnavailable = output && (!output.output || (output.endpointId && output.status !== 'connected'));
    const outputUnknown = output?.status === 'unknown';
    const outputChanged = output?.selectionMatches === false;
    const retryRequired = output?.retryRequired === true;
    const localStatus = standby ? 'standby' : !reachable ? 'offline' : local.controlUncertain ? 'control-unconfirmed' : outputChanged ? 'output-changed' :
      outputUnavailable ? (output.status === 'disconnected' ? 'device-disconnected' : 'device-unknown') : outputUnknown ? 'device-unknown' :
      retryRequired ? 'device-reconnected' : 'ready';
    const localMessage = standby ? (canStartOnDemand ? '本地内核正在安全待命；明确选择本地曲目播放时会重新连接。' : '本地资源交接仍待核验，播放内核不会自动重启。') : !reachable ? (['starting', 'restarting', 'checking'].includes(backend.status) ? '专属本地内核正在启动或检查。' :
      '专属本地内核未连接；可查看诊断并重试，已保存的音乐库仍可浏览。') : local.controlUncertain ?
      '旧播放控制尚未证实结束。请重连专属内核；重连不会自动开始播放。' : outputChanged ?
      '播放器当前输出与已确认设备不一致。请在音频设置中明确选择设备；未自动切换输出。' : outputUnavailable || outputUnknown ? output.message : retryRequired ?
      '原音频设备已重新连接。请明确重试或选择播放；不会自动恢复。' : '由内置 foobar2000 播放本地音乐。';
    const value = {selectedSource, sources: {
      local: {id: 'local', name: '本地音乐', status: localStatus, available: reachable,
        backendReachable: reachable, connected: reachable, outputConnection: output, controlUncertain: local.controlUncertain === true,
        backendStatus: standby ? 'standby' : reachable ? 'ready' : ['starting', 'restarting', 'checking'].includes(backend.status) ? 'starting' : 'offline',
        backendDiagnostic: backend.error || local.error || null, message: localMessage,
        capabilities: {library: true, playback: reachable && !local.controlUncertain && !outputUnavailable && !outputChanged,
          nativeImport: true, canStartOnDemand, retryBackend: !standby && typeof retryBackend === 'function'}},
      apple: appleStatus()
    }};
    observeDiagnosticSources?.(value);
    return value;
  };
  function checkedLocation(track, id) {
    if (!track) throw new Error(`Track not found: ${id}`);
    if (track.supported === false) throw new Error(track.playbackUnsupportedReason || `This audio format is unsupported: ${track.title || track.path}`);
    if (track.valid === false) throw new Error(`Audio file is unavailable: ${track.title || track.path}`);
    return playbackLocation(track);
  }
  async function locations(trackIds) {
    const requested = ids(trackIds);
    const result = [];
    for (const id of requested) {
      const track = await library.getTrack(id);
      result.push(checkedLocation(track, id));
    }
    return result;
  }
  const mutateLibrary = fn => async payload => { const value = decorateLibrarySnapshot(await fn(payload)); emit('library', value); return value; };
  const mutatePlayer = fn => async payload => {
    playbackContext.invalidate();
    const result = await fn(payload);
    const value = await player();
    if (Number.isInteger(result?.skippedCount)) value.skippedCount = result.skippedCount;
    emit('player', value); return value;
  };
  const h = {
    'app:bootstrap': async () => {
      const sources = await sourceStatus();
      return {library: await snapshot(), player: await player(), settings: settings.get(), ...sources,
        capabilities: {engine: 'foobar2000', transport: 'Beefweb', nativeDialogs: true, ...(typeof foobar.capabilities === 'function' ? await foobar.capabilities() : {}),
          persistUIState, exportDiagnostics: persistUIState && typeof exportDiagnostics === 'function', externalLyrics: true, spectrum: spectrumSupported === true}, version};
    },
    'source:status': sourceStatus,
    'source:select': async p => {
      if (!['local', 'apple'].includes(p.source)) throw new Error('Invalid browsing source');
      selectedSource = p.source;
      const value = await sourceStatus(); emit('source', value); return value;
    },
    'apple:status': appleStatus,
    'apple:authorize': async () => {await requireApple('authorize').authorize(); const value = await sourceStatus(); emit('source', value); return {status: value.sources.apple};},
    'apple:pair': async () => h['apple:authorize'](),
    'apple:library': p => {
      const service = requireApple('library');
      const input = {};
      if (p.kind != null) input.kind = string(p.kind, 'Apple library kind');
      if (p.id != null) {
        const id = string(p.id, 'Apple item ID');
        if (!/^[a-zA-Z0-9._-]{1,200}$/.test(id)) throw new Error('Invalid Apple item ID');
        input.id = id;
      }
      if (p.limit != null) {input.limit = numeric(p.limit, 1, 100, 'Apple library limit'); if (!Number.isInteger(input.limit)) throw new Error('Apple library limit must be an integer');}
      if (p.offset != null) {input.offset = numeric(p.offset, 0, 100000, 'Apple library offset'); if (!Number.isInteger(input.offset)) throw new Error('Apple library offset must be an integer');}
      return Promise.resolve(service.library(input)).then(result => {observeAppleRead?.({operation: 'library', input, result}); return result;});
    },
    'apple:search': p => {
      const service = requireApple('search');
      const input = {term: string(p.term, 'Apple search term')};
      if (p.types != null) input.types = ids(p.types);
      if (p.limit != null) input.limit = numeric(p.limit, 1, 100, 'Apple search limit');
      if (p.offset != null) input.offset = numeric(p.offset, 0, 100000, 'Apple search offset');
      return Promise.resolve(service.search(input)).then(result => {observeAppleRead?.({operation: 'search', input, result}); return result;});
    },
    'app:exportDiagnostics': async p => {
      if (!exportDiagnostics || !persistUIState) throw new Error('此运行模式不提供诊断保存。');
      const input = record(p ?? {});
      if (Reflect.ownKeys(input).some(key => key !== 'layout' && key !== 'scope')) throw new Error('诊断保存不接受路径或额外参数。');
      const scope = Object.getOwnPropertyDescriptor(input, 'scope');
      if (scope && scope.value !== 'apple') throw new Error('诊断保存范围无效。');
      const layout = Object.hasOwn(input, 'layout') ? validateDiagnosticLayout(Object.getOwnPropertyDescriptor(input, 'layout')?.value) : undefined;
      return exportDiagnostics({...(scope ? {scope: 'apple'} : {}), ...(layout ? {layout} : {})});
    },
    'backend:retry': async () => {
      if (!retryBackend) throw new Error('此运行模式不提供后端启动。');
      playbackContext.invalidate();
      const result = await retryBackend();
      const value = await sourceStatus(); emit('source', value);
      if (!result.available && result.error) throw new Error(result.error);
      return value;
    },
    'library:list': snapshot,
    'library:import': mutateLibrary(async p => {
      if (!['files', 'folder'].includes(p.kind)) throw new Error('Choose files or folder import');
      const extensions = [...require('./library').AUDIO_EXTENSIONS].map(extension => extension.slice(1));
      const result = await dialog.showOpenDialog(window(), p.kind === 'folder' ? {title: '导入音乐文件夹', properties: ['openDirectory']} : {title: '导入音乐', properties: ['openFile', 'multiSelections'], filters: [{name: '音乐', extensions} ]});
      if (result.canceled || !result.filePaths.length) return snapshot();
      const imported = await (p.kind === 'folder' ? library.importFolder(result.filePaths[0]) : library.importFiles(result.filePaths));
      const selectedPaths = new Set(result.filePaths.map(canonical));
      const folderPrefix = `${canonical(result.filePaths[0]).replace(/\/$/, '')}/`;
      const accepted = imported.tracks.filter(track => p.kind === 'folder' ? canonical(track.path).startsWith(folderPrefix) : selectedPaths.has(canonical(track.path)));
      const importReport = {indexedCount: accepted.length, backendPrepared: false, warnings: []};
      const playable = accepted.filter(track => track.valid !== false && track.supported !== false);
      if (!playable.length) importReport.warnings.push('音乐索引已保存，但本次没有可供 foobar2000 精确校验的有效曲目。');
      else if (prepareLibraryPaths) {
        try {
          const prepared = await prepareLibraryPaths(playable.map(playbackLocation));
          importReport.pending = prepared.pending === true;
          importReport.restartRequired = prepared.restartRequired === true;
          if (prepared.pending) importReport.warnings.push('音乐索引已保存；新目录将在下次明确开始播放时应用，当前音乐保持播放。');
          else if (typeof foobar.prepareLocations === 'function') {
            await foobar.prepareLocations({locations: playable.map(playbackLocation)}); importReport.backendPrepared = true;
          }
        } catch (error) {importReport.warnings.push(`音乐索引已保存；专属后端尚未确认可访问音频：${error.message}`);}
      }
      else if (typeof foobar.prepareLocations !== 'function') importReport.warnings.push('音乐索引已保存；当前后端未提供路径校验，能否访问音频仍需在播放时确认。');
      else {
        try {
          const prepared = await foobar.prepareLocations({locations: playable.map(playbackLocation)});
          importReport.backendPrepared = true;
          if (Array.isArray(prepared?.warnings)) importReport.warnings.push(...prepared.warnings.map(String));
        } catch (error) {importReport.warnings.push(`音乐索引已保存；foobar2000 尚未确认可访问音频：${error.message}`);}
      }
      return {...imported, importReport};
    }),
    'library:refresh': mutateLibrary(() => library.refresh()),
    'library:remove': mutateLibrary(p => library.remove(ids(p.ids))),
    'library:reveal': p => library.reveal(string(p.id)),
    'playlist:create': mutateLibrary(p => library.createPlaylist(string(p.name, 'playlist name'))),
    'playlist:rename': mutateLibrary(p => library.renamePlaylist(string(p.id), string(p.name, 'playlist name'))),
    'playlist:delete': mutateLibrary(p => library.deletePlaylist(string(p.id))),
    'playlist:setTracks': mutateLibrary(p => library.setPlaylistTracks(string(p.id), ids(p.trackIds))),
    'playlist:addTracks': mutateLibrary(p => library.addPlaylistTracks(string(p.id), ids(p.trackIds))),
    'playlist:removeTracks': mutateLibrary(p => library.removePlaylistTracks(string(p.id), ids(p.trackIds))),
    'playlist:removeItem': mutateLibrary(p => {
      const index = numeric(p.index, 0, 1000000, 'playlist index');
      if (!Number.isInteger(index)) throw new Error('Playlist index must be an integer');
      return library.removePlaylistItem(string(p.id), index);
    }),
    'playlist:moveItem': mutateLibrary(p => {
      const fromIndex = numeric(p.fromIndex, 0, 1000000, 'source playlist index');
      const toIndex = numeric(p.toIndex, 0, 1000000, 'destination playlist index');
      if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) throw new Error('Playlist indices must be integers');
      return library.movePlaylistItem(string(p.id), fromIndex, toIndex);
    }),
    'player:state': player,
    'player:play': mutatePlayer(async p => {
      const source = p.source ?? 'local';
      if (!['local', 'apple'].includes(source)) throw new Error('Invalid playback source');
      if (source === 'apple') {
        const status = appleStatus(), capabilities = status.capabilities;
        const selected = p.ids ? ids(p.ids) : [string(p.id ?? p.trackId, 'Apple item ID')];
        const ready = capabilities.playback === true;
        if (!ready && capabilities.canSubmitPlayIntent !== true) throw new Error(status.message || 'Apple Music 后端尚未连接或未授权此能力。');
        const limit = ready && Number.isSafeInteger(capabilities.maxPlayItems) ? Math.max(1, Math.min(1000, capabilities.maxPlayItems)) : 1;
        if (!selected.length || selected.length > limit || selected.some(id => !/^[a-zA-Z0-9._-]{1,200}$/.test(id))) throw new Error('Invalid or unsupported Apple item IDs');
        const kind = p.kind == null ? 'songs' : string(p.kind, 'Apple item kind');
        const playableTypes = ready ? (Array.isArray(capabilities.playableTypes) ? capabilities.playableTypes : ['songs', 'library-songs']) :
          Array.isArray(capabilities.playIntentTypes) ? capabilities.playIntentTypes.filter(type => ['songs', 'library-songs'].includes(type)) : [];
        if (!playableTypes.includes(kind)) throw new Error('This Apple item type has no verified playback capability');
        if (!ready) {
          const intent = {id: p.id ?? p.trackId ?? selected[0], kind, ...(p.ids === undefined ? {} : {ids: p.ids})};
          if (capabilities.canSubmitPlayIntent !== true || selected.length !== 1 || intent.id !== selected[0] ||
              (p.id !== undefined && p.trackId !== undefined && p.id !== p.trackId) ||
              typeof apple?.canSubmitPlayIntent !== 'function' || apple.canSubmitPlayIntent(intent) !== true) throw new Error(status.message || 'Apple Music 后端尚未连接或未授权此能力。');
        }
        return playback.play({source, input: {ids: selected, kind}});
      }
      let skippedCount = 0;
      return playback.play({source, prepare: async context => {
      const selected = string(p.trackId);
      let order = p.trackIds;
      if (!order && p.playlistId) {
        const playlist = (await snapshot()).playlists.find(item => item.id === string(p.playlistId));
        if (!playlist) throw new Error('Playlist not found');
        order = playlist.trackIds;
      }
      order = order ? ids(order) : [selected];
      const selectedIndex = p.startIndex == null ? order.indexOf(selected) : numeric(p.startIndex, 0, Math.max(order.length - 1, 0), 'playback start index');
      if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || order[selectedIndex] !== selected) throw new Error('Selected track is absent from playback order at the chosen index');
      // Validate the chosen occurrence strictly, retaining missing entries in the library.
      const playable = [], resolved = await Promise.all(order.map(id => library.getTrack(id)));
      context.check();
      checkedLocation(resolved[selectedIndex], selected);
      let startIndex = 0;
      for (let index = 0; index < resolved.length; index++) {
        const track = resolved[index];
        if (!track || track.valid === false || track.supported === false) {skippedCount++; continue;}
        if (index === selectedIndex) startIndex = playable.length;
        try { playable.push(playbackLocation(track)); }
        catch { skippedCount++; }
      }
      return {locations: playable, startIndex};
      }, beforeStart: prepareLocalPlayback}).then(value => ({...value, skippedCount}));
    }),
    'player:context': p => {
      const input = record(p), source = Object.getOwnPropertyDescriptor(input, 'source')?.value;
      if (Reflect.ownKeys(input).some(key => key !== 'source') || !['local', 'apple'].includes(source)) throw new Error('Invalid playback context source');
      return playbackContext.read(source);
    },
    'player:spectrum': p => {
      if (Reflect.ownKeys(record(p)).length) throw new Error('Spectrum command accepts no payload fields');
      return typeof readSpectrum === 'function' ? readSpectrum() : emptySpectrum({reason: 'spectrum-unavailable'});
    },
    'player:toggle': mutatePlayer(() => playback.command('toggle')),
    'player:pause': mutatePlayer(() => playback.command('pause')),
    'player:stop': mutatePlayer(() => playback.command('stop')),
    'player:next': mutatePlayer(() => playback.command('next')),
    'player:previous': mutatePlayer(() => playback.command('previous')),
    'player:seek': mutatePlayer(p => playback.command('seek', numeric(p.position, 0, 604800, 'playback position'))),
    'player:volume': mutatePlayer(p => playback.command('setVolume', numeric(p.volume, 0, 1, 'volume'))),
    'player:order': mutatePlayer(p => {
      const id = typeof p.id === 'string' && /^\d+$/.test(p.id) ? Number(p.id) : p.id;
      numeric(id, 0, 10000, 'playback order ID');
      if (!Number.isInteger(id)) throw new Error('Playback order ID must be an integer');
      return playback.command('setOrder', id);
    }),
    'queue:list': async () => mapQueue(await foobar.queueList(), await tracks()),
    'queue:add': async p => { await foobar.queueAdd(await locations(p.trackIds)); return h['queue:list'](); },
    'queue:remove': async p => { const index = numeric(p.index, 0, 1000000, 'queue index'); if (!Number.isInteger(index)) throw new Error('Queue index must be an integer'); await foobar.queueRemove(index); return h['queue:list'](); },
    'queue:clear': async () => { await foobar.queueClear(); return h['queue:list'](); },
    'audio:outputs': () => foobar.outputs(),
    'audio:select': async p => { const result = await foobar.selectOutput(string(p.id, 'output ID')); emit('player', await player()); return result; },
    'audio:details': () => foobar.audioDetails(),
    'settings:get': () => settings.get(),
    'settings:update': async p => { const value = await settings.update(record(p.patch)); emit('settings', value); return value; },
    'lyrics:resolve': p => lyrics.resolve({trackId: string(p.trackId), force: p.force === true}),
    'lyrics:search': p => lyrics.search({trackId: string(p.trackId), query: p.query == null ? undefined : string(p.query, 'query')}),
    'lyrics:preview': p => lyrics.preview({trackId: string(p.trackId), candidate: record(p.candidate)}),
    'lyrics:bind': p => lyrics.bind({trackId: string(p.trackId), candidate: record(p.candidate)}),
    'lyrics:offset': p => lyrics.setOffset({trackId: string(p.trackId), offsetMs: numeric(p.offsetMs, -600000, 600000, 'lyrics offset')}),
    'lyrics:unbind': p => lyrics.unbind({trackId: string(p.trackId)}),
    'lyrics:import': async p => {
      const trackId = string(p.trackId);
      if (!await (getLyricsTrack || (id => library.getTrack(id)))(trackId)) throw new Error('Track not found');
      const result = await dialog.showOpenDialog(window(), {title: '导入歌词', properties: ['openFile'], filters: [{name: '歌词', extensions: lyrics.supportedFormats || ['lrc','txt']} ]});
      if (result.canceled || !result.filePaths.length) return {canceled: true};
      return lyrics.importFile({trackId, path: result.filePaths[0]});
    },
    'app:openDataFolder': async () => { const error = await shell.openPath(dataDir); if (error) throw new Error(error); return {opened: true}; },
    'app:restoreInfo': () => getRestoreInfo(),
    'app:window': p => { const w = window(); if (p.action === 'minimize') w.minimize(); else if (p.action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize(); else if (p.action === 'close') w.close(); else throw new Error('Invalid window action'); return {ok: true}; }
  };
  Object.defineProperties(h, {closePlaybackContext: {value: () => playbackContext.close()},
    invalidatePlaybackContext: {value: () => playbackContext.invalidate()}});
  return h;
}
async function invokeSafely(handler, payload) {
  try { return {ok: true, value: await handler(record(payload ?? {}))}; }
  catch (error) { return {ok: false, error: error instanceof Error ? error.message : String(error)}; }
}
const SMOKE_READ_CHANNELS = new Set(['app:bootstrap', 'app:restoreInfo', 'source:status', 'source:select', 'apple:status', 'apple:library', 'apple:search', 'library:list', 'player:state', 'player:context', 'player:spectrum', 'queue:list', 'audio:outputs', 'audio:details', 'settings:get', 'lyrics:resolve', 'lyrics:search', 'lyrics:preview']);
const DEFAULT_SMOKE_PLAN = [
  {action: 'click', selector: '[data-view="library"]'},
  {action: 'assert', selector: '#pageTitle', text: '曲目库'}, {action: 'screenshot', name: '01-library'},
  {action: 'click', selector: '[data-view="albums"]'}, {action: 'assert', selector: '#pageTitle', text: '专辑'}, {action: 'screenshot', name: '02-albums'},
  {action: 'click', selector: '[data-view="artists"]'}, {action: 'screenshot', name: '03-artists'},
  {action: 'click', selector: '[data-view="playlists"]'}, {action: 'screenshot', name: '04-playlists'},
  {action: 'click', selector: '[data-view="library"]'}, {action: 'fill', selector: '#search', value: 'STILL smoke search'},
  {action: 'screenshot', name: '05-search'}, {action: 'fill', selector: '#search', value: ''},
  {action: 'click', selector: '#queueButton'}, {action: 'wait', ms: 1000}, {action: 'assert', selector: '#dialog[open]'},
  {action: 'screenshot', name: '06-queue'}, {action: 'click', selector: '#closeDialog'},
  {action: 'click', selector: '#audioButton'}, {action: 'wait', ms: 1500}, {action: 'assert', selector: '#dialog[open]'},
  {action: 'screenshot', name: '07-settings'}, {action: 'click', selector: '#closeDialog'},
  {action: 'click', selector: '#nowTitle', optional: true}, {action: 'wait', ms: 200}, {action: 'screenshot', name: '08-now-playing-entry'},
  {action: 'click', selector: '#leaveImmersive', optional: true},
  {action: 'resize', width: 980, height: 680}, {action: 'wait', ms: 200}, {action: 'screenshot', name: '09-narrow-window'}
];
function validateSmokePlan(plan) {
  if (!Array.isArray(plan) || plan.length > 100) throw new Error('Smoke plan must be an array of at most 100 steps');
  return plan.map(step => {
    record(step);
    if (!['click', 'fill', 'select', 'wait', 'assert', 'resize', 'screenshot'].includes(step.action)) throw new Error('Unknown smoke action');
    if (['click', 'fill', 'select', 'assert'].includes(step.action)) string(step.selector, 'smoke selector');
    if (['fill', 'select'].includes(step.action) && typeof step.value !== 'string') throw new Error('Smoke value must be text');
    if (step.action === 'wait') numeric(step.ms, 0, 5000, 'smoke wait');
    if (step.action === 'resize') {
      for (const key of ['width', 'height']) if (!Number.isInteger(step[key]) || step[key] < 400 || step[key] > 3840) throw new Error('Invalid smoke window size');
    }
    if (step.action === 'screenshot' && (typeof step.name !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(step.name))) throw new Error('Invalid smoke screenshot name');
    if (step.text != null && typeof step.text !== 'string') throw new Error('Smoke assertion text must be text');
    if (step.optional != null && typeof step.optional !== 'boolean') throw new Error('Smoke optional flag must be boolean');
    if (step.allowBelowMinimum != null && (step.action !== 'resize' || typeof step.allowBelowMinimum !== 'boolean')) throw new Error('Smoke minimum override is allowed only as a resize boolean');
    return {...step};
  });
}
async function runDesktopSmoke({mainWindow, dataDir, version, getState, getActualState, simulatedUIFixture = false, diagnostics, plan = DEFAULT_SMOKE_PLAN}) {
  const productMinimumWindow = mainWindow.getMinimumSize();
  const report = {started: true, version, simulatedUIFixture, productMinimumWindow, sandbox: true, contextIsolation: true, readOnlyIPC: true, steps: [], screenshots: [], diagnostics};
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const execute = source => mainWindow.webContents.executeJavaScript(source);
  const capture = async name => {
    // DOM text can update before Chromium presents the corresponding frame.
    // Decode visible images and cross two animation frames before capturePage.
    const animationSettlement = await execute(`(async () => {
      await document.fonts.ready;
      await Promise.race([Promise.all([...document.images].map(image => image.decode?.().catch(() => {}))), new Promise(resolve => setTimeout(resolve, 1500))]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const finite = document.getAnimations().filter(animation => {
        const timing = animation.effect?.getComputedTiming();
        return animation.playState === 'running' && timing && Number.isFinite(timing.endTime) && Number.isFinite(timing.iterations);
      });
      const timedOut = await Promise.race([Promise.allSettled(finite.map(animation => animation.finished)).then(() => false), new Promise(resolve => setTimeout(() => resolve(true), 650))]);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return {finiteAnimations:finite.length,timedOut};
    })()`);
    await pause(150);
    await fs.writeFile(path.join(dataDir, `${name}.png`), (await mainWindow.webContents.capturePage()).toPNG());
    report.screenshots.push({name: `${name}.png`, animationSettlement, ...await execute(`(() => {
      const clip = document.getElementById('content')?.getBoundingClientRect();
      const visibleTrackRowRects = [...document.querySelectorAll('.track-row')].map(row => {
        const rect = row.getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom,left:rect.left,width:rect.width,height:rect.height};
      }).filter(rect => clip && rect.width > 0 && rect.top >= Math.max(clip.top,0) && rect.bottom <= Math.min(clip.bottom,innerHeight));
      const play = document.querySelector('.detail-play'), playRect = play?.getBoundingClientRect();
      const detailPlay = playRect ? {disabled:play.disabled,top:playRect.top,bottom:playRect.bottom,height:playRect.height,
        visible:playRect.width>0 && playRect.top>=Math.max(clip?.top||0,0) && playRect.bottom<=Math.min(clip?.bottom||innerHeight,innerHeight)} : null;
      return {view:window.StillApp?.state.view,immersive:window.StillApp?.state.immersive,
      browseSource:window.StillApp?.state.browseSource,heading:document.querySelector('#pageTitle')?.textContent,
      dialog:document.querySelector('dialog[open] h2')?.textContent || null,width:innerWidth,height:innerHeight,devicePixelRatio,
      visibleTrackRows:visibleTrackRowRects.length,fullyVisibleRowCount:visibleTrackRowRects.length,visibleTrackRowRects,detailPlay,horizontalOverflow:document.documentElement.scrollWidth > innerWidth};
    })()`)});
  };
  try {
    const deadline = Date.now() + 15000;
    while (!await execute('Boolean(window.StillApp?.state.ready)')) {
      if (Date.now() > deadline) throw new Error('Renderer did not become ready within 15 seconds');
      await pause(100);
    }
    await execute('document.fonts.ready.then(() => true)');
    report.bridge = await execute(`(async () => {
      const result = await window.still.invoke('app:bootstrap');
      return {tracks:result.library.tracks.length,playlists:result.library.playlists.length,
        playerAvailable:result.player.available,simulatedUIFixture:result.simulatedUIFixture === true,version:result.version,
        nodeExposed:typeof window.require !== 'undefined',bridgeReady:typeof window.still.on === 'function'};
    })()`);
    if (report.bridge.nodeExposed || !report.bridge.bridgeReady) throw new Error('Renderer isolation or preload bridge failed');
    await capture('00-startup');
    const beforeBrowsing = await getState();
    const selectBrowseSource = async source => {
      await execute(`document.getElementById(${JSON.stringify(source === 'apple' ? 'sourceApple' : 'sourceLocal')}).click()`);
      const deadline = Date.now() + 5000;
      while (await execute(`window.StillApp.state.browseSource !== ${JSON.stringify(source)}`)) {
        if (Date.now() > deadline) throw new Error('Browsing source did not update');
        await pause(50);
      }
      const selected = await execute(`window.still.invoke('source:status')`);
      if (selected.selectedSource !== source) throw new Error('Browsing source IPC did not agree with the DOM');
    };
    await selectBrowseSource('apple'); await pause(100); await capture('00-apple-source');
    const whileAppleBrowsing = await getState();
    await selectBrowseSource('local'); await pause(100); await capture('00-local-source');
    const afterBrowsing = await getState();
    const playbackIdentity = state => JSON.stringify({generation: state.generation, source: state.source, state: state.state,
      currentTrackId: state.currentTrackId || null, path: state.currentTrack?.path || null, subsong: state.currentTrack?.subsong ?? null});
    report.sourceBrowsing = {before: beforeBrowsing, whileAppleBrowsing, after: afterBrowsing,
      unchanged: playbackIdentity(beforeBrowsing) === playbackIdentity(whileAppleBrowsing) && playbackIdentity(beforeBrowsing) === playbackIdentity(afterBrowsing),
      activePlaybackObserved: !simulatedUIFixture && beforeBrowsing.available === true && ['playing', 'paused'].includes(beforeBrowsing.state)};
    if (!report.sourceBrowsing.unchanged) throw new Error('Browsing source changed actual playback state or generation');
    for (const step of validateSmokePlan(plan)) {
      if (step.action === 'wait') await pause(step.ms);
      else if (step.action === 'resize') {
        if (step.allowBelowMinimum) {
          mainWindow.setMinimumSize(Math.min(productMinimumWindow[0], step.width), Math.min(productMinimumWindow[1], step.height));
          report.forcedBelowProductMinimum = step.width < productMinimumWindow[0] || step.height < productMinimumWindow[1];
        }
        mainWindow.setSize(step.width, step.height); await pause(150);
      }
      else if (step.action === 'screenshot') await capture(step.name);
      else {
        const outcome = await execute(`(() => {
          const step = ${JSON.stringify(step)};
          const element = document.querySelector(step.selector);
          if (!element) {if (step.optional) return 'missing'; throw new Error('Smoke element missing: ' + step.selector);}
          const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
          if (!bounds.width || !bounds.height || style.visibility === 'hidden' || style.display === 'none') {if (step.optional) return 'hidden'; throw new Error('Smoke element hidden: ' + step.selector);}
          if (step.action === 'click') {if (element.disabled) {if (step.optional) return 'disabled'; throw new Error('Smoke element disabled');} element.click();}
          if (step.action === 'fill' || step.action === 'select') {
            element.value = step.value;
            element.dispatchEvent(new Event(step.action === 'fill' ? 'input' : 'change', {bubbles:true}));
          }
          if (step.action === 'assert' && step.text != null && !element.textContent.includes(step.text)) throw new Error('Smoke text mismatch: ' + step.selector);
          return true;
        })()`);
        if (outcome !== true) {report.steps.push({...step, skipped: outcome}); continue;}
      }
      report.steps.push({...step, passed: true});
    }
    report.dom = await execute(`({title:document.title,ready:window.StillApp.state.ready,view:window.StillApp.state.view,
      heading:document.querySelector('h1')?.textContent,connection:document.getElementById('connectionText')?.textContent,
      viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},
      horizontalOverflow:document.documentElement.scrollWidth > innerWidth,
      reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,
      missingImages:[...document.images].filter(image => image.complete && !image.naturalWidth).map(image => image.src)})`);
    report.player = await getState();
    if (getActualState) report.actualPlayer = await getActualState();
    await capture('desktop-smoke');
    report.passed = !diagnostics.some(item => item.level === 'error') && !report.dom.missingImages.length && !report.screenshots.some(item => item.horizontalOverflow);
  } catch (error) {report.error = error.message; report.passed = false; await capture('desktop-smoke-failed').catch(() => {});}
  report.completedAt = new Date().toISOString();
  await fs.writeFile(path.join(dataDir, 'desktop-smoke.json'), JSON.stringify(report, null, 2));
  return report;
}

async function run() {
  const {app, BrowserWindow, ipcMain, protocol, net, session, dialog, shell, Menu, screen, safeStorage, nativeTheme} = require('electron');
  registerApplicationSchemes(protocol);
  const root = path.resolve(__dirname, '../..');
  const dataDir = process.env.STILL_DATA_DIR ? path.resolve(process.env.STILL_DATA_DIR) : path.join(app.isPackaged ? path.dirname(app.getPath('exe')) : root, 'data');
  const runtimeRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : root;
  // The product never discovers or launches the original ancestor installation.
  // STILL_FOOBAR_DIR is an explicit developer diagnostic override only.
  const foobarDir = await resolveFoobarDir(runtimeRoot, process.env.STILL_FOOBAR_DIR);
  // Keep Chromium cache and user preferences portable too.
  await fs.mkdir(path.join(dataDir, 'electron', 'session'), {recursive: true});
  app.setPath('userData', path.join(dataDir, 'electron'));
  app.setPath('sessionData', path.join(dataDir, 'electron', 'session'));
  if (!app.requestSingleInstanceLock()) { console.error('STILL is already running with this data directory.'); app.exit(process.env.STILL_SMOKE_TEST === '1' ? 1 : 0); return; }
  let mainWindow, pollTimer, shuttingDown = false, shutdownComplete = false, shutdownFailure = null, polling = false;
  const smokeMode = process.env.STILL_SMOKE_TEST === '1';
  const diagnostics = [];
  function diagnostic(level, message, details = {}) {
    if (diagnostics.length < 200) diagnostics.push({level, message, ...details});
    if (level === 'error') console.error('STILL:', message);
  }
  let lastState = '', lastSources = '', syncedBackend = false, syncPromise = null, syncRetryAt = 0, libraryState, connectionEpoch = 0, wasAvailable = false;
  let coordinator, emittedGeneration = -1, emittedRevision = -1, cachedPlayer = null, spectrumService = null;
  const rememberPlayer = value => {
    if (value.generation < (coordinator?.currentGeneration() ?? 0) || (cachedPlayer && (value.generation < cachedPlayer.generation ||
        (value.generation === cachedPlayer.generation && value.revision < cachedPlayer.revision)))) return;
    cachedPlayer = value;
    spectrumService?.refresh();
  };
  const emit = (name, value) => {
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
  await app.whenReady();
  let closeAppleArtwork = async () => {}, closeMetadataCovers = async () => {}, closePublicFetch = async () => {}, closePlaybackContext = () => {}, closeSpectrum = () => {};
  try {
  const publicNetwork = createPublicFetchService({session});
  const publicFetch = publicNetwork.fetch;
  closePublicFetch = publicNetwork.close;
  nativeTheme.themeSource = 'dark';
  await fs.mkdir(dataDir, {recursive: true});
  const settings = createSettingsService({dataDir});
  await settings.initialize();
  const {createLibraryService} = require('./library');
  const {createFoobarService} = require('./foobar');
  const {createBackendManager} = require('./backend');
  const {createLyricsService} = require('./lyrics');
  const {createQqLyricsClient} = require('./qq-lyrics');
  let metadataCovers = null;
  const decorateLibrarySnapshot = value => metadataCovers ? metadataCovers.decorateSnapshot(value) : value;
  const decorateTrack = value => metadataCovers ? metadataCovers.decorateTrack(value) : value;
  const library = createLibraryService({dataDir, onUpdate: value => {libraryState = value; emit('library', decorateLibrarySnapshot(value));}, dialog, shell});
  const backend = createBackendManager({dataDir, backendDir: foobarDir,
    quietRestartPolicy: 'stopped-owned-exit',
    ownedExitOutputPolicy: 'dx1-wasapi-in-process-v1',
    probePath: path.join(root, 'scripts', 'foobar-coreaudio-probe.exe')});
  const initialBackendInfo = backend.getInfo();
  const backendStartupController = new AbortController();
  let backendStartup = null, backendStarting = true, bridgeReady = false, bridgeReachable = false, backendInitError = null;
  let getCachedLocalHandoff = () => null;
  const getBackendInfo = () => {
    const info = backend.getInfo(), pendingRestore = getCachedLocalHandoff()?.pendingRestore === true;
    return {...info, available: info.available && bridgeReady && bridgeReachable && !pendingRestore,
      verified: info.available && bridgeReady && !pendingRestore, pendingHandoff: info.pendingHandoff === true || pendingRestore,
      ...(backendStarting ? {status: 'starting'} : {}), ...(backendInitError ? {error: backendInitError} : {}),
      ...(shutdownFailure ? {available: false, status: 'failed', error: shutdownFailure} : {})};
  };
  let lastLocalOutput = null;
  const rawFoobar = createFoobarSessionService({createService: createFoobarService, backend,
    serviceOptions: {dataDir, foobarDir: initialBackendInfo.foobarDir || foobarDir,
      baseUrl: initialBackendInfo.baseUrl, pollIntervalMs: 0, persistOutputSelection: !smokeMode,
      onAudioDispatch: event => spectrumService?.onAudioDispatch(event),
      probePath: path.join(root, 'scripts', 'foobar-coreaudio-probe.exe'),
      waitForOutputRelease: args => backend.waitForOutputRelease(args)},
    onUpdate: state => {
      bridgeReachable = state.backendReachable ?? state.available === true;
      if (state.output) lastLocalOutput = state.output;
      if (!bridgeReachable && state.error) backendInitError = state.error;
    }, onOutputConnection: () => {lastSources = '';}});
  getCachedLocalHandoff = () => rawFoobar.getHandoffStatus();
  await rawFoobar.initializeHandoff();
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
    diagnostic('warning', 'Apple Music 后端尚未连接。');
    apple = unavailableAppleService();
  }
  try {
    const {createMetadataCoverService} = require('./metadata-covers');
    metadataCovers = createMetadataCoverService({cacheDirectory: path.join(dataDir, 'cover-metadata-cache'), artworkUrlFor, fetchImpl: publicFetch,
      onChange: () => {if (!shuttingDown && libraryState) emit('library', decorateLibrarySnapshot(libraryState));}});
    closeMetadataCovers = () => metadataCovers.close();
    // Cache initialization and public metadata lookups must not delay the
    // window, bootstrap or either playback engine.
    Promise.resolve(metadataCovers.initialize()).catch(() => diagnostic('warning', '封面元数据缓存暂不可用。'));
  } catch {diagnostic('warning', '封面元数据服务暂不可用。');}
  coordinator = createPlaybackCoordinator({engines: {local: foobar, apple: createAppleAdapter(apple)},
    prepareAppleHandoff: context => prepareAppleHandoffLifecycle({backend, bridge: rawFoobar, onBridgeReady: value => {bridgeReady = value;}}, context)});
  try {
    const {createSpectrumClient, DEFAULT_READER_PATH} = require('./spectrum-client');
    const client = createSpectrumClient({readerPath: DEFAULT_READER_PATH, getBackendSession: () => backend.getSession()});
    spectrumService = createPlayerSpectrumService({client, getPlayer: () => cachedPlayer,
      getGeneration: () => coordinator.currentGeneration(), getBackendInfo, getBackendSession: () => backend.getSession(),
      getAudioTransportStatus: () => rawFoobar.getAudioTransportStatus()});
    closeSpectrum = () => spectrumService.dispose();
  } catch {diagnostic('warning', '当前播放频谱暂不可用。');}
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
  const diagnosticExport = createDiagnosticsService({dataDir, getSnapshot: createDiagnosticSnapshotReader({apple, getBuildSnapshot,
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
    return {player: mapPlayer(playerState, libraryState?.tracks || []), sources: await handlers['source:status'](),
      backend: {pid: managed.pid, backendId: managed.backendId, sessionId: managed.sessionId,
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
  await library.initialize();
  libraryState = await library.list();
  await lyrics.initialize();
  async function startBackend({start = true, restartOwned = false} = {}) {
    if (backendStartup) return backendStartup;
    backendStarting = true; backendInitError = null; bridgeReady = false; bridgeReachable = false; lastSources = '';
    connectionEpoch++; syncedBackend = false;
    backendStartup = (async () => {
      if (shuttingDown) return getBackendInfo();
      const info = await initializeBackend(backend, {start, restartOwned, signal: backendStartupController.signal});
      if (shuttingDown) return getBackendInfo();
      backendInitError = info.error || null;
      if (info.available) {
        try {
          const state = await rawFoobar.connect(info);
          bridgeReady = state.available === true;
          if (!bridgeReady) backendInitError = state.error || '专属内核尚未读回就绪状态。';
        } catch (error) {bridgeReady = false; backendInitError = error.message;}
      } else bridgeReady = false;
      return getBackendInfo();
    })().finally(() => {backendStarting = false; backendStartup = null; lastSources = '';});
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
      await library.importFoobar(await foobar.librarySnapshot());
    }
    if (epoch === connectionEpoch) syncedBackend = true;
  }
  function startBackendSync() {
    if (syncPromise || syncedBackend || Date.now() < syncRetryAt || shuttingDown) return;
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
  mainWindow.webContents.on('console-message', event => diagnostic(event.level, event.message, {source: event.sourceId, line: event.lineNumber}));
  mainWindow.webContents.on('preload-error', (_event, file, error) => diagnostic('error', `Preload failed: ${error.message}`, {source: file}));
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    diagnostic('error', `Renderer exited: ${details.reason}`, {exitCode: details.exitCode});
    if (!smokeMode && !shuttingDown) {dialog.showErrorBox('STILL 界面异常退出', `界面进程已退出：${details.reason}。请重新打开 STILL；你的音乐和 foobar2000 设置保留。`); app.quit();}
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  const getRestoreInfo = async () => ({dataDir, foobarDir, audioEngine: 'foobar2000',
    guide: 'docs/foobar-install-restore.md', originalBackup: 'D:\\foobar2000\\Still-backup-20261028-before-beefweb',
    message: 'STILL 的库、列表、歌词绑定和偏好在 data。专属 foobar2000 后端在 backend/foobar2000，正常打开 STILL 时由应用管理；不会自动发现或启动原来的 foobar2000。',
    nativeDiagnostics: '若 Beefweb 未返回原始输出错误，则失败原因未确认；不能据此判断设备独占占用。输出与 DAC 实测结果见独立验收记录。',
    backendError: backendInitError || null, managedBackend: getBackendInfo(),
    backend: typeof foobar.restoreInfo === 'function' ? await foobar.restoreInfo() : null});
  let handlers = createHandlers({library, foobar, apple, coordinator, lyrics, settings, dialog, shell, dataDir, emit, window: () => mainWindow, version: app.getVersion(), getRestoreInfo,
    getLibrarySnapshot: () => libraryState, getBackendInfo, getLyricsTrack, decorateLibrarySnapshot, decorateTrack,
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
    track: libraryState.tracks.find(item => item.valid !== false && item.coverUrl && /[\u3400-\u9fff]/.test(item.title)) || libraryState.tracks.find(item => item.valid !== false)});
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, async (event, payload) => {
    if (!isTrustedApplicationSender(event, mainWindow, expectedUrl)) return {ok: false, error: 'Untrusted application sender'};
    if (smokeMode && !SMOKE_READ_CHANNELS.has(channel)) {
      const error = `Read-only desktop smoke blocked command: ${channel}`;
      diagnostic('error', error); return {ok: false, error};
    }
    const response = await invokeSafely(handler, payload);
    if (!response.ok) emit('error', {channel, message: response.error});
    return response;
  });
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true; backendStartupController.abort(); clearInterval(pollTimer);
    closeSpectrum();
    closePlaybackContext();
    shutdownDesktop({coordinator, foobar: rawFoobar, backend, syncPromise, smokeMode, bridgeSessionBound: rawFoobar.sessionBound(),
      closeServices: [closeMetadataCovers, closeAppleArtwork, () => settings.close(), () => library.close(), () => lyrics.close(), () => apple.close(), () => diagnosticExport.close?.(), closePublicFetch]
    }).then(() => {
      shutdownComplete = true;
      smokeMode ? app.exit(process.exitCode || 0) : app.quit();
    }).catch(error => {
      shutdownFailure = error.message; diagnostic('error', `关闭后端失败：${error.message}`);
      if (smokeMode) {process.exitCode = 1; app.exit(1); return;}
      shuttingDown = false;
      if (mainWindow && !mainWindow.isDestroyed()) {mainWindow.show(); mainWindow.focus();}
      emit('error', {channel: 'app:shutdown', message: error.message});
      dialog.showErrorBox('STILL 尚未完成退出', `${error.message}\n未强制结束其他进程。请保留此窗口并查看诊断，处理后可再次关闭。`);
    });
  });
  const startup = await revealBeforeBackend({openWindow: async () => {
    await mainWindow.loadFile(rendererFile);
    if (!mainWindow.isDestroyed()) mainWindow.show();
  }, initialize: () => startBackend({start: !smokeMode && !process.env.STILL_FOOBAR_DIR})});
  startup.completion.catch(error => {backendInitError = error.message; backendStarting = false; lastSources = '';});
  Promise.resolve().then(() => apple.initialize()).catch(() => {lastSources = '';});
  async function poll() {
    if (polling || shuttingDown) return;
    polling = true;
    try {
      const sources = await handlers['source:status']();
      const serializedSources = JSON.stringify(sources);
      if (serializedSources !== lastSources) {lastSources = serializedSources; emit('source', sources);}
      const localAvailable = sources.sources.local.available;
      if (localAvailable) {if (!wasAvailable) syncRetryAt = 0; backendInitError = null; startBackendSync();}
      else {if (wasAvailable) connectionEpoch++; syncedBackend = false;}
      wasAvailable = localAvailable;
      const state = await handlers['player:state']();
      const serialized = JSON.stringify(state);
      if (serialized !== lastState) { lastState = serialized; emit('player', state); }
    } catch (error) { emit('player', {available: false, state: 'unavailable', source: null, position: 0, duration: 0, volume: null,
      generation: coordinator.currentGeneration(), revision: coordinator.currentRevision(), error: error.message}); }
    finally { polling = false; }
  }
  pollTimer = setInterval(poll, 600);
  await poll();
  if (smokeMode) {
    let report;
    try {
      const plan = process.env.STILL_SMOKE_PLAN ? JSON.parse(await fs.readFile(path.resolve(process.env.STILL_SMOKE_PLAN), 'utf8')) : undefined;
      report = await runDesktopSmoke({mainWindow, dataDir, version: app.getVersion(), getState: handlers['player:state'], getActualState: getActualPlayer, simulatedUIFixture, diagnostics, plan});
      console.log(`Desktop smoke ${report.passed ? 'passed' : 'FAILED'}: ${path.join(dataDir, 'desktop-smoke.json')}`);
    } catch (error) {
      report = {passed: false, error: error.message, diagnostics};
      await fs.writeFile(path.join(dataDir, 'desktop-smoke.json'), JSON.stringify(report, null, 2));
    } finally {process.exitCode = report?.passed ? 0 : 1; app.quit();}
  }
  } catch (error) {
    closeSpectrum();
    closePlaybackContext();
    try {await closeMetadataCovers();} finally {try {await closeAppleArtwork();} finally {await closePublicFetch();}}
    throw error;
  }
}
if (require.main === module || (process.versions.electron && process.type === 'browser')) run().catch(error => {
  console.error('STILL startup failed:', error); process.exitCode = 1;
  try { const {app, dialog} = require('electron'); if (process.env.STILL_SMOKE_TEST !== '1') dialog.showErrorBox('STILL 无法启动', error.message); app.exit(1); } catch {}
});
module.exports = {APPLE_PLAYBACK_MAINTENANCE, createHandlers, invokeSafely, mapPlayer, mapQueue, safeCoverPath, resolveFoobarDir, initializeBackend, prepareLocalPlaybackLifecycle, prepareAppleHandoffLifecycle, revealBeforeBackend, guardFoobarService, settleWithin, shutdownDesktop, createAppleAdapter, unavailableAppleService, withSmokeLyricsFixture, windowSize, validateDiagnosticLayout, validateSmokePlan, runDesktopSmoke, registerApplicationSchemes, createAppleMusicIntegration, createLyricsTrackResolver, isTrustedApplicationSender, isApprovedPublicRequest, createPublicFetchService, run};
