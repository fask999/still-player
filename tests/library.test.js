'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createLibraryService, trackId, AUDIO_EXTENSIONS } = require('../src/main/library');
const {planSeed, seedLibrary} = require('../scripts/seed-library');

function chunk(id, data) {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'ascii');
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])]);
}

function wav({ title = 'Actual WAV title', artist = 'Actual artist', album = 'Actual album', id3 = null } = {}) {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(2, 2);
  format.writeUInt32LE(48000, 4);
  format.writeUInt32LE(48000 * 4, 8);
  format.writeUInt16LE(4, 12);
  format.writeUInt16LE(16, 14);
  const info = Buffer.concat([Buffer.from('INFO'), chunk('INAM', Buffer.from(`${title}\0`)), chunk('IART', Buffer.from(`${artist}\0`)), chunk('IPRD', Buffer.from(`${album}\0`))]);
  const content = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', format), chunk('LIST', info), ...(id3 ? [chunk('id3 ', id3)] : []), chunk('data', Buffer.alloc(48000 * 4))]);
  const header = Buffer.alloc(8);
  header.write('RIFF');
  header.writeUInt32LE(content.length, 4);
  return Buffer.concat([header, content]);
}

function id3WithPicture(picture) {
  const frames = [];
  function frame(id, bytes) {
    const header = Buffer.alloc(10);
    header.write(id);
    header.writeUInt32BE(bytes.length, 4);
    frames.push(header, bytes);
  }
  for (const [id, value] of [['TPE2', 'Tagged album artist'], ['TRCK', '3/12'], ['TPOS', '2/2'], ['TYER', '2024'], ['TCON', 'Ambient']]) frame(id, Buffer.concat([Buffer.from([0]), Buffer.from(value)]));
  frame('APIC', Buffer.concat([Buffer.from([0]), Buffer.from('image/png\0'), Buffer.from([3, 0]), picture]));
  const content = Buffer.concat(frames);
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (content.length >>> 21) & 0x7f, (content.length >>> 14) & 0x7f, (content.length >>> 7) & 0x7f, content.length & 0x7f]);
  return Buffer.concat([header, content]);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(__dirname, '.tmp-library-'));
  const dataDir = path.join(root, 'data');
  const musicDir = path.join(root, 'music');
  await fs.mkdir(musicDir);
  const services = [];
  const create = options => {
    const service = createLibraryService({ dataDir, ...options });
    services.push(service);
    return service;
  };
  t.after(async () => {
    for (const service of services) await service.close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(__dirname));
    assert.ok(path.basename(resolved).startsWith('.tmp-library-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { root, dataDir, musicDir, create };
}

test('one-time library seed reads real metadata and preserves playlist occurrence order without overwriting a library', async t => {
  const {root, musicDir, dataDir, create} = await fixture(t);
  const file = path.join(musicDir, 'actual.wav'), missing = path.join(musicDir, 'missing.wav');
  await fs.writeFile(file, wav());
  const snapshotPath = path.join(root, 'snapshot.json');
  await fs.writeFile(snapshotPath, JSON.stringify({playlists: [{id: 'one', name: 'Actual existing list', items: [
    {path: file, subsong: 0}, {path: missing, subsong: 0}, {path: file, subsong: 0}
  ]}]}));
  const plan = await planSeed({snapshotPath, dataDir});
  assert.equal(plan.dryRun, true); assert.equal(plan.libraryExists, false);
  assert.equal(plan.existingFiles, 1); assert.equal(plan.missingFiles, 1);
  assert.equal(await fs.lstat(dataDir).then(() => true, () => false), false);
  const report = await seedLibrary(plan);
  assert.equal(report.validTracks, 1); assert.equal(report.occurrences, 3);
  const service = create(); await service.initialize();
  const result = service.list();
  assert.deepEqual(result.playlists[0].trackIds, [trackId(file), trackId(missing), trackId(file)]);
  assert.equal(result.tracks.find(item => item.path === file).title, 'Actual WAV title');
  assert.equal(result.tracks.find(item => item.path === missing).valid, false);
  const before = await fs.readFile(path.join(dataDir, 'library.json'));
  await assert.rejects(seedLibrary(plan), /already has a library/);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'library.json')), before);
});

test('one-time library seed rejects a captured snapshot changed after its reviewed plan', async t => {
  const {root, musicDir, dataDir} = await fixture(t);
  const snapshotPath = path.join(root, 'snapshot.json');
  const snapshot = {playlists: [{id: 'one', name: 'Real list', items: [{path: path.join(musicDir, 'missing.wav'), subsong: 0}]}]};
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
  const plan = await planSeed({snapshotPath, dataDir});
  snapshot.playlists[0].name = 'Changed after review';
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot));
  await assert.rejects(seedLibrary(plan), /changed after review/);
  assert.equal(await fs.lstat(dataDir).then(() => true, () => false), false);
});

test('starts empty, imports actual WAV tags and technical metadata, and preserves stable IDs', async t => {
  const { musicDir, dataDir, create } = await fixture(t);
  const file = path.join(musicDir, 'Filename.wav');
  await fs.writeFile(file, wav());
  const library = create();
  const empty = await library.initialize();
  assert.deepEqual(empty, { tracks: [], playlists: [], folders: [], revision: 0, status: library.getStatus(), eventCursors: { library: { streamId: empty.eventCursors.library.streamId, sequence: 0 } } });
  const snapshot = await library.importFiles([file, file, path.join(musicDir, 'not-music.txt')]);
  assert.equal(snapshot.tracks.length, 1);
  const track = snapshot.tracks[0];
  assert.equal(track.title, 'Actual WAV title');
  assert.equal(track.artist, 'Actual artist');
  assert.equal(track.album, 'Actual album');
  assert.equal(track.sampleRate, 48000);
  assert.equal(track.bitsPerSample, 16);
  assert.equal(track.channels, 2);
  assert.ok(Math.abs(track.duration - 1) < 0.001);
  assert.match(track.codec, /PCM/i);
  assert.equal(track.valid, true);
  assert.equal(track.subsong, 0);
  assert.equal(track.supported, true);
  assert.equal(track.albumArtist, '');
  assert.equal(track.trackNumber, null);
  assert.equal(track.coverUrl, '');
  assert.equal(track.id, trackId(file));
  if (process.platform === 'win32') {
    assert.equal(trackId(file.toUpperCase()), track.id);
    assert.equal((await library.importFiles([file.toUpperCase()])).tracks.length, 1);
  }
  const loaded = create();
  await loaded.initialize();
  assert.deepEqual(loaded.getTrack(track.id), library.getTrack(track.id));
  assert.equal(loaded.getTrack('missing'), null);
  assert.deepEqual(loaded.getTracks(['missing', track.id]).map(item => item.id), [track.id]);
  assert.equal((await fs.readdir(dataDir)).filter(name => name.endsWith('.tmp')).length, 0);
  // All getters return copies; UI edits cannot mutate persisted state.
  const detached = loaded.list();
  detached.tracks[0].title = 'Edited outside service';
  assert.equal(loaded.getTrack(track.id).title, 'Actual WAV title');
});

test('missing and malformed files remain indexed with honest unknown fields and explicit errors', async t => {
  const { musicDir, create } = await fixture(t);
  const corrupt = path.join(musicDir, 'Broken.flac');
  const missing = path.join(musicDir, 'Missing.mp3');
  await fs.writeFile(corrupt, 'not an audio file');
  const library = create();
  const snapshot = await library.importFiles([corrupt, missing]);
  assert.equal(snapshot.tracks.length, 2);
  for (const track of snapshot.tracks) {
    assert.equal(track.sampleRate, null);
    assert.equal(track.duration, null);
    assert.equal(track.album, '');
    assert.equal(track.codec, '');
    assert.ok(track.error);
  }
  assert.equal(snapshot.tracks[0].valid, true, 'metadata parsing does not predict whether foobar2000 can decode an accessible file');
  assert.equal(snapshot.tracks[0].supported, true);
  assert.ok(snapshot.tracks[0].metadataError);
  assert.equal(snapshot.tracks[1].valid, false);
  assert.equal(snapshot.tracks[0].title, 'Broken');
  assert.match(snapshot.tracks[1].error, /unavailable/i);
  await fs.writeFile(missing, wav());
  await library.refresh();
  assert.equal(library.getTrack(trackId(missing)).valid, true);
});

test('extracts embedded cover and full tags from real WAV without altering audio bytes', async t => {
  const { musicDir, dataDir, create } = await fixture(t);
  const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF1sAAAAASUVORK5CYII=', 'base64');
  const audio = wav({ id3: id3WithPicture(picture) });
  const files = [path.join(musicDir, 'cover-a.wav'), path.join(musicDir, 'cover-b.wav')];
  await Promise.all(files.map(file => fs.writeFile(file, audio)));
  const library = create();
  const snapshot = await library.importFiles(files);
  const track = snapshot.tracks[0];
  assert.equal(track.albumArtist, 'Tagged album artist');
  assert.equal(track.trackNumber, 3);
  assert.equal(track.discNumber, 2);
  assert.equal(track.year, 2024);
  assert.equal(track.genre, 'Ambient');
  assert.match(track.coverUrl, /^still-cover:\/\/art\/[a-f0-9]{64}\.png$/);
  assert.equal(snapshot.tracks[1].coverUrl, track.coverUrl);
  const coverFiles = await fs.readdir(path.join(dataDir, 'covers'));
  assert.equal(coverFiles.length, 1);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'covers', coverFiles[0])), picture);
  for (const file of files) assert.deepEqual(await fs.readFile(file), audio);
});

test('saved playlists preserve explicit order, deduplicate, serialize concurrent edits, and remove only the index', async t => {
  const { musicDir, create } = await fixture(t);
  const files = ['a.wav', 'b.wav', 'c.wav'].map(name => path.join(musicDir, name));
  await Promise.all(files.map((file, index) => fs.writeFile(file, wav({ title: `Track ${index}` }))));
  const library = create();
  await library.importFiles(files);
  const ids = files.map(file => trackId(file));
  let snapshot = await library.createPlaylist('  Saved list  ');
  const playlistId = snapshot.playlists[0].id;
  await Promise.all([library.addPlaylistTracks(playlistId, [ids[0], ids[1], ids[0]]), library.addPlaylistTracks(playlistId, [ids[2]])]);
  assert.deepEqual(library.list().playlists[0].trackIds, ids);
  snapshot = await library.setPlaylistTracks(playlistId, [ids[2], ids[0], ids[2], 'unknown', ids[1]]);
  assert.deepEqual(snapshot.playlists[0].trackIds, [ids[2], ids[0], ids[2], ids[1]]);
  await library.renamePlaylist(playlistId, 'Renamed');
  await library.removePlaylistTracks(playlistId, [ids[0]]);
  assert.deepEqual(library.list().playlists[0].trackIds, [ids[2], ids[2], ids[1]]);
  await fs.unlink(files[1]);
  snapshot = await library.refresh();
  assert.equal(library.getTrack(ids[1]).valid, false);
  assert.deepEqual(snapshot.playlists[0].trackIds, [ids[2], ids[2], ids[1]], 'missing audio retains the saved entry');
  snapshot = await library.remove([ids[2]]);
  assert.deepEqual(snapshot.playlists[0].trackIds, [ids[1]]);
  await fs.access(files[2]);
  const reloaded = create();
  await reloaded.initialize();
  assert.equal(reloaded.list().playlists[0].name, 'Renamed');
  assert.deepEqual(reloaded.list().playlists[0].trackIds, [ids[1]]);
  await reloaded.deletePlaylist(playlistId);
  assert.equal(reloaded.list().playlists.length, 0);
  assert.equal(reloaded.list().tracks.length, 2);
});

test('folder refresh discovers new files, skips directory links, and respects index removals', async t => {
  const { musicDir, root, create } = await fixture(t);
  const nested = path.join(musicDir, 'nested');
  await fs.mkdir(nested);
  const first = path.join(nested, 'first.wav');
  const second = path.join(nested, 'second.wav');
  await fs.writeFile(first, wav());
  const library = create();
  const snapshot = await library.importFolder(musicDir);
  assert.equal(snapshot.tracks.length, 1);
  assert.deepEqual(snapshot.folders, [musicDir]);
  await fs.writeFile(second, wav());
  await library.refresh();
  assert.equal(library.list().tracks.length, 2);
  await library.remove([trackId(first)]);
  await library.refresh();
  assert.equal(library.getTrack(trackId(first)), null);
  await fs.access(first);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'hidden.wav'), wav());
  try {
    await fs.symlink(outside, path.join(musicDir, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(musicDir, path.join(nested, 'loop-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await library.refresh();
    assert.equal(library.list().tracks.length, 1);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic(`Directory-link check unavailable: ${error.code}`);
  }
  await library.importFolder(musicDir);
  assert.equal(library.list().tracks.length, 2, 'an explicit reimport restores a removed index entry');
});

test('foobar copies retain authoritative subsongs, metadata, source, missing paths, and user playlist edits', async t => {
  const { musicDir, create } = await fixture(t);
  const cue = path.join(musicDir, 'actual.cue');
  await fs.writeFile(path.join(musicDir, 'actual.wav'), wav());
  await fs.writeFile(cue, 'FILE "actual.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:00:30\n');
  const missing = path.join(musicDir, 'gone.wav');
  const snapshot = { playlists: [{ id: 'source-7', name: 'Existing foobar playlist', items: [
    { path: cue, subsong: 0, title: 'Cue first', artist: 'Cue artist', duration: 0.5 },
    { path: cue, subsong: 1, title: 'Cue second', albumArtist: 'Album artist', duration: 0.5 },
    { path: missing, subsong: 0, title: 'Missing source entry' },
  ] }] };
  const library = create();
  await library.importFoobar(snapshot);
  assert.equal(library.list().tracks.length, 3);
  const first = library.getTrack(trackId(cue, 0));
  const second = library.getTrack(trackId(cue, 1));
  assert.notEqual(first.id, second.id);
  assert.equal(first.title, 'Cue first');
  assert.equal(second.title, 'Cue second');
  assert.equal(second.albumArtist, 'Album artist');
  assert.equal(second.duration, 0.5);
  assert.equal(second.source, 'foobar2000');
  assert.equal(second.metadataSource, 'foobar2000');
  assert.equal(second.supported, true);
  assert.equal(library.getTrack(trackId(missing)).valid, false);
  assert.equal(library.getTrack(trackId(missing)).title, 'Missing source entry');
  const playlist = library.list().playlists[0];
  assert.equal(playlist.source, 'foobar2000');
  assert.deepEqual(playlist.trackIds, [first.id, second.id, trackId(missing)]);
  await library.renamePlaylist(playlist.id, 'User edited copy');
  await library.setPlaylistTracks(playlist.id, [second.id, first.id]);
  await library.importFoobar(snapshot);
  assert.equal(library.list().playlists.length, 1);
  assert.equal(library.list().playlists[0].name, 'User edited copy');
  assert.deepEqual(library.list().playlists[0].trackIds, [second.id, first.id]);
  await library.remove([second.id]);
  await library.importFoobar(snapshot);
  assert.equal(library.getTrack(second.id), null);
  assert.ok(library.getTrack(first.id), 'removing one subsong never excludes its siblings');
  await library.deletePlaylist(playlist.id);
  await library.importFoobar(snapshot);
  assert.equal(library.list().playlists.length, 0, 'startup import does not resurrect a deleted imported copy');
  await library.refresh();
  assert.equal(library.getTrack(first.id).title, 'Cue first');
  const loaded = create();
  await loaded.initialize();
  await loaded.importFoobar(snapshot);
  assert.equal(loaded.list().playlists.length, 0);
  assert.equal(loaded.getTrack(second.id), null);
});

test('direct unverified containers are indexed with a specific playback limitation; supported formats include DSD and common lossless audio', async t => {
  const { musicDir, create } = await fixture(t);
  const cue = path.join(musicDir, 'direct.cue');
  await fs.writeFile(cue, 'FILE "unavailable.wav" WAVE\n');
  const library = create();
  const snapshot = await library.importFiles([cue]);
  assert.equal(snapshot.tracks[0].supported, false);
  assert.equal(snapshot.tracks[0].valid, true);
  assert.match(snapshot.tracks[0].playbackUnsupportedReason, /foobar2000 playlist/);
  for (const extension of ['.flac', '.mp3', '.m4a', '.wav', '.aiff', '.ogg', '.opus', '.wv', '.dsf', '.dff']) assert.ok(AUDIO_EXTENSIONS.has(extension));
});

test('playlist occurrences survive import, additions, restore, position moves and single-position deletion', async t => {
  const { musicDir, create } = await fixture(t);
  const first = path.join(musicDir, 'a.wav');
  const second = path.join(musicDir, 'b.wav');
  const third = path.join(musicDir, 'c.wav');
  await Promise.all([first, second, third].map(file => fs.writeFile(file, wav())));
  const library = create();
  await library.importFoobar({ playlists: [{ id: 'repeat', name: 'Repeated', items: [first, second, first].map(file => ({ path: file, subsong: 0 })) }] });
  const playlist = library.list().playlists[0];
  const ids = [trackId(first), trackId(second), trackId(first)];
  assert.deepEqual(playlist.trackIds, ids);
  await library.importFiles([third]);
  await library.addPlaylistTracks(playlist.id, [trackId(third), trackId(third), trackId(first)]);
  assert.deepEqual(library.list().playlists[0].trackIds, [...ids, trackId(third)]);
  const restored = create();
  await restored.initialize();
  assert.deepEqual(restored.list().playlists[0].trackIds, [...ids, trackId(third)]);
  await restored.removePlaylistItem(playlist.id, 0);
  assert.deepEqual(restored.list().playlists[0].trackIds, [trackId(second), trackId(first), trackId(third)]);
  await restored.movePlaylistItem(playlist.id, 2, 0);
  assert.deepEqual(restored.list().playlists[0].trackIds, [trackId(third), trackId(second), trackId(first)]);
  await restored.setPlaylistTracks(playlist.id, ids);
  assert.deepEqual(restored.list().playlists[0].trackIds, ids);
  await restored.removePlaylistTracks(playlist.id, [trackId(first)]);
  assert.deepEqual(restored.list().playlists[0].trackIds, [trackId(second)]);
  await assert.rejects(restored.removePlaylistItem(playlist.id, 5), /out of range/);
  assert.deepEqual(restored.list().playlists[0].trackIds, [trackId(second)]);
});

test('unknown source subsongs stay distinct from verified zero and are explicitly unsupported', async t => {
  const { musicDir, create } = await fixture(t);
  const file = path.join(musicDir, 'source.wav');
  await fs.writeFile(file, wav());
  const library = create();
  await library.importFoobar({ playlists: [{ id: 'unknown', name: 'Unknown identifiers', items: [
    { path: file, subsong: null, supported: false, title: 'Unresolved source item' },
    { path: file, subsong: 0, supported: true },
  ] }] });
  assert.equal(library.list().tracks.length, 2);
  const unknown = library.getTrack(trackId(file, null));
  assert.equal(unknown.subsong, null);
  assert.equal(unknown.supported, false);
  assert.match(unknown.playbackUnsupportedReason, /valid exact subsong/);
  assert.equal(library.getTrack(trackId(file, 0)).supported, true);
});

test('reuses one metadata read across snapshot duplicates and unchanged subsequent snapshots', async t => {
  const { musicDir, create } = await fixture(t);
  const file = path.join(musicDir, 'cached.wav');
  await fs.writeFile(file, wav());
  const library = create();
  const originalOpen = fs.open;
  let audioReads = 0;
  fs.open = async function (target, ...args) {
    if (String(target).toLowerCase() === file.toLowerCase()) audioReads++;
    return originalOpen.call(this, target, ...args);
  };
  try {
    const item = { path: file, subsong: 0, title: 'Source first title' };
    const snapshot = { playlists: [{ id: 'cache-a', name: 'A', items: [item, item] }, { id: 'cache-b', name: 'B', items: [item] }] };
    await library.importFoobar(snapshot);
    assert.equal(audioReads, 1);
    await library.importFoobar(snapshot);
    assert.equal(audioReads, 1);
    item.title = 'Updated source title';
    await library.importFoobar(snapshot);
    assert.equal(audioReads, 1, 'metadata-only source changes merge without reopening the audio');
    assert.equal(library.getTrack(trackId(file)).title, 'Updated source title');
    await library.refresh();
    assert.equal(audioReads, 1);
  } finally { fs.open = originalOpen; }
});

test('failed atomic persistence rolls back getters and removes temporary writes', async t => {
  const { dataDir, create } = await fixture(t);
  let updates = 0;
  const library = create({ onUpdate: () => { updates++; } });
  await library.createPlaylist('Committed');
  const before = library.list();
  const file = path.join(dataDir, 'library.json');
  const backup = path.join(dataDir, 'saved-library-backup.json');
  await fs.rename(file, backup);
  await fs.mkdir(file);
  await assert.rejects(library.createPlaylist('Cannot commit'));
  assert.deepEqual(library.list(), { ...before, status: library.getStatus(), eventCursors: { library: { ...before.eventCursors.library, sequence: before.eventCursors.library.sequence + 1 } } });
  assert.equal(library.getStatus().readOnly, true);
  assert.equal(updates, 2, 'the failed save immediately publishes read-only status without claiming a saved edit');
  assert.equal((await fs.readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  await fs.rmdir(file);
  await fs.rename(backup, file);
  const restored = create();
  await restored.initialize();
  assert.deepEqual(restored.list(), { ...before, eventCursors: restored.list().eventCursors });
  assert.equal(restored.list().eventCursors.library.sequence, 0);
  assert.notEqual(restored.list().eventCursors.library.streamId, before.eventCursors.library.streamId);
});

test('malformed saved data is backed up byte for byte before an empty replacement', async t => {
  const { dataDir, create } = await fixture(t);
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'library.json');
  await fs.writeFile(file, '{ invalid JSON');
  const library = create();
  const snapshot = await library.initialize();
  assert.equal(snapshot.status.status, 'recovered');
  assert.equal(snapshot.status.readOnly, false);
  assert.equal(await fs.readFile(snapshot.status.backupPath, 'utf8'), '{ invalid JSON');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).tracks, []);
  await library.createPlaylist('Recovered');
  assert.equal(library.list().playlists[0].name, 'Recovered');
});
