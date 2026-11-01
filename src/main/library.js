'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLibraryStorage } = require('./library-storage');
const { imageExtension, stripCoverPictures } = require('./library-metadata');

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

function createLibraryService({ dataDir, onUpdate, onDelta, returnDeltas = false, shell, supportsSubsongs = true, fileSystem = fs, metadataParser, backupLimit = 5 } = {}) {
  if (!dataDir) throw new TypeError('A library dataDir is required.');
  const storage = createLibraryStorage({ dataDir, fileSystem, backupLimit });
  const { coversDir } = storage;
  let records = new Map();
  let playlists = [];
  let folders = [];
  let excludedTrackIds = new Set();
  let importedPlaylistIds = new Set();
  let initialization;
  let pending = Promise.resolve();
  let closed = false;
  let revision = 0;
  const eventStream = crypto.randomUUID();
  let eventSequence = 0;
  let status = { status: 'ready', readOnly: false, recovered: false, backupPath: '', message: '' };
  let publishedRecords = new Map();
  let publishedPlaylists = [];
  let publishedFolders = [];
  let publishedSnapshot;
  let transaction;
  const parseCache = new Map();
  const publishedCoverUrls = new Set();
  let coverReferences = new Map();

  function list() {
    publishedSnapshot ||= { tracks: [...publishedRecords.values()].map(publicTrack), playlists: publishedPlaylists.map(item => ({ ...item, trackIds: [...item.trackIds] })), folders: [...publishedFolders], revision, status: getStatus() };
    return { ...structuredClone(publishedSnapshot), eventCursors: { library: { streamId: eventStream, sequence: eventSequence } } };
  }

  function getStatus() { return structuredClone(status); }

  function readOnly(error, backupPath = '') {
    status = { status: 'read-only', readOnly: true, recovered: false, backupPath, message: `The music library is read-only: ${error.message}`, error: { code: error.code || 'ERR_LIBRARY_STORAGE', message: error.message } };
  }

  function publish(changes) {
    if (changes) {
      for (const id of changes.recordUndo.keys()) {
        const beforeCover = publishedRecords.get(id)?.coverUrl;
        const afterCover = records.get(id)?.coverUrl;
        if (beforeCover !== afterCover) { changeCoverReference(beforeCover, -1); changeCoverReference(afterCover, 1); }
        if (records.has(id)) { publishedRecords.set(id, records.get(id)); if (afterCover) publishedCoverUrls.add(afterCover); }
        else publishedRecords.delete(id);
      }
    } else {
      publishedRecords = new Map(records);
      coverReferences = new Map();
      for (const record of records.values()) if (record.coverUrl) { publishedCoverUrls.add(record.coverUrl); changeCoverReference(record.coverUrl, 1); }
    }
    publishedPlaylists = playlists;
    publishedFolders = folders;
    publishedSnapshot = undefined;
  }

  function changeCoverReference(url, amount) {
    if (!url) return;
    const count = (coverReferences.get(url) || 0) + amount;
    if (count > 0) coverReferences.set(url, count); else coverReferences.delete(url);
  }

  function setRecord(record) {
    if (!transaction.recordUndo.has(record.id)) transaction.recordUndo.set(record.id, records.get(record.id));
    if (!records.has(record.id)) transaction.orderChanged = true;
    records.set(record.id, record);
  }

  function deleteRecord(id) {
    if (!records.has(id)) return;
    if (!transaction.recordUndo.has(id)) transaction.recordUndo.set(id, records.get(id));
    transaction.orderChanged = true;
    records.delete(id);
  }

  function setMembership(set, id, present) {
    if (set.has(id) === present) return;
    transaction.setUndo.push({ set, id, present: !present });
    if (present) set.add(id); else set.delete(id);
  }

  function writablePlaylists() {
    if (playlists === transaction.playlists) playlists = [...playlists];
    return playlists;
  }

  function makeDelta(changes, baseRevision) {
    const delta = { kind: 'library-delta', baseRevision, revision, tracks: [], removedTrackIds: [], status: getStatus() };
    for (const id of changes.recordUndo.keys()) {
      const record = records.get(id);
      if (record) delta.tracks.push(publicTrack(record)); else delta.removedTrackIds.push(id);
    }
    if (changes.orderChanged) delta.trackIds = [...records.keys()];
    if (playlists !== changes.playlists) delta.playlists = playlists.map(item => ({ ...item, trackIds: [...item.trackIds] }));
    if (folders !== changes.folders) delta.folders = [...folders];
    return delta;
  }

  function notify(delta, { result = true } = {}) {
    delta.eventId = `library:${eventStream}:${++eventSequence}`;
    // A delta-only runtime never allocates or clones a complete track snapshot.
    if (typeof onDelta === 'function') { try { Promise.resolve(onDelta(structuredClone(delta))).catch(() => {}); } catch (_) { /* Notifications cannot undo saved edits. */ } }
    let snapshot;
    if ((result && !returnDeltas) || typeof onUpdate === 'function') snapshot = list();
    if (typeof onUpdate === 'function') { try { Promise.resolve(onUpdate(structuredClone(snapshot))).catch(() => {}); } catch (_) { /* Notifications cannot undo saved edits. */ } }
    return returnDeltas ? delta : snapshot;
  }

  function notifyStatus() {
    notify({ kind: 'library-delta', baseRevision: revision, revision, tracks: [], removedTrackIds: [], status: getStatus() }, { result: false });
  }

  function restoreStored(stored) {
    if (!stored || !Array.isArray(stored.tracks) || !Array.isArray(stored.playlists) || (stored.folders !== undefined && !Array.isArray(stored.folders))) throw new Error('The saved music library has an invalid structure.');
    if (stored.version !== undefined && stored.version !== 1 && stored.version !== 2) throw new Error('The saved music library version is unsupported.');
    for (const key of ['excludedTrackIds', 'importedPlaylistIds']) if (stored[key] !== undefined && (!Array.isArray(stored[key]) || stored[key].some(id => typeof id !== 'string'))) throw new Error(`The saved music library ${key} has an invalid structure.`);
    if (stored.revision !== undefined && (!Number.isSafeInteger(stored.revision) || stored.revision < 0)) throw new Error('The saved music library revision is invalid.');
    const restoredRecords = new Map();
    const aliases = new Map();
    for (const item of stored.tracks) {
      if (!item || typeof item.path !== 'string' || !path.isAbsolute(item.path)) throw new Error('The saved music library contains an invalid track.');
      const base = emptyTrack(item.path, item.subsong);
      aliases.set(item.id, base.id);
      const restored = { ...base, ...cleanMetadata(item), valid: item.valid === true, _fileValid: item.valid === true };
      for (const key of ['error', 'metadataError', 'metadataSource', 'source', 'sourceScope', '_sourceSize', '_sourceMtime', '_foobarMetadata', '_foobarSupported', '_fileValid']) if (item[key] !== undefined) restored[key] = item[key];
      if (typeof item.coverUrl === 'string' && /^still-cover:\/\/art\/[a-f0-9]+\.(jpg|png|gif|webp)$/.test(item.coverUrl)) restored.coverUrl = item.coverUrl;
      applySupport(restored);
      restoredRecords.set(base.id, restored);
    }
    const restoredPlaylists = stored.playlists.map(item => {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || !Array.isArray(item.trackIds) || item.trackIds.some(id => typeof id !== 'string')) throw new Error('The saved music library contains an invalid playlist.');
      return {
        id: item.id, name: item.name, trackIds: orderedIds(item.trackIds.map(id => aliases.get(id) || id), restoredRecords),
        createdAt: item.createdAt || new Date().toISOString(), updatedAt: item.updatedAt || new Date().toISOString(),
        ...(item.source ? { source: item.source, sourcePlaylistId: item.sourcePlaylistId, sourceScope: item.sourceScope || 'existing-playlists' } : {}),
      };
    });
    const restoredFolders = stored.folders || [];
    if (restoredFolders.some(item => typeof item !== 'string' || !path.isAbsolute(item))) throw new Error('The saved music library contains an invalid folder.');
    return {
      records: restoredRecords, playlists: restoredPlaylists,
      folders: [...new Map(restoredFolders.map(item => [canonicalPath(item), path.resolve(item)])).values()],
      excludedTrackIds: new Set(stored.excludedTrackIds || []),
      importedPlaylistIds: new Set(stored.importedPlaylistIds || restoredPlaylists.filter(item => item.source === 'foobar2000').map(item => item.id)),
    };
  }

  function startInitialization(options = {}) {
    if (initialization) return initialization;
    initialization = (async () => {
      let stored, restored, backupPath = '', maintenanceError = '';
      try {
        const bytes = await storage.readDatabase();
        let invalid;
        if (bytes !== null) {
          try {
            stored = JSON.parse(bytes.toString('utf8'));
            restored = restoreStored(stored);
          } catch (error) { invalid = error; }
        }
        if (options.reset === true || invalid) {
          if (bytes !== null) {
            backupPath = await storage.backup(bytes, invalid ? 'corrupt' : 'reset');
            // A verified independent backup is enough to retire older copies;
            // repeated replacement failures must not accumulate unbounded files.
            await storage.pruneBackups(backupPath, bytes).catch(error => { maintenanceError = error.message; });
            await storage.verifyBackup(backupPath, bytes);
          }
          const recoveredRevision = Number.isSafeInteger(stored?.revision) && stored.revision >= 0 ? nextRevision(stored.revision) : 1;
          await storage.writeDatabase({ version: 2, tracks: [], playlists: [], folders: [], excludedTrackIds: [], importedPlaylistIds: [], revision: recoveredRevision });
          revision = recoveredRevision;
          status = { status: 'recovered', readOnly: false, recovered: true, backupPath, message: invalid ? 'The unreadable library was backed up and replaced with an empty library.' : 'The library was backed up and reset.' };
          if (maintenanceError) status.maintenanceError = maintenanceError;
          stored = null;
        }
        await storage.assertDirectories(coversDir, { create: true });
      } catch (error) {
        records.clear(); playlists = []; folders = [];
        readOnly(error, backupPath);
        if (maintenanceError) status.maintenanceError = maintenanceError;
        publish();
        return;
      }
      if (!stored) { publish(); return; }
      revision = Number.isSafeInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0;
      ({ records, playlists, folders, excludedTrackIds, importedPlaylistIds } = restored);
      publish();
    })();
    return initialization;
  }

  async function initialize(options = {}) {
    if (initialization && options.reset === true) return reset();
    await startInitialization(options);
    return list();
  }

  async function ensureInitialized() {
    // Internal transactions await readiness without materializing a bootstrap
    // snapshot. Public initialize()/list() always return the current cursor.
    await startInitialization();
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
    await storage.writeDatabase({ version: 2, tracks: [...records.values()], playlists, folders, excludedTrackIds: [...excludedTrackIds], importedPlaylistIds: [...importedPlaylistIds], revision: nextRevision(revision) });
  }

  function nextRevision(value) {
    if (!Number.isSafeInteger(value + 1)) throw new Error('The music library revision has reached its supported limit.');
    return value + 1;
  }

  function reset() {
    if (closed) return Promise.reject(new Error('The music library has been closed.'));
    const task = pending.then(async () => {
      await ensureInitialized();
      const baseRevision = revision;
      const removedTrackIds = [...records.keys()];
      let backupPath = '', maintenanceError = '';
      try {
        const bytes = await storage.readDatabase();
        if (bytes !== null) {
          backupPath = await storage.backup(bytes, 'reset');
          await storage.pruneBackups(backupPath, bytes).catch(error => { maintenanceError = error.message; });
          await storage.verifyBackup(backupPath, bytes);
        }
        await storage.writeDatabase({ version: 2, tracks: [], playlists: [], folders: [], excludedTrackIds: [], importedPlaylistIds: [], revision: nextRevision(revision) });
        records = new Map(); playlists = []; folders = []; excludedTrackIds = new Set(); importedPlaylistIds = new Set();
        revision++;
        status = { status: 'recovered', readOnly: false, recovered: true, backupPath, message: 'The library was backed up and reset.' };
        if (maintenanceError) status.maintenanceError = maintenanceError;
        publish();
        return notify({ kind: 'library-delta', baseRevision, revision, tracks: [], removedTrackIds, trackIds: [], playlists: [], folders: [], status: getStatus() });
      } catch (error) {
        readOnly(error, backupPath);
        if (maintenanceError) status.maintenanceError = maintenanceError;
        publish();
        notifyStatus();
        throw error;
      }
    });
    pending = task.catch(() => {});
    return task;
  }

  function mutate(operation) {
    if (closed) return Promise.reject(new Error('The music library has been closed.'));
    const task = pending.then(async () => {
      await ensureInitialized();
      if (status.readOnly) throw new Error(status.message);
      // Records and playlists are copied only when affected; published references
      // remain immutable until the atomic file replacement succeeds.
      const changes = { recordUndo: new Map(), playlists, folders, setUndo: [], writablePlaylistIds: new Set(), orderChanged: false };
      transaction = changes;
      let saving = false;
      try {
        await operation();
        saving = true;
        await persist();
      } catch (error) {
        for (const [id, previous] of changes.recordUndo) { if (previous === undefined) records.delete(id); else records.set(id, previous); }
        // Restoring deleted entries also restores their exact original order.
        if (changes.orderChanged) records = new Map(publishedRecords);
        playlists = changes.playlists;
        folders = changes.folders;
        for (const item of changes.setUndo.reverse()) { if (item.present) item.set.add(item.id); else item.set.delete(item.id); }
        if (saving) { readOnly(error, status.backupPath); publishedSnapshot = undefined; notifyStatus(); }
        throw error;
      } finally {
        transaction = undefined;
        parseCache.clear();
      }
      const baseRevision = revision;
      revision++;
      publish(changes);
      return notify(makeDelta(changes, baseRevision));
    });
    pending = task.catch(() => {});
    return task;
  }

  async function saveCover(picture) {
    if (!picture || !picture.data || !picture.data.length) return '';
    const bytes = Buffer.from(picture.data);
    // Detect actual image bytes; never trust a tag's declared MIME or filename.
    const extension = imageExtension(bytes);
    if (!extension) return '';
    const filename = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${extension}`;
    const target = path.join(coversDir, filename);
    await storage.assertDirectories(coversDir);
    const existing = await storage.readRegular(target, { missing: true });
    if (existing) {
      if (!existing.equals(bytes)) throw new Error('An existing managed cover does not match its content hash.');
    } else await storage.writeAtomic(target, bytes);
    return `still-cover://art/${filename}`;
  }

  async function readTrack(filePath, subsong = 0, foobarMetadata, force = false) {
    const base = emptyTrack(filePath, subsong);
    const previous = records.get(base.id);
    const sourceMetadata = foobarMetadata ? cleanMetadata(foobarMetadata) : previous?._foobarMetadata;
    const sourceSupported = foobarMetadata ? foobarMetadata.supported !== false && normalizeSubsong(foobarMetadata.subsong) !== null : previous?._foobarSupported;
    let stat;
    try { stat = await fileSystem.stat(base.path); if (!stat.isFile()) throw new Error('This path is not a regular file.'); }
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
      if (!metadataParser) metadataModule ||= import('music-metadata').catch(error => { metadataModule = undefined; throw error; });
      const parser = metadataParser || await metadataModule;
      const parseFile = typeof parser === 'function' ? parser : parser.parseFile;
      const selectCover = parser.selectCover;
      const cacheKey = `${canonicalPath(base.path)}\0${stat.size}\0${stat.mtimeMs}`;
      if (!parseCache.has(cacheKey)) {
        parseCache.set(cacheKey, (async () => {
          const metadata = await parseFile(base.path, { duration: true, skipCovers: false });
          const cover = typeof selectCover === 'function' ? selectCover(metadata.common?.picture) : metadata.common?.picture?.[0];
          try { metadata.coverUrl = await saveCover(cover); }
          finally { stripCoverPictures(metadata); }
          return metadata;
        })());
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
      record.coverUrl = metadata.coverUrl;
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
      if (explicit) setMembership(excludedTrackIds, trackId(resolved), false);
      else if (excludedTrackIds.has(trackId(resolved))) continue;
      const record = await readTrack(resolved);
      setRecord(record);
    }
  }

  function requirePlaylist(id) {
    const index = playlists.findIndex(item => item.id === id);
    let playlist = playlists[index];
    if (!playlist) throw new Error('The saved playlist was not found.');
    if (transaction && !transaction.writablePlaylistIds.has(id)) {
      playlist = { ...playlist, trackIds: [...playlist.trackIds] };
      writablePlaylists()[index] = playlist;
      transaction.writablePlaylistIds.add(id);
    }
    return playlist;
  }

  function playlistName(name) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('A playlist name is required.');
    return name.trim().slice(0, 240);
  }

  function coverMaintenance(operation) {
    const task = pending.then(async () => {
      if (closed && !initialization) throw new Error('The music library was closed before initialization.');
      await ensureInitialized();
      if (status.readOnly) throw new Error(status.message);
      // Queue behind commits and retain every cover ever published this session:
      // a player or UI can still hold an older DTO after its index entry is removed.
      return operation();
    });
    pending = task.catch(() => {});
    return task;
  }

  async function planCoverCollection({ retainUrls = [] } = {}) {
    if (!Array.isArray(retainUrls) || retainUrls.some(url => typeof url !== 'string')) throw new TypeError('Retained cover URLs must be an array of strings.');
    await storage.assertDirectories(coversDir);
    await storage.assertDatabaseUnchanged();
    const retained = new Set([...(closed ? [] : publishedCoverUrls), ...coverReferences.keys(), ...retainUrls]);
    const candidates = [], skipped = [];
    const entries = await fileSystem.readdir(coversDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/.test(entry.name)) continue;
      if (retained.has(`still-cover://art/${entry.name}`)) continue;
      const target = path.join(coversDir, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) { skipped.push({ filename: entry.name, reason: 'not-independent-file' }); continue; }
      try {
        const bytes = await storage.readRegular(target);
        const stat = await fileSystem.lstat(target);
        storage.assertRegular(stat, target);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.name.slice(0, 64) || imageExtension(bytes) !== path.extname(entry.name).slice(1)) { skipped.push({ filename: entry.name, reason: 'content-does-not-match-managed-name' }); continue; }
        candidates.push({ filename: entry.name, path: target, bytes: bytes.length, dev: stat.dev, ino: stat.ino });
      } catch (error) {
        skipped.push({ filename: entry.name, reason: error.code || error.message });
      }
    }
    return { kind: 'library-cover-collection', revision, candidates, skipped, retainedCount: retained.size, referenceCounts: Object.fromEntries(coverReferences) };
  }

  async function collectCovers(options) {
    // Always re-plan under the same transaction queue; an earlier reviewed plan
    // cannot authorize deletion of a cover that a later commit started using.
    const plan = await planCoverCollection(options);
    const removed = [], errors = [];
    for (const item of plan.candidates) {
      try {
        await storage.assertDirectories(coversDir);
        const stat = await fileSystem.lstat(item.path);
        storage.assertRegular(stat, item.path);
        if (stat.dev !== item.dev || stat.ino !== item.ino || stat.size !== item.bytes) throw new Error('The managed cover changed after collection planning.');
        const bytes = await storage.readRegular(item.path);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.filename.slice(0, 64)) throw new Error('The managed cover changed before collection.');
        await storage.assertDatabaseUnchanged();
        await fileSystem.unlink(item.path);
        removed.push(item.filename);
      } catch (error) { errors.push({ filename: item.filename, message: error.message }); }
    }
    return { ...plan, removed, errors };
  }

  return {
    initialize(options) {
      if (closed && !initialization) return Promise.reject(new Error('The music library has been closed.'));
      return initialize(options);
    },
    reset, list, getStatus,
    planCoverCollection(options) { return coverMaintenance(() => planCoverCollection(options)); },
    collectCovers(options) { return coverMaintenance(() => collectCovers(options)); },
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
        if (!folders.some(item => canonicalPath(item) === canonicalPath(resolved))) folders = [...folders, resolved];
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
              setRecord(record);
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
            writablePlaylists().push({ id, name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : `foobar2000 playlist ${index + 1}`, trackIds: ids, createdAt: timestamp, updatedAt: timestamp, source: 'foobar2000', sourceScope: 'existing-playlists', sourcePlaylistId });
            setMembership(importedPlaylistIds, id, true);
          }
        }
      });
    },
    refresh() {
      return mutate(async () => {
        for (const record of records.values()) setRecord(await readTrack(record.path, record.subsong));
        for (const folder of folders) await indexPaths(await discover(folder, { strict: false }), false);
      });
    },
    remove(ids) {
      return mutate(() => {
        const removals = new Set(uniqueIds(ids, records));
        for (const id of removals) { setMembership(excludedTrackIds, id, true); deleteRecord(id); }
        for (const candidate of playlists) {
          if (candidate.trackIds.some(id => removals.has(id))) { const playlist = requirePlaylist(candidate.id); playlist.trackIds = playlist.trackIds.filter(id => !removals.has(id)); playlist.updatedAt = new Date().toISOString(); }
        }
      });
    },
    createPlaylist(name) {
      return mutate(() => {
        const timestamp = new Date().toISOString();
        writablePlaylists().push({ id: `playlist_${crypto.randomUUID()}`, name: playlistName(name), trackIds: [], createdAt: timestamp, updatedAt: timestamp });
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
      await ensureInitialized();
      const record = records.get(id);
      if (!record) throw new Error('The track was not found in the music library.');
      if (!shell || typeof shell.showItemInFolder !== 'function') throw new Error('Opening the audio folder is unavailable.');
      await fs.access(record.path);
      shell.showItemInFolder(record.path);
      return publicTrack(record);
    },
    async close() { closed = true; await pending; if (initialization) await initialization; parseCache.clear(); publishedCoverUrls.clear(); },
  };
}

module.exports = { createLibraryService, AUDIO_EXTENSIONS, canonicalPath, trackId };
