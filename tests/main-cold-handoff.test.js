'use strict';
// Production core fixture reused with fake files/processes/fetches only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {createHandlers, guardFoobarService, prepareAppleHandoffLifecycle} = require('../src/main/main');
const {createPlaybackCoordinator, isExplicitAppleHandoffContext} = require('../src/main/playback-coordinator');
const testPath = path.join(__dirname, 'owned-handoff.test.js'), load = createRequire(testPath), ownModule = {exports: {}};
// Keep the fixture in the Node realm so its strict array assertions compare
// the same prototypes as real production callbacks; only registration is muted.
const compileFixture = vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + fs.readFileSync(testPath, 'utf8') + '\nmodule.exports={coldFixture};\n})', {filename: testPath});
compileFixture(name => name === 'node:test' ? () => {} : load(name), ownModule, ownModule.exports, __dirname, testPath);
async function mainCold(t, options = {}) {
  const cold = await ownModule.exports.coldFixture(t, options); await cold.coordinator.close();
  let bridgeReady = false, starts = 0, prepares = 0, captured;
  const getInfo = () => {const value = cold.life.manager.getInfo(), pending = cold.life.local.getHandoffStatus().pendingRestore;
    return {...value, verified: value.available && bridgeReady && !pending, pendingHandoff: value.pendingHandoff || pending};};
  const guarded = guardFoobarService(cold.life.local, getInfo), apple = {getStatus: () => ({available: true, capabilities: {playback: true, maxPlayItems: 1, playableTypes: ['songs']}}),
    cancelPending: async () => {}, getState: async () => ({available: true, state: starts ? 'playing' : 'stopped', currentTrackId: starts ? 'target' : null}),
    play: async () => {starts++;}};
  const coordinator = createPlaybackCoordinator({engines: {local: guarded, apple}, prepareAppleHandoff: context => {
    prepares++; captured = context; assert.equal(isExplicitAppleHandoffContext(context), true);
    return prepareAppleHandoffLifecycle({backend: cold.life.manager, bridge: cold.life.local, onBridgeReady: value => {bridgeReady = value;}}, context);
  }});
  const h = createHandlers({apple, foobar: guarded, coordinator, getBackendInfo: getInfo, library: {list: () => ({tracks: []})}});
  t.after(() => coordinator.close());
  return {cold, h, coordinator, starts: () => starts, prepares: () => prepares, captured: () => captured, ready: () => bridgeReady};
}
test('main explicit Apple callback restores a cold stopped instance, verifies it and obtains new real exit proof before Apple', async t => {
  const f = await mainCold(t), beforeSpawns = f.cold.f.spawnCount(), beforeExits = f.cold.f.exitCalls();
  assert.equal(f.cold.life.local.needsColdHandoffRestore(), true); assert.equal(f.cold.life.manager.getSession(), null);
  const value = await f.h['player:play']({source: 'apple', id: 'target', kind: 'songs'});
  assert.equal(value.source, 'apple'); assert.equal(f.starts(), 1); assert.equal(f.prepares(), 1); assert.equal(f.ready(), true);
  assert.equal(f.cold.f.spawnCount(), beforeSpawns + 1); assert.equal(f.cold.f.exitCalls(), beforeExits + 1);
  assert.equal(f.cold.life.local.getHandoffStatus().current.sourceExited, true);
  assert.equal(isExplicitAppleHandoffContext(f.captured()), false);
  await assert.rejects(f.cold.life.manager.ensureStarted({explicitHandoffRestore: true}), {code: 'STILL_HANDOFF_RESTORE_UNVERIFIED'});
  await assert.rejects(f.cold.life.manager.ensureStarted({explicitHandoffRestore: f.captured()}), {code: 'STILL_HANDOFF_RESTORE_UNVERIFIED'});
  assert.equal(f.cold.f.calls.some(row => /^player\/play/.test(row.route)), false);
});
test('main cold hook cannot turn prepared or mismatching records into permission to start Apple', async t => {
  for (const options of [{prepared: true}, {changedFingerprint: true}, {changedCold: true}, {reusedCold: true}]) {
    const f = await mainCold(t, options); await assert.rejects(f.h['player:play']({source: 'apple', id: 'target'}));
    assert.equal(f.starts(), 0); if (options.prepared) assert.equal(f.prepares(), 0);
  }
});
test('a late older preparation cannot overwrite a newer successful bridge readiness', async () => {
  let current = 1, ready = true, release;
  const gate = new Promise(resolve => {release = resolve;}), contexts = [1, 2].map(generation => ({generation, signal: new AbortController().signal,
    check() {if (current !== generation) throw Object.assign(new Error('cancelled'), {code: 'STILL_CANCELLED'});}}));
  const events = [], backend = {ensureStarted: async input => {assert.equal(input.explicitHandoffRestore, contexts[current - 1]); if (current === 1) await gate; return {available: true};}},
    bridge = {connect: async () => {events.push('connect');}, verifyHandoffRestore: async () => {events.push('verify');}};
  const dependencies = {backend, bridge, onBridgeReady: value => {ready = value;}};
  const old = prepareAppleHandoffLifecycle(dependencies, contexts[0]), failure = old.catch(error => error);
  current = 2; await prepareAppleHandoffLifecycle(dependencies, contexts[1]); assert.equal(ready, true);
  release(); assert.equal((await failure).code, 'STILL_CANCELLED'); assert.equal(ready, true); assert.deepEqual(events, ['connect', 'verify']);
});
