'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {isVerifiedBackendChildExit} = require('../src/main/backend');
const {mainCoreFixture} = require('./helpers/main-core-fixture');
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
