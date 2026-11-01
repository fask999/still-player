'use strict';

const fs = require('node:fs/promises');
const {constants: FS} = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const LIMITS = Object.freeze({maxConcurrent: 2, maxQueued: 32, maxEntries: 512,
  maxResponseBytes: 1024 * 1024, maxIndexBytes: 2 * 1024 * 1024, timeoutMs: 8000,
  negativeCooldownMs: 24 * 60 * 60 * 1000, failureCooldownMs: 60 * 60 * 1000});
const SAFE_SCHEME = /^still-apple-art:\/\/art\/[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const USER_AGENT = ''; // Missing maintainer contact: native network lookup fails closed.
function normalized(value) {
  return typeof value === 'string' && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase() : '';
}
function metadata(track) {
  if (!track || typeof track !== 'object') return null;
  const artist = normalized(track.albumArtist) || normalized(track.artist), album = normalized(track.album);
  if (!artist || !album) return null;
  return {artist, album, key: createHash('sha256').update(JSON.stringify([artist, album])).digest('hex')};
}
function artworkForRelease(releaseId) {
  return typeof releaseId === 'string' && UUID.test(releaseId)
    ? 'https://coverartarchive.org/release/' + releaseId + '/front-500' : '';
}
function creditedArtist(row) {
  if (!Array.isArray(row['artist-credit']) || !row['artist-credit'].length || row['artist-credit'].length > 16) return '';
  let text = '';
  for (const credit of row['artist-credit']) {
    if (!credit || typeof credit !== 'object') return '';
    const name = credit.name === undefined ? credit.artist?.name : credit.name;
    if (typeof name !== 'string' || name.length > 256 || (credit.joinphrase !== undefined && typeof credit.joinphrase !== 'string')) return '';
    text += name + (credit.joinphrase || '');
  }
  return normalized(text);
}
function selectMatch(json, info) {
  if (json.count > json.releases.length) return {status: 'low-confidence'};
  const matches = new Map(); let uncertain = false;
  for (const row of json.releases) {
    if (normalized(row?.title) !== info.album || creditedArtist(row) !== info.artist) continue;
    if (typeof row.id !== 'string' || !UUID.test(row.id) ||
        (row.disambiguation !== undefined && (typeof row.disambiguation !== 'string' || normalized(row.disambiguation)))) {uncertain = true; continue;}
    const releaseId = row.id;
    matches.set(releaseId, {releaseId, artworkUrl: artworkForRelease(releaseId),
      provider: 'Cover Art Archive', source: 'musicbrainz', sourceUrl: 'https://musicbrainz.org/release/' + releaseId});
  }
  if (matches.size > 1) return {status: 'ambiguous'};
  if (uncertain) return {status: 'low-confidence'};
  return matches.size === 1 ? {status: 'matched', ...matches.values().next().value} : {status: 'no-match'};
}
async function safeDirectory(directory, create = false) {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current).catch(error => {if (error.code !== 'EEXIST') throw error;});
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe metadata cache directory.');
  }
}
async function boundedJson(response, signal) {
  if (!response || response.status !== 200 || response.redirected ||
      !/^(application\/json|text\/javascript)(?:;|$)/i.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length')) > LIMITS.maxResponseBytes) {
    try {await response?.body?.cancel();} catch {}
    throw new Error('Invalid metadata response.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing metadata body.');
  let cancellation;
  const cancel = () => (cancellation ||= (async () => {try {await reader.cancel();} catch {}})());
  signal.addEventListener('abort', cancel, {once: true});
  if (signal.aborted) cancel();
  let length = 0, reads = 0; const chunks = [];
  try {
    while (true) {
      if (signal.aborted) throw new Error('Metadata request cancelled.');
      if (++reads > 8192) throw new Error('Invalid metadata body.');
      const {value, done} = await reader.read();
      if (signal.aborted) throw new Error('Metadata request cancelled.');
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid metadata body.');
      length += value.byteLength;
      if (length > LIMITS.maxResponseBytes) throw new Error('Oversized metadata response.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    // The logical deadline can settle independently, but the physical slot must
    // include a pending read/cancel operation even for an injected bad transport.
    await cancel();
    try {reader.releaseLock();} catch {}
  }
  const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(json.releases) || json.releases.length > 50 || !Number.isSafeInteger(json.count) || json.count < json.releases.length) throw new Error('Invalid metadata results.');
  return json;
}
function createMetadataCoverService({cacheDirectory, artworkUrlFor, fetchImpl = globalThis.fetch, onChange, userAgent = USER_AGENT} = {}) {
  if (!cacheDirectory || typeof artworkUrlFor !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('Metadata cache, artwork registrar and fetch are required.');
  const directory = path.resolve(cacheDirectory), indexFile = path.join(directory, 'index.json');
  const cache = new Map(), queued = new Map(), active = new Set();
  let initialization, ready = false, unavailable = false, closed = false, generation = 0;
  let writes = Promise.resolve(), wakeTimer, lastStart = -Infinity;
  const validUserAgent = typeof userAgent === 'string' && userAgent.length <= 256 && /^[A-Za-z][A-Za-z0-9 ._-]*\/[0-9][A-Za-z0-9._-]* \((?:https:\/\/[^\s()]+|[^\s()@]+@[^\s()@]+\.[^\s()@]+)\)$/.test(userAgent);
  function notify() {
    if (!closed && typeof onChange === 'function') {try {Promise.resolve(onChange()).catch(() => {});} catch {}}
  }
  async function persist() {
    const entries = [...cache].map(([key, value]) => ({key, ...value}));
    while (Buffer.byteLength(JSON.stringify({version: 2, entries})) > LIMITS.maxIndexBytes && entries.length) {
      cache.delete(entries[0].key); entries.shift();
    }
    writes = writes.catch(() => {}).then(async () => {
      await safeDirectory(directory);
      try {const stat = await fs.lstat(indexFile); if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe metadata index.');}
      catch (error) {if (error.code !== 'ENOENT') throw error;}
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | (FS.O_NOFOLLOW || 0), 0o600);
        await handle.writeFile(JSON.stringify({version: 2, entries})); await handle.sync(); await handle.close(); handle = null;
        await safeDirectory(directory); await fs.rename(temporary, indexFile);
      } finally {if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch(() => {});}
    });
    await writes;
  }
  function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      try {
        await safeDirectory(directory, true);
        let stored;
        try {
          const handle = await fs.open(indexFile, FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
          try {
            const stat = await handle.stat(); const linkStat = await fs.lstat(indexFile);
            if (!stat.isFile() || stat.nlink !== 1 || linkStat.isSymbolicLink() || stat.size > LIMITS.maxIndexBytes) throw new Error('Unsafe metadata index.');
            stored = JSON.parse(await handle.readFile('utf8'));
          } finally {await handle.close();}
        } catch (error) {if (error.code !== 'ENOENT') throw error;}
        if (stored && stored.version !== 1) {
          if (stored.version !== 2 || !Array.isArray(stored.entries) || stored.entries.length > LIMITS.maxEntries) throw new Error('Invalid metadata index.');
          for (const row of stored.entries) {
            const info = metadata({artist: row.artist, album: row.album});
            if (!info || info.key !== row.key || !Number.isSafeInteger(row.checkedAt) || row.checkedAt < 0 || row.checkedAt > Date.now() ||
                !['matched', 'no-match', 'ambiguous', 'low-confidence', 'failed'].includes(row.status)) continue;
            if (row.status === 'matched' && (!artworkForRelease(row.releaseId) || row.provider !== 'Cover Art Archive' || row.source !== 'musicbrainz' || row.sourceUrl !== 'https://musicbrainz.org/release/' + row.releaseId)) continue;
            cache.set(info.key, {...info, status: row.status, checkedAt: row.checkedAt,
              ...(row.status === 'matched' ? {artworkUrl: artworkForRelease(row.releaseId), releaseId: row.releaseId,
                sourceUrl: row.sourceUrl, provider: 'Cover Art Archive', source: 'musicbrainz'} : {})});
          }
        }
      } catch {unavailable = true; cache.clear();}
      ready = true;
      if (!closed) {pump(); notify();}
    })();
    return initialization;
  }
  function query(info, controller) {
    if (!validUserAgent) throw new Error('MusicBrainz maintainer contact unavailable.');
    const escapePhrase = value => value.replace(/[\\"]/g, '\\$&');
    const url = new URL('https://musicbrainz.org/ws/2/release/');
    url.search = new URLSearchParams({query: 'release:"' + escapePhrase(info.album) + '" AND artist:"' + escapePhrase(info.artist) + '"', fmt: 'json', limit: '50'}).toString();
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(new Error('Metadata request cancelled.'));
      controller.signal.addEventListener('abort', abortListener, {once: true});
      if (controller.signal.aborted) abortListener();
    });
    const timer = setTimeout(() => controller.abort(), LIMITS.timeoutMs);
    const transport = (async () => {
      const response = await fetchImpl(url.href, {signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', headers: {Accept: 'application/json', 'User-Agent': userAgent}});
      if (controller.signal.aborted) {
        try {await response?.body?.cancel();} catch {}
        throw new Error('Metadata request cancelled.');
      }
      return selectMatch(await boundedJson(response, controller.signal), info);
    })();
    const result = Promise.race([transport, aborted]).finally(() => {
      clearTimeout(timer); controller.signal.removeEventListener('abort', abortListener);
    });
    return {result, transport};
  }
  function pump() {
    if (!ready || closed || unavailable) return;
    clearTimeout(wakeTimer);
    while (active.size < LIMITS.maxConcurrent && queued.size) {
      const now = Date.now();
      if (now - lastStart < 1000) {wakeTimer = setTimeout(pump, Math.max(1, lastStart + 1000 - now)); wakeTimer.unref?.(); break;}
      const [key, info] = queued.entries().next().value; queued.delete(key);
      const controller = new AbortController(), epoch = generation;
      const job = {controller, key, promise: null}; active.add(job); lastStart = now;
      const request = query(info, controller);
      job.promise = (async () => {
        let result;
        try {result = await request.result;} catch {result = {status: 'failed'};}
        if (closed || epoch !== generation) return;
        cache.delete(key); cache.set(key, {...info, ...result, checkedAt: Date.now()});
        while (cache.size > LIMITS.maxEntries) cache.delete(cache.keys().next().value);
        try {await persist();} catch { /* A transient disk failure must not interrupt playback. */ }
        if (!closed && epoch === generation) notify();
      })();
      // Keep a real transport slot until both fetch/body cleanup and logical
      // publication settle. Timeout/close can finish job.promise promptly without
      // permitting an uncooperative fetch to accumulate beyond maxConcurrent.
      void Promise.allSettled([request.transport, job.promise]).then(() => {active.delete(job); pump();});
    }
  }
  function decorateTrack(track) {
    if (!track || typeof track !== 'object' || (typeof track.coverUrl === 'string' && track.coverUrl.trim())) return track;
    // IDs must already belong to indexed metadata. Never inspect audio files to
    // obtain them. Direct CAA registration needs no MusicBrainz API call or UA.
    const suppliedIds = [track.musicbrainzAlbumId, track.musicbrainzReleaseId]
      .filter(value => value !== undefined && value !== null && value !== '');
    if (suppliedIds.length) {
      const decorated = {...track, coverUrl: ''};
      delete decorated.coverMetadataSource;
      if (closed) decorated.coverMetadataStatus = 'closed';
      else if (suppliedIds.some(id => typeof id !== 'string' || !UUID.test(id))) decorated.coverMetadataStatus = 'invalid-release-id';
      else if (new Set(suppliedIds).size !== 1) decorated.coverMetadataStatus = 'ambiguous';
      else {
        const releaseId = suppliedIds[0];
        let local;
        try {local = artworkUrlFor(artworkForRelease(releaseId));} catch {}
        if (typeof local === 'string' && SAFE_SCHEME.test(local)) {
          decorated.coverUrl = local;
          decorated.coverMetadataStatus = 'matched';
          decorated.coverMetadataSource = {provider: 'Cover Art Archive', source: 'musicbrainz',
            releaseId, sourceUrl: `https://musicbrainz.org/release/${releaseId}`};
        } else decorated.coverMetadataStatus = 'artwork-unavailable';
      }
      return decorated;
    }
    const info = metadata(track);
    let status, coverUrl = '', attribution;
    if (!info) status = 'missing-metadata';
    else if (closed) status = 'closed';
    else if (!ready) {status = 'initializing'; void initialize();}
    else if (unavailable) status = 'cache-unavailable';
    else {
      const entry = cache.get(info.key), cooldown = entry?.status === 'failed' ? LIMITS.failureCooldownMs : LIMITS.negativeCooldownMs;
      if (entry && (entry.status === 'matched' || Date.now() - entry.checkedAt < cooldown)) {
        status = entry.status;
        if (status === 'matched') {
          try {const local = artworkUrlFor(entry.artworkUrl); if (typeof local === 'string' && SAFE_SCHEME.test(local)) coverUrl = local;} catch {}
          if (!coverUrl) status = 'failed';
          else attribution = {provider: entry.provider, source: entry.source, releaseId: entry.releaseId, sourceUrl: entry.sourceUrl};
        }
      } else if (!validUserAgent) status = 'source-unavailable';
      else if (queued.has(info.key) || [...active].some(job => job.key === info.key)) status = 'queued';
      else if (queued.size >= LIMITS.maxQueued) status = 'queue-full';
      else {queued.set(info.key, info); status = 'queued'; pump();}
    }
    const decorated = {...track, coverUrl, coverMetadataStatus: status};
    if (attribution) decorated.coverMetadataSource = attribution;
    else delete decorated.coverMetadataSource;
    return decorated;
  }
  function decorateSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.tracks)) return snapshot;
    return {...snapshot, tracks: snapshot.tracks.map(decorateTrack)};
  }
  async function close() {
    if (!closed) {closed = true; generation++; queued.clear(); clearTimeout(wakeTimer); for (const job of active) job.controller.abort();}
    await Promise.allSettled([...active].map(job => job.promise));
    if (initialization) await initialization;
    await writes.catch(() => {});
  }
  return {initialize, decorateSnapshot, decorateTrack, close};
}
module.exports = {createMetadataCoverService, artworkForRelease, LIMITS};
