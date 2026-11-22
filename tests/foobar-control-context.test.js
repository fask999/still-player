'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createFoobarService} = require('../src/main/foobar');
const {createFoobarSessionService} = require('../src/main/foobar-session');
const {verifyExistingContextScope} = require('../src/main/existing-context-scope');
const {createFakeBeefwebHttp} = require('./helpers/fake-beefweb-http');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');

const deviceId = 'output:016F9F0C-AFE4-4072-9018-CCEBB576B4CB';
const columns = index => [`C:\\Music\\${index}.flac`, '0', `Title ${index}`, '', '', '240'];

function fixture(t, {paused = false, editAfterPermit, editDuringProbe, editDuringRefresh, disconnectDuringFinalPage = false,
  slowAfterProbes = [], expireOnDispatch = false, totalCount = 250} = {}) {
  const {root: dataDir, parent} = createCanonicalTemp('still-control-context-');
  const items = Array.from({length: 250}, (_, index) => columns(index));
  items[10] = [...items[7]];
  const queue = [{playlistId: 'other', itemIndex: 1, columns: columns('queued')}];
  const outputs = {active: {typeId: 'output', deviceId}, types: [{id: 'output', devices: [{id: deviceId}]}]};
  let index = 7, state = paused ? 'paused' : 'playing', position = 0, probes = 0, marks = 0, released = false, scope;
  let wall = 100, elapsed = 0, physical = 1;
  const http = createFakeBeefwebHttp(({route, url, body, send}) => {
    if (route === 'query') return send({player: {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: state,
      activeItem: {playlistId: 'list', index, columns: items[index], duration: 240, position: state === 'playing' ? position += 0.2 : position}},
    ...(url.searchParams.has('playlists') && {playlists: [{id: 'list', title: 'List', itemCount: totalCount}]}),
    ...(url.searchParams.has('playQueue') && {playQueue: queue}), ...(url.searchParams.has('outputs') && {outputs})});
    if (route === 'playqueue') return send({playQueue: queue});
    const page = /^playlists\/list\/items\/(\d+):(\d+)$/.exec(route);
    if (page) {
      const offset = Number(page[1]);
      if (disconnectDuringFinalPage && probes === 2) {physical = 8; elapsed = 5000;}
      if (offset === 200 && slowAfterProbes.includes(probes)) elapsed += 5000;
      return send({playlistItems: {offset, totalCount, items: items.slice(offset, offset + Number(page[2])).map(columns => ({columns}))}});
    }
    if (route === 'player/next' || route === 'player/previous' || route === 'player/play') {
      if (route.endsWith('/next')) index++;
      if (route.endsWith('/previous')) index--;
      position = 0; state = 'playing'; return send(null, 204);
    }
    if (route === 'player' && body?.position != null) {position = body.position; return send(null, 204);}
    return send(null, 404);
  });
  const service = createFoobarService({dataDir, fetch: http.fetch, baseUrl: http.baseUrl, persistOutputSelection: false,
    pollIntervalMs: 0, verifyTimeoutMs: 180, verifyPollMs: 2, cleanupDelayMs: 60000,
    onAudioDispatch() {if (expireOnDispatch) elapsed += 5000;},
    clock: {now: () => wall, monotonicNow: () => elapsed}, async probeOutputState({endpointId}) {
      if (probes === 2 && editDuringRefresh) {
        await Promise.resolve();
        editDuringRefresh(items[index + 1]);
      }
      if (++probes === 2) physical = editDuringProbe?.({items, queue, outputs, setIndex: value => {index = value;}}) ?? physical;
      return {endpoint: endpointId, operation: 'GetState', mode: 'state', deviceFound: true,
        state: physical, active: physical === 1, hresult: '0x00000000', clientActivated: false, initializeCalled: false, startCalled: false, actualDacRate: null};
    }, cuePlaybackGuard: {async prepare(input) {
      scope = input.existingContextScope;
      assert.ok(input.locations.every(item => verifyExistingContextScope(scope, item)));
      return {check: input.context.check, async recheck() {editAfterPermit?.({items, queue, outputs, setIndex: value => {index = value;}});},
        markNativeRead() {input.context.check(); marks++;}, async release() {released = true;}};
    }}});
  t.after(async () => {
    await service.close(); await http.drain();
    assert.equal(path.dirname(dataDir), parent); assert.ok(path.basename(dataDir).startsWith('still-control-context-'));
    await fs.rm(dataDir, {recursive: true, force: true});
  });
  return {service, calls: http.calls, probes: () => probes, writes: () => http.calls.filter(call => call.method === 'POST'),
    setTime(value, timestamp) {elapsed = value; wall = timestamp;},
    checkReleased() {
      assert.ok(marks >= 3); assert.equal(released, true);
      assert.equal(verifyExistingContextScope(scope, {path: items[7][0], subsong: 0}), false);
    }};
}

for (const command of ['seek', 'next', 'previous', 'resume']) test(`${command} bounds playlist and native probe reads`, async t => {
  const f = fixture(t, {paused: command === 'resume'});
  await f.service.getState();
  const result = await f.service[command](...(command === 'seek' ? [55] : []));
  const pages = f.calls.map(call => call.route).filter(route => route.startsWith('playlists/list/items/'));
  const fullPages = pages.filter(route => !route.endsWith(':1'));
  const probes = f.probes() - 1;
  t.diagnostic(`command=${command} full-page-reads=${fullPages.length} item-reads=${pages.length - fullPages.length} forced-probes=${probes}`);
  if (command === 'seek') {
    assert.deepEqual(pages, ['playlists/list/items/7:1', 'playlists/list/items/7:1']);
    assert.equal(f.calls.some(call => call.route === 'playqueue' || call.url.searchParams.has('playlists')), false);
    assert.ok(Math.abs(result.position - 55) < 1);
  } else {
    assert.equal(fullPages.length, 9);
    assert.equal(result.state, 'playing');
  }
  assert.equal(probes, 1);
  assert.equal(f.writes().length, 1);
  f.checkReleased();
});

test('guarded seek accepts unrelated playlist or queue edits while its exact occurrence stays put', async t => {
  const f = fixture(t, {totalCount: 50001, editAfterPermit({items, queue}) {items[100][0] = 'C:\\Music\\new.flac'; queue[0].itemIndex++;}});
  await f.service.getState(); await f.service.seek(55);
  assert.equal(f.writes().length, 1);
  f.checkReleased();
});

for (const [name, command, edit] of [
  ['duplicate occurrence', 'seek', ({setIndex}) => setIndex(10)],
  ['same-size replacement', 'seek', ({items}) => {items[7][0] = items[7][0].toLowerCase();}],
  ['noncurrent subsong', 'next', ({items}) => {items[120][1] = '1';}],
  ['queue reference', 'next', ({queue}) => {queue[0].itemIndex++;}],
  ['output selection', 'seek', ({outputs}) => {outputs.active.deviceId = 'different';}],
  ['output selection', 'next', ({outputs}) => {outputs.active.deviceId = 'different';}],
]) test(`${command} refuses a changed ${name} during the final device probe`, async t => {
  const f = fixture(t, {editDuringProbe: edit});
  await f.service.getState();
  await assert.rejects(f.service[command](...(command === 'seek' ? [55] : [])),
    {code: name === 'output selection' ? 'STILL_OUTPUT_CHANGED' : 'STILL_CONTEXT_CHANGED'});
  assert.equal(f.writes().length, 0);
});

test('guarded seek checks the exact selected device after the permit', async t => {
  const f = fixture(t, {editDuringProbe: () => 8});
  await f.service.getState();
  await assert.rejects(f.service.seek(55), {code: 'STILL_OUTPUT_DISCONNECTED'});
  assert.equal(f.writes().length, 0);
});

test('invalid output evidence latches the control lane before a guarded playback write', async t => {
  const f = fixture(t, {editDuringProbe({outputs}) {delete outputs.types;}});
  await f.service.getState();
  await assert.rejects(f.service.next(), {code: 'STILL_BACKEND_INVALID_RESPONSE'});
  assert.equal(f.service.transportStatus().controlUncertain, true);
  assert.equal(f.writes().length, 0);
});

test('slow pagination refreshes expired device evidence before the playback write', async t => {
  const f = fixture(t, {disconnectDuringFinalPage: true});
  await f.service.getState();
  await assert.rejects(f.service.next(), {code: 'STILL_OUTPUT_DISCONNECTED'});
  assert.equal(f.probes(), 3);
  assert.equal(f.writes().length, 0);
});

test('guarded next refuses a candidate subsong changed during a supplemental device probe', async t => {
  const f = fixture(t, {slowAfterProbes: [2], editDuringRefresh(item) {item[1] = '1';}});
  await f.service.getState();
  await assert.rejects(f.service.next(), {code: 'STILL_CONTEXT_CHANGED'});
  assert.equal(f.probes(), 3);
  assert.equal(f.writes().length, 0);
  f.checkReleased();
});

test('guarded next can dispatch after supplemental device and candidate checks succeed', async t => {
  const f = fixture(t, {slowAfterProbes: [2]});
  await f.service.getState();
  assert.equal((await f.service.next()).state, 'playing');
  assert.equal(f.probes(), 3);
  assert.equal(f.calls.filter(call => call.route.startsWith('playlists/list/items/')).length, 12);
  assert.equal(f.writes().length, 1);
  f.checkReleased();
});

for (const [phase, options, probes] of [
  ['the supplemental scan', {slowAfterProbes: [2, 3]}, 3],
  ['the dispatch callback', {expireOnDispatch: true}, 2],
]) test(`guarded next does not write when device evidence expires during ${phase}`, async t => {
  const f = fixture(t, options);
  await f.service.getState();
  await assert.rejects(f.service.next(), {code: 'STILL_OUTPUT_UNKNOWN'});
  assert.equal(f.probes(), probes);
  assert.equal(f.writes().length, 0);
  f.checkReleased();
});

test('connection evidence expires on the monotonic clock while diagnostics keep the wall time', async t => {
  const f = fixture(t);
  const initial = await f.service.getState();
  f.setTime(4999, 100000);
  assert.equal((await f.service.outputConnection()).lastCheckedAt, initial.outputConnection.lastCheckedAt);
  f.setTime(5000, 10);
  assert.equal((await f.service.outputConnection()).lastCheckedAt, new Date(10).toISOString());
  assert.equal(f.probes(), 2);
});

test('wall-clock jumps do not expire the monotonic playback verification window', async t => {
  const f = fixture(t, {paused: true});
  await f.service.getState();
  let wall = Date.now(); t.mock.method(Date, 'now', () => (wall += 60000));
  assert.equal((await f.service.resume()).state, 'playing');
});

test('the session proxy rejects failures through the Promise of a forwarded command', async t => {
  const failure = new Error('Synthetic synchronous bridge failure');
  const info = {available: true, pid: 123, baseUrl: 'http://127.0.0.1:1234/api/', foobarDir: 'C:\\Synthetic'};
  const service = createFoobarSessionService({backend: {getInfo: () => info}, serviceOptions: info,
    createService: () => ({initialize: async () => {}, close: async () => {}, capabilities: () => ({playback: true}),
      play() {throw failure;}, audioDetails() {throw failure;}})});
  t.after(() => service.close());
  assert.deepEqual(service.capabilities(), {playback: true});
  await assert.rejects(service.audioDetails(), failure);
  await service.connect(info);
  await assert.rejects(service.play(), failure);
});
