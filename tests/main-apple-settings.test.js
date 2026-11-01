'use strict';
// Main/real coordinator + pure injected service only; no host/SDK RPC or audio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {createHandlers, createAppleAdapter} = require('../src/main/main');
const {createPlaybackCoordinator} = require('../src/main/playback-coordinator');
const {normalizeAppleSettingsSnapshot} = require('../src/main/apple-settings');
function fixture(owner = 'apple') {
  let pending = false, reads = 0, writes = 0, cancels = 0, applied = 'all';
  const actual = () => ({source: 'apple', available: true, status: pending ? 'pending' : 'ready', sessionOpen: true, authorized: true, pending,
    repeatMode: applied, shuffleMode: 'off', bitrateTarget: 256, capabilities: {read: true, repeatMode: true, shuffleMode: true, bitrateTarget: true, openSession: true,
      refreshLibrary: true, canSelectLossless: true, outputSelection: true}, details: {actualBitrate: 999999, actualDacRate: 192000}});
  const apple = {getPlaybackSettings: async () => {reads++; return actual();},
    canSetPlaybackSettings: () => !pending,
    setPlaybackSettings: async (_patch, context) => {assert.equal(typeof context?.check, 'function'); context.check(); writes++; return actual();},
    getState() {throw new Error('Settings must not GET playback state');}, getStatus: () => ({capabilities: {}}), cancelPending: async () => {cancels++;}};
  const local = {getState() {throw new Error('Settings must not read the local engine');}, cancelPending: async () => {cancels++;}};
  const coordinator = createPlaybackCoordinator({engines: {local, apple: createAppleAdapter(apple)}, defaultSource: owner});
  const h = createHandlers({apple, foobar: local, coordinator});
  return {h, apple, coordinator, reads: () => reads, writes: () => writes, cancels: () => cancels, pending: value => {pending = value;}, applied: value => {applied = value;}};
}
test('settings get returns one normalized DTO and masks write capabilities when the actual control owner is local', async () => {
  const f = fixture('local'), generation = f.coordinator.currentGeneration();
  const value = await f.h['apple:settings:get']({});
  assert.equal(value.source, 'apple'); assert.equal(Object.hasOwn(value, 'settings'), false); assert.equal(value.repeatMode, 'all'); assert.equal(value.capabilities.read, true);
  assert.equal(value.capabilities.repeatMode, false); assert.equal(value.capabilities.shuffleMode, false); assert.equal(value.capabilities.openSession, true);
  assert.equal(value.capabilities.bitrateTarget, false); assert.equal(value.capabilities.canSelectLossless, false); assert.equal(value.capabilities.outputSelection, false);
  assert.deepEqual(value.details, {actualBitrate: null, actualDacRate: null}); assert.equal(f.reads(), 1); assert.equal(f.writes(), 0);
  assert.equal(f.coordinator.currentGeneration(), generation); assert.equal(f.cancels(), 0);
});
test('settings update uses only the source-aware coordinator and returns actual readback instead of the requested mode', async () => {
  const f = fixture('apple'); f.coordinator.command = () => {throw new Error('No generic current-source command');};
  const value = await f.h['apple:settings:update']({patch: {repeatMode: 'one'}});
  assert.equal(value.repeatMode, 'all'); assert.notEqual(value.repeatMode, 'one'); assert.equal(value.capabilities.repeatMode, true);
  assert.equal(value.capabilities.shuffleMode, true); assert.equal(f.writes(), 1); assert.equal(f.reads(), 0);
  assert.equal(f.coordinator.currentGeneration(), 1); assert.deepEqual(value.details, {actualBitrate: null, actualDacRate: null});
});
test('wrong-owner or pending Apple updates reject before a new intent or cancellation', async () => {
  for (const owner of ['local', 'apple']) {
    const f = fixture(owner); if (owner === 'apple') f.pending(true);
    const generation = f.coordinator.currentGeneration(), cancels = f.cancels();
    await assert.rejects(f.h['apple:settings:update']({patch: {shuffleMode: 'songs'}}));
    assert.equal(f.coordinator.currentGeneration(), generation); assert.equal(f.cancels(), cancels); assert.equal(f.writes(), 0);
    const value = await f.h['apple:settings:get']({}); assert.equal(value.capabilities.repeatMode, false); assert.equal(value.capabilities.shuffleMode, false);
  }
});
test('malformed patches, source overrides, accessors, quality and session writes never reach coordinator admission', async () => {
  const f = fixture('apple'); let getters = 0;
  const top = {}; Object.defineProperty(top, 'patch', {get() {getters++; return {repeatMode: 'one'};}});
  const inner = {}; Object.defineProperty(inner, 'repeatMode', {enumerable: true, get() {getters++; return 'one';}});
  for (const payload of [top, {patch: inner}, {}, {patch: {}}, {source: 'local', patch: {repeatMode: 'one'}},
    {patch: {repeatMode: 'one', shuffleMode: 'songs'}}, {patch: {bitrateTarget: 256}}, {patch: {closeSession: true}}, {patch: {outputSelection: 'device'}},
    {patch: {repeatMode: 'unknown'}}, {patch: {shuffleMode: true}}, {patch: {repeatMode: 'none'}, [Symbol('extra')]: true}]) await assert.rejects(f.h['apple:settings:update'](payload));
  await assert.rejects(f.h['apple:settings:get']({source: 'apple'}));
  assert.equal(getters, 0); assert.equal(f.writes(), 0); assert.equal(f.cancels(), 0); assert.equal(f.coordinator.currentGeneration(), 0);
});
test('bootstrap advertises only the IPC feature, and an absent service returns an unsupported mode DTO', async () => {
  const h = createHandlers({library: {list: () => ({tracks: []})}, foobar: {getState: async () => ({available: false}), capabilities: () => ({appleSettings: false})},
    settings: {get: () => ({})}});
  assert.equal((await h['app:bootstrap']()).capabilities.appleSettings, true);
  assert.deepEqual(await h['apple:settings:get']({}), normalizeAppleSettingsSnapshot(null));
});
test('preload exposes only the two settings channels and read-only smoke admits get but no settings or output write', async () => {
  let api;
  const preload = await fs.readFile(path.join(__dirname, '../src/main/preload.js'), 'utf8');
  vm.runInNewContext(preload, {require: name => {assert.equal(name, 'electron'); return {contextBridge: {exposeInMainWorld: (_name, value) => {api = value;}},
    ipcRenderer: {invoke: async () => ({ok: true, value: {source: 'apple'}})}};}});
  assert.equal((await api.invoke('apple:settings:get')).source, 'apple'); assert.equal((await api.invoke('apple:settings:update', {patch: {repeatMode: 'none'}})).source, 'apple');
  await assert.rejects(api.invoke('apple:settings:command', {}), /Unknown/);
  const main = await fs.readFile(path.join(__dirname, '../src/main/main.js'), 'utf8'), match = /const SMOKE_READ_CHANNELS = new Set\((\[[^\n]+\])\);/.exec(main);
  assert.ok(match); const channels = new Set(vm.runInNewContext(match[1]));
  assert.equal(channels.has('apple:settings:get'), true); assert.equal(channels.has('apple:settings:update'), false); assert.equal(channels.has('audio:select'), false);
});

async function settingsWireFixture(t, options = {}) {
  const syncFs = require('node:fs'), {createRequire} = require('node:module'), fixturePath = path.join(__dirname, 'apple-settings-integration.test.js');
  const load = createRequire(fixturePath), ownModule = {exports: {}};
  const compile = vm.runInThisContext('(function(require,module,exports,__dirname,__filename){\n' + syncFs.readFileSync(fixturePath, 'utf8') + '\nmodule.exports={fixture};\n})', {filename: fixturePath});
  compile(name => name === 'node:test' ? () => {} : load(name), ownModule, ownModule.exports, __dirname, fixturePath);
  const f = await ownModule.exports.fixture(t, options);
  const h = createHandlers({apple: f.apple, coordinator: f.coordinator, foobar: {}, library: {list: () => ({tracks: []})}});
  return {f, h};
}
test('actual main settings handlers traverse the production Node/bridge public enum mapping and return actual DTO without media calls', async t => {
  const {f, h} = await settingsWireFixture(t);
  const closed = await h['apple:settings:get']({}); assert.equal(closed.status, 'session-closed'); assert.equal(f.host.startCalls, 0);
  await f.apple.authorize();
  const before = await h['apple:settings:get']({}); assert.equal(before.repeatMode, 'none'); assert.equal(before.capabilities.repeatMode, true);
  const actual = await h['apple:settings:update']({patch: {repeatMode: 'one'}});
  assert.equal(actual.repeatMode, 'one'); assert.equal(f.music.repeatMode, f.repeat.one); assert.notEqual(f.repeat.one, 1);
  assert.equal(Object.hasOwn(actual, 'settings'), false); assert.equal(f.host.startCalls, 1); assert.deepEqual(f.media, []);
  assert.equal(f.calls.filter(call => call.method === 'settings').length, 1); assert.equal(f.calls.filter(call => call.method === 'settings-write').length, 1);
});
test('actual main settings view is read-only for local control owner and pending writes do not invalidate a current play', async t => {
  const {f, h} = await settingsWireFixture(t, {owner: 'local'}); await f.apple.authorize();
  const value = await h['apple:settings:get']({}); assert.equal(value.capabilities.read, true); assert.equal(value.capabilities.repeatMode, false); assert.equal(value.capabilities.shuffleMode, false);
  const generation = f.coordinator.currentGeneration(), calls = f.calls.length;
  await assert.rejects(h['apple:settings:update']({patch: {shuffleMode: 'songs'}}), {code: 'STILL_SOURCE_CONTROL_UNAVAILABLE'});
  assert.equal(f.coordinator.currentGeneration(), generation); assert.equal(f.calls.length, calls); assert.equal(f.localCancels(), 0);
  const ready = await settingsWireFixture(t); await ready.f.apple.authorize(); await ready.h['apple:settings:get']({}); ready.f.setPending(true);
  const current = ready.f.coordinator.currentGeneration(), nativeCalls = ready.f.calls.length;
  await assert.rejects(ready.h['apple:settings:update']({patch: {repeatMode: 'all'}}), {code: 'STILL_SOURCE_CONTROL_UNAVAILABLE'});
  assert.equal(ready.f.coordinator.currentGeneration(), current); assert.equal(ready.f.calls.length, nativeCalls);
});
test('ignored actual public SDK writes remain failures rather than requested-value echoes through main', async t => {
  const {f, h} = await settingsWireFixture(t, {ignoreRepeat: true}); await f.apple.authorize(); await h['apple:settings:get']({});
  await assert.rejects(h['apple:settings:update']({patch: {repeatMode: 'all'}}), {code: 'official-setting-unconfirmed'});
  assert.equal((await h['apple:settings:get']({})).repeatMode, 'none'); assert.deepEqual(f.media, []); assert.equal(f.host.closeCalls, 0);
});
