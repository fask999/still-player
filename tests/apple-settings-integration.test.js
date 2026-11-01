'use strict';
// Synthetic public SDK/host only. No real account, host, profile, network or audio.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {createOfficialAppleMusicService} = require('../src/main/apple-official-web');
const {createPlaybackCoordinator} = require('../src/main/playback-coordinator');
const bridgeSource = fs.readFileSync(path.join(__dirname, '../native/apple-host/official-bridge.js'), 'utf8');
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const repeat = {none: 17, one: 31, all: 47}, shuffle = {off: 5, songs: 9}, bitrate = {STANDARD: 701, HIGH: 907};
  const calls = [], media = []; let running = false, session = null, revision = 1, ready = true, pending = false, secretReads = 0, writeGate = null;
  let repeatValue = repeat.none;
  const music = {isAuthorized: options.authorized !== false, isPlaying: false, playbackState: 3, currentPlaybackTime: 0, currentPlaybackDuration: 240,
    nowPlayingItem: {id: 'fixture-song', type: 'songs', attributes: {name: 'Synthetic', playParams: {id: 'fixture-song'}}}, volume: 0.5,
    shuffleMode: shuffle.off, queue: {items: []}, api: {music: async () => ({data: {data: []}})},
    setQueue: async () => {media.push('setQueue');}, play: () => {media.push('play'); music.isPlaying = true; music.playbackState = 2;},
    pause: () => {media.push('pause'); music.isPlaying = false; music.playbackState = 3;}, stop: () => {media.push('stop'); music.isPlaying = false; music.playbackState = 4;},
    seekToTime: () => {}, skipToNextItem: () => {}, skipToPreviousItem: () => {}};
  Object.defineProperty(music, 'repeatMode', {get: () => repeatValue, set: value => {calls.push({method: 'sdk-repeat-set', value}); if (!options.ignoreRepeat) repeatValue = value;}});
  Object.defineProperty(music, 'bitrate', {get: () => bitrate.HIGH, set: () => {throw new Error('Quality is read-only');}});
  for (const key of ['developerToken', 'musicUserToken', 'configuration', 'token']) Object.defineProperty(music, key, {get() {secretReads++; throw new Error('Synthetic secret getter forbidden');}});
  const context = {location: {origin: 'https://music.apple.com'}, URL, URLSearchParams, setTimeout,
    __STILL_SETTINGS_DOCUMENT__: 'fixture-document-1', MusicKit: {getInstance: () => music,
      PlayerRepeatMode: options.unsupportedRepeat ? undefined : repeat, PlayerShuffleMode: shuffle, PlaybackBitrate: bitrate}};
  context.window = context; context.top = context; const bridge = vm.runInNewContext(bridgeSource, context);
  const host = {
    startCalls: 0, closeCalls: 0,
    async start() {host.startCalls++; running = true; session = {}; return {runtime: 'synthetic-settings'};},
    isRunning: () => running, isReady: () => running && ready, isStarting: () => false, isClosing: () => false,
    hasUnsettledStart: () => pending, captureSession: () => session, contextRevision: () => revision, runtime: () => 'synthetic-settings',
    async request(method, data = {}) {
      if (!running) throw Object.assign(new Error('closed'), {code: 'host-exited', officialError: true});
      calls.push({method, ...data});
      const documentNonce = context.__STILL_SETTINGS_DOCUMENT__;
      if (method === 'settings-write' && writeGate) {writeGate.entered.resolve(); await writeGate.release.promise;}
      const result = await bridge({method, ...data, ...(method === 'settings-write' ? {documentNonce} : {})});
      if (!result.ok) throw Object.assign(new Error(result.code), {code: result.code === 'cancelled' ? 'STILL_CANCELLED' : result.code, officialError: true});
      return {...result.value, outputMuted: true};
    },
    async cancelPending(data = {}) {calls.push({method: 'cancel', ...data}); return bridge({method: 'cancel', controlGeneration: data.controlGeneration});},
    async close() {host.closeCalls++; running = false; session = null; return {browserProcessExited: true, helperExited: true};},
    closeSession: () => host.close()
  };
  const apple = createOfficialAppleMusicService({dataDir: path.join(__dirname, 'never-created-settings-data'), hostPath: __filename,
    hostFactory: () => host, runtimeDetector: async () => 'synthetic-settings', verificationTimeout: 30, pollInterval: 1});
  await apple.initialize();
  let localCancels = 0;
  const local = {cancelPending: async () => {localCancels++;}, getState: async () => ({available: true, state: 'stopped'}), stop: async () => {}, releaseOutput: async () => ({released: true})};
  const coordinator = createPlaybackCoordinator({engines: {local, apple}, defaultSource: options.owner || 'apple'});
  t.after(async () => {writeGate?.release.resolve(); await coordinator.close(); await apple.close(); assert.equal(secretReads, 0);});
  return {apple, coordinator, host, music, bridge, context, calls, media, repeat, shuffle,
    localCancels: () => localCancels,
    setPending: value => {pending = value;},
    navigate() {revision++; context.__STILL_SETTINGS_DOCUMENT__ = `fixture-document-${revision}`;},
    holdWrite() {writeGate = {entered: deferred(), release: deferred()}; return writeGate;}};
}

test('settings getter never opens a host; existing public named enums and target bitrate are projected without secrets or quality writes', async t => {
  const f = await fixture(t);
  assert.equal((await f.apple.getPlaybackSettings()).status, 'session-closed'); assert.equal(f.host.startCalls, 0); assert.deepEqual(f.calls, []);
  await f.apple.authorize(); const generation = f.coordinator.currentGeneration(), value = await f.apple.getPlaybackSettings();
  assert.equal(value.repeatMode, 'none'); assert.equal(value.shuffleMode, 'off'); assert.equal(value.bitrateTarget, 256);
  assert.equal(value.capabilities.bitrateTarget, false); assert.equal(value.capabilities.canSelectLossless, false); assert.equal(value.capabilities.outputSelection, false);
  assert.deepEqual(value.details, {actualBitrate: null, actualDacRate: null}); assert.equal(f.coordinator.currentGeneration(), generation); assert.deepEqual(f.media, []);
});

test('source-aware settings commands use named enum values, read back actual modes and never start paused media', async t => {
  const f = await fixture(t); await f.apple.authorize(); await f.apple.getPlaybackSettings();
  assert.equal(f.coordinator.controlSource(), 'apple'); assert.equal(f.coordinator.canCommandSource('apple', 'setPlaybackSettings', {repeatMode: 'one'}), true);
  const result = await f.coordinator.commandForSource('apple', 'setPlaybackSettings', {repeatMode: 'one'});
  assert.equal(result.repeatMode, 'one'); assert.equal(f.music.repeatMode, f.repeat.one); assert.notEqual(f.repeat.one, 1);
  const second = await f.coordinator.commandForSource('apple', 'setPlaybackSettings', {shuffleMode: 'songs'});
  assert.equal(second.shuffleMode, 'songs'); assert.equal(f.music.shuffleMode, f.shuffle.songs);
  assert.deepEqual(f.media, []); assert.equal(f.music.isPlaying, false); assert.equal(f.host.closeCalls, 0);
});

test('local owner, malformed, unsupported and pending settings reject before any new intent or native cancel', async t => {
  const local = await fixture(t, {owner: 'local'}); await local.apple.authorize(); await local.apple.getPlaybackSettings();
  let generation = local.coordinator.currentGeneration(), calls = local.calls.length;
  await assert.rejects(local.coordinator.commandForSource('apple', 'setPlaybackSettings', {repeatMode: 'one'}), {code: 'STILL_SOURCE_CONTROL_UNAVAILABLE'});
  assert.equal(local.coordinator.currentGeneration(), generation); assert.equal(local.calls.length, calls); assert.equal(local.localCancels(), 0);
  const f = await fixture(t, {unsupportedRepeat: true}); await f.apple.authorize(); await f.apple.getPlaybackSettings();
  generation = f.coordinator.currentGeneration(); calls = f.calls.length;
  await assert.rejects(f.coordinator.commandForSource('apple', 'setPlaybackSettings', {repeatMode: 'one'}), {code: 'STILL_SOURCE_CONTROL_UNAVAILABLE'});
  await assert.rejects(f.coordinator.commandForSource('apple', 'setPlaybackSettings', {bitrateTarget: 256}), TypeError);
  f.setPending(true); await assert.rejects(f.coordinator.commandForSource('apple', 'setPlaybackSettings', {shuffleMode: 'songs'}), {code: 'STILL_SOURCE_CONTROL_UNAVAILABLE'});
  assert.equal((await f.apple.getPlaybackSettings()).status, 'pending'); assert.equal(f.coordinator.currentGeneration(), generation); assert.equal(f.calls.length, calls);
});

test('direct setters and copied contexts cannot bypass the coordinator source command authority', async t => {
  const f = await fixture(t); await f.apple.authorize(); await f.apple.getPlaybackSettings(); const before = f.calls.length;
  await assert.rejects(f.apple.setPlaybackSettings({repeatMode: 'one'}), {code: 'official-control-unavailable'});
  await assert.rejects(f.apple.setPlaybackSettings({repeatMode: 'one'}, {check() {}, signal: new AbortController().signal}), {code: 'official-control-unavailable'});
  assert.equal(f.calls.length, before);
});

test('ignored SDK setter cannot be returned as requested-value success', async t => {
  const f = await fixture(t, {ignoreRepeat: true}); await f.apple.authorize(); await f.apple.getPlaybackSettings();
  await assert.rejects(f.coordinator.commandForSource('apple', 'setPlaybackSettings', {repeatMode: 'all'}), {code: 'official-setting-unconfirmed'});
  assert.equal((await f.apple.getPlaybackSettings()).repeatMode, 'none'); assert.equal(f.host.closeCalls, 0); assert.deepEqual(f.media, []);
});

test('pause/stop supersedes an already-dispatched setting and its late bridge entry cannot rewrite after the new generation', async t => {
  const f = await fixture(t); await f.apple.authorize(); await f.apple.getPlaybackSettings(); const hold = f.holdWrite();
  const setting = f.coordinator.commandForSource('apple', 'setPlaybackSettings', {repeatMode: 'all'}); setting.catch(() => {}); await hold.entered.promise;
  const stopping = f.coordinator.command('stop'); await assert.rejects(setting, {code: 'STILL_CANCELLED'});
  hold.release.resolve(); await stopping;
  assert.equal(f.music.repeatMode, f.repeat.none); assert.equal(f.calls.some(call => call.method === 'sdk-repeat-set'), false); assert.deepEqual(f.media, ['stop']);
});

test('a document change invalidates a queued settings write and the cached support proof', async t => {
  const f = await fixture(t); await f.apple.authorize(); await f.apple.getPlaybackSettings(); const hold = f.holdWrite();
  const setting = f.coordinator.commandForSource('apple', 'setPlaybackSettings', {repeatMode: 'all'}); setting.catch(() => {}); await hold.entered.promise;
  f.navigate(); hold.release.resolve(); await assert.rejects(setting, {code: 'STILL_CANCELLED'});
  assert.equal(f.music.repeatMode, f.repeat.none); assert.equal(f.apple.canSetPlaybackSettings({repeatMode: 'one'}), false);
});
