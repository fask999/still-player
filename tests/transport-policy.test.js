'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// Dependency-injected clocks/fetch/probes only. No listeners, child processes or audio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createFoobarTransport, createShutdownWriteGate, MAX_TRANSPORT_WAIT_MS, boundedMilliseconds} = require('../src/main/foobar-transport');
const {createFoobarService} = require('../src/main/foobar');
const {createOutputConnection} = require('../src/main/foobar-output-connection');
const {createPlaybackCoordinator} = require('../src/main/playback-coordinator');
const {createOwnedDecks} = require('../src/main/foobar-decks');
const {createSyntheticOwnedBackend} = require('./helpers/synthetic-owned-backend');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {let resolve, reject; return {promise: new Promise((a, b) => {resolve = a; reject = b;}), resolve, reject};};
const response = (value, status = 200) => ({ok: status >= 200 && status < 300, status, text: async () => value == null ? '' : JSON.stringify(value)});
function fakeClock() {
  let time = 0, id = 0; const timers = new Map();
  return {now: () => time,
    setTimeout(fn, ms) {const key = ++id; timers.set(key, {at: time + ms, fn}); return key;},
    clearTimeout(key) {timers.delete(key);},
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const due = [...timers].filter(([, row]) => row.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        time = due[1].at; timers.delete(due[0]); due[1].fn(); await tick();
      }
      time = end; await tick();
    }, timers};
}
function transportFixture(options = {}) {
  const clock = fakeClock(), exit = new AbortController(), calls = [];
  const transport = createFoobarTransport({baseUrl: 'http://127.0.0.1:24567/api/', clock, timeoutMs: 999999,
    fenceTimeoutMs: 999999, exitSignal: exit.signal,
    backendExitedError: () => Object.assign(new Error('verified fixture exit'), {code: 'STILL_BACKEND_EXITED'}), ...options,
    fetch: async (url, init) => {calls.push({route: new URL(url).pathname, init}); return options.fetch ? options.fetch(url, init) : response({ready: true});}});
  return {transport, clock, exit, calls};
}

test('POST hard cap preserves the physical body fence; a successful GET cannot clear uncertainty', async () => {
  const body = deferred();
  const f = transportFixture({fetch: async (_url, init) => init.method === 'POST' && !body.done
    ? {ok: true, status: 200, text: () => body.promise} : response({ready: true})});
  let finished = false;
  const old = f.transport.request('player/play', {}).catch(error => error).then(value => {finished = true; return value;});
  await tick(); assert.equal(f.transport.status().pendingControlRequests, 1);
  await f.clock.advance(24999); assert.equal(finished, false);
  await f.clock.advance(1); assert.equal((await old).code, 'STILL_TRANSPORT_UNCERTAIN');
  assert.equal(f.transport.status().pendingControlRequests, 1); assert.equal(f.transport.status().controlUncertain, true);
  assert.equal(f.calls[0].init.signal.aborted, false);
  await f.transport.request('query'); assert.equal(f.transport.status().controlUncertain, true);
  await assert.rejects(f.transport.request('player/stop', {}), {code: 'STILL_TRANSPORT_UNCERTAIN'});
  assert.equal(f.calls.filter(call => call.route.endsWith('/stop')).length, 0);
  body.done = true; body.resolve(''); await tick();
  assert.equal(f.transport.status().controlUncertain, false); assert.equal(f.transport.status().pendingControlRequests, 0);
  await f.transport.request('player/stop', {});
  assert.equal(f.calls.filter(call => call.route.endsWith('/stop')).length, 1);
  assert.equal(MAX_TRANSPORT_WAIT_MS, 25000);
  for (const value of [25001, 1e9]) assert.equal(boundedMilliseconds(value, 4000), 25000);
});

test('queue and preparation deadlines retain their lanes without blocking an independent stop', async () => {
  for (const route of ['playqueue/add', 'playlists/add']) {
    const gate = deferred();
    const f = transportFixture({fetch: async url => new URL(url).pathname.endsWith(route)
      ? {ok: true, status: 200, text: () => gate.promise} : response(null)});
    const writing = f.transport.request(route, {}).catch(error => error); await tick();
    await f.clock.advance(25000); assert.equal((await writing).code, 'STILL_TRANSPORT_UNCERTAIN');
    const lane = route.startsWith('playqueue') ? 'queue' : 'preparation';
    assert.deepEqual(f.transport.status().uncertainLanes, [lane]);
    await f.transport.request('player/stop', {});
    await assert.rejects(f.transport.request(route, {}), {code: 'STILL_TRANSPORT_UNCERTAIN'});
    let drained = false; const draining = f.transport.drain().then(() => {drained = true;});
    await tick(); assert.equal(drained, false);
    gate.resolve(''); await draining;
    assert.deepEqual(f.transport.status().uncertainLanes, []);
  }
});

test('every fence wait is capped at 25 seconds, retains actual work and expires its dispatch ticket', async () => {
  const f = transportFixture(), gate = deferred(); let expired = false, done = false;
  const waiting = f.transport.waitForFence(gate.promise, {onTimeout() {expired = true;}}).catch(error => error).then(value => {done = true; return value;});
  await f.clock.advance(24999); assert.equal(done, false);
  await f.clock.advance(1); assert.equal((await waiting).code, 'STILL_TRANSPORT_UNCERTAIN');
  assert.equal(expired, true); gate.resolve(); await tick();
  assert.equal(f.clock.timers.size, 0);
});

test('actual network failure remains latched after good reads and never exports provider error text', async () => {
  const f = transportFixture({fetch: async (_url, init) => {
    if (init.method === 'POST') throw new Error('PRIVATE_BEARER_SECRET'); return response({ready: true});
  }});
  await assert.rejects(f.transport.request('player/play', {}), error => error.code === 'STILL_TRANSPORT_UNCERTAIN' && !error.message.includes('PRIVATE'));
  await f.transport.request('query'); assert.equal(f.transport.status().controlUncertain, true);
  assert.equal(JSON.stringify(f.transport.status()).includes('PRIVATE'), false);
  await assert.rejects(f.transport.request('player/stop', {}), {code: 'STILL_TRANSPORT_UNCERTAIN'});
});

test('provider exceptions cannot forge a public STILL code to export raw error text', async () => {
  for (const atBody of [false, true]) {
    const failure = () => {throw Object.assign(new Error('PRIVATE_PROVIDER_TOKEN'), {code: 'STILL_TRANSPORT_UNCERTAIN'});};
    const f = transportFixture({fetch: async () => atBody ? {ok: true, status: 200, text: failure} : failure()});
    await assert.rejects(f.transport.request('player/play', {}), error => error.code === 'STILL_TRANSPORT_UNCERTAIN' && !error.message.includes('PRIVATE'));
    assert.equal(f.transport.status().controlUncertain, true);
  }
  const f = transportFixture({fetch: async () => ({ok: false, status: 'PRIVATE_STATUS_SECRET', text: async () => ''})});
  await assert.rejects(f.transport.request('query'), error => error.code === 'STILL_BACKEND_INVALID_RESPONSE' && !error.message.includes('PRIVATE'));
});

for (const method of ['GET', 'POST']) for (const status of [401, 403, 302]) test(`${method} ${status} fails at headers while a POST keeps its body fence`, async () => {
  const body = deferred(), notices = []; let denied = true, bodyRead = false;
  const f = transportFixture({onSafetyError: error => notices.push(error.code), fetch: async () => denied
    ? {ok: false, status, text() {bodyRead = true; return body.promise;}} : response({ready: true})});
  const writing = f.transport.request(method === 'POST' ? 'player/play' : 'query', method === 'POST' ? {} : undefined).catch(error => error);
  await tick(); const error = await writing;
  assert.equal(error.code, status === 302 ? 'STILL_BACKEND_REDIRECT_REJECTED' : 'STILL_BACKEND_ACCESS_DENIED');
  assert.equal(notices.length, 1); assert.equal(f.transport.status().controlUncertain, true);
  assert.equal(bodyRead, method === 'POST');
  assert.equal(f.transport.status().pendingControlRequests, method === 'POST' ? 1 : 0);
  assert.equal(f.calls[0].init.signal.aborted, method === 'GET');
  denied = false; await f.transport.request('query'); assert.equal(f.transport.status().controlUncertain, true);
  if (method === 'POST') {body.resolve('PRIVATE_HTTP_BODY_SECRET'); await tick(); assert.equal(f.transport.status().pendingControlRequests, 0);}
  assert.equal(f.transport.status().controlUncertain, true);
  await assert.rejects(f.transport.request('player/stop', {}), {code: 'STILL_TRANSPORT_UNCERTAIN'});
});

test('a redirected adapter response and invalid JSON are safety errors rather than degraded reads', async () => {
  for (const reply of [{ok: true, status: 200, redirected: true, text: async () => '{}'},
    {ok: true, status: 200, text: async () => 'PRIVATE_NOT_JSON_SECRET'}]) {
    const f = transportFixture({fetch: async () => reply});
    await assert.rejects(f.transport.request('query'), error => ['STILL_BACKEND_REDIRECT_REJECTED', 'STILL_BACKEND_INVALID_RESPONSE'].includes(error.code) && !error.message.includes('PRIVATE'));
    assert.equal(f.transport.status().controlUncertain, true);
  }
});

const ENDPOINT = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}';
const DEVICE = '0DD9B977-765B-4804-BF2D-B28EBF0C510D:016F9F0C-AFE4-4072-9018-CCEBB576B4CB';
const connectionEvidence = () => ({endpoint: ENDPOINT, operation: 'GetState', mode: 'state', deviceFound: true, state: 1, active: true,
  hresult: '0x00000000', clientActivated: false, initializeCalled: false, startCalled: false, actualDacRate: null});
test('GetState observations expire at 5 seconds, coalesce and discard late invalidated results', async () => {
  let time = 0, calls = 0, held = null;
  const output = {typeId: 'output', deviceId: DEVICE};
  const observer = createOutputConnection({getSelected: () => output, getOutputs: () => ({active: output}),
    endpointForOutput: () => ENDPOINT, isClosed: () => false, now: () => time,
    probeOutputState: async () => {calls++; if (held) return held.promise; return connectionEvidence();}});
  const first = await observer.refresh(); assert.equal(calls, 1);
  time = 4999; assert.equal((await observer.refresh()).lastCheckedAt, first.lastCheckedAt); assert.equal(calls, 1);
  time = 5000; await observer.refresh(); assert.equal(calls, 2);
  held = deferred(); const slow = observer.refresh({force: true}); await tick();
  const same = observer.refresh({force: true}); await tick(); assert.equal(calls, 3);
  observer.invalidate({selectionChanged: true}); held.resolve({...connectionEvidence(), active: false, state: 4});
  await Promise.all([slow, same]); assert.equal(observer.snapshot().status, 'unknown');
  held = null; await observer.refresh(); assert.equal(calls, 4); assert.equal(observer.snapshot().status, 'connected');
  observer.invalidate(); await observer.refresh(); assert.equal(calls, 5);
  assert.equal(observer.snapshot().actualDacRate, null); observer.close();
});

async function serviceFixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'still-transport-policy-'));
  let failure = null, identity = 'foobar2000', position = 17, mode = 'playing', hook = null;
  const calls = [], diagnostics = [], probes = [];
  const output = {typeId: 'output', deviceId: DEVICE};
  const fetch = async (url, init) => {
    const route = new URL(url).pathname.replace('/api/', ''); calls.push({route, init});
    if (hook) await hook(route, init);
    if (failure) return response({token: 'PRIVATE_HTTP_BODY_SECRET'}, failure);
    if (init.method === 'POST') {
      if (route === 'player/stop') mode = 'stopped'; if (route === 'player/pause') mode = 'paused';
      if (route === 'playlists/add') return response({id: 'deck', title: JSON.parse(init.body).title});
      return response(null);
    }
    if (route === 'playqueue') return response({playQueue: [{playlistId: 'user', itemIndex: 0, columns: ['C:\\Music\\fixture.wav', '0', 'Fixture']}]});
    if (route === 'playlists') return response({playlists: [{id: 'user', title: 'User', itemCount: 1}]});
    if (/\/items\/\d+:\d+$/.test(route)) return response({playlistItems: {offset: 0, totalCount: 1,
      items: [{columns: ['C:\\Music\\fixture.wav', '0', 'Fixture']}]}});
    return response({player: {info: {name: identity, pluginVersion: '0.10'}, playbackState: mode,
      activeItem: {playlistId: 'user', index: 0, position, duration: 100, columns: ['C:\\Music\\fixture.wav', '0', 'Fixture']},
      volume: {type: 'db', min: -100, max: 0, value: 0}}, outputs: {active: output,
        types: [{id: 'output', name: 'WASAPI', devices: [{id: DEVICE, name: 'Fixture DAC [exclusive]'}]}]}});
  };
  const service = createFoobarService({dataDir, fetch, baseUrl: 'http://127.0.0.1:24567/api/', pollIntervalMs: 0,
    persistOutputSelection: false, cleanupDelayMs: 60000, probeOutputState: async () => {probes.push(1); return connectionEvidence();}, ...options});
  service.on('diagnostic', value => diagnostics.push(value));
  t.after(async () => {await service.close(); await fs.rm(dataDir, {recursive: true, force: true});});
  return {service, calls, diagnostics, probes, setFailure: value => {failure = value;}, setIdentity: value => {identity = value;},
    setPosition: value => {position = value;}, setDevice: value => {output.deviceId = value;}, setHook: value => {hook = value;}};
}

test('two transient reads preserve last good state as stale; third is offline and good read recovers', async t => {
  const f = await serviceFixture(t); const good = await f.service.getState(); f.setFailure(503);
  for (let count = 1; count <= 2; count++) {
    const degraded = await f.service.getState(); assert.equal(degraded.connectionStatus, 'degraded');
    assert.equal(degraded.stale, true); assert.equal(degraded.available, true); assert.equal(degraded.backendReachable, false);
    assert.equal(degraded.position, good.position); assert.equal(degraded.lastGoodAt, good.readAt);
    assert.equal(degraded.consecutiveReadFailures, count); assert.equal(f.service.capabilities().playback, false);
  }
  const offline = await f.service.getState(); assert.equal(offline.connectionStatus, 'offline'); assert.equal(offline.available, false);
  assert.equal(offline.consecutiveReadFailures, 3); assert.equal(offline.lastGoodAt, good.readAt);
  assert.equal(JSON.stringify(f.diagnostics).includes('PRIVATE'), false);
  f.setFailure(null); f.setPosition(19); const recovered = await f.service.getState();
  assert.equal(recovered.connectionStatus, 'connected'); assert.equal(recovered.stale, false); assert.equal(recovered.position, 19);
  assert.equal(recovered.consecutiveReadFailures, 0);
});

for (const failure of ['identity', 401, 403]) test(`${failure} immediately fails closed without stale playback or diagnostic body`, async t => {
  const f = await serviceFixture(t); await f.service.getState();
  if (failure === 'identity') f.setIdentity('untrusted port'); else f.setFailure(failure);
  const offline = await f.service.getState(); assert.equal(offline.available, false); assert.equal(offline.connectionStatus, 'offline');
  assert.equal(offline.stale, false); assert.equal(f.service.capabilities().playback, false);
  f.setFailure(null); f.setIdentity('foobar2000');
  assert.equal((await f.service.getState()).available, false);
  await assert.rejects(f.service.stop(), {code: failure === 'identity' ? 'STILL_BACKEND_IDENTITY_MISMATCH' : 'STILL_BACKEND_ACCESS_DENIED'});
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0);
  assert.equal(JSON.stringify(f.diagnostics).includes('PRIVATE'), false);
});

test('stop, explicit retry and an endpoint change invalidate GetState without fabricating playback progress', async t => {
  let time = 0;
  const f = await serviceFixture(t, {clock: {now: () => time}}); const good = await f.service.getState();
  const before = f.calls.length; await f.service.outputConnection(); await f.service.outputConnection();
  assert.equal(f.calls.length, before); assert.equal(f.probes.length, 1);
  f.setPosition(99); const observed = await f.service.outputConnection(); assert.equal(observed.actualDacRate, null);
  assert.equal(good.position, 17); assert.equal(f.probes.length, 1);
  time = 4999; await f.service.outputConnection(); assert.equal(f.probes.length, 1);
  time = 5000; await f.service.outputConnection(); assert.equal(f.probes.length, 2);
  await f.service.stop(); assert.equal(f.probes.length, 3);
  const stoppedCalls = f.calls.length; await f.service.retryOutput(); assert.equal(f.probes.length, 4);
  assert.equal(f.calls.slice(stoppedCalls).some(call => call.init.method === 'POST'), false);
  f.setDevice('0DD9B977-765B-4804-BF2D-B28EBF0C510D:11111111-2222-3333-4444-555555555555');
  const changed = await f.service.getState(); assert.equal(f.probes.length, 5);
  assert.equal(changed.outputConnection.selectionMatches, false); assert.equal(changed.outputConnection.output.deviceId, DEVICE);
});

test('a late healthy read cannot reopen state after a concurrent identity mismatch', async t => {
  const f = await serviceFixture(t); await f.service.getState();
  const hold = deferred(), entered = deferred(); let once = false;
  f.setHook(async route => {if (route === 'query' && !once) {once = true; entered.resolve(); await hold.promise;}});
  const old = f.service.getState(); await entered.promise;
  f.setIdentity('wrong identity'); assert.equal((await f.service.getState()).available, false);
  f.setIdentity('foobar2000'); hold.resolve(); assert.equal((await old).available, false);
  assert.equal(f.service.transportStatus().controlUncertain, true);
});

test('identity mismatch publishes and returns fail-closed state without waiting for a hung connection observation', async t => {
  const held = deferred(); let time = 0, holdProbe = false;
  const f = await serviceFixture(t, {clock: {now: () => time}, probeOutputState: () => holdProbe ? held.promise : connectionEvidence()});
  await f.service.getState(); time = 5000; holdProbe = true; f.setIdentity('untrusted port');
  let done = false;
  const reading = f.service.getState().then(value => {done = true; return value;});
  try {
    await tick(); assert.equal(done, true);
    const value = await reading; assert.equal(value.available, false); assert.equal(value.controlUncertain, true);
  } finally {held.resolve(connectionEvidence()); await reading;}
});

test('failure threshold injection is bounded from 1 to 10', async t => {
  for (const [configured, expected] of [[0, 1], [100, 10]]) {
    const f = await serviceFixture(t, {readFailureThreshold: configured}); await f.service.getState(); f.setFailure(503);
    for (let count = 1; count < expected; count++) assert.equal((await f.service.getState()).connectionStatus, 'degraded');
    assert.equal((await f.service.getState()).connectionStatus, 'offline');
  }
});

test('a never-settling injected GetState read has a bounded observation deadline without audio evidence', async () => {
  const clock = fakeClock(); let signal;
  const output = {typeId: 'output', deviceId: DEVICE};
  const observer = createOutputConnection({getSelected: () => output, getOutputs: () => ({active: output}),
    endpointForOutput: () => ENDPOINT, isClosed: () => false, clock, now: clock.now, timeoutMs: 1e9,
    probeOutputState: value => {signal = value.signal; return new Promise(() => {});}});
  let done = false; const observation = observer.refresh().then(value => {done = true; return value;}); await tick();
  await clock.advance(4999); assert.equal(done, false);
  await clock.advance(1); const value = await observation; assert.equal(value.status, 'unknown');
  assert.equal(signal.aborted, true); assert.equal(value.actualDacRate, null); assert.equal(value.evidence, undefined);
});

test('a stop admission that expires before old physical settlement never dispatches late', async t => {
  const clock = fakeClock(), held = deferred(), entered = deferred();
  const f = await serviceFixture(t, {clock, timeoutMs: 25000, fenceTimeoutMs: 20});
  f.setHook(async route => {if (route === 'player/pause') {entered.resolve(); await held.promise;}});
  const pause = f.service.pause().catch(error => error); await entered.promise;
  const stop = f.service.stop().catch(error => error); await tick();
  await clock.advance(20); assert.equal((await stop).code, 'STILL_TRANSPORT_UNCERTAIN');
  assert.equal((await pause).code, 'STILL_CANCELLED');
  assert.equal(f.service.transportStatus().pendingControlRequests, 1);
  assert.throws(() => f.service.markBackendExited({exited: true, owned: true, verified: true}), /未匹配/);
  assert.equal(f.service.transportStatus().pendingControlRequests, 1);
  held.resolve(); await tick(); await tick();
  assert.equal(f.calls.some(call => call.route === 'player/stop'), false);
  assert.equal(f.service.transportStatus().controlUncertain, false);
  await f.service.stop(); assert.equal(f.calls.filter(call => call.route === 'player/stop').length, 1);
});

test('cancel and disposal waits cap at 25 seconds while retaining a physical POST after timeout', async t => {
  const clock = fakeClock(), held = deferred(), entered = deferred();
  const f = await serviceFixture(t, {clock, timeoutMs: 1e9, fenceTimeoutMs: 1e9});
  f.setHook(async route => {if (route === 'player/pause') {entered.resolve(); await held.promise;}});
  const pause = f.service.pause().catch(error => error); await entered.promise;
  const cancelling = f.service.cancelPending().catch(error => error);
  const closing = f.service.close().catch(error => error);
  await clock.advance(25000);
  assert.equal((await cancelling).code, 'STILL_TRANSPORT_UNCERTAIN');
  assert.equal((await closing).code, 'STILL_TRANSPORT_UNCERTAIN');
  assert.equal((await pause).code, 'STILL_CANCELLED'); assert.equal(f.service.transportStatus().pendingControlRequests, 1);
  assert.equal(f.calls.find(call => call.route === 'player/pause').init.signal.aborted, false);
  held.resolve(); await tick(); await f.service.close(); assert.equal(f.service.transportStatus().pendingControlRequests, 0);
});

test('shutdown quiesces a queue removal held in GET, retains read-only diagnostics and rejects non-owned stop', async t => {
  const f = await serviceFixture(t), held = deferred(), entered = deferred();
  f.setHook(async route => {if (route === 'playqueue') {entered.resolve(); await held.promise;}});
  const removing = f.service.queueRemove(0).catch(error => error); await entered.promise;
  const shutdown = f.service.beginShutdownWrites(); assert.equal(f.service.beginShutdownWrites(), shutdown);
  assert.equal(f.service.transportStatus().writesQuiesced, true);
  held.resolve(); assert.equal((await removing).code, 'STILL_SHUTDOWN_WRITES_CLOSED');
  await assert.rejects(shutdown.stop(), {code: 'STILL_SHUTDOWN_NOT_OWNED'});
  await assert.rejects(f.service.stop(), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
  assert.equal((await f.service.getState()).available, true); assert.equal(f.service.capabilities().playback, false);
});

for (const kind of ['create', 'copy']) test(`shutdown keeps an already-dispatched ${kind} fence but prevents its late play`, async t => {
  const f = await serviceFixture(t), held = deferred(), entered = deferred();
  f.setHook(async (route, init) => {if (init.method === 'POST' && (kind === 'create' ? route === 'playlists/add' : route.endsWith('/items/copy'))) {
    entered.resolve(); await held.promise;
  }});
  const playing = f.service.play({paths: ['C:\\Music\\fixture.wav']}).catch(error => error); await entered.promise;
  f.service.beginShutdownWrites(); assert.equal((await playing).code, 'STILL_CANCELLED');
  assert.equal(f.service.transportStatus().pendingPreparationRequests, 1);
  const posted = f.calls.filter(call => call.init.method === 'POST');
  assert.equal(posted.at(-1).init.signal.aborted, false);
  held.resolve(); await tick(); await tick();
  assert.equal(f.service.transportStatus().pendingPreparationRequests, 0);
  assert.equal(f.calls.some(call => /^player\/play/.test(call.route)), false);
  await f.service.cleanupOwnedDecks();
  assert.equal(f.calls.some(call => /^playlists\/remove/.test(call.route)), false);
});

test('shutdown stop permit is private, once-only and survives coordinator cancellation for the same owned bridge', async t => {
  const owned = await createSyntheticOwnedBackend(t, {port: 24567});
  const f = await serviceFixture(t, {foobarDir: owned.backendDir, baseUrl: owned.info.baseUrl, backendSession: owned.session});
  await f.service.getState(); const shutdown = f.service.beginShutdownWrites();
  const coordinator = createPlaybackCoordinator({engines: {local: f.service}});
  coordinator.beginShutdown();
  assert.equal((await shutdown.stop()).state, 'stopped');
  await assert.rejects(shutdown.stop(), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  await assert.rejects(f.service.play({paths: ['C:\\Music\\fixture.wav']}), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  await assert.rejects(f.service.queueClear(), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  assert.deepEqual(f.calls.filter(call => call.init.method === 'POST').map(call => call.route), ['player/stop']);
  assert.equal(f.service.transportStatus().writesQuiesced, true); await coordinator.close();
});

test('shutdown dispatch gate rejects old create/copy/cleanup/play microtasks and cannot be forged for stop', async () => {
  for (const route of ['playlists/add', 'playlists/user/deck/items/copy', 'playlists/remove/deck', 'player/play/user/0']) {
    const gate = createShutdownWriteGate({isOwned: () => true, onQuiesce() {}, stop() {throw new Error('not invoked');}});
    const f = transportFixture({beforeDispatch(route, body, extra) {if (body !== undefined) gate.assert(route, extra);}});
    const old = f.transport.request(route, {}).catch(error => error); gate.begin();
    assert.equal((await old).code, 'STILL_SHUTDOWN_WRITES_CLOSED'); assert.equal(f.calls.length, 0);
    await assert.rejects(f.transport.request('player/stop', {}, {shutdownPermit: {}}), {code: 'STILL_SHUTDOWN_WRITES_CLOSED'});
  }
});

test('cleanup held at its last reference read cannot delete a deck after shutdown quiescence', async () => {
  const held = deferred(), entered = deferred(), writes = [];
  const identity = {instanceId: '11111111-2222-4333-8444-555555555555'}, title = `STILL · Playback fixture [${identity.instanceId}]`;
  const lists = [{id: 'old-deck', title, itemCount: 1}]; let queries = 0;
  const gate = createShutdownWriteGate({isOwned: () => false, onQuiesce() {}, stop() {}});
  const request = async (route, body, extra) => {
    if (body !== undefined) {gate.assert(route, extra); writes.push(route); return null;}
    if (++queries === 2) {entered.resolve(); await held.promise;}
    return {player: {activeItem: null}, playQueue: []};
  };
  const decks = createOwnedDecks({request, checkPlayer() {}, playlists: async () => lists, sourceCache: new Map(),
    getIdentity: () => identity, getTransport: () => Promise.resolve(), getTransportFault: () => null,
    isClosed: () => gate.quiesced, hasHandoff: () => false, options: {keepDecks: 0, cleanupDelayMs: 60000}, notifyError() {}});
  const cleanup = decks.cleanupOwnedDecks().catch(error => error); await entered.promise;
  gate.begin(); decks.cancelTimer(); held.resolve(); assert.equal((await cleanup).code, 'STILL_SHUTDOWN_WRITES_CLOSED');
  assert.deepEqual(writes, []); assert.equal(decks.ownedDecks.has('old-deck'), true);
});

test('coordinator cross-engine barrier is capped and cannot execute a late engine start', async () => {
  const clock = fakeClock(), gate = deferred(), calls = [];
  const local = {getState: async () => ({available: true, state: 'playing'}), cancelPending: () => gate.promise,
    stop: async () => calls.push('stop'), releaseOutput: async () => ({released: true})};
  const apple = {getState: async () => ({available: true, state: 'stopped'}), cancelPending() {}, play: async () => calls.push('apple-play')};
  const coordinator = createPlaybackCoordinator({engines: {local, apple}, clock, fenceTimeoutMs: 1e9});
  await coordinator.getState(); const playing = coordinator.play({source: 'apple', input: {}}).catch(error => error); await tick();
  await clock.advance(24999); assert.deepEqual(calls, []);
  await clock.advance(1); assert.equal((await playing).code, 'STILL_TRANSPORT_UNCERTAIN');
  gate.resolve(); await tick(); assert.deepEqual(calls, []); await coordinator.close();
});
