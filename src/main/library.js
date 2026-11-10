'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { createLibraryStorage } = require('./library-storage');
const { imageExtension, stripCoverPictures } = require('./library-metadata');
const { createLocalCoverService, coverUrls, COVER_URL } = require('./local-covers');
const { createCueReader, validateCueItems } = require('./cue-import');

const AUDIO_EXTENSIONS = new Set([
  '.flac', '.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.wav', '.wave', '.aif',
  '.aiff', '.aifc', '.ogg', '.oga', '.opus', '.wv', '.dsf', '.dff', '.ape',
  '.mpc', '.mpp', '.mp+', '.wma', '.tak', '.tta', '.ac3', '.dts', '.caf',
  '.alac', '.cue', '.iso',
]);
const EXISTING_CONTEXT_AUDIO_EXTENSIONS = new Set([...AUDIO_EXTENSIONS].filter(extension => !['.cue', '.iso'].includes(extension)));
const EXISTING_CONTEXT_CONTAINERS = new Set(['.cue', '.iso', '.zip', '.7z', '.rar', '.tar', '.gz', '.gzip', '.bz2', '.xz', '.cab',
  '.m3u', '.m3u8', '.pls', '.xspf', '.asx', '.fpl', '.wpl']);
const TEXT_FIELDS = ['title', 'artist', 'album', 'albumArtist', 'genre', 'codec'];
const NUMBER_FIELDS = ['duration', 'trackNumber', 'discNumber', 'year', 'sampleRate', 'bitsPerSample', 'channels'];
const CUE_PLAYBACK_FIELDS = ['path', 'subsong', 'source', 'sourceScope', 'valid', 'supported', '_fileValid', '_foobarSupported',
  '_cueVerified', '_cuePath', '_cueAuthorizationRoot', '_cueContentHash', '_cueSafetyHash', '_cueTrackCount', '_cueValidationError'];
const CUE_SNAPSHOT_FIELDS = ['_cueVerified', '_cuePath', '_cueAuthorizationRoot', '_cueContentHash', '_cueSafetyHash', '_cueTrackCount', '_cueMetadata'];
let metadataModule;

function absolutePlaybackPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768 && !/[\u0000-\u001f\u007f]/u.test(value) && path.isAbsolute(value);
}

function localAbsolutePath(value) {
  return absolutePlaybackPath(value) &&
    (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/u.test(value));
}

function cuePlaybackPath(value) {
  return path.normalize(path.resolve(value));
}

function cuePlaybackWithin(root, target) {
  const base = cuePlaybackPath(root), absolute = cuePlaybackPath(target);
  // win32.relative() folds case internally. A CUE guard keeps exact normalized
  // names, including on case-sensitive NTFS directories and Unicode filenames.
  return absolute === base || absolute.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
}

function cuePlaybackFailure(reason, cause) {
  return Object.assign(new Error('CUE 播放信息需要重新核验，请刷新或重新导入所选曲目后重试。', cause ? {cause} : undefined),
    {code: 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED', reason});
}

function cuePlaybackLocations(locations) {
  try {
    if (!Array.isArray(locations)) throw new TypeError();
    const length = Object.getOwnPropertyDescriptor(locations, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 50000) throw new TypeError();
    const result = [];
    for (let index = 0; index < length; index++) {
      const entry = Object.getOwnPropertyDescriptor(locations, String(index));
      const item = entry && Object.hasOwn(entry, 'value') ? entry.value : null;
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError();
      const file = Object.getOwnPropertyDescriptor(item, 'path'), subsong = Object.getOwnPropertyDescriptor(item, 'subsong');
      if (!file || !Object.hasOwn(file, 'value') || !absolutePlaybackPath(file.value) || !subsong || !Object.hasOwn(subsong, 'value') ||
          !Number.isSafeInteger(subsong.value) || subsong.value < 0) throw new TypeError();
      result.push({path: file.value, subsong: subsong.value});
    }
    return result;
  } catch (cause) {
    throw Object.assign(new TypeError('Playback locations must be an array of at most 50000 absolute file paths with explicit non-negative safe-integer subsongs.', {cause}),
      {code: 'STILL_CUE_PLAYBACK_INVALID_LOCATIONS', reason: 'invalid-locations'});
  }
}

function sameCuePlaybackAssociation(before, after) {
  return Boolean(before && after && CUE_PLAYBACK_FIELDS.every(key => Object.hasOwn(before, key) === Object.hasOwn(after, key) && Object.is(before[key], after[key])) &&
    Object.hasOwn(before, '_cueMetadata') === Object.hasOwn(after, '_cueMetadata'));
}

function cueAssociated(record) {
  // Ordinary foobar imports also carry a cleared _cueValidationError. That
  // empty marker alone is not evidence that their physical audio is a CUE.
  return record.source === 'cue' || path.extname(record.path).toLowerCase() === '.cue' ||
    (Object.hasOwn(record, '_cueValidationError') && record._cueValidationError !== '') ||
    CUE_SNAPSHOT_FIELDS.some(key => Object.hasOwn(record, key));
}

function existingContextScopeOption(options) {
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return {kind: 'invalid'};
    const field = Object.getOwnPropertyDescriptor(options, 'existingContextScope');
    if (!field) return {kind: 'absent'};
    return Object.hasOwn(field, 'value') ? {kind: 'value', scope: field.value} : {kind: 'invalid'};
  } catch {return {kind: 'invalid'};}
}

function ordinaryExistingContext(location) {
  const file = location.path;
  if (!EXISTING_CONTEXT_AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase()) || /[|<>?*]/u.test(file) || /[a-z][a-z0-9+.-]*:\/\//iu.test(file) ||
      file.replace(/^[A-Za-z]:/u, '').includes(':')) return false;
  return !file.split(/[\\/]/u).some(segment => EXISTING_CONTEXT_CONTAINERS.has(path.extname(segment).toLowerCase()));
}

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
    sampleRate: null, bitsPerSample: null, channels: null, coverUrl: '', coverThumbnailUrl: '', coverLargeUrl: '', coverSource: '', valid: false,
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
  if (typeof record._cuePath === 'string' && record._cuePath) result.cueTrack = true;
  return result;
}

function uniqueIds(ids, records) {
  return [...new Set(orderedIds(ids, records))];
}

function orderedIds(ids, records) {
  if (!Array.isArray(ids)) throw new TypeError('trackIds must be an array.');
  return ids.filter(id => typeof id === 'string' && records.has(id));
}

function createLibraryService({ dataDir, onUpdate, onDelta, returnDeltas = false, shell, supportsSubsongs = true, fileSystem = fs, metadataParser, backupLimit = 5, coverTransform, cueInspector, verifyExistingContextScope } = {}) {
  if (!dataDir) throw new TypeError('A library dataDir is required.');
  const storage = createLibraryStorage({ dataDir, fileSystem, backupLimit });
  const { coversDir } = storage;
  const localCovers = createLocalCoverService({storage, fileSystem, coverTransform});
  const inspectCue = createCueReader({fileSystem});
  const cueOperations = new Map();
  let records = new Map();
  let playlists = [];
  let folders = [];
  let excludedTrackIds = new Set();
  let importedPlaylistIds = new Set();
  let initialization;
  let initializationAvailable = false;
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
  let cuePlaybackRecordTokens = new Map();
  let cuePlaybackPublication = {};
  let transaction;
  const parseCache = new Map();
  const coverWitnesses = new WeakMap();
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
    let playbackChanged = folders !== publishedFolders;
    if (changes) {
      for (const id of changes.recordUndo.keys()) {
        const before = publishedRecords.get(id), after = records.get(id);
        if (!after) {if (cuePlaybackRecordTokens.delete(id)) playbackChanged = true;}
        else if (!cuePlaybackRecordTokens.has(id) || !sameCuePlaybackAssociation(before, after)) {cuePlaybackRecordTokens.set(id, {}); playbackChanged = true;}
      }
    } else {
      const tokens = new Map();
      for (const [id, record] of records) {
        const previous = cuePlaybackRecordTokens.get(id);
        const token = previous && sameCuePlaybackAssociation(publishedRecords.get(id), record) ? previous : {};
        if (token !== previous) playbackChanged = true;
        tokens.set(id, token);
      }
      if (tokens.size !== cuePlaybackRecordTokens.size) playbackChanged = true;
      cuePlaybackRecordTokens = tokens;
    }
    if (playbackChanged) cuePlaybackPublication = {};
    if (changes) {
      for (const id of changes.recordUndo.keys()) {
        const beforeCovers = new Set(coverUrls(publishedRecords.get(id))), afterCovers = new Set(coverUrls(records.get(id)));
        for (const url of beforeCovers) if (!afterCovers.has(url)) changeCoverReference(url, -1);
        for (const url of afterCovers) if (!beforeCovers.has(url)) changeCoverReference(url, 1);
        if (records.has(id)) { publishedRecords.set(id, records.get(id)); for (const url of afterCovers) publishedCoverUrls.add(url); }
        else publishedRecords.delete(id);
      }
    } else {
      publishedRecords = new Map(records);
      coverReferences = new Map();
      for (const record of records.values()) for (const url of coverUrls(record)) { publishedCoverUrls.add(url); changeCoverReference(url, 1); }
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
      for (const key of ['error', 'metadataError', 'metadataSource', 'source', 'sourceScope', '_sourceSize', '_sourceMtime', '_foobarMetadata', '_foobarSupported', '_fileValid', '_cueMetadata', '_cueVerified', '_cuePath', '_cueAuthorizationRoot', '_cueContentHash', '_cueSafetyHash', '_cueTrackCount', '_cueValidationError']) if (item[key] !== undefined) restored[key] = item[key];
      for (const key of ['coverUrl', 'coverThumbnailUrl', 'coverLargeUrl', '_embeddedCoverUrl']) if (typeof item[key] === 'string' && COVER_URL.test(item[key])) restored[key] = item[key];
      if (['embedded', 'sidecar'].includes(item.coverSource)) restored.coverSource = item.coverSource;
      if (item._coverVariants && typeof item._coverVariants === 'object') {
        restored._coverVariants = {};
        for (const size of ['thumbnail', 'large']) {
          const value = item._coverVariants[size];
          if (typeof value?.key === 'string' && /^[a-f0-9]{64}:\d+:\d+:\d+$/.test(value.key) && typeof value.url === 'string' && COVER_URL.test(value.url)) restored._coverVariants[size] = {key: value.key, url: value.url};
        }
      }
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
      if (!stored) { publish(); initializationAvailable = true; return; }
      revision = Number.isSafeInteger(stored.revision) && stored.revision >= 0 ? stored.revision : 0;
      ({ records, playlists, folders, excludedTrackIds, importedPlaylistIds } = restored);
      publish();
      initializationAvailable = true;
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

  async function getCuePlaybackRequests(input, options = {}) {
    const locations = cuePlaybackLocations(input);
    const scopeOption = existingContextScopeOption(options);
    const open = () => {if (closed) throw cuePlaybackFailure('closed');};
    open();
    // Reading a playback guard never starts initialization/recovery or queues
    // behind a mutable import. Only an already-started initialization is awaited.
    if (!initialization) throw cuePlaybackFailure('not-initialized');
    try {await initialization;} catch (cause) {throw cuePlaybackFailure('not-initialized', cause);}
    open();
    if (!initializationAvailable) throw cuePlaybackFailure('not-initialized');
    const selected = new Map(), groups = new Map(), requiredRoots = new Set(), scopedLocations = new Map();
    const folderRoots = new Set(publishedFolders.map(cuePlaybackPath));
    const publishedCuePaths = () => {
      const paths = new Set();
      for (const record of publishedRecords.values()) if (cueAssociated(record)) paths.add(canonicalPath(record.path));
      return paths;
    };
    let associatedPaths, associatedPublication;
    const cuePaths = () => {
      if (!associatedPaths || associatedPublication !== cuePlaybackPublication) {associatedPaths = publishedCuePaths(); associatedPublication = cuePlaybackPublication;}
      return associatedPaths;
    };
    const verifyScopedLocation = location => {
      if (!ordinaryExistingContext(location) || cuePaths().has(canonicalPath(location.path))) throw cuePlaybackFailure('unknown-location');
      if (scopeOption.kind === 'absent') throw cuePlaybackFailure('unknown-location');
      if (scopeOption.kind !== 'value' || typeof verifyExistingContextScope !== 'function') throw cuePlaybackFailure('existing-context-scope-invalid');
      let verified;
      try {verified = verifyExistingContextScope(scopeOption.scope, location);} catch {throw cuePlaybackFailure('existing-context-scope-invalid');}
      if (verified !== true) {
        // Consume rejection only for a real Promise; do not assimilate/call an
        // arbitrary thenable. Async verifiers never grant a synchronous scope.
        if (verified && (typeof verified === 'object' || typeof verified === 'function')) {
          try {void Promise.prototype.then.call(verified, () => {}, () => {});} catch {}
        }
        throw cuePlaybackFailure('existing-context-scope-invalid');
      }
    };
    for (const location of locations) {
      const id = trackId(location.path, location.subsong), record = publishedRecords.get(id);
      if (!record || canonicalPath(record.path) !== canonicalPath(location.path) || record.subsong !== location.subsong) {
        const key = `${location.path}\0${location.subsong}`;
        if (!scopedLocations.has(key)) {
          const receipt = Object.freeze({...location});
          verifyScopedLocation(receipt); scopedLocations.set(key, receipt);
        }
        continue;
      }
      selected.set(id, cuePlaybackRecordTokens.get(id));
      if (!cueAssociated(record)) continue;
      if (location.path !== record.path || record.path !== cuePlaybackPath(record.path)) throw cuePlaybackFailure('unknown-location');
      if (record._cueVerified !== true || record.supported !== true || record._fileValid !== true ||
          (Object.hasOwn(record, '_cueValidationError') && record._cueValidationError !== '')) throw cuePlaybackFailure('unverified-cue');
      if (!localAbsolutePath(record.path) || !localAbsolutePath(record._cuePath) || record._cuePath !== cuePlaybackPath(record._cuePath) || path.extname(record._cuePath).toLowerCase() !== '.cue' ||
          (path.extname(record.path).toLowerCase() === '.cue' && record.path !== record._cuePath) ||
          typeof record._cueContentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(record._cueContentHash) ||
          typeof record._cueSafetyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(record._cueSafetyHash) ||
          !Number.isSafeInteger(record._cueTrackCount) || record._cueTrackCount < 1 || record._cueTrackCount > 99 ||
          !Object.hasOwn(record, '_cueAuthorizationRoot') || (record._cueAuthorizationRoot !== '' &&
            (!localAbsolutePath(record._cueAuthorizationRoot) || record._cueAuthorizationRoot !== cuePlaybackPath(record._cueAuthorizationRoot)))) throw cuePlaybackFailure('invalid-cue-snapshot');
      const cuePath = path.resolve(record._cuePath), root = record._cueAuthorizationRoot;
      if (root && (!folderRoots.has(cuePlaybackPath(root)) || !cuePlaybackWithin(root, cuePath))) throw cuePlaybackFailure('authorization-mismatch');
      if (root) requiredRoots.add(cuePlaybackPath(root));
      const key = cuePlaybackPath(cuePath), previous = groups.get(key);
      const snapshot = {path: cuePath, authorizationRoot: root, contentHash: record._cueContentHash, safetyHash: record._cueSafetyHash, trackCount: record._cueTrackCount};
      if (previous && (previous.snapshot.authorizationRoot !== root ||
          previous.snapshot.contentHash !== snapshot.contentHash || previous.snapshot.safetyHash !== snapshot.safetyHash || previous.snapshot.trackCount !== snapshot.trackCount)) throw cuePlaybackFailure('invalid-cue-snapshot');
      if (!previous) groups.set(key, {snapshot, selectedPaths: new Set([cuePlaybackPath(location.path)])});
      else previous.selectedPaths.add(cuePlaybackPath(location.path));
    }
    let checkedPublication = cuePlaybackPublication;
    const check = () => {
      open();
      for (const location of scopedLocations.values()) verifyScopedLocation(location);
      if (checkedPublication === cuePlaybackPublication) return;
      for (const [id, token] of selected) if (!token || cuePlaybackRecordTokens.get(id) !== token) throw cuePlaybackFailure('record-changed');
      const currentRoots = new Set(publishedFolders.map(cuePlaybackPath));
      for (const root of requiredRoots) if (!currentRoots.has(root)) throw cuePlaybackFailure('authorization-mismatch');
      checkedPublication = cuePlaybackPublication;
    };
    const inspectPlaybackCue = createCueReader({fileSystem});
    for (const group of groups.values()) {
      let prepared;
      try {prepared = await inspectPlaybackCue(group.snapshot.path, {authorizationRoot: group.snapshot.authorizationRoot || undefined});}
      catch (cause) {check(); throw cuePlaybackFailure('cue-files-unavailable', cause);}
      check();
      const request = prepared.request, snapshot = group.snapshot;
      const effectiveRoot = snapshot.authorizationRoot || path.dirname(snapshot.path);
      if (cuePlaybackPath(request.path) !== cuePlaybackPath(snapshot.path) || cuePlaybackPath(request.authorizationRoot) !== cuePlaybackPath(effectiveRoot) ||
          !cuePlaybackWithin(effectiveRoot, request.path) || request.references.some(file => !cuePlaybackWithin(effectiveRoot, file) ||
            (!snapshot.authorizationRoot && cuePlaybackPath(path.dirname(file)) !== cuePlaybackPath(path.dirname(snapshot.path))))) throw cuePlaybackFailure('authorization-mismatch');
      if (request.contentHash !== snapshot.contentHash) throw cuePlaybackFailure('cue-content-changed');
      if (prepared.safetyHash !== snapshot.safetyHash) throw cuePlaybackFailure('cue-references-changed');
      if (request.trackCount !== snapshot.trackCount) throw cuePlaybackFailure('cue-track-count-changed');
      const allowed = new Set([request.path, ...request.references].map(cuePlaybackPath));
      for (const file of group.selectedPaths) if (!allowed.has(file)) throw cuePlaybackFailure('selection-not-in-cue');
      group.prepared = prepared;
    }
    for (const group of groups.values()) {
      try {await group.prepared.recheck();}
      catch (cause) {check(); throw cuePlaybackFailure('cue-files-unavailable', cause);}
      check();
    }
    check();
    return [...groups.values()].map(group => structuredClone(group.prepared.request));
  }

  function applySupport(record) {
    const extension = path.extname(record.path).toLowerCase();
    const container = extension === '.iso' || extension === '.cue';
    record.supported = !record._cueValidationError && record.subsong !== null && record._foobarSupported !== false && ((!container && record.subsong === 0) || (supportsSubsongs && (record.source === 'foobar2000' || record._cueVerified === true)));
    record.playbackUnsupportedReason = record.supported ? '' : record._foobarSupported === false || record.subsong === null
      ? 'foobar2000 did not expose a valid exact subsong identifier for this entry.'
      : record._cueValidationError || 'Import this container or subsong from an existing foobar2000 playlist so its exact track selection can be verified.';
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
        initializationAvailable = true;
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
        cueOperations.clear();
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
    return localCovers.save(picture.data);
  }

  async function readTrack(filePath, subsong = 0, foobarMetadata, force = false, cueMetadata) {
    const base = emptyTrack(filePath, subsong);
    const previous = records.get(base.id);
    const sourceMetadata = foobarMetadata ? cleanMetadata(foobarMetadata) : previous?._foobarMetadata || (cueMetadata ? cleanMetadata(cueMetadata) : previous?._cueMetadata);
    const sourceSupported = foobarMetadata ? foobarMetadata.supported !== false && normalizeSubsong(foobarMetadata.subsong) !== null : previous?._foobarSupported;
    const foobarSource = Boolean(foobarMetadata || previous?._foobarMetadata);
    const sourceFields = sourceMetadata ? foobarSource
      ? {source: 'foobar2000', sourceScope: 'existing-playlists', metadataSource: 'foobar2000', _foobarMetadata: sourceMetadata, _foobarSupported: sourceSupported, ...(foobarMetadata ? {_cueValidationError: ''} : {})}
      : {source: 'cue', sourceScope: 'explicit-import', metadataSource: 'cue', _cueMetadata: sourceMetadata} : {};
    const cueFields = {};
    for (const key of ['_cueVerified', '_cuePath', '_cueAuthorizationRoot', '_cueContentHash', '_cueSafetyHash', '_cueTrackCount', '_cueValidationError']) if (previous?.[key] !== undefined) cueFields[key] = previous[key];
    let stat;
    try { stat = await fileSystem.stat(base.path); if (!stat.isFile()) throw new Error('This path is not a regular file.'); }
    catch (error) {
      return applySupport({ ...(previous || base), ...(sourceMetadata || {}), ...sourceFields, _fileValid: false, valid: false, error: `File unavailable: ${error.message}` });
    }
    if (!force && previous && previous._fileValid && previous._sourceSize === stat.size && previous._sourceMtime === stat.mtimeMs) {
      const reused = applySupport({
        ...previous,
        ...(foobarMetadata || cueMetadata ? sourceMetadata : {}),
        ...(foobarMetadata || cueMetadata ? sourceFields : {}),
      });
      const embedded = previous._embeddedCoverUrl || (previous.coverSource !== 'sidecar' ? previous.coverUrl : '');
      return localCovers.decorate(reused, embedded);
    }
    let record = { ...base, ...cueFields, ...(sourceMetadata || {}), ...sourceFields, _sourceSize: stat.size, _sourceMtime: stat.mtimeMs };
    let embeddedUrl = '';
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
      if (base.subsong > 0 || cueMetadata || previous?._cueVerified || ['.cue', '.iso'].includes(path.extname(base.path).toLowerCase())) {
        for (const key of ['title', 'artist', 'album', 'albumArtist', 'duration', 'trackNumber', 'discNumber', 'year', 'genre']) delete extracted[key];
      }
      record = { ...record, ...extracted, metadataSource: sourceMetadata && (base.subsong > 0 || cueMetadata) ? foobarSource ? 'foobar2000' : 'cue' : 'file', _fileValid: true, valid: true, error: '', metadataError: '' };
      embeddedUrl = metadata.coverUrl;
    } catch (error) {
      record._fileValid = true;
      record.error = `Metadata could not be read: ${error.message}`;
      record.metadataError = record.error;
      record.valid = true;
    }
    return applySupport(await localCovers.decorate(record, embeddedUrl));
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

  async function indexCue(cuePath, {explicit = true, authorizationRoot} = {}) {
    const resolved = path.resolve(cuePath), key = canonicalPath(resolved);
    if (cueOperations.has(key)) return cueOperations.get(key);
    const operation = (async () => {
      const existing = [...records.values()].filter(record => record._cuePath && canonicalPath(record._cuePath) === key || canonicalPath(record.path) === key);
      const verified = existing.filter(record => record._cueVerified === true);
      const rememberedRoot = verified.find(record => record._cueAuthorizationRoot)?._cueAuthorizationRoot;
      const authorized = authorizationRoot || rememberedRoot || undefined;
      let prepared, items, failure;
      try {
        prepared = await inspectCue(resolved, {authorizationRoot: authorized});
        const unchanged = verified.length > 0 && (!explicit || verified.length === prepared.request.trackCount) && verified.every(record => record._cueTrackCount === prepared.request.trackCount && record._cueContentHash === prepared.request.contentHash && record._cueSafetyHash === prepared.safetyHash);
        if (unchanged) items = verified.map(record => ({...record, supported: true}));
        else {
          if (typeof cueInspector !== 'function') throw new Error('CUE discovery is unavailable; import an existing foobar2000 playlist for verified exact subsongs.');
          items = validateCueItems(await cueInspector(structuredClone(prepared.request)), prepared.request);
        }
        await prepared.recheck();
      } catch (error) { failure = error; }
      if (failure) {
        const reason = `CUE requires verified discovery or an existing foobar2000 playlist: ${failure.message}`;
        if (existing.length) {
          for (const record of existing) {
            let valid = false, error = '';
            try {const stat = await fileSystem.lstat(record.path); valid = stat.isFile() && !stat.isSymbolicLink(); if (!valid) error = 'File unavailable: this path is not a regular file.';}
            catch (failure) {error = `File unavailable: ${failure.message}`;}
            setRecord(applySupport({...record, _fileValid: valid, error, ...(record.source === 'foobar2000' ? {} : {_cueVerified: false, _cueValidationError: reason})}));
          }
        } else if (explicit || !excludedTrackIds.has(trackId(resolved))) {
          const base = emptyTrack(resolved);
          let valid = false;
          try {const stat = await fileSystem.lstat(resolved); valid = stat.isFile() && !stat.isSymbolicLink();} catch {}
          if (explicit) setMembership(excludedTrackIds, base.id, false);
          setRecord(applySupport({...base, source: 'cue', sourceScope: 'explicit-import', _cuePath: resolved,
            _cueAuthorizationRoot: authorized || '', _cueVerified: false, _cueValidationError: reason, _fileValid: valid}));
        }
        return;
      }
      const accepted = new Set();
      for (const item of items) {
        const id = trackId(item.path, item.subsong);
        accepted.add(id);
        if (explicit) setMembership(excludedTrackIds, id, false);
        else if (excludedTrackIds.has(id)) continue;
        const record = await readTrack(item.path, item.subsong, undefined, false, item);
        setRecord(applySupport({...record, _cueVerified: true, _cuePath: resolved, _cueAuthorizationRoot: authorized || '',
          _cueContentHash: prepared.request.contentHash, _cueSafetyHash: prepared.safetyHash, _cueTrackCount: prepared.request.trackCount, _cueValidationError: ''}));
      }
      await prepared.recheck();
      for (const record of existing) {
        if (accepted.has(record.id) || record.source === 'foobar2000') continue;
        if (!record._cueVerified && record.path === resolved && record.subsong === 0 && !record._cueContentHash) deleteRecord(record.id);
        else setRecord(applySupport({...record, _cueVerified: false, _cueValidationError: 'The backend no longer verifies this exact CUE track.'}));
      }
    })();
    cueOperations.set(key, operation);
    return operation;
  }

  async function indexPaths(filePaths, explicit = true, authorizationRoot) {
    for (const filePath of filePaths) {
      if (typeof filePath !== 'string' || !filePath.trim()) continue;
      const resolved = path.resolve(filePath);
      if (!AUDIO_EXTENSIONS.has(path.extname(resolved).toLowerCase())) continue;
      if (path.extname(resolved).toLowerCase() === '.cue') {await indexCue(resolved, {explicit, authorizationRoot}); continue;}
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

  function emptyCoverPlan() {
    return {kind: 'library-cover-collection', revision, candidates: [], skipped: [], retainedCount: 0, referenceCounts: Object.fromEntries(coverReferences)};
  }

  function exactCoverIdentity(stat) {
    const {dev, ino, size} = stat;
    if ([dev, ino, size].some(value => typeof value !== 'bigint' || value < 0n)) {
      throw new Error('An exact managed cover identity is unavailable.');
    }
    return Object.freeze({dev, ino, size});
  }

  function matchesCoverIdentity(stat, expected) {
    const actual = exactCoverIdentity(stat);
    return Boolean(expected && actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size);
  }

  async function retainRecoveryCovers(plan, check = () => {}) {
    check();
    // Recovery copies can be the only remaining owner of an older cover URL,
    // even after a later startup publishes a healthy empty database. Names are
    // persistent conservative markers, not deletion-authorized backup records.
    try {await storage.assertDirectories(storage.root);}
    catch {plan.recoveryRetention = 'recovery-status-unavailable'; check(); return true;}
    check();
    let entries;
    try {entries = await fileSystem.readdir(storage.root, {withFileTypes: true});}
    catch {plan.recoveryRetention = 'recovery-status-unavailable'; check(); return true;}
    // Do not follow links, inspect entry types or open any backup contents.
    try {
      if (!Array.isArray(entries) || entries.some(entry => typeof entry?.name !== 'string')) plan.recoveryRetention = 'recovery-status-unavailable';
      else if (entries.some(entry => /^library-(?:corrupt|reset)-/i.test(entry.name))) plan.recoveryRetention = 'recovery-backup-present';
    } catch {plan.recoveryRetention = 'recovery-status-unavailable';}
    check();
    return Boolean(plan.recoveryRetention);
  }

  async function* coverCandidates({ retainUrls = [] } = {}, check = () => {}, plan, {sorted = true} = {}) {
    check();
    if (!Array.isArray(retainUrls) || retainUrls.some(url => typeof url !== 'string')) throw new TypeError('Retained cover URLs must be an array of strings.');
    if (await retainRecoveryCovers(plan, check)) return;
    check();
    await storage.assertDirectories(coversDir);
    check();
    await storage.assertDatabaseUnchanged();
    check();
    const retained = new Set([...(closed ? [] : publishedCoverUrls), ...coverReferences.keys(), ...retainUrls]);
    plan.retainedCount = retained.size;
    const entries = await fileSystem.readdir(coversDir, { withFileTypes: true });
    check();
    // Legacy explicit plans keep their deterministic order. A bounded shutdown
    // does not sort a potentially huge directory before checking its budget.
    if (sorted) entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      check();
      if (!/^[a-f0-9]{64}\.(?:jpg|png|gif|webp)$/.test(entry.name)) continue;
      if (retained.has(`still-cover://art/${entry.name}`)) continue;
      const target = path.join(coversDir, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) { plan.skipped.push({ filename: entry.name, reason: 'not-independent-file' }); continue; }
      let candidate;
      try {
        const {bytes, stat} = await storage.readRegular(target, {withIdentity: true});
        check();
        storage.assertRegular(stat, target);
        const witness = exactCoverIdentity(stat);
        if (witness.size !== BigInt(bytes.length)) throw new Error('The managed cover changed while being planned.');
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.name.slice(0, 64) || imageExtension(bytes) !== path.extname(entry.name).slice(1)) { plan.skipped.push({ filename: entry.name, reason: 'content-does-not-match-managed-name' }); continue; }
        // Exact identity authorizes deletion only through this private witness.
        // Public dev/ino are decimal strings so plans/results remain JSON-safe.
        candidate = { filename: entry.name, path: target, bytes: bytes.length, dev: witness.dev.toString(), ino: witness.ino.toString() };
        coverWitnesses.set(candidate, witness);
      } catch (error) {
        check();
        plan.skipped.push({ filename: entry.name, reason: error.code || error.message });
      }
      if (candidate) yield candidate;
    }
  }

  async function planCoverCollection(options = {}, check = () => {}) {
    const plan = emptyCoverPlan();
    for await (const candidate of coverCandidates(options, check, plan)) plan.candidates.push(candidate);
    return plan;
  }

  async function collectCovers(options = {}, state, budget) {
    // Always re-plan under the same transaction queue; an earlier reviewed plan
    // cannot authorize deletion of a cover that a later commit started using.
    const stopped = Symbol('cover-collection-stopped'), retained = Symbol('cover-recovery-retained');
    let plan = emptyCoverPlan(), admitted = 0, interrupted = false;
    const check = () => {
      const allowed = budget.allowed();
      if (plan.recoveryRetention) throw retained;
      if (!allowed) throw stopped;
    };
    const removed = [], errors = [];
    try {
      state.phase = 'planning';
      // Unbounded explicit collection preserves its complete deterministic plan.
      // A shutdown budget instead consumes one validated candidate at a time:
      // planning later candidates must not starve every physical deletion.
      if (budget.unbounded) plan = await planCoverCollection(options, check);
      check();
      const candidates = budget.unbounded ? plan.candidates : coverCandidates(options, check, plan, {sorted: false});
      for await (const item of candidates) {
        if (!budget.unbounded) plan.candidates.push(item);
        state.phase = 'collecting';
        try {
          check();
          if (admitted >= budget.maxDeletes) {interrupted = true; break;}
          await storage.assertDirectories(coversDir);
          check();
          const stat = await fileSystem.lstat(item.path, {bigint: true});
          check();
          storage.assertRegular(stat, item.path);
          const witness = coverWitnesses.get(item);
          if (!matchesCoverIdentity(stat, witness)) throw new Error('The managed cover changed after collection planning.');
          const {bytes, stat: readStat} = await storage.readRegular(item.path, {withIdentity: true});
          check();
          if (!matchesCoverIdentity(readStat, witness)) throw new Error('The managed cover changed before collection.');
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.filename.slice(0, 64)) throw new Error('The managed cover changed before collection.');
          if (await retainRecoveryCovers(plan, check)) break;
          check();
          // Recovery scanning can yield to another service's commit. Keep the
          // database witness as the final await before synchronous admission.
          await storage.assertDatabaseUnchanged();
          check();
          // This counter represents actual submitted IO. Aborting never clears it:
          // only the physical unlink promise settling can revoke this authority.
          admitted++; state.pendingDeletes++;
          try {await fileSystem.unlink(item.path);}
          finally {state.pendingDeletes--;}
          removed.push(item.filename);
        } catch (error) {
          if (error === retained) break;
          if (error === stopped) {interrupted = true; break;}
          errors.push({ filename: item.filename, message: error.message });
        }
        if (admitted >= budget.maxDeletes) {interrupted = true; break;}
        if (!budget.unbounded) state.phase = 'planning';
      }
    } catch (error) {
      if (error !== stopped && error !== retained) throw error;
      interrupted = error === stopped;
    }
    return { ...plan, removed, errors, ...(interrupted ? {interrupted: true} : {}) };
  }

  function startCoverCollection(options = {}) {
    const state = {phase: 'queued', pendingDeletes: 0, settled: false};
    // Capture remaining wall-clock time once. Clock rollback cannot extend this
    // operation's deadline; the shutdown caller also owns an independent timer.
    const startedAt = performance.now(), wallStartedAt = Date.now();
    let captured, budget, validationError, sealed = false;
    try {
      const {retainUrls = [], signal, deadlineAt = Infinity, maxDeletes = Infinity} = options;
      if (!Array.isArray(retainUrls) || retainUrls.some(url => typeof url !== 'string')) throw new TypeError('Retained cover URLs must be an array of strings.');
      if (deadlineAt !== Infinity && (typeof deadlineAt !== 'number' || !Number.isFinite(deadlineAt))) throw new TypeError('The cover collection deadline must be a finite timestamp or Infinity.');
      if (maxDeletes !== Infinity && (!Number.isSafeInteger(maxDeletes) || maxDeletes < 0)) throw new TypeError('The cover deletion limit must be a non-negative integer or Infinity.');
      if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean')) throw new TypeError('The cover collection signal must be an AbortSignal.');
      const monotonicDeadline = deadlineAt === Infinity ? Infinity : startedAt + Math.max(0, deadlineAt - wallStartedAt);
      captured = {retainUrls: [...retainUrls]};
      budget = {maxDeletes, unbounded: signal === undefined && deadlineAt === Infinity && maxDeletes === Infinity,
        allowed: () => {
          if (sealed || maxDeletes === 0 || signal?.aborted || Date.now() >= deadlineAt || performance.now() >= monotonicDeadline) {sealed = true; return false;}
          return true;
        }};
    } catch (error) {validationError = error;}
    const task = coverMaintenance(() => {
      if (validationError) throw validationError;
      return collectCovers(captured, state, budget);
    });
    const settled = () => {state.phase = 'settled'; state.settled = true;};
    const operation = task.then(value => {settled(); return value;}, error => {settled(); throw error;});
    Object.defineProperty(operation, 'getState', {value: () => Object.freeze({...state})});
    return operation;
  }

  return {
    initialize(options) {
      if (closed && !initialization) return Promise.reject(new Error('The music library has been closed.'));
      return initialize(options);
    },
    reset, list, getStatus, getCuePlaybackRequests,
    planCoverCollection(options) { return coverMaintenance(() => planCoverCollection(options)); },
    collectCovers: startCoverCollection,
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
        await indexPaths(await discover(resolved), true, resolved);
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
        const cueRecords = [...records.values()].filter(record => record._cuePath);
        for (const record of cueRecords) await indexCue(record._cuePath, {explicit: false, authorizationRoot: record._cueAuthorizationRoot || undefined});
        for (const record of records.values()) if (!record._cuePath) setRecord(await readTrack(record.path, record.subsong));
        for (const folder of folders) await indexPaths(await discover(folder, { strict: false }), false, folder);
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
    async close() { closed = true; await pending; if (initialization) await initialization; parseCache.clear(); cueOperations.clear(); localCovers.clear(); publishedCoverUrls.clear(); },
  };
}

module.exports = { createLibraryService, AUDIO_EXTENSIONS, canonicalPath, trackId };
