'use strict'; require('./helpers/test-effect-guard.cjs').installTestEffectGuard();

// Filesystem fixtures only. No live engine, HTTP, GUI, process or device calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createDiagnosticsService} = require('../src/main/diagnostics');
const fixedNow = () => new Date('2026-10-31T10:20:30.000Z');
const secret = 'SENSITIVE_DIAGNOSTICS_FIXTURE_MUST_NOT_EXPORT';
const uuid = '12345678-1234-4234-8234-123456789abc';
const pin = 'a'.repeat(64);
const song = i => ({id: `fixture-${i}`, type: 'songs', title: `Fixture title ${i}`, artist: 'Fixture artist', album: 'Fixture album',
  duration: 241.53, catalogId: `catalog-${i}`, playable: true, coverUrl: `https://invalid.example/${secret}`, developerToken: secret,
  headers: {Authorization: secret}, rawSDK: {musicUserToken: secret}});
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-diagnostics-fixture-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('still-diagnostics-fixture-'));
    await fs.rm(root, {recursive: true, force: true});
  }); return root;
}
async function exported(service) {
  const result = await service.exportSnapshot();
  const raw = await fs.readFile(result.filePath, 'utf8'); return {result, raw, value: JSON.parse(raw)};
}
function rawSnapshot() {
  const status = {id: 'apple', provider: 'officialWeb', available: true, configured: true, status: 'session-unverified',
    controlled: true, audioReleaseUnverified: false, message: secret, credentials: {token: secret},
    capabilities: {authorize: true, library: true, search: true, playback: true, queue: true, arbitrary: secret, playableTypes: ['songs', 'library-songs']},
    runtime: {available: true, version: '155.0.4283.62', hostBuilt: true, sessionOpen: true, origin: `https://invalid.example/${secret}`},
    verification: {selectedPlaybackReadback: true, subscriptionFullSong: false, actualDacRate: 192000}};
  return {player: {available: true, state: 'paused', source: 'local', generation: 4, revision: 10, position: 14.54, duration: 241.53, volume: 1,
    currentTrack: {...song(0), path: 'E:\\音乐\\fixture.flac', subsong: 0}, error: {code: 'STILL_HTTP_TIMEOUT', message: secret}, actualDacRate: 192000},
  sources: {selectedSource: 'apple', sources: {local: {status: 'ready', available: true, message: secret}, apple: status}},
  backend: {pid: 34567, backendId: uuid, sessionId: uuid, executable: 'D:\\STILL\\backend\\foobar2000\\foobar2000.exe',
    foobarDir: 'D:\\STILL\\backend\\foobar2000', status: 'ready', available: true, owned: true, verified: true,
    manifestSha256: pin, executableSha256: pin, baseUrl: `http://127.0.0.1:18880/${secret}`, config: {cookies: secret}},
  apple: {status, state: {state: 'playing', source: 'apple', position: 33, duration: 241.53, volume: 0.5, currentTrack: song(1),
    controlled: true, authorizedAudio: true, outputMuted: false, audioReleaseUnverified: false, mayBeAudible: true, audible: true,
    authorizationRequired: false, fullSongVerified: false, error: secret, developerToken: secret},
    queue: {items: Array.from({length: 12}, (_, i) => song(i)), offset: 0, limit: 50, total: 12, hasMore: false, headers: secret}},
  audio: {available: true, actualDacRate: 192000, measured: {sampleRate: 192000, bitsPerSample: 32}, error: secret,
    outputConnection: {status: 'connected', endpointId: '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}', retryRequired: false, selectionMatches: true,
      message: secret, lastCheckedAt: '2026-10-31T10:20:00.000Z', evidence: {probe: 'IMMDevice.GetState', initializeCalled: false, startCalled: false,
        result: {operation: 'GetState', mode: 'state', active: true, initialized: false, startCalled: false, error: secret, headers: secret}}},
    release: {released: true, processExited: true, startCalled: false, result: {initialized: true, startCalled: false, rawSDK: secret}}},
  build: {version: '1.0.0', electronVersion: '45.1.0', buildId: pin, builtAt: '2026-10-31T02:26:33.065Z', validation: {message: secret}, hashes: {arbitrary: secret}},
  developerToken: secret, musicUserToken: secret, headers: secret, credentials: secret, showAll: true};
}

test('export uses explicit public schema, keeps physical uncertainty and never claims a DAC measurement', async t => {
  const root = await temporary(t); let calls = 0;
  const service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: async () => {calls++; return rawSnapshot();}});
  assert.equal(calls, 0);
  const {result, raw, value} = await exported(service);
  assert.equal(calls, 1); assert.deepEqual(Object.keys(result), ['saved', 'filePath', 'recordedAt']); assert.equal(result.saved, true);
  assert.equal(path.dirname(result.filePath), path.join(root, 'diagnostics'));
  assert.equal(value.snapshot.player.currentTrack.path, 'E:\\音乐\\fixture.flac'); assert.equal(value.snapshot.player.errorCode, 'STILL_HTTP_TIMEOUT');
  assert.equal(value.snapshot.apple.state.controlled, true); assert.equal(value.snapshot.apple.state.authorizedAudio, true);
  assert.equal(value.snapshot.apple.state.outputMuted, false); assert.equal(value.snapshot.apple.state.mayBeAudible, true);
  assert.equal(value.snapshot.apple.queue.items.length, 5); assert.equal(value.snapshot.apple.queue.total, 12);
  assert.equal(value.snapshot.sources.sources.apple.runtime.version, '155.0.4283.62');
  assert.equal(value.snapshot.backend.pid, 34567); assert.equal(value.snapshot.backend.manifestSha256, pin); assert.equal(value.snapshot.backend.executableSha256, pin);
  assert.equal(value.snapshot.build.buildId, pin); assert.equal(value.snapshot.build.electronVersion, '45.1.0');
  assert.equal(value.snapshot.audio.outputConnection.evidence.startCalled, false);
  assert.deepEqual(value.snapshot.audio.measured, {exclusive: null, sampleRate: null, bitsPerSample: null, channels: null});
  const visit = object => {if (!object || typeof object !== 'object') return; for (const [key, v] of Object.entries(object)) {if (key === 'actualDacRate') assert.equal(v, null); visit(v);}};
  visit(value); assert.equal(raw.includes(secret), false); assert.equal(raw.includes('https://'), false); assert.equal(raw.includes('http://'), false);
  await service.close();
});

test('sensitive dictionaries, raw SDK/error objects, accessors, prototypes and toJSON never escape or execute', async t => {
  const root = await temporary(t); let getterCalls = 0, serializationCalls = 0;
  const value = rawSnapshot(), dangerous = {token: secret, userToken: secret, developerToken: secret, musicUserToken: secret,
    cookies: secret, headers: {Authorization: secret}, credentials: secret, stack: secret, message: secret};
  value.rawSDK = value; value.apple.state.currentTrack.sdk = value;
  for (const target of [value, value.player, value.backend, value.apple, value.apple.state, value.apple.status, value.audio, value.build]) {
    Object.assign(target, dangerous); Object.defineProperty(target, 'toJSON', {value: () => {serializationCalls++; return dangerous;}});
    Object.defineProperty(target, 'password', {get() {getterCalls++; throw new Error(secret);}});
  }
  Object.defineProperty(value.player.currentTrack, 'title', {get() {getterCalls++; throw new Error(secret);}});
  Object.defineProperty(value.apple.state, 'currentTrackId', {get() {getterCalls++; throw new Error(secret);}});
  Object.setPrototypeOf(value.backend, {errorCode: 'STILL_OUTPUT_CHANGED', token: secret});
  const service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: async () => value});
  service.observePlayer(value.player); service.observeSources(value.sources);
  const {raw, value: artifact} = await exported(service);
  assert.equal(raw.includes(secret), false); assert.equal(getterCalls, 0); assert.equal(serializationCalls, 0);
  assert.equal(artifact.snapshot.player.currentTrack.title, undefined); assert.equal(artifact.snapshot.backend.errorCode, undefined);
  assert.equal(artifact.snapshot.apple.state.currentTrackId, undefined); assert.equal(artifact.snapshot.player.errorCode, 'STILL_HTTP_TIMEOUT');
  await service.close();
});

test('Apple observations capture only already-returned pagination and at most five public metadata samples', async t => {
  const root = await temporary(t); let snapshotCalls = 0;
  const service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => {snapshotCalls++; return {};}});
  const items = Array.from({length: 37}, (_, i) => song(i));
  service.observeAppleRead({operation: 'search', input: {term: secret, id: secret, limit: 25, offset: 50, token: secret},
    result: {kind: 'songs', items, limit: 25, offset: 50, hasMore: true, next: `https://invalid/${secret}`, headers: secret}});
  service.observeAppleRead({operation: 'library', input: {kind: 'playlist-songs', id: secret}, result: {items: [song(9)], limit: 1, offset: 0, hasMore: false}});
  service.observeAppleRead({operation: 'play', input: {id: secret}, result: {items}});
  assert.equal(snapshotCalls, 0);
  const {raw, value} = await exported(service);
  assert.equal(value.trace.length, 2); const search = value.trace[0].value;
  assert.equal(search.operation, 'search'); assert.equal(search.kind, 'songs'); assert.equal(search.count, 37);
  assert.equal(search.limit, 25); assert.equal(search.offset, 50); assert.equal(search.hasMore, true); assert.equal(search.samples.length, 5);
  assert.equal(value.trace[1].value.kind, 'playlist-songs'); assert.equal(raw.includes(secret), false); assert.equal(raw.includes('term'), false);
  await service.close();
});

test('source/player observations deduplicate sanitized changes and retain at most 240 recent events', async t => {
  const root = await temporary(t), service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => ({})});
  service.observePlayer({state: 'paused', source: 'local', position: 1, message: 'ignored one'});
  service.observePlayer({state: 'paused', source: 'local', position: 1, message: 'ignored two'});
  service.observeSources({selectedSource: 'apple', sources: {apple: {status: 'session-unverified', message: 'ignored one'}}});
  service.observeSources({selectedSource: 'apple', sources: {apple: {status: 'session-unverified', message: 'ignored two'}}});
  assert.equal((await exported(service)).value.trace.length, 2);
  for (let position = 0; position < 1000; position++) service.observePlayer({state: 'playing', source: 'local', position});
  const {value} = await exported(service);
  assert.equal(value.traceLimit, 240); assert.equal(value.trace.length, 240); assert.equal(value.traceDropped, 762);
  assert.equal(value.trace.at(-1).value.position, 999); assert.equal(value.trace[0].value.position, 760);
  await service.close();
});

test('metadata and total artifact are bounded even with oversized observations, arrays and Unicode', async t => {
  const root = await temporary(t), enormous = '汉'.repeat(100000);
  const track = {...song(1), title: enormous, artist: enormous, album: enormous, path: `E:\\${'a'.repeat(2000)}.flac`, subsong: 0};
  const service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => ({player: {source: 'local', currentTrack: track}, apple: {queue: {items: Array.from({length: 5000}, () => track)}}})});
  for (let i = 0; i < 500; i++) service.observePlayer({state: 'playing', source: 'local', position: i, currentTrack: track});
  const {raw, value} = await exported(service);
  assert.ok(Buffer.byteLength(raw) <= 512 * 1024); assert.ok(value.trace.length <= 240); assert.ok(value.traceDropped > 260);
  assert.equal(value.snapshot.player.currentTrack.title.length, 160); assert.equal(value.snapshot.apple.queue.items.length, 5);
  assert.equal(value.snapshot.apple.queue.items[0].path, undefined); assert.equal(value.snapshot.apple.queue.items[0].subsong, undefined);
  await service.close();
});

test('each export creates a distinct evidence file without accepting paths/showAll or overwriting prior bytes', async t => {
  const root = await temporary(t), service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => ({})});
  const first = await exported(service), second = await exported(service);
  assert.notEqual(first.result.filePath, second.result.filePath);
  assert.equal(await fs.readFile(first.result.filePath, 'utf8'), first.raw);
  await assert.rejects(service.exportSnapshot({showAll: true, filePath: path.join(root, 'outside.json')}), {code: 'DIAGNOSTICS_WRITE_FAILED'});
  assert.deepEqual((await fs.readdir(root)).sort(), ['diagnostics']); assert.equal((await fs.readdir(path.join(root, 'diagnostics'))).length, 2);
  await service.close();
});

test('pre-existing diagnostics junction/symlink and linked data ancestors are refused before writing outside', async t => {
  const root = await temporary(t), outside = path.join(root, 'outside'), data = path.join(root, 'data');
  await fs.mkdir(outside); await fs.mkdir(data);
  await fs.symlink(outside, path.join(data, 'diagnostics'), process.platform === 'win32' ? 'junction' : 'dir');
  const service = createDiagnosticsService({dataDir: data, now: fixedNow, getSnapshot: () => ({})});
  await assert.rejects(service.exportSnapshot(), {code: 'DIAGNOSTICS_UNSAFE_DIRECTORY'});
  assert.deepEqual(await fs.readdir(outside), []); await service.close();
  const linked = path.join(root, 'linked-data'); await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const other = createDiagnosticsService({dataDir: path.join(linked, 'child'), now: fixedNow, getSnapshot: () => ({})});
  await assert.rejects(other.exportSnapshot(), {code: 'DIAGNOSTICS_UNSAFE_DIRECTORY'}); assert.deepEqual(await fs.readdir(outside), []); await other.close();
});

test('a directory link introduced by the asynchronous snapshot provider is still refused', async t => {
  const root = await temporary(t), outside = path.join(root, 'outside'), data = path.join(root, 'data'); await fs.mkdir(outside); await fs.mkdir(data);
  const service = createDiagnosticsService({dataDir: data, now: fixedNow, getSnapshot: async () => {
    await fs.symlink(outside, path.join(data, 'diagnostics'), process.platform === 'win32' ? 'junction' : 'dir'); return {};
  }});
  await assert.rejects(service.exportSnapshot(), {code: 'DIAGNOSTICS_UNSAFE_DIRECTORY'}); assert.deepEqual(await fs.readdir(outside), []); await service.close();
});

test('snapshot exceptions and filesystem failures expose fixed safe codes rather than exception text', async t => {
  const root = await temporary(t), service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => {throw new Error(secret);}});
  await assert.rejects(service.exportSnapshot(), error => error.code === 'DIAGNOSTICS_SNAPSHOT_FAILED' && !error.message.includes(secret) && !error.cause);
  assert.deepEqual(await fs.readdir(root), []); await service.close();
  await fs.writeFile(path.join(root, 'diagnostics'), secret);
  const other = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => ({})});
  await assert.rejects(other.exportSnapshot(), {code: 'DIAGNOSTICS_UNSAFE_DIRECTORY'}); await other.close();
});

test('close blocks queued/in-flight snapshot exports and later observations without opening a host', async t => {
  const root = await temporary(t); let release, enteredResolve;
  const entered = new Promise(resolve => {enteredResolve = resolve;});
  const gate = new Promise(resolve => {release = resolve;}); let starts = 0;
  const service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: async () => {
    enteredResolve(); await gate; return {apple: {status: {status: 'session-closed', runtime: {sessionOpen: false}}, host: {start() {starts++;}}}};
  }});
  const pending = service.exportSnapshot(); pending.catch(() => {}); await entered;
  const closing = service.close(); release(); await assert.rejects(pending, {code: 'DIAGNOSTICS_CLOSED'}); await closing;
  service.observePlayer({state: 'playing'}); await assert.rejects(service.exportSnapshot(), {code: 'DIAGNOSTICS_CLOSED'});
  assert.equal(starts, 0); assert.deepEqual(await fs.readdir(root), []);
});

test('malformed fields, arbitrary status/error text, URLs and Apple-local paths are discarded', async t => {
  const root = await temporary(t);
  const service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => ({
    player: {state: secret, source: 'remote', volume: Infinity, position: -1, generation: -3, errorCode: secret, currentTrack: {...song(1), title: `https://invalid/${secret}`}},
    sources: {selectedSource: secret, sources: {apple: {status: secret, reasonCodes: [secret, 'needs-auth'], runtime: {version: secret}}}},
    apple: {state: {state: 'unknown', source: 'local', controlled: false, authorizedAudio: false, outputMuted: null, audioReleaseUnverified: true, mayBeAudible: true,
      currentTrack: {...song(1), path: 'E:\\sensitive-local-path.flac', subsong: 2}}, queue: {items: [song(1)]}},
    backend: {executable: `https://invalid/${secret}`, sessionId: secret, manifestSha256: secret}, build: {buildId: secret}
  })});
  const {raw, value} = await exported(service);
  assert.equal(raw.includes(secret), false); assert.equal(value.snapshot.player.state, undefined); assert.equal(value.snapshot.player.volume, undefined);
  assert.equal(value.snapshot.player.currentTrack.title, undefined); assert.equal(value.snapshot.apple.state.currentTrack.path, undefined);
  assert.equal(value.snapshot.apple.state.outputMuted, null); assert.equal(value.snapshot.apple.state.audioReleaseUnverified, true);
  assert.deepEqual(value.snapshot.sources.sources.apple.reasonCodes, ['needs-auth']); await service.close();
});

test('layout preserves portrait CSS size/DPR and computes effective motion from the actual app/system OR', async t => {
  const root = await temporary(t), service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => ({})});
  const portrait = {width: 600, height: 1000, devicePixelRatio: 3.25, horizontalOverflow: false,
    appReducedMotion: true, systemReducedMotion: false, effectiveReducedMotion: false, accentColor: '#a1b2c3'};
  service.observeLayout(portrait);
  let artifact = (await exported(service)).value;
  assert.deepEqual(artifact.snapshot.layout, {...portrait, effectiveReducedMotion: true, accentColor: '#A1B2C3'});
  assert.equal(artifact.trace[0].event, 'layout'); assert.deepEqual(artifact.trace[0].value, artifact.snapshot.layout);
  service.observeLayout({...portrait, appReducedMotion: false, systemReducedMotion: true, effectiveReducedMotion: false});
  assert.equal((await exported(service)).value.snapshot.layout.effectiveReducedMotion, true);
  service.observeLayout({...portrait, appReducedMotion: false, systemReducedMotion: false, effectiveReducedMotion: true});
  artifact = (await exported(service)).value; assert.equal(artifact.snapshot.layout.effectiveReducedMotion, false);
  assert.equal(artifact.trace.length, 3); await service.close();
});

test('layout drops DOM/HTML/accounts/provider/URLs/errors/paths and never reads input accessors or ambient UI', async t => {
  const root = await temporary(t); let reads = 0;
  const value = {width: 600, height: 1000, devicePixelRatio: 3.25, horizontalOverflow: false,
    rawDOM: secret, HTML: secret, outerHTML: secret, account: {email: secret}, token: secret, provider: secret,
    error: {message: secret}, path: secret, url: `https://invalid/${secret}`};
  for (const key of ['window', 'document', 'process', 'engine', 'appReducedMotion']) Object.defineProperty(value, key, {get() {reads++; throw new Error(secret);}});
  const service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => ({layout: {rawDOM: secret}})});
  service.observeLayout(value); const {raw, value: artifact} = await exported(service);
  assert.equal(reads, 0); assert.equal(raw.includes(secret), false); assert.equal(raw.includes('https://'), false);
  assert.deepEqual(artifact.snapshot.layout, {width: 600, height: 1000, devicePixelRatio: 3.25, horizontalOverflow: false});
  assert.deepEqual(artifact.trace[0].value, artifact.snapshot.layout); await service.close();
});

test('layout rejects invalid sizes/DPR/colors and missing motion inputs never become false', async t => {
  const root = await temporary(t), service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => ({})});
  for (const value of [0, -1, 32769, 1.5, NaN, Infinity, '600', null]) {
    service.observeLayout({width: value, height: value}); assert.deepEqual((await exported(service)).value.snapshot.layout, {});
  }
  for (const value of [0.249, 16.001, NaN, Infinity, '3.25', null]) {
    service.observeLayout({devicePixelRatio: value}); assert.deepEqual((await exported(service)).value.snapshot.layout, {});
  }
  for (const value of ['#FFF', '#aabbcc44', 'red', `https://invalid/${secret}`, null]) {
    service.observeLayout({accentColor: value}); assert.deepEqual((await exported(service)).value.snapshot.layout, {});
  }
  service.observeLayout({width: 1, height: 32768, devicePixelRatio: 0.25, appReducedMotion: false, effectiveReducedMotion: false,
    horizontalOverflow: null, systemReducedMotion: 'false'});
  assert.deepEqual((await exported(service)).value.snapshot.layout, {width: 1, height: 32768, devicePixelRatio: 0.25, appReducedMotion: false});
  service.observeLayout({devicePixelRatio: 16, systemReducedMotion: true, effectiveReducedMotion: false});
  assert.deepEqual((await exported(service)).value.snapshot.layout, {devicePixelRatio: 16, systemReducedMotion: true});
  await service.close();
});

test('layout uses a detached latest value, deduplicates ignored changes and shares the 240-entry bound', async t => {
  const root = await temporary(t), service = createDiagnosticsService({dataDir: root, now: fixedNow, getSnapshot: () => ({})});
  assert.equal((await exported(service)).value.snapshot.layout, undefined);
  const value = {width: 600, height: 1000, accentColor: '#abcdef'};
  service.observeLayout(value); value.width = 900; value.rawDOM = secret;
  service.observeLayout({width: 600, height: 1000, accentColor: '#ABCDEF', rawDOM: secret});
  let artifact = (await exported(service)).value;
  assert.equal(artifact.snapshot.layout.width, 600); assert.equal(artifact.trace.length, 1);
  for (let width = 1; width <= 500; width++) service.observeLayout({width, height: 1000});
  service.observePlayer({state: 'paused', source: 'local'});
  artifact = (await exported(service)).value;
  assert.equal(artifact.trace.length, 240); assert.equal(artifact.traceDropped, 262);
  assert.equal(artifact.snapshot.layout.width, 500); assert.equal(artifact.trace.at(-1).event, 'player');
  assert.equal(artifact.trace.filter(row => row.event === 'layout').length, 239);
  await service.close(); service.observeLayout({width: 123}); await assert.rejects(service.exportSnapshot(), {code: 'DIAGNOSTICS_CLOSED'});
});

test('Apple-only snapshots and traces exclude local observations even if a provider returns extra general fields', async t => {
  const root = await temporary(t), localPath = 'E:\\PRIVATE_LOCAL_TRACK\\fixture.flac', raw = rawSnapshot();
  raw.player.currentTrack.path = localPath;
  const scopes = [], service = createDiagnosticsService({dataDir: root, getSnapshot: input => {scopes.push(input); return raw;}});
  service.observePlayer(raw.player); service.observeSources(raw.sources);
  service.observePlayer({...raw.apple.state, source: 'apple', currentTrack: {...song(1), path: localPath}});
  service.observeAppleRead({operation: 'library', input: {kind: 'songs'}, result: {items: [song(1)]}});
  service.observeLayout({width: 600, height: 1000});
  const result = await service.exportSnapshot({scope: 'apple'}), serialized = await fs.readFile(result.filePath, 'utf8'), artifact = JSON.parse(serialized);
  assert.deepEqual(scopes, [{scope: 'apple'}]); assert.deepEqual(Object.keys(artifact.snapshot), ['apple', 'build', 'layout']);
  assert.equal(serialized.includes(localPath), false); assert.equal(serialized.includes('PRIVATE_LOCAL_TRACK'), false);
  assert.equal(serialized.includes('foobar2000'), false); assert.equal(artifact.traceDropped, 1);
  assert.deepEqual(artifact.trace.map(row => row.event), ['sources', 'player', 'apple-read', 'layout']);
  assert.deepEqual(Object.keys(artifact.trace[0].value.sources), ['apple']);
  assert.equal(artifact.trace[1].value.currentTrack.path, undefined); await service.close();
});

test('queued exports capture detached scope and layout per request while legacy no-argument exports still work', async t => {
  const root = await temporary(t); let release, entered;
  const gate = new Promise(resolve => {release = resolve;}), started = new Promise(resolve => {entered = resolve;});
  const requests = [], service = createDiagnosticsService({dataDir: root, getSnapshot: async options => {
    requests.push(options); if (requests.length === 1) {entered(); await gate;} return rawSnapshot();}});
  service.observeLayout({width: 600, height: 1000});
  const firstInput = {scope: 'apple', layout: {width: 601, height: 1001}}, first = service.exportSnapshot(firstInput);
  await started;
  firstInput.scope = 'changed'; firstInput.layout.width = 999;
  const secondInput = {layout: {width: 602, height: 1002}}, second = service.exportSnapshot(secondInput);
  secondInput.scope = 'apple'; secondInput.layout.width = 999;
  const third = service.exportSnapshot();
  service.observeLayout({width: 603, height: 1003});
  release();
  const results = await Promise.all([first, second, third]), artifacts = await Promise.all(results.map(async result => JSON.parse(await fs.readFile(result.filePath, 'utf8'))));
  assert.deepEqual(requests, [{scope: 'apple'}, {}, {}]);
  assert.equal(artifacts[0].scope, 'apple'); assert.deepEqual(Object.keys(artifacts[0].snapshot), ['apple', 'build', 'layout']);
  assert.deepEqual(artifacts[0].snapshot.layout, {width: 601, height: 1001});
  assert.equal(artifacts[1].scope, undefined); assert.ok(artifacts[1].snapshot.backend);
  assert.deepEqual(artifacts[1].snapshot.layout, {width: 602, height: 1002});
  assert.deepEqual(artifacts[2].snapshot.layout, {width: 600, height: 1000});
  await service.close();
});

test('scope options reject unknown fields and scope/layout accessors without executing them', async t => {
  const root = await temporary(t); let reads = 0, snapshots = 0;
  const service = createDiagnosticsService({dataDir: root, getSnapshot: () => {snapshots++; return {};}});
  const scoped = {}, withLayout = {};
  Object.defineProperty(scoped, 'scope', {get() {reads++; return 'apple';}});
  Object.defineProperty(withLayout, 'layout', {get() {reads++; return {};}});
  for (const value of [scoped, withLayout, {scope: 'all'}, {scope: 'apple', url: secret}, {scope: 'apple', [Symbol('unknown')]: true}, null, []]) {
    await assert.rejects(service.exportSnapshot(value), {code: 'DIAGNOSTICS_WRITE_FAILED'});
  }
  assert.equal(reads, 0); assert.equal(snapshots, 0); assert.deepEqual(await fs.readdir(root), []); await service.close();
});

test('cached handoff diagnostics preserve the primary and cleanup codes separately and retain only sixteen explicit safe events', async t => {
  const root = await temporary(t), endpoint = '{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}'; let reads = 0;
  const current = {phase: 'blocked', code: 'STILL_OUTPUT_RELEASE_UNKNOWN', cleanupCode: 'STILL_HANDOFF_EXIT_UNVERIFIED', from: 'local', to: 'apple', sourceExited: false, sequence: 99,
    releaseEvidence: {classification: 'unknown', trustedEndpoint: true, endpoint, hresult: '0x887C001A', operation: 'Initialize', mode: 'shared', startCalled: false,
      rawSDK: secret, headers: secret, observed: true}, credentials: secret, paths: secret};
  Object.defineProperty(current.releaseEvidence, 'rawError', {get() {reads++; throw new Error(secret);}});
  const value = {handoff: {current, history: Array.from({length: 20}, (_, sequence) => ({...current, sequence})), pendingRestore: false, exitUnverified: true, provider: secret},
    sources: {sources: {local: {status: 'standby', available: false, connected: false, backendReachable: false, capabilities: {playback: false, canStartOnDemand: true}}}}};
  const service = createDiagnosticsService({dataDir: root, getSnapshot: () => value});
  const {raw, value: artifact} = await exported(service), handoff = artifact.snapshot.handoff;
  assert.equal(handoff.current.code, 'STILL_OUTPUT_RELEASE_UNKNOWN'); assert.equal(handoff.current.cleanupCode, 'STILL_HANDOFF_EXIT_UNVERIFIED');
  assert.equal(handoff.current.releaseEvidence.hresult, '0x887C001A'); assert.equal(handoff.current.releaseEvidence.classification, 'unknown');
  assert.equal(handoff.current.sourceExited, false); assert.equal(handoff.current.releaseEvidence.startCalled, false);
  assert.equal(handoff.history.length, 16); assert.equal(handoff.history[0].sequence, 4); assert.equal(handoff.history.at(-1).sequence, 19);
  assert.equal(raw.includes(secret), false); assert.equal(reads, 0); assert.equal(handoff.current.releaseEvidence.observed, undefined);
  const local = artifact.snapshot.sources.sources.local; assert.equal(local.status, 'standby'); assert.equal(local.connected, false); assert.equal(local.capabilities.canStartOnDemand, true);
  const appleFile = await service.exportSnapshot({scope: 'apple'}), apple = JSON.parse(await fs.readFile(appleFile.filePath, 'utf8'));
  assert.deepEqual(apple.snapshot.handoff, handoff); assert.equal(apple.snapshot.sources, undefined); await service.close();
});

test('handoff probe boundaries keep fixed native stages and cleanup HRESULTs without raw exceptions or source-exit inference', async t => {
  const root = await temporary(t); let reads = 0;
  const probe = {classification: 'unknown', trustedEndpoint: true, endpoint: null, operation: 'Initialize', mode: 'shared', hresult: '0x887C001A',
    stage: 'Initialize', failureStage: 'Initialize', hresultSource: 'native-return', initializeCalled: true, startCalled: false,
    nativeResults: Array.from({length: 20}, () => ({stage: 'Initialize', hresult: '0x887C001A', rawError: secret})),
    cleanupComplete: true, cleanupFailures: [{resource: 'AudioClient', hresult: '0x80004005', error: secret}],
    probeChildExited: true, probeExitCode: -1, actualDacRate: 192000, error: secret};
  Object.defineProperty(probe, 'clientToken', {get() {reads++; throw new Error(secret);}});
  const event = {phase: 'blocked', code: 'STILL_HANDOFF_DRAIN_UNVERIFIED', cleanupCode: 'STILL_OUTPUT_RELEASE_BUSY', from: 'local', to: 'apple',
    sourceExited: null, sequence: 1, releaseEvidence: probe};
  const service = createDiagnosticsService({dataDir: root, getSnapshot: () => ({handoff: {current: event, history: [event]}})});
  const {raw, value} = await exported(service), saved = value.snapshot.handoff.current, evidence = saved.releaseEvidence;
  assert.equal(saved.code, 'STILL_HANDOFF_DRAIN_UNVERIFIED'); assert.equal(saved.cleanupCode, 'STILL_OUTPUT_RELEASE_BUSY');
  assert.equal(evidence.stage, 'Initialize'); assert.equal(evidence.failureStage, 'Initialize'); assert.equal(evidence.hresultSource, 'native-return');
  assert.equal(evidence.nativeResults.length, 12); assert.deepEqual(evidence.cleanupFailures, [{resource: 'AudioClient', hresult: '0x80004005'}]);
  assert.equal(evidence.probeChildExited, true); assert.equal(saved.sourceExited, null); assert.equal(evidence.probeExitCode, -1); assert.equal(evidence.actualDacRate, null);
  assert.equal(raw.includes(secret), false); assert.equal(reads, 0); await service.close();
});

test('Apple lifecycle safety fields keep fixed phases and unknown readback values without arbitrary status text', async t => {
  const root = await temporary(t), service = createDiagnosticsService({dataDir: root, getSnapshot: () => ({apple: {
    status: {pending: true, controlsReady: false, lifecyclePhase: 'closing'},
    state: {state: 'unknown', pending: true, controlsReady: false, lifecyclePhase: 'closing', position: null, duration: null, outputMuted: null}}})});
  const value = (await exported(service)).value.snapshot.apple;
  assert.equal(value.status.lifecyclePhase, 'closing'); assert.equal(value.status.pending, true); assert.equal(value.status.controlsReady, false);
  assert.equal(value.state.position, null); assert.equal(value.state.duration, null); assert.equal(value.state.outputMuted, null); assert.equal(value.state.lifecyclePhase, 'closing');
  await service.close();
});

test('Apple explicit operation history keeps the latest sixteen safe stages and never overwrites the newer last operation', async t => {
  const root = await temporary(t); let reads = 0;
  const latest = {method: 'play', stage: 'complete', code: null, kind: 'library-songs', id: 'i.new-C'};
  const history = Array.from({length: 20}, (_, index) => ({method: 'play', stage: 'failed', code: 'official-player-not-ready', kind: 'library-songs', id: 'i.old-A',
    failedFromStage: 'dispatch', origin: 'native-sdk-ready-timeout', operationId: index + 1, generation: index, args: {token: secret}, rawError: secret}));
  history[19].operationId = 1; // Late A is recorded, independently of the current lastOperation C.
  Object.defineProperty(history[18], 'url', {get() {reads++; throw new Error(secret);}});
  history[17].origin = `https://private.invalid/${secret}`;
  const service = createDiagnosticsService({dataDir: root, getSnapshot: () => ({apple: {status: {available: false, pending: true, controlsReady: false, lifecyclePhase: 'starting',
    capabilities: {playback: false, canSubmitPlayIntent: true, playIntentTypes: ['songs', 'library-songs'], maxPlayItems: 1}, lastOperation: latest, operationHistory: history},
    state: {state: 'loading', pending: true, position: null, duration: null, volume: null, outputMuted: null, currentTrackId: null, currentTrack: null}}})});
  const saved = await service.exportSnapshot({scope: 'apple'}), raw = await fs.readFile(saved.filePath, 'utf8'), value = JSON.parse(raw).snapshot.apple;
  assert.deepEqual(value.status.lastOperation, latest); assert.equal(value.status.operationHistory.length, 16);
  assert.equal(value.status.operationHistory[0].operationId, 5); assert.equal(value.status.operationHistory.at(-1).id, 'i.old-A');
  assert.equal(value.status.operationHistory.at(-1).origin, 'native-sdk-ready-timeout'); assert.equal(value.status.operationHistory.at(-1).failedFromStage, 'dispatch');
  assert.equal(value.status.operationHistory[13].origin, undefined); assert.equal(value.status.available, false); assert.equal(value.status.capabilities.playback, false);
  assert.equal(value.status.capabilities.canSubmitPlayIntent, true); assert.equal(value.status.capabilities.maxPlayItems, 1);
  assert.equal(value.state.position, null); assert.equal(value.state.currentTrackId, null); assert.equal(value.state.currentTrack, null);
  assert.equal(raw.includes(secret), false); assert.equal(reads, 0); await service.close();
});

test('Apple autoplay policy keeps only strict own booleans and the fixed producer decisions without inferring availability or verification', async t => {
  const root = await temporary(t), decisions = ['not-seen', 'awaiting-request', 'revoked', 'allow-pending', 'allow-session', 'deny-kind', 'deny-core',
    'deny-origin', 'deny-navigation', 'deny-revoked', 'deny-nonce', 'deny-expired', 'temporary-policy-unavailable', 'handler-unavailable'];
  let policy;
  const service = createDiagnosticsService({dataDir: root, getSnapshot: () => ({apple: {status: {status: 'session-closed', available: false,
    autoplayPolicy: policy, verification: {selectedPlaybackReadback: false, subscriptionFullSong: false}}},
    sources: {sources: {local: {autoplayPolicy: policy}, apple: {autoplayPolicy: policy}}}})});
  for (const decision of decisions) {
    policy = {configured: true, seen: decision !== 'not-seen', decision};
    const value = (await exported(service)).value.snapshot;
    assert.deepEqual(value.apple.status.autoplayPolicy, policy); assert.deepEqual(value.sources.sources.apple.autoplayPolicy, policy);
    assert.equal(value.sources.sources.local.autoplayPolicy, undefined); assert.equal(value.apple.status.available, false);
    assert.equal(value.apple.status.verification.subscriptionFullSong, false); assert.equal(value.apple.status.errorCode, undefined);
  }
  await service.close();
});

test('autoplay diagnostic reconstruction never reads getters/prototypes/toJSON or retains URI, nonce, arguments and unknown decisions', async t => {
  const root = await temporary(t); let reads = 0, serializations = 0;
  let policy = {configured: false, seen: false, decision: 'not-seen', rawUri: `https://private.invalid/${secret}`, nonce: secret, args: {token: secret}, provider: secret};
  Object.defineProperty(policy, 'toJSON', {value() {serializations++; return {nonce: secret};}});
  Object.defineProperty(policy, 'headers', {get() {reads++; throw new Error(secret);}});
  const service = createDiagnosticsService({dataDir: root, getSnapshot: () => ({apple: {status: {autoplayPolicy: policy}}})});
  let saved = await exported(service);
  assert.deepEqual(saved.value.snapshot.apple.status.autoplayPolicy, {configured: false, seen: false, decision: 'not-seen'});
  assert.equal(saved.raw.includes(secret), false); assert.equal(reads, 0); assert.equal(serializations, 0);
  policy = {configured: 'true', seen: null, decision: `https://private.invalid/${secret}`};
  Object.defineProperty(policy, 'configured', {get() {reads++; throw new Error(secret);}});
  saved = await exported(service); assert.deepEqual(saved.value.snapshot.apple.status.autoplayPolicy, {}); assert.equal(saved.raw.includes(secret), false);
  policy = Object.create({configured: true, seen: true, decision: 'allow-session'});
  assert.deepEqual((await exported(service)).value.snapshot.apple.status.autoplayPolicy, {});
  policy = secret;
  assert.equal((await exported(service)).value.snapshot.apple.status.autoplayPolicy, undefined);
  assert.equal(reads, 0); assert.equal(serializations, 0); await service.close();
});
