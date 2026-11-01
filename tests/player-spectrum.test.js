'use strict';
// Reviewed peer DTO fixtures plus injected clients. No reader, pipe or audio IO.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createPlayerSpectrumService} = require('../src/main/player-spectrum');
const {mainCoreFixture} = require('./helpers/main-core-fixture');
const running = JSON.parse(fs.readFileSync(path.join(__dirname, '../review-evidence/spectrum-20261101/reader-client/snapshot-running.fixture.json'), 'utf8'));
async function fixture(t) {
  const core = await mainCoreFixture(t); let generation = 2, time = 1000, pending = false, session = core.session, info = core.getInfo();
  let player = {source: 'local', state: 'playing', available: true, generation, revision: 1, currentTrackId: 'fixture-track', currentTrack: {id: 'fixture-track', ...core.rows[2]}};
  let frame = {...structuredClone(running), backendPid: core.session.pid}, readHook = null, disposed = 0;
  const reads = [], invalidations = [], settlements = [];
  const client = {read: async args => {reads.push(args); if (readHook) return readHook(args); return frame;},
    invalidate: () => {const token = Object.freeze({number: invalidations.length}); invalidations.push(token); return token;},
    settleInvalidation: (token, disposition) => {settlements.push([token, disposition]);}, dispose: () => {disposed++;}};
  const service = createPlayerSpectrumService({client, getPlayer: () => player, getGeneration: () => generation, getBackendSession: () => session,
    getBackendInfo: () => info, getAudioTransportStatus: () => ({pending}), monotonicClock: () => time});
  t.after(() => service.dispose());
  return {core, service, client, reads, invalidations, settlements, disposed: () => disposed,
    player: () => player, frame: () => frame, setPlayer: value => {player = value;}, setFrame: value => {frame = value;}, setGeneration: value => {generation = value;},
    setTime: value => {time = value;}, setPending: value => {pending = value;}, setSession: value => {session = value;}, setInfo: value => {info = value;},
    setReadHook: value => {readHook = value;}};
}
test('renderer DTO strips private identity and clocks, retains 48 exact bands and real positive dBFS', async t => {
  const f = await fixture(t); let getters = 0;
  const frame = f.frame(), index = frame.bands.findIndex(band => band.hasBins); frame.bands[index].dbfs = 6;
  Object.defineProperty(frame, 'headers', {get() {getters++; throw new Error('PRIVATE_FIXTURE');}});
  const value = await f.service.read();
  assert.equal(value.available, true); assert.equal(value.bands.length, 48); assert.equal(value.bands[index].dbfs, 6); assert.equal(value.ceilingDbfs, 0);
  assert.equal(value.analyzedSampleRate, 48000); assert.equal(value.calibration, 'rms-full-scale-1'); assert.match(value.streamId, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(value), ['schemaVersion', 'source', 'status', 'available', 'reason', 'trackId', 'generation', 'units', 'floorDbfs', 'ceilingDbfs', 'calibration',
    'analyzedSampleRate', 'fftSize', 'window', 'channels', 'streamId', 'sequence', 'ageMs', 'bands']);
  for (const name of ['backendPid', 'path', 'componentSessionId', 'componentGeneration', 'capturedAtUnixMs', 'sampleRate', 'streamTimeSeconds']) assert.equal(Object.hasOwn(value, name), false);
  assert.equal(getters, 0); assert.equal(JSON.stringify(value).includes('PRIVATE_FIXTURE'), false);
});

test('a real local path/subsong may have a null public library ID without fabricating one', async t => {
  const f = await fixture(t); const player = {...f.player(), currentTrackId: null, currentTrack: {...f.player().currentTrack}};
  delete player.currentTrack.id; f.setPlayer(player); f.setFrame({...f.frame(), trackId: null});
  const value = await f.service.read(); assert.equal(value.available, true); assert.equal(value.trackId, null); assert.equal(value.bands.length, 48);
});
test('generation mismatch, transport pending, standby, fake session, Apple and nonplaying observations clear without a playing read', async t => {
  const f = await fixture(t), original = f.player();
  const cases = [
    () => f.setGeneration(3), () => {f.setGeneration(2); f.setPending(true);}, () => {f.setPending(false); f.setInfo({...f.core.getInfo(), status: 'standby'});},
    () => {f.setInfo(f.core.getInfo()); f.setSession({...f.core.session});}, () => {f.setSession(f.core.session); f.setPlayer({...original, source: 'apple'});},
    () => f.setPlayer({...original, state: 'paused'}), () => f.setPlayer({...original, state: 'stopped'}), () => f.setPlayer({...original, simulatedUIFixture: true})
  ];
  for (const change of cases) {change(); const value = await f.service.read(); assert.equal(value.available, false); assert.deepEqual(value.bands, []);
    assert.equal(value.streamId, null); assert.equal(f.reads.at(-1).state, 'unavailable'); assert.equal(f.reads.at(-1).currentTrackId, null);}
  assert.equal(f.invalidations.length, 0);
});
test('same stream and sequence cannot renew age, including across ordinary coordinator generation changes', async t => {
  const f = await fixture(t); f.frame().ageMs = 10;
  const first = await f.service.read(); f.setTime(1100); f.frame().ageMs = 0;
  const repeat = await f.service.read(); assert.equal(repeat.ageMs, 110); assert.equal(repeat.streamId, first.streamId);
  f.setGeneration(3); f.setPlayer({...f.player(), generation: 3}); f.setFrame({...f.frame(), generation: 3}); f.setTime(1150);
  const volumeEpoch = await f.service.read(); assert.equal(volumeEpoch.streamId, first.streamId); assert.equal(volumeEpoch.ageMs, 160);
  f.setTime(1250); const stale = await f.service.read(); assert.equal(stale.available, false); assert.deepEqual(stale.bands, []);
  f.setFrame({...f.frame(), sequence: 4}); assert.equal((await f.service.read()).available, true);
});
test('the final microtask conservatively adds elapsed time and rejects a late identity or audio-state change', async t => {
  const f = await fixture(t); f.frame().ageMs = 10;
  f.setReadHook(async () => {f.setTime(1020); return f.frame();});
  assert.equal((await f.service.read()).ageMs, 30);
  f.setReadHook(async () => {f.setPending(true); return f.frame();});
  assert.equal((await f.service.read()).reason, 'audio-transport-pending');
  f.setPending(false); f.setReadHook(async () => {f.setGeneration(3); return f.frame();});
  const value = await f.service.read(); assert.equal(value.available, false);
  assert.equal(value.generation, 2); assert.equal(value.trackId, 'fixture-track'); assert.equal(value.reason, 'snapshot-invalidated');
});
test('same analysis identity survives cache-object, position, revision and artwork replacement during a cached read', async t => {
  const f = await fixture(t); let changed = false;
  f.setReadHook(async () => {
    if (!changed) {changed = true; const previous = f.player();
      f.setPlayer({...previous, position: 20, revision: 2, currentTrack: {...previous.currentTrack, path: 'c:\\fixture\\repeat.flac',
        title: 'Updated metadata', coverUrl: 'still-apple-art://art/' + 'a'.repeat(64)}});}
    return f.frame();
  });
  const value = await f.service.read();
  assert.equal(value.available, true); assert.equal(value.bands.length, 48); assert.equal(value.generation, 2); assert.equal(f.invalidations.length, 0);
});
test('every real analysis identity and safety change still rejects a pending cached reply', async t => {
  const cases = [
    ['source', f => f.setPlayer({...f.player(), source: 'apple'})],
    ['track', f => f.setPlayer({...f.player(), currentTrackId: 'another-track'})],
    ['path', f => f.setPlayer({...f.player(), currentTrack: {...f.player().currentTrack, path: 'C:/Fixture/other.flac'}})],
    ['subsong', f => f.setPlayer({...f.player(), currentTrack: {...f.player().currentTrack, subsong: 1}})],
    ['generation', f => {f.setGeneration(3); f.setPlayer({...f.player(), generation: 3});}],
    ['pause', f => f.setPlayer({...f.player(), state: 'paused'})],
    ['stop', f => f.setPlayer({...f.player(), state: 'stopped'})],
    ['unavailable', f => f.setPlayer({...f.player(), available: false})],
    ['session', f => f.setSession({...f.core.session})],
    ['pending-audio', f => f.setPending(true)],
    ['standby', f => f.setInfo({...f.core.getInfo(), status: 'standby', pendingHandoff: true})],
    ['unverified', f => f.setInfo({...f.core.getInfo(), verified: false})],
    ['unowned', f => f.setInfo({...f.core.getInfo(), owned: false})]
  ];
  for (const [name, change] of cases) {
    const f = await fixture(t); let changed = false;
    f.setReadHook(async () => {if (!changed) {changed = true; change(f);} return f.frame();});
    const value = await f.service.read();
    assert.equal(value.available, false, name); assert.deepEqual(value.bands, [], name);
    assert.equal(value.generation, 2, name); assert.equal(value.trackId, 'fixture-track', name);
  }
});
test('captured primitive identity also detects in-place path/subsong mutation without relying on object replacement', async t => {
  const f = await fixture(t); const originalPath = f.player().currentTrack.path; let argsAtDispatch;
  f.setReadHook(async args => {if (!argsAtDispatch) argsAtDispatch = args; f.player().currentTrack.subsong = 2; return f.frame();});
  const value = await f.service.read(); assert.equal(value.available, false); assert.deepEqual(value.bands, []);
  assert.equal(argsAtDispatch.currentTrack.path, originalPath); assert.equal(argsAtDispatch.currentTrack.subsong, 0);
  assert.equal(f.player().currentTrack.subsong, 2);
  assert.equal(originalPath, 'C:/Fixture/repeat.flac');
});
test('a delayed old A empty reply cannot claim the identity of an already-delivered fresh B frame', async t => {
  const f = await fixture(t); let release, entered, held = false;
  const gate = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
  f.setReadHook(async args => {const frame = f.frame(); if (!held && args.currentTrackId === 'fixture-track') {held = true; entered(); await gate;} return frame;});
  const old = f.service.read(); await started;
  f.setGeneration(3); f.setPlayer({...f.player(), generation: 3, currentTrackId: 'new-B', currentTrack: {...f.player().currentTrack, id: 'new-B', path: 'C:/Fixture/other.flac'}});
  f.setFrame({...f.frame(), generation: 3, trackId: 'new-B', componentGeneration: 6, sequence: 4});
  const fresh = await f.service.read(); assert.equal(fresh.available, true); assert.equal(fresh.generation, 3); assert.equal(fresh.trackId, 'new-B');
  release(); const obsolete = await old; assert.equal(obsolete.available, false); assert.equal(obsolete.generation, 2); assert.equal(obsolete.trackId, 'fixture-track');
  assert.equal(obsolete.reason, 'snapshot-invalidated');
});
test('malformed fields or geometry fail flat without getters, and disposing stops only its client once', async t => {
  const f = await fixture(t); let getters = 0;
  Object.defineProperty(f.frame().bands[0], 'dbfs', {get() {getters++; throw new Error('No getter');}});
  assert.equal((await f.service.read()).reason, 'malformed-frame'); assert.equal(getters, 0);
  f.service.dispose(); f.service.dispose(); assert.equal(f.disposed(), 1); assert.equal((await f.service.read()).reason, 'disposed');
});
test('dispatch invalidation binds exact tokens only to actual audio kinds and never waits or throws into media', async t => {
  const f = await fixture(t); f.service.refresh(); await Promise.resolve(); assert.equal(f.invalidations.length, 0);
  for (const kind of ['volume', 'order', 'queue']) assert.equal(f.service.onAudioDispatch({source: 'local', kind}), undefined);
  const first = f.service.onAudioDispatch({source: 'local', kind: 'seek'}), second = f.service.onAudioDispatch({source: 'local', kind: 'play'});
  first.settle('not-dispatched'); second.settle('uncertain');
  assert.equal(f.settlements[0][0], f.invalidations[0]); assert.equal(f.settlements[1][0], f.invalidations[1]);
  assert.deepEqual(f.settlements.map(row => row[1]), ['not-dispatched', 'uncertain']);
  f.client.invalidate = () => {throw new Error('analysis failure');}; assert.doesNotThrow(() => f.service.onAudioDispatch({source: 'local', kind: 'pause'}));
  f.client.invalidate = () => Promise.reject(new Error('analysis promise')); assert.equal(f.service.onAudioDispatch({source: 'local', kind: 'stop'}), undefined);
  await new Promise(resolve => setImmediate(resolve));
});
test('real core dispatch hook invokes analysis at dispatch and settles without blocking an actual guarded stop', async t => {
  let view; const events = [], f = await mainCoreFixture(t, {onAudioDispatch: event => {events.push(event); return view.onAudioDispatch(event);}});
  const tokens = [], settled = [];
  view = createPlayerSpectrumService({client: {read: async () => ({}), invalidate: () => {const token = {}; tokens.push(token); return token;},
    settleInvalidation: (token, state) => settled.push([token, state]), dispose() {}}, getPlayer: () => null, getGeneration: () => 0,
    getBackendInfo: f.getInfo, getBackendSession: () => f.manager.getSession(), getAudioTransportStatus: () => f.guarded.getAudioTransportStatus()});
  t.after(() => view.dispose());
  const before = f.calls.length; assert.deepEqual(f.guarded.getAudioTransportStatus(), {pending: false}); assert.equal(f.calls.length, before);
  await f.guarded.stop(); assert.deepEqual(events, [{kind: 'stop', source: 'local'}]); assert.equal(tokens.length, 1);
  assert.deepEqual(settled, [[tokens[0], 'dispatched']]);
});

test('the accepted peer client and renderer adapter reconstruct an actual cached mock pipe frame without exposing native identity', async t => {
  const {createSpectrumClient} = require('../src/main/spectrum-client'), {EventEmitter} = require('node:events'), {PassThrough} = require('node:stream');
  const f = await mainCoreFixture(t); let time = 1000000, mono = 5000, child;
  const player = {source: 'local', state: 'playing', available: true, generation: 2, currentTrackId: 'fixture-track', currentTrack: {...f.rows[2], id: 'fixture-track'}};
  const peer = createSpectrumClient({getBackendSession: () => f.manager.getSession(), platform: 'win32', clock: () => time, monotonicClock: () => mono,
    spawn: () => {child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true; return child;}});
  const view = createPlayerSpectrumService({client: peer, getPlayer: () => player, getGeneration: () => 2, getBackendInfo: f.getInfo,
    getBackendSession: () => f.manager.getSession(), getAudioTransportStatus: () => f.guarded.getAudioTransportStatus(), monotonicClock: () => mono});
  t.after(() => view.dispose());
  assert.equal((await view.read()).available, false); assert.ok(child);
  time += 10; mono += 10;
  const frame = {schemaVersion: 1, source: 'foobar2000', analyzer: 'sdk-visualisation-pcm', status: 'running', reason: null, sequence: 1,
    sessionId: running.componentSessionId, backendPid: f.session.pid, generation: 5, track: {path: player.currentTrack.path, subsong: 0}, capturedAtUnixMs: time,
    ageMs: 0, streamTimeSeconds: 1, sampleRate: 48000, channels: 2, fftSize: 4096, window: 'hann-periodic', calibration: 'rms-full-scale-1', floorDbfs: -100,
    binHz: 48000 / 4096, windowSeconds: 4096 / 48000, bands: running.bands};
  child.stdout.emit('data', Buffer.from(JSON.stringify({protocol: 1, kind: 'frame', serverPid: f.session.pid, frame}) + '\n'));
  const value = await view.read(); assert.equal(value.available, true); assert.equal(value.bands.length, 48); assert.equal(value.analyzedSampleRate, 48000);
  assert.match(value.streamId, /^[a-f0-9]{64}$/); assert.equal(value.backendPid, undefined); assert.equal(value.componentSessionId, undefined);
});
