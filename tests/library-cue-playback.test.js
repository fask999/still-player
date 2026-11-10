'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createLibraryService, trackId} = require('../src/main/library');
const {createCueReader} = require('../src/main/cue-import');

const REQUIRED = 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED';
const INVALID = 'STILL_CUE_PLAYBACK_INVALID_LOCATIONS';
const location = (file, subsong = 1) => ({path: file, subsong});
const cueText = (reference = 'audio.flac') => `FILE "${reference}" WAVE\n TRACK 01 AUDIO\n INDEX 01 00:00:00\n TRACK 02 AUDIO\n INDEX 01 01:00:00\n`;
function deferred() {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};}
function rejected(promise, reason, code = REQUIRED) {
  return assert.rejects(promise, error => error.code === code && error.reason === reason);
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(__dirname, '.tmp-library-cue-playback-'));
  const music = path.join(root, 'music'), dataDir = path.join(root, 'data'), cue = path.join(music, 'album.cue'), audio = path.join(music, 'audio.flac');
  await fs.mkdir(music); await fs.writeFile(cue, cueText()); await fs.writeFile(audio, 'synthetic audio, never decoded or played');
  const services = [], calls = [];
  const create = extra => {
    const service = createLibraryService({dataDir, metadataParser: async () => ({common: {title: 'Fixture metadata'}, format: {}}),
      cueInspector: async request => {calls.push(structuredClone(request)); return {verified: true, items: [1, 2].map(subsong => ({path: request.path, subsong, supported: true, title: `Backend ${subsong}`}))};},
      ...options, ...extra});
    services.push(service); return service;
  };
  const rewrite = async edit => {
    const file = path.join(dataDir, 'library.json'), stored = JSON.parse(await fs.readFile(file, 'utf8'));
    edit(stored); await fs.writeFile(file, JSON.stringify(stored));
  };
  t.after(async () => {
    for (const service of services) await service.close();
    assert.equal(path.dirname(root), path.resolve(__dirname)); assert.ok(path.basename(root).startsWith('.tmp-library-cue-playback-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, music, dataDir, cue, audio, calls, create, rewrite};
}
function pauseCueOpen(cue) {
  let enabled = false;
  const entered = deferred(), release = deferred();
  return {entered, release, enable() {enabled = true;}, io: {...fs, async open(file, ...args) {
    if (enabled && file === cue) {enabled = false; entered.resolve(); await release.promise;}
    return fs.open(file, ...args);
  }}};
}
function pauseCommit(database) {
  let enabled = false;
  const entered = deferred(), release = deferred();
  return {entered, release, enable() {enabled = true;}, io: {...fs, async rename(source, target) {
    if (enabled && target === database) {enabled = false; entered.resolve(); await release.promise;}
    return fs.rename(source, target);
  }}};
}
function existingContextFixture(locations, opaque = {}) {
  const brands = new WeakMap(), calls = [], scope = Object.freeze(opaque);
  const state = {active: true, locations: locations.map(item => ({path: item.path, subsong: item.subsong}))};
  brands.set(scope, state);
  return {scope, calls, revoke() {state.active = false;}, verify(candidate, receipt) {
    assert.equal(Object.isFrozen(receipt), true); assert.deepEqual(Object.keys(receipt), ['path', 'subsong']);
    calls.push({candidate, receipt}); const bound = candidate && typeof candidate === 'object' ? brands.get(candidate) : null;
    return Boolean(bound?.active && bound.locations.some(item => item.path === receipt.path && item.subsong === receipt.subsong));
  }};
}

test('empty and known ordinary selections return no CUE requests; extra caller metadata and accessors are ignored', async t => {
  const {audio, calls, create} = await fixture(t); const service = create();
  await service.importFoobar({tracks: [{path: audio, subsong: 0, supported: true}]});
  let extrasRead = 0;
  const item = {path: audio, subsong: 0, cueTrack: true};
  Object.defineProperty(item, 'source', {get() {extrasRead++; throw new Error('Caller source must not be read.');}});
  assert.deepEqual(await service.getCuePlaybackRequests([]), []);
  assert.deepEqual(await service.getCuePlaybackRequests([item]), []);
  assert.equal(extrasRead, 0); assert.equal(calls.length, 0);
});

test('input requires an owned data path and explicit integer subsong, finite dense array and absolute file paths', async t => {
  const {audio, create} = await fixture(t); const service = create(); await service.initialize();
  let accessed = 0;
  const accessorPath = {subsong: 0}; Object.defineProperty(accessorPath, 'path', {get() {accessed++; return audio;}});
  const accessorSubsong = {path: audio}; Object.defineProperty(accessorSubsong, 'subsong', {get() {accessed++; return 0;}});
  const inherited = Object.create({path: audio, subsong: 0});
  const inputs = [undefined, null, {}, 'x', [null], ['x'], [inherited], [accessorPath], [accessorSubsong], new Array(1),
    [{path: 'relative.flac', subsong: 0}], [{path: 'https://example.invalid/track.flac', subsong: 0}], [{path: audio}],
    ...[null, undefined, '', '0', -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1].map(subsong => [{path: audio, subsong}]),
    [{path: audio + '\u0000', subsong: 0}], Array(50001).fill({path: audio, subsong: 0})];
  for (const input of inputs) await rejected(service.getCuePlaybackRequests(input), 'invalid-locations', INVALID);
  assert.equal(accessed, 0);
});

test('getter never starts initialization/recovery and rejects an unsuccessful initialization or a closed service', async t => {
  const {dataDir, cue, create} = await fixture(t); const service = create();
  await rejected(service.getCuePlaybackRequests([]), 'not-initialized');
  assert.equal(await fs.lstat(dataDir).then(() => true, () => false), false);
  const failed = create({fileSystem: {...fs, async mkdir() {throw Object.assign(new Error('synthetic unavailable directory'), {code: 'EACCES'});}}});
  await failed.initialize(); await rejected(failed.getCuePlaybackRequests([location(cue)]), 'not-initialized');
  await service.close(); await rejected(service.getCuePlaybackRequests([]), 'closed');
});

test('an already-started initialization is awaited without reading a partial published snapshot', async t => {
  const {dataDir, cue, create} = await fixture(t); const seed = create(); await seed.importFiles([cue]); await seed.close();
  const entered = deferred(), release = deferred(); let waiting = true;
  const service = create({fileSystem: {...fs, async open(file, ...args) {
    if (waiting && file === path.join(dataDir, 'library.json')) {waiting = false; entered.resolve(); await release.promise;}
    return fs.open(file, ...args);
  }}});
  const initialization = service.initialize(); await entered.promise;
  let settled = false; const result = service.getCuePlaybackRequests([location(cue)]).finally(() => {settled = true;});
  await Promise.resolve(); assert.equal(settled, false); release.resolve(); await initialization;
  assert.equal((await result).length, 1);
});

test('exact subsongs and repeated selections deduplicate each CUE, different CUEs stay separate and results are detached/read-only', async t => {
  const {cue, music, dataDir, calls, create} = await fixture(t), second = path.join(music, 'second.cue'); await fs.writeFile(second, cueText());
  let updates = 0;
  const service = create({onDelta: () => {updates++;}}); await service.importFiles([cue, second]);
  const before = service.list(), bytes = await fs.readFile(path.join(dataDir, 'library.json')), priorCalls = calls.length, priorUpdates = updates;
  const result = await service.getCuePlaybackRequests([location(cue, 2), location(cue), location(cue), location(second)]);
  assert.deepEqual(result.map(item => item.path), [cue, second]); assert.deepEqual(result[0].references, [path.join(music, 'audio.flac')]);
  result[0].references.length = 0; result[0].contentHash = 'tampered'; result[0].authorizationRoot = 'tampered';
  const fresh = await service.getCuePlaybackRequests([location(cue)]);
  assert.equal(fresh[0].references.length, 1); assert.match(fresh[0].contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(service.list(), before); assert.deepEqual(await fs.readFile(path.join(dataDir, 'library.json')), bytes);
  assert.equal(calls.length, priorCalls); assert.equal(updates, priorUpdates);
  await rejected(service.getCuePlaybackRequests([location(cue, 3)]), 'unknown-location');
});

test('unknown ordinary locations, legacy CUE records and direct unverified CUEs all fail closed', async t => {
  const {root, cue, audio, create} = await fixture(t); const service = create(); await service.initialize();
  await rejected(service.getCuePlaybackRequests([location(audio, 0)]), 'unknown-location');
  await service.importFoobar({tracks: [{path: cue, subsong: 8, supported: true}]});
  await rejected(service.getCuePlaybackRequests([location(cue, 8)]), 'unverified-cue');
  const unverified = create({dataDir: path.join(root, 'unverified-data'), cueInspector: undefined}); await unverified.initialize(); await unverified.importFiles([cue]);
  await rejected(unverified.getCuePlaybackRequests([location(cue, 0)]), 'unverified-cue');
});

test('revalidation errors give the Chinese refresh/reimport action without rendering the technical reason', async t => {
  const {cue, create} = await fixture(t), service = create(); await service.initialize();
  await assert.rejects(service.getCuePlaybackRequests([location(cue)]), error => {
    assert.equal(error.code, REQUIRED); assert.equal(error.reason, 'unknown-location');
    assert.equal(error.message, 'CUE 播放信息需要重新核验，请刷新或重新导入所选曲目后重试。');
    assert.equal(error.message.includes(error.reason), false); return true;
  });
});

test('reference-audio subsong zero is guarded from its private association and an unknown sibling never becomes ordinary', async t => {
  const {cue, audio, create} = await fixture(t);
  const service = create({cueInspector: async () => ({verified: true, items: [{path: audio, subsong: 0, supported: true}, {path: cue, subsong: 7, supported: true}]})});
  await service.importFiles([cue]);
  assert.equal((await service.getCuePlaybackRequests([location(audio, 0)]))[0].path, cue);
  await rejected(service.getCuePlaybackRequests([location(audio, 8)]), 'unknown-location');
  await fs.appendFile(cue, 'REM changed\n');
  await rejected(service.getCuePlaybackRequests([location(audio, 0)]), 'cue-content-changed');
});

test('same-directory direct imports and committed explicit folder subtrees survive restart without new discovery', async t => {
  const {music, cue, create, calls} = await fixture(t), nested = path.join(music, 'nested'); await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'child.flac'), 'synthetic child'); await fs.writeFile(cue, cueText('nested/child.flac'));
  const service = create(); await service.importFolder(music); await service.close(); const prior = calls.length;
  const restarted = create({cueInspector: () => {throw new Error('Playback guard must not discover.');}}); await restarted.initialize();
  const request = (await restarted.getCuePlaybackRequests([location(cue)]))[0];
  assert.equal(request.authorizationRoot, music); assert.deepEqual(request.references, [path.join(nested, 'child.flac')]); assert.equal(calls.length, prior);
});

for (const mutation of [
  ['content text', async ({cue}) => fs.appendFile(cue, 'REM legal metadata change\n'), 'cue-content-changed'],
  ['same-directory new FILE', async ({cue, music}) => {await fs.writeFile(path.join(music, 'new.flac'), 'new synthetic audio'); await fs.writeFile(cue, 'FILE "audio.flac" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nFILE "new.flac" WAVE\nTRACK 02 AUDIO\nINDEX 01 00:00:00\n');}, 'cue-content-changed'],
  ['reference size', async ({audio}) => fs.appendFile(audio, 'changed'), 'cue-references-changed'],
  ['reference mtime', async ({audio}) => {const stat = await fs.stat(audio); await fs.utimes(audio, stat.atime, new Date(stat.mtimeMs + 2000));}, 'cue-references-changed'],
  ['missing CUE', async ({cue}) => fs.unlink(cue), 'cue-files-unavailable'],
  ['missing reference', async ({audio}) => fs.unlink(audio), 'cue-files-unavailable'],
  ['outside FILE', async ({cue, root}) => {await fs.writeFile(path.join(root, 'outside.flac'), 'synthetic outside'); await fs.writeFile(cue, cueText('../outside.flac'));}, 'cue-files-unavailable'],
]) test(`fresh playback guard rejects ${mutation[0]} without changing the library or discovering new tracks`, async t => {
  const state = await fixture(t), service = state.create(); await service.importFiles([state.cue]); const before = service.list(), priorCalls = state.calls.length;
  await mutation[1](state); await rejected(service.getCuePlaybackRequests([location(state.cue)]), mutation[2]);
  assert.deepEqual(service.list(), before); assert.equal(state.calls.length, priorCalls);
});

test('reference ctime changes with unchanged bytes, size and mtime invalidate the saved safety hash', async t => {
  const {audio, cue, create} = await fixture(t); let changed = false;
  const service = create({fileSystem: {...fs, async lstat(file, options) {
    const stat = await fs.lstat(file, options);
    if (!changed || file !== audio || options?.bigint !== true) return stat;
    return new Proxy(stat, {get(target, key) {return key === 'ctimeNs' ? target.ctimeNs + 1n : Reflect.get(target, key);}});
  }}});
  await service.importFiles([cue]); changed = true;
  await rejected(service.getCuePlaybackRequests([location(cue)]), 'cue-references-changed');
});

test('reference hardlinks and final/ancestor symlinks cannot become fresh playback requests', async t => {
  const {root, music, cue, audio, create} = await fixture(t); const service = create(); await service.importFiles([cue]);
  const hardlink = path.join(root, 'audio-hardlink.flac'); await fs.link(audio, hardlink);
  await rejected(service.getCuePlaybackRequests([location(cue)]), 'cue-files-unavailable'); await fs.unlink(hardlink);
  const external = path.join(root, 'external.flac'); await fs.writeFile(external, 'synthetic external'); await fs.unlink(audio);
  try {await fs.symlink(external, audio, 'file');}
  catch (error) {if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {t.diagnostic(`File link unavailable: ${error.code}`); return;} throw error;}
  await rejected(service.getCuePlaybackRequests([location(cue)]), 'cue-files-unavailable'); await fs.unlink(audio); await fs.writeFile(audio, 'synthetic audio');
  const held = path.join(root, 'held-music'); await fs.rename(music, held); await fs.symlink(held, music, process.platform === 'win32' ? 'junction' : 'dir');
  await rejected(service.getCuePlaybackRequests([location(cue)]), 'cue-files-unavailable');
  await fs.unlink(music); await fs.rename(held, music);
});

for (const [name, edit, reason] of [
  ['missing content hash', record => {delete record._cueContentHash;}, 'invalid-cue-snapshot'],
  ['invalid safety hash', record => {record._cueSafetyHash = 'A'.repeat(64);}, 'invalid-cue-snapshot'],
  ['zero track count', record => {record._cueTrackCount = 0;}, 'invalid-cue-snapshot'],
  ['too many tracks', record => {record._cueTrackCount = 100;}, 'invalid-cue-snapshot'],
  ['changed track count', record => {record._cueTrackCount = 3;}, 'cue-track-count-changed'],
  ['missing root', record => {delete record._cueAuthorizationRoot;}, 'invalid-cue-snapshot'],
  ['relative root', record => {record._cueAuthorizationRoot = 'relative';}, 'invalid-cue-snapshot'],
  ['nonnormalized root', record => {record._cueAuthorizationRoot = path.dirname(record._cuePath) + path.sep + '.';}, 'invalid-cue-snapshot'],
  ['nonnormalized CUE path', record => {record._cuePath = path.dirname(record._cuePath) + path.sep + '.' + path.sep + path.basename(record._cuePath);}, 'invalid-cue-snapshot'],
  ['wrong CUE extension', record => {record._cuePath = record._cuePath.replace(/\.cue$/, '.flac');}, 'invalid-cue-snapshot'],
  ['unverified boolean', record => {record._cueVerified = 'true';}, 'unverified-cue'],
]) test(`persisted ${name} cannot grant playback after restart`, async t => {
  const {cue, create, rewrite} = await fixture(t); const seed = create(); await seed.importFiles([cue]); await seed.close();
  await rewrite(stored => {for (const record of stored.tracks) edit(record);});
  const restarted = create(); await restarted.initialize(); await rejected(restarted.getCuePlaybackRequests([location(cue)]), reason);
});

test('a persisted parent/drive root cannot replace the explicitly committed folder authorization', async t => {
  const {root, music, cue, create, rewrite} = await fixture(t); const seed = create(); await seed.importFolder(music); await seed.close();
  for (const broadened of [root, path.parse(root).root]) {
    await rewrite(stored => {for (const record of stored.tracks) if (record._cuePath) record._cueAuthorizationRoot = broadened;});
    const restarted = create(); await restarted.initialize(); await rejected(restarted.getCuePlaybackRequests([location(cue)]), 'authorization-mismatch'); await restarted.close();
  }
  if (process.platform === 'win32') {
    await rewrite(stored => {for (const record of stored.tracks) if (record._cuePath) record._cueAuthorizationRoot = music.toUpperCase();});
    const restarted = create(); await restarted.initialize(); await rejected(restarted.getCuePlaybackRequests([location(cue)]), 'authorization-mismatch');
  }
});

test('selected proofs for one CUE must retain the same direct/folder permission sentinel', async t => {
  const {music, cue, create, rewrite} = await fixture(t); const seed = create(); await seed.importFolder(music); await seed.close();
  await rewrite(stored => {stored.tracks.find(record => record.path === cue && record.subsong === 2)._cueAuthorizationRoot = '';});
  const restarted = create(); await restarted.initialize();
  await rejected(restarted.getCuePlaybackRequests([location(cue, 1), location(cue, 2)]), 'invalid-cue-snapshot');
});

test('partial CUE safety metadata/source on an ordinary file cannot bypass the guard; cleared foobar error alone remains ordinary', async t => {
  const {audio, create, rewrite} = await fixture(t); const seed = create(); await seed.importFoobar({tracks: [{path: audio, subsong: 0, supported: true}]}); await seed.close();
  for (const patch of [{_cuePath: ''}, {_cueVerified: false}, {_cueContentHash: '0'.repeat(64)}, {source: 'cue'}, {_cueValidationError: 'needs reimport'}]) {
    await rewrite(stored => {for (const record of stored.tracks) {for (const key of Object.keys(record)) if (key.startsWith('_cue')) delete record[key]; record.source = 'foobar2000'; Object.assign(record, patch);}});
    const restarted = create(); await restarted.initialize(); await rejected(restarted.getCuePlaybackRequests([location(audio, 0)]), 'unverified-cue'); await restarted.close();
  }
});

for (const marker of [false, 0, null]) test(`an own malformed CUE validation marker ${String(marker)} requires proof and never reads new files`, async t => {
  const {audio, cue, dataDir, calls, create, rewrite} = await fixture(t), seed = create();
  await seed.importFoobar({tracks: [{path: audio, subsong: 0, supported: true}]}); await seed.importFiles([cue]); await seed.close();
  await rewrite(stored => {for (const record of stored.tracks) if (record.path === audio || record.path === cue && record.subsong === 1) record._cueValidationError = marker;});
  let reads = 0;
  const restarted = create({fileSystem: {...fs,
    async open(...args) {reads++; return fs.open(...args);}, async lstat(...args) {reads++; return fs.lstat(...args);},
    async stat(...args) {reads++; return fs.stat(...args);}, async realpath(...args) {reads++; return fs.realpath(...args);}}});
  await restarted.initialize(); reads = 0;
  const before = restarted.list(), bytes = await fs.readFile(path.join(dataDir, 'library.json')), priorCalls = calls.length;
  await rejected(restarted.getCuePlaybackRequests([location(audio, 0)]), 'unverified-cue');
  await rejected(restarted.getCuePlaybackRequests([location(cue, 1)]), 'unverified-cue');
  assert.equal(reads, 0); assert.equal(calls.length, priorCalls);
  assert.deepEqual(restarted.list(), before); assert.deepEqual(await fs.readFile(path.join(dataDir, 'library.json')), bytes);
});

test('an absent CUE validation marker on an ordinary foobar record remains a normal empty result', async t => {
  const {audio, create, rewrite} = await fixture(t), seed = create();
  await seed.importFoobar({tracks: [{path: audio, subsong: 0, supported: true}]}); await seed.close();
  await rewrite(stored => {for (const record of stored.tracks) delete record._cueValidationError;});
  const restarted = create(); await restarted.initialize();
  assert.deepEqual(await restarted.getCuePlaybackRequests([location(audio, 0)]), []);
});

test('known ordinary UNC/rooted paths retain canonical compatibility while unindexed UNC still rejects without media I/O', {skip: process.platform !== 'win32'}, async t => {
  const {audio, cue, create, rewrite} = await fixture(t), seed = create(); await seed.importFiles([audio]); await seed.close();
  const unc = '\\\\STILL-SYNTHETIC-MEDIA.invalid\\share\\ordinary.flac', rooted = '\\STILL-SYNTHETIC-MEDIA\\ordinary.flac';
  await rewrite(stored => {stored.tracks = [unc, rooted].map(file => ({path: file, subsong: 0, valid: true, source: 'foobar2000', _foobarSupported: true, _fileValid: true, _cueValidationError: ''}));});
  let forbiddenReads = 0;
  const io = {...fs};
  for (const method of ['open', 'stat', 'lstat', 'realpath', 'access', 'readdir']) io[method] = (...args) => {
    if (typeof args[0] === 'string' && (args[0].startsWith('\\') || args[0].includes('STILL-SYNTHETIC-MEDIA'))) {forbiddenReads++; throw new Error('Synthetic network/rooted media must never be accessed.');}
    return fs[method](...args);
  };
  const restarted = create({fileSystem: io}); await restarted.initialize();
  const selections = [location(unc, 0), location(rooted, 0), location(unc.toUpperCase(), 0)];
  assert.deepEqual(await restarted.getCuePlaybackRequests(selections), []);
  assert.equal(selections[0].path, unc); assert.equal(selections[1].path, rooted);
  await rejected(restarted.getCuePlaybackRequests([location('\\\\STILL-SYNTHETIC-MEDIA.invalid\\share\\unknown.flac', 0)]), 'unknown-location');
  assert.equal(forbiddenReads, 0); assert.ok(cue);
});

test('a seeded CUE-associated UNC location cannot borrow the ordinary absolute-path exception', {skip: process.platform !== 'win32'}, async t => {
  const {audio, cue, create, rewrite} = await fixture(t), seed = create(); await seed.importFiles([audio]); await seed.close();
  const unc = '\\\\STILL-SYNTHETIC-MEDIA.invalid\\share\\associated.flac';
  await rewrite(stored => {stored.tracks = [{path: unc, subsong: 7, valid: true, source: 'foobar2000', _foobarSupported: true, _fileValid: true,
    _cueValidationError: '', _cueVerified: true, _cuePath: cue, _cueAuthorizationRoot: '', _cueContentHash: '0'.repeat(64), _cueSafetyHash: '0'.repeat(64), _cueTrackCount: 2}];});
  let forbiddenReads = 0;
  const io = {...fs};
  for (const method of ['open', 'stat', 'lstat', 'realpath', 'access', 'readdir']) io[method] = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('\\')) {forbiddenReads++; throw new Error('Synthetic UNC media must never be accessed.');}
    return fs[method](...args);
  };
  const restarted = create({fileSystem: io}); await restarted.initialize();
  await rejected(restarted.getCuePlaybackRequests([location(unc, 7)]), 'invalid-cue-snapshot');
  await rejected(restarted.getCuePlaybackRequests([location(unc.toUpperCase(), 7)]), 'unknown-location');
  assert.equal(forbiddenReads, 0);
});

test('a known ordinary tuple zero remains ordinary beside Cue7 while Cue7 and unknown siblings keep their own rules', async t => {
  const {audio, cue, create} = await fixture(t);
  const service = create({cueInspector: async () => ({verified: true, items: [{path: audio, subsong: 7, supported: true}, {path: cue, subsong: 9, supported: true}]})});
  await service.importFoobar({tracks: [{path: audio, subsong: 0, supported: true}]}); await service.importFiles([cue]);
  assert.deepEqual(await service.getCuePlaybackRequests([{path: audio, subsong: 0, cueTrack: false, source: 'local'}]), []);
  await rejected(service.getCuePlaybackRequests([location(audio, 8)]), 'unknown-location');
  assert.equal((await service.getCuePlaybackRequests([location(audio, 7)]))[0].path, cue);
  if (process.platform === 'win32') {
    assert.deepEqual(await service.getCuePlaybackRequests([location(audio.toUpperCase(), 0)]), []);
    await rejected(service.getCuePlaybackRequests([location(audio.toUpperCase(), 7)]), 'unknown-location');
  }
});

test('a newly committed sibling CUE association does not expand an already known ordinary tuple during another CUE read', async t => {
  const {audio, cue, music, create} = await fixture(t), other = path.join(music, 'other.cue'), gate = pauseCueOpen(cue);
  await fs.writeFile(other, cueText());
  const service = create({fileSystem: gate.io, cueInspector: async request => ({verified: true, items: request.path === cue
    ? [1, 2].map(subsong => ({path: cue, subsong, supported: true}))
    : [{path: audio, subsong: 7, supported: true}, {path: other, subsong: 9, supported: true}]})});
  await service.importFoobar({tracks: [{path: audio, subsong: 0, supported: true}]}); await service.importFiles([cue]);
  gate.enable(); const outcome = service.getCuePlaybackRequests([location(audio, 0), location(cue)]).then(value => ({value}), error => ({error}));
  await gate.entered.promise; await service.importFiles([other]); gate.release.resolve();
  const result = await outcome; assert.equal(result.error, undefined); assert.equal(result.value.length, 1);
});

test('a live opaque scope exempts only an exact old ordinary location without cloning the scope or writing the index', async t => {
  const {music, dataDir, calls, create} = await fixture(t), legacy = location(path.join(music, 'legacy.flac'), 1);
  let serialized = 0;
  const context = existingContextFixture([legacy], {toJSON() {serialized++; throw new Error('Opaque scope must not be serialized.');}});
  const service = create({verifyExistingContextScope: context.verify}); await service.initialize();
  const before = service.list();
  const options = {existingContextScope: context.scope}; const result = service.getCuePlaybackRequests([legacy], options);
  options.existingContextScope = {verified: true};
  assert.deepEqual(await result, []); assert.equal(serialized, 0); assert.equal(context.calls.length, 2);
  assert.ok(context.calls.every(call => call.candidate === context.scope && call.receipt !== legacy));
  assert.deepEqual(service.list(), before); assert.equal(calls.length, 0);
  assert.equal(await fs.readFile(path.join(dataDir, 'library.json')).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;}), false);
  await rejected(service.getCuePlaybackRequests([location(legacy.path, 2)], {existingContextScope: context.scope}), 'existing-context-scope-invalid');
});

test('absent, JSON-copied, inherited, accessor and revoked scopes cannot exempt an unknown tuple', async t => {
  const {music, create} = await fixture(t), legacy = location(path.join(music, 'legacy.flac'), 1), context = existingContextFixture([legacy]);
  const service = create({verifyExistingContextScope: context.verify}); await service.initialize();
  await rejected(service.getCuePlaybackRequests([legacy]), 'unknown-location');
  await rejected(service.getCuePlaybackRequests([legacy], {existingContextScope: JSON.parse(JSON.stringify(context.scope)), verified: true, cueTrack: false}), 'existing-context-scope-invalid');
  await rejected(service.getCuePlaybackRequests([legacy], Object.create({existingContextScope: context.scope})), 'unknown-location');
  let read = 0; const accessor = {}; Object.defineProperty(accessor, 'existingContextScope', {get() {read++; return context.scope;}});
  await rejected(service.getCuePlaybackRequests([legacy], accessor), 'existing-context-scope-invalid'); assert.equal(read, 0);
  await rejected(service.getCuePlaybackRequests([location(path.join(music, 'other.mp3'), 1)], {existingContextScope: context.scope}), 'existing-context-scope-invalid');
  context.revoke(); await rejected(service.getCuePlaybackRequests([legacy], {existingContextScope: context.scope}), 'existing-context-scope-invalid');
});

test('missing, throwing, async and nontrue scope verifiers fail closed and rejected Promises are drained', async t => {
  const {music, create} = await fixture(t), legacy = location(path.join(music, 'legacy.flac'), 1), context = existingContextFixture([legacy]);
  let thenRead = 0;
  const thenable = Object.defineProperty({}, 'then', {get() {thenRead++; throw new Error('Thenable must not be assimilated.');}});
  const verifiers = [undefined, () => {throw new Error('SYNTHETIC PRIVATE VERIFIER ERROR');}, () => Promise.resolve(true),
    () => Promise.reject(new Error('SYNTHETIC REJECTED VERIFIER')), () => thenable, ...[false, undefined, null, 0, 1, 'true', {}].map(value => () => value)];
  for (const verifyExistingContextScope of verifiers) {
    const service = create({verifyExistingContextScope}); await service.initialize();
    await rejected(service.getCuePlaybackRequests([legacy], {existingContextScope: context.scope}), 'existing-context-scope-invalid');
  }
  await new Promise(resolve => setImmediate(resolve)); assert.equal(thenRead, 0);
});

test('irrelevant invalid scopes never affect a known ordinary tuple or call the verifier', async t => {
  const {audio, create} = await fixture(t); let verified = 0, accessorRead = 0;
  const service = create({verifyExistingContextScope: () => {verified++; throw new Error('Known ordinary tuples do not need scope.');}});
  await service.importFoobar({tracks: [{path: audio, subsong: 0, supported: true}]});
  const accessor = {}; Object.defineProperty(accessor, 'existingContextScope', {get() {accessorRead++; throw new Error('Do not read scope accessor.');}});
  for (const options of [undefined, null, {existingContextScope: {fake: true}}, accessor]) assert.deepEqual(await service.getCuePlaybackRequests([location(audio, 0)], options), []);
  assert.equal(verified, 0); assert.equal(accessorRead, 0);
});

test('true scope cannot exempt CUE, ISO, playlist, archive or unpack shapes', async t => {
  const {music, cue, create} = await fixture(t); let verified = 0;
  const excluded = [cue, path.join(music, 'album.iso'), path.join(music, 'list.m3u'), path.join(music, 'list.fpl'), path.join(music, 'archive.zip'),
    path.join(music, 'archive.zip', 'track.flac'), path.join(music, 'list.m3u', 'track.flac'), path.join(music, 'archive.zip|track.flac'), path.join(music, 'unpack:', 'track.flac')];
  const context = existingContextFixture(excluded.map(file => location(file)));
  const service = create({verifyExistingContextScope: (scope, receipt) => {verified++; return context.verify(scope, receipt);}}); await service.initialize();
  for (const file of excluded) await rejected(service.getCuePlaybackRequests([location(file)], {existingContextScope: context.scope}), 'unknown-location');
  await rejected(service.getCuePlaybackRequests([location('unpack://zip|' + cue)], {existingContextScope: context.scope}), 'invalid-locations', INVALID);
  assert.equal(verified, 0);
});

test('true scope cannot exempt known CUE proof or an unknown tuple on a known CUE-associated path', async t => {
  const {audio, cue, create} = await fixture(t); let verified = 0;
  const context = existingContextFixture([location(audio, 0), location(audio, 7), location(audio, 8), location(audio.toUpperCase(), 7), location(audio.toUpperCase(), 8)]);
  const service = create({verifyExistingContextScope: (scope, receipt) => {verified++; return context.verify(scope, receipt);},
    cueInspector: async () => ({verified: true, items: [{path: audio, subsong: 7, supported: true}, {path: cue, subsong: 9, supported: true}]})});
  await service.importFoobar({tracks: [{path: audio, subsong: 0, supported: true}]}); await service.importFiles([cue]);
  assert.deepEqual(await service.getCuePlaybackRequests([location(audio, 0)], {existingContextScope: context.scope}), []);
  await rejected(service.getCuePlaybackRequests([location(audio, 8)], {existingContextScope: context.scope}), 'unknown-location');
  if (process.platform === 'win32') {
    await rejected(service.getCuePlaybackRequests([location(audio.toUpperCase(), 8)], {existingContextScope: context.scope}), 'unknown-location');
    await rejected(service.getCuePlaybackRequests([location(audio.toUpperCase(), 7)], {existingContextScope: context.scope}), 'unknown-location');
  }
  await fs.appendFile(cue, 'REM scope cannot hide changed CUE\n');
  await rejected(service.getCuePlaybackRequests([location(audio, 7)], {existingContextScope: context.scope}), 'cue-content-changed');
  assert.equal(verified, 0);
});

test('scope revocation during a fresh CUE read is rechecked without any library publication', async t => {
  const {music, cue, create} = await fixture(t), legacy = location(path.join(music, 'legacy.flac'), 1), context = existingContextFixture([legacy]), gate = pauseCueOpen(cue);
  const service = create({fileSystem: gate.io, verifyExistingContextScope: context.verify}); await service.importFiles([cue]); const revision = service.list().revision;
  gate.enable(); const outcome = service.getCuePlaybackRequests([legacy, location(cue)], {existingContextScope: context.scope}).then(value => ({value}), error => ({error}));
  await gate.entered.promise; context.revoke(); gate.release.resolve();
  assert.equal((await outcome).error?.reason, 'existing-context-scope-invalid'); assert.equal(service.list().revision, revision);
});

test('an initially scoped unknown tuple loses its exception when that path gains a committed CUE association', async t => {
  const {audio, cue, music, create} = await fixture(t), other = path.join(music, 'other.cue'), legacy = location(audio, 8), context = existingContextFixture([legacy]), gate = pauseCueOpen(cue);
  await fs.writeFile(other, cueText());
  const service = create({fileSystem: gate.io, verifyExistingContextScope: context.verify, cueInspector: async request => ({verified: true, items: request.path === cue
    ? [1, 2].map(subsong => ({path: cue, subsong, supported: true}))
    : [{path: audio, subsong: 7, supported: true}, {path: other, subsong: 9, supported: true}]})});
  await service.importFiles([cue]); gate.enable();
  const outcome = service.getCuePlaybackRequests([legacy, location(cue)], {existingContextScope: context.scope}).then(value => ({value}), error => ({error}));
  await gate.entered.promise; await service.importFiles([other]); gate.release.resolve();
  assert.equal((await outcome).error?.reason, 'unknown-location');
});

test('a selected path outside a valid saved CUE/reference allowlist is refused', async t => {
  const {cue, music, create, rewrite} = await fixture(t); const foreign = path.join(music, 'foreign.flac'); await fs.writeFile(foreign, 'synthetic foreign');
  const seed = create(); await seed.importFiles([cue]); await seed.close();
  await rewrite(stored => {stored.tracks[0].path = foreign;});
  const restarted = create(); await restarted.initialize(); await rejected(restarted.getCuePlaybackRequests([location(foreign)]), 'selection-not-in-cue');
});

test('a selected removal and remove/reimport ABA invalidate an in-flight request even if its saved fields become equal again', async t => {
  for (const restore of [false, true]) {
    const {cue, create} = await fixture(t); const gate = pauseCueOpen(cue); const service = create({fileSystem: gate.io}); await service.importFiles([cue]);
    gate.enable(); const outcome = service.getCuePlaybackRequests([location(cue)]).then(value => ({value}), error => ({error}));
    await gate.entered.promise; await service.remove([trackId(cue, 1)]); if (restore) await service.importFiles([cue]);
    gate.release.resolve(); assert.equal((await outcome).error?.reason, 'record-changed');
  }
});

test('a committed refresh of selected CUE verification invalidates an in-flight request', async t => {
  const {cue, create} = await fixture(t); const gate = pauseCueOpen(cue); const service = create({fileSystem: gate.io}); await service.importFiles([cue]);
  gate.enable(); const outcome = service.getCuePlaybackRequests([location(cue)]).then(value => ({value}), error => ({error}));
  await gate.entered.promise; await fs.appendFile(cue, 'REM changed before committed refresh\n'); await service.refresh();
  gate.release.resolve(); assert.equal((await outcome).error?.reason, 'record-changed');
});

test('an in-flight referenced audio identity cannot return an earlier CUE association after another import commits', async t => {
  const {cue, audio, music, create} = await fixture(t), other = path.join(music, 'other.cue'); await fs.writeFile(other, cueText()); const gate = pauseCueOpen(cue);
  const service = create({fileSystem: gate.io, cueInspector: async request => ({verified: true, items: [{path: audio, subsong: 0, supported: true}, {path: request.path, subsong: 7, supported: true}]})});
  await service.importFiles([cue]); gate.enable(); const outcome = service.getCuePlaybackRequests([location(audio, 0)]).then(value => ({value}), error => ({error}));
  await gate.entered.promise; await service.importFiles([other]); gate.release.resolve(); assert.equal((await outcome).error?.reason, 'record-changed');
});

test('unrelated metadata/cover and playlist commits do not invalidate the selected CUE association', async t => {
  const {cue, music, create} = await fixture(t), gate = pauseCueOpen(cue), service = create({fileSystem: gate.io}); await service.importFiles([cue]);
  gate.enable(); const result = service.getCuePlaybackRequests([location(cue)]); await gate.entered.promise;
  await fs.writeFile(path.join(music, 'cover.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64'));
  await service.refresh(); await service.createPlaylist('Unrelated'); gate.release.resolve(); assert.equal((await result).length, 1);
});

test('uncommitted imports are not published to the getter and it does not wait behind their transaction', async t => {
  const {cue, dataDir, create} = await fixture(t), gate = pauseCommit(path.join(dataDir, 'library.json')), service = create({fileSystem: gate.io}); await service.initialize();
  gate.enable(); const importing = service.importFiles([cue]); await gate.entered.promise;
  try {await rejected(service.getCuePlaybackRequests([location(cue)]), 'unknown-location'); assert.equal(service.list().revision, 0);}
  finally {gate.release.resolve(); await importing;}
  assert.equal((await service.getCuePlaybackRequests([location(cue)])).length, 1);
});

test('pending refresh drafts cannot silently replace the committed content/safety snapshot used by the getter', async t => {
  const {cue, dataDir, create} = await fixture(t), gate = pauseCommit(path.join(dataDir, 'library.json')), service = create({fileSystem: gate.io}); await service.importFiles([cue]);
  const before = service.list(); await fs.appendFile(cue, 'REM new draft proof\n'); gate.enable(); const refresh = service.refresh(); await gate.entered.promise;
  try {await rejected(service.getCuePlaybackRequests([location(cue)]), 'cue-content-changed'); assert.equal(service.list().revision, before.revision);}
  finally {gate.release.resolve(); await refresh;}
  assert.equal((await service.getCuePlaybackRequests([location(cue)])).length, 1);
});

test('close during a filesystem await refuses an otherwise valid request', async t => {
  const {cue, create} = await fixture(t), gate = pauseCueOpen(cue), service = create({fileSystem: gate.io}); await service.importFiles([cue]);
  gate.enable(); const outcome = service.getCuePlaybackRequests([location(cue)]).then(value => ({value}), error => ({error})); await gate.entered.promise;
  await service.close(); gate.release.resolve(); assert.equal((await outcome).error?.reason, 'closed');
});

test('the final recheck rejects a reference changed after initial inspection', async t => {
  const {audio, cue, create} = await fixture(t); let enabled = false, opens = 0;
  const service = create({fileSystem: {...fs, async open(file, ...args) {
    if (enabled && file === cue && ++opens === 2) await fs.appendFile(audio, 'changed before final recheck');
    return fs.open(file, ...args);
  }}});
  await service.importFiles([cue]); enabled = true;
  await rejected(service.getCuePlaybackRequests([location(cue)]), 'cue-files-unavailable');
});

test('reader recheck retains the original identity witness when a CUE is replaced with the same bytes', async t => {
  const {cue, music} = await fixture(t), read = createCueReader(), prepared = await read(cue);
  const bytes = await fs.readFile(cue), before = await fs.lstat(cue, {bigint: true});
  await fs.rename(cue, path.join(music, 'retained-original.cue'));
  await fs.writeFile(cue, bytes, {flag: 'wx'});
  const after = await fs.lstat(cue, {bigint: true});
  assert.notEqual(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`);
  assert.deepEqual(await fs.readFile(cue), bytes);
  assert.equal((await read(cue)).request.contentHash, prepared.request.contentHash);
  await assert.rejects(prepared.recheck(), error => error.code === 'ERR_CUE_IMPORT' && /CUE changed during backend discovery/.test(error.message));
});

test('a selected removal during the final recheck cannot return a stale request', async t => {
  const {cue, create} = await fixture(t), entered = deferred(), release = deferred(); let enabled = false, opens = 0;
  const service = create({fileSystem: {...fs, async open(file, ...args) {
    if (enabled && file === cue && ++opens === 2) {entered.resolve(); await release.promise;}
    return fs.open(file, ...args);
  }}});
  await service.importFiles([cue]); enabled = true;
  const outcome = service.getCuePlaybackRequests([location(cue)]).then(value => ({value}), error => ({error}));
  await entered.promise; await service.remove([trackId(cue, 1)]); release.resolve();
  assert.equal((await outcome).error?.reason, 'record-changed');
});

test('the getter snapshots caller locations before awaiting readiness and accepts the 50000-location boundary', async t => {
  const {cue, audio, create} = await fixture(t), service = create(); await service.importFiles([audio, cue]);
  const input = [location(cue)], pending = service.getCuePlaybackRequests(input);
  input[0].path = audio; input[0].subsong = 0; input.length = 0;
  assert.equal((await pending)[0].path, cue);
  assert.deepEqual(await service.getCuePlaybackRequests(Array(50000).fill(location(audio, 0))), []);
});

test('a final CUE pathname replaced by a symlink never reaches the playback request result', async t => {
  const {cue, music, create} = await fixture(t), service = create(); await service.importFiles([cue]);
  const held = path.join(music, 'held.cue'); await fs.rename(cue, held);
  try {await fs.symlink(held, cue, 'file');}
  catch (error) {if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {t.diagnostic(`File link unavailable: ${error.code}`); return;} throw error;}
  await rejected(service.getCuePlaybackRequests([location(cue)]), 'cue-files-unavailable');
});

test('Windows Unicode full-lowercase collisions cannot substitute a different CUE-selected path or committed authorization root', {skip: process.platform !== 'win32'}, async t => {
  const {music, audio, cue, create, rewrite} = await fixture(t), distinct = path.join(music, '\u0130.flac'), folded = path.join(music, 'i\u0307.flac');
  await fs.writeFile(distinct, 'synthetic capital dotted I'); await fs.writeFile(folded, 'synthetic lowercase combining dot');
  assert.equal(trackId(distinct, 0), trackId(folded, 0), 'fixture exercises the legacy full-lowercase ID collision');
  const associated = create({cueInspector: async () => ({verified: true, items: [{path: distinct, subsong: 0, supported: true}, {path: cue, subsong: 7, supported: true}]})});
  await fs.writeFile(cue, cueText('\u0130.flac')); await associated.importFiles([cue]);
  await rejected(associated.getCuePlaybackRequests([location(folded, 0)]), 'unknown-location'); await associated.close();
  const capitalRoot = path.join(music, '\u0130'), foldedRoot = path.join(music, 'i\u0307'); await fs.mkdir(capitalRoot); await fs.mkdir(foldedRoot);
  const nestedCue = path.join(capitalRoot, 'album.cue'); await fs.writeFile(nestedCue, cueText()); await fs.copyFile(audio, path.join(capitalRoot, 'audio.flac'));
  const seed = create(); await seed.initialize(); await seed.importFolder(capitalRoot); await seed.close();
  await rewrite(stored => {for (const record of stored.tracks) if (record._cuePath === nestedCue) record._cueAuthorizationRoot = foldedRoot;});
  const restarted = create(); await restarted.initialize(); await rejected(restarted.getCuePlaybackRequests([location(nestedCue)]), 'authorization-mismatch');
  assert.ok(await fs.readFile(cue));
});

test('CUE callers must use the exact committed path spelling while known ordinary locations retain legacy normalization', async t => {
  const {audio, cue, create} = await fixture(t); const service = create(); await service.importFiles([audio, cue]);
  const directory = path.dirname(cue), base = path.basename(cue), aliases = [directory + path.sep + '.' + path.sep + base,
    directory + path.sep + 'unused' + path.sep + '..' + path.sep + base, directory + path.sep + path.sep + base];
  if (process.platform === 'win32') aliases.push(cue.toUpperCase(), cue.replaceAll('\\', '/'), cue.replace(/^[A-Za-z]:/u, ''));
  for (const alias of aliases) await rejected(service.getCuePlaybackRequests([location(alias)]), 'unknown-location');
  assert.deepEqual(await service.getCuePlaybackRequests([location(path.dirname(audio) + path.sep + '.' + path.sep + path.basename(audio), 0)]), []);
  if (process.platform === 'win32') assert.deepEqual(await service.getCuePlaybackRequests([location(audio.toUpperCase(), 0)]), []);
});
