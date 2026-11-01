'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.wav', '.wave', '.aif',
  '.aiff', '.aifc', '.ogg', '.oga', '.opus', '.wv', '.dsf', '.dff', '.ape',
  '.mpc', '.mpp', '.mp+', '.wma', '.tak', '.tta', '.ac3', '.dts', '.caf',
  '.alac', '.cue', '.iso',
]);
const TEXT_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'codec'];
const NUMBER_FIELDS = ['duration', 'trackNumber', 'discNumber', 'year', 'sampleRate', 'bitsPerSample', 'channels'];
let metadataModule;

function canonicalPath(filePath) {
  const absolute = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function normalizeSubsong(value) {
  if (value === undefined) return 0;
  return value !== null && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
}

function trackId(filePath, subsong = 0) {
  return `track_${crypto.createHash('sha256').update(`${canonicalPath(filePath)}\0${normalizeSubsong(subsong)}`).digest('hex').slice(0, 32)}`;
}

function emptyTrack(filePath, subsong = 0) {
  const resolved = path.resolve(filePath);
  return {
    id: trackId(resolved, subsong), path: resolved, subsong: normalizeSubsong(subsong),
    title: path.basename(resolved, path.extname(resolved)), artist: '', album: '', albumArtist: '',
    duration: null, trackNumber: null, discNumber: null, year: null, genre: '', codec: '',
    sampleRate: null, bitsPerSample: null, channels: null, coverUrl: '', valid: false,
    supported: true, playbackUnsupportedReason: '', error: '', metadataError: '', metadataSource: 'filename',
  };
}

function cleanMetadata(value = {}) {
  const result = {};
  for (const key of TEXT_FIELDS) {
    if (Array.isArray(value[key])) result[key] = value[key].map(String).join(', ');
    else if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].trim();
  }
  for (const key of NUMBER_FIELDS) {
    if (value[key] !== null && value[key] !== undefined && value[key] !== '' && Number.isFinite(Number(value[key])) && Number(value[key]) >= 0) result[key] = Number(value[key]);
  }
  return result;
}

function publicTrack(record) {
  const result = { ...record };
  for (const key of Object.keys(result)) if (key.startsWith('_')) delete result[key];
  return result;
}

function uniqueIds(ids, records) {
  return [...new Set(orderedIds(ids, records))];
}

function orderedIds(ids, records) {
  if (!Array.isArray(ids)) throw new TypeError('trackIds must be an array.');
  return ids.filter(id => typeof id === 'string' && records.has(id));
}

async function atomicWrite(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx');
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

function createLibraryService({ dataDir, onUpdate, shell, supportsSubsongs = true } = {}) {
  if (!dataDir) throw new TypeError('A library dataDir is required.');
  const databasePath = path.join(dataDir, 'library.json');
  const coversDir = path.join(dataDir, 'covers');
  let records = new Map();
  let playlists = [];
  let folders = [];
  let excludedTrackIds = new Set();
  let importedPlaylistIds = new Set();
  let initialization;
  let pending = Promise.resolve();
  let closed = false;
  let publishedRecords = new Map();
  let publishedSnapshot = { tracks: [], playlists: [], folders: [] };
  const parseCache = new Map();

  function list() {
    return structuredClone(publishedSnapshot);
  }

  function publish() {
    publishedRecords = new Map(records);
    publishedSnapshot = { tracks: [...records.values()].map(publicTrack), playlists: playlists.map(item => ({ ...item, trackIds: [...item.trackIds] })), folders: [...folders] };
  }

  async function initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      await fs.mkdir(coversDir, { recursive: true });
      let stored;
      try { stored = JSON.parse(await fs.readFile(databasePath, 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') return list();
        throw new Error(`Cannot read the saved music library (${databasePath}): ${error.message}`);
      }
      if (!stored || !Array.isArray(stored.tracks) || !Array.isArray(stored.playlists)) throw new Error('The saved music library has an invalid structure.');
      const aliases = new Map();
      for (const item of stored.tracks) {
        if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path)) continue;
        const base = emptyTrack(item.path, item.subsong);
        aliases.set(item.id, base.id);
        const restored = { ...base, ...cleanMetadata(item), valid: item.valid === true, _fileValid: item.valid === true };
        for (const key of ['error', 'metadataError', 'metadataSource', 'source', 'sourceScope', '_sourceSize', '_sourceMtime', '_foobarMetadata', '_foobarSupported', '_fileValid']) if (item[key] !== undefined) restored[key] = item[key];
        // Covers can only refer to files under the dedicated image protocol.
        if (typeof item.coverUrl === 'string' && /^still-cover:\/\/art\/[a-f0-9]+\.(jpg|png|gif|webp)$/.test(item.coverUrl)) restored.coverUrl = item.coverUrl;
        applySupport(restored);
        records.set(base.id, restored);
      }
      playlists = stored.playlists.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.trackIds)).map(item => ({
        id: item.id, name: item.name, trackIds: orderedIds(item.trackIds.map(id => aliases.get(id) || id), records),
        createdAt: item.createdAt || new Date().toISOString(), updatedAt: item.updatedAt || new Date().toISOString(),
        ...(item.source ? { source: item.source, sourcePlaylistId: item.sourcePlaylistId, sourceScope: item.sourceScope || 'existing-playlists' } : {}),
      }));
      folders = [...new Map((Array.isArray(stored.folders) ? stored.folders : []).filter(item => typeof item === 'string' && path.isAbsolute(item)).map(item => [canonicalPath(item), path.resolve(item)])).values()];
      excludedTrackIds = new Set(Array.isArray(stored.excludedTrackIds) ? stored.excludedTrackIds : []);
      importedPlaylistIds = new Set(Array.isArray(stored.importedPlaylistIds) ? stored.importedPlaylistIds : playlists.filter(item => item.source === 'foobar2000').map(item => item.id));
      publish();
      return list();
    })();
    return initialization;
  }

  function applySupport(record) {
    const extension = path.extname(record.path).toLowerCase();
    const container = extension === '.iso' || extension === '.cue';
    record.supported = record.subsong !== null && record._foobarSupported !== false && ((!container && record.subsong === 0) || (supportsSubsongs && record.source === 'foobar2000'));
    record.playbackUnsupportedReason = record.supported ? '' : record._foobarSupported === false || record.subsong === null
      ? 'foobar2000 did not expose a valid exact subsong identifier for this entry.'
      : 'Import this container or subsong from an existing foobar2000 playlist so its exact track selection can be verified.';
    record.valid = record._fileValid === true;
    return record;
  }

  async function persist() {
    await atomicWrite(databasePath, { version: 2, tracks: [...records.values()], playlists, folders, excludedTrackIds: [...excludedTrackIds], importedPlaylistIds: [...importedPlaylistIds] });
  }

  function mutate(operation) {
    if (closed) return Promise.reject(new Error('The music library has been closed.'));
    const task = pending.then(async () => {
      await initialize();
      // Roll back memory if persistence fails; callers never observe a saved result that was not saved.
      const before = { records: structuredClone(records), playlists: structuredClone(playlists), folders: [...folders], excludedTrackIds: new Set(excludedTrackIds), importedPlaylistIds: new Set(importedPlaylistIds) };
      try {
        await operation();
        await persist();
      } catch (error) {
        ({ records, playlists, folders, excludedTrackIds, importedPlaylistIds } = before);
        throw error;
      } finally {
        parseCache.clear();
      }
      publish();
      const snapshot = list();
      if (typeof onUpdate === 'function') {
        try { Promise.resolve(onUpdate(snapshot)).catch(() => {}); } catch (_) { /* Notifications cannot undo a saved edit. */ }
      }
      return snapshot;
    });
    pending = task.catch(() => {});
    return task;
  }

  async function saveCover(picture) {
    if (!picture || !picture.data || !picture.data.length) return '';
    const bytes = Buffer.from(picture.data);
    // Detect actual image bytes; never trust a tag's declared MIME type or filename.
    let extension;
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) extension = 'jpg';
    else if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) extension = 'png';
    else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) extension = 'gif';
    else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') extension = 'webp';
    else return '';
    const filename = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${extension}`;
    await fs.writeFile(path.join(coversDir, filename), bytes, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    return `still-cover://art/${filename}`;
  }

  async function readTrack(filePath, subsong = 0, foobarMetadata, force = false) {
    const base = emptyTrack(filePath, subsong);
    const previous = records.get(base.id);
    const sourceMetadata = foobarMetadata ? cleanMetadata(foobarMetadata) : previous?._foobarMetadata;
    const sourceSupported = foobarMetadata ? foobarMetadata.supported !== false && normalizeSubsong(foobarMetadata.subsong) !== null : previous?._foobarSupported;
    let stat;
    try { stat = await fs.stat(base.path); if (!stat.isFile()) throw new Error('This path is not a regular file.'); }
    catch (error) {
      return applySupport({ ...(previous || base), ...(sourceMetadata || {}), ...(sourceMetadata ? { source: 'foobar2000', sourceScope: 'existing-playlists', metadataSource: 'foobar2000' } : {}), _foobarMetadata: sourceMetadata, _foobarSupported: sourceSupported, _fileValid: false, valid: false, error: `File unavailable: ${error.message}` });
    }
    if (!force && previous && previous._fileValid && previous._sourceSize === stat.size && previous._sourceMtime === stat.mtimeMs) {
      return applySupport({
        ...previous,
        ...(foobarMetadata ? sourceMetadata : {}),
        ...(foobarMetadata ? {
          source: 'foobar2000', sourceScope: 'existing-playlists', _foobarMetadata: sourceMetadata,
          _foobarSupported: sourceSupported,
          metadataSource: Object.keys(sourceMetadata).length ? 'foobar2000' : previous.metadataSource,
        } : {}),
      });
    }
    let record = { ...base, ...(sourceMetadata || {}), ...(sourceMetadata ? { source: 'foobar2000', sourceScope: 'existing-playlists', _foobarMetadata: sourceMetadata, _foobarSupported: sourceSupported, metadataSource: 'foobar2000' } : {}), _sourceSize: stat.size, _sourceMtime: stat.mtimeMs };
    try {
      metadataModule ||= import('music-metadata').catch(error => { metadataModule = undefined; throw error; });
      const { parseFile, selectCover } = await metadataModule;
      const cacheKey = `${canonicalPath(base.path)}\0${stat.size}\0${stat.mtimeMs}`;
      if (!parseCache.has(cacheKey)) {
        parseCache.set(cacheKey, parseFile(base.path, { duration: true, skipCovers: false }));
        // A bounded cache shares container reads without retaining an entire large library's cover bytes.
        if (parseCache.size > 16) parseCache.delete(parseCache.keys().next().value);
      }
      const metadata = await parseCache.get(cacheKey);
      const { common = {}, format = {} } = metadata;
      const extracted = cleanMetadata({
        title: common.title, artist: common.artist || common.artists, album: common.album,
        albumArtist: common.albumartist, duration: format.duration, trackNumber: common.track?.no,
        discNumber: common.disk?.no, year: common.year, genre: common.genre, codec: format.codec,
        sampleRate: format.sampleRate, bitsPerSample: format.bitsPerSample, channels: format.numberOfChannels,
      });
      // File/container metadata is not an individual subsong's title or duration.
      if (base.subsong > 0 || ['.cue', '.iso'].includes(path.extname(base.path).toLowerCase())) {
        for (const key of ['title', 'artist', 'album', 'albumArtist', 'duration', 'trackNumber', 'discNumber', 'year', 'genre']) delete extracted[key];
      }
      record = { ...record, ...extracted, metadataSource: sourceMetadata && base.subsong > 0 ? 'foobar2000' : 'file', _fileValid: true, valid: true, error: '', metadataError: '' };
      const cover = typeof selectCover === 'function' ? selectCover(common.picture) : common.picture?.[0];
      record.coverUrl = await saveCover(cover);
    } catch (error) {
      record._fileValid = true;
      record.error = `Metadata could not be read: ${error.message}`;
      record.metadataError = record.error;
      record.valid = true;
    }
    return applySupport(record);
  }

  async function discover(folderPath, { strict = true } = {}) {
    const root = path.resolve(folderPath);
    const found = [];
    const visited = new Set();
    async function walk(directory) {
      let real;
      try { real = await fs.realpath(directory); } catch (error) { if (strict && directory === root) throw error; return; }
      const key = canonicalPath(real);
      if (visited.has(key)) return;
      visited.add(key);
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if (strict && directory === root) throw error; return; }
      entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await walk(fullPath);
        else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(fullPath);
      }
    }
    await walk(root);
    return found;
  }

  async function indexPaths(filePaths, explicit = true) {
    for (const filePath of filePaths) {
      if (typeof filePath !== 'string' || !filePath.trim()) continue;
      const resolved = path.resolve(filePath);
      if (!AUDIO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) continue;
      if (explicit) excludedTrackIds.delete(trackId(resolved));
      else if (excludedTrackIds.has(trackId(resolved))) continue;
      const record = await readTrack(resolved);
      records.set(record.id, record);
    }
  }

  function requirePlaylist(id) {
    const playlist = playlists.find(item => item.id === id);
    if (!playlist) throw new Error('The saved playlist was not found.');
    return playlist;
  }

  function playlistName(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A playlist name is required.');
    return name.trim().slice(0, 240);
  }

  return {
    initialize, list,
    getTrack(id) { const record = publishedRecords.get(id); return record ? publicTrack(record) : null; },
    getTracks(ids) { return (Array.isArray(ids) ? ids : []).map(id => publishedRecords.get(id)).filter(Boolean).map(publicTrack); },
    importFiles(filePaths) {
      if (!Array.isArray(filePaths)) return Promise.reject(new TypeError('File paths must be an array.'));
      return mutate(() => indexPaths(filePaths));
    },
    importFolder(folderPath) {
      return mutate(async () => {
        if (typeof folderPath !== 'string' || !folderPath.trim()) throw new Error('A folder path is required.');
        const resolved = path.resolve(folderPath);
        await indexPaths(await discover(resolved));
        if (!folders.some(item => canonicalPath(item) === canonicalPath(resolved))) folders.push(resolved);
      });
    },
    importFoobar(snapshot) {
      return mutate(async () => {
        if (!snapshot || typeof snapshot !== 'object') throw new TypeError('A foobar2000 library snapshot is required.');
        const indexed = new Map();
        async function importItems(items) {
          const ids = [];
          for (const item of Array.isArray(items) ? items : []) {
            if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path) || excludedTrackIds.has(trackId(item.path, item.subsong))) continue;
            const id = trackId(item.path, item.subsong);
            let record = indexed.get(id);
            if (!record) {
              record = await readTrack(item.path, item.subsong, item);
              record.source = 'foobar2000';
              indexed.set(id, record);
              records.set(record.id, record);
            }
            ids.push(record.id);
          }
          return ids;
        }
        await importItems(snapshot.tracks);
        for (const [index, source] of (Array.isArray(snapshot.playlists) ? snapshot.playlists : []).entries()) {
          if (!source || source.ownedByStill === true) continue;
          const ids = await importItems(source.items || source.tracks);
          const sourcePlaylistId = String(source.id ?? source.index ?? index);
          const id = `foobar_${crypto.createHash('sha256').update(sourcePlaylistId).digest('hex').slice(0, 24)}`;
          // Imported lists are editable saved copies. A later startup never overwrites user edits.
          if (!importedPlaylistIds.has(id)) {
            const timestamp = new Date().toISOString();
            playlists.push({ id, name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `foobar2000 playlist ${index + 1}`, trackIds: ids, createdAt: timestamp, updatedAt: timestamp, source: 'foobar2000', sourceScope: 'existing-playlists', sourcePlaylistId });
            importedPlaylistIds.add(id);
          }
        }
      });
    },
    refresh() {
      return mutate(async () => {
        for (const record of [...records.values()]) records.set(record.id, await readTrack(record.path, record.subsong));
        for (const folder of folders) await indexPaths(await discover(folder, { strict: false }), false);
      });
    },
    remove(ids) {
      return mutate(() => {
        const removals = new Set(uniqueIds(ids, records));
        for (const id of removals) { excludedTrackIds.add(id); records.delete(id); }
        for (const playlist of playlists) {
          if (playlist.trackIds.some(id => removals.has(id))) { playlist.trackIds = playlist.trackIds.filter(id => !removals.has(id)); playlist.updatedAt = new Date().toISOString(); }
        }
      });
    },
    createPlaylist(name) {
      return mutate(() => {
        const timestamp = new Date().toISOString();
        playlists.push({ id: `playlist_${crypto.randomUUID()}`, name: playlistName(name), trackIds: [], createdAt: timestamp, updatedAt: timestamp });
      });
    },
    renamePlaylist(id, name) {
      return mutate(() => { const playlist = requirePlaylist(id); playlist.name = playlistName(name); playlist.updatedAt = new Date().toISOString(); });
    },
    deletePlaylist(id) {
      return mutate(() => { requirePlaylist(id); playlists = playlists.filter(item => item.id !== id); });
    },
    setPlaylistTracks(id, ids) {
      return mutate(() => { const playlist = requirePlaylist(id); playlist.trackIds = orderedIds(ids, records); playlist.updatedAt = new Date().toISOString(); });
    },
    addPlaylistTracks(id, ids) {
      return mutate(() => {
        const playlist = requirePlaylist(id);
        const existing = new Set(playlist.trackIds);
        playlist.trackIds.push(...uniqueIds(ids, records).filter(track => !existing.has(track)));
        playlist.updatedAt = new Date().toISOString();
      });
    },
    removePlaylistTracks(id, ids) {
      return mutate(() => { const playlist = requirePlaylist(id); const removals = new Set(uniqueIds(ids, records)); playlist.trackIds = playlist.trackIds.filter(item => !removals.has(item)); playlist.updatedAt = new Date().toISOString(); });
    },
    removePlaylistItem(id, index) {
      return mutate(() => {
        const playlist = requirePlaylist(id);
        if (!Number.isInteger(index) || index < 0 || index >= playlist.trackIds.length) throw new Error('The playlist item index is out of range.');
        playlist.trackIds.splice(index, 1);
        playlist.updatedAt = new Date().toISOString();
      });
    },
    movePlaylistItem(id, fromIndex, toIndex) {
      return mutate(() => {
        const playlist = requirePlaylist(id);
        if (![fromIndex, toIndex].every(index => Number.isInteger(index) && index >= 0 && index < playlist.trackIds.length)) throw new Error('The playlist item index is out of range.');
        const [item] = playlist.trackIds.splice(fromIndex, 1);
        playlist.trackIds.splice(toIndex, 0, item);
        playlist.updatedAt = new Date().toISOString();
      });
    },
    async reveal(id) {
      await initialize();
      const record = records.get(id);
      if (!record) throw new Error('The track was not found in the music library.');
      if (!shell || typeof shell.showItemInFolder !== 'function') throw new Error('Opening the audio folder is unavailable.');
      await fs.access(record.path);
      shell.showItemInFolder(record.path);
      return publicTrack(record);
    },
    async close() { closed = true; await pending; },
  };
}

module.exports = { createLibraryService, AUDIO_EXTENSIONS, canonicalPath, trackId };
