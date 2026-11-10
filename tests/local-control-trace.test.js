'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {createFoobarTransport} = require('../src/main/foobar-transport');
const {createFoobarService} = require('../src/main/foobar');
const {createRuntimeLog, sanitizeRuntimeLog} = require('../src/main/runtime-log');
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (value = null) => ({ok: true, status: value === null ? 204 : 200, text: async () => value === null ? '' : JSON.stringify(value)});
const context = () => ({id: 7, pendingPosts: new Set(), check() {}});
function transport(options = {}) {
  return createFoobarTransport({baseUrl: 'http://127.0.0.1:19341/api/', fetch: async () => response(),
    backendExitedError: () => Object.assign(new Error('Exited'), {code: 'STILL_BACKEND_EXITED'}), ...options});
}

for (const failure of ['throw', 'reject', 'frozen-mutation']) test(`trace observer ${failure} never changes a physical request or response`, async () => {
  const events = [], calls = [];
  const bridge = transport({fetch: async (url, init) => {calls.push({url: String(url), method: init.method}); return response();},
    onControlTrace: event => {
      events.push({...event});
      if (failure === 'throw') throw new Error('SECRET_OBSERVER');
      if (failure === 'reject') return Promise.reject(new Error('SECRET_OBSERVER'));
      event.phase = 'SECRET_OBSERVER';
    }});
  assert.equal(await bridge.request('player/play/SECRET_PLAYLIST/3', {token: 'SECRET_PAYLOAD'}, {context: context()}), null);
  await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'POST');
  assert.deepEqual(events.map(event => event.phase), ['dispatch', 'headers', 'settled']);
  assert.equal(events.every(event => event.operation === 'play-item'), true);
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
  assert.equal(bridge.status().controlUncertain, false);
});

test('only physical writes are traced; GET polling cannot evict play/remove evidence', async () => {
  const events = [], calls = [], ctx = context();
  let mono = 10;
  const bridge = transport({clock: {monotonicNow: () => mono}, fetch: async (url, init) => {
    calls.push(init.method); mono += 2; return response(init.method === 'GET' ? {} : null);
  }, onControlTrace: event => events.push(event)});
  const routes = [['player/play/p1/0', 'play-item'], ['player/stop', 'stop'], ['player/pause', 'pause'],
    ['player/next', 'next'], ['player/previous', 'previous'], ['outputs/active', 'output'],
    ['playlists/add', 'playlist-create'], ['playlists/remove/SECRET_ID', 'playlist-remove'],
    ['playlists/SECRET_SOURCE/SECRET_DEST/items/copy', 'playlist-copy'], ['playlists/p1/items/add', 'playlist-add-items'],
    ['playqueue/clear', 'queue-clear'], ['player', 'other-write']];
  for (const [route, operation] of routes) {
    await bridge.request(route, {}, {context: ctx});
    assert.equal(events.at(-1).operation, operation);
  }
  const before = events.length;
  for (let index = 0; index < 250; index++) await bridge.request('player');
  assert.equal(events.length, before); assert.equal(calls.filter(method => method === 'GET').length, 250);
  const ids = events.filter(event => event.phase === 'dispatch').map(event => event.requestId);
  assert.equal(ids.every((id, index) => !index || id > ids[index - 1]), true);
  assert.equal(events.every(event => Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0), true);
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
});

test('trace dispatch is observed after the final admission check and actual fetch invocation', async () => {
  const order = [];
  const bridge = transport({beforeDispatch: () => order.push('admit'), fetch: async () => {order.push('fetch'); return response();},
    onControlTrace: event => {if (event.phase === 'dispatch') order.push('trace');}});
  await bridge.request('player/stop', {}, {context: context()});
  const invoked = order.indexOf('fetch');
  assert.equal(order[invoked - 1], 'admit'); assert.equal(order[invoked + 1], 'trace');
});

test('a pre-dispatch cancellation produces no physical-dispatch trace', async () => {
  const events = []; let admitted = 0, calls = 0;
  const bridge = transport({beforeDispatch: () => {if (++admitted > 1) throw Object.assign(new Error('Cancelled'), {code: 'STILL_CANCELLED'});},
    fetch: async () => {calls++; return response();}, onControlTrace: event => events.push(event)});
  await assert.rejects(bridge.request('player/stop', {}, {context: context()}), {code: 'STILL_CANCELLED'});
  assert.equal(calls, 0); assert.deepEqual(events, []);
});

test('an injectable trace clock cannot dispatch a POST after it cancels the intent', async () => {
  const events = []; let cancelled = false, calls = 0;
  const bridge = transport({clock: {monotonicNow: () => {cancelled = true; return 1;}},
    beforeDispatch: () => {if (cancelled) throw Object.assign(new Error('Cancelled'), {code: 'STILL_CANCELLED'});},
    fetch: async () => {calls++; return response();}, onControlTrace: event => events.push(event)});
  await assert.rejects(bridge.request('player/stop', {}, {context: context()}), {code: 'STILL_CANCELLED'});
  assert.equal(calls, 0); assert.deepEqual(events, []);
});

test('trace context getters and invalid monotonic values never affect the request or leak data', async () => {
  const events = [], ctx = context(); let reads = 0;
  Object.defineProperty(ctx, 'id', {get() {reads++; throw new Error('SECRET_CONTEXT');}});
  const bridge = transport({clock: {monotonicNow: () => NaN}, onControlTrace: event => events.push(event)});
  await bridge.request('player/stop', {}, {context: ctx});
  assert.equal(reads, 0); assert.equal(events.length, 3);
  assert.equal(events.some(event => Object.hasOwn(event, 'elapsedMs') || Object.hasOwn(event, 'contextId')), false);
  assert.equal(JSON.stringify(events).includes('SECRET'), false);
});

test('runtime trace sanitization preserves only enum and bounded integer data without invoking getters', () => {
  let reads = 0;
  const log = createRuntimeLog({sink: () => {}, now: () => 123});
  const hostile = {operation: 'SECRET_ROUTE', phase: 'SECRET_ERROR', requestId: Infinity, contextId: -1, status: 700,
    elapsedMs: NaN, timeoutMs: -1, route: 'SECRET_PATH', payload: 'SECRET_TOKEN', headers: 'SECRET_HEADERS', error: 'SECRET_EXCEPTION'};
  for (const key of ['operation', 'phase', 'requestId']) Object.defineProperty(hostile, key, {get() {reads++; throw new Error('SECRET_GETTER');}});
  log.record('local-control-trace', hostile);
  log.record('local-control-trace', {operation: 'playlist-remove', phase: 'dispatch', requestId: 2, contextId: 7, status: 204, elapsedMs: 3, timeoutMs: 8000});
  const saved = sanitizeRuntimeLog(log.snapshot());
  assert.equal(reads, 0); assert.equal(JSON.stringify(saved).includes('SECRET'), false);
  assert.equal(saved.entries[1].operation, 'playlist-remove'); assert.equal(saved.entries[1].phase, 'dispatch');
  assert.equal(saved.entries[1].requestId, 2); assert.equal(saved.entries[1].elapsedMs, 3); assert.equal(saved.entries[1].level, 'debug');
  for (let index = 0; index < 210; index++) log.record('local-control-trace', {operation: 'stop', phase: 'dispatch', requestId: index + 3});
  assert.equal(log.snapshot().entries.length, 200); assert.equal(log.snapshot().dropped, 12);
});

async function serviceFixture(t, {timeout = false} = {}) {
  const {root, parent} = createCanonicalTemp('still-local-trace-');
  const events = [], order = [], methods = []; let mono = 0, playing = false, position = 0, releaseBody, headers;
  const body = new Promise(resolve => {releaseBody = resolve;});
  const headerSeen = new Promise(resolve => {headers = resolve;});
  const service = createFoobarService({dataDir: root, foobarDir: root, baseUrl: 'http://127.0.0.1:19341/api/',
    pollIntervalMs: 0, persistOutputSelection: false, verifyTimeoutMs: 20, verifyPollMs: 1, clock: {monotonicNow: () => mono},
    onControlTrace: event => {events.push(event); order.push(event.phase); if (event.phase === 'headers') headers();},
    fetch: async (_url, init) => {
      methods.push(init.method); mono += 5;
      if (init.method === 'POST') return {ok: true, status: 204, text: async () => {
        await body; playing = !timeout; mono = 200; order.push('physical-body-finished'); return '';
      }};
      if (playing) position += 0.05;
      return response({player: {info: {name: 'foobar2000', pluginVersion: '0.10'}, playbackState: playing ? 'playing' : 'stopped',
        activeItem: {playlistId: 'p1', index: 0, position, duration: 240, columns: ['C:\\Music\\a.flac', '0', 'Synthetic', '', '', '240']},
        volume: {type: 'db', min: -100, max: 0, value: -18}, options: [{id: 'playbackOrder', type: 'enum', value: 0, enumNames: ['Default']}]},
      outputs: {active: {typeId: 'output', deviceId: 'synthetic-device'}, types: [{id: 'output', name: 'Output', devices: [{id: 'synthetic-device', name: 'Synthetic'}]}]}});
    }});
  t.after(async () => {releaseBody(); await service.close(); assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('still-local-trace-')); await fs.rm(root, {recursive: true, force: true});});
  await service.initialize();
  return {service, events, order, methods, releaseBody, headerSeen};
}

test('verification tracing begins only after the play POST body resolves and retains the original verification budget', async t => {
  const f = await serviceFixture(t), playing = f.service.toggle(); playing.catch(() => {});
  await f.headerSeen;
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.events.some(event => event.phase.startsWith('verify-')), false);
  f.releaseBody(); await playing;
  const first = f.events.find(event => event.phase === 'verify-start'), complete = f.events.find(event => event.phase === 'verify-complete');
  assert.equal(first.timeoutMs, 20); assert.equal(first.elapsedMs, 0); assert.ok(complete.elapsedMs >= 5);
  assert.ok(f.order.indexOf('physical-body-finished') < f.order.indexOf('settled'));
  assert.ok(f.order.indexOf('settled') < f.order.indexOf('verify-start'));
  assert.equal(first.requestId, complete.requestId); assert.equal(first.operation, 'resume');
  assert.equal(f.methods.filter(method => method === 'POST').length, 1);
});

test('a verification timeout is diagnosed without adding a stop, retry or output write', async t => {
  const f = await serviceFixture(t, {timeout: true}), playing = f.service.toggle(); playing.catch(() => {});
  await f.headerSeen; f.releaseBody();
  await assert.rejects(playing, /后端未确认目标曲目正在播放且时间前进/);
  assert.deepEqual(f.events.filter(event => event.phase.startsWith('verify-')).map(event => event.phase), ['verify-start', 'verify-timeout']);
  assert.equal(f.events.some(event => event.operation === 'stop' || event.operation === 'output'), false);
  assert.equal(f.methods.filter(method => method === 'POST').length, 1);
});
