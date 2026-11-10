'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {mainCoreFixture} = require('./helpers/main-core-fixture');
const {createPlaybackCoordinator} = require('../src/main/playback-coordinator');
const {createDesktopIntegration} = require('../src/main/desktop-integration');
const {createDesktopPlaybackCallbacks, shutdownDesktop, createHandlers} = require('../src/main/main');
const {commandAvailability} = require('../src/main/ipc-handlers');
const {SMOKE_READ_CHANNELS} = require('../src/main/smoke');
const {DEFAULTS, createSettingsService} = require('../src/main/settings');
const {readBackendRuntimeAssets, readDesktopMediaRuntimeAssets, readCueReadLeaseRuntimeAssets} = require('../src/main/backend-job');
const {createRuntime} = require('../src/renderer/bootstrap');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function timerClock() {
  let now = 0, sequence = 0; const timers = new Map();
  return {now: () => now, wallNow: () => 1700000000000 + now,
    setTimeout(fn, delay) {const key = ++sequence; timers.set(key, {fn, due: now + delay}); return key;}, clearTimeout: key => timers.delete(key),
    advance(milliseconds) {now += milliseconds; for (const [key, value] of [...timers]) if (value.due <= now) {timers.delete(key); value.fn();}}};
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5));}
  assert.fail('Synthetic controlled operation did not settle in 500 ms');
}
async function temporary(t, prefix) {
  const {root, parent} = createCanonicalTemp(prefix);
  t.after(async () => {assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith(prefix)); await fs.rm(root, {recursive: true, force: true});});
  return root;
}
function controlled(t) {
  const calls = [], pending = new Set();
  let localState = {available: true, state: 'playing'}, appleState = {available: true, state: 'stopped'};
  const local = {
    readGate: null, prepareGate: null, releaseGate: null, proof: {released: true, evidence: {fixtureOnly: true}},
    cancelPending() {calls.push('cancel'); return Promise.resolve();},
    async getState() {const value = {...localState}, gate = local.readGate; local.readGate = null; if (gate) await gate.promise; return value;},
    async prepareOutputHandoff(context) {calls.push('prepare'); if (local.prepareGate) await local.prepareGate.promise; context.check(); return {};},
    finishOutputHandoff() {calls.push('finish');},
    async stop(context) {context.check(); calls.push('stop'); localState = {...localState, state: 'stopped'};},
    async releaseOutput(context) {calls.push('release-enter'); if (local.releaseGate) await local.releaseGate.promise; context.check(); calls.push('release-proof'); return local.proof;},
    async play(input, context) {context.check(); calls.push(`play:${input.id}`); localState = {available: true, state: 'playing', currentTrackId: input.id};}
  };
  const apple = {cancelPending: () => Promise.resolve(), getState: async () => ({...appleState})};
  const coordinator = createPlaybackCoordinator({engines: {local, apple}});
  t.after(async () => {for (const gate of pending) gate.resolve(); await coordinator.close();});
  const gate = () => {const value = deferred(); pending.add(value); return value;};
  const controller = new AbortController(); let current = true;
  const request = () => coordinator.stopAndReleaseForCurrentSource({source: 'local', generation: coordinator.currentGeneration(),
    signal: controller.signal, isCurrent: () => current, origin: 'sleep-timer'});
  return {coordinator, local, calls, controller, request, gate, obsolete() {current = false;},
    setLocal(value) {localState = value;}, setApple(value) {appleState = value;}};
}

test('desktop settings backfill without rewriting and atomically reject duplicates across queued patches', async t => {
  const root = await temporary(t, 'still-central-settings-'), file = path.join(root, 'settings.json');
  const original = JSON.stringify({lyrics: {fontSize: 39}, appearance: {localView: 'artists'}});
  await fs.writeFile(file, original);
  const settings = createSettingsService({dataDir: root}); await settings.initialize(); t.after(() => settings.close());
  assert.deepEqual(settings.get().desktop, DEFAULTS.desktop); assert.equal(await fs.readFile(file, 'utf8'), original);
  const outcomes = await Promise.allSettled([settings.update({desktop: {hotkeyToggle: 'ctrl+shift+p'}}), settings.update({desktop: {hotkeyNext: 'Shift+Control+P'}})]);
  assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected');
  assert.equal(settings.get().desktop.hotkeyToggle, 'Control+Shift+P'); assert.equal(settings.get().desktop.hotkeyNext, '');
  const committed = await fs.readFile(file, 'utf8');
  let accessed = false;
  const accessor = Object.defineProperty({}, 'preventSleep', {enumerable: true, get() {accessed = true; return true;}});
  await assert.rejects(settings.update({desktop: accessor})); assert.equal(accessed, false);
  for (const desktop of [{unknown: true}, {sleepTimer: 1}, {preventSleep: 1}, {hotkeyNext: 'MediaNextTrack'}, {windowPlacement: {path: 'arbitrary'}}]) {
    await assert.rejects(settings.update({desktop})); assert.equal(await fs.readFile(file, 'utf8'), committed);
  }
  await assert.rejects(settings.update({lyrics: {preferredSource: 'qq'}}));
  const restored = createSettingsService({dataDir: root}); await restored.initialize(); t.after(() => restored.close());
  assert.equal(restored.get().desktop.hotkeyToggle, 'Control+Shift+P'); assert.equal(restored.get().lyrics.fontSize, 39);
});

test('trusted runtime reader accepts legacy backend inventory and requires a separately fixed desktop manifest pin', async t => {
  const root = await temporary(t, 'still-central-runtime-');
  const paths = {backendOutputPolicy: 'src/main/backend-output-policy.json', backendLauncher: 'native/backend-job/StillBackendLauncher.exe', desktopMediaManifest: 'native/desktop-media/bin/runtime-manifest.json'};
  const bytes = {backendOutputPolicy: Buffer.from('{}'), backendLauncher: Buffer.from('NONEXECUTABLE FIXTURE'), desktopMediaManifest: Buffer.from('{"fixture":true}')};
  for (const [key, relative] of Object.entries(paths)) {const file = path.join(root, relative); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, bytes[key]);}
  const registry = {schemaVersion: 1, assets: Object.fromEntries(Object.keys(paths).map(key => [key, {relativePath: paths[key], sha256: sha256(bytes[key])}]))};
  const file = path.join(root, 'src/main/runtime-assets.json'), save = () => fs.writeFile(file, JSON.stringify(registry));
  const desktopPin = registry.assets.desktopMediaManifest; delete registry.assets.desktopMediaManifest; await save();
  assert.equal((await readBackendRuntimeAssets(root)).backendLauncher.sha256, registry.assets.backendLauncher.sha256);
  await assert.rejects(readDesktopMediaRuntimeAssets(root), {code: 'STILL_DESKTOP_RUNTIME_ASSET_UNVERIFIED'});
  registry.assets.desktopMediaManifest = desktopPin; await save();
  const read = await readDesktopMediaRuntimeAssets(root);
  assert.equal(read.desktopMediaManifest.sha256, desktopPin.sha256); assert.deepEqual(read.desktopMediaManifest.bytes, bytes.desktopMediaManifest);
  await readBackendRuntimeAssets(root);
  await fs.writeFile(path.join(root, paths.desktopMediaManifest), '{"mutableAdjacentManifest":true}');
  await assert.rejects(readDesktopMediaRuntimeAssets(root), {code: 'STILL_DESKTOP_RUNTIME_ASSET_UNVERIFIED'});
  await fs.writeFile(path.join(root, paths.desktopMediaManifest), bytes.desktopMediaManifest);
  registry.assets.desktopMediaManifest = {...desktopPin, relativePath: 'native/desktop-media/bin/other.json'}; await save();
  await assert.rejects(readDesktopMediaRuntimeAssets(root)); await assert.rejects(readBackendRuntimeAssets(root));
  registry.assets.desktopMediaManifest = desktopPin; registry.assets.unknown = desktopPin; await save();
  await assert.rejects(readDesktopMediaRuntimeAssets(root)); await assert.rejects(readBackendRuntimeAssets(root));
});

test('runtime schema accepts only core two plus fixed desktop/CUE optional pins and verifies the exact CUE manifest bytes', async t => {
  const root = await temporary(t, 'still-central-cue-runtime-');
  const paths = {backendOutputPolicy: 'src/main/backend-output-policy.json', backendLauncher: 'native/backend-job/StillBackendLauncher.exe',
    desktopMediaManifest: 'native/desktop-media/bin/runtime-manifest.json', cueReadLeaseManifest: 'native/cue-read-lease/bin/runtime-manifest.json'};
  const rows = {}, raw = {};
  for (const [key, relativePath] of Object.entries(paths)) {
    raw[key] = Buffer.from(`SYNTHETIC DATA ONLY: ${key}`); rows[key] = {relativePath, sha256: sha256(raw[key])};
    const file = path.join(root, relativePath); await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, raw[key]);
  }
  const file = path.join(root, 'src/main/runtime-assets.json'), save = assets => fs.writeFile(file, JSON.stringify({schemaVersion: 1, assets}));
  for (const optional of [[], ['desktopMediaManifest'], ['cueReadLeaseManifest'], ['desktopMediaManifest', 'cueReadLeaseManifest']]) {
    const assets = Object.fromEntries(['backendOutputPolicy', 'backendLauncher', ...optional].map(key => [key, rows[key]])); await save(assets);
    assert.equal((await readBackendRuntimeAssets(root)).backendLauncher.sha256, rows.backendLauncher.sha256);
    if (optional.includes('desktopMediaManifest')) await readDesktopMediaRuntimeAssets(root);
    else await assert.rejects(readDesktopMediaRuntimeAssets(root), {code: 'STILL_DESKTOP_RUNTIME_ASSET_UNVERIFIED'});
    if (optional.includes('cueReadLeaseManifest')) {
      const result = await readCueReadLeaseRuntimeAssets(root);
      assert.equal(result.root, root); assert.deepEqual(result.cueReadLeaseManifest, {...rows.cueReadLeaseManifest, bytes: raw.cueReadLeaseManifest});
    } else await assert.rejects(readCueReadLeaseRuntimeAssets(root), {code: 'STILL_CUE_READ_LEASE_RUNTIME_ASSET_UNVERIFIED'});
  }
  await fs.writeFile(path.join(root, paths.cueReadLeaseManifest), 'MUTATED ADJACENT MANIFEST');
  await assert.rejects(readCueReadLeaseRuntimeAssets(root), {code: 'STILL_CUE_READ_LEASE_RUNTIME_ASSET_UNVERIFIED'});
  await fs.writeFile(path.join(root, paths.cueReadLeaseManifest), raw.cueReadLeaseManifest);
  for (const assets of [
    {...rows, unknown: rows.cueReadLeaseManifest},
    {backendLauncher: rows.backendLauncher, desktopMediaManifest: rows.desktopMediaManifest, cueReadLeaseManifest: rows.cueReadLeaseManifest},
    {...rows, cueReadLeaseManifest: {...rows.cueReadLeaseManifest, relativePath: 'native/cue-read-lease/bin/other.json'}},
    {...rows, cueReadLeaseManifest: {...rows.cueReadLeaseManifest, sha256: rows.cueReadLeaseManifest.sha256.toUpperCase()}},
    {...rows, cueReadLeaseManifest: {...rows.cueReadLeaseManifest, sha256: [rows.cueReadLeaseManifest.sha256]}},
    {...rows, cueReadLeaseManifest: {...rows.cueReadLeaseManifest, extra: true}}
  ]) {
    await save(assets);
    await assert.rejects(readBackendRuntimeAssets(root), {code: 'STILL_BACKEND_RUNTIME_ASSET_UNVERIFIED'});
    await assert.rejects(readCueReadLeaseRuntimeAssets(root), {code: 'STILL_CUE_READ_LEASE_RUNTIME_ASSET_UNVERIFIED'});
  }
});

test('desktop bridge exposes only status and bounded timer commands and never revives credential IPC', async () => {
  let bridge; const calls = [], listeners = new Map();
  const context = {require(name) {assert.equal(name, 'electron'); return {contextBridge: {exposeInMainWorld(name, value) {assert.equal(name, 'still'); bridge = value;}},
    ipcRenderer: {invoke: async (channel, payload) => {calls.push({channel, payload}); return {ok: true, value: {channel}};}, on: (name, listener) => listeners.set(name, listener), removeListener: name => listeners.delete(name)}};}};
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../src/main/preload.js'), 'utf8'), context);
  for (const channel of ['desktop:status', 'desktop:sleepTimer:set', 'desktop:sleepTimer:cancel']) await bridge.invoke(channel, channel.endsWith(':set') ? {minutes: 15} : {});
  for (const channel of ['desktop:action', 'desktop:artwork', 'desktop:windowHandle', 'desktop:stopAndRelease', 'apple:configure-key', 'apple:import-token']) await assert.rejects(bridge.invoke(channel));
  assert.equal(calls.length, 3); const remove = bridge.on('desktop', () => {}); assert.equal(listeners.has('desktop'), true); remove(); assert.equal(listeners.size, 0);
  const removeCue = bridge.on('cue-discovery', () => {}); assert.equal(listeners.has('cue-discovery'), true); removeCue();
  await assert.rejects(bridge.invoke('cue-discovery')); await assert.rejects(bridge.invoke('cue:inspect'));
  assert.equal(commandAvailability('desktop:status', {readOnly: true}).ok, true); assert.equal(SMOKE_READ_CHANNELS.has('desktop:status'), true);
  for (const channel of ['desktop:sleepTimer:set', 'desktop:sleepTimer:cancel']) {assert.equal(commandAvailability(channel, {readOnly: true}).ok, false); assert.equal(SMOKE_READ_CHANNELS.has(channel), false);}
});

test('desktop callbacks route controls through current-source coordinator and enforce runtime policy', async () => {
  const calls = []; let runtime = {};
  const callbacks = createDesktopPlaybackCallbacks({coordinator: {commandForCurrentSource: async (...args) => {calls.push(args); return {state: 'paused'};}},
    getRuntimeState: () => runtime, mapState: state => ({...state, mapped: true})});
  assert.equal((await callbacks.performAction({action: 'play', source: 'apple', generation: 4})).mapped, true);
  await callbacks.performAction({action: 'seek', source: 'local', generation: 5, position: 6});
  assert.deepEqual(calls, [['apple', 4, 'toggle'], ['local', 5, 'seek', 6]]);
  for (const value of [{action: 'openPath', source: 'local', generation: 5}, {action: 'seek', source: 'local', generation: 5, position: Infinity}, {action: 'stop', source: 'foreign', generation: 5}]) await assert.rejects(callbacks.performAction(value));
  runtime = {readOnly: true}; await assert.rejects(callbacks.performAction({action: 'stop', source: 'local', generation: 5})); assert.equal(calls.length, 2);
});

test('a desktop command reply superseded before mapping cannot publish old actual state', async () => {
  const gate = deferred(); let generation = 1, mapped = false;
  const callbacks = createDesktopPlaybackCallbacks({coordinator: {currentGeneration: () => generation, commandForCurrentSource: () => gate.promise}, mapState: () => {mapped = true;}});
  const work = callbacks.performAction({action: 'pause', source: 'local', generation: 1}), rejected = assert.rejects(work, {code: 'STILL_CONTEXT_CHANGED'});
  generation = 2; gate.resolve({generation: 1, state: 'paused'}); await rejected; assert.equal(mapped, false);
});

test('lyrics search validates and forwards explicit providers without changing preview or bind candidates', async () => {
  const calls = [], candidate = {source: 'qq', id: 'candidate'};
  const h = createHandlers({library: {}, foobar: {}, settings: {get: () => DEFAULTS}, lyrics: {
    search: async input => {calls.push(input); return input;}, preview: async input => input, bind: async input => input}});
  await h['lyrics:search']({trackId: 'song'}); await h['lyrics:search']({trackId: 'song', source: 'qq', query: 'query'});
  assert.deepEqual(calls, [{trackId: 'song', source: 'lrclib', query: undefined}, {trackId: 'song', source: 'qq', query: 'query'}]);
  assert.throws(() => h['lyrics:search']({trackId: 'song', source: 'arbitrary'})); assert.equal(calls.length, 2);
  assert.equal((await h['lyrics:preview']({trackId: 'song', candidate})).candidate, candidate);
  assert.equal((await h['lyrics:bind']({trackId: 'song', candidate})).candidate, candidate); h.closePlaybackContext();
});

test('renderer bootstrap registers the desktop section with explicit app/features before starting', () => {
  const calls = [], app = {start() {calls.push('start');}}, glass = {init() {calls.push('glass');}}, features = {registerSettingsSection(id, render) {assert.equal(id, 'desktop'); calls.push('register'); this.renderDesktop = render;}};
  const definitions = ['timeline', 'libraryState', 'app', 'glass', 'features'].map(name => ({name, create: () => ({app, glass, features}[name] || {})}));
  const desktop = {render: ctx => ctx, dispose() {calls.push('dispose');}};
  const runtime = createRuntime(definitions, {desktopControls: {createModule(dependencies) {assert.equal(dependencies.app, app); assert.equal(dependencies.features, features); return desktop;}}});
  assert.deepEqual(calls, ['register']); const context = {current: () => true}; assert.equal(features.renderDesktop(context), context);
  runtime.start(); runtime.start(); runtime.dispose(); assert.deepEqual(calls, ['register', 'glass', 'start', 'dispose']);
});

test('shutdown synchronously invalidates desktop work before backend drain and waits before settings close', async () => {
  const calls = [], gate = deferred();
  const work = shutdownDesktop({desktop: {beginShutdown() {calls.push('desktop-begin'); return gate.promise;}},
    coordinator: {beginShutdown() {calls.push('coordinator'); return {settled: Promise.resolve()};}},
    foobar: {beginShutdownWrites() {calls.push('writes'); return {};}, close: async () => {}}, backend: {getInfo: () => ({owned: false}), close: async () => {calls.push('backend');}},
    closeServices: [async () => {calls.push('settings-close');}], drainTimeoutMs: 1000});
  assert.deepEqual(calls.slice(0, 3), ['desktop-begin', 'writes', 'coordinator']); await tick();
  assert.equal(calls.includes('settings-close'), false); gate.resolve(); await work;
  assert.equal(calls.at(-1), 'settings-close');
});

test('a failed backend close still awaits desktop helper and placement cleanup before propagating shutdown failure', async () => {
  const gate = deferred(); let completed = false, settingsClosed = false;
  const work = shutdownDesktop({desktop: {beginShutdown: () => gate.promise},
    coordinator: {beginShutdown: () => ({settled: Promise.resolve()})}, foobar: {beginShutdownWrites: () => ({}), close: async () => {}},
    backend: {getInfo: () => ({owned: false}), close: async () => {throw new Error('fixture backend exit unverified');}},
    closeServices: [async () => {settingsClosed = true;}]}).catch(error => {completed = true; throw error;});
  const rejected = assert.rejects(work, /backend exit unverified/); await tick(); assert.equal(completed, false); assert.equal(settingsClosed, false);
  gate.resolve(); await rejected; assert.equal(settingsClosed, false);
});

test('shutdown cancels CUE synchronously before a library drain can wait for its pending inspect', async () => {
  const inspect = deferred(), physicalClose = deferred(), calls = [];
  const work = shutdownDesktop({cueDiscovery: {close() {calls.push('cue-cancel'); inspect.resolve(); return physicalClose.promise;}},
    coordinator: {beginShutdown: () => ({settled: Promise.resolve()})}, foobar: {beginShutdownWrites: () => ({}), close: async () => {}},
    backend: {getInfo: () => ({owned: false}), close: async () => {calls.push('backend-close');}},
    closeServices: [async () => {calls.push('library-close'); await inspect.promise;}, async () => {calls.push('settings-close');}]});
  assert.equal(calls[0], 'cue-cancel'); await tick(); assert.equal(calls.includes('library-close'), false); assert.equal(calls.includes('settings-close'), false);
  physicalClose.resolve(); await work; assert.ok(calls.indexOf('cue-cancel') < calls.indexOf('library-close'));
});

test('CUE close failure still awaits desktop helper closure before shutdown can reject', async () => {
  const helper = deferred(); let completed = false, settingsClosed = false;
  const work = shutdownDesktop({cueDiscovery: {close: () => Promise.reject(new Error('SYNTHETIC CUE exit unverified'))}, desktop: {beginShutdown: () => helper.promise},
    coordinator: {beginShutdown: () => ({settled: Promise.resolve()})}, foobar: {beginShutdownWrites: () => ({}), close: async () => {}},
    backend: {getInfo: () => ({owned: false}), close: async () => ({})}, closeServices: [async () => {settingsClosed = true;}]}).catch(error => {completed = true; throw error;});
  const rejected = assert.rejects(work, /CUE exit unverified/); await tick(); assert.equal(completed, false); assert.equal(settingsClosed, false);
  helper.resolve(); await rejected; assert.equal(settingsClosed, false);
});

test('timer atomically claims generation, cancels old commits, verifies stop and requires independent release proof', async t => {
  const f = controlled(t), before = f.coordinator.currentGeneration(), work = f.request();
  assert.equal(f.coordinator.currentGeneration(), before + 1); assert.equal(f.calls[0], 'cancel');
  const result = await work;
  assert.equal(result.released, true); assert.equal(result.state.state, 'stopped');
  assert.ok(f.calls.indexOf('stop') < f.calls.indexOf('release-proof')); assert.equal(f.calls.some(value => value.startsWith('play:')), false);
  for (const proof of [{released: false}, {released: true}, {released: true, evidence: {}}]) {
    f.local.proof = proof; await assert.rejects(f.request(), {code: 'STILL_OUTPUT_RELEASE_UNVERIFIED'});
  }
});

test('obsolete source, generation and cancelled timer refuse before cancelling another request', async t => {
  const f = controlled(t);
  for (const patch of [{source: 'apple'}, {generation: 99}]) await assert.rejects(f.coordinator.stopAndReleaseForCurrentSource({source: 'local', generation: 0, origin: 'sleep-timer', isCurrent: () => true, ...patch}), {code: 'STILL_CONTEXT_CHANGED'});
  f.controller.abort(); await assert.rejects(f.request(), {code: 'STILL_CANCELLED'}); assert.deepEqual(f.calls, []);
});

test('cancel or rearm during initial read cannot later stop replacement playback', async t => {
  const f = controlled(t), gate = f.gate(); f.local.readGate = gate;
  const work = f.request(), rejected = assert.rejects(work, {code: 'STILL_CANCELLED'}); await tick();
  f.controller.abort(); await rejected; await f.coordinator.play({input: {id: 'replacement'}});
  gate.resolve(); await tick(); assert.equal(f.calls.includes('stop'), false); assert.equal(f.calls.includes('release-enter'), false);
  assert.equal((await f.coordinator.getState()).currentTrackId, 'replacement');
});

test('a newer playback generation wins while the previous timer is waiting for its strict snapshot', async t => {
  const f = controlled(t), gate = f.gate(); f.local.prepareGate = gate;
  const work = f.request(), rejected = assert.rejects(work, {code: 'STILL_CANCELLED'}); await tick();
  await f.coordinator.play({input: {id: 'replacement'}}); await rejected; gate.resolve(); await tick();
  assert.equal(f.calls.includes('stop'), false); assert.equal(f.calls.includes('release-enter'), false);
  assert.equal((await f.coordinator.getState()).currentTrackId, 'replacement');
});

test('a stopped response from stop without actual stopped readback cannot enter release', async t => {
  const f = controlled(t); f.local.stop = async context => {context.check(); f.calls.push('stop'); return {available: true, state: 'stopped'};};
  await assert.rejects(f.request(), {code: 'STILL_TRANSPORT_UNCERTAIN'}); assert.equal(f.calls.includes('release-enter'), false);
});

for (const boundary of ['prepare', 'release']) test(`source change or quit during ${boundary} cannot dispatch a late destructive action`, async t => {
  const f = controlled(t), gate = f.gate(); f.local[`${boundary}Gate`] = gate;
  const work = f.request(), rejected = assert.rejects(work, {code: 'STILL_CANCELLED'}); await tick();
  const shutdown = f.coordinator.beginShutdown(); await rejected; gate.resolve(); await shutdown.settled;
  assert.equal(f.calls.includes('release-proof'), false); if (boundary === 'prepare') assert.equal(f.calls.includes('stop'), false);
});

test('a timer current predicate is rechecked immediately before output release destruction', async t => {
  const f = controlled(t), gate = f.gate(); f.local.releaseGate = gate;
  const work = f.request(), rejected = assert.rejects(work, {code: 'STILL_CANCELLED'}); await tick(); f.obsolete(); gate.resolve(); await rejected;
  assert.equal(f.calls.includes('release-proof'), false);
});

for (const state of [{available: false, state: 'stopped'}, {available: true, state: 'playing', stale: true}, {available: true, state: 'playing', controlUncertain: true}]) test(`uncertain actual readback refuses timed stop: ${JSON.stringify(state)}`, async t => {
  const f = controlled(t); f.setLocal(state); await assert.rejects(f.request(), {code: 'STILL_TRANSPORT_UNCERTAIN'}); assert.equal(f.calls.includes('stop'), false);
});

test('conflicting actual engine readbacks cannot be guessed into a timed stop', async t => {
  const f = controlled(t); f.setApple({available: true, state: 'playing'}); await assert.rejects(f.request(), {code: 'STILL_TRANSPORT_UNCERTAIN'}); assert.equal(f.calls.includes('stop'), false);
});

test('production owned-session contract releases through exact endpoint and strict saved snapshot without auto-play', async t => {
  const f = await mainCoreFixture(t), current = await f.coordinator.getState();
  const result = await f.coordinator.stopAndReleaseForCurrentSource({source: 'local', generation: current.generation, origin: 'sleep-timer', isCurrent: () => true});
  assert.equal(result.released, true); assert.equal(result.evidence.method, 'verified-owned-source-exit');
  assert.equal(f.exitCalls(), 1); assert.equal(f.appleStarts(), 0); assert.equal(f.raw.getHandoffStatus().pendingRestore, true);
  assert.equal(f.calls.some(call => /player\/play/.test(call.route)), false);
});

test('real desktop timer composes with main callbacks and owned release while browsing another source', async t => {
  const f = await mainCoreFixture(t), clock = timerClock(), settings = {get: () => ({...DEFAULTS, desktop: {...DEFAULTS.desktop, preventSleep: false, systemMediaControls: false}})};
  const h = createHandlers({coordinator: f.coordinator, foobar: f.guarded, getBackendInfo: f.getInfo,
    library: {list: () => ({tracks: [], playlists: []})}, settings});
  const desktop = createDesktopIntegration({settings, clock, getPlayer: () => h['player:state']({}), getSources: () => h['source:status']({}),
    ...createDesktopPlaybackCallbacks({coordinator: f.coordinator}), createMediaClient() {assert.fail('Disabled SMTC must never create a native client');}});
  t.after(() => desktop.beginShutdown()); t.after(() => h.closePlaybackContext());
  await h['source:select']({source: 'apple'});
  desktop.handlers['desktop:sleepTimer:set']({minutes: 1}); clock.advance(60000);
  await waitFor(() => ['completed', 'error'].includes(desktop.getStatus().sleepTimer.status));
  assert.equal(desktop.getStatus().sleepTimer.status, 'completed'); assert.equal(f.exitCalls(), 1); assert.equal(f.appleStarts(), 0);
  assert.equal(f.calls.some(call => /player\/play/.test(call.route)), false);
});

test('real timer cancellation during an actual-player read never reaches a later stop or release', async t => {
  const f = await mainCoreFixture(t), clock = timerClock(), gate = deferred(), entered = deferred();
  const settings = {get: () => ({...DEFAULTS, desktop: {...DEFAULTS.desktop, preventSleep: false, systemMediaControls: false}})};
  const desktop = createDesktopIntegration({settings, clock, getSources: async () => ({sources: {local: {available: true}}}),
    getPlayer: async () => {const actual = await f.coordinator.getState(); entered.resolve(); await gate.promise; return actual;},
    ...createDesktopPlaybackCallbacks({coordinator: f.coordinator}), createMediaClient() {assert.fail('Disabled SMTC must never create a native client');}});
  t.after(() => desktop.beginShutdown());
  desktop.handlers['desktop:sleepTimer:set']({minutes: 1}); clock.advance(60000); await entered.promise;
  desktop.handlers['desktop:sleepTimer:cancel']({}); gate.resolve(); await tick(); await tick();
  assert.equal(desktop.getStatus().sleepTimer.status, 'cancelled'); assert.equal(f.calls.some(call => call.route === 'player/stop'), false);
  assert.equal(f.exitCalls(), 0); assert.equal((await f.coordinator.getState()).state, 'playing');
});

test('a real owned backend with stopped but no source history cannot be relabeled as released by the timer', async t => {
  const f = await mainCoreFixture(t), clock = timerClock(); await f.raw.stop();
  const actual = await f.coordinator.getState(); assert.equal(actual.state, 'stopped'); assert.equal(actual.source, null); assert.equal(actual.lastSource, null);
  const settings = {get: () => ({...DEFAULTS, desktop: {...DEFAULTS.desktop, preventSleep: false, systemMediaControls: false}})};
  const desktop = createDesktopIntegration({settings, clock, getPlayer: () => f.coordinator.getState(), getSources: async () => ({sources: {local: {available: true}}}),
    ...createDesktopPlaybackCallbacks({coordinator: f.coordinator}), createMediaClient() {assert.fail('Disabled SMTC must never create a native client');}});
  t.after(() => desktop.beginShutdown());
  desktop.handlers['desktop:sleepTimer:set']({minutes: 1}); clock.advance(60000);
  await waitFor(() => ['completed', 'error'].includes(desktop.getStatus().sleepTimer.status));
  assert.equal(desktop.getStatus().sleepTimer.status, 'error'); assert.equal(f.exitCalls(), 0);
});

test('production release contract rejects a changed exact playlist snapshot before owned exit', async t => {
  const f = await mainCoreFixture(t), probe = f.manager.waitForOutputRelease.bind(f.manager), current = await f.coordinator.getState();
  f.manager.waitForOutputRelease = async args => {try {return await probe(args);} catch (error) {f.rows.push({path: 'C:/Fixture/changed.flac', subsong: 0}); throw error;}};
  await assert.rejects(f.coordinator.stopAndReleaseForCurrentSource({source: 'local', generation: current.generation, origin: 'sleep-timer', isCurrent: () => true}), {code: 'STILL_HANDOFF_CONTEXT_CHANGED'});
  assert.equal(f.exitCalls(), 0); assert.equal(f.appleStarts(), 0);
});

test('production release contract rejects untrusted endpoint evidence before owned exit', async t => {
  const f = await mainCoreFixture(t), current = await f.coordinator.getState();
  f.manager.waitForOutputRelease = async () => {throw Object.assign(new Error('Synthetic untrusted endpoint'), {code: 'STILL_OUTPUT_RELEASE_UNVERIFIED', releaseEvidence: {classification: 'unknown', trustedEndpoint: false, probeChildExited: true}});};
  await assert.rejects(f.coordinator.stopAndReleaseForCurrentSource({source: 'local', generation: current.generation, origin: 'sleep-timer', isCurrent: () => true}), {code: 'STILL_OUTPUT_RELEASE_UNVERIFIED'});
  assert.equal(f.exitCalls(), 0); assert.equal(f.appleStarts(), 0);
});
