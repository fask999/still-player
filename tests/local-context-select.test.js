'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createFoobarService} = require('../src/main/foobar');
const {createPlaybackContextService} = require('../src/main/playback-context');
const {createFakeBeefwebHttp} = require('./helpers/fake-beefweb-http');

const cue = subsong => ['E:\\Music\\Image.flac', String(subsong), `Subsong ${subsong}`, '', '', '180'];
const deviceId = 'output:016F9F0C-AFE4-4072-9018-CCEBB576B4CB';
const endpointState = (endpoint, state = 1) => ({endpoint, operation: 'GetState', mode: 'state', deviceFound: true,
  state, active: state === 1, hresult: '0x00000000', clientActivated: false,
  initializeCalled: false, startCalled: false, actualDacRate: null});

function fixture(t, options = {}) {
  const rows = [cue(1), cue(2), cue(1)];
  const active = {playlistId: 'real', index: 2};
  const deviceId = options.deviceId || 'original';
  const output = {active: {typeId: 'synthetic', deviceId}, types: [{id: 'synthetic', name: 'Test',
    devices: [{id: deviceId, name: 'Original'}, {id: 'changed', name: 'Changed'}]}]};
  let position = 0, playbackState = 'playing', afterContextAnchor, afterContextPage;
  const http = createFakeBeefwebHttp(({route, url, send}) => {
    if (route === 'query') {
      const context = url.searchParams.has('playlists'), outputs = url.searchParams.has('outputs');
      send({player: {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState,
        activeItem: {...active, position: position += 0.1, columns: rows[active.index]}},
      ...(outputs && {outputs: output}),
      ...(context && {playlists: [{id: 'real', title: 'Active', itemCount: rows.length},
        {id: 'other', title: 'Other', itemCount: rows.length}]})});
      if (context) afterContextAnchor?.();
      return;
    }
    const page = /^playlists\/(?:real|other)\/items\/(\d+):(\d+)$/.exec(route);
    if (page) {
      const offset = Number(page[1]), count = Number(page[2]);
      send({playlistItems: {offset, totalCount: rows.length,
        items: rows.slice(offset, offset + count).map(columns => ({columns}))}});
      afterContextPage?.();
      return;
    }
    const play = /^player\/play\/real\/(\d+)$/.exec(route);
    if (play) {
      Object.assign(active, {index: Number(play[1])}, options.readback);
      options.afterPlay?.(rows);
      playbackState = 'playing'; position = 0;
      return send({applied: true});
    }
    if (route === 'player/stop') {playbackState = 'stopped'; return send(null, 204);}
    return send(null, 404);
  });
  const local = createFoobarService({fetch: http.fetch, baseUrl: http.baseUrl, persistOutputSelection: false,
    pollIntervalMs: 0, verifyTimeoutMs: 60, verifyPollMs: 2, probeOutputState: options.probeOutputState,
    clock: {now: () => 1}});
  const context = createPlaybackContextService({local});
  t.after(async () => {context.close(); await local.close(); await http.drain();});
  return {rows, active, output, local, context, http, setAfterContextAnchor(fn) {afterContextAnchor = fn;},
    setAfterContextPage(fn) {afterContextPage = fn;},
    writes: () => http.calls.filter(call => call.method === 'POST').map(call => call.route)};
}

test('local context exposes a bridge-bound opaque token and plays the exact duplicate occurrence', async t => {
  const f = fixture(t), replacement = fixture(t);
  await f.local.getState(); await replacement.local.getState();
  const snapshot = await f.context.read('local');
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.capabilities.select, true);
  assert.match(snapshot.selectionToken, /^local-select:[0-9a-f]{64}$/);
  assert.equal(snapshot.currentIndex, 2);
  assert.notEqual(snapshot.selectionToken, (await replacement.context.read('local')).selectionToken);
  assert.equal((await f.context.read('local')).selectionToken, snapshot.selectionToken);
  const selection = {selectionToken: snapshot.selectionToken, index: 0};
  await assert.rejects(replacement.local.selectPlaybackContext(selection), {code: 'STILL_CONTEXT_CHANGED'});
  assert.deepEqual(replacement.writes(), []);
  const result = await f.local.selectPlaybackContext(selection);
  assert.equal(result.state, 'playing');
  assert.equal(result.currentTrack.subsong, 1);
  assert.deepEqual(f.writes(), ['player/play/real/0']);
  assert.equal(f.active.index, 0);
  assert.notEqual((await f.context.read('local')).selectionToken, snapshot.selectionToken);
});

test('same-size playlist edits and changed occurrence fail before any POST', async t => {
  for (const change of [f => {f.rows[1] = cue(3);}, f => {f.rows[1] = [cue(2)[0].toLowerCase(), ...cue(2).slice(1)];},
    f => {f.active.index = 0;}, f => {f.active.playlistId = 'other';}]) {
    const f = fixture(t);
    await f.local.getState();
    const {selectionToken} = await f.context.read('local');
    change(f);
    await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 1}), {code: 'STILL_CONTEXT_CHANGED'});
    assert.deepEqual(f.writes(), []);
  }
});

test('local context keeps legacy backends and malformed selection tokens read-only', async t => {
  const f = fixture(t);
  await f.local.getState();
  const raw = await f.local.playbackContext();
  const {selectionToken, ...legacy} = raw;
  assert.match(selectionToken, /^local-select:/);
  for (const local of [
    {playbackContext: () => raw},
    {playbackContext: () => legacy, selectPlaybackContext() {}},
    {playbackContext: () => ({...raw, selectionToken: 'raw-track-path'}), selectPlaybackContext() {}}
  ]) {
    const context = createPlaybackContextService({local});
    t.after(() => context.close());
    const result = await context.read('local');
    assert.equal(result.status, 'ready');
    assert.equal(result.capabilities.select, false);
    assert.notEqual(result.selectionToken, 'raw-track-path');
  }
});

test('local select honors output and shutdown write admission', async t => {
  const f = fixture(t);
  await f.local.getState();
  const {selectionToken} = await f.context.read('local');
  f.output.active.deviceId = 'changed';
  await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 1}), {code: 'STILL_OUTPUT_CHANGED'});
  f.output.active.deviceId = 'original';
  f.setAfterContextAnchor(() => {f.output.active.deviceId = 'changed';});
  await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 1}), {code: 'STILL_OUTPUT_CHANGED'});
  f.local.beginShutdownWrites();
  await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 1}), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  assert.deepEqual(f.writes(), []);
});

test('local select rechecks the physical endpoint after playlist reads even when its GUID is unchanged', async t => {
  let physicalState = 1, pages = 0;
  const probes = [];
  const f = fixture(t, {deviceId, probeOutputState({endpointId}) {
    probes.push({endpointId, pages, state: physicalState});
    return endpointState(endpointId, physicalState);
  }});
  await f.local.getState();
  const {selectionToken, capabilities} = await f.context.read('local');
  assert.equal(capabilities.select, true);
  assert.equal(probes.length, 1, 'display reads do not probe the endpoint');
  f.setAfterContextPage(() => {if (++pages === 1) physicalState = 8;});
  await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 1}), {code: 'STILL_OUTPUT_DISCONNECTED'});
  assert.equal(f.output.active.deviceId, deviceId);
  assert.deepEqual(probes.map(({pages, state}) => [pages, state]), [[0, 1], [2, 8]]);
  assert.equal(probes[0].endpointId, probes[1].endpointId);
  assert.deepEqual(f.writes(), []);
});

test('local select rejects a same-size edit to the inactive target during the fresh device probe', async t => {
  let replaceTarget, probes = 0;
  const f = fixture(t, {deviceId, probeOutputState({endpointId}) {
    if (++probes === 2) replaceTarget();
    return endpointState(endpointId);
  }});
  await f.local.getState();
  const {selectionToken} = await f.context.read('local');
  replaceTarget = () => {f.rows[1] = cue(3);};
  await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 1}), {code: 'STILL_CONTEXT_CHANGED'});
  assert.equal(probes, 2);
  assert.equal(f.active.index, 2);
  assert.equal(f.rows.length, 3);
  assert.equal(f.http.calls.at(-1).route, 'playlists/real/items/1:1');
  assert.deepEqual(f.writes(), []);
});

test('local readback requires exact playlist, occurrence, path, and subsong', async t => {
  for (const options of [{readback: {playlistId: 'other'}}, {readback: {index: 2}},
    {afterPlay(rows) {rows[0] = cue(2);}},
    {afterPlay(rows) {rows[0] = [cue(1)[0].toLowerCase(), ...cue(1).slice(1)];}}]) {
    const f = fixture(t, options);
    await f.local.getState();
    const {selectionToken} = await f.context.read('local');
    await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 0}), /读回未确认/);
    assert.deepEqual(f.writes(), ['player/play/real/0']);
  }
});

test('cancellation of context validation does not send a POST', async t => {
  const f = fixture(t), controller = new AbortController();
  await f.local.getState();
  const {selectionToken} = await f.context.read('local');
  f.setAfterContextAnchor(() => controller.abort());
  await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 1}, {signal: controller.signal}), {code: 'STILL_CANCELLED'});
  assert.deepEqual(f.writes(), []);
});

test('a superseding stop waits for the physical local selection POST body', async t => {
  const f = fixture(t), body = Promise.withResolvers(), reading = Promise.withResolvers();
  try {
    await f.local.getState();
    const {selectionToken} = await f.context.read('local');
    f.http.setBodyHook(async call => {
      if (call.route === 'player/play/real/1') {reading.resolve(); await body.promise;}
    });
    const pending = f.local.selectPlaybackContext({selectionToken, index: 1});
    const cancelled = assert.rejects(pending, {code: 'STILL_CANCELLED'});
    await Promise.race([reading.promise, pending]);
    const stopping = f.local.stop();
    await cancelled;
    assert.deepEqual(f.writes(), ['player/play/real/1']);
    body.resolve();
    assert.equal((await stopping).state, 'stopped');
    assert.deepEqual(f.writes(), ['player/play/real/1', 'player/stop']);
  } finally {body.resolve();}
});
