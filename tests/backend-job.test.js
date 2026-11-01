'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// Protocol streams and source contracts only. No executable, socket or device.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const {bindBackendJobProcess, isOwnedCreationWitness, isBackendJobTreeExit} = require('../src/main/backend-job');
const nonce = 'a'.repeat(64);
function fixture() {
  const raw = new EventEmitter(); raw.stdout = new PassThrough(); raw.stdin = new PassThrough();
  const input = {nonce, executable: 'C:\\私有\\foobar2000.exe', profilePath: 'C:\\私有\\profile\\beefweb\\config.json',
    executableSha256: 'b'.repeat(64), backendId: 'protocol-fixture', parentPid: 104};
  const commands = []; raw.stdin.on('data', value => commands.push(value.toString()));
  const child = bindBackendJobProcess(raw, input), errors = []; child.on('control-error', error => errors.push(error));
  let sequence = 0;
  const row = (type, fields = {}) => ({schemaVersion: 1, nonce, sequence: ++sequence, type, pid: 921, startTime: '133700000000000001', ...fields});
  const created = () => row('created', {...input, atomicJobAssignment: true, jobHandleInheritable: false, suspended: true});
  const ready = () => row('ready', {parentOwnsJob: true, brokerOwnsJob: false, jobHandleInheritable: false});
  const send = value => raw.stdout.write(JSON.stringify(value) + '\n');
  return {raw, input, child, errors, commands, row, created, ready, send};
}

test('one raw launch channel brands only its exact ready child and empty tree', async () => {
  const f = fixture(); f.send(f.created());
  assert.equal(isOwnedCreationWitness(f.child.creationWitness, f.child), true);
  assert.equal(isOwnedCreationWitness({...f.child.creationWitness}, f.child), false);
  assert.deepEqual(f.commands, [`ACK ${nonce}\n`]);
  f.send(f.ready()); await f.child.ready; await f.child.requestExit();
  assert.deepEqual(f.commands, [`ACK ${nonce}\n`, `EXIT ${nonce}\n`]);
  let exits = 0; f.child.on('exit', () => {exits++;});
  f.send(f.row('child-exit', {processHandleSignaled: true, exitCode: 0}));
  assert.equal(exits, 1); assert.equal(f.child.treeExitEvidence, null);
  f.send(f.row('tree-empty', {activeProcessZero: true, rootHandleSignaled: true}));
  assert.equal(isBackendJobTreeExit(f.child.treeExitEvidence, f.child), true);
  assert.equal(isBackendJobTreeExit({...f.child.treeExitEvidence}, f.child), false);
  f.raw.emit('close', 0); assert.equal(f.errors.length, 0);
});

for (const type of ['child-exit', 'tree-empty']) test(`created → ${type} without READY never mints an exit brand`, async () => {
  const f = fixture(); let exits = 0; f.child.on('exit', () => {exits++;}); f.send(f.created());
  f.send(f.row(type, {processHandleSignaled: true, exitCode: 0, activeProcessZero: true, rootHandleSignaled: true}));
  await assert.rejects(f.child.ready, {code: 'STILL_BACKEND_STARTUP_UNCERTAIN', abnormalStartupExitRequired: true});
  assert.equal(exits, 0); assert.equal(f.child.exitCode, null); assert.equal(f.child.treeExitEvidence, null);
});

test('broker exit/close/EOF after READY never substitutes for a root process HANDLE witness', async () => {
  const f = fixture(); f.send(f.created()); f.send(f.ready()); await f.child.ready;
  let exits = 0; f.child.on('exit', () => {exits++;});
  f.raw.emit('exit', 0); f.raw.stdout.end(); f.raw.emit('close', 0);
  assert.equal(exits, 0); assert.equal(f.child.exitCode, null); assert.equal(f.child.treeExitEvidence, null);
  assert.throws(() => f.child.requestExit(), {code: 'STILL_BACKEND_JOB_CHANNEL_LOST'});
});

test('wrong nonce, replay and oversized data fail closed without a child exit', async () => {
  for (const kind of ['nonce', 'replay', 'oversize']) {
    const f = fixture();
    if (kind === 'nonce') f.send({...f.created(), nonce: 'c'.repeat(64)});
    if (kind === 'replay') {const row = f.created(); f.send(row); f.send(row);}
    if (kind === 'oversize') f.raw.stdout.write('x'.repeat(65537));
    await assert.rejects(f.child.ready); assert.equal(f.child.exitCode, null); assert.equal(f.child.treeExitEvidence, null);
  }
});

test('split UTF-8 paths preserve the exact native creation identity', async () => {
  const f = fixture(), bytes = Buffer.from(JSON.stringify(f.created()) + '\n');
  for (let index = 0; index < bytes.length; index++) f.raw.stdout.write(bytes.subarray(index, index + 1));
  assert.equal(f.child.creationWitness.executable, f.input.executable);
  f.send(f.ready()); await f.child.ready;
});

test('native source keeps lifetime and graceful-exit race constraints explicit', async () => {
  const source = await fs.readFile(path.join(__dirname, '../native/backend-job/launcher.cpp'), 'utf8');
  assert.match(source, /PROC_THREAD_ATTRIBUTE_JOB_LIST, localJob, true/);
  assert.doesNotMatch(source, /AssignProcessToJobObject\s*\(/);
  assert.doesNotMatch(source, /QueryInformationJobObject\s*\(/);
  assert.doesNotMatch(source, /JOB_OBJECT_LIMIT_(?:SILENT_)?BREAKAWAY_OK/);
  assert.doesNotMatch(source, /CancelSynchronousIo\s*\(/);
  const ready = source.indexOf('channel.emit("ready"');
  assert.equal(source.slice(ready).includes('DUPLICATE_SAME_ACCESS'), false);
  assert.equal((source.match(/DUPLICATE_CLOSE_SOURCE/g) || []).length, 1);
  const create = source.indexOf('helper = createProcess('), rootCheck = source.indexOf('if (WaitForSingleObject(child.get(), 0) != WAIT_TIMEOUT)', create);
  const resume = source.indexOf('ResumeThread(helperThread.get())', create);
  assert.match(source.slice(create, rootCheck), /PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, rootParent, true, &helperThread/);
  assert.ok(create < rootCheck && rootCheck < resume);
  assert.match(source.slice(rootCheck, resume), /TerminateProcess\(helper.get\(\), ERROR_CANCELLED\)/);
  assert.match(source, /if \(rootExited && helperExited && emptyObserved\)/);
  assert.match(source, /PeekNamedPipe/);
});
