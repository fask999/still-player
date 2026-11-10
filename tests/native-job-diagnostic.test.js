'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// Pure protocol fixtures only; never compiles/runs a stub, r6 Native or core.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');
const path = require('node:path');
const diagnostic = require('../scripts/verify-native-job-diagnostic');
const common = require('../scripts/verify-public-backend');
const ID = '11111111-2222-4333-8444-555555555555';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(options = {}) {
  const job = new EventEmitter(), witness = {pid: 4242}, proof = {pid: 4242}, calls = [], events = [];
  let ready, notReady;
  job.ready = new Promise((resolve, reject) => {ready = resolve; notReady = reject;}); job.ready.catch(() => {});
  job.treeExitEvidence = null; job.requestExit = () => {calls.push('FORBIDDEN_EXIT');};
  const api = {
    create: async input => {
      calls.push('create');
      if (!options.noCreated) input.onCreated(witness, job);
      queueMicrotask(() => {
        if (options.noCreated || options.readyFailure) {
          job.controlError = Object.assign(new Error('SYNTHETIC_PRIVATE_NATIVE_ERROR'), {code: 'STILL_BACKEND_JOB_LAUNCH_FAILED'});
          job.emit('control-error', job.controlError); notReady(job.controlError); return;
        }
        job.emit('ready'); ready(job);
        queueMicrotask(() => {
          job.emit('exit', options.exitCode ?? 0);
          if (!options.noTree) {job.treeExitEvidence = options.copiedTree ? {...proof} : proof; job.emit('job-tree-empty');}
        });
      });
      return job;
    },
    isCreationWitness: (value, child) => !options.badWitness && value === witness && child === job,
    isProcess: child => child === job,
    isTreeExit: (value, child) => value === proof && child === job
  };
  const lifetime = {};
  return {api, calls, events, lifetime,
    run: emit => diagnostic.runDiagnostic({api, input: {backendDir: 'synthetic-only'}, lifetime, timeoutMs: options.noTree ? 1 : 100,
      emit: emit || ((phase, fields) => events.push({phase, ...fields}))})};
}

test('diagnostic defaults to plan and execution requires a prepared UUID and explicit digest', () => {
  assert.equal(diagnostic.parseArguments([]).execute, false);
  assert.equal(diagnostic.parseArguments(['--prepare']).prepare, true);
  for (const argv of [['--execute'], ['--prepare', '--execute'], ['--plan', '--prepare'], ['--root', 'foreign'],
    ['--prepared-id', ID], ['--execute', '--prepared-id', '../foreign', '--prepared-sha256', 'a'.repeat(64)]]) {
    assert.throws(() => diagnostic.parseArguments(argv));
  }
  assert.equal(diagnostic.parseArguments(['--execute', '--prepared-id', ID, '--prepared-sha256', 'a'.repeat(64)]).execute, true);
  const scope = diagnostic.scopePaths(ID);
  assert.equal(scope.executable, path.join(scope.backendDir, 'foobar2000.exe'));
  assert.equal(common.inside(diagnostic.ROOT, scope.directory), true);
});

test('fixed auditable stub only sleeps and naturally exits, and prepared pins cannot substitute arbitrary source/config', () => {
  assert.match(diagnostic.STUB_SOURCE, /Thread\.Sleep\(1000\); return 0;/);
  assert.doesNotMatch(diagnostic.STUB_SOURCE, /System\.IO|Console\.|Net\.|Process\.|Audio|Windows\.Forms/);
  const data = [['NaturalExit.cs', Buffer.from(diagnostic.STUB_SOURCE)], ['root/foobar2000.exe', Buffer.from('SYNTHETIC_PE_BYTES_ONLY')],
    ['root/portable_mode_enabled', Buffer.alloc(0)], ['root/profile/beefweb/config.json', diagnostic.CONFIG]];
  const record = {schemaVersion: 1, runId: ID, backendId: ID, buildInfoSha256: common.POLICY.buildSha256,
    sourceSha256: sha(Buffer.from(diagnostic.STUB_SOURCE)), compiler: diagnostic.COMPILER, compilerExitCode: 0,
    files: data.map(([relativePath, bytes]) => ({relativePath, bytes: bytes.length, sha256: sha(bytes)}))};
  assert.equal(diagnostic.validatePrepared(record, ID), record);
  for (const patch of [{sourceSha256: '0'.repeat(64)}, {compiler: 'unknown'}, {files: record.files.slice(1)}, {buildInfoSha256: 'wrong'}]) {
    assert.throws(() => diagnostic.validatePrepared({...record, ...patch}, ID));
  }
  const changed = {...record, files: record.files.map(row => row.relativePath.endsWith('config.json') ? {...row, sha256: 'f'.repeat(64)} : row)};
  assert.throws(() => diagnostic.validatePrepared(changed, ID));
});

test('pure Native fixture records actual-predicate creation/READY/exit/tree without a BackendSession or health claim', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, 'passed-native-fixture-only'); assert.equal(result.ownFixture, true);
  assert.equal(result.creationWitnessVerified, true); assert.equal(result.nativeReadyObserved, true);
  assert.equal(result.transferClaimValidatedAtReady, true); assert.equal(result.childExitCode, 0);
  assert.equal(result.treeProofVerified, true); assert.equal(result.requiresExecutorRetention, false);
  assert.equal(Object.hasOwn(result, 'backendSession'), false); assert.equal(Object.hasOwn(result, 'healthy'), false);
  assert.deepEqual(f.calls, ['create']);
});

for (const [name, options] of [['before-created failure', {noCreated: true}], ['created but no READY', {readyFailure: true}],
  ['copied tree fields', {copiedTree: true}], ['missing tree event', {noTree: true}], ['foreign creation witness', {badWitness: true}]]) {
  test(`${name} is an uncertain failed native attempt and retains the executor`, async () => {
    const f = fixture(options), result = await f.run();
    assert.equal(result.status, 'failed'); assert.equal(result.nativeAttempted, true);
    assert.equal(result.treeProofVerified, false); assert.equal(result.requiresExecutorRetention, true);
    assert.equal(f.lifetime.treeProofVerified, undefined); assert.equal(f.calls.includes('FORBIDDEN_EXIT'), false);
    if (options.noCreated) {assert.equal(result.createdObserved, false); assert.equal(result.nativeReadyObserved, false);}
    assert.equal(JSON.stringify([result, f.events]).includes('SYNTHETIC_PRIVATE_NATIVE_ERROR'), false);
  });
}

test('nonzero natural exit fails the fixture while retaining honest verified tree facts', async () => {
  const f = fixture({exitCode: 3}), result = await f.run();
  assert.equal(result.status, 'failed'); assert.equal(result.code, 'VERIFY_STUB_EXIT_STATUS');
  assert.equal(result.treeProofVerified, true); assert.equal(result.requiresExecutorRetention, false);
});

test('observer throws cannot suppress natural exit evidence or turn the fixture into a success', async () => {
  const f = fixture(), result = await f.run(() => {throw new Error('SYNTHETIC_PRIVATE_SINK');});
  assert.equal(result.status, 'failed'); assert.equal(result.observerFailed, true);
  assert.equal(result.treeProofVerified, true); assert.equal(result.childExitCode, 0);
  assert.equal(result.requiresExecutorRetention, false);
  const unknown = fixture({noCreated: true}), failed = await unknown.run(() => {throw new Error('SYNTHETIC_PRIVATE_SINK');});
  assert.equal(failed.requiresExecutorRetention, true); assert.equal(failed.treeProofVerified, false);
});
