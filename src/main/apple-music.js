'use strict';

// Cider's documented v2 LOCAL API is the streaming engine. STILL neither
// obtains Apple credentials nor decodes Apple Music protected media.
const http = require('node:http');
const {createCiderCredentials} = require('./apple-credentials');

const SCOPES = Object.freeze(['playback', 'queue', 'library', 'audio']);
const PLAYABLE = Object.freeze(['songs', 'library-songs', 'albums', 'playlists', 'library-albums', 'library-playlists']);
const TYPES = new Set([...PLAYABLE, 'artists', 'library-artists']);
const ID = /^[A-Za-z0-9._-]{1,200}$/;
const SAFE_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const messages = {
  'cider-offline': '未连接 Cider。请先安装并运行 Cider，在其中登录 Apple Music，并启用其本机 API。',
  'cider-not-paired': '请连接 Cider，并在 Cider 的提示中批准 STILL。无需为此注册 Apple Developer。',
  'cider-unauthorized': 'Cider 未接受本机应用配对，请在 Cider 中重新批准 STILL。',
  'cider-scope-missing': 'Cider 未授予此操作所需权限，请重新连接并选择播放、队列、曲库和音量权限。',
  'cider-api-unsupported': '此 Cider 版本未提供所需的 v2 API。请使用支持当前官方 API 的版本。',
  'cider-timeout': 'Cider 未及时确认操作。请先检查 Cider 的实际状态，再手动重试。',
  'cider-invalid-response': 'Cider 返回了无法核验的数据，未把操作标记为成功。',
  'cider-auth-denied': 'Cider 连接未获用户批准。',
  'cider-auth-busy': 'Cider 已有待处理的连接确认，请先完成或关闭它。',
  'cider-rate-limited': 'Cider 暂时限制了请求，请等待后再手动重试。',
  'cider-apple-unavailable': 'Cider 未取得 Apple Music 数据。请在 Cider 中确认账号、订阅及歌曲可用性。',
  'cider-operation-failed': 'Cider 未确认此操作，未把它标记为成功。',
  'cider-track-unconfirmed': 'Cider 未确认已开始播放所选内容，请检查其实际状态。',
  'cider-stop-unconfirmed': 'Cider 尚未确认停止，未允许另一播放引擎开始。',
  'cider-release-unverified': 'Cider 已报告停止，但尚未取得独立音频输出释放证据；请退出 Cider 后再试。',
  'closed': 'Apple Music 服务已关闭。',
};
function fail(code, message) { return Object.assign(new Error(message || messages[code] || messages['cider-operation-failed']), {code, ciderError: true}); }
function cancelled() { return Object.assign(new Error('播放请求已被较新的播放或控制操作取消。'), {code: 'STILL_CANCELLED', ciderError: true}); }
function cleanError(error) { return error?.ciderError || error?.appleCredentialError ? error : fail('cider-operation-failed'); }
function text(value, maximum = 500) { return typeof value === 'string' ? value.slice(0, maximum).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') : ''; }
function validId(value) { if (typeof value !== 'string' || !ID.test(value)) throw fail('invalid-id', 'Apple Music 内容 ID 无效。'); return value; }
function integer(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) throw fail('invalid-input', `${label}超出有效范围。`); return value; }
function number(value, min, max, label) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail('invalid-input', `${label}超出有效范围。`); return value; }
function image(value) { return typeof value === 'string' && value.length <= 1024 * 1024 && SAFE_IMAGE.test(value) ? value : ''; }
function itemIds(value) {
  const attributes = value?.attributes || value || {}, params = attributes.playParams || value?.playParams || {};
  return [...new Set([value?.id, attributes.id, params.id, params.catalogId, params.libraryId, value?.catalogId].filter(id => typeof id === 'string' && ID.test(id)))];
}
function normalizeItem(raw, fallbackType = 'songs') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const attributes = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : raw;
  const params = attributes.playParams || raw.playParams || {};
  const id = text(raw.id || params.id, 200), type = TYPES.has(raw.type) ? raw.type : fallbackType;
  if (!ID.test(id) || !TYPES.has(type)) return null;
  const milliseconds = attributes.durationInMillis ?? attributes.durationMs ?? raw.durationMs;
  const duration = Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1000 : null;
  const suppliedArt = typeof attributes.artwork === 'string' ? attributes.artwork : attributes.artwork?.url;
  return {id, type, source: 'apple', title: text(attributes.name || attributes.title) || '未命名',
    artist: text(attributes.artistName || attributes.artist), album: text(attributes.albumName || attributes.album), duration,
    coverUrl: image(suppliedArt),
    playable: PLAYABLE.includes(type) && attributes.playable !== false && raw.playable !== false,
    ...(ID.test(String(params.catalogId || raw.catalogId || '')) ? {catalogId: String(params.catalogId || raw.catalogId)} : {})};
}
function normalizePlayback(data) {
  if (!data || !['playing', 'paused', 'stopped'].includes(data.state)) throw fail('cider-invalid-response');
  const current = data.nowPlaying && typeof data.nowPlaying === 'object' ? data.nowPlaying : null;
  const ids = itemIds(current), params = current?.playParams || current?.attributes?.playParams || {};
  const type = TYPES.has(params.kind) ? params.kind : params.kind === 'song' ? 'songs' : 'songs';
  const track = current ? normalizeItem({...current, id: ids[0], type}, type) : null;
  const position = data.time?.currentTime;
  const duration = data.time?.duration;
  return {available: true, source: 'apple', provider: 'cider', state: data.state,
    position: Number.isFinite(position) && position >= 0 ? position : 0,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : track?.duration || 0,
    volume: Number.isFinite(data.volume) && data.volume >= 0 && data.volume <= 1 ? data.volume : null,
    currentTrackId: track?.id || null, currentTrack: track,
    repeatMode: ['none', 'one', 'all'].includes(data.repeatMode) ? data.repeatMode : null,
    shuffle: typeof data.shuffleMode === 'boolean' ? data.shuffleMode : null,
    audio: {engine: 'Cider', output: '由 Cider 管理', exclusive: null, actualDacRate: null},
    // Internal IDs are stripped from getState's public result below.
    _ids: ids, _hasCurrent: !!current && Object.keys(current).length > 0};
}

function createLocalTransport({baseUrl = 'http://127.0.0.1:10767', timeout = 6000} = {}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw fail('invalid-endpoint', 'Cider 端点必须是本机回环地址。'); }
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || !base.port || !['', '/'].includes(base.pathname) || base.search || base.hash) throw fail('invalid-endpoint', '仅允许直接连接本机 127.0.0.1 Cider API。');
  return function request(method, endpoint, {token, body, signal, auth = false} = {}) {
    if (!endpoint.startsWith('/api/v2/') || /(?:^|\/)tokens(?:[/?]|$)/i.test(endpoint) || /(?:^|\/)account(?:[/?]|$)/i.test(endpoint)) return Promise.reject(fail('forbidden-endpoint', '本程序不访问 Apple 凭据端点。'));
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      let completed = false;
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const options = {protocol: 'http:', hostname: '127.0.0.1', port: Number(base.port), path: endpoint, method,
        headers: {'Accept': 'application/json', ...(token ? {apptoken: token} : {}), ...(payload ? {'Content-Type': 'application/json', 'Content-Length': payload.length} : {})}};
      function done(error, value) {
        if (completed) return; completed = true; signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(value);
      }
      const req = http.request(options, response => {
        let length = 0; const chunks = [];
        response.on('data', chunk => {
          length += chunk.length;
          if (length > (auth ? 65536 : 4 * 1024 * 1024)) { req.destroy(); done(fail('cider-invalid-response')); }
          else chunks.push(chunk);
        });
        response.on('error', () => done(fail('cider-offline')));
        response.on('end', () => {
          if (completed) return;
          let json;
          try {json = length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};}
          catch {return done(fail('cider-invalid-response'));}
          const serverCode = typeof json.error === 'string' ? json.error : json.error?.code;
          if (response.statusCode < 200 || response.statusCode >= 300 || serverCode) {
            const code = serverCode === 'INSUFFICIENT_SCOPE' ? 'cider-scope-missing' :
              serverCode === 'AUTH_REQUEST_DENIED' ? 'cider-auth-denied' :
              serverCode === 'AUTH_REQUEST_BUSY' ? 'cider-auth-busy' :
              response.statusCode === 429 ? 'cider-rate-limited' :
              serverCode === 'AMAPI_ERROR' ? 'cider-apple-unavailable' :
              response.statusCode === 401 || response.statusCode === 403 ? 'cider-unauthorized' :
              response.statusCode === 404 || response.statusCode === 405 ? 'cider-api-unsupported' :
              response.statusCode === 408 || response.statusCode === 504 ? 'cider-timeout' : 'cider-operation-failed';
            return done(Object.assign(fail(code), {httpStatus: response.statusCode}));
          }
          done(null, json);
        });
      });
      const onAbort = () => {req.destroy(); done(cancelled());};
      signal?.addEventListener('abort', onAbort, {once: true});
      req.setTimeout(auth ? 125000 : timeout, () => {req.destroy(); done(fail('cider-timeout'));});
      req.on('error', () => done(fail('cider-offline')));
      if (payload) req.write(payload);
      req.end();
    });
  };
}

function createCiderMusicService({dataDir, safeStorage, emit = () => {}, baseUrl, timeout,
  verifyOutputReleased, credentials: suppliedCredentials, request: suppliedRequest,
  verificationTimeout = 10000, pollInterval = 200} = {}) {
  if (typeof dataDir !== 'string') throw new Error('Apple Music dataDir is required');
  const credentials = suppliedCredentials || createCiderCredentials({dataDir, safeStorage});
  const request = suppliedRequest || createLocalTransport({baseUrl, timeout});
  let online = false, version = null, apiReady = false, pairing = false, closed = false;
  let issue = null, verifiedPlayback = false, generation = 0, connectionEpoch = 0;
  let writeTail = Promise.resolve(), pairController = null;
  let readSequence = 0, publishedRead = 0;
  let lastSnapshot = null, lastProbe = 0;
  const activeReadControllers = new Set();
  const knownItems = new Map();
  function getStatus() {
    const stored = credentials.status(), scopes = stored.credentials?.scopes || [];
    const capable = scope => stored.configured && online && apiReady && scopes.includes(scope) && !closed;
    const reasonCodes = closed ? ['closed'] : pairing ? ['cider-pairing-pending'] :
      issue ? [issue] : !stored.configured ? stored.reasonCodes : !online ? ['cider-offline'] : !apiReady ? ['cider-api-unverified'] : verifiedPlayback ? [] : ['apple-subscription-playback-unverified'];
    const message = closed ? messages.closed : pairing ? '请在 Cider 的本机应用确认框中批准 STILL。' : issue ? messages[issue] || messages['cider-operation-failed'] :
      !stored.configured ? (online ? messages['cider-not-paired'] : messages['cider-offline']) : !online ? messages['cider-offline'] :
        !apiReady ? '已保存 Cider 配对，当前 v2 API 能力尚未确认。' :
          verifiedPlayback ? 'Cider 已回读所选内容的播放状态；音频和订阅服务由 Cider 管理。' : '已连接 Cider，可请求曲库与播放；Apple Music 订阅全曲仍需实际播放验证。';
    return {id: 'apple', name: 'Apple Music', provider: 'cider', available: capable('playback'), configured: stored.configured,
      status: closed ? 'unavailable' : pairing ? 'connecting' : !stored.configured ? (online ? 'authorization-required' : 'not-connected') : !online || issue ? 'unavailable' : !apiReady ? 'configured' : verifiedPlayback ? 'ready' : 'paired-unverified',
      message, reasonCodes, credentials: stored.credentials, encryptionAvailable: stored.encryptionAvailable,
      runtime: {provider: 'cider', available: online, version, api: 'v2', apiVerified: apiReady},
      verification: {selectedPlaybackReadback: verifiedPlayback, subscriptionFullSong: false, actualDacRate: null},
      capabilities: {configure: false, configureKey: false, importToken: false, pairing: !closed && stored.encryptionAvailable && !pairing,
        authorize: !closed && stored.encryptionAvailable && !pairing, library: capable('library'), search: capable('library'),
        playback: capable('playback'), queue: capable('queue'), volume: capable('audio'),
        queueActions: capable('queue') ? ['jump', 'add-next', 'add-later', 'move', 'remove', 'clear'] : [],
        playableTypes: capable('playback') ? [...PLAYABLE] : []}};
  }
  function publish() {const status = getStatus(); emit('source', status); return status;}
  function assertOpen() {if (closed) throw fail('closed');}
  function requireScope(scope) {
    assertOpen();
    const stored = credentials.status();
    if (!stored.configured) throw fail('cider-not-paired');
    if (!stored.credentials.scopes.includes(scope)) throw fail('cider-scope-missing');
    return credentials.getToken();
  }
  function operation(context) {return {generation, context};}
  function check(op) {assertOpen(); if (op.generation !== generation || op.context?.signal?.aborted) throw cancelled(); op.context?.check?.();}
  function updateFailure(error) {
    const safe = cleanError(error);
    if (safe.code === 'STILL_CANCELLED') return safe;
    issue = safe.code;
    if (['cider-offline', 'cider-timeout'].includes(safe.code)) {online = false; apiReady = false;}
    if (safe.code === 'cider-unauthorized') apiReady = false;
    publish(); return safe;
  }
  function api(method, endpoint, options = {}) {return request(method, endpoint, options).catch(error => {throw cleanError(error);});}
  function read(endpoint, scope, op) {
    const token = requireScope(scope), epoch = connectionEpoch;
    if (op) check(op);
    const controller = new AbortController(); activeReadControllers.add(controller);
    const abort = () => controller.abort();
    op?.context?.signal?.addEventListener('abort', abort, {once: true});
    return api('GET', endpoint, {token, signal: controller.signal}).then(result => {
      if (epoch !== connectionEpoch) throw cancelled(); if (op) check(op); return result;
    }).finally(() => {activeReadControllers.delete(controller); op?.context?.signal?.removeEventListener('abort', abort);});
  }
  function write(method, endpoint, body, scope, op) {
    const token = requireScope(scope), epoch = connectionEpoch;
    const result = writeTail.then(async () => {
      if (op) check(op); else assertOpen();
      if (epoch !== connectionEpoch) throw cancelled();
      // Once sent, do not abort a mutation: a timeout/abort cannot undo a server
      // commit. cancelPending's barrier waits for this bounded transport call.
      return api(method, endpoint, {token, body});
    });
    writeTail = result.catch(() => {}); return result;
  }
  function remember(items) {
    for (const item of items) {knownItems.delete(`${item.type}:${item.id}`); knownItems.set(`${item.type}:${item.id}`, item);}
    while (knownItems.size > 10000) knownItems.delete(knownItems.keys().next().value);
  }
  function publicState(state) {const {_ids, _hasCurrent, ...value} = state; return value;}
  async function snapshot(op) {
    const sequence = ++readSequence, epoch = connectionEpoch;
    const response = await read('/api/v2/playback', 'playback', op);
    const state = normalizePlayback(response.data);
    if (epoch !== connectionEpoch) throw cancelled();
    if (sequence >= publishedRead) {publishedRead = sequence; lastSnapshot = state; online = true; issue = null;}
    return state;
  }
  async function verifyConnection() {
    const stored = credentials.status(), epoch = connectionEpoch;
    lastProbe = Date.now();
    try {
      const response = await api('GET', '/api/v2/client/info', {token: stored.configured ? credentials.getToken() : undefined});
      if (epoch !== connectionEpoch || closed) return getStatus();
      if (typeof response.data?.version !== 'string') throw fail('cider-invalid-response');
      online = true; version = text(response.data.version, 80); issue = null;
      if (stored.configured && stored.credentials.scopes.includes('playback')) {await snapshot(); if (epoch === connectionEpoch) apiReady = true;}
      else apiReady = false;
    } catch (error) {
      if (epoch !== connectionEpoch || closed) return getStatus();
      const safe = cleanError(error);
      // A documented auth failure proves that the local Cider API answered,
      // but does not prove pairing, subscription, library or playback access.
      online = safe.code === 'cider-unauthorized'; apiReady = false;
      issue = !stored.configured && online ? null : safe.code;
    }
    return publish();
  }
  async function waitFor(predicate, op, code) {
    const until = Date.now() + verificationTimeout;
    do {
      if (op) check(op);
      const state = await snapshot(op);
      if (await predicate(state)) return state;
      if (Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } while (Date.now() <= until);
    throw fail(code);
  }
  function selectInput(input = {}) {
    const kind = input.kind || input.type || 'songs';
    if (!PLAYABLE.includes(kind)) throw fail('unsupported-item', '此 Apple Music 内容类型暂不能直接播放。');
    if (input.ids !== undefined && (!Array.isArray(input.ids) || input.ids.length !== 1)) throw fail('unsupported-queue', '当前 Cider 接口只接受一次明确选择的歌曲或集合，未创建多曲队列。');
    const id = validId(input.id ?? input.ids?.[0]);
    if (input.ids && input.id !== undefined && input.ids[0] !== input.id) throw fail('invalid-input', 'Apple Music 曲目 ID 不一致。');
    const known = knownItems.get(`${kind}:${id}`);
    if (known?.playable === false) throw fail('unsupported-item', '此条目未提供可用的播放信息。');
    return {id, kind, expectedIds: new Set([id, known?.catalogId].filter(Boolean))};
  }
  async function getQueueInternal({offset = 0, limit = 50} = {}, op) {
    integer(offset, 0, 1000000, '队列偏移'); integer(limit, 1, 200, '队列页数');
    const response = await read(`/api/v2/queue?offset=${offset}&limit=${limit}`, 'queue', op);
    if (!Array.isArray(response.data?.items)) throw fail('cider-invalid-response');
    const rows = response.data.items;
    const items = rows.map((row, index) => {
      const item = normalizeItem(row.track || row, 'songs');
      if (!item) return null;
      const context = row.containerContext;
      return {...item, index: offset + index, ...(context && ID.test(context.id) ? {containerContext: {id: context.id, type: text(context.type, 60)}} : {})};
    }).filter(Boolean);
    if (items.length !== rows.length) throw fail('cider-invalid-response');
    remember(items);
    const total = Number.isSafeInteger(response.meta?.total) ? response.meta.total : null;
    const position = response.data.position ?? response.data.currentIndex;
    return {items, offset, limit, total, position: Number.isSafeInteger(position) ? position : null,
      hasMore: total !== null ? offset + rows.length < total : rows.length === limit};
  }
  async function verifySelection(selection, op) {
    const song = selection.kind.endsWith('songs');
    return waitFor(async state => {
      if (state.state !== 'playing') return false;
      if (song) return state._ids.some(id => selection.expectedIds.has(id));
      const queue = await getQueueInternal({offset: 0, limit: 1}, op);
      const selected = queue.position === null || queue.position === 0 ? queue : await getQueueInternal({offset: queue.position, limit: 1}, op);
      const current = selected.position === null ? null : selected.items.find(item => item.index === selected.position);
      return !!current?.containerContext && current.containerContext.id === selection.id;
    }, op, 'cider-track-unconfirmed');
  }
  async function command(endpoint, body, scope, predicate, context, method = 'POST') {
    const op = operation(context);
    try {
      await write(method, `/api/v2/${endpoint}`, body, scope, op); check(op);
      const state = await waitFor(predicate, op, 'cider-operation-failed'); check(op);
      return publicState(state);
    } catch (error) {throw updateFailure(error);}
  }
  async function allQueue(op) {
    const items = []; let position = null, expectedTotal = null;
    for (let offset = 0; offset < 10000;) {
      const page = await getQueueInternal({offset, limit: 200}, op);
      if (expectedTotal !== null && page.total !== expectedTotal || position !== null && page.position !== position) throw fail('cider-queue-changed', 'Cider 队列在读取时发生变化，请刷新后重试。');
      expectedTotal = page.total; position = page.position;
      items.push(...page.items); offset += page.items.length;
      if (!page.hasMore) return {items, position, total: page.total ?? items.length};
      if (!page.items.length) throw fail('cider-invalid-response');
    }
    throw fail('queue-too-large', '队列超过当前安全编辑上限，未修改 Cider 队列。');
  }
  const queueKeys = queue => queue.items.map(item => `${item.type}:${item.id}`);
  const sameKeys = (left, right) => left.length === right.length && left.every((key, index) => key === right[index]);
  async function navigate(direction, context) {
    const op = operation(context);
    try {
      const before = await snapshot(op); check(op);
      await write('POST', `/api/v2/playback/${direction}`, {}, 'playback', op); check(op);
      const state = await waitFor(next => next.state === 'stopped' && !next._hasCurrent ||
        next._ids.some(id => !before._ids.includes(id)) || direction === 'previous' && before.position > 3 && next.position < 1.5, op, 'cider-track-unconfirmed');
      return publicState(state);
    } catch (error) {throw updateFailure(error);}
  }
  const service = {
    async initialize() {await credentials.initialize(); return verifyConnection();},
    status: getStatus, getStatus,
    refresh: verifyConnection,
    async authorize() {
      assertOpen();
      if (pairing) throw fail('cider-auth-busy');
      if (!credentials.status().encryptionAvailable) throw fail('secure-storage-unavailable', 'Windows 安全存储不可用，无法安全保存 Cider 配对。');
      pairing = true; issue = null; pairController = new AbortController(); publish();
      try {
        const response = await api('POST', '/api/v2/auth/request', {auth: true, signal: pairController.signal,
          body: {app_name: 'STILL · 静室', scopes: [...SCOPES]}});
        assertOpen();
        await credentials.save({token: response.data?.token, scopes: response.data?.scopes});
        connectionEpoch++; service.cancelPending(); knownItems.clear(); verifiedPlayback = false;
        return await verifyConnection();
      } catch (error) {throw updateFailure(error);}
      finally {pairing = false; pairController = null; publish();}
    },
    async disconnect() {
      service.cancelPending(); await writeTail; pairController?.abort();
      connectionEpoch++; await credentials.clear(); apiReady = false; lastSnapshot = null; verifiedPlayback = false; knownItems.clear(); issue = null;
      return publish();
    },
    async library({kind = 'songs', id, limit = 50, offset = 0} = {}) {
      integer(limit, 1, 100, '曲库页数'); integer(offset, 0, 1000000, '曲库偏移');
      let endpoint, type;
      if (['songs', 'albums', 'artists', 'playlists'].includes(kind)) {endpoint = `/api/v2/library/${kind}`; type = `library-${kind}`;}
      else if (['album-songs', 'playlist-songs'].includes(kind)) {endpoint = `/api/v2/library/${kind === 'album-songs' ? 'albums' : 'playlists'}/${validId(id)}/songs`; type = 'library-songs';}
      else throw fail('invalid-input', '不支持此 Apple Music 曲库分类。');
      try {
        const response = await read(`${endpoint}?offset=${offset}&limit=${limit}`, 'library');
        if (!Array.isArray(response.data?.items)) throw fail('cider-invalid-response');
        const items = response.data.items.map(row => normalizeItem(row, type)).filter(Boolean); remember(items);
        const total = Number.isSafeInteger(response.meta?.total) ? response.meta.total : null;
        const hasMore = total !== null ? offset + response.data.items.length < total : response.data.items.length === limit;
        return {kind, items, offset, limit, total, hasMore, ...(hasMore ? {nextOffset: offset + response.data.items.length} : {})};
      } catch (error) {throw updateFailure(error);}
    },
    async search({term, types = ['songs'], limit = 25, offset = 0} = {}) {
      if (typeof term !== 'string' || !term.trim() || term.length > 200) throw fail('invalid-input', '请输入 1 至 200 字的搜索内容。');
      if (typeof types === 'string') types = types.split(',');
      if (!Array.isArray(types) || !types.length || types.some(type => !['songs', 'albums', 'artists', 'playlists'].includes(type))) throw fail('invalid-input', '搜索分类无效。');
      types = [...new Set(types)]; integer(limit, 1, 25, '搜索页数'); integer(offset, 0, 1000000, '搜索偏移');
      const query = new URLSearchParams({term: term.trim(), types: types.join(','), limit: String(limit), offset: String(offset)});
      try {
        const response = await read(`/api/v2/amapi/search?${query}`, 'library');
        if (!response.data?.results || typeof response.data.results !== 'object') throw fail('cider-invalid-response');
        const groups = types.map(type => {
          const group = response.data.results[type];
          if (group !== undefined && !Array.isArray(group.data)) throw fail('cider-invalid-response');
          const items = (group?.data || []).map(row => normalizeItem(row, type)).filter(Boolean);
          return {type, items, hasMore: typeof group?.next === 'string' && group.next.length > 0};
        });
        const items = groups.flatMap(group => group.items); remember(items);
        const hasMore = groups.some(group => group.hasMore);
        return {kind: types.length === 1 ? types[0] : 'search', term: term.trim(), items, groups, offset, limit, hasMore, ...(hasMore ? {nextOffset: offset + limit} : {})};
      } catch (error) {throw updateFailure(error);}
    },
    getQueue: getQueueInternal,
    async queue(input = {}, context) {
      const op = operation(context), action = input.action;
      if (!['jump', 'add-next', 'add-later', 'move', 'remove', 'clear'].includes(action)) throw fail('invalid-input', '不支持此 Cider 队列操作。');
      try {
        const before = await allQueue(op), beforeKeys = queueKeys(before); check(op);
        let method = 'POST', endpoint = `/api/v2/queue/${action}`, body = {}, expectedKeys = [...beforeKeys], selection;
        if (['jump', 'remove'].includes(action)) {
          integer(input.index, 0, before.items.length - 1, '队列位置');
          if (action === 'jump') body = {index: input.index};
          else {method = 'DELETE'; endpoint = `/api/v2/queue/items/${input.index}`; body = undefined; expectedKeys.splice(input.index, 1);}
        } else if (action === 'move') {
          integer(input.from, 0, before.items.length - 1, '源队列位置'); integer(input.to, 0, before.items.length - 1, '目标队列位置');
          body = {from: input.from, to: input.to}; const [moved] = expectedKeys.splice(input.from, 1); expectedKeys.splice(input.to, 0, moved);
        } else if (action === 'clear') {method = 'DELETE'; endpoint = '/api/v2/queue'; body = undefined; expectedKeys = [];}
        else {
          selection = selectInput(input);
          if (!selection.kind.endsWith('songs')) throw fail('unsupported-queue', '当前只支持向 Cider 队列加入一首明确选择的歌曲。');
          body = {type: selection.kind, id: selection.id};
        }
        // Check again after preparation and immediately before the write enters
        // the serialized transport lane. Never retry uncertain queue mutations.
        check(op); await write(method, endpoint, body, 'queue', op); check(op);
        const until = Date.now() + verificationTimeout;
        do {
          const after = await allQueue(op); check(op);
          if (action === 'jump') {
            const state = await snapshot(op);
            if (after.position === input.index && state.state === 'playing' && state._ids.some(id => itemIds(before.items[input.index]).includes(id))) return after;
          } else if (selection) {
            const insertion = action === 'add-next' ? Math.max(0, (before.position ?? -1) + 1) : before.items.length;
            const actual = after.items[insertion];
            const keys = queueKeys(after); const withoutInserted = keys.filter((_key, index) => index !== insertion);
            if (actual && selection.expectedIds.has(actual.id) && sameKeys(withoutInserted, beforeKeys)) return after;
          } else if (sameKeys(queueKeys(after), expectedKeys)) return after;
          if (Date.now() >= until) break;
          await new Promise(resolve => setTimeout(resolve, pollInterval)); check(op);
        } while (Date.now() <= until);
        throw fail('cider-queue-unconfirmed', 'Cider 队列修改未通过实际回读确认，请刷新队列后检查；不会自动重试。');
      } catch (error) {throw updateFailure(error);}
    },
    async play(input, context) {
      const selection = selectInput(input), op = operation(context);
      try {
        check(op);
        const song = selection.kind.endsWith('songs');
        await write('POST', song ? '/api/v2/playback/play-item' : '/api/v2/playback/play-collection',
          {type: selection.kind, id: selection.id, ...(song ? {} : {shuffle: false})}, 'playback', op);
        check(op);
        const state = await verifySelection(selection, op); check(op);
        verifiedPlayback = true; apiReady = true; issue = null; publish(); return publicState(state);
      } catch (error) {throw updateFailure(error);}
    },
    pause: context => command('playback/pause', {}, 'playback', state => state.state !== 'playing', context),
    resume: context => command('playback/play', {}, 'playback', state => state.state === 'playing', context),
    seek(seconds, context) {number(seconds, 0, 86400, '播放位置'); return command('playback/seek', {position: seconds}, 'playback', state => Math.abs(state.position - seconds) <= 1.5, context);},
    setVolume(volume, context) {number(volume, 0, 1, '音量'); return command('audio/volume', {volume}, 'audio', state => state.volume !== null && Math.abs(state.volume - volume) <= 0.011, context, 'PATCH');},
    next: context => navigate('next', context),
    previous: context => navigate('previous', context),
    async stop(context) {
      service.cancelPending(); const op = operation(context);
      try {
        await write('POST', '/api/v2/playback/stop', {}, 'playback', op); check(op);
        return publicState(await waitFor(state => state.state === 'stopped' && !state._hasCurrent, op, 'cider-stop-unconfirmed'));
      } catch (error) {throw updateFailure(error);}
    },
    cancelPending() {
      generation++;
      for (const controller of activeReadControllers) controller.abort();
      return writeTail;
    },
    async releaseOutput() {
      const barrier = service.cancelPending(), op = operation(); await barrier;
      try {
        check(op);
        await write('POST', '/api/v2/playback/stop', {}, 'playback', op); check(op);
        await waitFor(state => state.state === 'stopped' && !state._hasCurrent, op, 'cider-stop-unconfirmed');
        const first = await snapshot(op);
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        check(op); const second = await snapshot(op); check(op);
        if ([first, second].some(state => state.state !== 'stopped' || state._hasCurrent)) return {released: false, evidence: {provider: 'cider', reason: 'stop-readback-not-stable'}};
        if (typeof verifyOutputReleased !== 'function') return {released: false, evidence: {provider: 'cider', reason: 'independent-output-release-unverified', stoppedReadbacks: 2}};
        const independent = await verifyOutputReleased({provider: 'cider'});
        check(op);
        return {released: independent?.released === true, evidence: {provider: 'cider', stoppedReadbacks: 2,
          independent: independent?.evidence || null, actualDacRate: null}};
      } catch (error) {const safe = cleanError(error); return {released: false, evidence: {provider: 'cider', reason: safe.code || 'cider-stop-unconfirmed'}};}
    },
    async getState() {
      if (closed) return {available: false, source: 'apple', provider: 'cider', state: 'unavailable', position: 0, duration: 0, volume: null, error: messages.closed};
      if (!credentials.status().configured) {
        if (Date.now() - lastProbe > 5000) await verifyConnection();
        return {available: false, source: 'apple', provider: 'cider', state: 'unavailable', position: 0, duration: 0, volume: null, error: getStatus().message};
      }
      const sequence = ++readSequence;
      try {
        const state = await snapshot();
        if (!apiReady && Date.now() - lastProbe > 5000) await verifyConnection();
        return publicState(state);
      } catch (error) {
        const safe = cleanError(error);
        if (sequence >= publishedRead && safe.code !== 'STILL_CANCELLED') updateFailure(safe);
        return {available: false, source: 'apple', provider: 'cider', state: 'unavailable', position: 0, duration: 0, volume: null, error: safe.message};
      }
    },
    async close() {
      if (closed) return;
      service.cancelPending(); pairController?.abort(); closed = true; connectionEpoch++;
      await writeTail; await credentials.close();
      knownItems.clear(); lastSnapshot = null;
    }
  };
  return service;
}

// Optional Cider integration is retained for research. The default route is the
// user's genuine official web session and never probes Cider or requires a key.
const {createOfficialAppleMusicService} = require('./apple-official-web');
module.exports = {createAppleMusicService: createOfficialAppleMusicService, createOfficialAppleMusicService,
  createCiderMusicService, createLocalTransport, normalizeItem, normalizePlayback, SCOPES, PLAYABLE};
