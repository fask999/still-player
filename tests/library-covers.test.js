'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createLibraryService, trackId } = require('../src/main/library');

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
  return { root, dataDir, coversDir: path.join(dataDir, 'covers'), create(options = {}) { const service = createLibraryService({ dataDir, ...options }); services.push(service); return service; } };
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
  const io = { ...fs, async lstat(target) {
    if (changeBeforeDelete && target === changedPath) {
      changeBeforeDelete = false;
      await fs.writeFile(changedPath, PNG);
    }
    return fs.lstat(target);
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
