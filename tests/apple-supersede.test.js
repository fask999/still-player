'use strict';
// Real Node transport/coordinator + VM bridge; all child/browser/SDK values are
// synthetic. No executable, profile, browser, network or audio is touched.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {EventEmitter} = require('node:events');
const {PassThrough, Writable} = require('node:stream');
const runtimeRoot = process.env.STILL_APPLE_FIXTURE_RUNTIME_ROOT || path.join(__dirname, '..');
const {createOfficialAppleMusicService, createNativeOfficialHost} = require(path.join(runtimeRoot, 'src/main/apple-official-web'));
const {createPlaybackCoordinator} = require(path.join(runtimeRoot, 'src/main/playback-coordinator'));
const bridgeSource = fs.readFileSync(path.join(runtimeRoot, 'native/apple-host/official-bridge.js'), 'utf8');
const gate = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const song = id => ({id, type: 'songs', attributes: {name: `Synthetic ${id}`, durationInMillis: 240000, playParams: {id, kind: 'song'}}});

async function fixture(t, options = {}) {
  const children = [], wire = [], oldQueue = gate(), oldEntered = gate(), closeEntered = gate(), closeGate = gate(), secondSpawned = gate(), secondReady = gate(), secondMkdir = gate(), secondMkdirEntered = gate();
  let mkdirCalls = 0;
  let secretReads = 0, localStarts = 0;
  if (!options.holdClose) closeGate.resolve(); if (!options.holdSecondReady) secondReady.resolve();
  if (!options.holdSecondMkdir) secondMkdir.resolve();
  const spawnImpl = (_file, args) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    const entry = {child, profile: args[0], number: children.length + 1, nativeReady: true, closing: false, muted: true, unmuted: [], queueCalls: [], pending: new Map()};
    children.push(entry);
    const music = {isAuthorized: true, isPlaying: false, playbackState: 0, currentPlaybackTime: 0, currentPlaybackDuration: 240,
      nowPlayingItem: null, volume: 0.5, storefrontId: 'cn', queue: {items: []},
      api: {music: async () => ({data: {data: ['A', 'B', 'C'].map((letter, index) => ({...song(`i.fixture${letter}`), type: 'library-songs',
        attributes: {name: `Synthetic ${letter}`, durationInMillis: 240000, playParams: {id: `i.fixture${letter}`, kind: 'song', isLibrary: true, catalogId: `145000000${index + 1}`}}}))}})},
      async setQueue(value) {
        entry.queueCalls.push([...value.songs]);
        if (entry.number === 1) {oldEntered.resolve(); await oldQueue.promise;}
        music.nowPlayingItem = song(value.songs[0]); music.queue.items = [music.nowPlayingItem];
      },
      play() {music.isPlaying = true; music.playbackState = 2;}, pause() {music.isPlaying = false; music.playbackState = 3;},
      stop() {music.isPlaying = false; music.playbackState = 4;}, seekToTime(position) {music.currentPlaybackTime = position;},
      skipToNextItem() {}, skipToPreviousItem() {}};
    entry.music = music;
    for (const name of ['developerToken', 'musicUserToken', 'configuration', 'token']) Object.defineProperty(music, name, {get() {secretReads++; throw new Error('Synthetic secret getter forbidden');}});
    const context = {location: {origin: 'https://music.apple.com'}, MusicKit: {getInstance: () => music}, URL, URLSearchParams, setTimeout};
    context.window = context; context.top = context; entry.bridge = vm.runInNewContext(bridgeSource, context);
    const output = value => {if (child.exitCode === null) child.stdout.write(`${JSON.stringify(value)}\n`);};
    entry.policyMessage = value => output({type: 'autoplay-policy', ...value});
    entry.navigationLoading = () => {entry.nativeReady = false; output({type: 'phase', phase: 'loading'});};
    const retire = () => {
      for (const [rpcId, command] of entry.pending) if (['play', 'resume'].includes(command.method)) {
        entry.pending.delete(rpcId); output({type: 'response', rpcId, ok: false, code: 'cancelled'}); entry.muted = true;
      }
    };
    child.stdin = new Writable({write(chunk, _encoding, callback) {
      for (const line of String(chunk).trim().split('\n')) {
        const command = JSON.parse(line); wire.push({session: entry.number, closing: entry.closing, method: command.method, id: command.id,
          preservePlaybackPermission: command.preservePlaybackPermission === true});
        if (['play', 'resume', 'pause', 'stop', 'cancel', 'close'].includes(command.method)) retire();
        if (command.method === 'close') {
          entry.closing = true; entry.nativeReady = false; entry.muted = true; closeEntered.resolve();
          void entry.bridge({method: 'cancel'}).then(() => closeGate.promise).then(() => {
            output({type: 'response', rpcId: command.rpcId, ok: true, value: {closed: true, browserProcessExited: options.browserExit !== false}});
            child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit('close', 0);
          }); continue;
        }
        if (command.method === 'show') {output({type: 'response', rpcId: command.rpcId, ok: true, value: {shown: true}}); continue;}
        if (!entry.nativeReady) {output({type: 'response', rpcId: command.rpcId, ok: false, code: 'official-player-not-ready'}); continue;}
        if (command.method === 'probe' && music.isPlaying) music.currentPlaybackTime += 0.1;
        entry.pending.set(command.rpcId, command);
        if (['play', 'resume'].includes(command.method)) entry.muted = true;
        void entry.bridge(command).then(result => {
          if (child.exitCode !== null || !entry.pending.has(command.rpcId)) return;
          entry.pending.delete(command.rpcId);
          if (['play', 'resume'].includes(command.method) && result.ok) {
            entry.muted = !(result.value.isPlaying && (command.method === 'resume' || result.value.currentTrackId === command.id));
            if (!entry.muted) entry.unmuted.push(result.value.currentTrackId);
          }
          if (result.value) result.value.outputMuted = entry.muted;
          output({type: 'response', rpcId: command.rpcId, ...result});
        });
      }
      callback();
    }});
    child.kill = () => {throw new Error('Synthetic case must not need kill');};
    void Promise.resolve().then(async () => {
      if (entry.number === 2) {secondSpawned.resolve(); await secondReady.promise;}
      if (options.failSecondReady && entry.number === 2) {entry.nativeReady = false; output({type: 'error', code: 'official-player-not-ready', origin: 'native-sdk-ready-timeout'}); return;}
      output({type: 'ready', origin: 'https://music.apple.com', runtime: 'synthetic-supersede'});
    });
    return child;
  };
  const native = createNativeOfficialHost({hostPath: __filename, profileDir: path.join(__dirname, 'never-created-profile'), spawnImpl,
    mkdirImpl: async () => {if (++mkdirCalls === 2) {secondMkdirEntered.resolve(); await secondMkdir.promise;}}});
  const apple = createOfficialAppleMusicService({dataDir: path.join(__dirname, 'never-created-data'), hostPath: __filename,
    hostFactory: () => native, runtimeDetector: async () => 'synthetic-runtime', verificationTimeout: 150, pollInterval: 2});
  await apple.initialize(); await apple.authorize(); await apple.library();
  const local = {cancelPending: async () => {}, stop: async () => {}, releaseOutput: async () => ({released: true}), getState: async () => ({available: true, state: localStarts ? 'playing' : 'stopped'}), play: async () => {localStarts++;}};
  const coordinator = createPlaybackCoordinator({engines: {apple, local}, defaultSource: 'apple'});
  t.after(async () => {oldQueue.resolve(); closeGate.resolve(); secondReady.resolve(); secondMkdir.resolve(); await coordinator.close().catch(() => {}); await apple.close().catch(() => {}); assert.equal(secretReads, 0);});
  const play = letter => coordinator.play({source: 'apple', input: {id: `i.fixture${letter}`, kind: 'library-songs'}});
  return {apple, native, coordinator, children, wire, oldEntered, oldQueue, closeEntered, closeGate, secondSpawned, secondReady, secondMkdir, secondMkdirEntered, play, localStarts: () => localStarts};
}

test('same-source explicit B waits for owned browser/helper exit then really plays in one fresh same-profile session', async t => {
  const f = await fixture(t, {holdClose: true}); const a = f.play('A'); a.catch(() => {}); await f.oldEntered.promise;
  const b = f.play('B'); b.catch(() => {}); await f.closeEntered.promise;
  await tick(); assert.equal(f.children.length, 1);
  f.closeGate.resolve(); const result = await b;
  assert.equal(f.wire.some(row => row.closing && row.method !== 'close'), false);
  await assert.rejects(a, {code: 'STILL_CANCELLED'});
  assert.equal(result.currentTrackId, '1450000002'); assert.equal(f.children.length, 2);
  assert.equal(f.children[0].profile, f.children[1].profile);
  assert.deepEqual(f.children[0].unmuted, []); assert.deepEqual(f.children[1].unmuted, ['1450000002']);
  f.oldQueue.resolve(); await tick(); assert.equal(f.children[1].child.exitCode, null); assert.equal(f.children[1].muted, false);
  assert.equal(f.apple.status().pending, false); assert.equal(f.apple.status().controlsReady, true);
});

test('rapid A/B/C during closing and fresh readiness keeps one rebuild and dispatches only C', async t => {
  const f = await fixture(t, {holdClose: true, holdSecondReady: true});
  const a = f.play('A'); a.catch(() => {}); await f.oldEntered.promise;
  const b = f.play('B'); b.catch(() => {}); await f.closeEntered.promise; f.closeGate.resolve(); await f.secondSpawned.promise;
  const c = f.play('C'); await tick(); assert.equal(f.children.length, 2); assert.deepEqual(f.children[1].queueCalls, []);
  f.secondReady.resolve(); assert.equal((await c).currentTrackId, '1450000003');
  await assert.rejects(a, {code: 'STILL_CANCELLED'}); await assert.rejects(b, {code: 'STILL_CANCELLED'});
  assert.deepEqual(f.children[1].queueCalls, [['1450000003']]); assert.deepEqual(f.children[1].unmuted, ['1450000003']);
  f.oldQueue.resolve(); await tick(); assert.equal(f.children[1].child.exitCode, null); assert.equal(f.children[1].muted, false);
});

test('missing browser-exit witness blocks B and never creates a replacement', async t => {
  const f = await fixture(t, {browserExit: false}); const a = f.play('A'); a.catch(() => {}); await f.oldEntered.promise;
  await assert.rejects(f.play('B'), {code: 'official-audio-cleanup-unverified'});
  await assert.rejects(a, {code: 'STILL_CANCELLED'}); assert.equal(f.children.length, 1);
  assert.equal(f.apple.status().audioReleaseUnverified, true);
});

for (const method of ['pause', 'stop']) test(`${method} cancels pending A without any automatic rebuild or old queue resurrection`, async t => {
  const f = await fixture(t); const a = f.play('A'); a.catch(() => {}); await f.oldEntered.promise;
  await f.coordinator.command(method).catch(error => {assert.equal(error.code, 'session-closed');});
  await assert.rejects(a, {code: 'STILL_CANCELLED'}); f.oldQueue.resolve(); await tick();
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].unmuted, []);
});

test('cross-source cancellation releases A without rebuilding Apple', async t => {
  const f = await fixture(t); const a = f.play('A'); a.catch(() => {}); await f.oldEntered.promise;
  await f.coordinator.play({source: 'local', input: {id: 'synthetic-local'}});
  await assert.rejects(a, {code: 'STILL_CANCELLED'}); assert.equal(f.localStarts(), 1); assert.equal(f.children.length, 1);
});

test('a replacement whose current SDK is not ready never receives queue/play or a third automatic retry', async t => {
  const f = await fixture(t, {failSecondReady: true}); const a = f.play('A'); a.catch(() => {}); await f.oldEntered.promise;
  await assert.rejects(f.play('B'), {code: 'official-player-not-ready'}); await assert.rejects(a, {code: 'STILL_CANCELLED'});
  assert.equal(f.children.length, 2); assert.deepEqual(f.children[1].queueCalls, []); assert.deepEqual(f.children[1].unmuted, []);
  assert.equal(f.apple.status().controlsReady, false);
  assert.equal(f.apple.status().lastOperation.origin, 'native-sdk-ready-timeout');
});

test('no verified current context means resume, next and seek never fabricate a queue or rebuild a session', async t => {
  const f = await fixture(t);
  await assert.rejects(f.apple.resume(), {code: 'official-control-unavailable'});
  await assert.rejects(f.apple.next(), {code: 'official-control-unavailable'});
  await assert.rejects(f.apple.seek(30), {code: 'official-control-unavailable'});
  assert.equal(f.children.length, 1); assert.equal(f.wire.some(row => ['resume', 'next', 'seek', 'play'].includes(row.method)), false);
});

test('known navigation loading reports null observations and rejects commands without a readiness retry or probe', async t => {
  const f = await fixture(t); f.children[0].navigationLoading(); await tick();
  const before = f.wire.length, state = await f.apple.getState();
  assert.equal(state.pending, true); assert.equal(state.position, null); assert.equal(state.outputMuted, null);
  assert.equal(f.apple.status().pending, true); assert.equal(f.apple.status().controlsReady, false);
  await assert.rejects(f.play('B'), {code: 'official-player-not-ready', origin: 'node-page-not-ready'});
  assert.equal(f.children.length, 1); assert.equal(f.wire.slice(before).some(row => ['play', 'probe'].includes(row.method)), false);
  assert.equal(f.apple.status().lastOperation.failedFromStage, 'authorization-check');
});

test('a manually closed owned session cannot be automatically rebuilt by a later play without a supersede permit', async t => {
  const f = await fixture(t); await f.native.close();
  await assert.rejects(f.play('B'), {code: 'session-closed'}); assert.equal(f.children.length, 1);
});

test('quit while the old context is closing revokes B rebuild permission', async t => {
  const f = await fixture(t, {holdClose: true}); const a = f.play('A'); a.catch(() => {}); await f.oldEntered.promise;
  const b = f.play('B'); b.catch(() => {}); await f.closeEntered.promise;
  const quitting = f.coordinator.close(); f.closeGate.resolve(); await quitting;
  await assert.rejects(a, {code: 'STILL_CANCELLED'}); await assert.rejects(b, {code: 'STILL_CANCELLED'});
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].unmuted, []);
});

test('explicit operation history is bounded, cloned and unaffected by background status probes', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index++) await f.apple.library();
  const first = f.apple.status(); assert.equal(first.operationHistory.length, 16);
  assert.ok(first.operationHistory.every(row => Number.isInteger(row.operationId) && Number.isInteger(row.generation)));
  first.operationHistory[0].method = 'arbitrary-input';
  const copy = f.apple.status().operationHistory; await f.apple.getState();
  assert.deepEqual(f.apple.status().operationHistory, copy); assert.notEqual(copy[0].method, 'arbitrary-input');
  assert.equal(JSON.stringify(copy).includes('http'), false);
});

test('a completed A and a newer B reuse the ready context after the real cancel acknowledgment', async t => {
  const f = await fixture(t); f.oldQueue.resolve();
  assert.equal((await f.play('A')).currentTrackId, '1450000001');
  assert.equal((await f.play('B')).currentTrackId, '1450000002');
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].unmuted, ['1450000001', '1450000002']);
  assert.equal(f.apple.status().controlsReady, true);
});

test('the exact post-exit pre-spawn gap accepts only a verified explicit play intent without advertising online playback', async t => {
  const f = await fixture(t, {holdSecondMkdir: true}); const a = f.play('A'); a.catch(() => {}); await f.oldEntered.promise;
  const b = f.play('B'); b.catch(() => {}); await f.secondMkdirEntered.promise;
  const status = f.apple.status(); assert.equal(status.pending, true); assert.equal(status.available, false); assert.equal(status.capabilities.playback, false);
  assert.equal(status.capabilities.canSubmitPlayIntent, true); assert.deepEqual(status.capabilities.playIntentTypes, ['songs', 'library-songs']);
  assert.equal(f.apple.canSubmitPlayIntent({id: 'i.fixtureC', kind: 'library-songs'}), true);
  for (const input of [{id: 'i.unseen', kind: 'library-songs'}, {id: 'i.fixtureC', kind: 'albums'},
    {id: 'i.fixtureC', kind: 'library-songs', ids: ['i.fixtureC', 'i.fixtureA']}, {id: 'i.fixtureC', kind: 'songs', type: 'library-songs'}]) assert.equal(f.apple.canSubmitPlayIntent(input), false);
  const c = f.play('C'); await tick(); f.secondMkdir.resolve();
  assert.equal((await c).currentTrackId, '1450000003');
  await assert.rejects(a, {code: 'STILL_CANCELLED'}); await assert.rejects(b, {code: 'STILL_CANCELLED'});
  assert.deepEqual(f.children[1].queueCalls, [['1450000003']]); assert.deepEqual(f.children[1].unmuted, ['1450000003']);
  assert.equal(f.apple.status().capabilities.canSubmitPlayIntent, false);
});

test('manual close and service close never gain the pending-intent acceptance capability', async t => {
  const f = await fixture(t); await f.native.close();
  assert.equal(f.apple.status().capabilities.canSubmitPlayIntent, false);
  assert.equal(f.apple.canSubmitPlayIntent({id: 'i.fixtureC', kind: 'library-songs'}), false);
  await f.apple.close(); assert.equal(f.apple.status().capabilities.canSubmitPlayIntent, false);
});

test('ordinary verified Apple volume and seek invalidation preserve session permission; pause and cross-source do not', async t => {
  const f = await fixture(t); f.oldQueue.resolve(); await f.play('A');
  let offset = f.wire.length; await f.coordinator.command('setVolume', 0.7);
  assert.equal(f.wire.slice(offset).find(row => row.method === 'cancel').preservePlaybackPermission, true);
  offset = f.wire.length; await f.coordinator.command('seek', 42);
  assert.equal(f.wire.slice(offset).find(row => row.method === 'cancel').preservePlaybackPermission, true);
  offset = f.wire.length; await f.coordinator.command('pause');
  assert.equal(f.wire.slice(offset).find(row => row.method === 'cancel').preservePlaybackPermission, false);
  assert.equal(f.children.length, 1);
});

test('permission policy diagnostics contain only configured, seen and fixed decisions and do not grant media authority', async t => {
  const f = await fixture(t);
  f.children[0].policyMessage({configured: true, seen: false, decision: 'not-seen', uri: 'https://music.apple.com/?fixture-private-query'});
  await tick(); assert.deepEqual(f.apple.status().autoplayPolicy, {configured: true, seen: false, decision: 'not-seen'});
  assert.equal(f.apple.status().controlsReady, false);
  f.children[0].policyMessage({configured: true, seen: true, decision: 'fixture-private-error'}); await tick();
  assert.deepEqual(f.apple.status().autoplayPolicy, {configured: true, seen: false, decision: 'not-seen'});
  assert.equal(JSON.stringify(f.apple.status()).includes('fixture-private'), false);
  f.children[0].policyMessage({configured: true, seen: true, decision: 'temporary-policy-unavailable'}); await tick();
  await f.native.close(); assert.equal(f.apple.status().autoplayPolicy.decision, 'temporary-policy-unavailable');
});
