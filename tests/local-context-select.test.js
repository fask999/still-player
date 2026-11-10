'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createFoobarService} = require('../src/main/foobar');
const {createPlaybackContextService} = require('../src/main/playback-context');
const {createCuePlaybackGuard} = require('../src/main/cue-playback-guard');
const {verifyExistingContextScope} = require('../src/main/existing-context-scope');
const {createLibraryService} = require('../src/main/library');
const {createFakeBeefwebHttp} = require('./helpers/fake-beefweb-http');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');

const cue = subsong => ['E:\\Music\\Image.flac', String(subsong), `Subsong ${subsong}`, '', '', '180'];
const deviceId = 'output:016F9F0C-AFE4-4072-9018-CCEBB576B4CB';
const endpointState = (endpoint, state = 1) => ({endpoint, operation: 'GetState', mode: 'state', deviceFound: true,
  state, active: state === 1, hresult: '0x00000000', clientActivated: false,
  initializeCalled: false, startCalled: false, actualDacRate: null});

function fixture(t, options = {}) {
  const {root: dataDir, parent} = createCanonicalTemp('still-local-context-select-');
  const rows = [cue(1), cue(2), cue(1)];
  const active = {playlistId: 'real', index: 2};
  const deviceId = options.deviceId || 'original';
  const output = {active: {typeId: 'synthetic', deviceId}, types: [{id: 'synthetic', name: 'Test',
    devices: [{id: deviceId, name: 'Original'}, {id: 'changed', name: 'Changed'}]}]};
  let position = 0, playbackState = options.initialState || 'playing', afterContextAnchor, afterContextPage;
  const http = createFakeBeefwebHttp(({route, url, body, send}) => {
    options.onRequest?.(route);
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
    if (route === 'playqueue') return send({playQueue: options.queue || []});
    if (['player/play', 'player/next', 'player/previous'].includes(route)) {
      if (route === 'player/next') active.index = (active.index + 1) % rows.length;
      if (route === 'player/previous') active.index = (active.index + rows.length - 1) % rows.length;
      playbackState = 'playing'; position = 0; return send(null, 204);
    }
    if (route === 'player' && body?.position != null) {position = body.position; return send(null, 204);}
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
  const local = createFoobarService({dataDir, fetch: http.fetch, baseUrl: http.baseUrl, persistOutputSelection: false,
    pollIntervalMs: 0, verifyTimeoutMs: 60, verifyPollMs: 2, probeOutputState: options.probeOutputState,
    cuePlaybackGuard: options.cuePlaybackGuard, fenceTimeoutMs: options.fenceTimeoutMs,
    clock: {now: () => 1}});
  const context = createPlaybackContextService({local});
  t.after(async () => {context.close(); await local.close(); await http.drain();
    assert.equal(path.dirname(dataDir), parent); assert.ok(path.basename(dataDir).startsWith('still-local-context-select-'));
    await fs.rm(dataDir, {recursive: true, force: true});});
  return {rows, active, output, local, context, http, setAfterContextAnchor(fn) {afterContextAnchor = fn;},
    setAfterContextPage(fn) {afterContextPage = fn;},
    writes: () => http.calls.filter(call => call.method === 'POST').map(call => call.route)};
}

async function strictGuard(t, onGetter) {
  const {root: dataDir, parent} = createCanonicalTemp('still-context-guard-library-');
  const library = createLibraryService({dataDir, verifyExistingContextScope}); await library.initialize();
  const guard = createCuePlaybackGuard({runtimeRoot: path.resolve(__dirname, '..'), async getRequests(locations, options) {
    onGetter(locations, options); return library.getCuePlaybackRequests(locations, options);
  }});
  t.after(async () => {await guard.close(); await library.close(); assert.equal(path.dirname(dataDir), parent);
    assert.ok(path.basename(dataDir).startsWith('still-context-guard-library-')); await fs.rm(dataDir, {recursive: true, force: true});});
  return guard;
}

test('real strict library accepts the legacy exact Image.flac subsong only through the verified selection scope', async t => {
  const receipts = [];
  const guard = await strictGuard(t, (locations, {existingContextScope}) => {
    assert.equal(locations.length, 1); assert.deepEqual(locations[0], {path: cue(1)[0], subsong: 1});
    assert.equal(verifyExistingContextScope(existingContextScope, locations[0]), true);
    assert.equal(verifyExistingContextScope(existingContextScope, {path: cue(1)[0], subsong: 2}), false);
    receipts.push(existingContextScope);
  });
  const f = fixture(t, {cuePlaybackGuard: guard}); await f.local.getState();
  await assert.rejects(f.local.selectPlaybackContext({selectionToken: 'local-select:' + 'a'.repeat(64), index: 0}), {code: 'STILL_CONTEXT_CHANGED'});
  assert.equal(receipts.length, 0);
  const {selectionToken} = await f.context.read('local'), result = await f.local.selectPlaybackContext({selectionToken, index: 0});
  assert.equal(result.currentTrack.subsong, 1); assert.deepEqual(f.writes(), ['player/play/real/0']);
  assert.ok(receipts.length >= 3); assert.equal(receipts.every(scope => scope === receipts[0]), true);
  assert.equal(verifyExistingContextScope(receipts[0], {path: cue(1)[0], subsong: 1}), false); assert.equal(guard.getStatus().holders, 0);
});

test('a valid existing playlist token cannot admit an unknown explicit CUE', async t => {
  const guard = await strictGuard(t, () => {}), f = fixture(t, {cuePlaybackGuard: guard});
  f.rows[1] = ['E:\\Music\\Unknown.cue', '1', 'Unknown', '', '', '180']; await f.local.getState();
  const {selectionToken} = await f.context.read('local');
  await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 1}), {code: 'STILL_CUE_PLAYBACK_REVALIDATION_REQUIRED'});
  assert.deepEqual(f.writes(), []); assert.equal(guard.getStatus().holders, 0);
});

test('selection content is read again after the private getter and a changed occurrence revokes its scope', async t => {
  let f, scope, reads = 0;
  const guard = await strictGuard(t, (_locations, options) => {scope = options.existingContextScope; if (++reads === 2) f.rows[1] = cue(3);});
  f = fixture(t, {cuePlaybackGuard: guard}); await f.local.getState();
  const {selectionToken} = await f.context.read('local');
  await assert.rejects(f.local.selectPlaybackContext({selectionToken, index: 1}), {code: 'STILL_CONTEXT_CHANGED'});
  assert.deepEqual(f.writes(), []); assert.equal(verifyExistingContextScope(scope, {path: cue(2)[0], subsong: 2}), false);
});

for (const method of ['toggle', 'next', 'previous', 'seek']) test(`${method} protects actual Native context GETs and the final dispatch with the same operation permit`, async t => {
  let activePermit = false, marks = 0, observations = 0, scope;
  const guarded = {async prepare(input) {
    scope = input.existingContextScope;
    assert.ok(input.locations.every(row => verifyExistingContextScope(scope, row)));
    assert.equal(input.locations.length, method === 'seek' ? 1 : 4);
    activePermit = true;
    return {check() {input.context.check();}, async recheck() {input.context.check();}, markNativeRead() {input.context.check(); marks++;}, async release() {activePermit = false;}};
  }};
  const f = fixture(t, {cuePlaybackGuard: guarded, initialState: method === 'toggle' ? 'paused' : 'playing',
    queue: [{playlistId: 'other', itemIndex: 1, columns: ['E:\\Music\\Queued.wav', '0', 'Queued', '', '', '180']}],
    onRequest() {if (activePermit) {observations++; assert.equal(marks, observations);}}});
  await f.local.getState(); await f.local[method](...(method === 'seek' ? [40] : []));
  assert.equal(f.writes().length, 1); assert.ok(marks >= 3); assert.equal(activePermit, false);
  assert.equal(verifyExistingContextScope(scope, {path: cue(1)[0], subsong: 1}), false);
});

test('an expired dispatch cannot acquire a late selection permit or leave its scope live', async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers(); let scope, releases = 0;
  const f = fixture(t, {fenceTimeoutMs: 40, cuePlaybackGuard: {async prepare(input) {
    scope = input.existingContextScope; entered.resolve(); await gate.promise;
    return {check() {}, async recheck() {}, markNativeRead() {assert.fail('late Native admission');}, async release() {releases++;}};
  }}});
  try {
    await f.local.getState(); const {selectionToken} = await f.context.read('local');
    const selection = f.local.selectPlaybackContext({selectionToken, index: 0});
    const rejected = assert.rejects(selection, {code: 'STILL_TRANSPORT_UNCERTAIN'}); await entered.promise; await rejected;
    assert.equal(verifyExistingContextScope(scope, {path: cue(1)[0], subsong: 1}), false);
    gate.resolve(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(releases, 1); assert.deepEqual(f.writes(), []);
  } finally {gate.resolve();}
});

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
