'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const { createBackendManager, isVerifiedBackendSession } = require('../src/main/backend');
const { createSpectrumClient, DEFAULT_READER_PATH } = require('../src/main/spectrum-client');
const {writeSyntheticBackendRuntime} = require('./helpers/synthetic-backend-runtime');
const TRACK = { id: 'fixture-track', path: 'C:\\Fixture\\tone.wav', subsong: 0 };
const CONTEXT = { source: 'local', state: 'playing', generation: 1, currentTrack: TRACK, currentTrackId: TRACK.id };
const COMPONENT = '11111111-2222-4333-8444-555555555555';

// Only fake bytes/processes/fetches. This mints a real WeakSet-branded token
// through the production manager; no bypass is added to either implementation.
async function fixture(t, {readerExists = () => true} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-spectrum-fixture-'));
  await writeSyntheticBackendRuntime(root);
  const configFile = path.join(root, 'profile/beefweb/config.json');
  await fs.mkdir(path.dirname(configFile), { recursive: true });
  const files = [];
  for (const relativePath of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    const bytes = Buffer.from(`FIXTURE ONLY ${relativePath}`), file = path.join(root, relativePath);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes);
    files.push({ relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), mutable: false });
  }
  await fs.writeFile(configFile, JSON.stringify({ port: 18880, allowRemote: false, musicDirs: ['C:\\Fixture'] }));
  await fs.writeFile(path.join(root, 'backend-manifest.json'), JSON.stringify({ schemaVersion: 1, privateUseOnly: true,
    backendId: 'spectrum-test-only', executable: 'foobar2000.exe', configuration: { port: 18880 }, files }));
  let running = false, pid = 650, managerChild;
  const manager = createBackendManager({ backendDir: root, runtimeRoot: root, platform: 'win32', pollMs: 1, startupTimeoutMs: 100,
    spawn: () => { running = true; managerChild = new EventEmitter(); managerChild.pid = ++pid; managerChild.exitCode = null; return managerChild; },
    inspectSystem: async args => ({ processes: running ? [{ pid, executablePath: path.join(root, 'foobar2000.exe') }] : [],
      listeners: running ? [{ pid, address: '127.0.0.1' }] : [], pidCheck: args.pid ? { pid: args.pid, present: running } : null }),
    fetch: async url => ({ ok: true, text: async () => JSON.stringify(new URL(url).pathname.endsWith('/player')
      ? { player: { info: { name: 'foobar2000', pluginVersion: '0.10' }, playbackState: 'playing' } }
      : { roots: [{ path: 'C:\\Fixture' }] }) }),
    execFile: async () => { running = false; managerChild.exitCode = 0; managerChild.emit('exit', 0); return { stdout: '' }; }
  });
  await manager.initialize();
  let session = manager.getSession(), time = 1000000, monotonicTime = 5000;
  assert.equal(isVerifiedBackendSession(session), true);
  const spawned = [], diagnostics = [];
  const client = createSpectrumClient({ getBackendSession: () => session, platform: 'win32', clock: () => time, monotonicClock: () => monotonicTime,
    readerExists,
    onDiagnostic: (event, details) => diagnostics.push({event, ...details}),
    spawn: (file, args, options) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stdin = new PassThrough();
      child.killCount = 0; child.kill = () => { ++child.killCount; return true; };
      spawned.push({ file, args, options, child }); return child;
    }
  });
  t.after(async () => { client.dispose(); await manager.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { client, manager, spawned, diagnostics, get pid() { return pid; }, get session() { return session; },
    setSession: value => { session = value; }, setTime: value => { time = value; },
    setMonotonicTime: value => { monotonicTime = value; }, advanceMonotonic: ms => { monotonicTime += ms; },
    advance: ms => { time += ms; monotonicTime += Math.max(0, ms); },
    frame: (overrides = {}) => makeFrame(pid, time, overrides),
    send: (frame, child = spawned.at(-1).child) => child.stdout.emit('data', Buffer.from(JSON.stringify({ protocol: 1, kind: 'frame', serverPid: pid, frame }) + '\n')) };
}
function makeFrame(pid, time, overrides) {
  const rate = overrides.sampleRate || 48000, bin = rate / 4096, upper = Math.min(20000, rate / 2);
  const bands = Array.from({ length: 48 }, (_, i) => {
    const lowHz = 20 * Math.exp(Math.log(upper / 20) * i / 48), highHz = i === 47 ? upper : 20 * Math.exp(Math.log(upper / 20) * (i + 1) / 48);
    let hasBins = false;
    for (let k = 1; k <= 2048; k++) if (k * bin >= lowHz && (k * bin < highHz || (i === 47 && k * bin <= highHz))) { hasBins = true; break; }
    return { lowHz, highHz, dbfs: hasBins ? -3.0103 : -100, hasBins };
  });
  return { schemaVersion: 1, source: 'foobar2000', analyzer: 'sdk-visualisation-pcm', status: 'running', reason: null,
    sequence: 1, sessionId: COMPONENT, backendPid: pid, generation: 0, track: { path: TRACK.path, subsong: 0 },
    capturedAtUnixMs: time, ageMs: 0, streamTimeSeconds: 1, sampleRate: rate, channels: 2,
    fftSize: 4096, window: 'hann-periodic', calibration: 'rms-full-scale-1', floorDbfs: -100,
    binHz: bin, windowSeconds: 4096 / rate, bands, ...overrides };
}
async function running(t) { const f = await fixture(t); assert.equal((await f.client.read(CONTEXT)).available, false); return f; }
function assertEmpty(snapshot, reason) {
  assert.equal(snapshot.available, false); assert.deepEqual(snapshot.bands, []); assert.equal(snapshot.sampleRate, null);
  assert.equal(snapshot.analyzedSampleRate, null); assert.equal(snapshot.units, 'dBFS');
  if (reason) assert.equal(snapshot.reason, reason);
}

test('import/factory have no spawn side effects; branded manager token is mandatory', async t => {
  const f = await fixture(t); assert.equal(f.spawned.length, 0);
  f.setSession({ ...f.session }); assertEmpty(await f.client.read(CONTEXT), 'backend-session-unverified'); assert.equal(f.spawned.length, 0);
  f.setSession(null); assertEmpty(await f.client.read(CONTEXT), 'backend-session-unverified');
  assert.throws(() => createSpectrumClient({ getBackendSession: () => null, readerPath: 'C:\\arbitrary.exe' }), /packaged/);
});
test('reader command binds only verified PID and local packaged executable; concurrent reads coalesce', async t => {
  const f = await fixture(t); await Promise.all(Array.from({ length: 8 }, () => f.client.read(CONTEXT)));
  assert.equal(f.spawned.length, 1); const call = f.spawned[0];
  assert.equal(call.file, DEFAULT_READER_PATH); assert.deepEqual(call.args, ['--pid', String(f.pid), '--interval-ms', '50']);
  assert.equal(call.options.shell, false); assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'ignore']);
});
test('partial NDJSON is unavailable until LF, valid output is sanitized and independently copied', async t => {
  const f = await running(t), child = f.spawned[0].child;
  const line = Buffer.from(JSON.stringify({ protocol: 1, kind: 'frame', serverPid: f.pid, frame: f.frame() }) + '\n');
  child.stdout.emit('data', line.subarray(0, 150)); assertEmpty(await f.client.read(CONTEXT));
  child.stdout.emit('data', line.subarray(150)); const snapshot = await f.client.read(CONTEXT);
  assert.equal(snapshot.available, true); assert.equal(snapshot.bands.length, 48); assert.equal(snapshot.calibration, 'rms-full-scale-1');
  assert.equal(snapshot.units, 'dBFS'); assert.equal(snapshot.analyzedSampleRate, 48000); assert.equal(snapshot.sampleRate, snapshot.analyzedSampleRate);
  assert.equal(snapshot.trackId, TRACK.id); assert.equal(JSON.stringify(snapshot).includes('Fixture'), false);
  assert.equal(snapshot.componentSource, 'foobar2000'); snapshot.bands[5].dbfs = 50;
  assert.notEqual((await f.client.read(CONTEXT)).bands[5].dbfs, 50);
});
for (const [name, bytes] of [
  ['oversize single line', Buffer.alloc(65537, 120)], ['malformed JSON', Buffer.from('{\n')],
  ['two documents on one line', Buffer.from('{}{}\n')], ['empty line', Buffer.from('\n')],
  ['invalid UTF8', Buffer.from([0xff, 10])], ['wrong envelope', Buffer.from('{"protocol":1,"kind":"frame","token":"SECRET"}\n')]
]) test(`${name} fails closed without raw diagnostics`, async t => {
  const f = await running(t), child = f.spawned[0].child; child.stdout.emit('data', bytes);
  assert.equal(child.killCount, 1); assertEmpty(await f.client.read(CONTEXT));
});
test('oversize partial data is bounded across chunks and old child data is ignored', async t => {
  const f = await running(t), child = f.spawned[0].child;
  child.stdout.emit('data', Buffer.alloc(40000, 120)); child.stdout.emit('data', Buffer.alloc(30000, 120));
  assert.equal(child.killCount, 1); await f.client.read(CONTEXT); f.send(f.frame(), child);
  assertEmpty(await f.client.read(CONTEXT));
});
test('valid frame followed by extra garbage in the same chunk clears bars', async t => {
  const f = await running(t); f.spawned[0].child.stdout.emit('data', Buffer.from(JSON.stringify({ protocol: 1, kind: 'frame', serverPid: f.pid, frame: f.frame() }) + '\n{}\n'));
  assertEmpty(await f.client.read(CONTEXT));
});
for (const [name, change] of [
  ['kernel PID', e => { ++e.serverPid; }], ['self reported PID', e => { ++e.frame.backendPid; }],
  ['track path', e => { e.frame.track.path = 'C:\\Other\\private.wav'; }], ['subsong', e => { e.frame.track.subsong = 1; }],
  ['native source', e => { e.frame.source = 'loopback'; }], ['analyzer', e => { e.frame.analyzer = 'fake'; }],
  ['Nyquist', e => { e.frame.bands[47].highHz = 24001; }], ['band count', e => { e.frame.bands.pop(); }],
  ['empty bin fabricated bars', e => { const b = e.frame.bands.find(b => !b.hasBins); b.dbfs = -10; }],
  ['hasBins lie', e => { e.frame.bands[0].hasBins = !e.frame.bands[0].hasBins; }],
  ['NaN equivalent null', e => { e.frame.bands[0].dbfs = NaN; }], ['headroom limit', e => { e.frame.bands[8].dbfs = 61; }],
  ['FFT size', e => { e.frame.fftSize = 2048; }], ['window duration', e => { e.frame.windowSeconds = 1; }],
  ['unsafe sequence', e => { e.frame.sequence = Number.MAX_SAFE_INTEGER + 1; }], ['extra frame data', e => { e.frame.token = 'SECRET'; }]
]) test(`rejects mismatched or invalid ${name}`, async t => {
  const f = await running(t), e = { protocol: 1, kind: 'frame', serverPid: f.pid, frame: f.frame() }; change(e);
  f.spawned[0].child.stdout.emit('data', Buffer.from(JSON.stringify(e) + '\n')); assertEmpty(await f.client.read(CONTEXT));
});
test('Windows path normalization accepts separators/case/file SDK prefix without path disclosure', async t => {
  const f = await running(t); f.send(f.frame({ track: { path: 'file://c:/FIXTURE/./tone.wav', subsong: 0 } }));
  assert.equal((await f.client.read(CONTEXT)).available, true);
});
for (const invalidPath of ['\\tone.wav', '/tone.wav', 'C:tone.wav', 'tone.wav', '.', '\\\\server', '\\\\server\\', '\\\\?\\C:\\tone.wav', '\\\\.\\pipe\\name']) {
  test(`rejects nonqualified track path ${JSON.stringify(invalidPath)} in both context and native frame`, async t => {
    const f = await fixture(t), invalid = { ...CONTEXT, currentTrack: { ...TRACK, path: invalidPath } };
    assertEmpty(await f.client.read(invalid), 'invalid-context'); assert.equal(f.spawned.length, 0);
    await f.client.read(CONTEXT); f.send(f.frame({ track: { path: invalidPath, subsong: 0 } })); assertEmpty(await f.client.read(CONTEXT));
    assert.equal(f.spawned[0].child.killCount, 1);
  });
}
test('fully qualified UNC paths compare lexically without IO or renderer path disclosure', async t => {
  const f = await fixture(t), context = { ...CONTEXT, currentTrack: { ...TRACK, path: '\\\\server\\share\\Tone.wav' } };
  await f.client.read(context); f.send(f.frame({ track: { path: 'file:////SERVER/share/./tone.wav', subsong: 0 } }));
  const snapshot = await f.client.read(context); assert.equal(snapshot.available, true); assert.equal(JSON.stringify(snapshot).includes('server'), false);
});
for (const [name, context, status, reason] of [
  ['paused', { ...CONTEXT, state: 'paused' }, 'paused', 'paused'],
  ['stopped', { ...CONTEXT, state: 'stopped' }, 'stopped', 'stopped'],
  ['Apple', { ...CONTEXT, source: 'apple' }, 'unavailable', 'apple-protected-spectrum-unavailable'],
  ['unavailable', { ...CONTEXT, state: 'unavailable' }, 'unavailable', 'playback-unavailable']
]) test(`${name} never starts helper and clears a previous running spectrum immediately`, async t => {
  const f = await fixture(t); assertEmpty(await f.client.read(context), reason); assert.equal(f.spawned.length, 0);
  await f.client.read(CONTEXT); f.send(f.frame()); assert.equal((await f.client.read(CONTEXT)).available, true);
  const old = f.spawned[0].child; const cleared = await f.client.read(context); assertEmpty(cleared, reason); assert.equal(cleared.status, status);
  assert.equal(old.killCount, 1); f.send(f.frame({ sequence: 2 }), old); assertEmpty(await f.client.read(context), reason);
  assert.equal(f.spawned.length, 1);
});
test('coordinator generation and track changes cancel partial old reads; pre-boundary capture is rejected', async t => {
  const f = await running(t), old = f.spawned[0].child;
  old.stdout.emit('data', Buffer.from('{"protocol":1'));
  f.advance(5); const changed = { ...CONTEXT, generation: 2 };
  assertEmpty(await f.client.read(changed)); assert.equal(old.killCount, 1);
  f.send(f.frame(), old); assertEmpty(await f.client.read(changed));
  f.send(f.frame({ capturedAtUnixMs: 1000000 })); assertEmpty(await f.client.read(changed), 'stale-frame');
  f.send(f.frame({ sequence: 2 })); assert.equal((await f.client.read(changed)).available, true);
  const next = { ...changed, generation: 3, currentTrack: { ...TRACK, path: 'C:\\Fixture\\next.wav' } };
  assertEmpty(await f.client.read(next)); f.send(f.frame({ sequence: 3 })); assertEmpty(await f.client.read(next), 'track-mismatch');
});
test('backend identity changes, unverified session and later data cannot reuse old bars', async t => {
  const f = await running(t); f.send(f.frame()); const old = f.spawned[0].child;
  f.setSession(null); assertEmpty(await f.client.read(CONTEXT), 'backend-session-unverified'); assert.equal(old.killCount, 1);
  f.send(f.frame({ sequence: 2 }), old); assertEmpty(await f.client.read(CONTEXT));
  await f.manager.initialize({ restartOwned: true }); f.setSession(f.manager.getSession());
  assertEmpty(await f.client.read(CONTEXT)); assert.equal(f.spawned.length, 2); f.send(f.frame());
  assert.equal((await f.client.read(CONTEXT)).available, true);
});
test('backend token is rechecked during stdout ingestion before a subsequent read', async t => {
  const f = await running(t), old = f.spawned[0].child; f.setSession(null); f.send(f.frame(), old); assert.equal(old.killCount, 1);
  assertEmpty(await f.client.read(CONTEXT));
});
test('retired local session during Apple playback cannot restart the backend or reuse old-PID frames', async t => {
  const f = await running(t); f.send(f.frame()); assert.equal((await f.client.read(CONTEXT)).available, true);
  const old = f.spawned[0].child, oldPid = f.pid;
  // The external authoritative lifecycle can retire a session. The client only
  // observes getSession and owns no player start/stop/exit API.
  f.setSession(null); assertEmpty(await f.client.read(CONTEXT), 'backend-session-unverified'); assert.equal(old.killCount, 1);
  const apple = { ...CONTEXT, source: 'apple', generation: 2 };
  assertEmpty(await f.client.read(apple), 'apple-protected-spectrum-unavailable');
  f.send(f.frame({ backendPid: oldPid, sequence: 2 }), old);
  assertEmpty(await f.client.read(apple), 'apple-protected-spectrum-unavailable'); assert.equal(f.spawned.length, 1);
  await f.manager.initialize({ restartOwned: true }); f.setSession(f.manager.getSession()); assert.notEqual(f.pid, oldPid);
  assertEmpty(await f.client.read(apple), 'apple-protected-spectrum-unavailable'); assert.equal(f.spawned.length, 1);
  const local = { ...CONTEXT, generation: 3 };
  assertEmpty(await f.client.read(local)); assert.equal(f.spawned.length, 2);
  f.send(f.frame({ backendPid: oldPid })); assertEmpty(await f.client.read(local));
  f.send(f.frame(), old); assertEmpty(await f.client.read(local));
  f.send(f.frame()); assert.equal((await f.client.read(local)).available, true);
});
for (const [name, overrides] of [
  ['native sequence rollback', { sequence: 1, generation: 4 }],
  ['native generation rollback', { sequence: 3, generation: 3 }],
  ['generation change under repeated sequence', { sequence: 2, generation: 5 }],
  ['changed content under repeated sequence', { sequence: 2, generation: 4, streamTimeSeconds: 2 }]
]) test(name, async t => {
  const f = await running(t); f.send(f.frame({ sequence: 2, generation: 4 })); assert.equal((await f.client.read(CONTEXT)).available, true);
  f.send(f.frame(overrides)); assertEmpty(await f.client.read(CONTEXT)); assert.equal(f.spawned[0].child.killCount, 1);
});
test('component restart establishes a new identity and permanently rejects a retired session', async t => {
  const f = await running(t); f.send(f.frame({ sequence: 5, generation: 3 }));
  f.send(f.frame({ sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', sequence: 1, generation: 0 }));
  assert.equal((await f.client.read(CONTEXT)).componentSessionId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  f.send(f.frame({ sequence: 6, generation: 4 })); assertEmpty(await f.client.read(CONTEXT));
});
test('repeated sequence never extends freshness, and cache expires at 250ms', async t => {
  const f = await running(t), frame = f.frame(); f.send(frame); f.advance(200); f.send(frame);
  assert.equal((await f.client.read(CONTEXT)).ageMs, 200); f.advance(50); assert.equal((await f.client.read(CONTEXT)).available, true);
  f.advance(1); assertEmpty(await f.client.read(CONTEXT), 'stale-frame'); f.send(frame); assertEmpty(await f.client.read(CONTEXT));
});
test('same sequence may report increasing native age without renewing the first receipt', async t => {
  const f = await running(t), frame = f.frame(); f.send(frame); f.advance(200); f.send({ ...frame, ageMs: 200 });
  assert.equal((await f.client.read(CONTEXT)).ageMs, 200); assert.equal(f.spawned[0].child.killCount, 0);
  f.advance(51); assertEmpty(await f.client.read(CONTEXT), 'stale-frame');
});
test('same sequence with decreasing native age fails closed', async t => {
  const f = await running(t), frame = f.frame({ ageMs: 20 }); f.send(frame); f.send({ ...frame, ageMs: 19 });
  assertEmpty(await f.client.read(CONTEXT)); assert.equal(f.spawned[0].child.killCount, 1);
});
test('monotonic elapsed expires a frame when wall time advances then rolls back above first receipt', async t => {
  const f = await running(t), frame = f.frame(); f.send(frame); f.advance(100);
  assert.equal((await f.client.read(CONTEXT)).ageMs, 100);
  f.setTime(1000050); f.advanceMonotonic(150); assert.equal((await f.client.read(CONTEXT)).ageMs, 250);
  f.advanceMonotonic(1); assertEmpty(await f.client.read(CONTEXT), 'stale-frame');
});
test('larger repeated native age raises the floor across rollback without renewing lifetime', async t => {
  const f = await running(t), frame = f.frame(); f.send(frame); f.advance(100); f.setTime(1000050);
  f.send({ ...frame, ageMs: 200 }); assert.equal((await f.client.read(CONTEXT)).ageMs, 200);
  f.advanceMonotonic(50); assert.equal((await f.client.read(CONTEXT)).ageMs, 250);
  f.advanceMonotonic(1); assertEmpty(await f.client.read(CONTEXT), 'stale-frame');
  f.advanceMonotonic(100); f.send({ ...frame, ageMs: 251 }); assertEmpty(await f.client.read(CONTEXT));
});
test('a wall-clock forward observation remains a conservative age bound after rollback', async t => {
  const f = await running(t); f.send(f.frame()); f.setTime(1000200); f.advanceMonotonic(50);
  assert.equal((await f.client.read(CONTEXT)).ageMs, 200);
  f.setTime(1000050); f.advanceMonotonic(50); assert.equal((await f.client.read(CONTEXT)).ageMs, 250);
  f.advanceMonotonic(1); assertEmpty(await f.client.read(CONTEXT), 'stale-frame');
});
test('greater native age than limit clears a same-sequence cache immediately', async t => {
  const f = await running(t), frame = f.frame(); f.send(frame); f.send({ ...frame, ageMs: 251 });
  assertEmpty(await f.client.read(CONTEXT), 'stale-frame');
});
test('invalid or backward monotonic clock fails closed and final pending delivery rechecks monotonic age', async t => {
  const f = await running(t); f.send(f.frame()); const pending = f.client.read(CONTEXT); f.advanceMonotonic(251);
  assertEmpty(await pending, 'stale-frame'); f.send(f.frame({ sequence: 2 })); f.setMonotonicTime(5000);
  assertEmpty(await f.client.read(CONTEXT), 'stale-frame');
  f.setMonotonicTime(NaN); f.send(f.frame({ sequence: 3 })); assertEmpty(await f.client.read(CONTEXT));
});
for (const [name, overrides] of [
  ['age too old', { ageMs: 251 }], ['timestamp too old', { capturedAtUnixMs: 999749 }],
  ['future timestamp', { capturedAtUnixMs: 1000001 }], ['missing timestamp', { capturedAtUnixMs: null }], ['negative age', { ageMs: -1 }]
]) test(name, async t => { const f = await running(t); f.send(f.frame(overrides)); assertEmpty(await f.client.read(CONTEXT)); });
test('age includes capture-to-receipt delay and subsequent local elapsed; backward clock fails closed', async t => {
  const f = await running(t); f.advance(100); f.send(f.frame({ capturedAtUnixMs: 1000000, ageMs: 20 }));
  assert.equal((await f.client.read(CONTEXT)).ageMs, 100); f.advance(151); assertEmpty(await f.client.read(CONTEXT), 'stale-frame');
  f.send(f.frame({ sequence: 2 })); f.advance(-1); assertEmpty(await f.client.read(CONTEXT), 'stale-frame');
});
test('legitimate positive headroom and low sample rate keep physical bands bounded', async t => {
  const f = await running(t), frame = f.frame({ sampleRate: 8000 }); frame.bands.find(b => b.hasBins).dbfs = 6;
  f.send(frame); const snapshot = await f.client.read(CONTEXT); assert.equal(snapshot.available, true);
  assert.equal(snapshot.bands.at(-1).highHz, 4000); assert.equal(snapshot.bands.find(b => b.hasBins).dbfs, 6);
});
test('native nonrunning and controlled reader failures immediately clear bars', async t => {
  const f = await running(t); f.send(f.frame());
  f.send(f.frame({ sequence: 2, status: 'paused', reason: 'paused', capturedAtUnixMs: null, ageMs: null, streamTimeSeconds: null,
    sampleRate: null, channels: null, binHz: null, windowSeconds: null, bands: [] }));
  assertEmpty(await f.client.read(CONTEXT), 'paused');
  f.spawned[0].child.stdout.emit('data', Buffer.from('{"protocol":1,"kind":"unavailable","reason":"read-timeout"}\n'));
  assertEmpty(await f.client.read(CONTEXT), 'read-timeout');
});
test('unknown or raw exception reasons never propagate', async t => {
  const f = await running(t); f.spawned[0].child.stdout.emit('data', Buffer.from('{"protocol":1,"kind":"unavailable","reason":"SECRET raw exception"}\n'));
  assert.equal(f.spawned[0].child.killCount, 1); assert.equal(JSON.stringify(await f.client.read(CONTEXT)).includes('SECRET'), false);
});
test('helper close/error/partial EOF clears bars and only kills its owned helper', async t => {
  const f = await running(t); f.send(f.frame()); const child = f.spawned[0].child;
  child.emit('close', 0); assertEmpty(await f.client.read(CONTEXT)); assert.equal(child.killCount, 1);
  const next = f.spawned.at(-1).child; next.stdout.emit('data', Buffer.from('{')); next.emit('exit', 1);
  assertEmpty(await f.client.read(CONTEXT)); assert.equal(next.killCount, 1);
  f.spawned.at(-1).child.emit('error', new Error('fixture secret')); assertEmpty(await f.client.read(CONTEXT));
  assert.equal(f.manager.getSession(), f.session);
});
test('dispose during partial read resolves immediately and late callbacks cannot resurrect helper', async t => {
  const f = await running(t), child = f.spawned[0].child; child.stdout.emit('data', Buffer.from('{'));
  const pending = f.client.read(CONTEXT); f.client.dispose(); assertEmpty(await pending);
  f.send(f.frame(), child); assertEmpty(await f.client.read(CONTEXT), 'disposed');
  assert.equal(child.killCount, 1); assert.equal(child.stdout.listenerCount('data'), 0); assert.equal(f.spawned.length, 1);
  child.emit('error', new Error('late failed spawn')); assert.equal(f.manager.getSession(), f.session);
});
test('pending available read is invalidated by dispose, source change or protocol failure before delivery', async t => {
  const f = await running(t); f.send(f.frame());
  const first = f.client.read(CONTEXT); const switched = f.client.read({ ...CONTEXT, source: 'apple', generation: 2 });
  assertEmpty(await first); assertEmpty(await switched, 'apple-protected-spectrum-unavailable');
  await f.client.read(CONTEXT); f.send(f.frame({ sequence: 2 }));
  const second = f.client.read(CONTEXT); f.spawned.at(-1).child.stdout.emit('data', Buffer.from('{\n'));
  assertEmpty(await second);
  await f.client.read(CONTEXT); f.send(f.frame({ sequence: 3 }));
  const third = f.client.read(CONTEXT); f.client.dispose(); assertEmpty(await third, 'disposed');
});
test('pre-seek invalidate rejects same-path fresh new sequence until native generation strictly advances', async t => {
  const f = await running(t); f.send(f.frame({ generation: 7 })); assert.equal((await f.client.read(CONTEXT)).available, true);
  const old = f.spawned[0].child, pending = f.client.read(CONTEXT);
  f.advance(5); f.client.invalidate(); assert.equal(old.killCount, 1); assert.equal(f.spawned.length, 1); assertEmpty(await pending);
  const afterSeek = { ...CONTEXT, generation: 2 };
  assertEmpty(await f.client.read(afterSeek), 'awaiting-native-discontinuity');
  f.send(f.frame({ generation: 7, sequence: 2, streamTimeSeconds: 90 }));
  assertEmpty(await f.client.read(afterSeek), 'awaiting-native-discontinuity');
  f.send(f.frame({ generation: 7, sequence: 3, streamTimeSeconds: 90.05 }));
  assertEmpty(await f.client.read(afterSeek), 'awaiting-native-discontinuity');
  f.send(f.frame({ generation: 8, sequence: 4, streamTimeSeconds: 90.1 }));
  const snapshot = await f.client.read(afterSeek); assert.equal(snapshot.available, true); assert.equal(snapshot.generation, 2);
  assert.equal(snapshot.componentGeneration, 8); assert.equal(snapshot.streamTimeSeconds, 90.1);
  f.send(f.frame({ generation: 7, sequence: 5 }), old); assert.equal((await f.client.read(afterSeek)).componentGeneration, 8);
});
test('restarting the same first song requires native advance and nonrunning frames do not clear the fence', async t => {
  const f = await running(t); f.send(f.frame({ generation: 4 })); f.client.invalidate();
  const replay = { ...CONTEXT, generation: 2 }; await f.client.read(replay);
  f.send(f.frame({ sequence: 2, generation: 4, status: 'stopped', reason: 'stopped', capturedAtUnixMs: null,
    ageMs: null, streamTimeSeconds: null, sampleRate: null, channels: null, binHz: null, windowSeconds: null, bands: [] }));
  assertEmpty(await f.client.read(replay));
  f.send(f.frame({ sequence: 3, generation: 4, streamTimeSeconds: 0 }));
  assertEmpty(await f.client.read(replay), 'awaiting-native-discontinuity');
  f.send(f.frame({ sequence: 4, generation: 5, streamTimeSeconds: 0 })); assert.equal((await f.client.read(replay)).available, true);
});
test('ordinary coordinator generation changes accept a new sequence without a native discontinuity fence', async t => {
  const f = await running(t); f.send(f.frame({ generation: 4 }));
  const volumeOnlyGeneration = { ...CONTEXT, generation: 2 }; assertEmpty(await f.client.read(volumeOnlyGeneration));
  f.send(f.frame({ generation: 4, sequence: 2 })); const snapshot = await f.client.read(volumeOnlyGeneration);
  assert.equal(snapshot.available, true); assert.equal(snapshot.componentGeneration, 4);
});
test('new verified backend token and PID clear an old native-generation fence', async t => {
  const f = await running(t); f.send(f.frame({ generation: 50 })); f.client.invalidate(); const old = f.spawned[0].child;
  await f.manager.initialize({ restartOwned: true }); f.setSession(f.manager.getSession());
  const context = { ...CONTEXT, generation: 2 }; assertEmpty(await f.client.read(context));
  f.send(f.frame({ generation: 50, sequence: 2 }), old); assertEmpty(await f.client.read(context));
  f.send(f.frame({ generation: 0, sequence: 1 })); assert.equal((await f.client.read(context)).available, true);
});
test('new component identity may satisfy a fence but a retired component identity cannot return', async t => {
  const f = await running(t); f.send(f.frame({ generation: 5 })); f.client.invalidate(); await f.client.read(CONTEXT);
  f.send(f.frame({ sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', generation: 0, sequence: 1 }));
  assert.equal((await f.client.read(CONTEXT)).available, true);
  f.send(f.frame({ generation: 6, sequence: 2 })); assertEmpty(await f.client.read(CONTEXT));
});
test('without a native baseline invalidate requires the entire FFT window after its wall boundary', async t => {
  const f = await running(t); f.client.invalidate(); const context = { ...CONTEXT, generation: 2 };
  assertEmpty(await f.client.read(context), 'awaiting-native-discontinuity');
  f.send(f.frame({ sequence: 1, generation: 0 })); assertEmpty(await f.client.read(context), 'awaiting-native-discontinuity');
  f.advance(50); f.send(f.frame({ sequence: 2, generation: 1 }));
  assertEmpty(await f.client.read(context), 'awaiting-native-discontinuity');
  f.advance(36); f.send(f.frame({ sequence: 3, generation: 1 })); assert.equal((await f.client.read(context)).available, true);
});
test('invalidate before the first read binds verified identity without spawning and preserves the full-window fence', async t => {
  const f = await fixture(t); f.client.invalidate(); assert.equal(f.spawned.length, 0);
  assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity'); f.send(f.frame());
  assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  f.advance(86); f.send(f.frame({ sequence: 2 })); assert.equal((await f.client.read(CONTEXT)).available, true);
});
test('no-baseline full-window fence remains across nonrunning observations and uses each real sample rate', async t => {
  const f = await running(t); f.client.invalidate(); await f.client.read(CONTEXT);
  f.send(f.frame({ sequence: 1, generation: 0, status: 'unavailable', reason: 'no-pcm', capturedAtUnixMs: null,
    ageMs: null, streamTimeSeconds: null, sampleRate: null, channels: null, binHz: null, windowSeconds: null, bands: [] }));
  f.advance(511); f.send(f.frame({ sequence: 2, generation: 1, sampleRate: 8000 }));
  assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  f.advance(1); f.send(f.frame({ sequence: 3, generation: 1, sampleRate: 8000 })); assert.equal((await f.client.read(CONTEXT)).available, true);
});
for (const sampleRate of [48000, 8000]) test(`no-baseline ${sampleRate}Hz window requires real monotonic time despite a wall-clock forward jump`, async t => {
  const f = await fixture(t); f.client.invalidate(); f.setTime(1001000); f.advanceMonotonic(1);
  await f.client.read(CONTEXT); f.send(f.frame({ sampleRate }));
  assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  const windowMs = 4096 / sampleRate * 1000;
  f.setMonotonicTime(5000 + Math.ceil(windowMs) - 1);
  f.send(f.frame({ sequence: 2, sampleRate })); assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  f.setMonotonicTime(5000 + Math.ceil(windowMs)); f.send(f.frame({ sequence: 3, sampleRate }));
  assert.equal((await f.client.read(CONTEXT)).available, true);
});
test('full monotonic window never substitutes for the capture-window boundary or capture freshness', async t => {
  const f = await fixture(t); f.client.invalidate(); f.advanceMonotonic(100); f.setTime(1000001);
  await f.client.read(CONTEXT); f.send(f.frame()); assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  f.setTime(1001000); f.send(f.frame({ sequence: 2, capturedAtUnixMs: 1000000 }));
  assertEmpty(await f.client.read(CONTEXT), 'stale-frame');
  f.send(f.frame({ sequence: 3 })); assert.equal((await f.client.read(CONTEXT)).available, true);
});
for (const invalidMonotonic of [NaN, Infinity, -1]) test(`invalid monotonic invalidation boundary ${String(invalidMonotonic)} cannot satisfy the full-window fence`, async t => {
  const f = await fixture(t); f.setMonotonicTime(invalidMonotonic); const token = f.client.invalidate();
  f.setMonotonicTime(6000); f.setTime(1001000); await f.client.read(CONTEXT); f.send(f.frame());
  assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  f.advanceMonotonic(1000); f.send(f.frame({ sequence: 2 })); assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  assert.equal(f.client.settleInvalidation(token, 'not-dispatched'), true); await f.client.read(CONTEXT);
  f.send(f.frame({ sequence: 3 })); assert.equal((await f.client.read(CONTEXT)).available, true);
});
test('backward monotonic time relative to invalidation cannot pass a wall-fresh full-window frame', async t => {
  const f = await fixture(t); f.client.invalidate(); f.setMonotonicTime(4999); f.setTime(1001000);
  await f.client.read(CONTEXT); f.send(f.frame()); assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  f.setMonotonicTime(5086); f.send(f.frame({ sequence: 2 })); assert.equal((await f.client.read(CONTEXT)).available, true);
});
test('invalid monotonic reading during a no-baseline frame fails closed without discarding the fence', async t => {
  const f = await fixture(t); f.client.invalidate(); f.setTime(1001000); await f.client.read(CONTEXT);
  f.setMonotonicTime(NaN); f.send(f.frame()); assertEmpty(await f.client.read(CONTEXT));
  f.setMonotonicTime(5001); f.send(f.frame({ sequence: 2 })); assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  f.setMonotonicTime(5086); f.send(f.frame({ sequence: 3 })); assert.equal((await f.client.read(CONTEXT)).available, true);
});
test('pause Apple and lost backend clear immediately while no-baseline invalidation starts no helper itself', async t => {
  const f = await running(t); f.client.invalidate(); assert.equal(f.spawned.length, 1);
  assertEmpty(await f.client.read({ ...CONTEXT, state: 'paused' }), 'paused'); assert.equal(f.spawned.length, 1);
  assertEmpty(await f.client.read({ ...CONTEXT, source: 'apple' }), 'apple-protected-spectrum-unavailable'); assert.equal(f.spawned.length, 1);
  f.setSession(null); assertEmpty(await f.client.read(CONTEXT), 'backend-session-unverified'); assert.equal(f.spawned.length, 1);
});
test('exact current not-dispatched token cancels a no-op fence but never restores the old frame', async t => {
  const f = await running(t); f.send(f.frame({ generation: 5 })); const old = f.spawned[0].child;
  const token = f.client.invalidate(); assert.equal(Object.isFrozen(token), true);
  assert.equal(f.client.settleInvalidation(token, 'not-dispatched'), true);
  assertEmpty(await f.client.read(CONTEXT)); assert.equal(old.killCount, 1);
  f.send(f.frame({ generation: 5, sequence: 1 })); assertEmpty(await f.client.read(CONTEXT));
  f.send(f.frame({ generation: 5, sequence: 2 })); assert.equal((await f.client.read(CONTEXT)).available, true);
  assert.equal(f.client.settleInvalidation(token, 'not-dispatched'), false);
});
test('not-dispatched pre-dispatch cancellation invalidates a pending read and preserves ordinary capture boundary', async t => {
  const f = await running(t); f.send(f.frame({ generation: 3 })); const pending = f.client.read(CONTEXT);
  f.advance(10); const token = f.client.invalidate(); f.advance(5);
  assert.equal(f.client.settleInvalidation(token, 'not-dispatched'), true); assertEmpty(await pending);
  const context = { ...CONTEXT, generation: 2 }; await f.client.read(context);
  f.send(f.frame({ generation: 3, sequence: 2, capturedAtUnixMs: 1000000 })); assertEmpty(await f.client.read(context));
  f.send(f.frame({ generation: 3, sequence: 3 })); assert.equal((await f.client.read(context)).available, true);
});
for (const disposition of ['dispatched', 'uncertain']) test(`${disposition} disposition keeps the native-generation fence`, async t => {
  const f = await running(t); f.send(f.frame({ generation: 5 })); const token = f.client.invalidate();
  assert.equal(f.client.settleInvalidation(token, disposition), true); await f.client.read(CONTEXT);
  f.send(f.frame({ sequence: 2, generation: 5 })); assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  f.send(f.frame({ sequence: 3, generation: 6 })); assert.equal((await f.client.read(CONTEXT)).available, true);
  assert.equal(f.client.settleInvalidation(token, 'not-dispatched'), false);
});
test('copied forged invalid and late old tokens cannot cancel a newer seek fence', async t => {
  const f = await running(t); f.send(f.frame({ generation: 5 })); const oldToken = f.client.invalidate(), token = f.client.invalidate();
  for (const invalid of [oldToken, { ...token }, {}, null, undefined, 'token']) {
    assert.equal(f.client.settleInvalidation(invalid, 'not-dispatched'), false);
  }
  assert.equal(f.client.settleInvalidation(token, 'cancelled'), false);
  await f.client.read(CONTEXT); f.send(f.frame({ sequence: 2, generation: 5 }));
  assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  assert.equal(f.client.settleInvalidation(token, 'not-dispatched'), true);
  assertEmpty(await f.client.read(CONTEXT)); f.send(f.frame({ sequence: 3, generation: 5 }));
  assert.equal((await f.client.read(CONTEXT)).available, true);
});
test('not-dispatched can cancel a no-baseline full-window fence while retaining sequence high-water marks', async t => {
  const f = await running(t), token = f.client.invalidate(); await f.client.read(CONTEXT);
  f.send(f.frame({ sequence: 1 })); assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  assert.equal(f.client.settleInvalidation(token, 'not-dispatched'), true); await f.client.read(CONTEXT);
  f.send(f.frame({ sequence: 1 })); assertEmpty(await f.client.read(CONTEXT));
  f.send(f.frame({ sequence: 2 })); assert.equal((await f.client.read(CONTEXT)).available, true);
});
test('old-backend invalidation token cannot alter a fresh session or its pending read', async t => {
  const f = await running(t); f.send(f.frame({ generation: 5 })); const token = f.client.invalidate();
  await f.manager.initialize({ restartOwned: true }); f.setSession(f.manager.getSession()); await f.client.read(CONTEXT);
  f.send(f.frame()); const pending = f.client.read(CONTEXT);
  assert.equal(f.client.settleInvalidation(token, 'not-dispatched'), false); assert.equal((await pending).available, true);
  f.client.dispose(); assert.equal(f.client.invalidate(), null); assert.equal(f.client.settleInvalidation(token, 'not-dispatched'), false);
});
test('missing reader reports unavailable without launching anything', async t => {
  const f = await fixture(t, {readerExists: () => false});
  assertEmpty(await f.client.read(CONTEXT), 'reader-missing'); assert.equal(f.spawned.length, 0);
});

test('rapid reader exit/error/close failures cool down one owned transport with exponential bounded retries', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    await f.client.read(CONTEXT);
    const child = f.spawned.at(-1).child;
    child.emit('exit', 0); child.emit('close', 0); child.emit('error', new Error('UNMARKED SECRET'));
  }
  assert.equal(f.spawned.length, 3);
  assertEmpty(await f.client.read(CONTEXT), 'reader-cooldown');
  assert.deepEqual(f.client.getDiagnostics(), {consecutiveFailures: 3, coolingDown: true, retryInMs: 1000, childActive: false, reason: 'reader-cooldown'});
  // Track/generation changes cannot reset a crash loop for the same backend.
  assertEmpty(await f.client.read({...CONTEXT, generation: 2}), 'reader-cooldown');
  f.advance(999); await f.client.read(CONTEXT); assert.equal(f.spawned.length, 3);
  f.advance(1); await f.client.read(CONTEXT); assert.equal(f.spawned.length, 4);
  const old = f.spawned[0].child;
  old.stdout.emit('data', Buffer.from('SECRET\n')); assert.equal(f.client.getDiagnostics().consecutiveFailures, 3);
  f.spawned.at(-1).child.emit('error', new Error('UNMARKED SECRET'));
  assert.equal(f.client.getDiagnostics().retryInMs, 2000);
  for (let i = 0; i < 10; i++) {f.advance(30000); await f.client.read(CONTEXT); f.spawned.at(-1).child.emit('exit', 0);}
  assert.equal(f.client.getDiagnostics().retryInMs, 30000);
  assert.equal(JSON.stringify(f.diagnostics).includes('SECRET'), false);
  assert.equal(f.diagnostics.filter(row => row.event === 'spectrum-reader-failed').length, 2);
});

test('healthy reader recovery requires sustained valid transport, retains fences, and disposal never restarts', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {await f.client.read(CONTEXT); f.spawned.at(-1).child.emit('exit', 0);}
  f.advance(1000); await f.client.read(CONTEXT);
  f.send(f.frame()); assert.equal((await f.client.read(CONTEXT)).available, true);
  assert.equal(f.client.getDiagnostics().consecutiveFailures, 3);
  f.advance(5000); f.send(f.frame({sequence: 2}));
  assert.equal((await f.client.read(CONTEXT)).available, true);
  assert.equal(f.client.getDiagnostics().consecutiveFailures, 0);
  assert.equal(f.diagnostics.at(-1).event, 'spectrum-reader-recovered');
  const child = f.spawned.at(-1).child;
  const invalidation = f.client.invalidate();
  assert.equal(f.client.getDiagnostics().consecutiveFailures, 0);
  await f.client.read(CONTEXT); f.send(f.frame({sequence: 3}));
  assertEmpty(await f.client.read(CONTEXT), 'awaiting-native-discontinuity');
  assert.equal(f.client.settleInvalidation(invalidation, 'not-dispatched'), true);
  const before = f.spawned.length; f.client.dispose();
  child.emit('exit', 0); f.advance(30000); await f.client.read(CONTEXT);
  assert.equal(f.spawned.length, before);
});

test('a temporary unverified session cannot bypass the same branded cooldown but a different verified token can reset it', async t => {
  const f = await fixture(t), original = f.session;
  for (let i = 0; i < 3; i++) {await f.client.read(CONTEXT); f.spawned.at(-1).child.emit('exit', 0);}
  f.setSession(null); assertEmpty(await f.client.read(CONTEXT), 'backend-session-unverified');
  f.client.invalidate();
  f.setSession(original); assertEmpty(await f.client.read(CONTEXT), 'reader-cooldown');
  assert.equal(f.spawned.length, 3); assert.equal(f.client.getDiagnostics().consecutiveFailures, 3);
  const other = await fixture(t); f.setSession(other.session);
  await f.client.read(CONTEXT); assert.equal(f.spawned.length, 4); assert.equal(f.client.getDiagnostics().consecutiveFailures, 0);
});

for (const invalid of ['stale', 'replayed', 'wrong-track']) test(`a long-lived ${invalid} frame cannot clear reader failures before a fresh matching frame is accepted`, async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {await f.client.read(CONTEXT); f.spawned.at(-1).child.emit('exit', 0);}
  f.advance(1000); await f.client.read(CONTEXT); f.send(f.frame({sequence: 2}));
  assert.equal(f.client.getDiagnostics().consecutiveFailures, 3);
  f.advance(5000);
  const overrides = invalid === 'stale' ? {sequence: 3, capturedAtUnixMs: 1, ageMs: 999999} :
    invalid === 'replayed' ? {sequence: 1} : {sequence: 3, track: {...TRACK, path: 'C:\\Fixture\\other.wav'}};
  if (invalid === 'wrong-track') delete overrides.track.id;
  f.send(f.frame(overrides));
  assert.ok(f.client.getDiagnostics().consecutiveFailures >= 3);
  assert.notEqual(f.diagnostics.at(-1).event, 'spectrum-reader-recovered');
  if (invalid === 'replayed') {f.advance(2000); await f.client.read(CONTEXT); f.advance(5000);}
  f.send(f.frame({sequence: 4})); assert.equal((await f.client.read(CONTEXT)).available, true);
  assert.equal(f.client.getDiagnostics().consecutiveFailures, 0); assert.equal(f.diagnostics.at(-1).event, 'spectrum-reader-recovered');
});
