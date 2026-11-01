'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createLibraryState} = require('../src/renderer/library-state');
const L = '11111111-1111-4111-8111-111111111111', M = '22222222-2222-4222-8222-222222222222', OLD = '33333333-3333-4333-8333-333333333333';
const snapshot = (revision = 0, library = 0, metadata = 0, tracks = [{id: 'a', title: 'A', coverUrl: ''}, {id: 'b', title: 'B', coverUrl: ''}]) => ({revision, tracks, playlists: [{id: 'p', name: 'P', trackIds: ['a', 'a', 'b']}], folders: ['local'], status: {status: 'ready', readOnly: false}, eventCursors: {library: {streamId: L, sequence: library}, metadata: {streamId: M, sequence: metadata}}});
const patch = (source, sequence, baseRevision, revision, tracks = [], extra = {}) => ({kind: 'library-delta', eventId: `${source}:${source === 'library' ? L : M}:${sequence}`, baseRevision, revision, tracks, removedTrackIds: [], ...extra});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('frozen bootstrap and deltas stay untouched while ordered membership and duplicate playlist occurrences survive', () => {
  const initial = freeze(snapshot()), changes = [], store = createLibraryState({fetchSnapshot: async () => initial, onChange: (_value, change) => changes.push(change)});
  assert.equal(store.receive(initial), true);
  const metadata = freeze(patch('metadata', 1, 0, 0, [{id: 'a', title: 'A', coverUrl: 'still-cover://art/a.png'}]));
  store.receive(metadata); assert.equal(initial.tracks[0].coverUrl, ''); assert.equal(store.snapshot().tracks[0].coverUrl, metadata.tracks[0].coverUrl);
  assert.equal(changes.at(-1).structural, false);
  store.receive(freeze(patch('library', 1, 0, 1, [], {removedTrackIds: ['b'], trackIds: ['a'], playlists: [{id: 'p', name: 'P', trackIds: ['a', 'a']}]})));
  assert.deepEqual(store.snapshot().tracks.map(track => track.id), ['a']); assert.deepEqual(store.snapshot().playlists[0].trackIds, ['a', 'a']);
  store.receive(freeze(patch('library', 2, 1, 1, [], {status: {status: 'read-only', readOnly: true}})));
  assert.equal(store.snapshot().status.readOnly, true); assert.equal(store.snapshot().revision, 1);
  assert.deepEqual(initial.playlists[0].trackIds, ['a', 'a', 'b']);
});

test('authoritative cursor3 accepts patch4, ignores duplicate4, and gap6 coalesces one resync before patch7', async () => {
  const pending = deferred(); let reads = 0;
  const store = createLibraryState({fetchSnapshot: () => { reads++; return pending.promise; }});
  store.receive(snapshot(0, 0, 3));
  store.receive(patch('metadata', 4, 0, 0, [{id: 'a', title: 'A', coverUrl: 'four'}]));
  store.receive(patch('metadata', 4, 0, 0, [{id: 'a', title: 'A', coverUrl: 'wrong duplicate'}]));
  assert.equal(store.getTrack('a').coverUrl, 'four'); assert.equal(reads, 0);
  const gap = patch('metadata', 6, 0, 0, [{id: 'a', title: 'A', coverUrl: 'six'}]); store.receive(gap); store.receive(gap);
  await Promise.resolve(); assert.equal(reads, 1);
  store.receive(patch('metadata', 7, 0, 0, [{id: 'a', title: 'A', coverUrl: 'seven'}]));
  pending.resolve(snapshot(0, 0, 6, [{id: 'a', title: 'A', coverUrl: 'six'}, {id: 'b', title: 'B', coverUrl: 'five'}])); await store.whenSettled();
  assert.equal(store.getTrack('a').coverUrl, 'seven'); assert.equal(store.getTrack('b').coverUrl, 'five'); assert.equal(reads, 1);
});

test('an unconfirmed old stream gets one authoritative read and cannot cause a resync loop', async () => {
  let reads = 0; const store = createLibraryState({fetchSnapshot: async () => { reads++; return snapshot(0, 0, 4); }});
  store.receive(snapshot(0, 0, 4));
  store.receive({...patch('metadata', 90, 0, 0), eventId: `metadata:${OLD}:90`}); await store.whenSettled();
  store.receive({...patch('metadata', 91, 0, 0), eventId: `metadata:${OLD}:91`}); await store.whenSettled();
  assert.equal(reads, 1); store.receive(patch('metadata', 5, 0, 0, [{id: 'a', title: 'A', coverUrl: 'current stream'}]));
  assert.equal(store.getTrack('a').coverUrl, 'current stream'); assert.equal(Object.keys(store.snapshot().eventCursors).length, 2);
});

test('cross-revision metadata cannot re-add a removed ID and duplicate old metadata does not resync again', async () => {
  let reads = 0; const latest = snapshot(2, 3, 5, [{id: 'a', title: 'A', coverUrl: 'latest cache'}]);
  const store = createLibraryState({fetchSnapshot: async () => { reads++; return latest; }}); store.receive(snapshot(2, 3, 4, [{id: 'a', title: 'A', coverUrl: ''}]));
  const stale = patch('metadata', 5, 1, 1, [{id: 'b', title: 'Removed', coverUrl: 'old'}]); store.receive(stale); await store.whenSettled();
  assert.equal(store.getTrack('b'), undefined); assert.equal(store.getTrack('a').coverUrl, 'latest cache'); assert.equal(reads, 1);
  store.receive(stale); await store.whenSettled(); assert.equal(reads, 1);
});

test('metadata revision+1/membership is rejected and merged into a resync', async () => {
  let reads = 0; const store = createLibraryState({fetchSnapshot: async () => { reads++; return snapshot(1, 1, 2, [{id: 'a', title: 'A'}]); }});
  store.receive(snapshot(1, 1, 1, [{id: 'a', title: 'A'}]));
  assert.equal(store.receive(patch('metadata', 2, 1, 2, [{id: 'removed', title: 'Wrong'}], {trackIds: ['a', 'removed']})), false);
  assert.equal(store.getTrack('removed'), undefined); await store.whenSettled(); assert.equal(reads, 1); assert.equal(store.getTrack('removed'), undefined);
});

test('a newer library revision cannot roll an observed metadata cursor back or replace its fresh cover', async () => {
  const pending = deferred(), store = createLibraryState({fetchSnapshot: () => pending.promise});
  store.receive(snapshot(1, 1, 1, [{id: 'a', title: 'A', coverUrl: 'fresh'}]));
  assert.equal(store.receive(snapshot(2, 2, 0, [{id: 'a', title: 'A', coverUrl: 'stale'}])), false);
  assert.equal(store.getTrack('a').coverUrl, 'fresh');
  pending.resolve(snapshot(2, 2, 1, [{id: 'a', title: 'A', coverUrl: 'fresh'}])); await store.whenSettled();
  assert.equal(store.getTrack('a').coverUrl, 'fresh'); assert.equal(store.snapshot().revision, 2);
});

test('a late resync snapshot cannot overwrite a newer accepted revision', async () => {
  const pending = deferred(), store = createLibraryState({fetchSnapshot: () => pending.promise});
  store.receive(snapshot(0, 0, 1)); store.receive(patch('metadata', 3, 0, 0)); await Promise.resolve();
  store.receive(snapshot(1, 1, 4, [{id: 'a', title: 'New', coverUrl: 'new'}]));
  pending.resolve(snapshot(0, 0, 3, [{id: 'a', title: 'Old', coverUrl: 'old'}])); await store.whenSettled();
  assert.equal(store.snapshot().revision, 1); assert.equal(store.getTrack('a').title, 'New');
});

test('wrong cursor aliases are not accepted as a valid protocol', async () => {
  let reads = 0; const store = createLibraryState({fetchSnapshot: async () => { reads++; return snapshot(); }});
  const wrong = snapshot(); wrong.eventCursors.metadata = {streamUUID: M, currentSequence: 0};
  assert.equal(store.receive(wrong), false); await store.whenSettled(); assert.equal(reads, 1);
  assert.deepEqual(store.snapshot().eventCursors.metadata, {streamId: M, sequence: 0});
});
