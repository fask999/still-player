'use strict';

const fs = require('node:fs/promises');
const {constants: FS} = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {createBoundedSerialFetch} = require('./bounded-serial-fetch');
const LIMITS = Object.freeze({maxConcurrent: 2, maxQueued: 32, maxEntries: 512, maxNotificationBatch: 256,
  maxResponseBytes: 1024 * 1024, maxIndexBytes: 2 * 1024 * 1024, timeoutMs: 8000,
  negativeCooldownMs: 24 * 60 * 60 * 1000, failureCooldownMs: 60 * 60 * 1000});
const SAFE_SCHEME = /^still-apple-art:\/\/art\/[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function normalizeMusicBrainzContact(value) {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u0020\u007f-\u009f()<>"\\]/u.test(value.trim()) ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return '';
  const contact = value.trim();
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(contact)) return contact;
  try {
    const url = new URL(contact);
    if (!/^https:\/\//i.test(contact) || url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
        /[^\x21-\x7e]/u.test(contact) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(contact)) return '';
    return contact;
  } catch {return '';}
}
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
async function boundedJson(response, context) {
  if (!response || response.status !== 200 || response.redirected ||
      !/^(application\/json|text\/javascript)(?:;|$)/i.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length')) > LIMITS.maxResponseBytes) {
    await context.cancelBody(response);
    throw new Error('Invalid metadata response.');
  }
  const bytes = await context.readBody(response, {maxBytes: LIMITS.maxResponseBytes, maxReads: 8192});
  context.guard();
  const json = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(json.releases) || json.releases.length > 50 || !Number.isSafeInteger(json.count) || json.count < json.releases.length) throw new Error('Invalid metadata results.');
  return json;
}
function createMetadataCoverService({cacheDirectory, artworkUrlFor, fetchImpl = globalThis.fetch, onChange, contact, userAgent, clock} = {}) {
  if (!cacheDirectory || typeof artworkUrlFor !== 'function' || typeof fetchImpl !== 'function') throw new TypeError('Metadata cache, artwork registrar and fetch are required.');
  const directory = path.resolve(cacheDirectory), indexFile = path.join(directory, 'index.json');
  const cache = new Map(), jobs = new Map(), trackKeys = new Map(), keyTracks = new Map(), trackStatuses = new Map();
  const pendingIds = new Set(), fullKeys = new Set();
  const transport = createBoundedSerialFetch({fetchImpl, maxConcurrent: LIMITS.maxConcurrent, maxQueued: LIMITS.maxQueued,
    timeoutMs: LIMITS.timeoutMs, timeoutFrom: 'start', minRequestIntervalMs: 1000, intervalFrom: 'start', clock});
  let initialization, ready = false, unavailable = false, closed = false, generation = 0, contactGeneration = 0;
  let writes = Promise.resolve(), notificationQueued = false;
  let currentContact = normalizeMusicBrainzContact(contact);
  // The old UA option remains only for injected fixture transports. Runtime
  // callers supply contact and never infer identity from the machine/account.
  let requestUserAgent = currentContact ? `STILL/1.0.1 (${currentContact})` :
    contact === undefined && fetchImpl !== globalThis.fetch && typeof userAgent === 'string' && userAgent.length <= 256 &&
    /^[A-Za-z][A-Za-z0-9 ._-]*\/[0-9][A-Za-z0-9._-]* \((?:https:\/\/[^\s()]+|[^\s()@]+@[^\s()@]+\.[^\s()@]+)\)$/.test(userAgent) ? userAgent : '';
  function notifyIds(ids) {
    if (closed || typeof onChange !== 'function') return;
    for (const id of ids) if (trackKeys.has(id)) pendingIds.add(id);
    if (notificationQueued || !pendingIds.size) return;
    notificationQueued = true;
    queueMicrotask(() => {
      notificationQueued = false;
      const trackIds = [];
      for (const id of pendingIds) {
        pendingIds.delete(id); trackIds.push(id);
        if (trackIds.length >= LIMITS.maxNotificationBatch) break;
      }
      if (closed || !trackIds.length) return;
      try {Promise.resolve(onChange({trackIds})).catch(() => {});} catch {}
      if (pendingIds.size) notifyIds([]);
    });
  }
  function notifyKey(key) {notifyIds(keyTracks.get(key) || []);}
  function register(track, key) {
    if (typeof track.id !== 'string' || !track.id) return;
    const previous = trackKeys.get(track.id);
    if (previous === key) return;
    if (previous !== undefined) {
      const ids = keyTracks.get(previous); ids?.delete(track.id);
      if (!ids?.size) {
        keyTracks.delete(previous); fullKeys.delete(previous);
        const job = jobs.get(previous);
        if (job) {jobs.delete(previous); job.controller.abort();}
      }
    }
    pendingIds.delete(track.id); trackStatuses.delete(track.id);
    if (key === undefined) {trackKeys.delete(track.id); return;}
    trackKeys.set(track.id, key);
    if (!keyTracks.has(key)) keyTracks.set(key, new Set());
    keyTracks.get(key).add(track.id);
  }
  function remember(track, decorated) {
    if (trackKeys.has(track.id)) trackStatuses.set(track.id, decorated.coverMetadataStatus);
    return decorated;
  }
  function forgetTracks(trackIds) {
    if (!Array.isArray(trackIds)) return;
    for (const id of trackIds) if (typeof id === 'string') register({id}, undefined);
  }
  async function persist(epoch) {
    const entries = [...cache].map(([key, value]) => ({key, ...value}));
    while (Buffer.byteLength(JSON.stringify({version: 2, entries})) > LIMITS.maxIndexBytes && entries.length) {
      cache.delete(entries[0].key); entries.shift();
    }
    writes = writes.catch(() => {}).then(async () => {
      if (epoch !== contactGeneration) return;
      await safeDirectory(directory);
      try {const stat = await fs.lstat(indexFile); if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe metadata index.');}
      catch (error) {if (error.code !== 'ENOENT') throw error;}
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY | (FS.O_NOFOLLOW || 0), 0o600);
        await handle.writeFile(JSON.stringify({version: 2, entries})); await handle.sync(); await handle.close(); handle = null;
        await safeDirectory(directory);
        if (epoch === contactGeneration) await fs.rename(temporary, indexFile);
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
      if (!closed) notifyIds([...trackStatuses].filter(([, status]) => status === 'initializing').map(([id]) => id));
    })();
    return initialization;
  }
  function query(info, controller) {
    const agent = requestUserAgent;
    if (!agent) throw new Error('MusicBrainz maintainer contact unavailable.');
    const escapePhrase = value => value.replace(/[\\"]/g, '\\$&');
    const url = new URL('https://musicbrainz.org/ws/2/release/');
    url.search = new URLSearchParams({query: 'release:"' + escapePhrase(info.album) + '" AND artist:"' + escapePhrase(info.artist) + '"', fmt: 'json', limit: '50'}).toString();
    return transport.run(async context => {
      const response = await context.fetch(url.href, {signal: context.signal, redirect: 'error', credentials: 'omit',
        referrerPolicy: 'no-referrer', headers: {Accept: 'application/json', 'User-Agent': agent}});
      context.guard();
      return selectMatch(await boundedJson(response, context), info);
    }, {signal: controller.signal});
  }
  function enqueue(info) {
    const {key} = info, controller = new AbortController(), epoch = generation, persistenceEpoch = contactGeneration;
    const request = query(info, controller);
    if (request.admitted === false) {
      void request.result.catch(() => {});
      if (keyTracks.has(key)) fullKeys.add(key);
      return 'queue-full';
    }
    fullKeys.delete(key);
    const job = {controller, key, promise: null}; jobs.set(key, job);
    job.promise = (async () => {
      let result;
      try {result = await request.result;} catch (error) {
        if (['CANCELLED', 'CLOSED', 'BUSY'].includes(error.code)) return;
        result = {status: 'failed'};
      }
      if (closed || epoch !== generation) return;
      cache.delete(key); cache.set(key, {...info, ...result, checkedAt: Date.now()});
      while (cache.size > LIMITS.maxEntries) {
        const evicted = cache.keys().next().value;
        cache.delete(evicted); notifyKey(evicted);
      }
      if (jobs.get(key) === job) jobs.delete(key);
      try {await persist(persistenceEpoch);} catch { /* A transient disk failure must not interrupt playback. */ }
      if (!closed && epoch === generation) notifyKey(key);
    })().finally(() => {if (jobs.get(key) === job) jobs.delete(key);});
    // The shared scheduler owns real fetch/body/cancel slots, including a
    // transport that ignores abort after this job's logical result has settled.
    void request.settled.then(() => {
      if (!closed && epoch === generation) {
        let capacity = LIMITS.maxQueued - transport.getState().queued;
        for (const waitingKey of fullKeys) {if (capacity-- <= 0) break; notifyKey(waitingKey);}
      }
    });
    return 'queued';
  }
  function setContact(value) {
    const next = normalizeMusicBrainzContact(value), agent = next ? `STILL/1.0.1 (${next})` : '';
    if (currentContact === next && requestUserAgent === agent) return currentContact;
    currentContact = next; requestUserAgent = agent; generation++; contactGeneration++;
    pendingIds.clear();
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear(); fullKeys.clear();
    // Runtime re-decorates these indexed IDs, scheduling only their current
    // metadata. A track moved to another album cannot receive an old-key patch.
    notifyIds([...trackStatuses].filter(([, status]) => ['initializing', 'queued', 'queue-full', 'source-unavailable'].includes(status)).map(([id]) => id));
    return currentContact;
  }
  function decorateTrack(track) {
    if (!track || typeof track !== 'object') return track;
    if (typeof track.coverUrl === 'string' && track.coverUrl.trim()) {register(track, undefined); return track;}
    // IDs must already belong to indexed metadata. Never inspect audio files to
    // obtain them. Direct CAA registration needs no MusicBrainz API call or UA.
    const suppliedIds = [track.musicbrainzAlbumId, track.musicbrainzReleaseId]
      .filter(value => value !== undefined && value !== null && value !== '');
    if (suppliedIds.length) {
      register(track, '@release');
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
      return remember(track, decorated);
    }
    const info = metadata(track);
    register(track, info?.key || '@missing');
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
      } else if (!requestUserAgent) status = 'source-unavailable';
      else if (jobs.has(info.key)) status = 'queued';
      else status = enqueue(info);
    }
    const decorated = {...track, coverUrl, coverMetadataStatus: status};
    if (attribution) decorated.coverMetadataSource = attribution;
    else delete decorated.coverMetadataSource;
    return remember(track, decorated);
  }
  function decorateSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.tracks)) return snapshot;
    return {...snapshot, tracks: snapshot.tracks.map(decorateTrack)};
  }
  async function close() {
    const pending = [...jobs.values()];
    if (!closed) {
      closed = true; generation++; pendingIds.clear(); fullKeys.clear();
      for (const job of pending) job.controller.abort();
      transport.close();
    }
    await Promise.allSettled(pending.map(job => job.promise));
    if (initialization) await initialization;
    await writes.catch(() => {});
  }
  return {initialize, decorateSnapshot, decorateTrack, setContact, forgetTracks, close};
}
module.exports = {createMetadataCoverService, artworkForRelease, normalizeMusicBrainzContact, LIMITS};
