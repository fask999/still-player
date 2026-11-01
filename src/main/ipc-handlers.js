'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const {createPlaybackCoordinator} = require('./playback-coordinator');
const {createPlaybackContextService} = require('./playback-context');
const RECOVERY_READ_CHANNELS = new Set(['app:bootstrap', 'app:window', 'app:openDataFolder', 'app:restoreInfo', 'app:exportDiagnostics',
  'app:safeOwnedExitStatus', 'source:status', 'apple:status', 'library:list', 'settings:get', 'player:state', 'player:context', 'player:spectrum',
  'queue:list', 'audio:outputs', 'audio:details']);
const READ_ONLY_MESSAGE = '安全退出尚未完成；当前仅保留只读状态与诊断，播放和更改操作已关闭。请查看诊断后再次退出。';
function commandAvailability(channel, {fatal = false, shuttingDown = false, readOnly = false} = {}) {
  if (fatal || shuttingDown) return {ok: false, error: '应用正在安全退出，命令已关闭。'};
  if (readOnly && !RECOVERY_READ_CHANNELS.has(channel)) return {ok: false, error: READ_ONLY_MESSAGE};
  return {ok: true};
}
function validateSafeOwnedExitPayload(payload, requireSelection = false) {
  const value = payload === undefined ? {} : record(payload);
  const keys = Reflect.ownKeys(value);
  if (!requireSelection) {
    if (keys.length) throw new Error('安全退出状态查询不接受参数。');
    return {};
  }
  const token = Object.getOwnPropertyDescriptor(value, 'selectionToken')?.value;
  if (keys.length !== 1 || keys[0] !== 'selectionToken' || typeof token !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) throw new Error('请重新查询并选择可安全退出的遗留后台。');
  return {selectionToken: token};
}
// Native start/session/failure cleanup passed independent code review. Enable
// only actual official-session capabilities; account/full-song playback remains
// unverified and Apple queue is still disabled below.
const APPLE_PLAYBACK_MAINTENANCE = false;
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
function identity(track) { return `${canonical(track.path)}|${Number.isInteger(track.subsong) && track.subsong >= 0 ? track.subsong : 'unknown'}`; }
function createLibraryView() {
  const records = new Map(), locations = new Map();
  let order = [], playlists = [], folders = [], status = {}, revision = 0, initialized = false, cachedTracks, eventCursors = {}, viewVersion = 0;
  const validCursor = value => value && typeof value.streamId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.streamId) &&
    Number.isSafeInteger(value.sequence) && value.sequence >= 0;
  const location = track => typeof track?.path === 'string' ? identity(track) : null;
  function remove(id) {
    const previous = records.get(id), key = location(previous);
    if (key) {const ids = locations.get(key); ids?.delete(id); if (!ids?.size) locations.delete(key);}
    records.delete(id);
  }
  function put(track) {
    remove(track.id); records.set(track.id, track);
    const key = location(track);
    if (key) {if (!locations.has(key)) locations.set(key, new Set()); locations.get(key).add(track.id);}
  }
  function tracks() {return cachedTracks ||= order.map(id => records.get(id)).filter(Boolean);}
  function match(items) {
    const selected = new Map();
    for (const item of items) {
      const id = item?.id ?? item?.currentTrackId;
      if (records.has(id)) selected.set(id, records.get(id));
      const ids = locations.get(location(item));
      for (const found of ids || []) selected.set(found, records.get(found));
    }
    return [...selected.values()];
  }
  return {
    replace(value, {expectedVersion} = {}) {
      const nextRevision = value.revision ?? 0, currentCursor = eventCursors.library, nextCursor = value.eventCursors?.library;
      if (!Number.isSafeInteger(nextRevision) || nextRevision < 0 || (nextCursor !== undefined && !validCursor(nextCursor))) return false;
      if (initialized) {
        if (nextRevision < revision) return false;
        if (validCursor(currentCursor)) {
          // The source stream is fixed for this library lifetime. A delayed
          // snapshot cannot remove its cursor or undo even same-revision status.
          if (!validCursor(nextCursor) || nextCursor.streamId !== currentCursor.streamId || nextCursor.sequence < currentCursor.sequence) return false;
        } else if (expectedVersion !== undefined && expectedVersion !== viewVersion) {
          // Legacy DI has no event cursor. Its snapshot may replace the view
          // only if no accepted update occurred while list() was pending.
          return false;
        }
      }
      records.clear(); locations.clear();
      for (const track of value.tracks || []) put(track);
      order = (value.tracks || []).map(track => track.id); playlists = value.playlists || []; folders = value.folders || [];
      revision = nextRevision; status = value.status || {}; eventCursors = structuredClone(value.eventCursors || {});
      initialized = true; cachedTracks = undefined; viewVersion++;
      return true;
    },
    apply(delta) {
      if (!initialized || delta?.kind !== 'library-delta' || delta.baseRevision !== revision || delta.revision < revision) return false;
      const parsed = /^library:([a-f0-9-]{36}):([1-9][0-9]*)$/i.exec(delta.eventId || '');
      if (parsed) {
        const cursor = eventCursors.library, sequence = Number(parsed[2]);
        if (!Number.isSafeInteger(sequence) || (cursor && (cursor.streamId !== parsed[1] || sequence !== cursor.sequence + 1))) return false;
        eventCursors = {...eventCursors, library: {streamId: parsed[1], sequence}};
      }
      for (const id of delta.removedTrackIds || []) remove(id);
      const newIds = [];
      for (const track of delta.tracks || []) {if (!records.has(track.id)) newIds.push(track.id); put(track);}
      if (delta.trackIds) order = [...delta.trackIds];
      else if (newIds.length || delta.removedTrackIds?.length) order = [...order, ...newIds].filter(id => records.has(id));
      if (delta.playlists) playlists = delta.playlists;
      if (delta.folders) folders = delta.folders;
      if (delta.status) status = delta.status;
      revision = delta.revision;
      viewVersion++;
      if (delta.tracks?.length || delta.removedTrackIds?.length || delta.trackIds) cachedTracks = undefined;
      return true;
    },
    snapshot: () => ({tracks: tracks(), playlists, folders, revision, status, eventCursors: structuredClone(eventCursors)}),
    tracks, getTracks: ids => ids.map(id => records.get(id)).filter(Boolean), getPlaylist: id => playlists.find(item => item.id === id),
    playerTracks: state => match([state.currentTrack || {}, {id: state.currentTrackId, path: state.currentTrack?.path || state.path,
      subsong: state.currentTrack?.subsong ?? state.subsong}]),
    queueTracks: queue => match(queue.items || []),
    summary: () => ({revision, status}), isInitialized: () => initialized, version: () => viewVersion
  };
}
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
function createHandlers({library, foobar, apple, lyrics, settings, dialog, shell, dataDir, emit = () => {}, window, version, getRestoreInfo, getLibrarySnapshot, getLibraryTracks, getPlayerTracks, getQueueTracks, getLibraryPlaylist, libraryReturnsDeltas = false, onSettingsChanged, coordinator, getBackendInfo, retryBackend, prepareLibraryPaths, prepareLocalPlayback, persistUIState = true, getRuntimeState = () => ({}), getSafeOwnedExitTarget, requestSafeOwnedExit,
  exportDiagnostics, observeDiagnosticPlayer, observeDiagnosticSources, observeAppleRead, getLyricsTrack, decorateLibrarySnapshot = value => value, decorateTrack, readSpectrum, spectrumSupported = false}) {
  const playback = coordinator || createPlaybackCoordinator({engines: {local: foobar || {}, ...(apple ? {apple: createAppleAdapter(apple)} : {})}});
  const checkWritable = () => {
    const allowed = commandAvailability('settings:update', getRuntimeState());
    if (!allowed.ok) throw new Error(allowed.error);
  };
  let selectedSource = 'local';
  const snapshot = async () => decorateLibrarySnapshot(await (getLibrarySnapshot ? getLibrarySnapshot() : library.list()));
  const tracks = async () => getLibraryTracks ? getLibraryTracks() : (await snapshot()).tracks;
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
    const mapped = mapPlayer(state, getPlayerTracks ? await getPlayerTracks(state) : await tracks(), decorateTrack);
    if (getRuntimeState().readOnly) Object.assign(mapped, {controlsReady: false, readOnly: true, error: READ_ONLY_MESSAGE, errorCode: 'STILL_SHUTDOWN_FAILED'});
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
    const localStatus = standby ? 'standby' : local.controlUncertain ? 'control-unconfirmed' : local.connectionStatus === 'degraded' ? 'degraded' : !reachable ? 'offline' : outputChanged ? 'output-changed' :
      outputUnavailable ? (output.status === 'disconnected' ? 'device-disconnected' : 'device-unknown') : outputUnknown ? 'device-unknown' :
      retryRequired ? 'device-reconnected' : 'ready';
    const localMessage = standby ? (canStartOnDemand ? '本地内核正在安全待命；明确选择本地曲目播放时会重新连接。' : '本地资源交接仍待核验，播放内核不会自动重启。') : local.controlUncertain ?
      '旧播放控制尚未证实结束。请重连专属内核；重连不会自动开始播放。' : local.connectionStatus === 'degraded' ? '状态读取暂时中断；保留上次确认的进度，正在重试。' : !reachable ? (['starting', 'restarting', 'checking'].includes(backend.status) ? '专属本地内核正在启动或检查。' :
      '专属本地内核未连接；可查看诊断并重试，已保存的音乐库仍可浏览。') : outputChanged ?
      '播放器当前输出与已确认设备不一致。请在音频设置中明确选择设备；未自动切换输出。' : outputUnavailable || outputUnknown ? output.message : retryRequired ?
      '原音频设备已重新连接。请明确重试或选择播放；不会自动恢复。' : '由内置 foobar2000 播放本地音乐。';
    const value = {selectedSource, sources: {
      local: {id: 'local', name: '本地音乐', status: localStatus, available: reachable,
        backendReachable: reachable, connected: reachable, outputConnection: output, controlUncertain: local.controlUncertain === true,
        connectionStatus: local.connectionStatus, stale: local.stale, consecutiveReadFailures: local.consecutiveReadFailures, lastGoodAt: local.lastGoodAt,
        backendStatus: standby ? 'standby' : reachable ? 'ready' : ['starting', 'restarting', 'checking'].includes(backend.status) ? 'starting' : 'offline',
        backendDiagnostic: backend.error || local.error || null, message: localMessage,
        capabilities: {library: true, playback: reachable && !local.controlUncertain && !outputUnavailable && !outputChanged,
          nativeImport: true, canStartOnDemand, retryBackend: !standby && typeof retryBackend === 'function'}},
      apple: appleStatus()
    }};
    if (getRuntimeState().readOnly) {
      for (const source of Object.values(value.sources)) {
        source.message = READ_ONLY_MESSAGE;
        source.controlsReady = false;
        source.capabilities = {...source.capabilities, playback: false, canSubmitPlayIntent: false, canStartOnDemand: false,
          authorize: false, pairing: false, retryBackend: false, queue: false, toggle: false, next: false, previous: false,
          seek: false, volume: false, order: false, outputSelection: false};
      }
    }
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
  const mutateLibrary = fn => async payload => {
    const raw = await fn(payload);
    if (raw == null) return raw;
    // Runtime onDelta already applied and broadcast the committed mutation once.
    if (raw?.kind === 'library-delta') return {...raw, tracks: raw.tracks.map(decorateTrack)};
    const value = decorateLibrarySnapshot(raw); emit('library', value); return value;
  };
  const mutatePlayer = fn => async payload => {
    playbackContext.invalidate();
    const result = await fn(payload);
    const value = await player();
    if (Number.isInteger(result?.skippedCount)) value.skippedCount = result.skippedCount;
    emit('player', value); return value;
  };
  const h = {
    'app:safeOwnedExitStatus': async p => {
      validateSafeOwnedExitPayload(p);
      return typeof getSafeOwnedExitTarget === 'function' ? getSafeOwnedExitTarget() : {available: false, refused: true,
        code: 'STILL_BACKEND_OWNERSHIP_UNVERIFIED', reason: '未找到本次应用创建记录与实时身份均可核验的后台。', selectionToken: null, target: null};
    },
    'app:safeOwnedExit': async p => {
      const selection = validateSafeOwnedExitPayload(p, true);
      if (typeof requestSafeOwnedExit !== 'function') throw new Error('无法核验遗留后台归属；安全退出操作未启用。');
      return requestSafeOwnedExit(selection);
    },
    'app:bootstrap': async () => {
      const sources = await sourceStatus();
      return {library: await snapshot(), player: await player(), settings: settings.get(), ...sources,
        capabilities: {engine: 'foobar2000', transport: 'Beefweb', nativeDialogs: true, ...(typeof foobar.capabilities === 'function' ? await foobar.capabilities() : {}),
          persistUIState, exportDiagnostics: persistUIState && typeof exportDiagnostics === 'function', externalLyrics: true, spectrum: spectrumSupported === true},
        safeOwnedExit: {label: '安全退出遗留后台', ...await h['app:safeOwnedExitStatus']({})}, version};
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
      if (result.canceled || !result.filePaths.length) return libraryReturnsDeltas ? null : snapshot();
      checkWritable();
      const imported = await (p.kind === 'folder' ? library.importFolder(result.filePaths[0]) : library.importFiles(result.filePaths));
      const selectedPaths = new Set(result.filePaths.map(canonical));
      const folderPrefix = `${canonical(result.filePaths[0]).replace(/\/$/, '')}/`;
      const accepted = imported.tracks.filter(track => p.kind === 'folder' ? canonical(track.path).startsWith(folderPrefix) : selectedPaths.has(canonical(track.path)));
      const importReport = {indexedCount: accepted.length, backendPrepared: false, warnings: []};
      const playable = accepted.filter(track => track.valid !== false && track.supported !== false);
      if (!playable.length) importReport.warnings.push('音乐索引已保存，但本次没有可供 foobar2000 精确校验的有效曲目。');
      else if (prepareLibraryPaths) {
        checkWritable();
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
        const playlist = getLibraryPlaylist ? await getLibraryPlaylist(string(p.playlistId)) : (await snapshot()).playlists.find(item => item.id === string(p.playlistId));
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
    'queue:list': async () => {const queue = await foobar.queueList(); return mapQueue(queue, getQueueTracks ? await getQueueTracks(queue) : await tracks());},
    'queue:add': async p => { await foobar.queueAdd(await locations(p.trackIds)); return h['queue:list'](); },
    'queue:remove': async p => { const index = numeric(p.index, 0, 1000000, 'queue index'); if (!Number.isInteger(index)) throw new Error('Queue index must be an integer'); await foobar.queueRemove(index); return h['queue:list'](); },
    'queue:clear': async () => { await foobar.queueClear(); return h['queue:list'](); },
    'audio:outputs': () => foobar.outputs(),
    'audio:select': async p => { const result = await foobar.selectOutput(string(p.id, 'output ID')); emit('player', await player()); return result; },
    'audio:details': () => foobar.audioDetails(),
    'settings:get': () => settings.get(),
    'settings:update': async p => { const value = await settings.update(record(p.patch)); onSettingsChanged?.(value); emit('settings', value); return value; },
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
      checkWritable();
      return lyrics.importFile({trackId, path: result.filePaths[0]});
    },
    'app:openDataFolder': async () => { const error = await shell.openPath(dataDir); if (error) throw new Error(error); return {opened: true}; },
    'app:restoreInfo': () => getRestoreInfo(),
    'app:window': p => { const w = window(); if (p.action === 'minimize') w.minimize(); else if (p.action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize(); else if (p.action === 'close') w.close(); else throw new Error('Invalid window action'); return {ok: true}; }
  };
  for (const [channel, handler] of Object.entries(h)) h[channel] = payload => {
    const allowed = commandAvailability(channel, getRuntimeState());
    if (!allowed.ok) throw new Error(allowed.error);
    return handler(payload);
  };
  Object.defineProperties(h, {closePlaybackContext: {value: () => playbackContext.close()},
    invalidatePlaybackContext: {value: () => playbackContext.invalidate()}});
  return h;
}
async function invokeSafely(handler, payload) {
  try { return {ok: true, value: await handler(record(payload ?? {}))}; }
  catch (error) { return {ok: false, error: error instanceof Error ? error.message : String(error)}; }
}

module.exports = {APPLE_PLAYBACK_MAINTENANCE, record, string, numeric, createHandlers, createLibraryView, invokeSafely, mapPlayer, mapQueue, safeCoverPath, createAppleAdapter, unavailableAppleService, windowSize, validateDiagnosticLayout, registerApplicationSchemes, createLyricsTrackResolver, isTrustedApplicationSender, commandAvailability, validateSafeOwnedExitPayload};
