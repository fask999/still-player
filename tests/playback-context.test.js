'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createPlaybackContextService} = require('../src/main/playback-context');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const rawLocal = () => ({status: 'ready', playlist: {id: 'real', name: 'Real playing list'}, currentIndex: 2, items: [0, 1, 2].map(index =>
  ({playlistId: 'real', itemIndex: index, path: index === 1 ? 'E:\\Other.flac' : 'E:\\Repeated.flac', subsong: 0, title: 'Song', artist: 'Artist', album: 'Album', supported: true}))});
const appleStatus = () => ({available: true, runtime: {sessionOpen: true}, capabilities: {queue: true}});
const appleQueue = () => ({offset: 0, limit: 100, total: 3, position: 2, hasMore: false,
  items: [0, 1, 2].map(index => ({id: index === 1 ? 'other' : 'repeat', type: 'songs', title: 'Song', artist: 'Artist', album: 'Album', playable: true}))});
test('local context resolves exact library metadata, hides file paths and retains occurrence keys and real current index', async () => {
  const library = [{id: 'known', path: 'e:/repeated.flac', subsong: 0, coverUrl: 'still-apple-art://art/' + 'a'.repeat(64)}];
  const service = createPlaybackContextService({local: {playbackContext: () => rawLocal()}, getTracks: () => library, getGeneration: () => 7, getRevision: () => 11});
  const value = await service.read('local');
  assert.equal(value.status, 'ready'); assert.equal(value.currentIndex, 2); assert.equal(value.generation, 7); assert.equal(value.revision, 11);
  assert.deepEqual(value.items.map(item => item.trackId), ['known', null, 'known']); assert.equal(new Set(value.items.map(item => item.key)).size, 3);
  assert.deepEqual(value.items[2].reference, {source: 'local', playlistId: 'real', itemIndex: 2}); assert.equal(value.items[0].coverUrl, library[0].coverUrl);
  assert.equal(JSON.stringify(value).includes('Repeated.flac'), false); assert.deepEqual(value.capabilities, {select: false, predictNeighbors: false});
});
test('Apple context reads only the already-authorized queue, keeps SDK occurrence index and never falls back to local tracks', async () => {
  let queueReads = 0, statusReads = 0;
  const service = createPlaybackContextService({apple: {getStatus: () => {statusReads++; return appleStatus();}, getQueue: input => {queueReads++;
    assert.deepEqual(input, {limit: 100, offset: 0}); return appleQueue();}, authorize() {throw new Error('No authorize');}, initialize() {throw new Error('No initialize');}},
    local: {playbackContext() {throw new Error('No local source');}}, getTracks() {throw new Error('No library fallback');}});
  const value = await service.read('apple'); assert.equal(value.status, 'ready'); assert.equal(value.playlist, null); assert.equal(value.currentIndex, 2);
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

test('close before dispatch prevents any engine read and an oversized Apple queue stops after its first page', async () => {
  let calls = 0;
  const service = createPlaybackContextService({local: {playbackContext: () => {calls++; return rawLocal();}}});
  const pending = service.read('local'); service.close(); assert.equal((await pending).reason, 'context-closed'); assert.equal(calls, 0);
  const apple = createPlaybackContextService({apple: {getStatus: appleStatus, getQueue: () => {calls++; return {...appleQueue(), total: 501};}}});
  assert.equal((await apple.read('apple')).reason, 'context-too-large'); assert.equal(calls, 1);
});

test('Apple pagination is bounded and an absent SDK position never guesses a current index from duplicate IDs', async () => {
  const offsets = [], rows = Array.from({length: 203}, (_, index) => ({id: `item-${index}`, type: 'songs', playable: true}));
  const service = createPlaybackContextService({apple: {getStatus: appleStatus, getQueue: ({limit, offset}) => {
    offsets.push(offset); return {offset, total: rows.length, position: null, items: rows.slice(offset, offset + limit)};}}});
  const value = await service.read('apple'); assert.equal(value.status, 'ready'); assert.equal(value.items.length, 203);
  assert.equal(value.currentIndex, null); assert.deepEqual(offsets, [0, 100, 200, 0, 100, 200]);
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
