'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const {createPlaybackCoordinator} = require('../src/main/playback-coordinator');

const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const cancelled = () => Object.assign(new Error('fixture cancelled'), {code: 'STILL_CANCELLED'});

test('explicit reconnect invalidates pending playback without issuing stop or waiting on the HTTP barrier', async () => {
  const {calls, local, coordinator} = setup('stopped'), prepare = deferred(), barrier = deferred();
  local.barrier = barrier;
  const request = coordinator.play({prepare: async () => {await prepare.promise; return {id: 'obsolete'};}}).catch(error => error);
  await tick();
  const previous = coordinator.currentGeneration();
  let settled = false;
  const cancellation = coordinator.cancelPending().then(() => {settled = true;});
  assert.ok(coordinator.currentGeneration() > previous);
  await tick(); assert.equal(settled, false);
  assert.equal((await request).code, 'STILL_CANCELLED');
  assert.equal(calls.some(call => call.includes('.stop') || call.includes('.start:')), false);
  prepare.resolve(); barrier.resolve(); await cancellation; await tick();
  assert.equal(calls.some(call => call.includes('.start:')), false);
  await coordinator.close();
});
function fixture(source, calls, output, initial = 'stopped') {
  let token = 0, state = {available: true, state: initial, position: 0, duration: 10, volume: 0.5, currentTrack: {id: `${source}-old`}};
  if (initial === 'playing' || initial === 'paused') output.add(source);
  const engine = {
    barrier: null, releaseGate: null, readGate: null, stopError: null, releaseError: null,
    cancelPending() {token++; calls.push(`${source}.cancel`); return engine.barrier?.promise;},
    async getState() {const result = {...state}; const gate = engine.readGate; engine.readGate = null; if (gate) await gate.promise; return result;},
    async play(input = {}) {
      const request = ++token; calls.push(`${source}.prepare:${input.id}`);
      if (input.prepareGate) await input.prepareGate.promise;
      if (request !== token) throw cancelled();
      assert.deepEqual([...output].filter(id => id !== source), [], 'another engine still holds the output');
      output.add(source); calls.push(`${source}.start:${input.id}`);
      state = {...state, state: 'playing', currentTrack: {id: input.id}};
      if (input.verifyGate) await input.verifyGate.promise;
      if (request !== token) throw cancelled();
      if (input.errorAfterStart) throw new Error(input.errorAfterStart);
      return {...state};
    },
    async stop() {token++; calls.push(`${source}.stop`); if (engine.stopError) throw new Error(engine.stopError); state = {...state, state: 'stopped'};},
    async pause() {token++; calls.push(`${source}.pause`); state = {...state, state: 'paused'};},
    async releaseOutput() {
      calls.push(`${source}.release-begin`);
      if (engine.releaseGate) await engine.releaseGate.promise;
      if (engine.releaseError) throw new Error(engine.releaseError);
      output.delete(source); calls.push(`${source}.released`); return {released: true, evidence: {fixture: true}};
    }
  };
  return engine;
}
function setup(localInitial = 'playing') {
  const calls = [], output = new Set();
  const local = fixture('local', calls, output, localInitial), apple = fixture('apple', calls, output);
  const coordinator = createPlaybackCoordinator({engines: {local, apple}});
  return {calls, output, local, apple, coordinator};
}

test('cross-engine play waits for actual release, and reports only read-back playback', async () => {
  const {calls, output, local, coordinator} = setup();
  local.releaseGate = deferred();
  assert.equal((await coordinator.getState()).source, 'local');
  const play = coordinator.play({source: 'apple', input: {id: 'apple-song'}});
  await tick();
  assert.ok(calls.includes('local.stop'));
  assert.ok(calls.includes('local.release-begin'));
  assert.equal(calls.some(value => value.startsWith('apple.start')), false);
  assert.equal((await coordinator.getState()).source, null);
  assert.deepEqual([...output], ['local']);
  local.releaseGate.resolve();
  const result = await play;
  assert.equal(result.source, 'apple');
  assert.ok(calls.indexOf('local.released') < calls.indexOf('apple.start:apple-song'));
  assert.deepEqual([...output], ['apple']);
  await coordinator.close();
});

test('same-engine B immediately cancels A materialization without waiting for A', async () => {
  const {calls, coordinator} = setup();
  const gate = deferred();
  const first = coordinator.play({input: {id: 'A', prepareGate: gate}});
  const firstRejected = assert.rejects(first, {code: 'STILL_CANCELLED'});
  await tick();
  const second = await coordinator.play({input: {id: 'B'}});
  assert.equal(second.currentTrack.id, 'B');
  assert.equal(calls.includes('local.start:A'), false);
  gate.resolve(); await firstRejected; await tick();
  assert.equal((await coordinator.getState()).currentTrack.id, 'B');
  await coordinator.close();
});

test('pause and stop immediately invalidate pending verification and cannot be revived', async () => {
  for (const method of ['pause', 'stop']) {
    const {calls, coordinator} = setup();
    const gate = deferred();
    const first = coordinator.play({input: {id: 'A', verifyGate: gate}});
    const firstRejected = assert.rejects(first, {code: 'STILL_CANCELLED'});
    await tick();
    const result = await coordinator.command(method);
    assert.equal(result.state, method === 'pause' ? 'paused' : 'stopped');
    assert.ok(calls.includes(`local.${method}`));
    gate.resolve(); await firstRejected; await tick();
    assert.equal((await coordinator.getState()).state, method === 'pause' ? 'paused' : 'stopped');
    await coordinator.close();
  }
});

test('late cancelled materialization from another engine cannot restart after switching', async () => {
  const {calls, output, coordinator} = setup();
  const gate = deferred();
  const first = coordinator.play({input: {id: 'A', prepareGate: gate}});
  const firstRejected = assert.rejects(first, {code: 'STILL_CANCELLED'});
  await tick();
  assert.equal((await coordinator.play({source: 'apple', input: {id: 'B'}})).source, 'apple');
  gate.resolve(); await firstRejected; await tick();
  assert.equal(calls.includes('local.start:A'), false);
  assert.deepEqual([...output], ['apple']);
  await coordinator.close();
});

test('latest generation wins while a cross-engine release is delayed', async () => {
  const {calls, local, coordinator} = setup();
  local.releaseGate = deferred();
  const first = coordinator.play({source: 'apple', input: {id: 'A'}});
  const firstRejected = assert.rejects(first, {code: 'STILL_CANCELLED'});
  await tick();
  const second = coordinator.play({input: {id: 'B'}});
  await tick();
  local.releaseGate.resolve();
  assert.equal((await second).currentTrack.id, 'B');
  await firstRejected;
  assert.equal(calls.includes('apple.start:A'), false);
  await coordinator.close();
});

test('a cancelled cross-engine barrier cannot stop or release a newer pause', async () => {
  const {calls, local, coordinator} = setup();
  const barrier = deferred(); local.barrier = barrier;
  const first = coordinator.play({source: 'apple', input: {id: 'A'}});
  const firstRejected = assert.rejects(first, {code: 'STILL_CANCELLED'});
  await tick();
  assert.equal((await coordinator.command('pause')).state, 'paused');
  barrier.resolve(); await firstRejected; await tick();
  assert.equal(calls.includes('local.stop'), false);
  assert.equal(calls.includes('local.release-begin'), false);
  assert.equal((await coordinator.getState()).state, 'paused');
  await coordinator.close();
});

test('failed stop or missing release proof never starts or reports the requested engine', async () => {
  for (const mode of ['stop', 'release', 'no-proof']) {
    const {calls, local, coordinator} = setup();
    await coordinator.getState();
    if (mode === 'stop') local.stopError = 'device busy';
    else if (mode === 'release') local.releaseError = 'release probe unavailable';
    else local.releaseOutput = async () => ({released: false});
    await assert.rejects(coordinator.play({source: 'apple', input: {id: 'A'}}));
    const state = await coordinator.getState();
    assert.equal(state.source, mode === 'stop' ? 'local' : null);
    assert.equal(state.lastSource, 'local');
    assert.equal(calls.some(value => value.startsWith('apple.start')), false);
    await coordinator.close();
  }
});

test('a failed start is described by actual state even if the adapter already began playback', async () => {
  const {coordinator} = setup();
  await assert.rejects(coordinator.play({source: 'apple', input: {id: 'A', errorAfterStart: 'verification failed'}}), /verification failed/);
  const result = await coordinator.getState();
  assert.equal(result.source, 'apple');
  assert.equal(result.currentTrack.id, 'A');
  await coordinator.close();
});

test('a slow library preparation loses to a newer request before adapter materialization', async () => {
  const {calls, coordinator} = setup();
  const gate = deferred();
  const first = coordinator.play({prepare: async context => {await gate.promise; context.check(); return {id: 'A'};}});
  const firstRejected = assert.rejects(first, {code: 'STILL_CANCELLED'});
  await tick();
  assert.equal((await coordinator.play({input: {id: 'B'}})).currentTrack.id, 'B');
  gate.resolve(); await firstRejected; await tick();
  assert.equal(calls.includes('local.prepare:A'), false);
  await coordinator.close();
});

test('old state reads return the latest accepted state after a stop', async () => {
  const {local, coordinator} = setup();
  await coordinator.getState();
  const gate = deferred(); local.readGate = gate;
  const oldRead = coordinator.getState();
  await tick();
  const stopped = await coordinator.command('stop');
  gate.resolve(); const late = await oldRead;
  assert.equal(stopped.state, 'stopped');
  assert.equal(late.state, 'stopped');
  assert.equal(late.source, null);
  assert.ok(late.revision >= stopped.revision);
  await coordinator.close();
});
