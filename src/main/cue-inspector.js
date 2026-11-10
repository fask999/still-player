'use strict';

// Metadata discovery has a separate, short-lived portable profile. This module
// does not import Electron/main, adopt the playback manager, or expose playback.
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {createRequire} = require('node:module');
const {createMediaFileReader, normalized, isWithin} = require('./media-file-safety');
const {createCueReader, validateCueItems, CUE_LIMITS} = require('./cue-import');

const LIMITS = Object.freeze({deadlineMs: 60000, requestMs: 2000, responseBytes: 1024 * 1024,
  pending: 16, retainedRuns: 4, cacheBytes: 128 * 1024 * 1024, runReservationBytes: 32 * 1024 * 1024,
  treeEntries: 2048, treeDepth: 32, nativePathChars: 259, pollMs: 80});
// Official SDK output.cpp, output_id_null. A display name or a default device
// GUID is never evidence of Null output. The device GUID must be enumerated.
const NULL_PROVIDER = 'EEEB07DE-C2C8-44C2-985C-C85856D96DA1';
const GUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const NULL_DEVICE = new RegExp(`^${NULL_PROVIDER}:${GUID}$`, 'i');
const COLUMNS = Object.freeze(['%path%', '%subsong%', '[%title%]', '[%artist%]', '[%album%]',
  '%length_seconds_fp%', '[%codec%]', '[%samplerate%]', '[$info(bitspersample)]',
  '[$info(channels)]', '[%album artist%]', '[%tracknumber%]', '[%discnumber%]']);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message, extra) => Object.assign(new Error(message), {code, ...extra});
const assert = (condition, code, message) => {if (!condition) throw fail(code, message);};
const exact = (value, keys) => Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
const dirIdentity = stat => [stat.dev, stat.ino, stat.birthtimeNs].map(String).join(':');
const fileIdentity = stat => [dirIdentity(stat), stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
const cancelled = () => fail('ERR_CUE_INSPECTOR_CANCELLED', 'CUE metadata discovery was cancelled.');

function absolute(value) {
  assert(typeof value === 'string' && path.isAbsolute(value) && value === path.normalize(value) &&
    !/[\0-\x1f]/u.test(value) && !value.split(/[\\/]/u).includes('..') &&
    !/^\\\\[?.]\\/u.test(value) && !/:/u.test(value.replace(/^[A-Za-z]:/u, '')),
  'ERR_CUE_INSPECTOR_REQUEST', 'CUE discovery requires canonical authorized absolute paths.');
  return path.resolve(value);
}
function snapshotRequest(value) {
  assert(exact(value, ['path', 'references', 'trackCount', 'authorizationRoot', 'encoding', 'contentHash']) &&
    Array.isArray(value.references) && value.references.length > 0 && value.references.length <= CUE_LIMITS.maxReferences &&
    Number.isInteger(value.trackCount) && value.trackCount > 0 && value.trackCount <= CUE_LIMITS.maxTracks &&
    ['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(value.encoding) && /^[a-f0-9]{64}$/u.test(value.contentHash),
  'ERR_CUE_INSPECTOR_REQUEST', 'CUE preflight evidence is incomplete.');
  const result = {...value, path: absolute(value.path), authorizationRoot: absolute(value.authorizationRoot), references: value.references.map(absolute)};
  assert(path.extname(result.path).toLowerCase() === '.cue' && isWithin(result.authorizationRoot, result.path) &&
    result.references.every(name => isWithin(result.authorizationRoot, name)) &&
    new Set(result.references.map(normalized)).size === result.references.length,
  'ERR_CUE_INSPECTOR_REQUEST', 'CUE paths do not match one authorized subtree.');
  return Object.freeze({...result, references: Object.freeze(result.references)});
}
function sameRequest(a, b) {
  return normalized(a.path) === normalized(b.path) && normalized(a.authorizationRoot) === normalized(b.authorizationRoot) &&
    a.contentHash === b.contentHash && a.encoding === b.encoding && a.trackCount === b.trackCount &&
    a.references.length === b.references.length && a.references.every((name, index) => normalized(name) === normalized(b.references[index]));
}
function sameOutput(a, b) {return a?.typeId === b?.typeId && typeof a?.deviceId === 'string' && typeof b?.deviceId === 'string' && a.deviceId.toLowerCase() === b.deviceId.toLowerCase();}
function nullOutput(outputs) {
  assert(outputs && Array.isArray(outputs.types) && outputs.types.length <= 32, 'ERR_CUE_INSPECTOR_NULL_OUTPUT', 'Null output enumeration is invalid.');
  const found = []; let count = 0;
  for (const type of outputs.types) {
    assert(type && typeof type.id === 'string' && Array.isArray(type.devices) && type.devices.length <= 256,
      'ERR_CUE_INSPECTOR_NULL_OUTPUT', 'Null output enumeration is invalid.');
    for (const device of type.devices) {
      assert(++count <= 512 && device && typeof device.id === 'string' && device.id.length <= 500,
        'ERR_CUE_INSPECTOR_NULL_OUTPUT', 'Null output enumeration is invalid.');
      if (type.id === 'output' && NULL_DEVICE.test(device.id)) found.push({typeId: type.id, deviceId: device.id});
    }
  }
  assert(found.length === 1, 'ERR_CUE_INSPECTOR_NULL_OUTPUT', 'One verified built-in Null output is required.');
  return found[0];
}
function metadata(columns) {
  assert(Array.isArray(columns) && columns.length === COLUMNS.length && columns.every(value =>
    typeof value === 'string' && value.length <= 8192 && !/\0/u.test(value)), 'ERR_CUE_INSPECTOR_ITEMS', 'CUE metadata columns are invalid.');
  const text = index => columns[index] === '?' ? '' : columns[index];
  const number = index => columns[index] !== '' && columns[index] !== '?' && Number.isFinite(Number(columns[index])) ? Number(columns[index]) : null;
  const subsong = /^[0-9]+$/u.test(columns[1]) ? Number(columns[1]) : null;
  const item = {path: text(0), subsong, title: text(2), artist: text(3), album: text(4), duration: number(5),
    codec: text(6), sampleRate: number(7), bitsPerSample: number(8), channels: number(9),
    albumArtist: text(10), trackNumber: number(11), discNumber: number(12), supported: true};
  assert(Number.isSafeInteger(subsong) && subsong >= 0 && item.duration > 0 && item.codec &&
    Number.isInteger(item.sampleRate) && item.sampleRate > 0 && Number.isInteger(item.channels) && item.channels > 0,
  'ERR_CUE_INSPECTOR_ITEMS', 'The backend did not report supported audio metadata and a real subsong.');
  return item;
}
function pause(ms, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const done = () => {signal.removeEventListener('abort', abort); resolve();};
    const timer = setTimeout(done, ms);
    const abort = () => {clearTimeout(timer); reject(signal.reason);};
    signal.addEventListener('abort', abort, {once: true});
  });
}

function createCueInspector({runtimeRoot = path.resolve(__dirname, '../..'), dataDir, enabled = true, onProgress = () => {}} = {}) {
  // Construction is intentionally synchronous and has no filesystem/process I/O.
  const root = absolute(runtimeRoot), storage = absolute(dataDir), cache = path.join(storage, 'cue-indexer');
  const reader = createMediaFileReader(), readCue = createCueReader();
  let tail = Promise.resolve(), pending = 0, closed = false, closing = null, blocked = null, active = null;
  const retained = new Set();
  const publish = (state, extra = {}) => {
    try {const result = onProgress({state, pending, ...extra}); if (result?.then) Promise.resolve(result).catch(() => {});} catch { /* Observation grants no control. */ }
  };
  async function directory(filename) {
    await reader.assertDirectory(filename);
    const stat = await fs.lstat(filename, {bigint: true});
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'ERR_CUE_INSPECTOR_WORKSPACE', 'The indexer workspace is not an independent directory.');
    return dirIdentity(stat);
  }
  async function ensureDirectory(filename) {
    const parent = path.dirname(filename);
    if (parent !== filename) {
      const stat = await fs.lstat(parent).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
      if (!stat) await ensureDirectory(parent);
      else await directory(parent);
    }
    await fs.mkdir(filename).catch(error => {if (error.code !== 'EEXIST') throw error;});
    return directory(filename);
  }
  async function entries(filename, limit = LIMITS.treeEntries) {
    const values = [];
    for await (const entry of await fs.opendir(filename)) {
      assert(values.length < limit, 'ERR_CUE_INSPECTOR_QUOTA', 'Indexer directory entry quota reached.');
      values.push(entry.name);
    }
    return values;
  }
  async function tree(filename, {includeRoot = false} = {}) {
    const rows = []; let bytes = 0;
    async function visit(target, depth = 0) {
      assert(depth <= LIMITS.treeDepth, 'ERR_CUE_INSPECTOR_QUOTA', 'Indexer directory depth quota reached.');
      await reader.assertDirectory(path.dirname(target));
      const stat = await fs.lstat(target, {bigint: true});
      assert(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile() && stat.nlink === 1n),
        'ERR_CUE_INSPECTOR_WORKSPACE', 'Indexer cache contains a link or an unknown file type; it was retained.');
      assert(rows.length < LIMITS.treeEntries, 'ERR_CUE_INSPECTOR_QUOTA', 'Indexer cache entry quota reached.');
      const row = {path: target, directory: stat.isDirectory(), identity: stat.isDirectory() ? dirIdentity(stat) : fileIdentity(stat)};
      rows.push(row);
      if (stat.isFile()) {bytes += Number(stat.size); assert(Number.isSafeInteger(bytes) && bytes <= LIMITS.cacheBytes,
        'ERR_CUE_INSPECTOR_QUOTA', 'Indexer cache byte quota reached.');}
      else for (const name of await entries(target)) await visit(path.join(target, name), depth + 1);
      const after = await fs.lstat(target, {bigint: true});
      assert((stat.isDirectory() ? fileIdentity(after) === fileIdentity(stat) : fileIdentity(after) === row.identity),
        'ERR_CUE_INSPECTOR_WORKSPACE', 'Indexer cache changed during inspection; it was retained.');
    }
    if (includeRoot) await visit(filename);
    else for (const name of await entries(filename)) await visit(path.join(filename, name));
    return {rows, bytes};
  }
  async function newWorkspace(check) {
    await ensureDirectory(storage); check(); await ensureDirectory(cache); check();
    const cacheIdentity = await directory(cache), names = await entries(cache, LIMITS.retainedRuns);
    assert(names.length < LIMITS.retainedRuns, 'ERR_CUE_INSPECTOR_QUOTA', 'Retained indexer workspaces require inspection before another can be created.');
    const cached = await tree(cache); check();
    assert(cached.bytes + LIMITS.runReservationBytes <= LIMITS.cacheBytes, 'ERR_CUE_INSPECTOR_QUOTA', 'Indexer cache has insufficient space within its byte quota.');
    assert(await directory(cache) === cacheIdentity, 'ERR_CUE_INSPECTOR_WORKSPACE', 'Indexer cache identity changed.');
    const id = randomUUID(), runDir = path.join(cache, id);
    await fs.mkdir(runDir); const identity = await directory(runDir);
    const marker = path.join(runDir, 'cue-inspector-owner.json');
    await fs.writeFile(marker, JSON.stringify({schemaVersion: 1, runId: id}), {flag: 'wx'});
    const witness = await reader.read(marker, {maxBytes: 1024});
    return {id, runDir, identity, cacheIdentity, marker, markerIdentity: witness.identity, markerHash: digest(witness.bytes),
      dataDir: path.join(runDir, 'data'), backendDir: path.join(runDir, 'data/backend/foobar2000')};
  }
  async function assertWorkspace(scope) {
    assert(await directory(cache) === scope.cacheIdentity && await directory(scope.runDir) === scope.identity,
      'ERR_CUE_INSPECTOR_WORKSPACE', 'The owned workspace identity changed; no files were removed.');
    const current = await reader.read(scope.marker, {maxBytes: 1024});
    assert(current.identity === scope.markerIdentity && digest(current.bytes) === scope.markerHash,
      'ERR_CUE_INSPECTOR_WORKSPACE', 'The owned workspace marker changed; no files were removed.');
  }
  async function removeWorkspace(scope) {
    await assertWorkspace(scope);
    // No recursive removal. Inspect the complete tree before the first unlink;
    // then check each original identity and ancestry before removing that entry.
    const {rows} = await tree(scope.runDir, {includeRoot: true});
    await assertWorkspace(scope);
    for (const row of rows.reverse()) {
      assert(await directory(cache) === scope.cacheIdentity && await directory(scope.runDir) === scope.identity,
        'ERR_CUE_INSPECTOR_WORKSPACE', 'Workspace changed during cleanup; remaining files were retained.');
      await reader.assertDirectory(path.dirname(row.path));
      const stat = await fs.lstat(row.path, {bigint: true});
      assert(!stat.isSymbolicLink() && (row.directory ? stat.isDirectory() && dirIdentity(stat) === row.identity :
        stat.isFile() && stat.nlink === 1n && fileIdentity(stat) === row.identity),
      'ERR_CUE_INSPECTOR_WORKSPACE', 'A workspace entry changed during cleanup; remaining files were retained.');
      if (row.directory) await fs.rmdir(row.path); else await fs.unlink(row.path);
    }
  }
  async function runtime(check) {
    await directory(root); check();
    const load = createRequire(path.join(root, 'package.json'));
    const moduleAt = name => {
      const relative = `./src/main/${name}.js`;
      assert(normalized(load.resolve(relative)) === normalized(path.join(root, relative)), 'ERR_CUE_INSPECTOR_RUNTIME', 'Indexer modules must belong to the selected application runtime.');
      return load(relative);
    };
    const sources = [], add = async (relative, pin, maxBytes = 64 * 1024 * 1024) => {
      const filename = path.join(root, relative);
      assert(isWithin(root, filename), 'ERR_CUE_INSPECTOR_RUNTIME', 'A runtime resource escaped the application root.');
      const value = await reader.read(filename, {maxBytes}); check();
      if (pin) assert(value.bytes.length === pin.bytes && digest(value.bytes) === pin.sha256, 'ERR_CUE_INSPECTOR_RUNTIME', 'An indexer source resource differs from its fixed pin.');
      sources.push({filename, identity: value.identity, hash: digest(value.bytes), maxBytes}); return value.bytes;
    };
    await add('src/main/backend-bootstrap.js', null, CUE_LIMITS.maxBytes); await add('src/main/backend.js', null, CUE_LIMITS.maxBytes);
    const bootstrap = moduleAt('backend-bootstrap'), backend = moduleAt('backend');
    let leaseApi;
    try {await add('src/main/cue-read-lease.js', null, CUE_LIMITS.maxBytes); leaseApi = moduleAt('cue-read-lease');}
    catch (cause) {throw fail('ERR_CUE_INSPECTOR_LEASE_UNAVAILABLE', 'A verified Windows read-lease holder is required for native CUE ingestion.', {cause});}
    assert(typeof leaseApi.createCueReadLease === 'function' && typeof leaseApi.isVerifiedCueReadLease === 'function',
      'ERR_CUE_INSPECTOR_LEASE_UNAVAILABLE', 'The read-lease holder interface is unavailable.');
    const manifest = bootstrap.validateBootstrapManifest(JSON.parse((await add('manifests/public-backend.json', null, CUE_LIMITS.maxBytes)).toString('utf8')));
    assert(manifest.schemaVersion === 2 && manifest.deployment === 'extract-original-installer', 'ERR_CUE_INSPECTOR_RUNTIME', 'CUE discovery requires automatic extraction; installer GUI is forbidden.');
    if (process.platform === 'win32') {
      // A short executable path alone does not ensure foobar can load the
      // nested components. Include the complete destination paths before
      // creating a workspace, acquiring the holder or starting a Job.
      const backendDir = path.join(cache, '0'.repeat(36), 'data', 'backend', 'foobar2000');
      const destinations = [...manifest.coreFiles.map(row => row.relativePath), ...manifest.components.map(row => row.targetPath), 'profile/beefweb/config.json'];
      assert(destinations.every(relative => path.join(backendDir, relative).length <= LIMITS.nativePathChars),
        'ERR_CUE_INSPECTOR_NATIVE_PATH_LENGTH', 'STILL 数据目录过深，隔离内核的组件路径过长。请使用较短的数据目录后重新导入 CUE。');
    }
    assert([...manifest.coreFiles, ...manifest.components, ...manifest.components].reduce((total, row) => total + row.bytes, 0) + 4 * 1024 * 1024 <= LIMITS.runReservationBytes,
      'ERR_CUE_INSPECTOR_QUOTA', 'The pinned core exceeds the reserved metadata workspace budget.');
    for (const row of [manifest.installer, ...manifest.extractor.files, ...manifest.components]) await add(row.relativePath || row.sourcePath, row);
    const registry = JSON.parse((await add('src/main/runtime-assets.json', null, 16384)).toString('utf8'));
    assert(registry.schemaVersion === 1 && registry.assets, 'ERR_CUE_INSPECTOR_RUNTIME', 'Runtime asset registry is invalid.');
    for (const [name, relativePath] of [['backendLauncher', 'native/backend-job/StillBackendLauncher.exe'], ['backendOutputPolicy', 'src/main/backend-output-policy.json']]) {
      const pin = registry.assets[name];
      assert(exact(pin, ['relativePath', 'sha256']) && pin.relativePath === relativePath && /^[a-f0-9]{64}$/u.test(pin.sha256), 'ERR_CUE_INSPECTOR_RUNTIME', 'Indexer runtime pin is invalid.');
      const bytes = await add(relativePath);
      assert(digest(bytes) === pin.sha256, 'ERR_CUE_INSPECTOR_RUNTIME', 'Indexer runtime asset differs from its fixed pin.');
    }
    const leaseManifestPath = 'native/cue-read-lease/bin/runtime-manifest.json', leasePin = registry.assets.cueReadLeaseManifest;
    assert(exact(leasePin, ['relativePath', 'sha256']) && leasePin.relativePath === leaseManifestPath && /^[a-f0-9]{64}$/u.test(leasePin.sha256),
      'ERR_CUE_INSPECTOR_LEASE_UNAVAILABLE', 'The read-lease holder has no trusted application runtime pin.');
    const leaseManifestBytes = await add(leaseManifestPath, null, 16384);
    assert(digest(leaseManifestBytes) === leasePin.sha256, 'ERR_CUE_INSPECTOR_RUNTIME', 'The read-lease manifest differs from the trusted runtime pin.');
    const leaseManifest = JSON.parse(leaseManifestBytes.toString('utf8'));
    assert(exact(leaseManifest, ['schemaVersion', 'kind', 'architecture', 'files']) && leaseManifest.schemaVersion === 1 &&
      leaseManifest.kind === 'still-cue-read-lease' && leaseManifest.architecture === 'x64' && Array.isArray(leaseManifest.files) &&
      leaseManifest.files.length === 2 && new Set(leaseManifest.files.map(row => row?.path)).size === 2,
    'ERR_CUE_INSPECTOR_RUNTIME', 'The read-lease manifest schema is invalid.');
    for (const row of leaseManifest.files) {
      assert(exact(row, ['path', 'bytes', 'sha256']) && ['StillCueReadLease.exe', 'NOTICE.txt'].includes(row.path) &&
        Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= 16 * 1024 * 1024 && /^[a-f0-9]{64}$/u.test(row.sha256),
      'ERR_CUE_INSPECTOR_RUNTIME', 'The read-lease holder file pin is invalid.');
      await add(`native/cue-read-lease/bin/${row.path}`, row, 16 * 1024 * 1024);
    }
    return {bootstrap, backend, leaseApi, async recheck() {
      for (const row of sources) {
        const value = await reader.read(row.filename, {maxBytes: row.maxBytes});
        assert(value.identity === row.identity && digest(value.bytes) === row.hash, 'ERR_CUE_INSPECTOR_RUNTIME', 'Indexer source resources changed during discovery.');
      }
    }};
  }
  async function backendFiles(scope, publicFiles, {fresh = false} = {}) {
    await assertWorkspace(scope);
    const allowed = new Set([...publicFiles.map(row => row.relativePath), 'backend-manifest.json', 'profile/beefweb/config.json']);
    if (fresh) {
      const snapshot = await tree(scope.backendDir);
      const files = snapshot.rows.filter(row => !row.directory).map(row => path.relative(scope.backendDir, row.path).split(path.sep).join('/'));
      assert(files.length === allowed.size && files.every(name => allowed.has(name)), 'ERR_CUE_INSPECTOR_PROFILE', 'Metadata discovery requires a newly prepared profile without saved user state.');
    }
    for (const row of publicFiles) {
      const value = await reader.read(path.join(scope.backendDir, row.relativePath), {maxBytes: 64 * 1024 * 1024});
      assert(value.bytes.length === row.bytes && digest(value.bytes) === row.sha256, 'ERR_CUE_INSPECTOR_RUNTIME', 'An isolated core file changed during discovery.');
    }
  }
  async function run(request, controller) {
    const signal = controller.signal;
    const check = () => {if (closed || signal.aborted) throw signal.reason || cancelled(); if (blocked) throw blocked;};
    let api, scope, bootstrap, manager, session, publicFiles, info, primary, result, cue, lease, setupClosed = false, safeToRemove = false;
    const cancelSetup = () => {try {bootstrap?.cancel();} catch (error) {primary ||= error;}};
    signal.addEventListener('abort', cancelSetup, {once: true});
    const timer = setTimeout(() => controller.abort(fail('ERR_CUE_INSPECTOR_DEADLINE', 'CUE metadata discovery exceeded its deadline.')), LIMITS.deadlineMs);
    try {
      check(); publish('validating');
      cue = await readCue(request.path, {authorizationRoot: request.authorizationRoot}); check();
      assert(sameRequest(cue.request, request), 'ERR_CUE_INSPECTOR_REQUEST', 'The current CUE does not match the supplied preflight evidence.');
      if (process.platform === 'win32') assert([request.path, ...request.references].every(name => name.length <= LIMITS.nativePathChars),
        'ERR_CUE_INSPECTOR_NATIVE_PATH_LENGTH', 'CUE 或引用的音频路径过长。请从较短的目录导入这组文件。');
      api = await runtime(check); check();
      // The holder must keep deny-write/delete file and required directory
      // handles until explicit close AFTER the metadata Job tree has exited.
      // Cancellation may cancel acquisition, never release an acquired lease.
      try {
        lease = await api.leaseApi.createCueReadLease({runtimeRoot: root, request, signal,
          onLost: cause => controller.abort(fail('ERR_CUE_INSPECTOR_LEASE_LOST', 'The native CUE read lease was lost.', {cause}))});
      } catch (cause) {
        if (cause?.cleanupPending === true) {
          blocked = fail('ERR_CUE_INSPECTOR_LEASE_EXIT_UNVERIFIED', 'A read-lease acquisition failed without physical holder close evidence.', {cause});
          retained.add({leaseController: cause.retainedController, acquisitionError: cause});
          throw blocked;
        }
        throw cause;
      }
      assert(api.leaseApi.isVerifiedCueReadLease(lease, {request}) && typeof lease.check === 'function' && typeof lease.close === 'function',
        'ERR_CUE_INSPECTOR_LEASE_UNAVAILABLE', 'Native CUE ingestion requires a branded, live read lease.');
      await lease.check(); await cue.recheck(); check(); scope = await newWorkspace(check); check();
      bootstrap = api.bootstrap.createBackendBootstrap({appRoot: root, dataDir: scope.dataDir, backendDir: scope.backendDir,
        onUpdate: value => publish('preparing', {completed: Number.isInteger(value.progress?.completed) ? value.progress.completed : 0,
          total: Number.isInteger(value.progress?.total) ? value.progress.total : 0})});
      const initial = await bootstrap.initialize(); check();
      assert(initial.automatic === true && initial.prepared === false, 'ERR_CUE_INSPECTOR_PROFILE', 'A fresh automatic metadata profile is required.');
      await bootstrap.begin(); check(); await bootstrap.complete({musicDirs: [request.authorizationRoot]}); check();
      assert(bootstrap.getStatus().prepared === true, 'ERR_CUE_INSPECTOR_PROFILE', 'The isolated metadata profile was not prepared.');
      publicFiles = bootstrap.getExpectedFiles();
      await backendFiles(scope, publicFiles, {fresh: true}); await api.recheck(); await cue.recheck(); check();
      manager = api.backend.createBackendManager({backendDir: scope.backendDir, dataDir: scope.dataDir,
        requireOwnedSession: true, requirePublicProvenance: true, publicFiles, startStopped: false});
      info = await manager.initialize({start: true, signal}); session = manager.getSession();
      const owned = current => {
        const token = manager.getSession();
        assert(token === session && api.backend.isVerifiedBackendSession(session, {foobarDir: scope.backendDir, baseUrl: info.baseUrl}) &&
          current?.available === true && current.owned === true && current.nativeReadySeen === true && current.pid === session?.pid &&
          current.backendId === session.backendId && normalized(session.executable) === normalized(path.join(scope.backendDir, 'foobar2000.exe')) &&
          normalized(session.profilePath) === normalized(path.join(scope.backendDir, 'profile/beefweb/config.json')) &&
          Array.isArray(current.musicDirs) && current.musicDirs.length === 1 && normalized(current.musicDirs[0]) === normalized(request.authorizationRoot),
        'ERR_CUE_INSPECTOR_SESSION', 'A branded, newly owned metadata-only session is required.');
      };
      owned(info); check(); bootstrap.markReady(session, info);
      const address = new URL(info.baseUrl);
      assert(address.protocol === 'http:' && address.hostname === '127.0.0.1' && !address.username && !address.password &&
        address.pathname === '/api/' && Number(address.port) >= 1024 && Number(address.port) <= 65535 && address.port !== '8880' &&
        !address.search && !address.hash, 'ERR_CUE_INSPECTOR_SESSION', 'The metadata endpoint is not an isolated loopback API.');
      let shadow = null;
      async function rpc(route, body) {
        check(); await lease.check(); check(); owned(manager.getInfo());
        const allowedGet = ['query?player=true&playQueue=true&outputs=true&playlists=true', 'browser/roots', 'playlists'].includes(route) ||
          Boolean(shadow && route === `playlists/${encodeURIComponent(shadow)}/items/0:${request.trackCount + 1}?columns=${encodeURIComponent(COLUMNS.join(','))}`);
        const allowedPost = route === 'outputs/active' && exact(body, ['typeId', 'deviceId']) && body.typeId === 'output' && NULL_DEVICE.test(body.deviceId) ||
          route === 'playlists/add' && exact(body, ['title', 'setCurrent']) && body.title === `STILL CUE Indexer [${scope.id}]` && body.setCurrent === false ||
          shadow && route === `playlists/${encodeURIComponent(shadow)}/items/add` && exact(body, ['items', 'async', 'replace', 'play']) &&
          Array.isArray(body.items) && body.items.length === 1 && body.items[0] === request.path && body.async === true && body.replace === false && body.play === false;
        assert(body === undefined ? allowedGet : allowedPost, 'ERR_CUE_INSPECTOR_RPC', 'This operation is outside the metadata-only RPC allowlist.');
        if (body !== undefined) {owned(await manager.initialize({start: false, signal})); await assertWorkspace(scope); await cue.recheck(); check();}
        const timeout = AbortSignal.timeout(LIMITS.requestMs), requestSignal = AbortSignal.any([signal, timeout]);
        const response = await globalThis.fetch(new URL(route, address), {method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          headers: body === undefined ? {} : {'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: requestSignal});
        check();
        if (!response.ok) {Promise.resolve(response.body?.cancel()).catch(() => {}); throw fail('ERR_CUE_INSPECTOR_RPC', 'Metadata API request failed.');}
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > LIMITS.responseBytes)) {
          Promise.resolve(response.body?.cancel()).catch(() => {});
          throw fail('ERR_CUE_INSPECTOR_RESPONSE_LIMIT', 'Metadata API response exceeds its byte limit.');
        }
        if (!response.body) return null;
        const stream = response.body.getReader(), chunks = []; let size = 0;
        try {
          while (true) {
            const next = await stream.read(); check();
            if (next.done) break;
            size += next.value.byteLength;
            assert(size <= LIMITS.responseBytes, 'ERR_CUE_INSPECTOR_RESPONSE_LIMIT', 'Metadata API response exceeds its byte limit.');
            chunks.push(Buffer.from(next.value));
          }
        } catch (error) {Promise.resolve(stream.cancel()).catch(() => {}); throw error;}
        finally {stream.releaseLock();}
        check(); return size ? JSON.parse(Buffer.concat(chunks, size).toString('utf8')) : null;
      }
      let wanted = null;
      async function quiet() {
        const value = await rpc('query?player=true&playQueue=true&outputs=true&playlists=true');
        assert(value?.player?.info?.name === 'foobar2000' && /^0\.10(?:\D|$)/u.test(value.player.info.pluginVersion || '') &&
          value.player.playbackState === 'stopped' && Array.isArray(value.playQueue) && value.playQueue.length === 0 &&
          Array.isArray(value.playlists) && value.playlists.length <= 16 && value.playlists.every(row => row && typeof row.id === 'string' &&
            Number.isInteger(row.itemCount) && row.itemCount >= 0 && row.itemCount <= (row.id === shadow ? request.trackCount : 0)),
        'ERR_CUE_INSPECTOR_NOT_QUIET', 'The isolated metadata session must remain stopped with an empty queue and no foreign playlist contents.');
        if (wanted) assert(sameOutput(nullOutput(value.outputs), wanted) && sameOutput(value.outputs.active, wanted),
          'ERR_CUE_INSPECTOR_NULL_OUTPUT', 'The isolated session did not read back the verified Null output.');
        return value;
      }
      const roots = (await rpc('browser/roots'))?.roots;
      assert(Array.isArray(roots) && roots.length === 1 && typeof roots[0]?.path === 'string' && normalized(roots[0].path) === normalized(request.authorizationRoot),
        'ERR_CUE_INSPECTOR_SESSION', 'The isolated roots do not match this request authorization.');
      const first = await quiet(); await quiet();
      wanted = nullOutput(first.outputs);
      await rpc('outputs/active', wanted); await quiet(); publish('discovering');
      const title = `STILL CUE Indexer [${scope.id}]`, created = await rpc('playlists/add', {title, setCurrent: false});
      assert(created && typeof created.id === 'string' && created.id.length > 0 && created.id.length <= 200 && !/[\0-\x1f]/u.test(created.id),
        'ERR_CUE_INSPECTOR_ITEMS', 'The shadow playlist has no verified identity.');
      shadow = created.id;
      const lists = (await rpc('playlists'))?.playlists;
      assert(Array.isArray(lists) && lists.filter(row => row.id === shadow).length === 1 &&
        lists.some(row => row.id === shadow && row.title === title && row.itemCount === 0),
      'ERR_CUE_INSPECTOR_ITEMS', 'The new empty shadow playlist was not read back.');
      await quiet(); await rpc(`playlists/${encodeURIComponent(shadow)}/items/add`, {items: [request.path], async: true, replace: false, play: false});
      let stable = null;
      while (true) {
        check(); const page = (await rpc(`playlists/${encodeURIComponent(shadow)}/items/0:${request.trackCount + 1}?columns=${encodeURIComponent(COLUMNS.join(','))}`))?.playlistItems;
        assert(page && page.offset === 0 && Number.isInteger(page.totalCount) && page.totalCount >= 0 && page.totalCount <= request.trackCount &&
          Array.isArray(page.items) && page.items.length === page.totalCount, 'ERR_CUE_INSPECTOR_ITEMS', 'CUE expansion returned a wrong count or malformed page.');
        if (page.totalCount === request.trackCount) {
          const items = validateCueItems({verified: true, items: page.items.map(row => metadata(row?.columns))}, request);
          const identity = JSON.stringify(items);
          if (stable === identity) {result = {verified: true, items}; break;}
          stable = identity;
        } else stable = null;
        await quiet(); await pause(LIMITS.pollMs, signal);
      }
      await quiet(); await cue.recheck(); await api.recheck(); check();
    } catch (error) {primary = error;}
    finally {
      clearTimeout(timer); signal.removeEventListener('abort', cancelSetup); publish('closing');
      if (bootstrap) {try {await bootstrap.close(); setupClosed = true;} catch (cause) {
        blocked = fail('ERR_CUE_INSPECTOR_SETUP_EXIT_UNVERIFIED', 'The extractor lifetime did not prove its physical close.', {cause});
        retained.add({manager, bootstrap, session, scope, lease}); primary = blocked;
      }}
      else setupClosed = true;
      if (manager) {
        try {
          // initialize may reject after the native launch was requested and
          // before an owned session was verified. The absence of a token or
          // an accepted creation callback cannot prove the Job is empty.
          session ??= manager.getSession();
          const stopped = await manager.close(), proof = stopped?.exitEvidence;
          if (session) {
            assert(api.backend.isVerifiedBackendChildExit(proof, session) && api.backend.isVerifiedBackendTreeExit(proof, session) &&
              manager.isOwnedTreeExited(session) === true, 'ERR_CUE_INSPECTOR_EXIT_UNVERIFIED', 'The exact metadata child and Job tree did not prove their exit.');
            publish('exit-verified', {childExited: true, treeExited: true});
          } else {
            assert(manager.hasClosedUnverifiedStartupTree?.({foobarDir: scope.backendDir}) === true,
              'ERR_CUE_INSPECTOR_EXIT_UNVERIFIED', 'An uncertain metadata startup was retained without an exit claim.');
            // This proof allows resource disposal for this failed attempt.
            // It cannot promote the attempt to a verified discovery.
            primary ||= fail('ERR_CUE_INSPECTOR_SESSION', 'The metadata session failed before HTTP verification.');
          }
          safeToRemove = true;
        } catch (error) {
          blocked = fail('ERR_CUE_INSPECTOR_EXIT_UNVERIFIED', 'The isolated metadata process was not proven exited; its workspace and owner were retained.', {cause: error});
          retained.add({manager, bootstrap, session, scope, lease}); primary = blocked;
        }
      } else safeToRemove = true;
      if (scope && safeToRemove && setupClosed) {
        try {
          if (cue) await cue.recheck();
          if (api) await api.recheck();
          if (publicFiles) await backendFiles(scope, publicFiles);
          await removeWorkspace(scope);
        } catch (error) {primary ||= error; publish('retained', {code: error.code || 'ERR_CUE_INSPECTOR_WORKSPACE'});}
      }
      if (lease && safeToRemove && setupClosed) {
        try {await lease.check();} catch (error) {primary ||= error;}
        try {await lease.close();}
        catch (cause) {
          blocked = fail('ERR_CUE_INSPECTOR_LEASE_EXIT_UNVERIFIED', 'The exact read-lease holder did not prove its physical close.', {cause});
          retained.add({manager, bootstrap, session, scope, lease}); primary = blocked;
        }
        if (!blocked && cue) {try {await cue.recheck();} catch (error) {primary ||= error;}}
      }
    }
    if (closed || signal.aborted) primary ||= signal.reason || cancelled();
    if (primary) throw primary;
    publish('verified', {completed: result.items.length, total: request.trackCount}); return result;
  }
  return Object.freeze({
    inspect(value, {signal} = {}) {
      if (closed) return Promise.reject(cancelled());
      if (!enabled) return Promise.reject(fail('ERR_CUE_INSPECTOR_DISABLED', 'CUE metadata discovery is disabled in this runtime.'));
      if (blocked) return Promise.reject(blocked);
      if (pending >= LIMITS.pending) return Promise.reject(fail('ERR_CUE_INSPECTOR_BUSY', 'The CUE metadata discovery queue is full.'));
      let request;
      try {request = snapshotRequest(value);} catch (error) {return Promise.reject(error);}
      const controller = new AbortController(), abort = () => controller.abort(cancelled());
      if (signal?.aborted) return Promise.reject(cancelled());
      signal?.addEventListener('abort', abort, {once: true}); pending++;
      const work = tail.then(async () => {
        if (closed || controller.signal.aborted) throw cancelled();
        if (blocked) throw blocked;
        active = controller;
        try {return await run(request, controller);} finally {active = null;}
      }).finally(() => {pending--; signal?.removeEventListener('abort', abort);});
      tail = work.catch(() => {}); return work;
    },
    close() {
      if (closing) return closing;
      closed = true; active?.abort(cancelled());
      closing = tail.then(() => {if (blocked || retained.size) throw blocked;});
      return closing;
    }
  });
}

module.exports = {createCueInspector, CUE_INSPECTOR_LIMITS: LIMITS, CUE_INSPECTOR_NULL_PROVIDER: NULL_PROVIDER};
