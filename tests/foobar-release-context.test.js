'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {createFakeBeefwebHttp} = require('./helpers/fake-beefweb-http');
const {createFoobarService} = require('../src/main/foobar');

const changed = () => Object.assign(new Error('Replaced caller context'), {code: 'STILL_CONTEXT_CHANGED'});
function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}
async function fixture(t, {holdStop, waitForOutputRelease} = {}) {
  const {root} = createCanonicalTemp('still-release-context-');
  const calls = [], enteredStop = deferred();
  let playbackState = 'playing';
  const outputs = {active: {typeId: 'fixture', deviceId: 'fixture'}, types: [
    {id: 'fixture', name: 'Synthetic output', devices: [{id: 'fixture', name: 'Synthetic device'}]}
  ]};
  const http = createFakeBeefwebHttp(async ({route, call, send}) => {
    calls.push(call);
    if (route === 'player/stop') {
      enteredStop.resolve();
      if (holdStop) await holdStop.promise;
      playbackState = 'stopped';
      return send(null, 204);
    }
    if (route === 'query') return send({outputs, player: {
      info: {name: 'foobar2000', version: '2.26.2', pluginVersion: '0.10'}, playbackState,
      activeItem: {playlistId: 'fixture', index: 0, position: 0, duration: 12,
        columns: ['C:\\Synthetic\\silence.wav', '0', 'Synthetic silence', '', '', '12']},
      volume: {type: 'db', min: -100, max: 0, value: -20}, options: []
    }});
    return send({}, 404);
  });
  const service = createFoobarService({dataDir: root, baseUrl: http.baseUrl, fetch: http.fetch,
    pollIntervalMs: 0, verifyTimeoutMs: 200, verifyPollMs: 1, timeoutMs: 500, waitForOutputRelease});
  t.after(async () => {
    holdStop?.resolve();
    await service.close(); await http.drain();
    await fs.rm(root, {recursive: true, force: true});
  });
  return {service, calls, enteredStop};
}

test('a stale external stop cannot replace the current adapter intent', async t => {
  const hold = deferred(), f = await fixture(t, {holdStop: hold});
  const current = f.service.stop();
  await f.enteredStop.promise;
  await assert.rejects(f.service.stop({check() {throw changed();}}), {code: 'STILL_CONTEXT_CHANGED'});
  hold.resolve();
  assert.equal((await current).state, 'stopped');
  assert.equal(f.calls.filter(call => call.route === 'player/stop').length, 1);
});

test('release rejects an already cancelled caller before any control or probe', async t => {
  let probes = 0;
  const f = await fixture(t, {waitForOutputRelease: async () => {probes++; return {released: true};}});
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.releaseOutput({signal: controller.signal}), {code: 'STILL_CANCELLED'});
  assert.equal(f.calls.length, 0); assert.equal(probes, 0);
});

test('release rechecks external ownership after its cancellation fence before stop', async t => {
  let checks = 0, probes = 0;
  const f = await fixture(t, {waitForOutputRelease: async () => {probes++; return {released: true};}});
  await assert.rejects(f.service.releaseOutput({check() {if (++checks === 2) throw changed();}}), {code: 'STILL_CONTEXT_CHANGED'});
  assert.equal(f.calls.length, 0); assert.equal(probes, 0);
});

test('aborting the caller during the physical stop cannot continue to release probing', async t => {
  const hold = deferred(); let probes = 0;
  const f = await fixture(t, {holdStop: hold, waitForOutputRelease: async () => {probes++; return {released: true};}});
  const controller = new AbortController();
  const release = f.service.releaseOutput({signal: controller.signal, check() {}});
  const rejection = assert.rejects(release, {code: 'STILL_CANCELLED'});
  await f.enteredStop.promise; controller.abort(); hold.resolve();
  await rejection;
  assert.equal(probes, 0);
});

test('a late positive release probe is refused after its caller was superseded', async t => {
  const entered = deferred(), result = deferred(); let current = true;
  const f = await fixture(t, {waitForOutputRelease: async input => {
    assert.equal(typeof input.check, 'function'); input.check(); entered.resolve();
    return result.promise;
  }});
  const release = f.service.releaseOutput({check() {if (!current) throw changed();}});
  const rejection = assert.rejects(release, {code: 'STILL_CONTEXT_CHANGED'});
  await entered.promise; current = false; result.resolve({released: true, evidence: {synthetic: true}});
  await rejection;
});

test('a current release keeps its real stopped readback and supplied release evidence', async t => {
  let checks = 0, probes = 0;
  const proof = {released: true, evidence: {synthetic: true}};
  const f = await fixture(t, {waitForOutputRelease: async input => {
    probes++; input.check(); return proof;
  }});
  const result = await f.service.releaseOutput({check() {checks++;}});
  assert.equal(result.released, true); assert.equal(result.evidence, proof.evidence);
  assert.equal(result.state.state, 'stopped'); assert.equal(probes, 1);
  assert.ok(checks >= 6);
  assert.equal(f.calls.some(call => /^(?:player\/play(?:\/|$)|player\/volume|outputs\/active)/.test(call.route)), false);
  assert.equal(f.calls.filter(call => call.method === 'POST').every(call => call.route === 'player/stop'), true);
});
