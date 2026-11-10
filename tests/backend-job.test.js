'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
// Protocol streams and source contracts only. No executable, socket or device.
const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const {bindBackendJobProcess, isOwnedCreationWitness, isBackendJobTreeExit, parseNativeFailureDiagnostic} = require('../src/main/backend-job');
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

const diagnostic = (overrides = {}) => ({schemaVersion: 1, phase: 'child-create', checkLine: 191, domain: 'win32', status: 5, ...overrides});
for (const withCreated of [false, true]) test(`typed native failure remains diagnostic with creation witness=${withCreated}`, async () => {
  const f = fixture(), dto = diagnostic();
  if (withCreated) f.send(f.created());
  f.send(f.row('failure', {code: 'STILL_BACKEND_JOB_LAUNCH_FAILED', nativeFailure: dto}));
  await assert.rejects(f.child.ready, error => {
    assert.deepEqual(error.nativeFailure, dto); assert.equal(Object.isFrozen(error.nativeFailure), true);
    assert.equal(error.created, withCreated); assert.equal(error.abnormalStartupExitRequired, withCreated);
    assert.equal(error.code, withCreated ? 'STILL_BACKEND_STARTUP_UNCERTAIN' : 'STILL_BACKEND_JOB_LAUNCH_FAILED'); return true;
  });
  assert.equal(f.child.exitCode, null); assert.equal(f.child.treeExitEvidence, null);
  assert.equal(isBackendJobTreeExit(dto, f.child), false); assert.equal(isOwnedCreationWitness(dto, f.child), false);
  assert.equal(f.commands.length, withCreated ? 1 : 0);
  assert.throws(() => f.child.requestExit(), {code: 'STILL_BACKEND_STARTUP_UNCERTAIN'});
});

test('legacy failure frames retain compatibility and absence never claims an uncreated process', async () => {
  const f = fixture(); f.send(f.row('failure', {code: 'STILL_BACKEND_JOB_LAUNCH_FAILED'}));
  await assert.rejects(f.child.ready, error => error.code === 'STILL_BACKEND_JOB_LAUNCH_FAILED' && !Object.hasOwn(error, 'nativeFailure'));
  assert.equal(f.child.creationWitness, null); assert.equal(f.child.treeExitEvidence, null);
});
test('malformed diagnostic after a creation witness preserves abnormal startup retention instead of erasing the brand', async () => {
  const f = fixture(); f.send(f.created());
  f.send(f.row('failure', {code: 'STILL_BACKEND_JOB_LAUNCH_FAILED', nativeFailure: diagnostic({created: false, treeEmpty: true})}));
  await assert.rejects(f.child.ready, {code: 'STILL_BACKEND_STARTUP_UNCERTAIN', created: true, abnormalStartupExitRequired: true});
  assert.equal(isOwnedCreationWitness(f.child.creationWitness, f.child), true);
  assert.equal(f.child.exitCode, null); assert.equal(f.child.treeExitEvidence, null); assert.equal(f.commands.length, 1);
  assert.equal(Object.hasOwn(f.errors[0], 'nativeFailure'), false);
});

const invalidDiagnostics = [null, [], {}, diagnostic({schemaVersion: 2}), diagnostic({phase: 'SECRET_PATH'}),
  diagnostic({checkLine: -1}), diagnostic({checkLine: 100001}), diagnostic({checkLine: 1.5}), diagnostic({checkLine: 0}),
  diagnostic({domain: 'hresult'}), diagnostic({status: -1}), diagnostic({status: 0x100000000}), diagnostic({status: '5'}),
  diagnostic({domain: 'validation', status: 5}), diagnostic({domain: 'ntstatus', status: 0}), diagnostic({path: 'SECRET_PATH'})];
for (const [index, value] of invalidDiagnostics.entries()) test(`malformed native diagnostic ${index} fails closed without process or exit brands`, async () => {
  const f = fixture(); f.send(f.row('failure', {code: 'STILL_BACKEND_JOB_LAUNCH_FAILED', nativeFailure: value}));
  await assert.rejects(f.child.ready, {code: 'STILL_BACKEND_JOB_PROTOCOL_INVALID'});
  assert.equal(f.child.creationWitness, null); assert.equal(f.child.exitCode, null); assert.equal(f.child.treeExitEvidence, null);
  assert.equal(JSON.stringify(f.errors).includes('SECRET_PATH'), false); assert.equal(f.commands.length, 0);
});

test('native diagnostic parser copies only closed data descriptors and does not evaluate accessors', () => {
  let reads = 0; const value = diagnostic();
  Object.defineProperty(value, 'status', {get() {reads++; throw new Error('SECRET_GETTER');}});
  assert.throws(() => parseNativeFailureDiagnostic(value), /Invalid native failure diagnostic/); assert.equal(reads, 0);
  assert.throws(() => parseNativeFailureDiagnostic({...diagnostic(), [Symbol('secret')]: 1}));
  const source = diagnostic(), copy = parseNativeFailureDiagnostic(source); source.status = 999;
  assert.equal(copy.status, 5); assert.equal(Object.isFrozen(copy), true);
  for (const row of [diagnostic({domain: 'ntstatus', status: 0xc000000d}), diagnostic({domain: 'validation', checkLine: 0, status: null}),
    diagnostic({status: 0}), diagnostic({status: 0xffffffff})]) assert.deepEqual(parseNativeFailureDiagnostic(row), row);
});

test('native failure after READY cannot change child or tree exit evidence', async () => {
  const f = fixture(); f.send(f.created()); f.send(f.ready()); await f.child.ready;
  f.send(f.row('failure', {code: 'STILL_BACKEND_JOB_LAUNCH_FAILED', nativeFailure: diagnostic({phase: 'child-observe'})}));
  assert.equal(f.errors[0].nativeFailure.phase, 'child-observe');
  assert.equal(f.child.exitCode, null); assert.equal(f.child.treeExitEvidence, null);
  assert.throws(() => f.child.requestExit(), {code: 'STILL_BACKEND_JOB_LAUNCH_FAILED'});
});

test('native diagnostics use immediate Win32 and returned NTSTATUS with the exact JS finite phase vocabulary', async () => {
  const source = await fs.readFile(path.join(__dirname, '../native/backend-job/launcher.cpp'), 'utf8');
  const phases = [...source.slice(source.indexOf('const char* phaseName'), source.indexOf('struct DiagnosticFailure')).matchAll(/return "([a-z-]+)"/g)].map(row => row[1]);
  for (const phase of new Set(phases)) assert.equal(parseNativeFailureDiagnostic(diagnostic({phase})).phase, phase);
  assert.match(source, /#define requireWin32\(ok\)[^\n]*GetLastError\(\)[^\n]*"win32"/);
  assert.match(source, /#define requireNtstatus\(call\)[^\n]*NTSTATUS[^\n]*\(call\)[^\n]*"ntstatus"/);
  assert.doesNotMatch(source, /require\(BCrypt/); assert.doesNotMatch(source, /failure\.what\(/);
  assert.match(source, /resumeResult = ResumeThread[^\n]*\n\s*const DWORD resumeError = resumeResult == DWORD\(-1\) \? GetLastError\(\)/);
  const nativeFields = source.slice(source.indexOf('std::string diagnosticFields'), source.indexOf('std::string hashFile'));
  assert.doesNotMatch(nativeFields, /(?:nonce|path|what\(\)|backendId|executable)/i);
});
