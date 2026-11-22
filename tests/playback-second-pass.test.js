'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createFoobarService} = require('../src/main/foobar');
const {createHandlers, createAppleAdapter, invokeSafely} = require('../src/main/ipc-handlers');
const {createPlaybackCoordinator} = require('../src/main/playback-coordinator');
const {createDesktopIntegration} = require('../src/main/desktop-integration');
const {createDesktopPlaybackCallbacks} = require('../src/main/main');
const {DEFAULTS} = require('../src/main/settings');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {createFakeBeefwebHttp} = require('./helpers/fake-beefweb-http');
const {syntheticOfficialAppleHost} = require('./helpers/synthetic-official-apple-host');

const files = ['repeat.flac', 'other.flac', 'repeat.flac', 'last.flac'];
const location = name => ({path: `C:\\Music\\${name}`, subsong: 0});
const columns = name => [location(name).path, '0', name, '', '', '180'];

function fixture(t, options = {}) {
  const {root, parent} = createCanonicalTemp('still-playback-r2-');
  const output = {typeId: 'output', deviceId: 'fixture'};
  const outputs = {active: output, types: [{id: 'output', name: 'Output', devices: [{id: 'fixture', name: 'Fixture'}]}]};
  let index = options.index ?? 0, position = 8, playback = options.playback || 'playing', order = 0;
  let pendingSkip, pendingOrder, queueReads = 0;
  const queue = [];
  const queuedRows = () => queue.map(itemIndex => ({playlistId: 'p1', playlistIndex: 0, itemIndex, columns: columns(files[itemIndex])}));
  const playlists = [{id: 'p1', index: 0, title: 'Fixture', itemCount: files.length}];
  const http = createFakeBeefwebHttp(({route, method, body, url, send}) => {
    if (route === 'query' && method === 'GET') {
      if (pendingSkip && pendingSkip.remaining-- === 0) {
        playback = pendingSkip.target === null ? 'stopped' : 'playing';
        if (pendingSkip.target !== null) index = pendingSkip.target;
        position = 0; pendingSkip = null;
      }
      if (pendingOrder && pendingOrder.remaining-- === 0) {order = pendingOrder.id; pendingOrder = null;}
      const playingState = options.stoppedGap && pendingSkip?.remaining === 1 ? 'stopped' : playback;
      if (playingState === 'playing') position += 0.2;
      const enumNames = ['Default', 'Repeat (playlist)', 'Repeat (track)', 'Shuffle (tracks)'];
      return send({outputs, ...(url.searchParams.has('playQueue') ? {playQueue: queuedRows()} : {}),
        player: {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: playingState,
        activeItem: playingState === 'stopped' ? {playlistId: '', playlistIndex: -1, index: -1, position: 0, duration: 0, columns: []} :
          {playlistId: 'p1', playlistIndex: 0, index, position, duration: 180, columns: columns(files[index])},
        volume: {type: 'db', min: -100, max: 0, value: -20},
        playbackMode: order, playbackModes: enumNames,
        options: [{id: 'playbackOrder', type: 'enum', value: order, enumNames},
          {id: 'stopAfterCurrentTrack', type: 'bool', value: false}]}});
    }
    if (['player/next', 'player/previous'].includes(route) && method === 'POST') {
      const target = options.skipTarget ? options.skipTarget(index, order) : queue.length && route === 'player/next' ? queue.shift() : index + 1;
      if (target !== undefined) pendingSkip = {target, remaining: 3};
      return send(null, 204);
    }
    if (route === 'player' && method === 'POST' && body.options) {
      assert.deepEqual(Object.keys(body), ['options']);
      assert.equal(body.options[0]?.id, 'playbackOrder');
      pendingOrder = {id: body.options[0].value, remaining: 2};
      return send(null, 204);
    }
    if (route === 'player' && method === 'POST' && Number.isFinite(body.position)) {
      options.onSeek?.(index, body.position); position = body.position; return send(null, 204);
    }
    if (route === 'player/stop' && method === 'POST') {playback = 'stopped'; pendingSkip = null; return send(null, 204);}
    if (route === 'playlists' && method === 'GET') return send({playlists});
    const page = /^playlists\/p1\/items\/(\d+):(\d+)$/.exec(route);
    if (page && method === 'GET') {
      const offset = Number(page[1]);
      return send({playlistItems: {offset, totalCount: files.length, items: files.slice(offset, offset + Number(page[2])).map(name => ({columns: columns(name)}))}});
    }
    if (route === 'playqueue' && method === 'GET') {
      if (options.failQueueRead?.(++queueReads)) return send({}, 503);
      return send({playQueue: queuedRows()});
    }
    if (route.startsWith('playqueue/') && method === 'POST') {
      options.beforeQueueWrite?.(route, queue);
      if (route === 'playqueue/add') {
        assert.equal(body.plref, 'p1'); assert.ok(files[body.itemIndex]);
        if (!options.ignoreAdds) queue.push(body.itemIndex);
      } else if (route === 'playqueue/remove') {
        // The native API removes one position, or the first matching reference.
        if (body.queueIndex === undefined) assert.equal(body.plref, 'p1');
        const remove = body.queueIndex ?? queue.indexOf(body.itemIndex);
        if (remove >= 0) queue.splice(remove, 1);
      } else if (route === 'playqueue/clear') queue.length = 0;
      else throw new Error(`Unexpected ${method} ${route}`);
      return send(null, 204);
    }
    throw new Error(`Unexpected ${method} ${route}`);
  });
  const service = createFoobarService({dataDir: root, baseUrl: http.baseUrl, fetch: http.fetch, pollIntervalMs: 0,
    persistOutputSelection: false, verifyTimeoutMs: 250, verifyPollMs: 5, timeoutMs: 500});
  t.after(async () => {
    await service.close(); await http.drain();
    assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('still-playback-r2-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  const tracks = [{id: 'repeat', ...location('repeat.flac')}, {id: 'other', ...location('other.flac')}, {id: 'last', ...location('last.flac')}];
  const coordinator = createPlaybackCoordinator({engines: {local: service}});
  const handlers = createHandlers({foobar: service, coordinator, library: {list: () => ({tracks}), getTrack: id => tracks.find(track => track.id === id)}});
  t.after(async () => {handlers.closePlaybackContext(); await coordinator.close();});
  return {service, http, handlers, coordinator, queue, moveTo(value) {index = value; position = 0;}};
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Expected desktop command or snapshot did not arrive');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function desktopFixture(t, {handlers, coordinator, beforeAction}) {
  const snapshots = [], errors = [];
  const settings = {get: () => ({...DEFAULTS, desktop: {...DEFAULTS.desktop, systemMediaControls: true, preventSleep: false}})};
  const callbacks = createDesktopPlaybackCallbacks({coordinator});
  let command;
  const desktop = createDesktopIntegration({settings, getPlayer: () => handlers['player:state']({}), getSources: () => handlers['source:status']({}),
    ...callbacks, performAction(action) {beforeAction?.(action); return callbacks.performAction(action);}, onError: value => errors.push(value.code),
    createMediaClient({onCommand}) {
      command = onCommand;
      return {start: () => ({available: true}), update: value => {snapshots.push(value);}, dispose: () => {}};
    }});
  t.after(() => desktop.beginShutdown());
  return {desktop, errors, snapshots, send(action, extra = {}) {
    const {sessionId, sequence} = snapshots.at(-1);
    command({action, sessionId, sequence, ...extra});
  }};
}

test('next waits for the new occurrence after Beefweb acknowledges the command', async t => {
  const {service, http} = fixture(t);
  const state = await service.next();
  assert.equal(state.currentTrack.path, location('other.flac').path);
  assert.deepEqual(http.calls.filter(call => call.method === 'POST').map(call => call.route), ['player/next']);
});

test('queue removal refuses a shifted index after the dialog read', async t => {
  const {handlers, http, queue} = fixture(t);
  queue.push(0, 1, 3);
  const firstView = await handlers['queue:list']({});
  assert.deepEqual(firstView.items.map(item => item.itemIndex), [0, 1, 3]);
  assert.equal((await handlers['queue:list']({})).selectionToken, firstView.selectionToken);
  queue.shift();
  const secondView = await handlers['queue:list']({});
  assert.notEqual(firstView.selectionToken, secondView.selectionToken);
  const rejected = await invokeSafely(handlers['queue:remove'], {index: 1, selectionToken: firstView.selectionToken});
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'STILL_QUEUE_CHANGED');
  assert.deepEqual(queue, [1, 3]);
  assert.equal(http.calls.some(call => call.method === 'POST'), false);
});

test('queue selection is bridge bound even when the new bridge has identical content', async t => {
  const first = fixture(t), second = fixture(t);
  first.queue.push(0, 1); second.queue.push(0, 1);
  const {selectionToken} = await first.handlers['queue:list']({});
  await assert.rejects(second.handlers['queue:remove']({index: 1, selectionToken}), {code: 'STILL_QUEUE_CHANGED'});
  await assert.rejects(second.handlers['queue:remove']({index: 1}), {code: 'STILL_QUEUE_CHANGED'});
  assert.deepEqual(second.queue, [0, 1]);
  assert.equal(second.http.calls.some(call => call.method === 'POST'), false);
});

test('queue removal targets the requested playlist occurrence when a different copy of the same file is consumed', async t => {
  const {service, http, queue} = fixture(t, {beforeQueueWrite(_route, items) {items.shift();}});
  queue.push(0, 2);
  const result = await service.queueRemove(1);
  assert.deepEqual(result.items, []);
  assert.deepEqual(queue, []);
  assert.deepEqual(http.calls.find(call => call.method === 'POST').body, {plref: 'p1', itemIndex: 2});
});

test('queue append verifies its new entries after the playing queue consumes the preceding head', async t => {
  const {handlers, http, queue} = fixture(t, {beforeQueueWrite(_route, items) {items.shift();}});
  queue.push(0, 1);
  const result = await handlers['queue:add']({trackIds: ['last']});
  assert.deepEqual(result.items.map(item => item.itemIndex), [1, 3]);
  assert.deepEqual(queue, [1, 3]);
  assert.deepEqual(http.calls.filter(call => call.method === 'POST').map(call => call.route), ['playqueue/add']);
});

test('an old queue suffix alone cannot confirm an acknowledged append', async t => {
  const {handlers, http, queue} = fixture(t, {ignoreAdds: true, beforeQueueWrite(_route, items) {items.shift();}});
  queue.push(1, 2);
  await assert.rejects(handlers['queue:add']({trackIds: ['repeat']}), /未确认排队曲目/);
  assert.deepEqual(queue, [2]);
  assert.equal(http.calls.filter(call => call.method === 'POST').length, 1);
});

test('repeated native queue references allow position removal with a stopped witness only', async t => {
  const {handlers, http, queue} = fixture(t);
  const added = await handlers['queue:add']({trackIds: ['repeat', 'other', 'repeat', 'last']});
  const [first, , repeated] = added.items;
  assert.equal(first.itemIndex, repeated.itemIndex);
  assert.equal(first.playlistId, repeated.playlistId);
  const remove = () => handlers['queue:remove']({index: 2, selectionToken: added.selectionToken});
  await assert.rejects(remove(), {code: 'STILL_QUEUE_CHANGED'});
  assert.equal(http.calls.some(call => call.route === 'playqueue/remove'), false);
  await handlers['player:stop']({});
  const removed = await remove();
  assert.deepEqual(removed.items.map(item => item.trackId), ['repeat', 'other', 'last']);
  assert.deepEqual(queue, [first.itemIndex, 1, 3]);
  assert.deepEqual(http.calls.find(call => call.route === 'playqueue/remove').body, {queueIndex: 2});
  const atomic = http.calls.find(call => call.route === 'query' && call.url.searchParams.has('qcolumns'));
  assert.equal(atomic.url.searchParams.get('player'), 'true');
  assert.equal(atomic.url.searchParams.get('playQueue'), 'true');
});

test('queue clear returns its confirmed readback if a subsequent queue read would fail', async t => {
  const {handlers, http, queue} = fixture(t, {failQueueRead: count => count === 2});
  queue.push(0, 2, 0);
  assert.deepEqual((await handlers['queue:clear']({})).items, []);
  assert.deepEqual(queue, []);
  assert.equal(http.calls.filter(call => call.route === 'playqueue' && call.method === 'GET').length, 1);
});

test('previous can pass through stopped and confirm a different occurrence of the same file', async t => {
  const {service, handlers, http} = fixture(t, {index: 2, stoppedGap: true, skipTarget: () => 0});
  const before = await service.getState();
  const result = await handlers['player:previous']({});
  assert.equal(result.currentTrack.path, before.currentTrack.path);
  assert.notEqual(result.playbackOccurrence, before.playbackOccurrence);
  assert.equal(result.state, 'playing');
  assert.deepEqual(http.calls.filter(call => call.method === 'POST').map(call => call.route), ['player/previous']);
});

test('order confirms the enumerated option and next respects the backend queue over playlist order', async t => {
  const {handlers, http, queue} = fixture(t);
  const order = await handlers['player:order']({id: 3});
  assert.equal(order.playbackOrder?.id, 3);
  assert.deepEqual(http.calls.find(call => call.method === 'POST').body, {options: [{id: 'playbackOrder', value: 3}]});
  queue.push(3);
  const result = await handlers['player:next']({});
  assert.equal(result.currentTrack.path, location('last.flac').path);
  assert.deepEqual(queue, []);
  assert.deepEqual(http.calls.filter(call => call.method === 'POST').map(call => call.route), ['player', 'player/next']);
});

test('same occurrence restart is confirmed but unchanged forward progress is not', async t => {
  let target = 0;
  const {service} = fixture(t, {skipTarget: () => target});
  const before = await service.getState(), restarted = await service.next();
  assert.equal(restarted.playbackOccurrence, before.playbackOccurrence);
  assert.ok(restarted.position < before.position);
  target = undefined;
  await assert.rejects(service.next(), /未确认切换曲目/);
});

test('cancelled order readback leaves the physical write settled and allows an explicit new order', async t => {
  const {service, http} = fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let held;
  t.after(() => release.resolve());
  http.setBodyHook(async call => {
    if (!held && call.route === 'query' && http.calls.some(row => row.method === 'POST' && row.body?.options)) {
      held = call; entered.resolve(); await release.promise;
    }
  });
  const changing = service.setOrder(3);
  const cancelled = assert.rejects(changing, {code: 'STILL_CANCELLED'});
  await entered.promise;
  await service.stop();
  await cancelled;
  assert.equal(held.signal.aborted, true);
  release.resolve();
  assert.equal((await service.setOrder(1)).playbackOrder?.id, 1);
  assert.deepEqual(http.calls.filter(call => call.method === 'POST').map(call => call.route), ['player', 'player/stop', 'player']);
});

test('Windows media seek retains the displayed local occurrence through the final adapter check', async t => {
  const seeks = [];
  const f = fixture(t, {onSeek: (index, position) => seeks.push({index, position})});
  let startAction = true;
  const media = desktopFixture(t, {...f, beforeAction() {
    if (startAction) {startAction = false; f.moveTo(2);}
  }});
  const first = await f.handlers['player:state']({});
  media.desktop.observePlayer(first);
  media.desktop.observeSources(await f.handlers['source:status']({}));
  await waitUntil(() => media.snapshots.at(-1)?.capabilities.seek);
  const initial = media.snapshots.at(-1);
  const fresh = await f.handlers['player:state']({});
  assert.ok(fresh.revision > first.revision);
  assert.equal(fresh.playbackOccurrence, first.playbackOccurrence);
  assert.equal(media.desktop.observePlayer(fresh), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(media.snapshots.at(-1).sequence, initial.sequence);
  assert.equal(media.snapshots.at(-1).sessionId, initial.sessionId);
  media.send('seek', {position: 71});
  await waitUntil(() => media.errors.length || seeks.length);
  assert.deepEqual(media.errors, ['STILL_DESKTOP_MEDIA_COMMAND']);
  assert.deepEqual(seeks, []);
  const second = await f.handlers['player:state']({});
  assert.equal(second.currentTrackId, first.currentTrackId);
  assert.notEqual(second.playbackOccurrence, first.playbackOccurrence);
  media.desktop.observePlayer(second);
  await waitUntil(() => media.snapshots.at(-1).sessionId !== initial.sessionId);
  media.send('seek', {position: 19});
  await waitUntil(() => seeks.length);
  assert.deepEqual(seeks, [{index: 2, position: 19}]);
});

test('verified Apple playback exposes Windows media Stop and verifies one native stop', async t => {
  const {service: apple, wire} = syntheticOfficialAppleHost(t);
  await apple.initialize(); await apple.authorize();
  const local = {getState: () => ({available: true, state: 'stopped'})};
  const coordinator = createPlaybackCoordinator({engines: {local, apple: createAppleAdapter(apple)}, defaultSource: 'apple'});
  const handlers = createHandlers({foobar: local, apple, coordinator, library: {list: () => ({tracks: []})}});
  t.after(async () => {handlers.closePlaybackContext(); await coordinator.close();});
  const media = desktopFixture(t, {handlers, coordinator});
  const played = await handlers['player:play']({source: 'apple', id: 'fixture-apple'});
  assert.equal(played.state, 'playing');
  media.desktop.observePlayer(played);
  media.desktop.observeSources(await handlers['source:status']({}));
  await waitUntil(() => media.snapshots.at(-1)?.capabilities.pause);
  assert.equal(media.snapshots.at(-1).capabilities.stop, true);
  media.send('stop');
  await waitUntil(() => media.snapshots.at(-1)?.state === 'stopped');
  assert.deepEqual(media.errors, []);
  assert.equal(wire.filter(method => method === 'stop').length, 1);
  assert.equal((await handlers['player:state']({})).state, 'stopped');
});
