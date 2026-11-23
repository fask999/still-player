'use strict';

// Read-only context composition. No process, output-device, write or engine
// initialization APIs; transport/session ownership stays with the running app.
const {createHash} = require('node:crypto');
const LIMITS = Object.freeze({maxItems: 500, pageSize: 100, timeoutMs: 2500});
const APPLE_MAX_OFFSET = 1000000;
const TYPES = new Set(['songs', 'library-songs']);
function own(value, key) {if (!value || typeof value !== 'object') return undefined; try {return Object.getOwnPropertyDescriptor(value, key)?.value;} catch {return undefined;}}
const id = value => typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value) ? value : null;
const text = value => typeof value === 'string' ? value.slice(0, 500).replace(/[\u0000-\u001f\u007f]/g, '') : '';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const canonical = value => typeof value === 'string' ? value.replace(/^file:\/\//i, '').replace(/\//g, '\\').toLowerCase() : '';
const location = track => {
  const path = canonical(own(track, 'path')), subsong = integer(own(track, 'subsong'));
  return path && subsong !== null ? JSON.stringify([path, subsong]) : null;
};
const cover = value => typeof value === 'string' && value.length <= 2048 && /^still-(?:cover|apple-art):\/\/art\/[A-Za-z0-9._-]+$/.test(value) ? value : '';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const counter = callback => {try {return integer(callback?.()) ?? 0;} catch {return 0;}};
function createPlaybackContextService({local, apple, getTracks = () => [], decorateTrack, getGeneration, getRevision, ...options} = {}) {
  const limits = {};
  for (const [key, maximum] of Object.entries(LIMITS)) {
    const value = options[key] ?? maximum;
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new TypeError('Invalid playback context limit.');
    limits[key] = value;
  }
  const pending = new Map(); let closed = false;
  function empty(source, status, reason) {return {source, status, contextId: null, generation: counter(getGeneration), revision: counter(getRevision),
    playlist: null, currentIndex: null, items: [], capabilities: {select: false, predictNeighbors: false}, reason};}
  async function readLocal(signal) {
    if (typeof local?.playbackContext !== 'function') return empty('local', 'unavailable', 'backend-unavailable');
    const raw = await local.playbackContext({signal, maxItems: limits.maxItems, pageSize: limits.pageSize});
    if (signal.aborted) return empty('local', 'unknown', 'context-changed');
    if (own(raw, 'status') !== 'ready') return empty('local', own(raw, 'status') === 'unknown' ? 'unknown' : 'unavailable',
      new Set(['backend-unavailable', 'no-active-playlist', 'context-too-large', 'context-changed', 'context-timeout', 'context-read-failed']).has(own(raw, 'reason')) ? own(raw, 'reason') : 'context-read-failed');
    const playlist = own(raw, 'playlist'), playlistId = id(own(playlist, 'id')), items = own(raw, 'items'), currentIndex = integer(own(raw, 'currentIndex'));
    const rawOffset = own(raw, 'offset'), rawTotal = own(raw, 'total');
    const partial = rawOffset !== undefined || rawTotal !== undefined;
    const offset = partial ? integer(rawOffset) : 0, total = integer(rawTotal);
    if (!playlistId || !Array.isArray(items) || items.length > limits.maxItems || offset === null || currentIndex === null ||
        currentIndex < offset || currentIndex - offset >= items.length ||
        (partial && (total === null || total <= limits.maxItems || offset > total - items.length))) {
      return empty('local', 'unknown', 'context-invalid-response');
    }
    const library = await getTracks(), byLocation = new Map();
    if (signal.aborted) return empty('local', 'unknown', 'context-changed');
    if (Array.isArray(library)) for (const track of library) {
      const key = location(track); if (key) byLocation.set(key, byLocation.has(key) ? null : track);
    }
    const refs = [];
    for (let index = 0; index < items.length; index++) {
      const item = own(items, String(index)), key = location(item);
      if (own(item, 'playlistId') !== playlistId || own(item, 'itemIndex') !== offset + index || !key) return empty('local', 'unknown', 'context-invalid-response');
      refs.push(key);
    }
    const contextId = `local:${digest(partial ? [playlistId, offset, total, refs] : [playlistId, refs])}`;
    const token = own(raw, 'selectionToken');
    const selectionToken = !partial && typeof token === 'string' && /^local-select:[0-9a-f]{64}$/.test(token) ? token : null;
    const occurrence = own(raw, 'playbackOccurrence');
    const playbackOccurrence = typeof occurrence === 'string' && /^[0-9a-f]{64}$/.test(occurrence) ? occurrence : null;
    const select = Boolean(selectionToken && typeof local.selectPlaybackContext === 'function' && own(own(raw, 'capabilities'), 'select') === true);
    return {source: 'local', status: 'ready', contextId, generation: counter(getGeneration), revision: counter(getRevision),
      playlist: {id: playlistId, name: text(own(playlist, 'name'))}, currentIndex,
      ...(partial && {offset, total}), ...(playbackOccurrence && {playbackOccurrence}),
      ...(selectionToken && {selectionToken}),
      items: items.map((item, relativeIndex) => {
        const index = offset + relativeIndex;
        const track = byLocation.get(refs[relativeIndex]), decorated = track && typeof decorateTrack === 'function' ? decorateTrack(track) : track;
        const key = partial ? `local-item:${digest([playlistId, index, refs[relativeIndex]])}` : `${contextId}:${index}`;
        return {key, index, trackId: id(own(track, 'id')), title: text(own(item, 'title')), artist: text(own(item, 'artist')), album: text(own(item, 'album')),
          coverUrl: cover(own(decorated, 'coverUrl')), coverThumbnailUrl: cover(own(decorated, 'coverThumbnailUrl')), coverLargeUrl: cover(own(decorated, 'coverLargeUrl')),
          ...(own(decorated, 'cueTrack') === true ? {cueTrack: true} : {}), playable: own(item, 'supported') === true,
          reference: {source: 'local', playlistId, itemIndex: index}};
      }), capabilities: {select, predictNeighbors: !partial && own(raw, 'predictNeighbors') === true}};
  }
  function appleReady() {
    const status = typeof apple?.getStatus === 'function' ? apple.getStatus() : typeof apple?.status === 'function' ? apple.status() : null;
    const phase = own(status, 'lifecyclePhase');
    return own(status, 'pending') !== true && (phase === undefined || phase === 'ready') && own(status, 'available') === true &&
      own(own(status, 'runtime'), 'sessionOpen') === true && own(own(status, 'capabilities'), 'queue') === true;
  }
  async function readApplePage(signal, offset, limit = limits.pageSize) {
    if (signal.aborted || !appleReady()) return null;
    const page = await apple.getQueue({limit, offset});
    if (signal.aborted) return null;
    const rows = own(page, 'items'), total = integer(own(page, 'total')), position = integer(own(page, 'position'));
    if (total !== null && total > limits.maxItems && (position === null || position >= total)) return {reason: 'context-too-large'};
    if (!Array.isArray(rows) || total === null || own(page, 'offset') !== offset || rows.length !== Math.min(limit, total - offset)) return null;
    const items = [];
    for (const row of rows) {
      const type = own(row, 'type'), itemId = id(own(row, 'id'));
      if (!TYPES.has(type) || !itemId) return null;
      items.push({id: itemId, type, title: text(own(row, 'title')), artist: text(own(row, 'artist')), album: text(own(row, 'album')),
        coverUrl: cover(own(row, 'coverUrl')), playable: own(row, 'playable') === true});
    }
    return {items, total, position};
  }
  async function readAppleQueue(signal) {
    const first = await readApplePage(signal, 0);
    if (!first || first.reason) return first;
    const {total, position} = first;
    const partial = total > limits.maxItems;
    const count = Math.min(total, limits.maxItems);
    const offset = partial ? Math.max(0, Math.min(position - Math.floor(count / 2), total - count)) : 0;
    const lastPageOffset = offset + Math.floor((count - 1) / limits.pageSize) * limits.pageSize;
    if (lastPageOffset > APPLE_MAX_OFFSET) return {reason: 'context-too-large'};
    const items = offset === 0 ? first.items.slice(0, count) : [];
    while (items.length < count) {
      const limit = partial ? Math.min(limits.pageSize, count - items.length) : limits.pageSize;
      const page = await readApplePage(signal, offset + items.length, limit);
      if (!page || page.total !== total || page.position !== position) return null;
      items.push(...page.items);
    }
    return {items, position: position !== null && position < total ? position : null, ...(partial && {offset, total})};
  }
  async function readApple(signal) {
    if (typeof apple?.getQueue !== 'function' || !appleReady()) return empty('apple', 'unavailable', 'apple-context-unavailable');
    const first = await readAppleQueue(signal);
    if (first?.reason) return empty('apple', 'unknown', first.reason);
    const second = first && await readAppleQueue(signal);
    if (second?.reason) return empty('apple', 'unknown', second.reason);
    if (signal.aborted) return empty('apple', 'unknown', 'context-changed');
    if (!first || !second || JSON.stringify(first) !== JSON.stringify(second) || !appleReady()) return empty('apple', 'unknown', 'context-changed');
    const partial = first.offset !== undefined;
    const offset = first.offset ?? 0;
    const refs = first.items.map(item => [item.type, item.id]);
    const contextId = `apple:${digest(partial ? [offset, first.total, refs] : refs)}`;
    return {source: 'apple', status: 'ready', contextId, generation: counter(getGeneration), revision: counter(getRevision), playlist: null, currentIndex: first.position,
      ...(partial && {offset, total: first.total}),
      items: first.items.map((item, relativeIndex) => {
        const index = offset + relativeIndex;
        const key = partial ? `apple-item:${digest([index, refs[relativeIndex]])}` : `${contextId}:${index}`;
        return {key, index, trackId: item.id, title: item.title, artist: item.artist, album: item.album,
          coverUrl: item.coverUrl, playable: item.playable, reference: {source: 'apple', kind: item.type, id: item.id, itemIndex: index}};
      }), capabilities: {select: false, predictNeighbors: false}};
  }
  return {
    async read(source) {
      if (source !== 'local' && source !== 'apple') throw new TypeError('Invalid playback context source.');
      if (closed) return empty(source, 'unavailable', 'context-closed');
      for (const [pendingSource, entry] of pending) if (entry.generation !== counter(getGeneration)) {entry.controller.abort(); entry.invalidate(empty(pendingSource, 'unknown', 'context-changed'));}
      if (pending.has(source)) return empty(source, 'unknown', 'context-busy');
      const generation = counter(getGeneration), controller = new AbortController(); let timer;
      const job = Promise.resolve().then(() => controller.signal.aborted ? empty(source, closed ? 'unavailable' : 'unknown', closed ? 'context-closed' : 'context-changed') :
        source === 'local' ? readLocal(controller.signal) : readApple(controller.signal));
      let invalidate;
      const invalidated = new Promise(resolve => {invalidate = resolve;});
      const entry = {job, generation, controller, invalidate}; pending.set(source, entry);
      job.finally(() => {if (pending.get(source) === entry) pending.delete(source);}).catch(() => {});
      try {
        const result = await Promise.race([job, invalidated, new Promise(resolve => {timer = setTimeout(() => {controller.abort(); resolve(empty(source, 'unknown', 'context-timeout'));}, limits.timeoutMs);})]);
        return generation === counter(getGeneration) ? result : empty(source, 'unknown', 'context-changed');
      } catch {return empty(source, 'unavailable', 'context-read-failed');}
      finally {clearTimeout(timer);}
    },
    invalidate() {for (const [source, entry] of pending) {entry.controller.abort(); entry.invalidate(empty(source, 'unknown', 'context-changed'));}},
    close() {closed = true; for (const [source, entry] of pending) {entry.controller.abort(); entry.invalidate(empty(source, 'unavailable', 'context-closed'));}}
  };
}
module.exports = {createPlaybackContextService, LIMITS};
