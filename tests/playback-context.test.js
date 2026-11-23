'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createPlaybackContextService} = require('../src/main/playback-context');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const rawLocal = () => ({status: 'ready', playlist: {id: 'real', name: 'Real playing list'}, currentIndex: 2, items: [0, 1, 2].map(index =>
  ({playlistId: 'real', itemIndex: index, path: index === 1 ? 'E:\\Other.flac' : 'E:\\Repeated.flac', subsong: 0, title: 'Song', artist: 'Artist', album: 'Album', supported: true}))});
const rawPartial = (offset = 400) => ({...rawLocal(), offset, total: 987, currentIndex: 402,
  items: rawLocal().items.map((item, relativeIndex) => {
    const itemIndex = offset + relativeIndex;
    return {...item, itemIndex, path: itemIndex % 2 ? 'E:\\Other.flac' : 'E:\\Repeated.flac'};
  })});
const appleStatus = () => ({available: true, runtime: {sessionOpen: true}, capabilities: {queue: true}});
const appleQueue = () => ({offset: 0, limit: 100, total: 3, position: 2, hasMore: false,
  items: [0, 1, 2].map(index => ({id: index === 1 ? 'other' : 'repeat', type: 'songs', title: 'Song', artist: 'Artist', album: 'Album', playable: true}))});
test('local context resolves exact library metadata, hides file paths and retains occurrence keys and real current index', async () => {
  const library = [{id: 'known', path: 'e:/repeated.flac', subsong: 0, coverUrl: 'still-apple-art://art/' + 'a'.repeat(64),
    coverThumbnailUrl: 'still-cover://art/' + 'b'.repeat(64) + '.png', coverLargeUrl: 'still-cover://art/' + 'c'.repeat(64) + '.png', cueTrack: true, _cuePath: 'E:/PRIVATE.cue'}];
  const service = createPlaybackContextService({local: {playbackContext: () => rawLocal()}, getTracks: () => library, getGeneration: () => 7, getRevision: () => 11});
  const value = await service.read('local');
  assert.equal(value.status, 'ready'); assert.equal(value.currentIndex, 2); assert.equal(value.generation, 7); assert.equal(value.revision, 11);
  assert.equal(Object.hasOwn(value, 'offset'), false); assert.equal(Object.hasOwn(value, 'total'), false);
  assert.deepEqual(value.items.map(item => item.trackId), ['known', null, 'known']); assert.equal(new Set(value.items.map(item => item.key)).size, 3);
  assert.deepEqual(value.items.map(item => item.key), [0, 1, 2].map(index => `${value.contextId}:${index}`));
  assert.deepEqual(value.items[2].reference, {source: 'local', playlistId: 'real', itemIndex: 2}); assert.equal(value.items[0].coverUrl, library[0].coverUrl);
  assert.equal(value.items[0].coverThumbnailUrl, library[0].coverThumbnailUrl); assert.equal(value.items[0].coverLargeUrl, library[0].coverLargeUrl);
  assert.equal(value.items[0].cueTrack, true); assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(value).includes('Repeated.flac'), false); assert.deepEqual(value.capabilities, {select: false, predictNeighbors: false});
});
test('a partial local context keeps absolute row keys stable across windows and always remains read-only', async () => {
  let offset = 400;
  const playbackOccurrence = 'b'.repeat(64);
  const library = [{id: 'repeat', path: 'e:/repeated.flac', subsong: 0}];
  const service = createPlaybackContextService({maxItems: 3, getTracks: () => library, local: {
    playbackContext: () => ({...rawPartial(offset), playbackOccurrence, selectionToken: 'local-select:' + 'a'.repeat(64),
      capabilities: {select: true}, predictNeighbors: true}),
    selectPlaybackContext() {throw new Error('Unexpected context write');}
  }});
  const first = await service.read('local');
  assert.equal(first.status, 'ready'); assert.equal(first.offset, 400); assert.equal(first.total, 987); assert.equal(first.currentIndex, 402);
  assert.equal(first.playbackOccurrence, playbackOccurrence); assert.equal(Object.hasOwn(first, 'selectionToken'), false);
  assert.deepEqual(first.capabilities, {select: false, predictNeighbors: false});
  assert.deepEqual(first.items.map(item => item.index), [400, 401, 402]);
  assert.deepEqual(first.items.map(item => item.trackId), ['repeat', null, 'repeat']);
  assert.notEqual(first.items[0].key, first.items[2].key); assert.equal(JSON.stringify(first).includes('Repeated.flac'), false);
  assert.deepEqual(first.items[2].reference, {source: 'local', playlistId: 'real', itemIndex: 402});
  offset = 401;
  const second = await service.read('local');
  assert.notEqual(second.contextId, first.contextId);
  assert.deepEqual(second.items.slice(0, 2).map(item => item.key), first.items.slice(1).map(item => item.key));
});
test('the local serializer rejects incomplete or inconsistent window evidence and discards malformed occurrence proof', async () => {
  let raw;
  const service = createPlaybackContextService({maxItems: 3, local: {playbackContext: () => raw}});
  for (const change of [{offset: undefined}, {total: undefined}, {total: 3}, {total: Number.MAX_SAFE_INTEGER + 1}, {offset: 986},
    {currentIndex: 399}, {currentIndex: 403}, {items: rawPartial().items.slice(1)}, {items: rawLocal().items}]) {
    raw = {...rawPartial(), ...change};
    const value = await service.read('local');
    assert.equal(value.reason, 'context-invalid-response'); assert.deepEqual(value.items, []); assert.equal(value.currentIndex, null);
  }
  raw = {...rawPartial(), playbackOccurrence: 'E:\\Private\\Track.flac'};
  const value = await service.read('local');
  assert.equal(value.status, 'ready'); assert.equal(Object.hasOwn(value, 'playbackOccurrence'), false);
  assert.equal(JSON.stringify(value).includes('Private'), false);
});
test('Apple context reads only the already-authorized queue, keeps SDK occurrence index and never falls back to local tracks', async () => {
  let queueReads = 0, statusReads = 0;
  const service = createPlaybackContextService({apple: {getStatus: () => {statusReads++; return appleStatus();}, getQueue: input => {queueReads++;
    assert.deepEqual(input, {limit: 100, offset: 0}); return appleQueue();}, authorize() {throw new Error('No authorize');}, initialize() {throw new Error('No initialize');}},
    local: {playbackContext() {throw new Error('No local source');}}, getTracks() {throw new Error('No library fallback');}});
  const value = await service.read('apple'); assert.equal(value.status, 'ready'); assert.equal(value.playlist, null); assert.equal(value.currentIndex, 2);
  assert.equal(Object.hasOwn(value, 'offset'), false); assert.equal(Object.hasOwn(value, 'total'), false);
  assert.equal(queueReads, 2); assert.equal(statusReads, 4); assert.notEqual(value.items[0].key, value.items[2].key);
  assert.deepEqual(value.items[2].reference, {source: 'apple', kind: 'songs', id: 'repeat', itemIndex: 2}); assert.equal(value.capabilities.select, false);
});
test('closed Apple sessions cannot read a queue or the local source; filtered or changing queues cannot invent a current occurrence', async () => {
  let reads = 0;
  const closed = createPlaybackContextService({apple: {getStatus: () => ({available: false, runtime: {sessionOpen: false}}), getQueue: () => {reads++;}},
    getTracks: () => {throw new Error('No local metadata');}});
  assert.deepEqual((await closed.read('apple')).items, []); assert.equal(reads, 0);
  for (const mode of ['filtered', 'changed']) {
    let count = 0;
    const service = createPlaybackContextService({apple: {getStatus: appleStatus, getQueue: () => {const value = appleQueue(); count++;
      if (mode === 'filtered') value.items.pop(); else if (count > 1) value.position = 0; return value;}}});
    const value = await service.read('apple'); assert.equal(value.status, 'unknown'); assert.equal(value.currentIndex, null); assert.deepEqual(value.items, []);
  }
});
test('a timed-out read keeps its physical source slot until actual settlement and performs no late metadata work', async () => {
  const gate = deferred(); let calls = 0, tracks = 0, signal;
  const service = createPlaybackContextService({timeoutMs: 10, local: {playbackContext: input => {calls++; signal = input.signal; return gate.promise;}}, getTracks: () => {tracks++; return [];}});
  assert.equal((await service.read('local')).reason, 'context-timeout'); assert.equal(signal.aborted, true);
  assert.equal((await service.read('local')).reason, 'context-busy'); assert.equal(calls, 1);
  gate.resolve(rawLocal()); await new Promise(resolve => setImmediate(resolve)); assert.equal(tracks, 0);
  const next = await service.read('local'); assert.equal(calls, 2); assert.equal(next.status, 'ready');
});
test('new intent and close promptly invalidate logical results without freeing unsettled transport or publishing late data', async () => {
  for (const action of ['invalidate', 'close']) {
    const gate = deferred(), entered = deferred(); let generation = 1, calls = 0;
    const service = createPlaybackContextService({local: {playbackContext: () => {calls++; entered.resolve(); return gate.promise;}}, getGeneration: () => generation});
    const pending = service.read('local'); await entered.promise;
    if (action === 'invalidate') {generation++; service.invalidate();} else service.close();
    const value = await pending; assert.notEqual(value.status, 'ready'); assert.deepEqual(value.items, []); assert.equal(value.currentIndex, null);
    assert.equal((await service.read('local')).reason, action === 'close' ? 'context-closed' : 'context-busy'); assert.equal(calls, 1);
    gate.resolve(rawLocal()); await new Promise(resolve => setImmediate(resolve));
    if (action === 'close') assert.equal((await service.read('local')).reason, 'context-closed');
  }
});
test('context serialization ignores unknown data/getters and cannot accept unsupported sources or counts', async () => {
  const raw = rawLocal(); let reads = 0;
  Object.defineProperty(raw.items[0], 'title', {get() {reads++; throw new Error('PRIVATE');}});
  Object.defineProperty(raw, 'credentials', {get() {reads++; throw new Error('PRIVATE');}});
  const service = createPlaybackContextService({local: {playbackContext: () => raw}}), value = await service.read('local');
  assert.equal(value.items[0].title, ''); assert.equal(reads, 0); assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  await assert.rejects(service.read('unknown')); assert.throws(() => createPlaybackContextService({maxItems: 501}), /limit/);
});

test('close before dispatch prevents any engine read and an oversized Apple queue without position stops after its first page', async () => {
  let calls = 0;
  const service = createPlaybackContextService({local: {playbackContext: () => {calls++; return rawLocal();}}});
  const pending = service.read('local'); service.close(); assert.equal((await pending).reason, 'context-closed'); assert.equal(calls, 0);
  const apple = createPlaybackContextService({apple: {getStatus: appleStatus, getQueue: () => {calls++; return {...appleQueue(), total: 501, position: null};}}});
  assert.equal((await apple.read('apple')).reason, 'context-too-large'); assert.equal(calls, 1);
});

test('Apple pagination is bounded and an absent SDK position never guesses a current index from duplicate IDs', async () => {
  const offsets = [], rows = Array.from({length: 203}, (_, index) => ({id: `item-${index}`, type: 'songs', playable: true}));
  const service = createPlaybackContextService({apple: {getStatus: appleStatus, getQueue: ({limit, offset}) => {
    offsets.push(offset); return {offset, total: rows.length, position: null, items: rows.slice(offset, offset + limit)};}}});
  const value = await service.read('apple'); assert.equal(value.status, 'ready'); assert.equal(value.items.length, 203);
  assert.equal(value.currentIndex, null); assert.deepEqual(offsets, [0, 100, 200, 0, 100, 200]);
});

test('large Apple queues keep their verified absolute position and read-only occurrences across overlapping windows', async () => {
  const requests = [], rows = Array.from({length: 987}, (_, index) => ({id: `song-${index}`, type: 'songs', playable: true}));
  rows[519] = {...rows[520]};
  let position;
  const service = createPlaybackContextService({apple: {getStatus: appleStatus, getQueue: ({limit, offset}) => {
    requests.push([offset, limit]); return {offset, total: rows.length, position, items: rows.slice(offset, offset + limit)};
  }}});
  let middle;
  for (const [current, offset] of [[0, 0], [520, 270], [521, 271], [986, 487]]) {
    requests.length = 0; position = current;
    const value = await service.read('apple');
    assert.equal(value.status, 'ready'); assert.equal(value.currentIndex, current); assert.equal(value.offset, offset); assert.equal(value.total, 987);
    assert.deepEqual(value.items.map(item => item.index), Array.from({length: 500}, (_, index) => index + offset));
    assert.deepEqual(value.items[current - offset].reference, {source: 'apple', kind: 'songs', id: rows[current].id, itemIndex: current});
    assert.deepEqual(value.capabilities, {select: false, predictNeighbors: false}); assert.equal(Object.hasOwn(value, 'selectionToken'), false);
    const pass = Array.from({length: 5}, (_, index) => [offset + 100 * index, 100]);
    if (offset) pass.unshift([0, 100]);
    assert.deepEqual(requests, [...pass, ...pass]);
    if (current === 520) {
      middle = value;
      assert.equal(value.items[249].trackId, value.items[250].trackId); assert.notEqual(value.items[249].key, value.items[250].key);
    }
    if (current === 521) assert.equal(value.items[249].key, middle.items[250].key);
  }
});

test('large Apple queues reject moving positions, inconsistent pages and windows outside provider limits', async () => {
  const rows = Array.from({length: 987}, (_, index) => ({id: `song-${index}`, type: 'songs', playable: true}));
  rows[519] = {...rows[520]};
  for (const mode of ['moving', 'changing', 'filtered', 'different-total', 'out-of-range-position', 'out-of-range-offset']) {
    let calls = 0;
    const service = createPlaybackContextService({apple: {getStatus: appleStatus, getQueue: ({limit, offset}) => {
      calls++;
      const total = mode === 'out-of-range-offset' ? 1005000 : rows.length;
      const items = rows.slice(offset, offset + limit);
      if (mode === 'changing' && calls === 8) items[0] = {...items[0], title: 'Replaced'};
      if (mode === 'filtered' && calls === 2) items.pop();
      const position = mode === 'out-of-range-offset' ? total - 1 : mode === 'out-of-range-position' ? total : mode === 'moving' && calls > 6 ? 519 : 520;
      return {offset, total: total + Number(mode === 'different-total' && calls === 2), position, items};
    }}});
    const value = await service.read('apple');
    assert.equal(value.status, 'unknown', mode); assert.equal(value.currentIndex, null); assert.deepEqual(value.items, []);
    if (mode.startsWith('out-of-range')) assert.equal(calls, 1);
  }
});

test('neighbor prediction stays false unless the local backend explicitly confirms it, and never follows Apple array order', async () => {
  for (const evidence of [undefined, false, 'normal', 0, true]) {
    const local = createPlaybackContextService({local: {playbackContext: () => ({...rawLocal(), predictNeighbors: evidence})}});
    assert.equal((await local.read('local')).capabilities.predictNeighbors, evidence === true);
  }
  const apple = createPlaybackContextService({apple: {getStatus: appleStatus, getQueue: () => ({...appleQueue(), predictNeighbors: true, shuffle: false})}});
  assert.equal((await apple.read('apple')).capabilities.predictNeighbors, false);
});

test('an Apple starting or closing lifecycle cannot dispatch queue reads even if old availability remains cached', async () => {
  for (const lifecyclePhase of ['starting', 'closing']) {
    let reads = 0;
    const service = createPlaybackContextService({apple: {getStatus: () => ({...appleStatus(), pending: true, lifecyclePhase}), getQueue: () => {reads++; return appleQueue();}}});
    assert.equal((await service.read('apple')).status, 'unavailable'); assert.equal(reads, 0);
  }
  let closing = false, queues = 0;
  const changed = createPlaybackContextService({apple: {getStatus: () => ({...appleStatus(), pending: closing, lifecyclePhase: closing ? 'closing' : 'ready'}),
    getQueue: () => {queues++; closing = true; return appleQueue();}}});
  assert.deepEqual((await changed.read('apple')).items, []); assert.equal(queues, 1);
});
