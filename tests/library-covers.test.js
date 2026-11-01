'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createLibraryService, trackId } = require('../src/main/library');
const {createShutdownCoverGc} = require('../src/main/shutdown-cover-gc');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64');
const filename = bytes => `${crypto.createHash('sha256').update(bytes).digest('hex')}.png`;
const url = bytes => `still-cover://art/${filename(bytes)}`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(__dirname, '.tmp-library-covers-'));
  const dataDir = path.join(root, 'data');
  const services = [];
  t.after(async () => {
    for (const service of services) await service.close();
    assert.equal(path.dirname(root), path.resolve(__dirname));
    assert.ok(path.basename(root).startsWith('.tmp-library-covers-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, coversDir: path.join(dataDir, 'covers'), create(options = {}, factory = createLibraryService) { const service = factory({ dataDir, ...options }); services.push(service); return service; } };
}

async function clockedLibrary(clock) {
  const sourcePath = path.resolve(__dirname, '../src/main/library.js'), mod = {exports: {}};
  const load = name => name === 'node:perf_hooks' ? {performance: {now: () => clock.elapsed}} : name.startsWith('./') ? require(path.resolve(path.dirname(sourcePath), name)) : require(name);
  class ClockDate extends Date {static now() {return 1700000000000 + clock.elapsed;}}
  vm.runInNewContext(await fs.readFile(sourcePath, 'utf8'), {module: mod, exports: mod.exports, require: load, Date: ClockDate, Buffer, process, structuredClone}, {filename: sourcePath});
  return {factory: mod.exports.createLibraryService, now: ClockDate.now};
}

test('metadata cache extracts a cover once for container subsongs and strips only duplicated cover binary', async t => {
  const { root, coversDir, create } = await fixture(t);
  const cue = path.join(root, 'synthetic.cue');
  const audio = Buffer.from('synthetic fixture audio, never sent to native playback');
  await fs.writeFile(cue, audio);
  const lyricBytes = Buffer.from('timed lyric payload');
  const pictureHeader = Buffer.alloc(8), pictureMime = Buffer.from('image/png'), pictureDimensions = Buffer.alloc(20);
  pictureHeader.writeUInt32BE(3, 0); pictureHeader.writeUInt32BE(pictureMime.length, 4); pictureDimensions.writeUInt32BE(PNG.length, 16);
  const flacPicture = Buffer.concat([pictureHeader, pictureMime, Buffer.alloc(4), pictureDimensions, PNG]).toString('base64');
  const metadata = {
    common: { title: 'Container title', picture: [{ format: 'image/png', data: PNG }], lyrics: [{ text: 'Preserved words' }] },
    format: { codec: 'Fixture', sampleRate: 48000 },
    native: {
      id3: [
        { id: 'APIC', value: { data: PNG, format: 'image/png' } },
        { id: 'APIC', value: 'Preserved non-binary text' },
        { id: 'USLT', value: { text: 'Preserved lyrics' } },
        { id: 'SYLT', value: lyricBytes },
        { id: 'custom', value: PNG },
      ],
      mp4: [{ id: 'covr', value: [{ data: PNG }] }],
      vorbis: [{ id: 'COVERART', value: PNG.toString('base64') }, { id: 'METADATA_BLOCK_PICTURE', value: flacPicture }, { id: 'LYRICS', value: 'More preserved lyrics' }],
    },
  };
  let parses = 0;
  const service = create({ metadataParser: { async parseFile(file, options) { assert.equal(file, cue); assert.equal(options.skipCovers, false); parses++; return metadata; }, selectCover(pictures) { return pictures[0]; } } });
  const snapshot = await service.importFoobar({ tracks: [{ path: cue, subsong: 0, title: 'First' }, { path: cue, subsong: 1, title: 'Second' }] });
  assert.equal(parses, 1);
  assert.deepEqual(snapshot.tracks.map(item => item.coverUrl), [url(PNG), url(PNG)]);
  assert.equal(metadata.coverUrl, url(PNG));
  assert.equal('picture' in metadata.common, false);
  assert.deepEqual(metadata.native.id3.map(item => item.id), ['APIC', 'USLT', 'SYLT', 'custom']);
  assert.deepEqual(metadata.native.mp4, []);
  assert.deepEqual(metadata.native.vorbis, [{ id: 'LYRICS', value: 'More preserved lyrics' }]);
  assert.equal(metadata.native.id3[2].value, lyricBytes);
  assert.equal(metadata.native.id3[3].value, PNG);
  assert.deepEqual(metadata.common.lyrics, [{ text: 'Preserved words' }]);
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
  assert.deepEqual(await fs.readFile(cue), audio);
  await service.refresh();
  assert.equal(parses, 1, 'unchanged tracks do not reopen the container');
});

test('cover extraction failure still releases duplicated binary and does not claim a saved cover', async t => {
  const { root, create } = await fixture(t);
  const file = path.join(root, 'fixture.wav');
  await fs.writeFile(file, 'synthetic');
  const metadata = { common: { picture: [{ data: PNG }] }, native: { id3: [{ id: 'APIC', value: { data: PNG } }] } };
  const io = { ...fs, async rename(source, target) { if (path.basename(path.dirname(target)) === 'covers') throw Object.assign(new Error('Injected cover save failure'), { code: 'EIO' }); return fs.rename(source, target); } };
  const service = create({ metadataParser: async () => metadata, fileSystem: io });
  await service.importFiles([file]);
  const track = service.getTrack(trackId(file));
  assert.equal(track.coverUrl, '');
  assert.match(track.metadataError, /Injected cover save failure/);
  assert.equal('picture' in metadata.common, false);
  assert.deepEqual(metadata.native.id3, []);
});

test('explicit collection keeps every published, retained and user cover while removing managed orphans only', async t => {
  const { root, coversDir, dataDir, create } = await fixture(t);
  const file = path.join(root, 'fixture.wav');
  await fs.writeFile(file, 'synthetic audio');
  const service = create({ metadataParser: async () => ({ common: { picture: [{ data: PNG }] } }) });
  await service.importFiles([file]);
  await service.remove([trackId(file)]);
  const orphan = Buffer.concat([PNG, Buffer.from('orphan')]);
  const retained = Buffer.concat([PNG, Buffer.from('retained')]);
  const mismatched = `${'0'.repeat(64)}.png`;
  const userCover = path.join(coversDir, 'my-kept-photo.png');
  await fs.writeFile(path.join(coversDir, filename(orphan)), orphan);
  await fs.writeFile(path.join(coversDir, filename(retained)), retained);
  await fs.writeFile(path.join(coversDir, mismatched), PNG);
  await fs.writeFile(userCover, PNG);
  const external = path.join(root, 'external.png');
  await fs.writeFile(external, PNG);
  const originalDatabase = await fs.readFile(path.join(dataDir, 'library.json'));
  const plan = await service.planCoverCollection({ retainUrls: [url(retained), external] });
  assert.deepEqual(plan.candidates.map(item => item.filename), [filename(orphan)]);
  assert.ok(plan.skipped.some(item => item.filename === mismatched));
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(orphan))), orphan, 'planning never deletes');
  const result = await service.collectCovers({ retainUrls: [url(retained), external] });
  assert.deepEqual(result.removed, [filename(orphan)]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG, 'a published DTO may still be active after its track is removed');
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(retained))), retained);
  assert.deepEqual(await fs.readFile(userCover), PNG);
  assert.deepEqual(await fs.readFile(external), PNG);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'library.json')), originalDatabase);
  await service.close();
  const closedPlan = await service.planCoverCollection({ retainUrls: [url(retained)] });
  assert.deepEqual(closedPlan.candidates.map(item => item.filename), [filename(PNG)]);
  const afterClose = await service.collectCovers({ retainUrls: [url(retained)] });
  assert.deepEqual(afterClose.removed, [filename(PNG)]);
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(retained))), retained);
  await assert.rejects(service.createPlaylist('Closed means no commits'), /closed/);
});

test('cover collection skips hardlinks, symlinks, nested directories and content changed after planning', async t => {
  const { root, coversDir, create } = await fixture(t);
  let changeBeforeDelete = false;
  const changed = Buffer.concat([PNG, Buffer.from('changed')]);
  const changedPath = path.join(coversDir, filename(changed));
  const io = { ...fs, async lstat(target, ...args) {
    if (changeBeforeDelete && target === changedPath) {
      changeBeforeDelete = false;
      await fs.writeFile(changedPath, PNG);
    }
    return fs.lstat(target, ...args);
  } };
  const service = create({ fileSystem: io });
  await service.initialize();
  const linked = Buffer.concat([PNG, Buffer.from('hardlinked')]);
  const external = path.join(root, 'outside.png');
  await fs.writeFile(external, linked);
  await fs.link(external, path.join(coversDir, filename(linked)));
  const nested = `${'1'.repeat(64)}.png`;
  await fs.mkdir(path.join(coversDir, nested));
  await fs.writeFile(changedPath, changed);
  const plan = await service.planCoverCollection();
  assert.deepEqual(plan.candidates.map(item => item.filename), [filename(changed)]);
  assert.ok(plan.skipped.some(item => item.filename === filename(linked)));
  assert.ok(plan.skipped.some(item => item.filename === nested));
  changeBeforeDelete = true;
  const result = await service.collectCovers();
  assert.deepEqual(result.removed, []);
  assert.deepEqual(await fs.readFile(external), linked);
  assert.deepEqual(await fs.readFile(changedPath), PNG);
  try {
    const symbolic = Buffer.concat([PNG, Buffer.from('symlink')]);
    const source = path.join(root, 'symlink-source.png');
    await fs.writeFile(source, symbolic);
    await fs.symlink(source, path.join(coversDir, filename(symbolic)), 'file');
    assert.ok((await service.planCoverCollection()).skipped.some(item => item.filename === filename(symbolic)));
    assert.deepEqual(await fs.readFile(source), symbolic);
  } catch (error) { if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; t.diagnostic(`File symlink unavailable: ${error.code}`); }
});

test('collection is queued behind a pending metadata/cover commit and sees the newly published reference', async t => {
  const { root, coversDir, create } = await fixture(t);
  const file = path.join(root, 'fixture.wav');
  await fs.writeFile(file, 'synthetic');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const parsing = new Promise(resolve => { started = resolve; });
  const service = create({ metadataParser: async () => { started(); await gate; return { common: { picture: [{ data: PNG }] } }; } });
  await service.initialize();
  await fs.writeFile(path.join(coversDir, filename(PNG)), PNG);
  const importing = service.importFiles([file]);
  await parsing;
  let collected = false;
  const collecting = service.collectCovers().then(result => { collected = true; return result; });
  await Promise.resolve();
  assert.equal(collected, false);
  release();
  await importing;
  assert.deepEqual((await collecting).removed, []);
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
});

test('collection unlink failure is reported and leaves library persistence intact', async t => {
  const { coversDir, dataDir, create } = await fixture(t);
  const io = { ...fs, async unlink(target) { if (path.dirname(target) === coversDir && target.endsWith('.png')) throw Object.assign(new Error('Injected unlink failure'), { code: 'EACCES' }); return fs.unlink(target); } };
  const service = create({ fileSystem: io });
  await service.createPlaylist('Saved');
  await fs.writeFile(path.join(coversDir, filename(PNG)), PNG);
  const before = await fs.readFile(path.join(dataDir, 'library.json'));
  const result = await service.collectCovers();
  assert.deepEqual(result.removed, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Injected unlink failure/);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'library.json')), before);
  assert.equal(service.getStatus().readOnly, false);
});

test('shared covers retain their counted current reference until the final track is removed and the service closes', async t => {
  const { root, coversDir, create } = await fixture(t);
  const files = ['one.wav', 'two.wav'].map(name => path.join(root, name));
  await Promise.all(files.map(file => fs.writeFile(file, 'synthetic')));
  const service = create({ metadataParser: async () => ({ common: { picture: [{ data: PNG }] } }) });
  await service.importFiles(files);
  assert.equal((await service.planCoverCollection()).referenceCounts[url(PNG)], 2);
  await service.remove([trackId(files[0])]);
  assert.equal((await service.planCoverCollection()).referenceCounts[url(PNG)], 1);
  await service.close();
  assert.deepEqual((await service.collectCovers()).removed, []);
  const lastReference = create();
  await lastReference.initialize();
  await lastReference.remove([trackId(files[1])]);
  assert.equal((await lastReference.planCoverCollection()).referenceCounts[url(PNG)], undefined);
  assert.deepEqual((await lastReference.collectCovers()).removed, [], 'live old DTO references remain conservative');
  await lastReference.close();
  assert.deepEqual((await lastReference.collectCovers()).removed, [filename(PNG)]);
  await assert.rejects(fs.access(path.join(coversDir, filename(PNG))), { code: 'ENOENT' });
});

test('an older closed service refuses collection after a different service publishes a new cover reference', async t => {
  const { root, coversDir, create } = await fixture(t);
  const old = create();
  await old.createPlaylist('Initial');
  await old.close();
  await fs.writeFile(path.join(coversDir, filename(PNG)), PNG);
  const file = path.join(root, 'new-reference.wav');
  await fs.writeFile(file, 'synthetic');
  const active = create({ metadataParser: async () => ({ common: { picture: [{ data: PNG }] } }) });
  await active.importFiles([file]);
  await assert.rejects(old.collectCovers(), /changed outside this service/);
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
});

test('bounded collection exposes immutable operation state and counts a physical unlink until it really settles', async t => {
  const {coversDir, create} = await fixture(t);
  let enter, release, calls = 0;
  const entered = new Promise(resolve => {enter = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const io = {...fs, async unlink(target) {
    if (path.dirname(target) === coversDir) {calls++; enter(); await gate;}
    return fs.unlink(target);
  }};
  const service = create({fileSystem: io}); await service.initialize(); await service.close();
  const images = [PNG, Buffer.concat([PNG, Buffer.from('second')])];
  await Promise.all(images.map(bytes => fs.writeFile(path.join(coversDir, filename(bytes)), bytes)));
  const controller = new AbortController();
  const operation = service.collectCovers({signal: controller.signal, maxDeletes: 2});
  assert.equal(Object.getOwnPropertyDescriptor(operation, 'getState').writable, false);
  assert.throws(() => {operation.getState = () => ({});}, TypeError);
  let heldState;
  try {
    await entered;
    heldState = operation.getState(); assert.equal(Object.isFrozen(heldState), true);
    assert.deepEqual(heldState, {phase: 'collecting', pendingDeletes: 1, settled: false});
    controller.abort(); await Promise.resolve();
    assert.equal(operation.getState().pendingDeletes, 1, 'abort cannot settle a submitted unlink');
  } finally {release();}
  const result = await operation;
  assert.equal(result.removed.length, 1); assert.equal(calls, 1);
  assert.deepEqual(operation.getState(), {phase: 'settled', pendingDeletes: 0, settled: true});
  assert.equal(heldState.pendingDeletes, 1, 'state snapshots are detached');
  assert.equal((await fs.readdir(coversDir)).length, 1, 'future deletes were revoked');
});

test('collection cancellation after the final database read prevents unlink admission', async t => {
  const {coversDir, dataDir, create} = await fixture(t);
  const controller = new AbortController(); let operation, unlinks = 0;
  const io = {...fs, async open(target, flags) {
    const handle = await fs.open(target, flags);
    if (target !== path.join(dataDir, 'library.json') || flags !== 'r') return handle;
    return {stat: (...args) => handle.stat(...args), close: () => handle.close(), async readFile() {
      const bytes = await handle.readFile();
      if (operation?.getState().phase === 'collecting') controller.abort();
      return bytes;
    }};
  }, async unlink(target) {unlinks++; return fs.unlink(target);}};
  const service = create({fileSystem: io}); await service.createPlaylist('DB identity'); await service.close();
  await fs.writeFile(path.join(coversDir, filename(PNG)), PNG);
  operation = service.collectCovers({signal: controller.signal});
  const result = await operation;
  assert.equal(result.interrupted, true); assert.equal(unlinks, 0);
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
});

test('expired, aborted and zero-budget collection never admits a cover deletion', async t => {
  const {coversDir, create} = await fixture(t); let unlinks = 0;
  const service = create({fileSystem: {...fs, async unlink(target) {unlinks++; return fs.unlink(target);}}});
  await service.initialize(); await service.close(); await fs.writeFile(path.join(coversDir, filename(PNG)), PNG);
  const controller = new AbortController(); controller.abort();
  for (const options of [{deadlineAt: Date.now() - 1}, {signal: controller.signal}, {maxDeletes: 0}]) {
    const operation = service.collectCovers(options), result = await operation;
    assert.equal(result.interrupted, true); assert.equal(operation.getState().settled, true);
  }
  assert.equal(unlinks, 0); assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
  for (const options of [{maxDeletes: -1}, {maxDeletes: 1.5}, {deadlineAt: NaN}, {signal: {}}]) await assert.rejects(service.collectCovers(options), TypeError);
});

test('bounded collection limits planning and counts failed unlink attempts against maxDeletes', async t => {
  const {coversDir, create} = await fixture(t); let attempts = 0;
  const service = create({fileSystem: {...fs, async unlink(target) {
    if (path.dirname(target) === coversDir) {attempts++; throw new Error('Fixture unlink refusal');}
    return fs.unlink(target);
  }}});
  await service.initialize(); await service.close();
  for (const bytes of [PNG, Buffer.concat([PNG, Buffer.from('other')])]) await fs.writeFile(path.join(coversDir, filename(bytes)), bytes);
  const result = await service.collectCovers({maxDeletes: 1});
  assert.equal(result.candidates.length, 1); assert.equal(result.errors.length, 1); assert.equal(attempts, 1);
  assert.equal((await fs.readdir(coversDir)).length, 2);
});

for (const revoke of [false, true]) test(`queued collection snapshots its options before callers can mutate them (abort=${revoke})`, async t => {
  const {coversDir, create} = await fixture(t); let armed = false, enter, release, attempts = 0;
  const entered = new Promise(resolve => {enter = resolve;}), gate = new Promise(resolve => {release = resolve;});
  const io = {...fs, async readdir(target, settings) {
    if (armed && target === coversDir) {armed = false; enter(); await gate;}
    return fs.readdir(target, settings);
  }, async unlink(target) {attempts++; return fs.unlink(target);}};
  const service = create({fileSystem: io}); await service.initialize(); await service.close();
  for (const bytes of [PNG, Buffer.concat([PNG, Buffer.from('one')]), Buffer.concat([PNG, Buffer.from('two')])]) await fs.writeFile(path.join(coversDir, filename(bytes)), bytes);
  armed = true; const blocker = service.planCoverCollection();
  let operation;
  try {
    await entered;
    const controller = new AbortController(), options = {retainUrls: [url(PNG)], signal: controller.signal, deadlineAt: Infinity, maxDeletes: 1};
    operation = service.collectCovers(options); assert.equal(operation.getState().phase, 'queued');
    options.retainUrls.length = 0; options.signal = new AbortController().signal;
    options.deadlineAt = Date.now() - 1; options.maxDeletes = Infinity;
    if (revoke) controller.abort();
  } finally {release();}
  await blocker; const result = await operation;
  assert.equal(attempts, revoke ? 0 : 1); assert.equal(result.removed.length, revoke ? 0 : 1);
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
});

test('wall-clock rollback cannot extend the monotonic collection deadline', async t => {
  const {coversDir, create} = await fixture(t); let armed = false, enter, release, unlinks = 0;
  const entered = new Promise(resolve => {enter = resolve;}), gate = new Promise(resolve => {release = resolve;});
  const service = create({fileSystem: {...fs, async readdir(target, settings) {
    if (armed && target === coversDir) {enter(); await gate;}
    return fs.readdir(target, settings);
  }, async unlink(target) {unlinks++; return fs.unlink(target);}}});
  await service.initialize(); await service.close(); await fs.writeFile(path.join(coversDir, filename(PNG)), PNG);
  let wallTime = Date.now(); const originalWallTime = wallTime;
  t.mock.method(Date, 'now', () => wallTime);
  armed = true; const operation = service.collectCovers({deadlineAt: originalWallTime + 10});
  try {await entered; await new Promise(resolve => setTimeout(resolve, 20)); wallTime -= 60000;}
  finally {release();}
  assert.equal((await operation).interrupted, true); assert.equal(unlinks, 0);
});

test('bounded collection makes progress across a large directory in repeated unchanged 250ms budgets', async t => {
  const {coversDir, create} = await fixture(t), clock = {elapsed: 0}, admittedAt = [];
  const {factory, now} = await clockedLibrary(clock);
  const service = create({fileSystem: {...fs, async open(target, flags) {
    if (path.dirname(target) === coversDir && flags === 'r') clock.elapsed += 20;
    return fs.open(target, flags);
  }, async unlink(target) {admittedAt.push(clock.elapsed); return fs.unlink(target);}}}, factory);
  await service.createPlaylist('Progress'); await service.close();
  for (let index = 0; index < 64; index++) {
    const bytes = Buffer.concat([PNG, Buffer.from(`progress-${index}`)]);
    await fs.writeFile(path.join(coversDir, filename(bytes)), bytes);
  }
  let remaining = 64, rounds = 0;
  while (remaining) {
    const startedAt = clock.elapsed, before = admittedAt.length;
    const operation = service.collectCovers({deadlineAt: now() + 250, maxDeletes: 64});
    const result = await operation;
    assert.ok(result.removed.length > 0, 'later candidate planning must not starve every unlink');
    assert.ok(result.removed.length <= 64);
    assert.ok(admittedAt.slice(before).every(time => time - startedAt < 250), 'each unlink was admitted before the same deadline');
    if (rounds === 0) assert.equal(result.removed.length, 6, 'one plan+revalidation costs 40ms; the 64-candidate batch no longer consumes the whole budget first');
    remaining -= result.removed.length; rounds++;
    assert.equal(operation.getState().pendingDeletes, 0); assert.equal(operation.getState().settled, true);
    assert.equal((await fs.readdir(coversDir)).length, remaining); assert.ok(rounds <= 11);
  }
  assert.equal(admittedAt.length, 64);
});

test('incremental bounded planning keeps managed format, links, refs, retained URLs and per-delete identity protections', async t => {
  const {root, coversDir, create} = await fixture(t);
  const orphan = Buffer.concat([PNG, Buffer.from('orphan')]), changed = Buffer.concat([PNG, Buffer.from('replaced')]);
  const retained = Buffer.concat([PNG, Buffer.from('retained')]), linked = Buffer.concat([PNG, Buffer.from('linked')]);
  const orphanPath = path.join(coversDir, filename(orphan)); let operation, unlinks = 0, replaced = false;
  const io = {...fs, async lstat(target, ...args) {
    if (target === orphanPath && operation?.getState().phase === 'collecting' && !replaced) {replaced = true; await fs.writeFile(target, changed);}
    return fs.lstat(target, ...args);
  }, async unlink(target) {unlinks++; return fs.unlink(target);}};
  const service = create({fileSystem: io, metadataParser: async () => ({common: {picture: [{data: PNG}]}})});
  const audio = path.join(root, 'current-reference.wav'); await fs.writeFile(audio, 'synthetic'); await service.importFiles([audio]); await service.close();
  await fs.writeFile(orphanPath, orphan); await fs.writeFile(path.join(coversDir, filename(retained)), retained);
  const outside = path.join(root, 'outside.png'); await fs.writeFile(outside, linked); await fs.link(outside, path.join(coversDir, filename(linked)));
  const nested = `${'1'.repeat(64)}.png`; await fs.mkdir(path.join(coversDir, nested));
  const badFormat = filename(PNG).replace('.png', '.jpg'); await fs.writeFile(path.join(coversDir, badFormat), PNG);
  await fs.writeFile(path.join(coversDir, 'user-photo.png'), PNG);
  operation = service.collectCovers({retainUrls: [url(retained)], deadlineAt: Date.now() + 5000, maxDeletes: 64});
  const result = await operation;
  assert.equal(result.removed.length, 0); assert.equal(result.errors.length, 1); assert.equal(unlinks, 0);
  assert.ok(result.skipped.some(item => item.filename === filename(linked)));
  assert.ok(result.skipped.some(item => item.filename === nested)); assert.ok(result.skipped.some(item => item.filename === badFormat));
  for (const bytes of [PNG, retained]) assert.deepEqual(await fs.readFile(path.join(coversDir, filename(bytes))), bytes);
  assert.deepEqual(await fs.readFile(orphanPath), changed); assert.deepEqual(await fs.readFile(outside), linked);
  assert.deepEqual(await fs.readFile(path.join(coversDir, 'user-photo.png')), PNG);
});

test('incremental collection checks database identity again after yielding a candidate and before unlink admission', async t => {
  const {coversDir, create} = await fixture(t); let operation, replacement, changed = false, unlinks = 0;
  const coverPath = path.join(coversDir, filename(PNG));
  const old = create({fileSystem: {...fs, async lstat(target, ...args) {
    if (target === coverPath && operation?.getState().phase === 'collecting' && !changed) {changed = true; await replacement.createPlaylist('New session commit');}
    return fs.lstat(target, ...args);
  }, async unlink(target) {unlinks++; return fs.unlink(target);}}});
  await old.createPlaylist('Old session'); await old.close(); replacement = create(); await replacement.initialize();
  await fs.writeFile(coverPath, PNG);
  operation = old.collectCovers({deadlineAt: Date.now() + 5000, maxDeletes: 64});
  const result = await operation;
  assert.equal(changed, true); assert.equal(unlinks, 0); assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /changed outside this service/); assert.deepEqual(await fs.readFile(coverPath), PNG);
});

test('default unbounded collection still returns a complete sorted plan before deleting in that order', async t => {
  const {coversDir, create} = await fixture(t), reads = [], unlinks = [];
  const service = create({fileSystem: {...fs, async readdir(target, options) {
    const entries = await fs.readdir(target, options); return target === coversDir ? entries.reverse() : entries;
  }, async open(target, flags) {if (path.dirname(target) === coversDir && flags === 'r') reads.push(path.basename(target)); return fs.open(target, flags);},
  async unlink(target) {unlinks.push({name: path.basename(target), reads: reads.length}); return fs.unlink(target);}}});
  await service.initialize(); await service.close();
  const names = [];
  for (const suffix of ['one', 'two', 'three']) {
    const bytes = Buffer.concat([PNG, Buffer.from(suffix)]); names.push(filename(bytes)); await fs.writeFile(path.join(coversDir, filename(bytes)), bytes);
  }
  const result = await service.collectCovers(); names.sort((left, right) => left.localeCompare(right, 'en'));
  assert.deepEqual(result.candidates.map(item => item.filename), names); assert.deepEqual(result.removed, names);
  assert.deepEqual(unlinks.map(item => item.name), names); assert.equal(unlinks[0].reads, 4, 'all three candidates are planned before the first per-delete reread');
  assert.equal(Object.hasOwn(result, 'interrupted'), false); assert.equal(result.errors.length, 0);
});

for (const kind of ['corrupt', 'reset']) test(`a ${kind} recovery backup protects old artwork after a later ready initialization`, async t => {
  const {root, dataDir, coversDir, create} = await fixture(t), database = path.join(dataDir, 'library.json');
  const original = create({metadataParser: async () => ({common: {picture: [{data: PNG}]}})});
  const audio = path.join(root, 'recovery-reference.wav'); await fs.writeFile(audio, 'synthetic'); await original.importFiles([audio]); await original.close();
  if (kind === 'corrupt') await fs.appendFile(database, '\n{ invalid trailing bytes');
  const recovered = create(); await recovered.initialize({reset: kind === 'reset'});
  assert.equal(recovered.getStatus().recovered, true); assert.ok(path.basename(recovered.getStatus().backupPath).startsWith(`library-${kind}-`));
  await recovered.close();
  let backupReads = 0, unlinks = 0;
  const ready = create({fileSystem: {...fs, async open(target, flags) {
    if (/^library-(?:corrupt|reset)-/i.test(path.basename(target))) {backupReads++; throw new Error('Backup contents must not be read by GC');}
    return fs.open(target, flags);
  }, async unlink(target) {unlinks++; return fs.unlink(target);}}});
  await ready.initialize(); assert.equal(ready.getStatus().status, 'ready'); assert.equal(ready.getStatus().recovered, false); await ready.close();
  const plan = await ready.planCoverCollection(); assert.equal(plan.recoveryRetention, 'recovery-backup-present'); assert.deepEqual(plan.candidates, []);
  for (const options of [undefined, {deadlineAt: Date.now() + 5000, maxDeletes: 64}]) {
    const operation = ready.collectCovers(options), result = await operation;
    assert.equal(result.recoveryRetention, 'recovery-backup-present'); assert.equal(Object.hasOwn(result, 'interrupted'), false);
    assert.deepEqual(result.removed, []); assert.deepEqual(result.errors, []); assert.equal(operation.getState().settled, true); assert.equal(operation.getState().pendingDeletes, 0);
  }
  assert.equal(unlinks, 0); assert.equal(backupReads, 0); assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
  assert.ok((await fs.readdir(dataDir)).some(name => name.startsWith(`library-${kind}-`)));
});

for (const marker of ['LiBrArY-CoRrUpT-user-kept.json', 'LIBRARY-RESET-OLD-FORMAT', 'library-reset-partial.tmp', 'library-corrupt-directory']) test(`the recovery marker family conservatively retains covers for ${marker}`, async t => {
  const {dataDir, coversDir, create} = await fixture(t); let backupReads = 0;
  const service = create({fileSystem: {...fs, async open(target, flags) {
    if (/^library-(?:corrupt|reset)-/i.test(path.basename(target))) {backupReads++; throw new Error('Do not open recovery markers');}
    return fs.open(target, flags);
  }}});
  await service.createPlaylist('Marker family'); await service.close(); await fs.writeFile(path.join(coversDir, filename(PNG)), PNG);
  if (marker.endsWith('directory')) await fs.mkdir(path.join(dataDir, marker));
  else await fs.writeFile(path.join(dataDir, marker), '{ intentionally unreadable backup JSON');
  const result = await service.collectCovers({deadlineAt: Date.now() + 5000, maxDeletes: 64});
  assert.equal(result.recoveryRetention, 'recovery-backup-present'); assert.deepEqual(result.removed, []); assert.equal(backupReads, 0);
  assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
});

test('recovery marker names are sufficient even for links and never cause type inspection or following', async t => {
  const {dataDir, coversDir, create} = await fixture(t); let armed = false, followed = 0;
  const marker = 'library-reset-opaque-link';
  const service = create({fileSystem: {...fs, async readdir(target, options) {
    const entries = await fs.readdir(target, options);
    if (armed && target === dataDir) entries.push({name: marker,
      isFile() {throw new Error('No marker type inspection');}, isDirectory() {throw new Error('No marker type inspection');}, isSymbolicLink() {throw new Error('No marker type inspection');}});
    return entries;
  }, async lstat(target, ...args) {if (target === path.join(dataDir, marker)) {followed++; throw new Error('Do not follow the recovery marker');} return fs.lstat(target, ...args);}}});
  await service.initialize(); await service.close(); await fs.writeFile(path.join(coversDir, filename(PNG)), PNG); armed = true;
  const plan = await service.planCoverCollection(), result = await service.collectCovers();
  assert.equal(plan.recoveryRetention, 'recovery-backup-present'); assert.equal(result.recoveryRetention, 'recovery-backup-present');
  assert.equal(followed, 0); assert.deepEqual(result.removed, []);
});

for (const bounded of [false, true]) test(`a recovery marker appearing after one unlink stops every later deletion (bounded=${bounded})`, async t => {
  const {dataDir, coversDir, create} = await fixture(t); let unlinks = 0;
  const service = create({fileSystem: {...fs, async unlink(target) {
    await fs.unlink(target); unlinks++;
    if (unlinks === 1) await fs.writeFile(path.join(dataDir, 'library-corrupt-new-marker.tmp'), '{ invalid');
  }}});
  await service.initialize(); await service.close();
  for (const suffix of ['one', 'two', 'three']) {const bytes = Buffer.concat([PNG, Buffer.from(suffix)]); await fs.writeFile(path.join(coversDir, filename(bytes)), bytes);}
  const operation = service.collectCovers(bounded ? {deadlineAt: Date.now() + 5000, maxDeletes: 64} : undefined), result = await operation;
  assert.equal(unlinks, 1); assert.equal(result.removed.length, 1); assert.equal(result.recoveryRetention, 'recovery-backup-present');
  assert.equal(Object.hasOwn(result, 'interrupted'), false); assert.equal((await fs.readdir(coversDir)).length, 2);
  assert.deepEqual(operation.getState(), {phase: 'settled', pendingDeletes: 0, settled: true});
});

test('unreadable or unknown data-directory scans retain covers instead of authorizing deletion', async t => {
  const {dataDir, coversDir, create} = await fixture(t); let armed = false, unlinks = 0;
  const service = create({fileSystem: {...fs, async readdir(target, options) {
    if (armed && target === dataDir) throw Object.assign(new Error('Injected data directory refusal'), {code: 'EACCES'});
    return fs.readdir(target, options);
  }, async unlink(target) {unlinks++; return fs.unlink(target);}}});
  await service.initialize(); await service.close(); await fs.writeFile(path.join(coversDir, filename(PNG)), PNG); armed = true;
  const plan = await service.planCoverCollection(); assert.equal(plan.recoveryRetention, 'recovery-status-unavailable');
  for (const options of [undefined, {deadlineAt: Date.now() + 5000, maxDeletes: 64}]) {
    const result = await service.collectCovers(options); assert.equal(result.recoveryRetention, 'recovery-status-unavailable');
    assert.deepEqual(result.removed, []); assert.equal(Object.hasOwn(result, 'interrupted'), false);
  }
  assert.equal(unlinks, 0); assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
});

test('a failed marker scan immediately before unlink seals the operation even if the next scan could succeed', async t => {
  const {dataDir, coversDir, create} = await fixture(t); let scans = 0, unlinks = 0, armed = false;
  const service = create({fileSystem: {...fs, async readdir(target, options) {
    if (armed && target === dataDir && ++scans === 2) throw new Error('The per-unlink scan cannot establish recovery ownership');
    return fs.readdir(target, options);
  }, async unlink(target) {unlinks++; return fs.unlink(target);}}});
  await service.initialize(); await service.close();
  for (const suffix of ['one', 'two']) {const bytes = Buffer.concat([PNG, Buffer.from(suffix)]); await fs.writeFile(path.join(coversDir, filename(bytes)), bytes);}
  armed = true; const result = await service.collectCovers({deadlineAt: Date.now() + 5000, maxDeletes: 64});
  assert.equal(scans, 2); assert.equal(unlinks, 0); assert.equal(result.recoveryRetention, 'recovery-status-unavailable');
  assert.equal(Object.hasOwn(result, 'interrupted'), false); assert.equal((await fs.readdir(coversDir)).length, 2);
});

test('normal shutdown maintenance logs persistent recovery retention as skipped rather than complete or expired', async t => {
  const {dataDir, coversDir, create} = await fixture(t), events = [];
  const service = create(); await service.initialize(); await service.close(); await fs.writeFile(path.join(coversDir, filename(PNG)), PNG);
  await fs.writeFile(path.join(dataDir, 'library-reset-user-kept'), '{ invalid');
  const gc = createShutdownCoverGc({library: service, record: event => events.push(event)});
  await gc.finish({eligible: true});
  assert.deepEqual(events, ['cover-gc-skipped']); assert.deepEqual(await fs.readFile(path.join(coversDir, filename(PNG))), PNG);
});

test('a per-delete recovery scan cannot invalidate the final database witness', async t => {
  const {root, dataDir, coversDir, create} = await fixture(t);
  const audio = path.join(root, 'new-database-reference.wav'); await fs.writeFile(audio, 'synthetic');
  let armed = false, scans = 0, unlinks = 0, replacement;
  const old = create({fileSystem: {...fs, async readdir(target, options) {
    if (armed && target === dataDir && ++scans === 2) await replacement.importFiles([audio]);
    return fs.readdir(target, options);
  }, async unlink(target) {unlinks++; return fs.unlink(target);}}});
  await old.createPlaylist('Old database witness'); await old.close();
  replacement = create({metadataParser: async () => ({common: {picture: [{data: PNG}]}})}); await replacement.initialize();
  const coverPath = path.join(coversDir, filename(PNG)); await fs.writeFile(coverPath, PNG);
  armed = true; const result = await old.collectCovers({deadlineAt: Date.now() + 5000, maxDeletes: 64});
  const newDbRefs = replacement.getTrack(trackId(audio))?.coverUrl === url(PNG);
  t.diagnostic(JSON.stringify({newDbRefs, scans, unlinks, removed: result.removed.length, errors: result.errors.length}));
  assert.equal(newDbRefs, true); assert.equal(scans, 2); assert.equal(unlinks, 0);
  assert.deepEqual(result.removed, []); assert.equal(result.errors.length, 1); assert.match(result.errors[0].message, /changed outside this service/);
  assert.deepEqual(await fs.readFile(coverPath), PNG);
});

for (const bounded of [false, true]) test(`cover GC rejects adjacent exact FileIDs that collide as Numbers (bounded=${bounded})`, async t => {
  const {coversDir, create} = await fixture(t), coverPath = path.join(coversDir, filename(PNG));
  const beforeID = 9007199254740992n, afterID = 9007199254740993n;
  assert.notEqual(beforeID, afterID); assert.equal(Number(beforeID), Number(afterID));
  let operation, virtualUnlinks = 0;
  const reads = [];
  function present(stat, options) {
    const ino = operation?.getState().phase === 'collecting' ? afterID : beforeID;
    return new Proxy(stat, {get(object, member) {
      if (member === 'ino') return options?.bigint ? ino : Number(ino);
      const value = Reflect.get(object, member, object); return typeof value === 'function' ? value.bind(object) : value;
    }});
  }
  const io = {...fs, async lstat(target, options, ...args) {
    const stat = await fs.lstat(target, options, ...args);
    if (target !== coverPath) return stat;
    reads.push({phase: operation?.getState().phase ?? 'public-plan', bigint: options?.bigint === true}); return present(stat, options);
  }, async open(target, flags, ...args) {
    const handle = await fs.open(target, flags, ...args);
    if (target !== coverPath) return handle;
    return new Proxy(handle, {get(object, member) {
      if (member === 'stat') return async (options, ...args) => present(await object.stat(options, ...args), options);
      const value = Reflect.get(object, member, object); return typeof value === 'function' ? value.bind(object) : value;
    }});
  }, async unlink(target, ...args) {
    if (target === coverPath) {virtualUnlinks++; return;}
    return fs.unlink(target, ...args);
  }};
  const service = create({fileSystem: io}); await service.createPlaylist('Exact GC identity'); await service.close();
  await fs.writeFile(coverPath, PNG);
  operation = service.collectCovers(bounded ? {deadlineAt: Date.now() + 5000, maxDeletes: 64} : undefined);
  const result = await operation;
  t.diagnostic(JSON.stringify({bounded, injectedBefore: String(beforeID), injectedAfter: String(afterID), roundedBoth: Number(beforeID),
    virtualUnlinks, removed: result.removed.length, errors: result.errors.length, nonBigIntWitnessReads: reads.filter(read => !read.bigint).length}));
  assert.equal(virtualUnlinks, 0, 'a different exact FileID must never authorize unlink');
  assert.deepEqual(result.removed, []); assert.equal(result.errors.length, 1); assert.match(result.errors[0].message, /changed after collection planning/);
  assert.equal(reads.every(read => read.bigint), true); assert.equal(operation.getState().pendingDeletes, 0);
  assert.doesNotThrow(() => JSON.stringify(result)); assert.deepEqual(await fs.readFile(coverPath), PNG);
});

test('public cover plans and results use exact decimal IDs without exposing private BigInt witnesses', async t => {
  const {coversDir, create} = await fixture(t), coverPath = path.join(coversDir, filename(PNG));
  const highID = 9007199254740993n, unlinks = [];
  const present = (stat, options) => new Proxy(stat, {get(object, member) {
    if (member === 'ino') return options?.bigint ? highID : Number(highID);
    const value = Reflect.get(object, member, object); return typeof value === 'function' ? value.bind(object) : value;
  }});
  const service = create({fileSystem: {...fs, async lstat(target, options, ...args) {
    const stat = await fs.lstat(target, options, ...args); return target === coverPath ? present(stat, options) : stat;
  }, async open(target, flags, ...args) {
    const handle = await fs.open(target, flags, ...args); if (target !== coverPath) return handle;
    return new Proxy(handle, {get(object, member) {
      if (member === 'stat') return async (options, ...args) => present(await object.stat(options, ...args), options);
      const value = Reflect.get(object, member, object); return typeof value === 'function' ? value.bind(object) : value;
    }});
  }, async unlink(target, ...args) {if (target === coverPath) {unlinks.push(target); return;} return fs.unlink(target, ...args);}}});
  await service.initialize(); await service.close(); await fs.writeFile(coverPath, PNG);
  const userCover = path.join(coversDir, 'user-photo.png'); await fs.writeFile(userCover, PNG);
  const plan = await service.planCoverCollection(), candidate = plan.candidates[0];
  assert.equal(candidate.ino, String(highID)); assert.equal(typeof candidate.dev, 'string'); assert.equal(typeof candidate.bytes, 'number');
  assert.equal(JSON.parse(JSON.stringify(plan)).candidates[0].ino, String(highID));
  // A public plan's display fields and path are not deletion authority. The
  // collector always replans and uses only its private exact witness.
  candidate.dev = 'forged'; candidate.ino = 'forged'; candidate.bytes = -1; candidate.path = userCover;
  const result = await service.collectCovers();
  assert.deepEqual(unlinks, [coverPath]); assert.deepEqual(result.removed, [filename(PNG)]);
  assert.equal(result.candidates[0].ino, String(highID)); assert.equal(JSON.parse(JSON.stringify(result)).candidates[0].ino, String(highID));
  assert.deepEqual(await fs.readFile(userCover), PNG);
});

for (const phase of ['planning', 'collecting']) test(`a Number-only FileID adapter fails closed during ${phase}`, async t => {
  const {coversDir, create} = await fixture(t), coverPath = path.join(coversDir, filename(PNG));
  const highID = 9007199254740993n; let operation, unlinks = 0;
  const present = (stat, options) => new Proxy(stat, {get(object, member) {
    if (member === 'ino') return (operation?.getState().phase ?? 'planning') === phase ? Number(highID) : options?.bigint ? highID : Number(highID);
    const value = Reflect.get(object, member, object); return typeof value === 'function' ? value.bind(object) : value;
  }});
  const service = create({fileSystem: {...fs, async lstat(target, options, ...args) {
    const stat = await fs.lstat(target, options, ...args); return target === coverPath ? present(stat, options) : stat;
  }, async open(target, flags, ...args) {
    const handle = await fs.open(target, flags, ...args); if (target !== coverPath) return handle;
    return new Proxy(handle, {get(object, member) {
      if (member === 'stat') return async (options, ...args) => present(await object.stat(options, ...args), options);
      const value = Reflect.get(object, member, object); return typeof value === 'function' ? value.bind(object) : value;
    }});
  }, async unlink(target, ...args) {if (target === coverPath) {unlinks++; return;} return fs.unlink(target, ...args);}}});
  await service.initialize(); await service.close(); await fs.writeFile(coverPath, PNG);
  operation = service.collectCovers({deadlineAt: Date.now() + 5000, maxDeletes: 64}); const result = await operation;
  assert.equal(unlinks, 0); assert.deepEqual(result.removed, []);
  if (phase === 'planning') assert.equal(result.skipped.length, 1);
  else {assert.equal(result.errors.length, 1); assert.match(result.errors[0].message, /exact managed cover identity is unavailable/);}
  assert.doesNotThrow(() => JSON.stringify(result)); assert.deepEqual(await fs.readFile(coverPath), PNG);
});

test('the byte reread must retain the same exact private identity as the planned cover', async t => {
  const {coversDir, create} = await fixture(t), coverPath = path.join(coversDir, filename(PNG));
  const beforeID = 9007199254740992n, afterID = 9007199254740993n;
  let operation, collectingStats = 0, currentID = beforeID, unlinks = 0;
  const present = (stat, options) => new Proxy(stat, {get(object, member) {
    if (member === 'ino') return options?.bigint ? currentID : Number(currentID);
    const value = Reflect.get(object, member, object); return typeof value === 'function' ? value.bind(object) : value;
  }});
  const service = create({fileSystem: {...fs, async lstat(target, options, ...args) {
    const stat = await fs.lstat(target, options, ...args); if (target !== coverPath) return stat;
    if (operation?.getState().phase === 'collecting' && ++collectingStats === 2) currentID = afterID;
    return present(stat, options);
  }, async open(target, flags, ...args) {
    const handle = await fs.open(target, flags, ...args); if (target !== coverPath) return handle;
    return new Proxy(handle, {get(object, member) {
      if (member === 'stat') return async (options, ...args) => present(await object.stat(options, ...args), options);
      const value = Reflect.get(object, member, object); return typeof value === 'function' ? value.bind(object) : value;
    }});
  }, async unlink(target, ...args) {if (target === coverPath) {unlinks++; return;} return fs.unlink(target, ...args);}}});
  await service.initialize(); await service.close(); await fs.writeFile(coverPath, PNG);
  operation = service.collectCovers({deadlineAt: Date.now() + 5000, maxDeletes: 64}); const result = await operation;
  assert.ok(collectingStats >= 2); assert.equal(unlinks, 0); assert.deepEqual(result.removed, []);
  assert.equal(result.errors.length, 1); assert.match(result.errors[0].message, /changed before collection/);
});
