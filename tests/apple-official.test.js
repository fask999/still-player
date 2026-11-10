'use strict';
const {integrationEnabled} = require('./helpers/test-effect-guard.cjs').installTestEffectGuard({suite: 'apple-host-protocol'});

// All MusicKit/account/playback values below are SYNTHETIC UNIT FIXTURES.
// These tests never open a browser, log in, play audio or contact Apple/Cider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const {PassThrough, Writable} = require('node:stream');
const {spawnSync} = require('node:child_process');
const {createOfficialAppleMusicService, createNativeOfficialHost} = require('../src/main/apple-official-web');
const {createAppleMusicService} = require('../src/main/apple-music');
const {createPlaybackCoordinator} = require('../src/main/playback-coordinator');
const {createPlaybackContextService} = require('../src/main/playback-context');
const {createHandlers} = require('../src/main/ipc-handlers');
const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'native', 'apple-host', 'official-bridge.js'), 'utf8');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const fixtureSong = (id = 'fixture-song-1', extra = {}) => ({id, type: 'songs', attributes: {
  name: `Fixture ${id}`, artistName: 'Synthetic artist', albumName: 'Synthetic album', durationInMillis: 240000,
  playParams: {id, kind: 'song'}, ...extra}});

function fixture({authorized = false, origin = 'https://music.apple.com', frozenProgress = false, orderEnums} = {}) {
  const requests = [], calls = [];
  let sensitiveReads = 0, gate = null, closed = false, running = false, muted = true, activeStarts = 0, session = null, closeMode = 'confirmed';
  const waiting = new Set();
  const music = {isAuthorized: authorized, isPlaying: false, playbackState: 0, currentPlaybackTime: 0, currentPlaybackDuration: 0, volume: 0.5,
    nowPlayingItem: null, storefrontId: 'cn', queue: {items: [], position: 0},
    api: {async music(endpoint) {
      requests.push(endpoint);
      if (endpoint.startsWith('/v1/catalog/cn/search?')) return {data: {results: {songs: {data: [fixtureSong()], next: '/v1/catalog/cn/search?offset=1'}}}};
      if (endpoint.startsWith('/v1/me/library/songs?')) return {data: {data: [{...fixtureSong('fixture-library-1', {playParams: {catalogId: 'fixture-song-1'}}), type: 'library-songs'}]}};
      if (endpoint.startsWith('/v1/me/library/playlists/fixture-playlist/tracks?')) return {data: {data: [{...fixtureSong('fixture-library-1', {playParams: {catalogId: 'fixture-song-1'}}), type: 'library-songs'}]}};
      throw new Error('Fixture does not implement this API');
    }},
    async setQueue(value) {calls.push(['setQueue', value]); if (gate) {gate.entered.resolve(); await gate.resume.promise;} music.queue.items = value.songs.map(id => fixtureSong(id)); music.nowPlayingItem = music.queue.items[0]; music.currentPlaybackDuration = 240;},
    async play() {calls.push(['play']); music.isPlaying = true; music.playbackState = 2;},
    async pause() {calls.push(['pause']); music.isPlaying = false; music.playbackState = 3;},
    async stop() {calls.push(['stop']); music.isPlaying = false; music.playbackState = 4; music.nowPlayingItem = null;},
    async seekToTime(value) {calls.push(['seek', value]); music.currentPlaybackTime = value;},
    async skipToNextItem() {calls.push(['next']); music.nowPlayingItem = fixtureSong('fixture-song-2');},
    async skipToPreviousItem() {calls.push(['previous']); music.currentPlaybackTime = 0;},
  };
  for (const name of ['developerToken', 'musicUserToken', 'configuration', 'token']) Object.defineProperty(music, name, {get() {sensitiveReads++; throw new Error('Sensitive fixture property must never be read');}});
  const context = {location: {origin}, URLSearchParams, URL, setTimeout, MusicKit: {getInstance: () => music, ...orderEnums}};
  context.window = context; context.top = context;
  const bridge = vm.runInNewContext(bridgeSource, context);
  const host = {
    startCalls: [], closeCalls: 0,
    async start(options) {host.startCalls.push(options); running = true; closed = false; muted = true; session = {}; return {runtime: 'fixture-runtime'};},
    isRunning: () => running,
    hasUnsettledStart: () => activeStarts > 0,
    captureSession: () => session,
    closeSession(owner) {return owner === session && owner ? host.close() : Promise.resolve({closed: false, sessionChanged: true, browserProcessExited: false, helperExited: false});},
    runtime: () => 'fixture-runtime',
    async request(method, data = {}) {
      if (!running) throw Object.assign(new Error('closed'), {code: 'host-exited', officialError: true});
      if (method === 'play' || method === 'resume') {muted = true; activeStarts++;}
      if (method === 'stop') muted = true;
      if (method === 'probe' && music.isPlaying && !frozenProgress) music.currentPlaybackTime += 0.1; // Synthetic progressing clock.
      let rejectClosed;
      const interrupted = new Promise((_resolve, reject) => {rejectClosed = reject; waiting.add(reject);});
      try {
        const result = await Promise.race([bridge({method, ...data}), interrupted]);
        if (!result.ok) {if (method === 'play' || method === 'resume') muted = true; throw Object.assign(new Error(result.code), {code: result.code, officialError: true});}
        if (method === 'play' || method === 'resume') muted = !(result.value.isPlaying && (method === 'resume' || result.value.currentTrackId === data.id));
        return {...result.value, outputMuted: muted};
      } finally {waiting.delete(rejectClosed); if (method === 'play' || method === 'resume') activeStarts--;}
    },
    cancelPending() {if (activeStarts) return host.close(); return bridge({method: 'cancel'});},
    async close() {
      host.closeCalls++;
      if (closeMode === 'unconfirmed') return {closed: false, browserProcessExited: false, helperExited: false};
      if (closeMode === 'throw') throw new Error('Synthetic cleanup failure');
      if (closeMode === 'helper-only') {running = false; session = null; return {closed: true, browserProcessExited: false, helperExited: true};}
      await bridge({method: 'cancel'}); running = false; closed = true; muted = true; session = null;
      for (const reject of waiting) reject(Object.assign(new Error('closed'), {code: 'host-exited', officialError: true}));
      music.isPlaying = false; music.playbackState = 4;
      return {closed: true, browserProcessExited: true, helperExited: true};
    },
  };
  return {music, calls, requests, bridge, host, sensitiveReads: () => sensitiveReads, isClosed: () => closed, outputMuted: () => muted,
    setCloseMode(value) {closeMode = value;},
    gateSetQueue() {gate = {entered: deferred(), resume: deferred()}; return gate;}};
}

function serviceFor(fixtureValue, options = {}) {
  return createOfficialAppleMusicService({dataDir: path.join(__dirname, 'fixture-data-not-written'), hostPath: __filename,
    hostFactory: () => fixtureValue.host, runtimeDetector: async () => 'fixture-runtime', verificationTimeout: 100, pollInterval: 2, ...options});
}

const libraryAlbumId = 'l.fixtureAlbum';
const albumEndpoint = '/v1/catalog/cn/albums/fixtureAlbum';
const albumSelection = (id, index) => ({ids: [id], kind: 'songs', album: {id: libraryAlbumId, index}});

function albumFixture({modes = false, restoreOrder = true} = {}) {
  const orderEnums = {PlayerShuffleMode: {off: 0, songs: 1}, PlayerRepeatMode: {none: 0, one: 1, all: 2}};
  const f = fixture({authorized: true, ...(modes ? {orderEnums} : {})}), {music} = f;
  const tracks = ['fixture-A', 'fixture-B', 'fixture-B', 'fixture-C'].map(id => fixtureSong(id));
  const originalApi = music.api.music, originalSetQueue = music.setQueue;
  let orderedItems = [], shuffleMode = 0;
  const arrange = keepCurrent => {
    const current = music.nowPlayingItem;
    const items = shuffleMode ? [...orderedItems].reverse() : [...orderedItems];
    if (shuffleMode && keepCurrent && items.includes(current)) items.unshift(items.splice(items.indexOf(current), 1)[0]);
    music.queue.items = items;
    music.queue.position = Math.max(0, items.indexOf(current));
  };
  if (modes) {
    music.repeatMode = 0;
    Object.defineProperty(music, 'shuffleMode', {get: () => shuffleMode, set: mode => {
      shuffleMode = mode;
      if (mode || restoreOrder) arrange(true);
    }});
  }
  music.api.music = async endpoint => {
    if (endpoint === `/v1/me/library/albums/${libraryAlbumId}/catalog`) {
      f.requests.push(endpoint);
      // Identifier-only catalog relationships are valid and need a catalog read.
      return {data: {data: [{id: 'fixtureAlbum', type: 'albums'}]}};
    }
    if (endpoint === albumEndpoint) {
      f.requests.push(endpoint);
      return {data: {data: [{id: 'fixtureAlbum', type: 'albums', attributes: {trackCount: tracks.length}}]}};
    }
    if (endpoint.startsWith(`${albumEndpoint}/tracks?`)) {
      f.requests.push(endpoint);
      const {searchParams} = new URL(endpoint, 'https://api.music.apple.com');
      const offset = Number(searchParams.get('offset')), limit = Math.min(2, Number(searchParams.get('limit')));
      const data = tracks.slice(offset, offset + limit), end = offset + data.length;
      return {data: {data, ...(end < tracks.length ? {next: `${albumEndpoint}/tracks?offset=${end}`} : {})}};
    }
    return originalApi(endpoint);
  };
  music.setQueue = async value => {
    if (!value.items) return originalSetQueue(value);
    f.calls.push(['setQueue', value]);
    orderedItems = Array.from(value.items); arrange(false); music.queue.position = 0;
    music.nowPlayingItem = music.queue.items[0]; music.isPlaying = false; music.currentPlaybackTime = 0;
  };
  const select = index => {
    music.queue.position = index; music.nowPlayingItem = music.queue.items[index];
    music.isPlaying = true; music.playbackState = 2; music.currentPlaybackTime = 0;
  };
  music.changeToMediaAtIndex = async index => {f.calls.push(['changeToMediaAtIndex', index]); select(index);};
  music.skipToNextItem = async () => {
    f.calls.push(['next']);
    const index = music.queue.position + 1;
    if (index < music.queue.items.length) select(index);
    else if (music.repeatMode === 2) select(0);
    else {music.isPlaying = false; music.playbackState = 4; music.nowPlayingItem = null;}
  };
  music.skipToPreviousItem = async () => {
    f.calls.push(['previous']);
    if (music.queue.position > 0) select(music.queue.position - 1);
    else if (music.repeatMode === 2) select(music.queue.items.length - 1);
    else music.currentPlaybackTime = 0;
  };
  return {...f, tracks};
}

test('official album browses catalog pages, starts the exact duplicate occurrence and displays the real ordered SDK queue', async t => {
  const f = albumFixture(), service = serviceFor(f);
  const panel = createPlaybackContextService({apple: service, pageSize: 2});
  t.after(() => {panel.close(); return service.close();});
  await service.initialize(); await service.authorize();
  assert.equal(service.status().capabilities.albumPlayback, true);
  const first = await service.library({kind: 'album-songs', id: libraryAlbumId});
  const second = await service.library({kind: 'album-songs', id: libraryAlbumId, offset: first.nextOffset});
  assert.equal(first.albumPlayback, true); assert.equal(second.albumPlayback, true);
  assert.equal(first.total, 4); assert.equal(first.nextOffset, 2); assert.equal(second.hasMore, false);
  assert.deepEqual([...first.items, ...second.items].map(track => track.id), ['fixture-A', 'fixture-B', 'fixture-B', 'fixture-C']);
  const started = await service.play(albumSelection(second.items[0].id, second.offset));
  assert.equal(started.currentTrackId, 'fixture-B'); assert.equal(started.queuePosition, 2); assert.equal(started.outputMuted, false);
  assert.deepEqual(f.calls.map(call => call[0]), ['setQueue', 'changeToMediaAtIndex']);
  assert.equal(f.calls[0][1].startPlaying, false);
  assert.deepEqual(Array.from(f.calls[0][1].items, track => track.id), ['fixture-A', 'fixture-B', 'fixture-B', 'fixture-C']);
  assert.deepEqual(f.calls[1], ['changeToMediaAtIndex', 2]);
  const queued = await panel.read('apple');
  assert.equal(queued.status, 'ready'); assert.equal(queued.currentIndex, 2);
  assert.deepEqual(queued.items.map(item => item.trackId), ['fixture-A', 'fixture-B', 'fixture-B', 'fixture-C']);
  assert.notEqual(queued.items[1].key, queued.items[2].key);
  const previous = await service.previous();
  assert.equal(previous.queuePosition, 1); assert.equal(previous.currentTrackId, 'fixture-B');
  const next = await service.next();
  assert.equal(next.queuePosition, 2); assert.equal(next.currentTrackId, 'fixture-B');
  assert.equal(f.sensitiveReads(), 0);
});

test('album pagination or eligibility failures never call a queue or playback mutation', async t => {
  for (const reason of ['truncated', 'bad cursor', 'wrong occurrence', 'unavailable neighbor', 'unsupported video']) await t.test(reason, async t => {
    const f = albumFixture(), service = serviceFor(f);
    t.after(() => service.close()); await service.initialize(); await service.authorize();
    if (reason === 'unavailable neighbor') delete f.tracks[0].attributes.playParams;
    if (reason === 'unsupported video') f.tracks[3].type = 'music-videos';
    const api = f.music.api.music;
    f.music.api.music = async endpoint => {
      const result = await api(endpoint);
      if (endpoint.startsWith(`${albumEndpoint}/tracks?`) && endpoint.endsWith('offset=0')) {
        if (reason === 'truncated') delete result.data.next;
        if (reason === 'bad cursor') result.data.next = `${albumEndpoint}/tracks?offset=3`;
      }
      return result;
    };
    const expected = reason === 'wrong occurrence' ? 'official-track-unconfirmed' :
      ['truncated', 'bad cursor'].includes(reason) ? 'official-invalid-response' : 'unsupported-item';
    await assert.rejects(service.play(albumSelection('fixture-B', reason === 'wrong occurrence' ? 3 : 2)), {code: expected});
    assert.deepEqual(f.calls, []);
    assert.equal(f.outputMuted(), true);
  });
});

test('an album request superseded during catalog pagination cannot set its queue after the new request starts', async t => {
  const f = albumFixture(), service = serviceFor(f);
  t.after(() => service.close()); await service.initialize(); await service.authorize();
  await service.library({kind: 'album-songs', id: libraryAlbumId});
  const entered = deferred(), release = deferred(), api = f.music.api.music;
  let pendingPage = true;
  f.music.api.music = async endpoint => {
    if (pendingPage && endpoint.startsWith(`${albumEndpoint}/tracks?`) && endpoint.endsWith('offset=2')) {
      pendingPage = false; entered.resolve(); await release.promise;
    }
    return api(endpoint);
  };
  const older = service.play(albumSelection('fixture-B', 2)); older.catch(() => {});
  await entered.promise;
  try {
    await service.cancelPending({intent: 'play', source: 'apple'});
    await assert.rejects(older, {code: 'STILL_CANCELLED'});
    assert.equal(service.status().capabilities.albumPlayback, true);
    const current = await service.play(albumSelection('fixture-C', 3));
    assert.equal(current.currentTrackId, 'fixture-C'); assert.equal(current.queuePosition, 3);
  } finally {release.resolve();}
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(call => call[0]), ['setQueue', 'changeToMediaAtIndex']);
  assert.deepEqual(f.calls[1], ['changeToMediaAtIndex', 3]);
});

test('album readback fails when the SDK drops a row or the real queue changes while selected audio advances', async t => {
  for (const change of ['drops a row on install', 'changes after unmute']) await t.test(change, async t => {
    const f = albumFixture(), service = serviceFor(f);
    t.after(() => service.close()); await service.initialize(); await service.authorize();
    if (change === 'drops a row on install') {
      const setQueue = f.music.setQueue;
      f.music.setQueue = async value => {await setQueue(value); f.music.queue.items.pop();};
    } else {
      const request = f.host.request;
      f.host.request = async (method, data) => {
        if (method === 'probe' && data?.includeQueue) f.music.queue.items[0] = fixtureSong('unexpected');
        return request(method, data);
      };
    }
    await assert.rejects(service.play(albumSelection('fixture-B', 2)), {code: 'official-track-unconfirmed'});
    assert.equal(f.host.closeCalls, 1); assert.equal(f.outputMuted(), true);
    assert.equal(service.status().verification.selectedPlaybackReadback, false);
    if (change === 'drops a row on install') assert.equal(f.calls.some(call => call[0] === 'changeToMediaAtIndex'), false);
  });
});

test('an album skip rejects the wrong occurrence even when the SDK changes song or restarts the duplicate', async t => {
  const f = albumFixture(), service = serviceFor(f);
  t.after(() => service.close()); await service.initialize(); await service.authorize();
  await service.play(albumSelection('fixture-B', 2));
  f.music.currentPlaybackTime = 5;
  f.music.skipToPreviousItem = async () => {f.music.currentPlaybackTime = 0;};
  await assert.rejects(service.previous(), {code: 'official-operation-failed'});
  await service.play(albumSelection('fixture-B', 1));
  f.music.skipToNextItem = () => f.music.changeToMediaAtIndex(3);
  await assert.rejects(service.next(), {code: 'official-operation-failed'});
});

test('a repeated next snapshots the live album after the cancelled SDK skip physically settles', async t => {
  const f = albumFixture(), service = serviceFor(f);
  t.after(() => service.close()); await service.initialize(); await service.authorize();
  await service.play(albumSelection('fixture-A', 0));
  const entered = deferred(), release = deferred(), skip = f.music.skipToNextItem;
  let first = true;
  f.music.skipToNextItem = async () => {
    if (first) {first = false; entered.resolve(); await release.promise;}
    return skip();
  };
  const older = service.next(); older.catch(() => {});
  await entered.promise;
  try {
    const cancelled = service.cancelPending({intent: 'command', source: 'apple', method: 'next'});
    const newer = service.next(); newer.catch(() => {});
    release.resolve(); await cancelled;
    await assert.rejects(older, {code: 'STILL_CANCELLED'});
    const current = await newer;
    assert.equal(current.queuePosition, 2); assert.equal(current.currentTrackId, 'fixture-B');
  } finally {release.resolve();}
});

test('official playback order is routed through IPC, reads Apple enum values and preserves the selected real queue', async t => {
  const f = albumFixture({modes: true}), apple = serviceFor(f), hints = [];
  const cancel = f.host.cancelPending;
  f.host.cancelPending = options => {hints.push(options); return cancel(options);};
  const handler = createHandlers({apple, library: {list: async () => ({tracks: [], playlists: [], folders: []})},
    foobar: {getState: async () => ({available: false, state: 'stopped'}), stop: async () => {}, releaseOutput: async () => ({released: true})}});
  t.after(() => apple.close()); await apple.initialize(); await apple.authorize();
  const playing = await handler['player:play']({source: 'apple', id: 'fixture-C', kind: 'songs', album: {id: libraryAlbumId, index: 3}});
  assert.equal(playing.controlsReady, true);
  assert.deepEqual(playing.playbackOrders.map(mode => mode.id), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(playing.playbackOrder, {id: 0, name: '顺序'});
  const apply = (state, id) => handler['player:order']({source: 'apple', generation: state.generation, id});
  const repeat = await apply(playing, 1);
  assert.equal(repeat.playbackOrder.id, 1); assert.equal(f.music.repeatMode, 2);
  assert.equal(repeat.currentTrackId, 'fixture-C'); assert.equal(repeat.queuePosition, 3); assert.equal(repeat.outputMuted, false);
  assert.equal(hints.at(-1).preservePlaybackPermission, true);
  const wrapped = await handler['player:next']({});
  assert.equal(wrapped.queuePosition, 0); assert.equal(wrapped.currentTrackId, 'fixture-A');
  const shuffled = await apply(wrapped, 4);
  assert.equal(shuffled.playbackOrder.id, 4); assert.equal(f.music.shuffleMode, 1); assert.equal(shuffled.queuePosition, 0);
  const actual = await handler['player:context']({source: 'apple'});
  assert.deepEqual(actual.items.map(item => item.trackId), ['fixture-A', 'fixture-C', 'fixture-B', 'fixture-B']);
  const single = await apply(shuffled, 5);
  assert.equal(single.playbackOrder.id, 5); assert.equal(f.music.repeatMode, 1);
  const ordered = await apply(single, 0);
  assert.equal(ordered.playbackOrder.id, 0); assert.equal(f.music.shuffleMode, 0);
  assert.deepEqual((await handler['player:context']({source: 'apple'})).items.map(item => item.trackId), ['fixture-A', 'fixture-B', 'fixture-B', 'fixture-C']);
  assert.deepEqual(f.calls.map(call => call[0]), ['setQueue', 'changeToMediaAtIndex', 'next']);
});

test('shuffled album locates a unique track by live position and rejects indistinguishable occurrences without changing mode', async t => {
  const f = albumFixture({modes: true}), service = serviceFor(f);
  t.after(() => service.close()); await service.initialize(); await service.authorize();
  assert.equal((await service.setOrder(4)).playbackOrder.id, 4);
  const started = await service.play(albumSelection('fixture-A', 0));
  assert.equal(started.currentTrackId, 'fixture-A'); assert.equal(started.queuePosition, 3); assert.equal(started.playbackOrder.id, 4);
  assert.equal((await service.next()).currentTrackId, 'fixture-C');
  const count = f.calls.length;
  await assert.rejects(service.play(albumSelection('fixture-B', 2)), {code: 'official-track-unconfirmed'});
  assert.equal(f.calls.length, count); assert.equal(f.music.shuffleMode, 1); assert.equal(f.music.repeatMode, 2);
});

test('order reports failed queue restoration even when the observed SDK mode flag changes', async t => {
  const f = albumFixture({modes: true, restoreOrder: false}), service = serviceFor(f);
  t.after(() => service.close()); await service.initialize(); await service.authorize();
  await service.play(albumSelection('fixture-A', 0)); await service.setOrder(3);
  await assert.rejects(service.setOrder(0), {code: 'official-operation-failed'});
  assert.equal((await service.getState()).playbackOrder.id, 0);
  assert.equal(service.status().lastOperation.failedFromStage, 'readback');
  const calls = f.calls.length;
  await assert.rejects(service.next(), {code: 'official-track-unconfirmed'});
  assert.equal(f.calls.length, calls);
});

test('missing public index controls disable album requests and preserve ordinary single-song playback', async t => {
  const f = albumFixture(), service = serviceFor(f);
  delete f.music.changeToMediaAtIndex;
  t.after(() => service.close()); await service.initialize(); await service.authorize();
  assert.equal(service.status().capabilities.albumPlayback, false);
  await assert.rejects(service.play(albumSelection('fixture-B', 2)), {code: 'official-control-unavailable'});
  assert.deepEqual(f.calls, []);
  assert.equal((await service.play({ids: ['fixture-B']})).currentTrackId, 'fixture-B');
  assert.deepEqual(Array.from(f.calls[0][1].songs), ['fixture-B']);
});

test('default factory is officialWeb; initialize/getState never open a host or Cider', async () => {
  assert.equal(createAppleMusicService, createOfficialAppleMusicService);
  const f = fixture(), service = serviceFor(f);
  const status = await service.initialize();
  assert.equal(status.provider, 'officialWeb'); assert.equal(status.status, 'session-closed');
  assert.equal(status.capabilities.playback, false); assert.equal(status.capabilities.library, false);
  assert.equal((await service.getState()).available, false); assert.equal((await service.getState()).errorCode, 'session-closed'); assert.equal(f.host.startCalls.length, 0);
  assert.equal(f.requests.length, 0); await service.close(); assert.equal((await service.getState()).errorCode, 'closed');
});

test('official bridge probes only named public members and enforces the top-level official origin', async () => {
  const f = fixture(); const result = await f.bridge({method: 'probe'});
  assert.equal(result.ok, true); assert.equal(result.value.state.authorized, false);
  assert.equal(result.value.methods.apiMusic, true); assert.equal(f.sensitiveReads(), 0);
  const invalid = fixture({origin: 'https://example.com'});
  assert.equal((await invalid.bridge({method: 'probe'})).code, 'official-origin-required');
});

test('unauthenticated library/play are blocked without API or media calls; catalog uses official public api.music', async () => {
  const f = fixture(), service = serviceFor(f); await service.initialize();
  const status = await service.authorize();
  assert.equal(f.host.startCalls[0].show, true); assert.equal(status.status, 'authorization-required');
  assert.equal(status.capabilities.search, true); assert.equal(status.capabilities.library, false);
  await assert.rejects(service.library(), {code: 'needs-auth'});
  await assert.rejects(service.play({id: 'fixture-song-1'}), {code: 'needs-auth'});
  assert.deepEqual(f.calls, []); assert.deepEqual(f.requests, []);
  const result = await service.search({term: 'Fixture', types: ['songs'], limit: 1});
  assert.equal(result.items[0].id, 'fixture-song-1'); assert.equal(result.items[0].coverUrl, '');
  assert.equal(result.hasMore, true); assert.equal(f.requests.length, 1);
  assert.match(f.requests[0], /^\/v1\/catalog\/cn\/search\?/); assert.equal(f.sensitiveReads(), 0);
  await service.close();
});

test('SDK errors and unsupported arbitrary script input never expose raw messages or credentials', async () => {
  const f = fixture({authorized: true});
  const invalid = await f.bridge({method: 'eval', script: 'fixture-private-string'});
  assert.equal(invalid.ok, false); assert.equal(invalid.code, 'unsupported-method');
  f.music.play = async () => {throw Object.assign(new Error('fixture-sensitive-value'), {name: 'NotAllowedError'});};
  const blocked = await f.bridge({method: 'resume'});
  assert.deepEqual(JSON.parse(JSON.stringify(blocked)), {ok: false, code: 'needs-user-interaction'});
  assert.equal(JSON.stringify(blocked).includes('fixture-sensitive-value'), false);
  assert.equal(f.sensitiveReads(), 0);
});

test('website playback while initially muted is never reported as controlled or audible Apple source', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  f.music.isPlaying = true; f.music.playbackState = 2; f.music.nowPlayingItem = fixtureSong();
  const state = await service.getState();
  assert.equal(state.state, 'muted'); assert.equal(state.controlled, false); assert.equal(state.authorizedAudio, false);
  assert.equal(service.status().controlled, false); assert.equal(state.fullSongVerified, false);
  await service.close();
});

test('selected song readback, real metadata and controls are separate from full-song/DAC claims', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  await service.search({term: 'Fixture'});
  const state = await service.play({id: 'fixture-song-1', kind: 'songs'});
  assert.equal(state.state, 'playing'); assert.equal(state.currentTrackId, 'fixture-song-1'); assert.equal(state.controlled, true);
  assert.equal(state.fullSongVerified, false); assert.equal(state.audio.actualDacRate, null); assert.equal(state.audio.exclusive, null);
  assert.equal(service.status().verification.selectedPlaybackReadback, true);
  assert.equal(service.status().verification.subscriptionFullSong, false);
  assert.equal(service.status().capabilities.exclusiveOutput, false);
  assert.equal(service.status().capabilities.outputSelection, false);
  assert.equal(service.status().capabilities.pcmAccess, false);
  assert.deepEqual(service.status().audioOutput, {path: 'webview2-system', mode: 'shared', exclusiveSupported: false,
    bitPerfectVerified: false, reasonCode: 'official-web-no-pcm-output'});
  assert.equal((await service.pause()).state, 'paused');
  assert.equal((await service.resume()).state, 'playing');
  assert.ok(Math.abs((await service.seek(42)).position - 42) <= 0.5);
  assert.equal((await service.setVolume(0.3)).volume, 0.3);
  assert.equal(f.sensitiveReads(), 0); await service.close();
});

test('void MusicKit play waits for delayed public playing state before the native audio gate reply', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f);
  await service.initialize(); await service.authorize();
  f.music.play = () => {
    f.calls.push(['play']);
    setTimeout(() => {f.music.isPlaying = true; f.music.playbackState = 2;}, 15);
    // Apple's documented play() returns void, not a ready-to-play Promise.
  };
  const result = await service.play({id: 'fixture-song-1'});
  assert.equal(result.state, 'playing'); assert.equal(result.outputMuted, false);
  assert.equal(result.currentTrackId, 'fixture-song-1'); assert.equal(f.host.closeCalls, 0);
  await service.pause();
  assert.equal((await service.resume()).state, 'playing');
  assert.equal(f.sensitiveReads(), 0); await service.close();
});

test('login completed inside the existing official window refreshes before library and play authorization checks', async () => {
  const f = fixture(), service = serviceFor(f); await service.initialize(); await service.authorize();
  f.music.isAuthorized = true;
  const library = await service.library({kind: 'songs'});
  assert.equal(library.items.length, 1); assert.equal(service.status().configured, true);
  f.music.isAuthorized = false; await service.getState(); f.music.isAuthorized = true;
  assert.equal((await service.play({id: 'fixture-song-1'})).state, 'playing');
  assert.equal(f.host.startCalls.length, 1); assert.equal(f.sensitiveReads(), 0); await service.close();
});

test('bridge waits for the selected item and cancellation fences delayed void playback', async () => {
  const f = fixture({authorized: true});
  f.music.setQueue = () => {f.music.nowPlayingItem = fixtureSong('fixture-old');};
  f.music.isPlaying = true;
  const starting = f.bridge({method: 'play', id: 'fixture-song-1'});
  let finished = false; starting.then(() => {finished = true;});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(finished, false, 'An old playing item cannot open the selected item gate');
  await f.bridge({method: 'cancel'});
  const result = await starting;
  assert.equal(result.ok, false); assert.equal(result.code, 'cancelled'); assert.equal(f.sensitiveReads(), 0);
});

test('bridge bounds a void playback that never enters playing state without claiming success', async () => {
  const f = fixture({authorized: true}); f.music.play = () => {};
  let clock = 0, polls = 0;
  const context = {location: {origin: 'https://music.apple.com'}, URLSearchParams, URL,
    Date: {now: () => clock}, setTimeout(callback, duration) {clock += duration; polls++; queueMicrotask(callback);},
    MusicKit: {getInstance: () => f.music}};
  context.window = context; context.top = context;
  const bridge = vm.runInNewContext(bridgeSource, context);
  const result = await bridge({method: 'play', id: 'fixture-song-1'});
  assert.equal(result.ok, false); assert.equal(result.code, 'official-track-unconfirmed');
  assert.equal(clock, 8000); assert.equal(polls, 160); assert.equal(f.sensitiveReads(), 0);
});

test('pause, stop and a new play invalidate an older bridge playing wait', async () => {
  for (const method of ['pause', 'stop', 'play']) {
    const f = fixture({authorized: true}); f.music.play = () => {};
    const old = f.bridge({method: 'play', id: 'fixture-song-1'});
    await new Promise(resolve => setImmediate(resolve));
    if (method === 'play') f.music.play = () => {f.music.isPlaying = true; f.music.playbackState = 2;};
    const newer = await f.bridge({method, ...(method === 'play' ? {id: 'fixture-song-2'} : {})});
    assert.equal(newer.ok, true);
    assert.equal((await old).code, 'cancelled', method);
    if (method === 'play') assert.equal(newer.value.currentTrackId, 'fixture-song-2');
    else assert.equal(f.music.isPlaying, false);
    assert.equal(f.sensitiveReads(), 0);
  }
});

test('library readback never borrows the requested catalog ID when its observed mapping is missing, wrong or not a library resource', async () => {
  for (const variant of ['wrong-catalog', 'missing-catalog', 'not-library']) {
    const f = fixture({authorized: true}), requested = '1450000001';
    f.music.setQueue = value => {
      f.calls.push(['setQueue', value]);
      f.music.nowPlayingItem = {...fixtureSong('i.fixtureReadback', {name: requested,
        playParams: {id: 'i.fixtureReadback', kind: 'song', ...(variant === 'missing-catalog' ? {} : {catalogId: variant === 'wrong-catalog' ? '1450000002' : requested})}}),
        type: variant === 'not-library' ? 'songs' : 'library-songs'};
    };
    let clock = 0;
    const context = {location: {origin: 'https://music.apple.com'}, URLSearchParams, URL,
      Date: {now: () => clock}, setTimeout(callback, duration) {clock += duration; queueMicrotask(callback);}, MusicKit: {getInstance: () => f.music}};
    context.window = context; context.top = context;
    const bridge = vm.runInNewContext(bridgeSource, context);
    const result = await bridge({method: 'play', id: requested, kind: 'songs'});
    const unmute = result.ok && result.value.isPlaying && result.value.currentTrackId === requested;
    assert.equal(result.ok, false, variant); assert.equal(result.code, 'official-track-unconfirmed', variant);
    assert.equal(unmute, false); assert.equal(clock, 8000);
    assert.equal((await bridge({method: 'state'})).value.currentTrack.id, 'i.fixtureReadback');
    assert.equal(f.sensitiveReads(), 0);
  }
});

test('generic public MediaItems require strict song library flags and a valid observed catalog mapping', async () => {
  const requested = '1450000001';
  const base = {id: 'i.fixtureGeneric', kind: 'song', isLibrary: true, catalogId: requested};
  const cases = [
    {name: 'false isLibrary', params: {...base, isLibrary: false}},
    {name: 'missing isLibrary', params: {id: base.id, kind: base.kind, catalogId: requested}},
    {name: 'truthy isLibrary', params: {...base, isLibrary: 'true'}},
    {name: 'wrong public kind', params: {...base, kind: 'album'}},
    {name: 'missing public kind', params: {id: base.id, isLibrary: true, catalogId: requested}},
    {name: 'invalid catalog path', params: {...base, catalogId: '../invalid'}},
    {name: 'numeric catalog', params: {...base, catalogId: 1450000001}},
    {name: 'missing catalog', params: {id: base.id, isLibrary: true, kind: 'song'}},
    {name: 'wrong observed catalog', params: {...base, catalogId: '1450000002'}},
    {name: 'album resource', type: 'albums', params: base},
    {name: 'library album resource', type: 'library-albums', params: base},
    {name: 'unknown non-song resource', type: 'music-videos', params: base},
  ];
  for (const value of cases) {
    const f = fixture({authorized: true}); let clock = 0;
    const current = {...fixtureSong(base.id, {name: requested, playParams: value.params}), type: value.type || 'songs'};
    f.music.nowPlayingItem = current; f.music.isPlaying = true; f.music.setQueue = () => {};
    const context = {location: {origin: 'https://music.apple.com'}, URLSearchParams, URL,
      Date: {now: () => clock}, setTimeout(callback, duration) {clock += duration; queueMicrotask(callback);}, MusicKit: {getInstance: () => f.music}};
    context.window = context; context.top = context;
    const bridge = vm.runInNewContext(bridgeSource, context);
    const initial = (await bridge({method: 'state'})).value;
    assert.equal(initial.currentTrack.id, base.id, value.name); assert.notEqual(initial.currentTrackId, requested, value.name);
    const result = await bridge({method: 'play', kind: 'songs', id: requested});
    assert.equal(result.ok, false, value.name); assert.equal(result.code, 'official-track-unconfirmed', value.name);
    assert.equal(result.ok && result.value.isPlaying && result.value.currentTrackId === requested, false, value.name);
    assert.equal(clock, 8000); assert.equal(f.sensitiveReads(), 0);
  }
});

test('Node revalidates the normalized library catalog mapping and ignores arbitrary raw canonical IDs', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f), requested = '1450000001';
  await service.initialize(); await service.authorize();
  const request = f.host.request;
  for (const catalogId of ['../invalid', 1450000001, null, false, '1450000002']) {
    f.host.request = async (method, data) => {
      const result = await request(method, data);
      if (method === 'probe') {
        result.state.currentTrack = {id: 'i.fixtureNode', type: 'library-songs', title: requested, catalogId, playable: true};
        result.state.currentTrackId = requested;
      }
      return result;
    };
    const value = await service.getState();
    assert.equal(value.currentTrack.id, 'i.fixtureNode'); assert.notEqual(value.currentTrackId, requested);
    assert.equal(value.currentTrackId, catalogId === '1450000002' ? catalogId : 'i.fixtureNode');
  }
  assert.equal(f.sensitiveReads(), 0); f.host.request = request; await service.close();
});

test('public artwork is allowlisted, dimension bounded and exposed through opaque local URLs only', async () => {
  const f = fixture({authorized: true}), seen = [];
  const remote = 'https://is1-ssl.mzstatic.com/image/thumb/Music221/v4/fixture/cover/{w}x{h}bb.jpg';
  const local = `still-apple-art://art/${'a'.repeat(64)}`;
  const request = f.music.api.music;
  f.music.api.music = async endpoint => {
    const response = await request(endpoint);
    if (response.data.results) response.data.results.songs.data[0].attributes.artwork = {url: remote};
    else response.data.data[0].attributes.artwork = {url: remote};
    return response;
  };
  const service = serviceFor(f, {artworkUrlFor: url => {seen.push(url); return local;}});
  await service.initialize(); await service.authorize();
  const results = await service.search({term: 'Fixture'});
  assert.equal(results.items[0].coverUrl, local);
  assert.equal((await service.library()).items[0].coverUrl, local);
  f.music.nowPlayingItem = fixtureSong('fixture-song-1', {artwork: {url: remote}});
  f.music.queue.items = [f.music.nowPlayingItem];
  assert.equal((await service.getState()).currentTrack.coverUrl, local);
  assert.equal((await service.getQueue()).items[0].coverUrl, local);
  assert.ok(seen.length >= 4);
  assert.ok(seen.every(url => url === remote.replace('{w}', '512').replace('{h}', '512')));
  assert.equal(JSON.stringify(results).includes('mzstatic.com'), false);
  assert.equal(f.sensitiveReads(), 0); await service.close();
});

test('artwork rejects remote URL escapes at both page and Node boundaries and fails closed without a resolver', async () => {
  const f = fixture({authorized: true}), seen = [];
  const valid = 'https://is5-ssl.mzstatic.com/image/thumb/Music/v4/fixture/512x512bb.png';
  const invalid = [
    valid.replace('https:', 'http:'), valid.replace('is5-ssl.mzstatic.com', 'is5-ssl.mzstatic.com.evil.example'),
    valid.replace('is5-ssl', 'is6-ssl'), valid.replace('is5-ssl.mzstatic.com', '127.0.0.1'),
    valid.replace('https://', 'https://fixture-user@'), valid.replace('.com/', '.com:444/'),
    `${valid}?fixture=secret`, `${valid}#fixture`, valid.replace('/image/thumb/', '/other/'),
    valid.replace('512x512', '8192x8192'), valid.replace('.png', '.svg'),
    valid.replace('/v4/', '/%2e%2e/'), valid.replace('/v4/', '/../'), valid.replace('/image/', '/image\\'),
  ];
  const service = serviceFor(f, {artworkUrlFor: url => {seen.push(url); return `still-apple-art://art/${'b'.repeat(64)}`;}});
  await service.initialize(); await service.authorize();
  for (const url of invalid) {
    f.music.nowPlayingItem = fixtureSong('fixture-song-1', {artwork: {url}});
    assert.equal((await f.bridge({method: 'state'})).value.currentTrack.coverUrl, '', url);
  }
  const request = f.host.request;
  for (const url of invalid) {
    f.host.request = async (method, data) => {
      const result = await request(method, data);
      if (method === 'probe') result.state.currentTrack.coverUrl = url;
      return result;
    };
    assert.equal((await service.getState()).currentTrack.coverUrl, '', url);
  }
  assert.deepEqual(seen, []); f.host.request = request; await service.close();
  for (const resolver of [undefined, () => valid, () => 'still-apple-art://art/invalid', () => {throw new Error('fixture-only');}]) {
    const next = fixture({authorized: true}), serviceValue = serviceFor(next, {artworkUrlFor: resolver});
    await serviceValue.initialize(); await serviceValue.authorize();
    next.music.nowPlayingItem = fixtureSong('fixture-song-1', {artwork: {url: valid}});
    assert.equal((await serviceValue.getState()).currentTrack.coverUrl, ''); await serviceValue.close();
  }
});

test('safe operation diagnostics retain filtered failure after background probes without leaking inputs', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f);
  await service.initialize(); await service.authorize();
  assert.equal(service.status().lastOperation, null);
  assert.deepEqual(service.status().methodSupport, {play: true, pause: true, stop: true, next: true,
    previous: true, seek: true, setQueue: true, apiMusic: true, queue: true, volume: true, albumPlayback: false, order: false});
  const mutable = service.status().methodSupport; mutable.play = false; assert.equal(service.status().methodSupport.play, true);
  f.music.api.music = async () => {throw new Error('fixture-secret-error-and-input');};
  await assert.rejects(service.search({term: 'fixture-private-query'}), {code: 'official-operation-failed'});
  await service.getState();
  assert.deepEqual(service.status().lastOperation, {method: 'search', stage: 'failed', code: 'official-operation-failed', failedFromStage: 'dispatch'});
  const serialized = JSON.stringify(service.status());
  assert.equal(serialized.includes('fixture-secret'), false); assert.equal(serialized.includes('fixture-private'), false);
  await service.play({id: 'fixture-song-1'});
  assert.deepEqual(service.status().lastOperation, {method: 'play', stage: 'complete', code: null, kind: 'songs', id: 'fixture-song-1'});
  assert.equal(f.sensitiveReads(), 0); await service.close();
});

test('unavailable state exposes a fixed safe error code without native raw failures', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  f.host.request = async () => {throw new Error('fixture-private-error');};
  const state = await service.getState();
  assert.equal(state.state, 'unavailable'); assert.equal(state.errorCode, 'official-operation-failed');
  assert.equal(JSON.stringify(state).includes('fixture-private-error'), false); await service.close();
});

test('a delayed authorization probe for an older play cannot supersede a newer selected song', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f), entered = deferred(), release = deferred();
  await service.initialize(); await service.authorize();
  const request = f.host.request; let hold = true;
  f.host.request = async (method, data) => {
    if (method === 'probe' && hold) {hold = false; entered.resolve(); await release.promise;}
    return request(method, data);
  };
  const older = service.play({id: 'fixture-song-1'}); older.catch(() => {}); await entered.promise;
  assert.equal((await service.play({id: 'fixture-song-2'})).currentTrackId, 'fixture-song-2');
  release.resolve(); await assert.rejects(older, {code: 'STILL_CANCELLED'});
  assert.equal(f.calls.filter(call => call[0] === 'setQueue').length, 1);
  assert.equal((await service.getState()).currentTrackId, 'fixture-song-2');
  assert.deepEqual(service.status().lastOperation, {method: 'play', stage: 'complete', code: null, kind: 'songs', id: 'fixture-song-2'});
  assert.equal(f.host.closeCalls, 0); await service.close();
});

test('library song playback requires a catalog mapping actually read from the authorized library', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  await assert.rejects(service.play({id: 'fixture-library-1', kind: 'library-songs'}), {code: 'unsupported-item'});
  const library = await service.library({kind: 'songs'});
  assert.equal(library.items[0].catalogId, 'fixture-song-1');
  const state = await service.play({id: 'fixture-library-1', kind: 'library-songs'});
  assert.equal(state.currentTrackId, 'fixture-song-1');
  assert.deepEqual(Array.from(f.calls.find(call => call[0] === 'setQueue')[1].songs), ['fixture-song-1']);
  const details = await service.library({kind: 'playlist-songs', id: 'fixture-playlist'});
  assert.equal(details.items.length, 1);
  await service.close();
});

test('metadata lookup returns cloned current or browsed song fields synchronously without requests or URL exposure', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize();
  assert.equal(service.lookupMetadata({id: 'fixture-song-1'}), null); assert.equal(f.host.startCalls.length, 0);
  await service.authorize();
  const browsed = await service.search({term: 'Fixture'}); browsed.items[0].title = 'Changed by caller';
  const first = service.lookupMetadata({id: 'fixture-song-1'});
  assert.deepEqual(first, {id: 'fixture-song-1', type: 'songs', source: 'apple', title: 'Fixture fixture-song-1',
    artist: 'Synthetic artist', album: 'Synthetic album', duration: 240});
  first.title = 'Changed by lookup caller';
  assert.equal(service.lookupMetadata({id: 'fixture-song-1'}).title, 'Fixture fixture-song-1');
  f.music.nowPlayingItem = fixtureSong('fixture-current-only');
  const readback = await service.getState(); readback.currentTrack.title = 'Changed readback';
  const requests = f.requests.length, starts = f.host.startCalls.length, hostRequest = f.host.request;
  f.host.request = async () => {throw new Error('Metadata lookup must not request a host');};
  const current = service.lookupMetadata({id: 'fixture-current-only'});
  assert.equal(current.title, 'Fixture fixture-current-only'); assert.equal(current instanceof Promise, false);
  assert.deepEqual(Object.keys(current), ['id', 'type', 'source', 'title', 'artist', 'album', 'duration']);
  for (const input of [null, {}, {id: '../invalid'}, {id: 'fixture-current-only', kind: 'albums'},
    {id: 'fixture-current-only', kind: 'library-songs'}, {id: 'fixture-unseen'}]) assert.equal(service.lookupMetadata(input), null);
  assert.equal(f.requests.length, requests); assert.equal(f.host.startCalls.length, starts); assert.equal(f.sensitiveReads(), 0);
  f.host.request = hostRequest; await service.close(); assert.equal(service.lookupMetadata({id: 'fixture-song-1'}), null);
});

test('metadata catalog aliases require unique actually-read library mappings and preserve exact type identity', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  let rows = [{...fixtureSong('i.fixtureOne', {name: 'Observed library title', playParams: {id: 'i.fixtureOne', catalogId: '1450000001'}}), type: 'library-songs'}];
  f.music.api.music = async () => ({data: {data: rows}});
  const browsed = await service.library();
  browsed.items[0].catalogId = '1450000009'; browsed.items[0].title = 'Caller mutation';
  assert.equal(service.lookupMetadata({id: 'i.fixtureOne', kind: 'library-songs'}).title, 'Observed library title');
  assert.equal(service.lookupMetadata({id: '1450000001'}).title, 'Observed library title');
  assert.equal(service.lookupMetadata({id: '1450000009'}), null);
  assert.equal(service.lookupMetadata({id: 'i.fixtureOne'}), null, 'A library-looking string is never guessed to be a catalog mapping');
  rows = [{...fixtureSong('i.fixtureTwo', {playParams: {id: 'i.fixtureTwo', catalogId: '1450000001'}}), type: 'library-songs'},
    {...fixtureSong('i.fixtureNoCatalog', {playParams: {id: 'i.fixtureNoCatalog'}}), type: 'library-songs'},
    {...fixtureSong('i.fixtureOne', {name: 'Album is not a song', playParams: {catalogId: '1450000002'}}), type: 'library-albums'}];
  await service.library();
  assert.equal(service.lookupMetadata({id: '1450000001'}), null, 'Two observed library IDs for a catalog alias are ambiguous');
  assert.equal(service.lookupMetadata({id: '1450000002'}), null, 'Album mappings do not create song aliases');
  assert.equal(service.lookupMetadata({id: 'i.fixtureOne', kind: 'library-songs'}).title, 'Observed library title');
  assert.equal(service.lookupMetadata({id: 'i.fixtureNoCatalog', kind: 'library-songs'}).type, 'library-songs');
  assert.equal(f.sensitiveReads(), 0); await service.close();
});

test('canceling an unfinished SDK setQueue disposes its owned context and prevents late play', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  const gate = f.gateSetQueue(); const playing = service.play({id: 'fixture-song-1'}); playing.catch(() => {});
  await gate.entered.promise;
  const barrier = service.cancelPending(); await barrier;
  await assert.rejects(playing, {code: 'STILL_CANCELLED'});
  gate.resume.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call[0] === 'play').length, 0);
  assert.equal(f.host.isRunning(), false); assert.equal(service.status().controlled, false);
  await service.close();
});

test('releaseOutput requires owned browser and helper exit, not a stopped/paused/muted status alone', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  const release = await service.releaseOutput();
  assert.equal(release.released, true); assert.equal(release.evidence.ownedBrowserProcessExited, true);
  assert.equal(release.evidence.ownedHelperExited, true); assert.equal(release.evidence.actualDacRate, null);
  await service.close();
  const unverified = fixture({authorized: true});
  unverified.host.close = async () => ({closed: true, helperExited: true, browserProcessExited: false});
  const blocked = serviceFor(unverified); await blocked.initialize(); await blocked.authorize();
  assert.equal((await blocked.releaseOutput()).released, false); await blocked.close();
});

test('releaseOutput external cancellation refuses before any owned-host close', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  const controller = new AbortController(); controller.abort(); const closes = f.host.closeCalls;
  await assert.rejects(service.releaseOutput({signal: controller.signal}), {code: 'STILL_CANCELLED'});
  assert.equal(f.host.closeCalls, closes); await service.close();
});

test('releaseOutput bridges timer abort while its old-write barrier is pending and cannot close a replacement host', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  const gate = deferred(), entered = deferred(), original = f.host.cancelPending.bind(f.host); let calls = 0;
  f.host.cancelPending = () => {const result = original(); calls++; if (calls === 1) {entered.resolve(); return gate.promise;} return result;};
  const controller = new AbortController(), closes = f.host.closeCalls;
  const release = service.releaseOutput({signal: controller.signal}), rejected = assert.rejects(release, {code: 'STILL_CANCELLED'});
  await entered.promise; controller.abort(); gate.resolve(); await rejected;
  assert.ok(calls >= 2); assert.equal(f.host.closeCalls, closes); await service.close();
});

test('releaseOutput rechecks the same external context after the barrier before closing the owned host', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  const gate = deferred(), original = f.host.cancelPending.bind(f.host); let current = true, once = true;
  f.host.cancelPending = () => {const result = original(); if (once) {once = false; return gate.promise;} return result;};
  const closes = f.host.closeCalls, release = service.releaseOutput({check() {if (!current) throw Object.assign(new Error('changed'), {code: 'STILL_CONTEXT_CHANGED'});}});
  const rejected = assert.rejects(release, {code: 'STILL_CONTEXT_CHANGED'}); current = false; gate.resolve(); await rejected;
  assert.equal(f.host.closeCalls, closes); await service.close();
});

test('safe Apple independent release receives the original operation signal and rejects a late positive after cancellation', async () => {
  const f = fixture({authorized: true}), entered = deferred(), gate = deferred(), controller = new AbortController();
  const context = {signal: controller.signal, check() {if (controller.signal.aborted) throw Object.assign(new Error('Synthetic cancelled'), {code: 'STILL_CANCELLED'});}};
  const service = serviceFor(f, {verifyOutputReleased: async args => {
    assert.equal(args.context, context); assert.equal(args.signal, controller.signal); args.check(); entered.resolve();
    await gate.promise; return {released: true, evidence: {synthetic: true}};
  }});
  await service.initialize(); await service.authorize(); f.setCloseMode('unconfirmed');
  const released = service.releaseOutput(context), rejected = assert.rejects(released, {code: 'STILL_CANCELLED'});
  await entered.promise; controller.abort(); gate.resolve(); await rejected; await service.close();
});

test('missing host/runtime and invalid IDs/ranges fail with explicit safe state', async () => {
  const f = fixture(), absent = serviceFor(f, {hostPath: path.join(__dirname, 'does-not-exist.exe')});
  assert.equal((await absent.initialize()).reasonCodes[0], 'official-host-missing');
  await assert.rejects(absent.authorize(), {code: 'official-host-missing'}); await absent.close();
  const f2 = fixture({authorized: true}), service = serviceFor(f2); await service.initialize(); await service.authorize();
  await assert.rejects(service.play({id: undefined}), {code: 'invalid-item'});
  await assert.rejects(service.play({id: '../invalid'}), {code: 'invalid-item'});
  await assert.rejects(service.play({id: 'fixture-song-1', ids: ['fixture-song-1', 'fixture-song-2']}), {code: 'invalid-item'});
  await assert.rejects(service.library({kind: 'album-songs'}), {code: 'invalid-item'});
  assert.throws(() => service.seek(-1), {code: 'invalid-input'});
  assert.throws(() => service.setVolume(2), {code: 'invalid-input'});
  await service.close();
});

test('native transport rejects non-whitelisted method names before starting a process', async () => {
  const host = createNativeOfficialHost({hostPath: __filename, profileDir: path.join(__dirname, 'never-created')});
  await assert.rejects(host.request('eval', {code: 'fixture'}), {code: 'invalid-input'});
  assert.equal(host.isRunning(), false);
});

test('injected native transport wire keeps rpcId separate from content id, including a play and detail request', async t => {
  const profileDir = path.join(__dirname, 'fixture-apple-wire-profile-not-written');
  const f = fixture({authorized: true}), wire = [];
  function spawnFixture() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    const output = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.stdin = new Writable({write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        const command = JSON.parse(line); wire.push(command);
        queueMicrotask(async () => {
          if (command.method === 'close') {
            output({type: 'response', rpcId: command.rpcId, ok: true, value: {closed: true, browserProcessExited: true}});
            child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('close', 0); return;
          }
          const result = await f.bridge(command);
          output({type: 'response', rpcId: command.rpcId, ...result});
        });
      }
      callback();
    }});
    child.kill = () => {child.exitCode = 1; child.emit('close', 1); return true;};
    queueMicrotask(() => output({type: 'ready', origin: 'https://music.apple.com', runtime: 'fixture-native-wire'}));
    return child;
  }
  const host = createNativeOfficialHost({hostPath: __filename, profileDir, spawnImpl: spawnFixture, mkdirImpl: async () => {}});
  t.after(() => host.close());
  await host.start();
  const playing = await host.request('play', {id: 'fixture-song-1', kind: 'songs'});
  assert.equal(playing.currentTrackId, 'fixture-song-1');
  const details = await host.request('library', {kind: 'playlist-songs', id: 'fixture-playlist', limit: 1, offset: 0});
  assert.equal(details.items.length, 1);
  for (const command of wire.filter(command => ['play', 'library'].includes(command.method))) {
    assert.equal(typeof command.rpcId, 'number'); assert.equal(typeof command.id, 'string'); assert.notEqual(command.id, command.rpcId);
  }
  assert.equal(f.sensitiveReads(), 0);
});

test('i.* library selection verifies catalog and typed or generic library MediaItems over the real NativeHost wire', async t => {
  for (const readbackType of ['catalog', 'library-songs', 'songs', 'song', undefined]) await t.test(
    readbackType === 'catalog' ? 'catalog MediaItem' : `delayed i.* library flags with type ${readbackType || 'missing'}`, async t => {
  const libraryReadback = readbackType !== 'catalog';
  const f = fixture({authorized: true}), wire = [], libraryId = 'i.fixtureLibrarySong', catalogId = '1450000001';
  let playTimer, unmuteCount = 0;
  f.music.api.music = async endpoint => {
    if (endpoint === '/v1/me/library/albums/l.fixtureAlbum/catalog') return {data: {data: []}};
    assert.match(endpoint, /^\/v1\/me\/library\/albums\/l.fixtureAlbum\/tracks\?/);
    return {data: {data: [{...fixtureSong(libraryId, {name: 'Observed library song',
      playParams: {id: libraryId, kind: 'song', isLibrary: true, catalogId}}), type: 'library-songs'}]}};
  };
  if (libraryReadback) {
    f.music.setQueue = value => {
      f.calls.push(['setQueue', value]);
      f.music.nowPlayingItem = fixtureSong(libraryId, {playParams: {id: libraryId, kind: 'song', isLibrary: true, catalogId}});
      if (readbackType === undefined) delete f.music.nowPlayingItem.type;
      else f.music.nowPlayingItem.type = readbackType;
      f.music.queue.items = [f.music.nowPlayingItem]; f.music.currentPlaybackDuration = 240;
    };
    f.music.play = () => {f.calls.push(['play']); playTimer = setTimeout(() => {f.music.isPlaying = true; f.music.playbackState = 2;}, 15);};
  }
  function spawnFixture() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    let muted = true;
    const output = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.stdin = new Writable({write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        const command = JSON.parse(line); wire.push(command);
        queueMicrotask(async () => {
          if (command.method === 'close') {
            clearTimeout(playTimer); await f.bridge({method: 'cancel'}); f.music.isPlaying = false;
            output({type: 'response', rpcId: command.rpcId, ok: true, value: {closed: true, browserProcessExited: true}});
            child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('close', 0); return;
          }
          if (command.method === 'probe' && f.music.isPlaying) f.music.currentPlaybackTime += 0.1;
          if (command.method === 'play') muted = true;
          const result = await f.bridge(command);
          if (child.exitCode !== null) return; // A disposed synthetic browser cannot deliver a late page response.
          if (command.method === 'play' && result.ok) {muted = !(result.value.isPlaying && result.value.currentTrackId === command.id); if (!muted) unmuteCount++;}
          if (result.value) result.value.outputMuted = muted;
          output({type: 'response', rpcId: command.rpcId, ...result});
        });
      }
      callback();
    }});
    child.kill = () => {child.exitCode = 1; child.emit('close', 1); return true;};
    queueMicrotask(() => output({type: 'ready', origin: 'https://music.apple.com', runtime: 'fixture-library-wire'})); return child;
  }
  const host = createNativeOfficialHost({hostPath: __filename, profileDir: path.join(os.tmpdir(), 'fixture-no-files-written'),
    spawnImpl: spawnFixture, mkdirImpl: async () => {}});
  const service = createOfficialAppleMusicService({dataDir: path.join(__dirname, 'fixture-data-not-written'), hostPath: __filename,
    hostFactory: () => host, runtimeDetector: async () => 'fixture-library-wire', verificationTimeout: 100, pollInterval: 2});
  t.after(() => service.close()); await service.initialize(); await service.authorize();
  await assert.rejects(service.play({id: libraryId, kind: 'library-songs'}), {code: 'unsupported-item'});
  assert.equal(service.status().lastOperation.id, libraryId); assert.equal(service.status().lastOperation.code, 'unsupported-item');
  const details = await service.library({kind: 'album-songs', id: 'l.fixtureAlbum'});
  assert.equal(details.albumPlayback, false); assert.equal(details.items[0].id, libraryId); assert.equal(details.items[0].catalogId, catalogId);
  const result = await service.play({id: libraryId, kind: 'library-songs'});
  assert.equal(result.currentTrackId, catalogId); assert.equal(result.currentTrack.type, libraryReadback ? 'library-songs' : 'songs');
  assert.equal(result.currentTrack.id, libraryReadback ? libraryId : catalogId);
  assert.equal(result.outputMuted, false); assert.equal(service.status().verification.selectedPlaybackReadback, true);
  const command = wire.find(value => value.method === 'play');
  assert.equal(command.id, catalogId); assert.equal(command.kind, 'songs'); assert.equal(typeof command.rpcId, 'number');
  assert.deepEqual(Array.from(f.calls.find(value => value[0] === 'setQueue')[1].songs), [catalogId]);
  assert.deepEqual(service.status().lastOperation, {method: 'play', stage: 'complete', code: null, kind: 'library-songs', id: libraryId});
  if (libraryReadback) {
    const previousUnmutes = unmuteCount;
    f.music.isPlaying = false; f.music.playbackState = 3;
    const pending = service.play({id: libraryId, kind: 'library-songs'}); pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve)); await service.cancelPending();
    await assert.rejects(pending, {code: 'STILL_CANCELLED'});
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(unmuteCount, previousUnmutes, 'A late library reply after session cancellation cannot open the gate');
    assert.equal(host.isRunning(), false);
  }
  assert.equal(f.sensitiveReads(), 0);
  });
});

test('opt-in compiled native protocol self-test checks the real C# audio gate before unmuting', {
  skip: !integrationEnabled && 'Requires STILL_TEST_INTEGRATION=1 and STILL_TEST_INTEGRATION_SUITE=apple-host-protocol'
}, t => {
  const executable = path.join(__dirname, '..', 'native', 'apple-host', 'bin', 'StillAppleHost.exe');
  if (process.platform !== 'win32' || !fs.existsSync(executable)) return t.skip('Windows compiled native host unavailable');
  const result = spawnSync(executable, ['--protocol-self-test'], {encoding: 'utf8', windowsHide: true, timeout: 10000});
  assert.equal(result.status, 0, 'Native C# protocol regression failed');
  const value = JSON.parse(result.stdout.trim());
  assert.equal(value.fixtureOnly, true); assert.equal(value.rpcSeparated, true);
  assert.equal(value.oldItemRemainsMuted, true); assert.equal(value.nonPlayingItemRemainsMuted, true); assert.equal(value.selectedPlayingItemCanUnmute, true);
  assert.equal(value.staleStartRetirementPassed, true); assert.equal(value.readOnlyPreservesGate, true);
  assert.equal(value.nativeReadyGatePassed, true);
  assert.equal(value.autoplayPolicyPassed, true); assert.ok(Object.keys(value.autoplayPolicyChecks).length >= 18);
  assert.equal(Object.values(value.autoplayPolicyChecks).every(Boolean), true);
  assert.deepEqual(value.staleStartRetirement, {pause: true, stop: true, cancel: true, play: true, resume: true, close: true});
});

function lifecycleSpawnFixture({readyGate} = {}) {
  const children = [], spawned = deferred();
  function spawnImpl() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; children.push(child);
    const output = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.stdin = new Writable({write(chunk, _encoding, callback) {
      const command = JSON.parse(String(chunk));
      queueMicrotask(() => {
        if (command.method === 'close') {
          output({type: 'response', rpcId: command.rpcId, ok: true, value: {closed: true, browserProcessExited: true}});
          child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('close', 0);
        } else output({type: 'response', rpcId: command.rpcId, ok: true, value: {shown: true}});
      }); callback();
    }});
    child.kill = () => {child.exitCode = 1; child.emit('close', 1); return true;};
    Promise.resolve(readyGate).then(() => {if (child.exitCode === null) output({type: 'ready', origin: 'https://music.apple.com', runtime: 'fixture-lifecycle'});});
    spawned.resolve(); return child;
  }
  return {spawnImpl, children, spawned, unclosed: () => children.filter(child => child.exitCode === null).length};
}

test('native start is singleflight across its asynchronous profile preparation', async () => {
  const fixtureValue = lifecycleSpawnFixture(), entered = deferred(), release = deferred();
  const host = createNativeOfficialHost({hostPath: __filename, profileDir: path.join(os.tmpdir(), 'fixture-no-files-created'), spawnImpl: fixtureValue.spawnImpl,
    mkdirImpl: async () => {entered.resolve(); await release.promise;}});
  const first = host.start({show: true}), second = host.start({show: true});
  await entered.promise; assert.equal(fixtureValue.children.length, 0); release.resolve();
  await Promise.all([first, second]); assert.equal(fixtureValue.children.length, 1);
  await host.close(); assert.equal(fixtureValue.unclosed(), 0);
});

test('close racing a profile-delayed start fences spawning and does not leak an owned helper', async () => {
  const fixtureValue = lifecycleSpawnFixture(), entered = deferred(), release = deferred();
  const host = createNativeOfficialHost({hostPath: __filename, profileDir: path.join(os.tmpdir(), 'fixture-no-files-created'), spawnImpl: fixtureValue.spawnImpl,
    mkdirImpl: async () => {entered.resolve(); await release.promise;}});
  const starting = host.start(); starting.catch(() => {}); await entered.promise;
  const closing = host.close(); release.resolve();
  await assert.rejects(starting, {code: 'STILL_CANCELLED'}); assert.equal((await closing).helperExited, true);
  assert.equal(fixtureValue.children.length, 0); assert.equal(fixtureValue.unclosed(), 0);
  await host.start(); assert.equal(fixtureValue.children.length, 1); await host.close(); assert.equal(fixtureValue.unclosed(), 0);
});

test('close binds to the spawned session even before its official page becomes ready', async () => {
  const ready = deferred(), fixtureValue = lifecycleSpawnFixture({readyGate: ready.promise});
  const host = createNativeOfficialHost({hostPath: __filename, profileDir: path.join(os.tmpdir(), 'fixture-no-files-created'), spawnImpl: fixtureValue.spawnImpl, mkdirImpl: async () => {}});
  const starting = host.start(); starting.catch(() => {}); await fixtureValue.spawned.promise;
  const closed = await host.close(); await assert.rejects(starting, {code: 'STILL_CANCELLED'});
  assert.equal(closed.helperExited, true); assert.equal(fixtureValue.unclosed(), 0);
  ready.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(fixtureValue.children.length, 1);
});

test('frozen progress after native play closes the actual owned session before rejecting verification', async () => {
  const f = fixture({authorized: true, frozenProgress: true}), service = serviceFor(f, {verificationTimeout: 15});
  await service.initialize(); await service.authorize();
  await assert.rejects(service.play({id: 'fixture-song-1'}), {code: 'official-track-unconfirmed'});
  assert.equal(f.calls.filter(call => call[0] === 'play').length, 1, 'Native/SDK start did succeed before verification froze');
  assert.equal(f.host.closeCalls, 1); assert.equal(f.host.isRunning(), false);
  assert.equal(f.music.isPlaying, false); assert.equal((await service.getState()).available, false);
  assert.equal(service.status().audioReleaseUnverified, false);
  await service.close();
});

test('failed cleanup preserves SDK audible state, sticky uncertainty and coordinator output ownership', async () => {
  const f = fixture({authorized: true, frozenProgress: true}); f.setCloseMode('unconfirmed');
  let independentCalls = 0, localStarts = 0;
  const service = serviceFor(f, {verificationTimeout: 15, verifyOutputReleased: async () => {independentCalls++; return {released: true, evidence: 'fixture-only'};}});
  await service.initialize(); await service.authorize();
  const local = {getState: async () => ({available: true, state: 'stopped', position: 0, duration: 0}),
    stop: async () => {}, cancelPending: () => Promise.resolve(), releaseOutput: async () => ({released: true, evidence: 'fixture-only'}), play: async () => {localStarts++;}};
  const coordinator = createPlaybackCoordinator({engines: {local, apple: service}});
  await assert.rejects(coordinator.play({source: 'apple', input: {id: 'fixture-song-1'}}), {code: 'official-audio-cleanup-unverified'});
  assert.equal(f.host.closeCalls, 1); assert.equal(f.host.isRunning(), true); assert.equal(f.music.isPlaying, true); assert.equal(f.outputMuted(), false);
  const state = await service.getState();
  assert.equal(state.state, 'playing'); assert.equal(state.outputMuted, false); assert.equal(state.audible, true);
  assert.equal(state.controlled, false); assert.equal(state.audioReleaseUnverified, true); assert.ok(state.error);
  assert.equal(service.status().capabilities.playback, false);
  f.music.isAuthorized = false;
  const revoked = await service.getState();
  assert.equal(revoked.available, true, 'Lost authorization must not hide physically playing, unmuted audio');
  assert.equal(revoked.state, 'playing'); assert.equal(revoked.audible, true);
  assert.equal((await coordinator.getState()).source, 'apple');
  await assert.rejects(coordinator.play({source: 'local', input: {id: 'fixture-local'}}), {code: 'official-audio-cleanup-unverified'});
  assert.equal(localStarts, 0); assert.equal(independentCalls, 0, 'Endpoint-only evidence must not excuse potentially audible orphaned Apple audio');
  f.setCloseMode('confirmed'); await coordinator.close(); await service.close();
});

test('cleanup without browser-exit proof reports unknown audio when the helper or state read is gone', async () => {
  const f = fixture({authorized: true, frozenProgress: true}); f.setCloseMode('helper-only');
  const service = serviceFor(f, {verificationTimeout: 15}); await service.initialize(); await service.authorize();
  await assert.rejects(service.play({id: 'fixture-song-1'}), {code: 'official-audio-cleanup-unverified'});
  const state = await service.getState();
  assert.equal(state.state, 'unknown'); assert.equal(state.outputMuted, null); assert.equal(state.audible, null); assert.equal(state.mayBeAudible, true);
  assert.equal(state.audioReleaseUnverified, true); assert.ok(state.error);
  assert.equal(state.errorCode, 'official-audio-cleanup-unverified');
  assert.equal((await service.releaseOutput()).released, false);
  f.setCloseMode('confirmed'); await service.close();
});

test('a late old verification failure cannot close or revoke a newer legitimate play', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f); await service.initialize(); await service.authorize();
  const originalRequest = f.host.request.bind(f.host), entered = deferred(), failOld = deferred();
  let holdOld = true;
  f.host.request = async (method, data, timeout) => {
    if (method === 'probe' && holdOld && f.music.nowPlayingItem?.id === 'fixture-song-1') {
      holdOld = false; entered.resolve(); await failOld.promise;
      throw Object.assign(new Error('Synthetic old read failure'), {code: 'official-invalid-response', officialError: true});
    }
    return originalRequest(method, data, timeout);
  };
  const oldPlay = service.play({id: 'fixture-song-1'}); oldPlay.catch(() => {}); await entered.promise;
  // Exercise the adapter's own audio-attempt epoch, independently of the
  // coordinator's cancelPending generation fence.
  const newer = await service.play({id: 'fixture-song-2'});
  assert.equal(newer.state, 'playing'); assert.equal(newer.currentTrackId, 'fixture-song-2');
  failOld.resolve(); await assert.rejects(oldPlay, {code: 'STILL_CANCELLED'});
  const after = await service.getState();
  assert.equal(f.host.closeCalls, 0); assert.equal(f.host.isRunning(), true); assert.equal(f.outputMuted(), false);
  assert.equal(after.currentTrackId, 'fixture-song-2'); assert.equal(after.controlled, true); assert.equal(after.audible, true);
  assert.equal(after.audioReleaseUnverified, false); await service.close();
});

test('native closeSession cannot dispose a newly opened session using an old session handle', async () => {
  const fixtureValue = lifecycleSpawnFixture();
  const host = createNativeOfficialHost({hostPath: __filename, profileDir: path.join(os.tmpdir(), 'fixture-no-files-created'), spawnImpl: fixtureValue.spawnImpl, mkdirImpl: async () => {}});
  await host.start(); const oldSession = host.captureSession(); await host.closeSession(oldSession);
  await host.start(); const newSession = host.captureSession(); assert.notEqual(oldSession, newSession);
  const staleClose = await host.closeSession(oldSession);
  assert.equal(staleClose.sessionChanged, true); assert.equal(host.captureSession(), newSession); assert.equal(fixtureValue.unclosed(), 1);
  await host.closeSession(newSession); assert.equal(fixtureValue.unclosed(), 0);
});

test('a helper lost after verified playback retains unknown audio and blocks reopening or endpoint-only release', async () => {
  const f = fixture({authorized: true}); let independentCalls = 0;
  const service = serviceFor(f, {verifyOutputReleased: async () => {independentCalls++; return {released: true};}});
  await service.initialize(); await service.authorize(); await service.play({id: 'fixture-song-1'});
  f.setCloseMode('helper-only'); await f.host.close(); // Synthetic helper loss; its browser audio survives.
  assert.equal(f.music.isPlaying, true); assert.equal(f.outputMuted(), false);
  const state = await service.getState();
  assert.equal(state.state, 'unknown'); assert.equal(state.audioReleaseUnverified, true);
  assert.equal(state.mayBeAudible, true); assert.equal(state.audible, null);
  assert.equal(service.status().capabilities.playback, false);
  await assert.rejects(service.authorize(), {code: 'official-audio-cleanup-unverified'});
  assert.equal(f.host.startCalls.length, 1);
  assert.equal((await service.releaseOutput()).released, false); assert.equal(independentCalls, 0);
  f.setCloseMode('confirmed'); await service.close();
});

test('a state-read failure after verified playback remains sticky even if the next SDK read succeeds', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f);
  await service.initialize(); await service.authorize(); await service.play({id: 'fixture-song-1'});
  const request = f.host.request.bind(f.host);
  f.host.request = async () => {throw new Error('Synthetic transport failure');};
  const missing = await service.getState();
  assert.equal(missing.state, 'unknown'); assert.equal(missing.audioReleaseUnverified, true); assert.equal(missing.mayBeAudible, true);
  f.host.request = request;
  const recovered = await service.getState();
  assert.equal(recovered.state, 'playing'); assert.equal(recovered.audible, true);
  assert.equal(recovered.audioReleaseUnverified, true); assert.ok(recovered.error);
  await assert.rejects(service.play({id: 'fixture-song-2'}), {code: 'official-audio-cleanup-unverified'});
  await service.close();
});

test('close after verified playback rejects missing exit proof and permits a later proven close', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f);
  await service.initialize(); await service.authorize(); await service.play({id: 'fixture-song-1'});
  f.setCloseMode('unconfirmed');
  await assert.rejects(service.close(), {code: 'official-audio-cleanup-unverified'});
  const after = await service.getState();
  assert.equal(after.state, 'playing'); assert.equal(after.audible, true); assert.equal(after.audioReleaseUnverified, true);
  assert.notEqual(service.status().status, 'unavailable', 'An unproven close must remain retryable, not permanently closed');
  f.setCloseMode('confirmed'); await service.close();
  assert.equal(service.status().audioReleaseUnverified, false);
  assert.equal(service.status().status, 'unavailable');
  await assert.rejects(service.authorize(), {code: 'closed'});
});

test('release after verified playback cannot substitute one endpoint probe for missing browser exit', async () => {
  const f = fixture({authorized: true}); let independentCalls = 0;
  const service = serviceFor(f, {verifyOutputReleased: async () => {independentCalls++; return {released: true};}});
  await service.initialize(); await service.authorize(); await service.play({id: 'fixture-song-1'});
  f.setCloseMode('helper-only');
  assert.equal((await service.releaseOutput()).released, false);
  assert.equal(independentCalls, 0); assert.equal((await service.getState()).mayBeAudible, true);
  f.setCloseMode('confirmed'); await service.close();
});

test('canceling a verified play does not erase browser risk when its helper is subsequently lost', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f);
  await service.initialize(); await service.authorize(); await service.play({id: 'fixture-song-1'});
  await service.cancelPending();
  f.setCloseMode('helper-only'); await f.host.close();
  await assert.rejects(service.stop(), {code: 'official-audio-cleanup-unverified'});
  assert.equal((await service.getState()).mayBeAudible, true);
  assert.equal((await service.releaseOutput()).released, false);
  f.setCloseMode('confirmed'); await service.close();
});

test('a background state-read failure during play verification cannot be upgraded to successful playback', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f);
  await service.initialize(); await service.authorize();
  const gate = f.gateSetQueue(), play = service.play({id: 'fixture-song-1'}); play.catch(() => {});
  await gate.entered.promise;
  const request = f.host.request.bind(f.host);
  f.host.request = async method => {if (method === 'probe') throw new Error('Synthetic background read failure'); return request(method);};
  assert.equal((await service.getState()).audioReleaseUnverified, true);
  f.host.request = request; gate.resume.resolve();
  await assert.rejects(play, {code: 'official-track-unconfirmed'});
  assert.equal(f.host.closeCalls, 1); assert.equal(f.music.isPlaying, false);
  assert.equal(service.status().verification.selectedPlaybackReadback, false);
  assert.equal(service.status().audioReleaseUnverified, false);
  await service.close();
});

test('a background state-read failure during resume verification also closes the dispatched session', async () => {
  const f = fixture({authorized: true}), service = serviceFor(f);
  await service.initialize(); await service.authorize(); await service.play({id: 'fixture-song-1'}); await service.pause();
  const request = f.host.request.bind(f.host), entered = deferred(), release = deferred(); let failProbe = false;
  f.host.request = async (method, data, timeout) => {
    if (method === 'probe' && failProbe) throw new Error('Synthetic background read failure');
    const result = await request(method, data, timeout);
    if (method === 'resume') {entered.resolve(); await release.promise;}
    return result;
  };
  const resume = service.resume(); resume.catch(() => {}); await entered.promise;
  failProbe = true; assert.equal((await service.getState()).audioReleaseUnverified, true);
  failProbe = false; release.resolve();
  await assert.rejects(resume, {code: 'official-operation-failed'});
  assert.equal(f.host.closeCalls, 1); assert.equal(f.music.isPlaying, false);
  assert.equal(service.status().verification.selectedPlaybackReadback, false);
  assert.equal(service.status().audioReleaseUnverified, false);
  await service.close();
});
