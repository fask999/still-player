'use strict';

// Existing-service fakes only: no native hosts, network, accounts or devices.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {readAppleDiagnosticSnapshot, createDiagnosticSnapshotReader} = require('../src/main/apple-diagnostics');
const {createDiagnosticsService} = require('../src/main/diagnostics');
const secret = 'PRIVATE_APPLE_DIAGNOSTIC_FIXTURE';
const publicMethods = ['play', 'pause', 'stop', 'next', 'previous', 'seek', 'setQueue', 'apiMusic', 'queue', 'volume'];
const support = () => Object.fromEntries(publicMethods.map(key => [key, true]));
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-apple-diagnostics-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('still-apple-diagnostics-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  return root;
}
async function exportApple(t, apple) {
  const dataDir = await temporary(t), service = createDiagnosticsService({dataDir,
    getSnapshot: createDiagnosticSnapshotReader({apple, getGeneralSnapshot: () => {throw new Error('General snapshot must not run');}})});
  t.after(() => service.close());
  const saved = await service.exportSnapshot({scope: 'apple'}), raw = await fs.readFile(saved.filePath, 'utf8');
  return {raw, artifact: JSON.parse(raw)};
}

test('Apple scope reads only the existing service and takes fresh status after state and at most five queue items', async t => {
  const calls = []; let methods = {}, lastOperation = null, forbiddenCalls = 0;
  const forbidden = () => {forbiddenCalls++; throw new Error(secret);};
  const apple = {initialize: forbidden, authorize: forbidden, start: forbidden, close: forbidden,
    getState: async () => {calls.push('state'); methods = support(); return {available: true, source: 'apple', state: 'paused'};},
    getQueue: async input => {calls.push(['queue', input]); lastOperation = {method: 'play', stage: 'failed', code: 'official-track-unconfirmed'};
      return {items: Array.from({length: 20}, (_, index) => ({id: `song-${index}`, title: `Song ${index}`})), total: 20};},
    getStatus: () => {calls.push('status'); return {status: 'session-unverified', configured: true, available: true,
      methodSupport: methods, lastOperation, capabilities: {library: true}};}};
  const snapshot = createDiagnosticSnapshotReader({apple, getGeneralSnapshot: forbidden});
  const dataDir = await temporary(t), diagnostics = createDiagnosticsService({dataDir, getSnapshot: snapshot});
  t.after(() => diagnostics.close());
  const saved = await diagnostics.exportSnapshot({scope: 'apple'}), artifact = JSON.parse(await fs.readFile(saved.filePath, 'utf8'));
  assert.deepEqual(calls, ['state', ['queue', {limit: 5, offset: 0}], 'status']);
  assert.equal(forbiddenCalls, 0); assert.deepEqual(Object.keys(artifact.snapshot), ['apple']);
  assert.equal(artifact.scope, 'apple'); assert.equal(artifact.snapshot.apple.queue.items.length, 5);
  assert.deepEqual(artifact.snapshot.apple.status.methodSupport, support());
  assert.deepEqual(artifact.snapshot.apple.status.lastOperation, lastOperation);
});

test('an unavailable state never starts or authorizes a session or asks for its queue; final account status remains distinct', async () => {
  const calls = [];
  const value = await readAppleDiagnosticSnapshot({
    getState: () => {calls.push('state'); return {available: false, state: 'unknown', errorCode: 'official-player-not-ready'};},
    getQueue: () => {throw new Error('No queue without an available state');},
    getStatus: () => {calls.push('status'); return {status: 'session-unverified', configured: true, capabilities: {library: true}};},
    initialize: () => {throw new Error('Do not initialize');}, authorize: () => {throw new Error('Do not authorize');}});
  assert.deepEqual(calls, ['state', 'status']); assert.equal(value.apple.queue, undefined);
  assert.equal(value.apple.state.errorCode, 'official-player-not-ready'); assert.equal(value.apple.status.configured, true);
});

test('state and queue exceptions retain fixed safe codes, status is still last, and raw exception text never exports', async t => {
  for (const code of ['host-timeout', 'needs-auth', 'official-origin-required', 'STILL_CANCELLED', secret]) {
    const calls = [], thrown = Object.assign(new Error(secret), {code});
    const {raw, artifact} = await exportApple(t, {
      getState: () => {calls.push('state'); throw thrown;},
      getStatus: () => {calls.push('status'); return {status: 'session-unverified', lastOperation: {method: 'play', stage: 'authorization-check', code: 'needs-auth'}};}});
    assert.deepEqual(calls, ['state', 'status']); assert.equal(raw.includes(secret), false);
    assert.equal(artifact.snapshot.apple.state.errorCode, code === secret ? 'official-operation-failed' : code);
    assert.deepEqual(artifact.snapshot.apple.status.lastOperation, {method: 'play', stage: 'authorization-check', code: 'needs-auth'});
  }
  const {raw, artifact} = await exportApple(t, {
    getState: () => ({available: true, source: 'apple', state: 'paused'}),
    getQueue: () => {throw Object.assign(new Error(secret), {code: 'official-queue-unavailable'});},
    getStatus: () => ({status: 'ready', lastOperation: {method: 'search', stage: 'failed', code: 'host-timeout'}})});
  assert.equal(raw.includes(secret), false); assert.equal(artifact.snapshot.apple.queue.errorCode, 'official-queue-unavailable');
  assert.deepEqual(artifact.snapshot.apple.status.lastOperation, {method: 'search', stage: 'failed', code: 'host-timeout'});
});

test('missing readers and status failures produce distinct safe error codes without a new session', async t => {
  const empty = await readAppleDiagnosticSnapshot({});
  assert.equal(empty.apple.state.errorCode, 'official-api-unavailable'); assert.equal(empty.apple.status.errorCode, 'official-api-unavailable');
  const {artifact} = await exportApple(t, {getState: () => ({available: false, state: 'unavailable', errorCode: 'session-closed'}),
    getStatus: () => {throw Object.assign(new Error(secret), {code: 'host-exited'});}});
  assert.equal(artifact.snapshot.apple.status.errorCode, 'host-exited');
  assert.equal(artifact.snapshot.apple.state.errorCode, 'session-closed');
  const invalid = await readAppleDiagnosticSnapshot({getState: () => secret, getStatus: () => null});
  assert.equal(invalid.apple.state.errorCode, 'official-invalid-response'); assert.equal(invalid.apple.status.errorCode, 'official-invalid-response');
});

test('method support and operation diagnostics whitelist values without getters, identifiers, arguments or unknown fields', async t => {
  let reads = 0;
  const methods = {...support(), arbitrary: secret, token: secret};
  Object.defineProperty(methods, 'play', {get() {reads++; throw new Error(secret);}});
  methods.volume = 1; methods.apiMusic = null;
  const operation = {method: 'resume', stage: 'readback', code: null, id: secret, url: `https://example.invalid/${secret}`,
    args: {token: secret}, result: secret, error: secret};
  Object.defineProperty(operation, 'toJSON', {value() {reads++; return secret;}});
  const {raw, artifact} = await exportApple(t, {
    getState: () => ({available: false, state: 'unknown'}),
    getStatus: () => ({status: 'session-unverified', methodSupport: methods, lastOperation: operation, token: secret})});
  assert.equal(reads, 0); assert.equal(raw.includes(secret), false);
  assert.deepEqual(artifact.snapshot.apple.status.methodSupport, {pause: true, stop: true, next: true, previous: true, seek: true, setQueue: true, queue: true});
  assert.deepEqual(artifact.snapshot.apple.status.lastOperation, {method: 'resume', stage: 'readback', code: null});
  for (const lastOperation of [null, {method: secret, stage: 'failed', code: 'needs-auth'}, {method: 'play', stage: secret, code: 'needs-auth'},
    {method: 'play', stage: 'failed', code: secret}, {method: 'play', stage: 'failed'}]) {
    const {artifact: next} = await exportApple(t, {getState: () => ({available: false}), getStatus: () => ({lastOperation})});
    assert.equal(next.snapshot.apple.status.lastOperation, lastOperation === null ? null : undefined);
  }
  const evil = {};
  Object.defineProperty(evil, 'code', {get() {reads++; throw new Error(secret);}});
  const safe = await readAppleDiagnosticSnapshot({getState: () => {throw evil;}, getStatus: () => ({})});
  assert.equal(reads, 0); assert.equal(safe.apple.state.errorCode, 'official-operation-failed');
});

test('only a play operation can identify its strict song kind and business ID, without URLs or raw arguments', async t => {
  const base = {method: 'play', stage: 'failed', code: 'official-track-unconfirmed'};
  const cases = [
    [{...base, kind: 'songs', id: 'catalog-123'}, {...base, kind: 'songs', id: 'catalog-123'}],
    [{...base, kind: 'library-songs', id: 'i.abc-123'}, {...base, kind: 'library-songs', id: 'i.abc-123'}],
    [{...base, kind: 'albums', id: 'catalog-123'}, base],
    [{...base, kind: 'songs', id: 'https://private.invalid/123'}, base],
    [{...base, kind: 'songs', id: 'x'.repeat(201)}, base],
    [{...base, method: 'search', kind: 'songs', id: 'catalog-123'}, {...base, method: 'search'}]
  ];
  for (const [lastOperation, expected] of cases) {
    const {artifact, raw} = await exportApple(t, {getState: () => ({available: false}),
      getStatus: () => ({lastOperation: {...lastOperation, args: {token: secret}, url: `https://private.invalid/${secret}`}})});
    assert.deepEqual(artifact.snapshot.apple.status.lastOperation, expected); assert.equal(raw.includes(secret), false);
  }
});

test('Apple-only diagnostics add a static package identity without invoking any general or local provider', async t => {
  const dataDir = await temporary(t); let general = 0, builds = 0;
  const service = createDiagnosticsService({dataDir, getSnapshot: createDiagnosticSnapshotReader({
    apple: {getState: () => ({available: false, source: 'apple', state: 'unavailable', errorCode: 'session-closed'}), getStatus: () => ({status: 'session-closed'})},
    getGeneralSnapshot: () => {general++; throw new Error('No local/provider/helper access');},
    getBuildSnapshot: () => {builds++; return {version: '1.0.0', sourceFrozenSnapshot: 'b'.repeat(64), buildId: 'b'.repeat(64),
      account: secret, path: secret, rawSDK: secret};}})});
  t.after(() => service.close());
  const saved = await service.exportSnapshot({scope: 'apple'}), raw = await fs.readFile(saved.filePath, 'utf8'), value = JSON.parse(raw);
  assert.equal(general, 0); assert.equal(builds, 1); assert.equal(value.snapshot.build.sourceFrozenSnapshot, 'b'.repeat(64));
  assert.equal(value.snapshot.build.version, '1.0.0'); assert.equal(raw.includes(secret), false);
  assert.deepEqual(Object.keys(value.snapshot), ['apple', 'build']);
});

test('both diagnostics scopes append only the pure cached handoff provider while Apple-only never reads local state', async t => {
  const dataDir = await temporary(t); let local = 0, cached = 0;
  const current = {phase: 'probe-failed', code: 'STILL_OUTPUT_RELEASE_UNKNOWN', cleanupCode: null, from: 'local', to: 'apple', sourceExited: false, sequence: 1,
    releaseEvidence: {classification: 'unknown', trustedEndpoint: true, hresult: '0x887C001A', operation: 'Initialize', mode: 'shared', startCalled: false}};
  const service = createDiagnosticsService({dataDir, getSnapshot: createDiagnosticSnapshotReader({
    apple: {getState: () => ({available: false}), getStatus: () => ({status: 'session-closed'})},
    getGeneralSnapshot: () => {local++; return {};}, getHandoffSnapshot: () => {cached++; return {current, history: [current], pendingRestore: false, exitUnverified: false};}})});
  t.after(() => service.close());
  const appleFile = await service.exportSnapshot({scope: 'apple'}), value = JSON.parse(await fs.readFile(appleFile.filePath, 'utf8'));
  assert.equal(local, 0); assert.equal(cached, 1); assert.equal(value.snapshot.handoff.current.releaseEvidence.classification, 'unknown');
  assert.equal(value.snapshot.handoff.current.code, 'STILL_OUTPUT_RELEASE_UNKNOWN');
  const normal = await service.exportSnapshot(), other = JSON.parse(await fs.readFile(normal.filePath, 'utf8'));
  assert.equal(local, 1); assert.equal(cached, 2); assert.deepEqual(other.snapshot.handoff, value.snapshot.handoff);
});

test('pending Apple lifecycle diagnostics do not ask an available-but-closing host for its queue', async () => {
  let queues = 0;
  const value = await readAppleDiagnosticSnapshot({getState: () => ({available: true, state: 'unknown', pending: true, position: null, duration: null}),
    getQueue: () => {queues++; throw new Error('No dying host probe');}, getStatus: () => ({pending: true, lifecyclePhase: 'closing', controlsReady: false})});
  assert.equal(queues, 0); assert.equal(value.apple.state.position, null); assert.equal(value.apple.status.lifecyclePhase, 'closing');
});

test('Apple-only export preserves the real sanitized Node policy channel and producer-owned unavailable reasons after close', async t => {
  const vm = require('node:vm'), syncFs = require('node:fs'), {createRequire} = require('node:module');
  const fixturePath = path.join(__dirname, 'apple-supersede.test.js'), load = createRequire(fixturePath), ownModule = {exports: {}};
  // Existing production Node host + VM SDK fixture: test registration is muted;
  // every child/profile/SDK operation remains synthetic and injected.
  vm.runInNewContext(syncFs.readFileSync(fixturePath, 'utf8') + '\nmodule.exports={fixture};', {
    require: name => name === 'node:test' ? () => {} : load(name), module: ownModule, exports: ownModule.exports,
    __dirname, __filename: fixturePath, process: {env: {STILL_APPLE_FIXTURE_RUNTIME_ROOT: path.join(__dirname, '..')}},
    console, Buffer, URL, URLSearchParams, AbortController, setTimeout, clearTimeout, setImmediate
  });
  for (const decision of ['temporary-policy-unavailable', 'handler-unavailable']) {
    const f = await ownModule.exports.fixture(t);
    f.children[0].policyMessage({configured: true, seen: false, decision, rawUri: `https://private.invalid/${secret}`, nonce: secret, args: {token: secret}});
    await new Promise(resolve => setImmediate(resolve));
    const expected = {configured: true, seen: false, decision};
    assert.deepEqual(f.apple.getStatus().autoplayPolicy, expected);
    const before = await exportApple(t, f.apple);
    assert.deepEqual(before.artifact.snapshot.apple.status.autoplayPolicy, expected); assert.equal(before.raw.includes(secret), false);
    assert.equal(before.artifact.snapshot.apple.status.verification.subscriptionFullSong, false);
    await f.apple.close();
    const after = await exportApple(t, f.apple);
    assert.deepEqual(after.artifact.snapshot.apple.status.autoplayPolicy, expected); assert.equal(after.raw.includes(secret), false);
    assert.equal(after.artifact.snapshot.apple.status.available, false);
  }
});
