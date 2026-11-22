'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {createHandlers} = require('../src/main/ipc-handlers');
const {createLibraryService, trackId} = require('../src/main/library');

const audio = Buffer.alloc(44 + 16000);
audio.write('RIFF');
audio.writeUInt32LE(audio.length - 8, 4);
audio.write('WAVEfmt ', 8);
audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20);
audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(8000, 24);
audio.writeUInt32LE(16000, 28);
audio.writeUInt16LE(2, 32);
audio.writeUInt16LE(16, 34);
audio.write('data', 36);
audio.writeUInt32LE(16000, 40);

async function fixture(t, serviceOptions = {}) {
  const prefix = 'still-native-import-';
  const {root, parent} = createCanonicalTemp(prefix);
  const folder = path.join(root, '本地 专辑');
  const dataDir = path.join(root, 'data');
  const database = path.join(dataDir, 'library.json');
  await fs.mkdir(folder);
  const deltas = [], dialogs = [], backendCalls = [], emitted = [];
  let library, handlers, selection;
  const prepare = {
    paths: async () => ({pending: false, restartRequired: false}),
    locations: async () => ({})
  };
  async function reopen() {
    handlers?.closePlaybackContext();
    await library?.close();
    library = createLibraryService({dataDir, returnDeltas: true, onDelta: delta => deltas.push(delta), ...serviceOptions});
    await library.initialize();
    handlers = createHandlers({
      library, libraryReturnsDeltas: true, window: () => null, decorateTrack: track => track,
      dialog: {showOpenDialog: async (_window, options) => { dialogs.push(options); return selection; }},
      prepareLibraryPaths: async locations => { backendCalls.push(['paths', locations]); return prepare.paths(locations); },
      foobar: {
        prepareLocations: async ({locations}) => { backendCalls.push(['locations', locations]); return prepare.locations(locations); },
        play: () => assert.fail('Import must not start playback'),
        stop: () => assert.fail('Import must not stop playback'),
      },
      emit: (...event) => emitted.push(event)
    });
  }
  t.after(async () => {
    handlers?.closePlaybackContext();
    await library?.close();
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith(prefix));
    await fs.rm(root, {recursive: true, force: true});
  });
  await reopen();
  return {
    folder, database, deltas, dialogs, backendCalls, emitted, prepare, reopen, library: () => library,
    file: async (name, bytes = audio) => {
      const file = path.join(folder, name);
      await fs.mkdir(path.dirname(file), {recursive: true});
      await fs.writeFile(file, bytes);
      return file;
    },
    select: (kind, filePaths, canceled = false) => {
      selection = {canceled, filePaths};
      return handlers['library:import']({kind});
    }
  };
}

const duplicatePath = file => process.platform === 'win32' ? file.toUpperCase() : file;

test('native file import saves one ordered playlist in the track commit and reuses it after restart and edits', async t => {
  const f = await fixture(t);
  const first = await f.file('第一首.WAV'), second = await f.file('第二首.wav'), third = await f.file('第三首.wav');
  const extra = await f.file('另选.wav');
  const result = await f.select('files', [second, first, duplicatePath(second), third]);
  const ids = [second, first, third].map(file => trackId(file));
  const [playlist] = f.library().list().playlists;
  assert.deepEqual(playlist.trackIds, ids);
  assert.equal(playlist.name, '第二首 等 3 首');
  assert.equal(f.deltas.length, 1);
  assert.equal(result.eventId, f.deltas[0].eventId);
  assert.deepEqual(result.tracks.map(track => track.id), ids);
  assert.deepEqual(f.deltas[0].playlists, [playlist]);
  assert.equal(f.deltas[0].importSelection, undefined);
  assert.equal(result.importSelection, undefined);
  assert.equal(playlist._importedTrackIds, undefined);
  assert.deepEqual(result.importReport, {indexedCount: 3, backendPrepared: true, pending: false, restartRequired: false,
    warnings: [], playlist: {id: playlist.id, name: playlist.name, created: true, addedTrackCount: 3, trackCount: 3}});
  assert.deepEqual(f.dialogs[0].properties, ['openFile', 'multiSelections']);
  assert.ok(f.dialogs[0].filters[0].extensions.includes('wav'));
  assert.deepEqual(f.emitted, []);

  const library = f.library();
  await library.importFiles([extra]);
  await library.renamePlaylist(playlist.id, '自定义顺序');
  await library.movePlaylistItem(playlist.id, 2, 0);
  await library.removePlaylistItem(playlist.id, 1);
  await library.addPlaylistTracks(playlist.id, [trackId(extra)]);
  const [edited] = library.list().playlists;
  assert.deepEqual(edited.trackIds, [ids[2], ids[1], trackId(extra)]);
  await f.reopen();
  const repeated = await f.select('files', [duplicatePath(first), third, second, first]);
  assert.equal(repeated.importReport.indexedCount, 3);
  assert.deepEqual(repeated.importReport.playlist, {id: playlist.id, name: edited.name, created: false, addedTrackCount: 0, trackCount: 3});
  assert.deepEqual(f.library().list().playlists, [edited]);
  assert.equal(repeated.playlists, undefined);
  assert.deepEqual(await Promise.all([first, second, third, extra].map(file => fs.readFile(file))), [audio, audio, audio, audio]);
});

test('reselecting an already indexed folder or files creates playlists and later folder imports only append new songs', async t => {
  const f = await fixture(t);
  const first = await f.file('01 前奏.WAV'), second = await f.file('02 分册/第二首.wav'), third = await f.file('03 尾声.wav');
  // Seed the pre-feature library shape, including an identically named manual list.
  await f.library().importFiles([second]);
  await f.library().importFolder(f.folder);
  const manual = (await f.library().createPlaylist(path.basename(f.folder))).playlists[0];
  await f.library().setPlaylistTracks(manual.id, [trackId(second)]);
  await f.reopen();
  assert.equal(f.library().list().tracks.length, 3);
  const folderResult = await f.select('folder', [f.folder]);
  const {id} = folderResult.importReport.playlist;
  const folderPlaylist = () => f.library().list().playlists.find(list => list.id === id);
  assert.deepEqual(f.dialogs[0].properties, ['openDirectory']);
  assert.equal(folderPlaylist().name, path.basename(f.folder));
  assert.deepEqual(folderPlaylist().trackIds, [first, second, third].map(file => trackId(file)));
  assert.deepEqual(f.library().list().playlists.find(list => list.id === manual.id).trackIds, [trackId(second)]);
  const filesResult = await f.select('files', [second]);
  assert.equal(filesResult.importReport.playlist.name, '第二首');
  assert.equal(filesResult.importReport.playlist.trackCount, 1);
  assert.notEqual(filesResult.importReport.playlist.id, id);

  await f.library().renamePlaylist(id, '改过的专辑');
  await f.library().movePlaylistItem(id, 2, 0);
  await f.library().removePlaylistItem(id, 1);
  await f.reopen();
  const newSong = await f.file('00 新曲.wav');
  const updated = await f.select('folder', [duplicatePath(f.folder)]);
  assert.deepEqual(updated.importReport.playlist, {id, name: '改过的专辑', created: false, addedTrackCount: 1, trackCount: 3});
  assert.deepEqual(folderPlaylist().trackIds, [third, second, newSong].map(file => trackId(file)));
  await f.library().deletePlaylist(id);
  await f.library().refresh();
  assert.equal(folderPlaylist(), undefined);
  await f.select('folder', [f.folder]);
  assert.deepEqual(folderPlaylist().trackIds, [newSong, first, second, third].map(file => trackId(file)));
});

test('CUE file selection saves verified subsongs and referenced audio once, including existing foobar identities', async t => {
  let discoveries = 0;
  const f = await fixture(t, {cueInspector: async ({path: cuePath, references}) => {
    discoveries++;
    return {verified: true, items: [
      {path: cuePath, subsong: 7, title: 'Exact CUE track', supported: true},
      {path: references[0], subsong: 0, title: 'Referenced track', supported: true},
    ]};
  }});
  const file = await f.file('合辑.wav');
  const cue = await f.file('影像.cue', 'FILE "合辑.wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\nTRACK 02 AUDIO\nINDEX 01 00:00:20\n');
  await f.library().importFoobar({tracks: [{path: file, subsong: 0, title: 'Foobar track', supported: true}]});
  const result = await f.select('files', [cue]);
  const ids = [trackId(cue, 7), trackId(file)];
  const [playlist] = f.library().list().playlists;
  assert.equal(playlist.name, '影像');
  assert.deepEqual(playlist.trackIds, ids);
  assert.equal(f.library().getTrack(ids[1]).source, 'foobar2000');
  assert.equal(result.importReport.indexedCount, 2);
  assert.deepEqual(f.backendCalls[0], ['paths', [{path: cue, subsong: 7}, {path: file, subsong: 0}]]);
  await f.reopen();
  await f.select('files', [cue, file]);
  assert.deepEqual(f.library().list().playlists.map(list => list.trackIds), [ids, ids]);
  await f.reopen();
  assert.deepEqual(f.library().list().playlists[0].trackIds, ids);
  assert.deepEqual(await fs.readFile(file), audio);

  // Older libraries saved verified identities with no separate CUE order.
  await f.library().close();
  const legacy = JSON.parse(await fs.readFile(f.database, 'utf8'));
  for (const track of legacy.tracks) delete track._cueOrder;
  legacy.playlists = [];
  await fs.writeFile(f.database, JSON.stringify(legacy));
  await f.reopen();
  const recovered = await f.select('files', [cue]);
  assert.equal(recovered.importReport.playlist.trackCount, 2);
  assert.deepEqual(f.library().list().playlists[0].trackIds, [ids[1], ids[0]]);
  assert.equal(discoveries, 1, 'an older verified CUE does not need a new discovery');
});

test('native cancellation is a no-op and empty, unsupported and mixed selections preserve indexing without empty playlists', async t => {
  const f = await fixture(t);
  const notes = await f.file('说明.txt', 'synthetic notes');
  const before = f.library().list();
  assert.equal(await f.select('files', [notes], true), null);
  assert.equal(await f.select('files', []), null);
  assert.deepEqual(f.library().list(), before);
  assert.deepEqual(f.deltas, []);
  await assert.rejects(fs.access(f.database), {code: 'ENOENT'});
  await assert.rejects(f.select('folder', [path.join(f.folder, 'missing')]), {code: 'ENOENT'});
  assert.deepEqual(f.library().list(), before);

  const empty = await f.select('folder', [f.folder]);
  assert.equal(empty.importReport.playlist, null);
  assert.equal(empty.importReport.indexedCount, 0);
  assert.match(empty.importReport.warnings.join(' '), /刷新曲库/);
  assert.deepEqual(f.library().list().folders, [f.folder]);
  assert.equal((await f.select('files', [notes])).importReport.playlist, null);

  const file = await f.file(' .wav');
  const cue = await f.file('未核验.cue', 'FILE " .wav" WAVE\nTRACK 01 AUDIO\nINDEX 01 00:00:00\n');
  const unverified = await f.select('files', [cue]);
  assert.equal(unverified.importReport.playlist, null);
  assert.equal(unverified.importReport.indexedCount, 1);
  assert.equal(f.library().getTrack(trackId(cue)).supported, false);
  assert.ok(f.library().getTrack(trackId(cue)).playbackUnsupportedReason);
  assert.deepEqual(f.backendCalls, []);

  await f.reopen();
  await f.library().refresh();
  assert.ok(f.library().getTrack(trackId(file)));
  assert.deepEqual(f.library().list().playlists, []);
  const mixed = await f.select('files', [cue, file, notes]);
  assert.equal(mixed.importReport.indexedCount, 2);
  assert.match(mixed.importReport.warnings.join(' '), /1 项索引已保留在曲库/);
  assert.equal(mixed.importReport.playlist.name, '导入的音乐');
  assert.deepEqual(f.library().list().playlists[0].trackIds, [trackId(file)]);
  assert.ok(f.library().getTrack(trackId(cue)));
});

test('pending and denied backend preparation preserve the committed list and do not emit player or source changes', async t => {
  const f = await fixture(t);
  const pending = await f.file('pending.wav'), denied = await f.file('denied.wav');
  f.prepare.paths = async locations => {
    assert.ok(f.library().list().playlists.some(list => list.trackIds.includes(trackId(locations[0].path))));
    if (locations[0].path === pending) return {pending: true, restartRequired: true};
    throw new Error('Synthetic backend denial');
  };
  const delayed = await f.select('files', [pending]), rejected = await f.select('files', [denied]);
  assert.equal(delayed.importReport.pending, true);
  assert.equal(delayed.importReport.backendPrepared, false);
  assert.equal(rejected.importReport.backendPrepared, false);
  assert.match(rejected.importReport.warnings.join(' '), /Synthetic backend denial/);
  assert.deepEqual(f.backendCalls.map(([action]) => action), ['paths', 'paths']);
  assert.deepEqual(f.emitted, []);
  await f.reopen();
  assert.deepEqual(f.library().list().playlists.map(list => list.trackIds), [[trackId(pending)], [trackId(denied)]]);
});

test('failed import commit saves neither new tracks nor the new playlist and leaves prior data intact', async t => {
  let fail = false;
  const f = await fixture(t, {fileSystem: {...fs, async rename(source, target) {
    if (fail && path.basename(target) === 'library.json') throw Object.assign(new Error('Synthetic import save failure'), {code: 'EIO'});
    return fs.rename(source, target);
  }}});
  const first = await f.file('first.wav'), newSong = await f.file('new.wav');
  await f.select('files', [first]);
  const {tracks, playlists, folders, revision} = f.library().list();
  const before = await fs.readFile(f.database);
  const backendCalls = f.backendCalls.length;
  fail = true;
  await assert.rejects(f.select('folder', [f.folder]), /Synthetic import save failure/);
  assert.deepEqual(f.library().list().tracks, tracks);
  assert.deepEqual(f.library().list().playlists, playlists);
  assert.deepEqual(f.library().list().folders, folders);
  assert.equal(f.library().list().revision, revision);
  assert.equal(f.library().getTrack(trackId(newSong)), null);
  assert.equal(f.deltas.at(-1).playlists, undefined);
  assert.equal(f.deltas.at(-1).revision, revision);
  assert.equal(f.backendCalls.length, backendCalls);
  assert.deepEqual(await fs.readFile(f.database), before);
  await f.reopen();
  assert.deepEqual(f.library().list().playlists, playlists);
});
