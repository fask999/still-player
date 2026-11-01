'use strict';
// Reuse the independently reviewed production Node host/coordinator + VM SDK
// wire fixture. Test registration is suppressed; no binary/profile/network IO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {createHandlers} = require('../src/main/main');
const testPath = path.join(__dirname, 'apple-supersede.test.js'), load = createRequire(testPath), ownModule = {exports: {}};
vm.runInNewContext(fs.readFileSync(testPath, 'utf8') + '\nmodule.exports={fixture};', {
  require: name => name === 'node:test' ? () => {} : load(name), module: ownModule, exports: ownModule.exports,
  __dirname, __filename: testPath, process: {env: {STILL_APPLE_FIXTURE_RUNTIME_ROOT: path.join(__dirname, '..')}},
  console, Buffer, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, setImmediate
});
const fixture = ownModule.exports.fixture;
const gate = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const payload = letter => ({source: 'apple', id: `i.fixture${letter}`, kind: 'library-songs'});
const handlers = f => createHandlers({apple: f.apple, coordinator: f.coordinator, foobar: {},
  library: {list: async () => ({tracks: [], playlists: [], folders: []})}, settings: {get: () => ({})}});
async function rebuildGap(t) {
  const f = await fixture(t, {holdClose: true}), entered = gate(), release = gate(), originalStart = f.native.start;
  f.native.start = async options => {if (f.children.length === 1 && f.children[0].child.exitCode !== null) {entered.resolve(); await release.promise;} return originalStart(options);};
  t.after(() => release.resolve());
  const h = handlers(f), a = h['player:play'](payload('A')); const aFailure = a.catch(error => error);
  await f.oldEntered.promise;
  const b = h['player:play'](payload('B')), bFailure = b.catch(error => error);
  await f.closeEntered.promise; f.closeGate.resolve(); await entered.promise;
  return {f, h, a, b, aFailure, bFailure, release};
}
test('actual main handler accepts latest known C after old dual exit before replacement spawn and only C unmutes', async t => {
  const {f, h, aFailure, bFailure, release} = await rebuildGap(t), status = f.apple.status();
  assert.equal(status.pending, true); assert.equal(status.available, false); assert.equal(status.capabilities.playback, false); assert.equal(status.capabilities.canSubmitPlayIntent, true);
  const c = h['player:play'](payload('C')); release.resolve();
  const result = await c; assert.equal(result.currentTrackId, '1450000003');
  assert.equal((await aFailure).code, 'STILL_CANCELLED'); assert.equal((await bFailure).code, 'STILL_CANCELLED');
  assert.equal(f.children.length, 2); assert.equal(f.children[0].profile, f.children[1].profile);
  assert.deepEqual(Array.from(f.children[1].unmuted), ['1450000003']);
  assert.equal(f.wire.some(row => row.closing && row.method !== 'close'), false);
});
test('unknown, conflicting, oversized, unsupported and no-permit requests do not cancel the valid pending B', async t => {
  const {f, h, aFailure, b, release} = await rebuildGap(t), generation = f.coordinator.currentGeneration();
  for (const input of [{...payload('C'), id: 'i.unknown'}, {...payload('C'), kind: 'albums'}, {...payload('C'), ids: ['i.fixtureB', 'i.fixtureC']},
    {...payload('C'), ids: ['i.fixtureB']}, {...payload('C'), trackId: 'i.fixtureB'}, {...payload('C'), ids: null}]) await assert.rejects(h['player:play'](input));
  const getStatus = f.apple.getStatus;
  f.apple.getStatus = () => {const value = getStatus(); return {...value, capabilities: {...value.capabilities, canSubmitPlayIntent: false}};};
  await assert.rejects(h['player:play']({...payload('C'), canSubmitPlayIntent: true})); f.apple.getStatus = getStatus;
  const predicate = f.apple.canSubmitPlayIntent; f.apple.canSubmitPlayIntent = undefined;
  await assert.rejects(h['player:play'](payload('C'))); f.apple.canSubmitPlayIntent = predicate;
  await assert.rejects(async () => h['apple:library']({kind: 'songs'}));
  assert.equal(f.coordinator.currentGeneration(), generation); release.resolve();
  assert.equal((await b).currentTrackId, '1450000002'); assert.equal((await aFailure).code, 'STILL_CANCELLED');
  assert.deepEqual(Array.from(f.children[1].unmuted), ['1450000002']);
});
test('manual closed production session has no rebuild intent permit and the main handler does not reopen it', async t => {
  const f = await fixture(t); await f.apple.close(); const h = handlers(f), count = f.children.length, generation = f.coordinator.currentGeneration();
  assert.equal(f.apple.status().capabilities.canSubmitPlayIntent, false);
  await assert.rejects(h['player:play']({...payload('C'), canSubmitPlayIntent: true}));
  assert.equal(f.children.length, count); assert.equal(f.coordinator.currentGeneration(), generation);
});
test('the rebuild permission is not consulted for toggle, seek or browsing capabilities', async () => {
  let permits = 0, plays = 0; const commands = [];
  const h = createHandlers({apple: {getStatus: () => ({capabilities: {playback: false, canSubmitPlayIntent: true, playIntentTypes: ['songs'], library: false}}),
    canSubmitPlayIntent: () => {permits++; return true;}}, library: {list: () => ({tracks: []})}, coordinator: {currentGeneration: () => 0, currentRevision: () => 0,
      play: () => {plays++;}, command: async method => {commands.push(method); throw new Error('controls not ready');}}});
  await assert.rejects(h['player:toggle']({})); await assert.rejects(h['player:seek']({position: 2})); await assert.rejects(async () => h['apple:library']({}));
  assert.deepEqual(commands, ['toggle', 'seek']); assert.equal(permits, 0); assert.equal(plays, 0);
});
