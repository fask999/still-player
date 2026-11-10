'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// Entirely synthetic lifecycle/metadata/buffers. Never loads the real r6 API,
// opens a socket, launches a child, plays audio, or reads a user profile/media.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {EventEmitter} = require('node:events');
const verifier = require('../scripts/verify-public-backend');
const ID = '11111111-2222-4333-8444-555555555555';
const DEVICE = `${verifier.POLICY.sharedProvider}:11111111-2222-3333-4444-555555555555`;
const wanted = {typeId: 'output', deviceId: DEVICE};
const ENDPOINT = '{0.0.0.00000000}.{11111111-2222-3333-4444-555555555555}';
const scope = verifier.scopePaths(ID);
const code = expected => error => error.code === expected;

function fixture(patch = {}) {
  const calls = [], events = [], session = {pid: 4242}, proof = {pid: 4242};
  let time = 0, playing = false, position = 0, stopped = false, treeExited = false, ready = false;
  const state = () => ({available: true, backendReachable: true, stale: false, controlUncertain: false,
    state: playing ? 'playing' : 'stopped', position, currentTrack: playing ? {path: scope.wavePath, subsong: 0} : null,
    output: wanted});
  const bootstrap = {
    initialize: async () => {calls.push('bootstrap.initialize'); return {automatic: true, prepared: false};},
    begin: async () => {calls.push('bootstrap.begin');},
    complete: async options => {calls.push(['bootstrap.complete', options]);},
    getStatus: () => ({prepared: true, ready}), getExpectedFiles: () => [{relativePath: 'synthetic-only'}],
    markReady: received => {assert.equal(received, session); calls.push('bootstrap.markReady'); ready = true;},
    close: async () => {calls.push('bootstrap.close');}
  };
  const info = {available: true, owned: true, nativeReadySeen: true, status: 'ready', pid: session.pid, baseUrl: 'http://127.0.0.1:19876/api/'};
  const backend = {
    initialize: async () => {calls.push('backend.initialize'); return info;}, getSession: () => session,
    close: async () => {calls.push('backend.close'); treeExited = !patch.noTree; return {exitEvidence: patch.copiedProof ? {...proof} : proof};},
    isOwnedTreeExited: received => received === session && treeExited,
    getInfo: () => ({owned: !treeExited})
  };
  const service = {
    on() {}, bindBackendSession: received => {assert.equal(received, session); calls.push('service.bind');},
    initialize: async () => {calls.push('service.initialize'); return patch.staleInitial ? {...state(), stale: true} : state();},
    outputs: async () => ({outputs: [{...wanted, name: 'Synthetic exact speaker', configuredExclusive: null},
      {typeId: 'output', deviceId: `${verifier.POLICY.sharedProvider}:00000000-0000-0000-0000-000000000000`, name: 'Synthetic default'}]}),
    selectOutput: async received => {assert.deepEqual(received, wanted); calls.push('service.selectOutput');
      return {selected: wanted, outputConnection: {status: 'connected', selectionMatches: true, endpointId: patch.wrongEndpoint ? 'wrong' : ENDPOINT}};},
    retryOutput: async () => ({ready: true, outputConnection: {status: 'connected', retryRequired: false, selectionMatches: true, endpointId: ENDPOINT}}),
    play: async input => {assert.deepEqual(input, {paths: [scope.wavePath]}); calls.push('service.play');
      if (patch.playError) throw patch.playError;
      playing = true; return patch.wrongWave ? {...state(), currentTrack: {path: 'unapproved.synthetic', subsong: 0}} : state();},
    getState: async () => {calls.push('service.getState'); if (playing && !patch.frozenProgress) position += 0.35; return state();},
    stop: async () => {calls.push('service.stop'); if (patch.stopError) throw patch.stopError;
      playing = false; stopped = true; return state();},
    beginShutdownWrites: () => {calls.push('service.quiesce'); return {stop: async () => {calls.push('service.cleanupStop'); playing = false; return state();}};},
    markBackendExited: received => {assert.equal(received, proof); calls.push('service.markExited');},
    close: async () => {calls.push('service.close');}
  };
  const api = {
    createBootstrap: () => bootstrap, createBackend: () => backend, createService: () => {calls.push('service.create'); return service;},
    isSession: received => received === session && !patch.unbranded,
    isChildExit: received => received === proof, isTreeExit: received => received === proof && treeExited
  };
  return {calls, events, api, bootstrap, backend, service, info, proof,
    run: stage => verifier.runLifecycle({api, scope, stage, wanted, emit: (phase, fields) => events.push({phase, ...fields}),
      pause: async milliseconds => {time += milliseconds;}, now: () => time}),
    get stopped() {return stopped;}};
}

test('CLI defaults to a plan and has no path/runtime/installer override surface', () => {
  assert.equal(verifier.parseArguments([]).execute, false);
  assert.equal(verifier.parseArguments(['--check']).check, true);
  for (const argv of [['--execute'], ['--execute', '--check'], ['--plan', '--execute', '--stage', 'enumerate'], ['--data-dir', 'elsewhere'], ['--package-root', 'elsewhere'],
    ['--installer', 'elsewhere'], ['--stage', 'play'], ['--execute', '--stage', 'enumerate', '--device-id', DEVICE]]) {
    assert.throws(() => verifier.parseArguments(argv), error => /^VERIFY_/.test(error.code));
  }
  const parsed = verifier.parseArguments(['--execute', '--stage', 'play', '--enumeration-id', ID, '--type-id', 'output', '--device-id', DEVICE]);
  assert.equal(parsed.deviceId, DEVICE);
});

test('only an exact non-default shared provider tuple is eligible; names cannot select devices', () => {
  assert.deepEqual(verifier.selection('output', DEVICE), wanted);
  for (const pair of [['output', `${verifier.POLICY.sharedProvider}:00000000-0000-0000-0000-000000000000`],
    ['output', '0DD9B977-765B-4804-BF2D-B28EBF0C510D:11111111-2222-3333-4444-555555555555'], ['ASIO', DEVICE], ['output', 'DX1 II'], ['output', DEVICE + '\n']]) {
    assert.throws(() => verifier.selection(...pair), code('VERIFY_EXPLICIT_SHARED_OUTPUT_REQUIRED'));
  }
  const rows = verifier.sanitizedOutputs({outputs: [{...wanted, name: 'Any name'}, {typeId: 'output', deviceId: 'unknown', name: 'DX1 II'}]});
  assert.equal(rows[0].sharedEligible, true); assert.equal(rows[1].sharedEligible, false);
});

test('scope and file inventories reject escape/aliases/unknown pin shape before effects', () => {
  for (const name of ['../x', '/x', 'a\\x', 'a:x', 'a/./x', 'a//x', 'NUL', 'a/trailing.']) assert.throws(() => verifier.relativeFile(name));
  assert.equal(verifier.relativeFile('components/foo_ui_std.dll'), 'components/foo_ui_std.dll');
  assert.throws(() => verifier.scopePaths('../other'));
  assert.equal(scope.backendDir, path.join(scope.dataDir, 'backend/foobar2000'));
  assert.equal(verifier.inside(verifier.POLICY.evidenceRoot, scope.dataDir), true);
  assert.equal(verifier.inside(scope.dataDir, path.join(scope.dataDir, '../foreign')), false);
  assert.throws(() => verifier.inventoryRows({'a.js': {bytes: 1, sha256: 'a'.repeat(64)}, 'A.js': {bytes: 1, sha256: 'a'.repeat(64)}}));
  assert.throws(() => verifier.inventoryRows({'a.js': {bytes: -1, sha256: 'a'.repeat(64)}}));
});

test('fake filesystem metadata rejects symbolic links, junction aliases and hard links', async () => {
  const filename = path.resolve('synthetic/root/file');
  const io = {lstat: async current => ({isSymbolicLink: () => false, isFile: () => current === filename, nlink: 1}), realpath: async value => value};
  await verifier.noLinks(filename, io);
  await assert.rejects(verifier.noLinks(filename, {...io, lstat: async () => ({isSymbolicLink: () => true, isFile: () => false})}), code('VERIFY_LINK_REJECTED'));
  await assert.rejects(verifier.noLinks(filename, {...io, lstat: async () => ({isSymbolicLink: () => false, isFile: () => true, nlink: 2})}), code('VERIFY_LINK_REJECTED'));
  await assert.rejects(verifier.noLinks(filename, {...io, realpath: async () => path.resolve('foreign')}), code('VERIFY_PATH_ALIAS_REJECTED'));
});

function silentBuffer() {
  const bytes = Buffer.alloc(2116844);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100, 24); bytes.writeUInt32LE(176400, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(2116800, 40); return bytes;
}
const pin = bytes => ({bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')});
test('only the approved-format twelve-second all-zero PCM buffer can pass', () => {
  const bytes = silentBuffer(); assert.equal(verifier.verifyWave(bytes).allZeroPcm, true);
  assert.throws(() => verifier.verifyWave(bytes, {bytes: bytes.length, sha256: '0'.repeat(64)}), code('VERIFY_WAVE_PIN'));
  for (const mutate of [data => {data[44] = 1;}, data => data.writeUInt32LE(48000, 24), data => data.writeUInt16LE(1, 22)]) {
    const changed = Buffer.from(bytes); mutate(changed);
    assert.throws(() => verifier.verifyWave(changed, pin(changed)), code('VERIFY_WAVE_NOT_APPROVED_SILENCE'));
  }
});

test('synthetic enumeration requires genuine-API predicates and closes after two stopped observations', async () => {
  const f = fixture(), result = await f.run('enumerate');
  assert.equal(result.status, 'enumerated'); assert.equal(result.ready, true);
  assert.equal(result.childExitVerified, true); assert.equal(result.treeExitVerified, true); assert.equal(result.stoppedVerified, true);
  assert.equal(f.calls.includes('service.play'), false); assert.equal(f.calls.includes('service.selectOutput'), false);
  assert.deepEqual(f.calls.find(row => Array.isArray(row)), ['bootstrap.complete', {musicDirs: [scope.mediaDir]}]);
  assert.ok(f.calls.indexOf('service.stop') < f.calls.indexOf('backend.close'));
  assert.ok(f.calls.indexOf('service.markExited') < f.calls.indexOf('service.close'));
});

test('synthetic play uses exactly one approved WAV, advances across readings and performs no volume call', async () => {
  const f = fixture(), result = await f.run('play');
  assert.equal(result.status, 'passed'); assert.equal(result.volumeWrites, 0); assert.equal(f.stopped, true);
  assert.ok(result.progress.length >= 3); assert.ok(result.progress.at(-1).position >= result.progress[0].position + 1);
  assert.equal(result.requiresExecutorRetention, false);
  assert.equal(f.calls.some(row => typeof row === 'string' && /volume|kill|installer|smtc/i.test(row)), false);
});

for (const [name, patch, expected] of [
  ['unbranded JSON session', {unbranded: true}, 'VERIFY_REAL_OWNED_SESSION_REQUIRED'],
  ['stale initial readback', {staleInitial: true}, 'VERIFY_INITIAL_STOPPED_REQUIRED'],
  ['different endpoint readback', {wrongEndpoint: true}, 'VERIFY_OUTPUT_READBACK_REQUIRED'],
  ['frozen playing position', {frozenProgress: true}, 'VERIFY_REAL_PROGRESS_REQUIRED'],
  ['another media identity', {wrongWave: true}, 'VERIFY_PLAYBACK_IDENTITY_OR_STATE'],
  ['failed stop readback', {stopError: Object.assign(new Error('redacted'), {code: 'STILL_STOP_FAILED'})}, 'STILL_STOP_FAILED']
]) test(`${name} cannot pass even when later graceful cleanup succeeds`, async () => {
  const f = fixture(patch), result = await f.run('play'); assert.equal(result.status, 'failed'); assert.equal(result.code, expected);
});

test('native READY and fresh setup cannot be replaced by available/serialized flags', async () => {
  const f = fixture(); f.info.nativeReadySeen = false;
  assert.equal((await f.run('enumerate')).code, 'VERIFY_REAL_OWNED_SESSION_REQUIRED');
  const old = fixture(); old.bootstrap.initialize = async () => ({automatic: true, prepared: true});
  const result = await old.run('enumerate'); assert.equal(result.code, 'VERIFY_FRESH_AUTOMATIC_SETUP_REQUIRED');
  assert.equal(old.calls.includes('backend.initialize'), false);
});

test('missing/copy-only tree proof retains the executor rather than closing the bridge or claiming pass', async () => {
  for (const patch of [{noTree: true}, {copiedProof: true, noTree: true}]) {
    const f = fixture(patch), result = await f.run('play');
    assert.equal(result.status, 'failed'); assert.equal(result.treeExitVerified, false);
    assert.equal(result.requiresExecutorRetention, true); assert.equal(f.calls.includes('service.close'), false);
    assert.equal(f.calls.includes('service.markExited'), false);
  }
});

test('only typed error codes and bounded own-WAV facts are emitted, never provider error/media strings', async () => {
  const secret = 'FAKE_PROVIDER_PRIVATE_VALUE', f = fixture({playError: new Error(secret)});
  const result = await f.run('play'); assert.equal(result.code, 'VERIFY_OPERATION_FAILED');
  assert.equal(JSON.stringify([result, f.events]).includes(secret), false);
  const state = verifier.stateEvidence({available: true, backendReachable: true, state: 'playing', position: 0,
    currentTrack: {path: secret, title: secret, subsong: 0}, output: wanted}, scope.wavePath, wanted);
  assert.equal(JSON.stringify(state).includes(secret), false); assert.equal(state.exactOwnWave, false);
});

test('enumeration records only authorize tuple membership, never a new live session brand', () => {
  const input = {enumerationId: ID, ...wanted};
  const record = {schemaVersion: 1, runId: ID, stage: 'enumerate', status: 'enumerated', simulated: false,
    buildInfoSha256: verifier.POLICY.buildSha256, silenceSha256: verifier.POLICY.waveSha256,
    ready: true, stoppedVerified: true, treeExitVerified: true, childExitVerified: true, outputs: [{...wanted, sharedEligible: true}]};
  assert.deepEqual(verifier.checkEnumerationRecord(record, input), wanted);
  for (const patch of [{simulated: true}, {treeExitVerified: false}, {buildInfoSha256: 'x'}, {outputs: []}]) {
    assert.throws(() => verifier.checkEnumerationRecord({...record, ...patch}, input), error => /^VERIFY_/.test(error.code));
  }
});

test('exact Reviewer repro: cleanup-failed observer throw returns failed retention with no manufactured exit', async () => {
  const f = fixture({noTree: true}), lifetime = {};
  const result = await verifier.runLifecycle({api: f.api, scope, stage: 'enumerate', lifetime,
    emit: phase => {if (phase === 'cleanup-failed') throw new Error('SYNTHETIC_EVIDENCE_SINK_FAILURE');}});
  assert.equal(result.status, 'failed'); assert.equal(result.observerFailed, true);
  assert.equal(result.requiresExecutorRetention, true); assert.equal(f.backend.getInfo().owned, true);
  assert.equal(result.stoppedVerified, true); assert.equal(f.stopped, true);
  assert.equal(result.childExitVerified, false); assert.equal(result.treeExitVerified, false);
  assert.equal(f.calls.includes('service.markExited'), false); assert.equal(f.calls.includes('service.close'), false);
  assert.equal(lifetime.backend, f.backend); assert.notEqual(lifetime.exitVerified, true);
});

for (const phase of ['backend-ready', 'stopped', 'cleanup-failed']) test(`throwing ${phase} observer cannot interrupt owned cleanup or retention`, async () => {
  const f = fixture({noTree: true});
  const result = await verifier.runLifecycle({api: f.api, scope, stage: 'enumerate',
    emit: current => {if (current === phase) throw new Error('SYNTHETIC_PRIVATE_OBSERVER_MESSAGE');}});
  assert.equal(result.status, 'failed'); assert.equal(result.observerFailed, true);
  assert.equal(result.requiresExecutorRetention, true); assert.equal(result.treeExitVerified, false);
  assert.equal(f.calls.includes('backend.close'), true); assert.equal(f.calls.includes('bootstrap.close'), true);
  assert.equal(f.calls.includes('service.markExited'), false); assert.equal(f.calls.includes('service.close'), false);
  assert.equal(JSON.stringify(result).includes('SYNTHETIC_PRIVATE_OBSERVER_MESSAGE'), false);
});

test('async rejected observer is captured without an unhandled rejection and retains an unverified tree', async () => {
  const f = fixture({noTree: true});
  const result = await verifier.runLifecycle({api: f.api, scope, stage: 'enumerate',
    emit: phase => phase === 'cleanup-failed' ? Promise.reject(new Error('SYNTHETIC_ASYNC_FAILURE')) : undefined});
  assert.equal(result.status, 'failed'); assert.equal(result.observerFailed, true);
  assert.equal(result.requiresExecutorRetention, true); assert.equal(result.treeExitVerified, false);
});

test('observer failure after a real fake-brand exit is still failure while verified physical facts remain true', async () => {
  const f = fixture(), lifetime = {};
  const result = await verifier.runLifecycle({api: f.api, scope, stage: 'enumerate', lifetime,
    emit: phase => {if (phase === 'exit-verified') throw new Error('SYNTHETIC_EXIT_OBSERVER_FAILURE');}});
  assert.equal(result.status, 'failed'); assert.equal(result.observerFailed, true);
  assert.equal(result.treeExitVerified, true); assert.equal(result.childExitVerified, true);
  assert.equal(result.requiresExecutorRetention, false); assert.equal(lifetime.exitVerified, true);
  assert.equal(f.calls.includes('service.close'), true);
});

test('main lifetime protection is armed before any result and retains unknown/throwing manager state', () => {
  for (const lifetime of [
    {backend: {getInfo: () => ({owned: true})}},
    {backend: {getInfo: () => {throw new Error('SYNTHETIC_STATE_FAILURE');}}},
    {backend: {getInfo: () => ({owned: false, startupCreated: true})}},
    {backend: {getInfo: () => ({owned: false, startupCreated: false})}, session: {pid: 4242}}
  ]) {
    let armed = 0, cleared = 0;
    const protection = verifier.protectLifetime(lifetime, {setInterval: () => {armed++; return 1;}, clearInterval: () => {cleared++;}});
    assert.equal(armed, 1); assert.equal(protection.finish(), true); assert.equal(cleared, 0);
  }
  for (const lifetime of [{}, {backend: {getInfo: () => ({owned: false, startupCreated: false})}},
    {backend: {getInfo: () => ({owned: true})}, exitVerified: true}]) {
    let cleared = 0;
    const protection = verifier.protectLifetime(lifetime, {setInterval: () => 1, clearInterval: () => {cleared++;}});
    assert.equal(protection.finish(), false); assert.equal(cleared, 1);
  }
});

test('startupCreated=false after an initialize attempt is missing witness, never an OS no-create proof', async () => {
  const f = fixture({noTree: true}), lifetime = {};
  f.backend.initialize = async () => {throw Object.assign(new Error('SYNTHETIC_NATIVE_FAILURE'), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'});};
  f.backend.getInfo = () => ({owned: false, startupCreated: false, nativeReadySeen: false, available: false, status: 'failed', pid: null});
  const result = await verifier.runLifecycle({api: f.api, scope, stage: 'enumerate', lifetime});
  assert.equal(result.status, 'failed'); assert.equal(result.requiresExecutorRetention, true);
  assert.equal(result.retentionReason, 'initialize-attempt-without-tree-proof');
  assert.equal(result.backendAtFailure.creationWitnessObserved, false);
  assert.equal(result.backendAtFailure.nativeReadySeen, false);
  assert.equal(result.treeExitVerified, false); assert.equal(result.childExitVerified, false);
  assert.equal(verifier.requiresExecutorRetention({backend: f.backend, startAttempted: true}), true);
});

class FakeSink extends EventEmitter {
  constructor(mode = 'ok') {super(); this.mode = mode; this.lines = [];}
  write(value, callback) {
    if (this.mode === 'throw') throw new Error('SYNTHETIC_PRIVATE_WRITE_FAILURE');
    this.lines.push(value);
    queueMicrotask(() => {
      const error = this.mode === 'callback-error' ? Object.assign(new Error('SYNTHETIC_EPIPE'), {code: 'EPIPE'}) : null;
      callback(error);
      if (this.mode === 'event-error') this.emit('error', Object.assign(new Error('SYNTHETIC_EPIPE'), {code: 'EPIPE'}));
    });
    return false; // Normal backpressure is not itself an observer failure.
  }
}

for (const channel of ['stdout', 'stderr']) for (const mode of ['throw', 'callback-error', 'event-error']) {
  test(`${channel} ${mode} is handled without EPIPE escape or false success`, async () => {
    const stdout = new FakeSink(channel === 'stdout' ? mode : 'ok'), stderr = new FakeSink(channel === 'stderr' ? mode : 'ok');
    const output = verifier.createOutputGuard(stdout, stderr);
    try {
      assert.doesNotThrow(() => output.write(channel, 'typed-phase-only\n'));
      await output.flush(); assert.equal(output.failed(), true);
      const result = {status: 'enumerated', code: null, treeExitVerified: true};
      if (output.failed()) verifier.markObserverFailure(result);
      assert.equal(result.status, 'failed'); assert.equal(result.code, 'VERIFY_OBSERVER_FAILED');
      assert.equal(result.treeExitVerified, true); // Do not fabricate or erase physical facts.
    } finally {output.dispose();}
  });
}

test('healthy sinks permit complete cleanup and ordinary backpressure is not an error', async () => {
  const stdout = new FakeSink(), stderr = new FakeSink(), output = verifier.createOutputGuard(stdout, stderr);
  try {
    output.write('stdout', 'phase\n'); output.write('stderr', 'typed\n'); await output.flush();
    assert.equal(output.failed(), false);
  } finally {output.dispose();}
});

test('sink failure during unverified cleanup leaves both failure and retention available', async () => {
  const f = fixture({noTree: true}), stdout = new FakeSink('event-error'), stderr = new FakeSink();
  const output = verifier.createOutputGuard(stdout, stderr);
  try {
    const result = await verifier.runLifecycle({api: f.api, scope, stage: 'enumerate',
      emit: phase => {if (phase === 'cleanup-failed') output.write('stdout', 'cleanup-failed\n');}});
    await output.flush(); if (output.failed()) verifier.markObserverFailure(result);
    assert.equal(result.status, 'failed'); assert.equal(result.requiresExecutorRetention, true);
    assert.equal(result.treeExitVerified, false); assert.equal(f.calls.includes('service.close'), false);
  } finally {output.dispose();}
});
