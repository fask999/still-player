'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createLibraryService, trackId } = require('../src/main/library');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(__dirname, '.tmp-library-delta-'));
  const dataDir = path.join(root, 'data');
  const services = [];
  t.after(async () => {
    for (const service of services) await service.close();
    assert.equal(path.dirname(root), path.resolve(__dirname));
    assert.ok(path.basename(root).startsWith('.tmp-library-delta-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, dataDir, create(options = {}) { const service = createLibraryService({ dataDir, ...options }); services.push(service); return service; } };
}

function applyDelta(snapshot, delta) {
  assert.equal(delta.kind, 'library-delta');
  assert.equal(delta.baseRevision, snapshot.revision);
  assert.equal(delta.revision, snapshot.revision + 1);
  const tracks = new Map(snapshot.tracks.map(item => [item.id, item]));
  for (const id of delta.removedTrackIds) tracks.delete(id);
  for (const track of delta.tracks) tracks.set(track.id, track);
  return {
    tracks: (delta.trackIds || [...tracks.keys()]).map(id => tracks.get(id)),
    playlists: delta.playlists || snapshot.playlists, folders: delta.folders || snapshot.folders,
    revision: delta.revision, status: delta.status,
    eventCursors: { ...snapshot.eventCursors, library: { streamId: delta.eventId.split(':')[1], sequence: Number(delta.eventId.split(':')[2]) } },
  };
}

test('deltas reconstruct snapshots with exact global order and repeated playlist occurrences', async t => {
  const { root, create } = await fixture(t);
  const notices = [];
  const library = create({ returnDeltas: true, onDelta: delta => notices.push(delta) });
  let snapshot = await library.initialize();
  const paths = ['a.wav', 'b.wav', 'c.wav'].map(name => path.join(root, name));
  const ids = paths.map(file => trackId(file));
  async function edit(operation, validate) {
    const delta = await operation();
    validate?.(delta);
    snapshot = applyDelta(snapshot, delta);
    assert.deepEqual(snapshot, library.list());
    assert.deepEqual(notices.at(-1), delta);
    assert.match(delta.eventId, /^library:[a-f0-9-]{36}:\d+$/);
    return delta;
  }
  await edit(() => library.importFiles(paths), delta => { assert.deepEqual(delta.trackIds, ids); assert.equal(delta.tracks.length, 3); assert.equal('playlists' in delta, false); });
  const created = await edit(() => library.createPlaylist('Manual'), delta => { assert.deepEqual(delta.tracks, []); assert.equal('trackIds' in delta, false); });
  const id = created.playlists[0].id;
  await edit(() => library.setPlaylistTracks(id, [ids[2], ids[0], ids[2], ids[1]]));
  await edit(() => library.movePlaylistItem(id, 2, 0));
  await edit(() => library.removePlaylistItem(id, 1));
  await edit(() => library.renamePlaylist(id, 'Edited name'));
  await edit(() => library.importFoobar({ playlists: [{ id: 'source', name: 'External', items: [paths[0], paths[0]].map(file => ({ path: file, title: 'Original' })) }] }));
  const imported = snapshot.playlists.find(item => item.source === 'foobar2000');
  await edit(() => library.renamePlaylist(imported.id, 'Keep my edits'));
  await edit(() => library.setPlaylistTracks(imported.id, [ids[1], ids[0], ids[1]]));
  await edit(() => library.importFoobar({ playlists: [{ id: 'source', name: 'Overwritten upstream', items: [{ path: paths[0] }] }] }), delta => assert.equal('playlists' in delta, false));
  assert.equal(snapshot.playlists.find(item => item.id === imported.id).name, 'Keep my edits');
  await edit(() => library.remove([ids[1]]), delta => { assert.deepEqual(delta.removedTrackIds, [ids[1]]); assert.deepEqual(delta.trackIds, [ids[0], ids[2]]); });
  await edit(() => library.importFiles([paths[1]]), delta => assert.deepEqual(delta.trackIds, [ids[0], ids[2], ids[1]]));
  await edit(() => library.deletePlaylist(id));
  await edit(() => library.reset(), delta => { assert.deepEqual(delta.trackIds, []); assert.equal(delta.removedTrackIds.length, 3); });
  assert.equal(notices.length, snapshot.revision);
});

test('delta-only small edits do not clone or serialize a full snapshot and getters stay isolated', async t => {
  const { root, dataDir, create } = await fixture(t);
  await fs.mkdir(dataDir);
  const stored = { tracks: Array.from({ length: 250 }, (_, index) => ({ path: path.join(root, `${index}.wav`), title: `Track ${index}` })), playlists: [] };
  await fs.writeFile(path.join(dataDir, 'library.json'), JSON.stringify(stored));
  const library = create({ returnDeltas: true, onDelta: delta => { delta.tracks.push({ id: 'listener edit' }); } });
  await library.initialize();
  const originalClone = global.structuredClone;
  const originalStringify = JSON.stringify;
  let databaseSerializations = 0;
  global.structuredClone = value => {
    assert.equal(value instanceof Map, false, 'a small edit must not clone the record map');
    assert.ok(!Array.isArray(value?.tracks) || value.tracks.length < 3, 'a delta-only edit must not clone all DTOs');
    return originalClone(value);
  };
  JSON.stringify = function (value, ...args) {
    if (value?.version === 2 && Array.isArray(value.tracks)) databaseSerializations++;
    return originalStringify.call(this, value, ...args);
  };
  let delta;
  try { delta = await library.createPlaylist('One edit'); }
  finally { global.structuredClone = originalClone; JSON.stringify = originalStringify; }
  assert.equal(databaseSerializations, 1, 'only the atomic database commit serializes the full library');
  assert.deepEqual(delta.tracks, []);
  assert.equal('trackIds' in delta, false);
  const snapshot = library.list();
  snapshot.tracks[0].title = 'External edit';
  snapshot.playlists[0].trackIds.push(snapshot.tracks[0].id);
  assert.equal(library.getTrack(snapshot.tracks[0].id).title, 'Track 0');
  assert.deepEqual(library.list().playlists[0].trackIds, []);
});

test('failed delta commits restore records, exclusion IDs, list occurrences, ordering and revision', async t => {
  const { root, dataDir, create } = await fixture(t);
  let fail = false;
  const notices = [];
  const io = { ...fs, async rename(source, target) { if (fail && target === path.join(dataDir, 'library.json')) throw Object.assign(new Error('Injected persistence failure'), { code: 'EIO' }); return fs.rename(source, target); } };
  const library = create({ returnDeltas: true, fileSystem: io, onDelta: delta => notices.push(delta) });
  const files = ['a.wav', 'b.wav', 'c.wav'].map(name => path.join(root, name));
  await library.importFiles(files);
  const ids = files.map(file => trackId(file));
  const playlist = (await library.createPlaylist('Saved')).playlists[0];
  await library.setPlaylistTracks(playlist.id, [ids[1], ids[0], ids[1]]);
  const before = library.list();
  const bytes = await fs.readFile(path.join(dataDir, 'library.json'));
  fail = true;
  await assert.rejects(library.remove([ids[1]]), /Injected persistence failure/);
  assert.deepEqual(library.list(), { ...before, status: library.getStatus(), eventCursors: { library: { ...before.eventCursors.library, sequence: before.eventCursors.library.sequence + 1 } } });
  assert.equal(library.getStatus().readOnly, true);
  assert.equal(notices.length, 4);
  assert.deepEqual(notices.at(-1), { kind: 'library-delta', baseRevision: before.revision, revision: before.revision, tracks: [], removedTrackIds: [], status: library.getStatus(), eventId: notices.at(-1).eventId });
  assert.notEqual(notices.at(-1).eventId, notices.at(-2).eventId, 'same-revision status has a distinct event identity');
  assert.equal(notices.at(-1).eventId.split(':').at(-1), '4');
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'library.json')), bytes);
  await assert.rejects(library.createPlaylist('No phantom save'), /read-only/);
  const restored = create({ returnDeltas: true });
  await restored.initialize();
  assert.deepEqual(restored.list(), { ...before, eventCursors: restored.list().eventCursors });
  assert.equal(restored.list().eventCursors.library.sequence, 0);
  assert.notEqual(restored.list().eventCursors.library.streamId, before.eventCursors.library.streamId);
  await restored.importFoobar({ tracks: [{ path: files[1], title: 'Still included' }] });
  assert.equal(restored.getTrack(ids[1]).title, 'Still included');
});

test('queued edits publish committed data only, keep notifications detached, and retain default snapshots', async t => {
  const { create } = await fixture(t);
  const updates = [];
  const library = create({ onUpdate: snapshot => { updates.push(snapshot.revision); snapshot.playlists[0].name = 'Listener edit'; }, onDelta: delta => { delta.playlists[0].name = 'Delta listener edit'; } });
  await library.initialize();
  const first = library.createPlaylist('One');
  const second = library.createPlaylist('Two');
  assert.equal(library.list().playlists.length, 0);
  assert.equal((await first).playlists[0].name, 'One');
  const result = await second;
  assert.deepEqual(result.playlists.map(item => item.name), ['One', 'Two']);
  assert.deepEqual(updates, [1, 2]);
});

test('invalid playlist and folder operations roll back without making the library read-only', async t => {
  const { root, create } = await fixture(t);
  const notices = [];
  const library = create({ returnDeltas: true, onDelta: delta => notices.push(delta) });
  const first = await library.createPlaylist('Valid');
  const id = first.playlists[0].id;
  await assert.rejects(library.renamePlaylist(id, ''), /name is required/);
  await assert.rejects(library.renamePlaylist('missing', 'Valid'), /not found/);
  await assert.rejects(library.movePlaylistItem(id, 0, 1), /out of range/);
  await assert.rejects(library.importFolder(path.join(root, 'missing-folder')), { code: 'ENOENT' });
  assert.equal(library.getStatus().readOnly, false);
  assert.equal(library.list().revision, first.revision);
  assert.equal(notices.length, 1);
  const next = await library.createPlaylist('Still writable');
  assert.equal(next.revision, first.revision + 1);
  assert.deepEqual(next.playlists.map(item => item.name), ['Valid', 'Still writable']);
  assert.equal(notices.at(-1).eventId, next.eventId);
});

test('bootstrap snapshots carry authoritative stream cursors after committed and same-revision status events', async t => {
  const { dataDir, create } = await fixture(t);
  const notices = [];
  let fail = false;
  const io = { ...fs, async rename(source, target) {
    if (fail && target === path.join(dataDir, 'library.json')) throw Object.assign(new Error('Injected cursor commit failure'), { code: 'EIO' });
    return fs.rename(source, target);
  } };
  const library = create({ returnDeltas: true, onDelta: delta => notices.push(delta), fileSystem: io });
  const initial = await library.initialize();
  const streamId = initial.eventCursors.library.streamId;
  assert.match(streamId, /^[a-f0-9-]{36}$/);
  assert.equal(initial.eventCursors.library.sequence, 0);
  for (let sequence = 1; sequence <= 3; sequence++) {
    const delta = await library.createPlaylist(`List ${sequence}`);
    assert.equal(delta.eventId, `library:${streamId}:${sequence}`);
    assert.equal(notices.at(-1).eventId, delta.eventId);
  }
  const bootstrap = await library.initialize();
  assert.deepEqual(bootstrap, library.list(), 'repeat initialize is a current bootstrap, not the old initial result');
  assert.deepEqual(bootstrap.eventCursors, { library: { streamId, sequence: 3 } });
  assert.equal(bootstrap.revision, 3);
  bootstrap.eventCursors.library.sequence = 999;
  assert.equal(library.list().eventCursors.library.sequence, 3, 'cursor DTOs are detached');
  fail = true;
  await assert.rejects(library.createPlaylist('Failed edit'), /Injected cursor commit failure/);
  const afterFailure = await library.initialize();
  assert.deepEqual(afterFailure.eventCursors, { library: { streamId, sequence: 4 } });
  assert.equal(afterFailure.status.readOnly, true);
  assert.equal(afterFailure.revision, 3);
  assert.equal(notices.at(-1).eventId, `library:${streamId}:4`);
  assert.equal(notices.at(-1).baseRevision, 3);
  assert.equal(notices.at(-1).revision, 3);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'library.json'), 'utf8')).revision, 3);
});

test('a first delta mutation on a large saved library spends no full-snapshot clone budget', async t => {
  const { root, dataDir, create } = await fixture(t);
  await fs.mkdir(dataDir);
  const tracks = Array.from({ length: 2500 }, (_, index) => ({ path: path.join(root, `saved-${index}.wav`), title: `Saved ${index}` }));
  await fs.writeFile(path.join(dataDir, 'library.json'), JSON.stringify({ version: 2, tracks, playlists: [], revision: 7 }));
  const notices = [];
  const library = create({ returnDeltas: true, onDelta: delta => notices.push(delta) });
  const originalClone = global.structuredClone;
  let fullSnapshotClones = 0;
  global.structuredClone = function (value, ...args) {
    if (Array.isArray(value?.tracks) && value.tracks.length === tracks.length) fullSnapshotClones++;
    return originalClone(value, ...args);
  };
  try {
    // This is deliberately the first service call: readiness must load persisted
    // records without constructing a full public bootstrap behind this mutation.
    const first = await library.createPlaylist('First mutation');
    assert.equal(fullSnapshotClones, 0);
    assert.equal(first.revision, 8);
    assert.deepEqual(first.tracks, []);
    assert.equal(notices.at(-1).eventId, first.eventId);

    const initialized = await library.initialize();
    assert.equal(fullSnapshotClones, 1, 'explicit public initialize returns one full detached snapshot');
    assert.equal(initialized.tracks.length, tracks.length);
    assert.equal(initialized.revision, 8);
    assert.equal(initialized.eventCursors.library.sequence, 1);
    const listed = library.list();
    assert.equal(fullSnapshotClones, 2, 'explicit list returns one full detached snapshot');
    assert.deepEqual(listed, initialized);
    initialized.tracks[0].title = 'Caller edit';
    initialized.playlists[0].name = 'Caller playlist edit';
    initialized.eventCursors.library.sequence = 999;
    assert.equal(listed.tracks[0].title, 'Saved 0');
    assert.equal(listed.playlists[0].name, 'First mutation');
    assert.equal(listed.eventCursors.library.sequence, 1);

    const next = await library.renamePlaylist(first.playlists[0].id, 'Second mutation');
    assert.equal(fullSnapshotClones, 2, 'subsequent delta edits also avoid full snapshot cloning');
    assert.equal(next.revision, 9);
    const current = await library.initialize();
    assert.equal(fullSnapshotClones, 3);
    assert.equal(current.revision, 9);
    assert.equal(current.playlists[0].name, 'Second mutation');
    assert.equal(current.tracks[0].title, 'Saved 0');
    assert.deepEqual(current.eventCursors.library, { streamId: next.eventId.split(':')[1], sequence: 2 });
  } finally { global.structuredClone = originalClone; }
});
