'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHandlers, invokeSafely} = require('../src/main/ipc-handlers');

test('Apple album selection reaches the playback engine with one clicked occurrence and preserves ordinary song playback', async () => {
  const calls = [];
  let supportsAlbum = true, readOnly = false;
  const apple = {
    getStatus: () => ({available: true, capabilities: {playback: true, albumPlayback: supportsAlbum, playableTypes: ['songs', 'library-songs']}}),
    getState: () => ({available: true, state: 'playing', currentTrackId: 'repeat'}),
    play(input) {calls.push(input);}
  };
  const foobar = {getState: () => ({available: true, state: 'stopped'}), stop() {}, releaseOutput: () => ({released: true})};
  const h = createHandlers({foobar, apple, getLibraryTracks: () => [], getRuntimeState: () => ({readOnly})});
  const input = {source: 'apple', id: 'repeat', kind: 'songs', album: {id: 'l.album', index: 103}};
  assert.equal((await invokeSafely(h['player:play'], input)).value.source, 'apple');
  assert.deepEqual(calls, [{ids: ['repeat'], kind: 'songs', album: {id: 'l.album', index: 103}}]);
  for (const payload of [
    {...input, album: {id: 'l.album', index: 500}},
    {...input, album: {id: 'l.album', index: 103, unchecked: true}},
    {...input, ids: ['repeat']},
    {...input, album: {id: 'untrusted/path', index: 0}}
  ]) assert.equal((await invokeSafely(h['player:play'], payload)).ok, false);
  supportsAlbum = false;
  assert.equal((await invokeSafely(h['player:play'], input)).ok, false);
  readOnly = true; supportsAlbum = true;
  assert.equal((await invokeSafely(h['player:play'], input)).ok, false);
  assert.equal(calls.length, 1);
  readOnly = false;
  assert.equal((await invokeSafely(h['player:play'], {source: 'apple', id: 'repeat', kind: 'songs'})).ok, true);
  assert.deepEqual(calls[1], {ids: ['repeat'], kind: 'songs'});
});

test('local context selection dispatches the selected duplicate position, uses readback and rejects stale generations or another owner', async () => {
  const path = 'E:\\Repeated.flac', selectionToken = 'local-select:' + 'a'.repeat(64), calls = [];
  let index = 0, readOnly = false, applePlaying = false;
  const foobar = {
    getState: () => ({available: true, state: applePlaying ? 'stopped' : 'playing', currentTrack: {path, subsong: 0}}),
    playbackContext: () => ({status: 'ready', playlist: {id: 'list'}, currentIndex: index, selectionToken, capabilities: {select: true},
      items: [0, 1].map(itemIndex => ({playlistId: 'list', itemIndex, path, subsong: 0, title: 'Repeat', supported: true}))}),
    selectPlaybackContext(selection, context) {context.check(); calls.push(selection); index = selection.index;},
    stop() {},
    releaseOutput: () => ({released: true})
  };
  const apple = {
    getStatus: () => ({capabilities: {playback: true}}),
    getState: () => ({available: true, state: applePlaying ? 'playing' : 'stopped'}),
    play() {applePlaying = true;}
  };
  const h = createHandlers({foobar, apple, getLibraryTracks: () => [], getRuntimeState: () => ({readOnly})});
  const read = () => h['player:context']({source: 'local'});
  const first = await read();
  assert.equal(first.currentIndex, 0);
  assert.equal(first.capabilities.select, true);
  assert.equal(first.selectionToken, selectionToken);
  const select = {source: 'local', selectionToken, itemIndex: 1, generation: first.generation};
  assert.equal((await invokeSafely(h['player:play'], select)).value.source, 'local');
  const second = await read();
  assert.equal(second.currentIndex, 1);
  assert.ok(second.generation > first.generation);
  assert.equal((await invokeSafely(h['player:play'], select)).ok, false);
  assert.equal((await invokeSafely(h['player:play'], {...select, generation: second.generation, trackId: 'repeat'})).ok, false);
  readOnly = true;
  const restricted = await read();
  assert.equal(restricted.capabilities.select, false);
  assert.equal(Object.hasOwn(restricted, 'selectionToken'), false);
  assert.equal((await invokeSafely(h['player:play'], {...select, generation: second.generation})).ok, false);
  readOnly = false;
  const moved = await h['player:play']({source: 'apple', id: 'a'});
  assert.equal(moved.source, 'apple');
  assert.equal((await invokeSafely(h['player:play'], {...select, generation: moved.generation})).ok, false);
  assert.deepEqual(calls, [{selectionToken, index: 1}]);
});

test('footer order selection is scoped to the real source and generation and exposes engine readback', async () => {
  const calls = [];
  let appleActive = false, orderAvailable = true, appleOrder = 0;
  const foobar = {
    getState: () => ({available: true, state: appleActive ? 'stopped' : 'playing'}),
    stop() {}, releaseOutput: () => ({released: true}),
    setOrder(id) {calls.push(['local', id]);}
  };
  const apple = {
    getState: () => ({available: true, state: appleActive ? 'playing' : 'stopped', playbackOrder: {id: appleOrder}}),
    getStatus: () => ({capabilities: {playback: true, order: orderAvailable}}),
    play() {appleActive = true;},
    setOrder(id, context) {context.check(); calls.push(['apple', id]); appleOrder = id;}
  };
  const h = createHandlers({foobar, apple, getLibraryTracks: () => []});
  const order = payload => invokeSafely(h['player:order'], payload);
  const local = await h['player:state']();
  const active = await h['player:play']({source: 'apple', id: 'track'});
  assert.equal(active.source, 'apple');
  assert.equal((await order({source: 'local', generation: local.generation, id: 2})).ok, false);
  assert.equal((await order({source: 'local', generation: active.generation, id: 2})).ok, false);
  orderAvailable = false;
  assert.equal((await order({source: 'apple', generation: active.generation, id: 2})).ok, false);
  orderAvailable = true;
  assert.equal((await order({source: 'apple', generation: active.generation, id: 2})).value.playbackOrder.id, 2);
  assert.deepEqual(calls, [['apple', 2]]);
});
