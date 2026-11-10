'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createHandoffSnapshots} = require('../src/main/foobar-handoff');
const {COLUMNS, normalizeOutputs, normalizeOrders, locationKey, trackFromColumns} = require('../src/main/foobar');
const {endpointForOutput} = require('../src/main/backend');

// Beefweb v0.10 foobar2000/player_control.cpp queryActiveItem sets both indices
// to -1 when get_playing_item_location fails. player_api_json.cpp always emits
// the six ActiveItemInfo fields. This exact response was observed via GET on
// the real 0.10 backend; no process, audio client, filesystem or POST is used.
const nativeEmptyItem = () => ({playlistId: '', playlistIndex: -1, index: -1, columns: [], position: 0, duration: 0});
const deviceId = '0DD9B977-765B-4804-BF2D-B28EBF0C510D:075B5502-3C8B-4700-B6AD-FFE11AD6962A';
const defaultLists = () => [
  {id: 'p1', title: 'Empty current list', items: []},
  {id: 'p2', title: 'Preserved sources', items: [{path: 'C:\\Music\\a.cue', subsong: 1}, {path: 'C:\\Music\\a.cue', subsong: 1}, {path: 'C:\\Music\\b.flac', subsong: 0}]}
];
function fixture(options = {}) {
  const active = Object.hasOwn(options, 'active') ? options.active : nativeEmptyItem();
  const {playbackState = 'stopped', queue = [], omitQueue = false,
    secondActive = active, secondPlaybackState = playbackState, lists = defaultLists(), secondLists = lists, pageChanged = false} = options;
  const reads = []; let pass = 0;
  const currentLists = () => pass < 2 ? lists : secondLists;
  const request = async (route, body) => {
    assert.equal(body, undefined, 'Snapshot capture must remain read-only'); reads.push(route);
    assert.match(route, /^query\?/); pass++;
    return {player: {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: pass < 2 ? playbackState : secondPlaybackState,
      activeItem: structuredClone(pass < 2 ? active : secondActive),
      volume: {type: 'db', min: -100, max: 0, value: -4}, options: [{id: 'playbackOrder', type: 'enum', value: 0, enumNames: ['Default']}]},
    ...(omitQueue ? {} : {playQueue: structuredClone(queue)}), outputs: {active: {typeId: 'output', deviceId},
      types: [{id: 'output', name: 'Output', devices: [{id: deviceId, name: 'Synthetic DX1'}]}]}};
  };
  const snapshots = createHandoffSnapshots({request, COLUMNS, normalizeOutputs, normalizeOrders, locationKey, trackFromColumns, endpointForOutput,
    checkPlayer: player => {assert.equal(player.info.name, 'foobar2000'); assert.equal(player.info.pluginVersion, '0.10');},
    playlists: async () => {
      reads.push('playlists');
      return currentLists().map(list => ({id: list.id, title: list.title, itemCount: list.items.length}));
    },
    itemPage: async (id, offset, count) => {
      reads.push(`items:${id}:${offset}:${count}`);
      const list = currentLists().find(row => row.id === id);
      const items = list.items.slice(offset, offset + count).map((row, index) => ({...row, supported: true, playlistId: id, itemIndex: offset + index}));
      return {total: list.items.length + (pageChanged ? 1 : 0), items};
    }});
  return {read: () => snapshots.stableHandoffSnapshot(), reads};
}

test('the exact stopped v0.10 native empty sentinel preserves every list and duplicate occurrence across two complete snapshots', async () => {
  const f = fixture(), snapshot = await f.read();
  assert.equal(snapshot.contextMode, 'none'); assert.equal(snapshot.currentIndex, null); assert.equal(snapshot.playlistId, null);
  assert.equal(snapshot.playbackState, 'stopped'); assert.deepEqual(snapshot.queue, []); assert.deepEqual(snapshot.items, []);
  assert.equal(snapshot.playlists.length, 2); assert.equal(snapshot.playlists[0].items.length, 0);
  assert.deepEqual(snapshot.playlists[1].items.map(row => row.occurrence), [0, 1, 0]);
  assert.deepEqual(snapshot.playlists[1].items.map(({path, subsong}) => ({path, subsong})), defaultLists()[1].items);
  assert.equal(f.reads.filter(route => route.startsWith('query?')).length, 2);
  assert.equal(f.reads.filter(route => route === 'playlists').length, 2);
  assert.equal(f.reads.filter(route => route.startsWith('items:')).length, 2);
});

for (const state of ['paused', 'playing']) test(`the native empty sentinel cannot become known-none while ${state}`, async () => {
  await assert.rejects(fixture({playbackState: state}).read(), {code: 'STILL_HANDOFF_SNAPSHOT_UNVERIFIED'});
});

for (const key of Object.keys(nativeEmptyItem())) test(`an empty-looking active item missing ${key} is rejected`, async () => {
  const active = nativeEmptyItem(); delete active[key];
  await assert.rejects(fixture({active}).read(), {code: 'STILL_HANDOFF_SNAPSHOT_UNVERIFIED'});
});

for (const [name, patch] of Object.entries({
  positivePlaylistIndex: {playlistIndex: 0}, positiveItemIndex: {index: 0}, negativeOtherIndex: {index: -2},
  nonemptyId: {playlistId: 'p1'}, nullId: {playlistId: null}, stringIndex: {index: '-1'},
  columnsPresent: {columns: ['C:\\Music\\a.flac']}, nullColumns: {columns: null},
  elapsedPosition: {position: 1}, nonzeroDuration: {duration: 240}, stringZeroPosition: {position: '0'},
  nullDuration: {duration: null}, extraField: {track: 'unknown'}
})) test(`a partial or inconsistent native empty sentinel is rejected: ${name}`, async () => {
  await assert.rejects(fixture({active: {...nativeEmptyItem(), ...patch}}).read(), {code: 'STILL_HANDOFF_SNAPSHOT_UNVERIFIED'});
});

for (const active of [undefined, {}, [], false]) test(`unknown active item ${JSON.stringify(active)} is not an empty native sentinel`, async () => {
  // Passing explicit undefined must not use the fixture's default sentinel.
  await assert.rejects(fixture({active, secondActive: active}).read(), {code: 'STILL_HANDOFF_SNAPSHOT_UNVERIFIED'});
});

test('the native empty sentinel still requires the full empty queue', async () => {
  await assert.rejects(fixture({omitQueue: true}).read(), {code: 'STILL_HANDOFF_QUEUE_UNKNOWN'});
  await assert.rejects(fixture({queue: [{playlistId: 'p2', itemIndex: 0}]}).read(), {code: 'STILL_HANDOFF_QUEUE_NOT_EMPTY'});
});

test('a changed list, a second inconsistent sentinel, or changed pagination still blocks a complete snapshot', async () => {
  const changed = defaultLists(); changed[1].items.reverse();
  await assert.rejects(fixture({secondLists: changed}).read(), {code: 'STILL_HANDOFF_CONTEXT_CHANGED'});
  await assert.rejects(fixture({secondActive: {...nativeEmptyItem(), position: 1}}).read(), {code: 'STILL_HANDOFF_SNAPSHOT_UNVERIFIED'});
  await assert.rejects(fixture({secondPlaybackState: 'playing'}).read(), {code: 'STILL_HANDOFF_SNAPSHOT_UNVERIFIED'});
  await assert.rejects(fixture({pageChanged: true}).read(), {code: 'STILL_HANDOFF_CONTEXT_CHANGED'});
});

test('native known-none retains the full-list preservation bounds', async () => {
  await assert.rejects(fixture({lists: Array.from({length: 51}, (_, index) => ({id: `p${index}`, title: 'Empty', items: []}))}).read(),
    {code: 'STILL_HANDOFF_SNAPSHOT_TOO_LARGE'});
  await assert.rejects(fixture({lists: [{id: 'p1', title: 'Too many', items: Array.from({length: 501}, () => ({path: 'C:\\Music\\a.flac', subsong: 0}))}]}).read(),
    {code: 'STILL_HANDOFF_SNAPSHOT_TOO_LARGE'});
});
