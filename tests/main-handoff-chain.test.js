'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {isVerifiedBackendChildExit} = require('../src/main/backend');
const {createFoobarSessionService} = require('../src/main/foobar-session');
const {createPlaybackCoordinator} = require('../src/main/playback-coordinator');
const {createHandlers, prepareLocalPlaybackLifecycle, verifyAppleOutputRelease} = require('../src/main/main');
const {createAppleAdapter} = require('../src/main/ipc-handlers');
const {mainCoreFixture} = require('./helpers/main-core-fixture');
const {syntheticOfficialAppleHost} = require('./helpers/synthetic-official-apple-host');

test('latest Apple play waits for its cancelled predecessor to release the local handoff lease', async t => {
  const entered = Promise.withResolvers(), allowCleanup = Promise.withResolvers();
  const events = [], stopped = {available: true, state: 'stopped'};
  let localState = 'playing', appleState = 'stopped', snapshots = 0;
  const sessionInfo = {available: true, foobarDir: path.resolve(__dirname, 'synthetic-handoff'),
    baseUrl: 'http://127.0.0.1:18880/api/', pid: 777};
  const local = createFoobarSessionService({backend: {getInfo: () => sessionInfo}, serviceOptions: sessionInfo,
    createService: () => ({
      initialize: async () => ({available: true, state: localState}),
      getState: async () => ({available: true, state: localState}),
      cancelPending: async () => {}, close: async () => {},
      async acquireOutputHandoff() {
        const n = ++snapshots;
        events.push(`snapshot ${n}`);
        if (n === 1) {entered.resolve(); await allowCleanup.promise;}
        return {release: () => events.push(`cleanup ${n}`)};
      },
      async stop() {events.push('stop'); localState = 'stopped'; return stopped;},
      async releaseOutput() {assert.equal(localState, 'stopped'); events.push('release proof'); return {released: true};}
    })});
  const apple = {getState: async () => ({available: true, state: appleState}),
    async play(id) {events.push(`play ${id}`); appleState = 'playing';}};
  const coordinator = createPlaybackCoordinator({engines: {local, apple}});
  t.after(async () => {allowCleanup.resolve(); await coordinator.close(); await local.close();});
  await local.connect(sessionInfo);
  const first = coordinator.play({source: 'apple', input: 'A'});
  const cancelled = assert.rejects(first, {code: 'STILL_CANCELLED'});
  await entered.promise;
  const latest = coordinator.play({source: 'apple', input: 'B'});
  latest.catch(() => {});
  await cancelled;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['snapshot 1']);
  allowCleanup.resolve();
  assert.equal((await latest).source, 'apple');
  assert.deepEqual(events, ['snapshot 1', 'cleanup 1', 'snapshot 2', 'stop', 'release proof', 'play B', 'cleanup 2']);
});

test('main guard and real core classes consume a true child-exit proof on a cancelled standby owner without a dead-source GET', async t => {
  let release, entered; const exitGate = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
  const f = await mainCoreFixture(t, {exitGate, onExit: entered});
  const first = f.coordinator.play({source: 'apple'}), failure = first.catch(error => error);
  await started; const cancelled = f.coordinator.cancelPending(); assert.equal((await failure).code, 'STILL_CANCELLED'); assert.equal(f.appleStarts(), 0);
  release(); await cancelled; await new Promise(resolve => setImmediate(resolve));
  assert.equal(isVerifiedBackendChildExit(f.manager.getExitEvidence(f.session), f.session), true);
  const before = f.calls.length;
  assert.equal((await f.coordinator.play({source: 'apple'})).source, 'apple'); assert.equal(f.appleStarts(), 1); assert.equal(f.calls.length, before);
});
test('main management forwarding cannot turn a serialized proof or an offline live slot into release evidence', async t => {
  const f = await mainCoreFixture(t); await f.coordinator.play({source: 'apple'});
  const realGetter = f.manager.getExitEvidence, proof = realGetter(f.session), copy = JSON.parse(JSON.stringify(proof));
  assert.equal(isVerifiedBackendChildExit(copy, f.session), false); f.manager.getExitEvidence = () => copy;
  const before = f.calls.length;
  try {
    await assert.rejects(f.guarded.prepareOutputHandoff({}), {code: 'STILL_HANDOFF_SESSION_UNVERIFIED'});
    await assert.rejects(f.guarded.releaseOutput({}), {code: 'STILL_HANDOFF_SESSION_UNVERIFIED'});
    assert.equal(f.calls.length, before);
  } finally {f.manager.getExitEvidence = realGetter;}
  const live = await mainCoreFixture(t), original = live.manager.getInfo;
  live.manager.getInfo = () => ({...original(), available: false, owned: false}); const liveBefore = live.calls.length;
  try {await assert.rejects(live.guarded.prepareOutputHandoff({}), {code: 'STILL_HANDOFF_SESSION_UNVERIFIED'});
    await assert.rejects(live.guarded.releaseOutput({}), {code: 'STILL_HANDOFF_SESSION_UNVERIFIED'}); assert.equal(live.calls.length, liveBefore);
  } finally {live.manager.getInfo = original;}
});

test('public local play restores the owned backend when the next Apple host exited before sending any audio RPC', async t => {
  let official, crashed = false, fallbackChecks = 0, bridgeReady = true;
  const fixture = await mainCoreFixture(t, {allowPlay: true, onExit() {
    if (crashed) return;
    crashed = true; official.crash();
  }});
  const {guarded: local, manager: backend, raw: bridge, getInfo} = fixture;
  official = syntheticOfficialAppleHost(t, {verifyOutputReleased: options => {
    fallbackChecks++;
    return verifyAppleOutputRelease({rawFoobar: bridge, backend, isActive: () => true}, options);
  }});
  const apple = official.service;
  await apple.initialize(); await apple.authorize();
  const coordinator = createPlaybackCoordinator({engines: {local, apple: createAppleAdapter(apple)}});
  const track = {id: 'fixture-local', ...fixture.rows[1]};
  const handlers = createHandlers({foobar: local, apple, coordinator, getBackendInfo: getInfo,
    library: {list: () => ({tracks: [track]}), getTrack: id => id === track.id ? track : null},
    prepareLocalPlayback: (input, context) => prepareLocalPlaybackLifecycle({backend, foobar: local, bridge,
      isBridgeReady: () => bridgeReady, onBridgeReady: ready => {bridgeReady = ready;}}, input, context)});
  t.after(async () => {handlers.closePlaybackContext(); await coordinator.close();});
  assert.equal((await handlers['player:state']({})).source, 'local');
  await assert.rejects(handlers['player:play']({source: 'apple', id: 'fixture-apple'}), {code: 'session-closed'});
  assert.equal(fixture.exitCalls(), 1);
  assert.equal(getInfo().status, 'standby');
  assert.equal(official.wire.some(method => method === 'play' || method === 'resume'), false);
  const restored = await handlers['player:play']({source: 'local', trackId: track.id});
  assert.equal(restored.source, 'local'); assert.equal(restored.state, 'playing');
  assert.equal(restored.currentTrackId, track.id);
  assert.equal(getInfo().status, 'ready'); assert.equal(bridgeReady, true);
  assert.equal(fallbackChecks, 0);
  assert.ok(fixture.calls.some(call => call.method === 'POST' && call.route === 'player/play/deck/0'));
});

test('a new silent Apple helper can release after a previous audio session had a verified exit', async t => {
  const {service, crash, wire} = syntheticOfficialAppleHost(t);
  await service.initialize(); await service.authorize();
  assert.equal((await service.play({id: 'fixture-apple'})).state, 'playing');
  const retired = await service.releaseOutput();
  assert.equal(retired.evidence.ownedBrowserProcessExited, true);
  assert.equal(retired.evidence.ownedHelperExited, true);
  await service.authorize(); crash();
  const recovered = await service.releaseOutput();
  assert.equal(recovered.released, true);
  assert.equal(recovered.evidence.outstandingAudioDispatch, false);
  assert.equal(wire.filter(method => method === 'play').length, 1);
});
