'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const childProcess = require('node:child_process');
const backendJob = require('../src/main/backend-job');
const {createCueReader} = require('../src/main/cue-import');
const {createCueReadLease, isVerifiedCueReadLease} = require('../src/main/cue-read-lease');

const WINDOWS = process.platform === 'win32' && process.arch === 'x64';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pause = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {for (let i = 0; i < 400; i++) {if (check()) return; await new Promise(resolve => setTimeout(resolve, 5));} assert.fail('Synthetic holder did not reach the expected state.');}
const nativeOptions = {skip: !WINDOWS};

function fakeHolder(options = {}) {
  const raw = new EventEmitter(); raw.pid = 770001; raw.exitCode = null; raw.signalCode = null;
  raw.stdout = new PassThrough(); raw.stderr = new PassThrough(); raw.stdin = new PassThrough();
  raw.messages = []; raw.closeCommands = 0; raw.checkCommands = 0; raw.request = null;
  raw.finish = (code = 0, signal = null) => {if (raw.exitCode !== null || raw.signalCode !== null) return; raw.exitCode = code; raw.signalCode = signal; raw.emit('exit', code, signal); raw.stdout.end(); raw.stderr.end(); raw.emit('close', code, signal);};
  raw.reply = line => raw.stdout.write(Buffer.from(line + '\r\n', 'ascii'));
  raw.ready = () => {
    const r = raw.request; if (!r || r.sentReady) return; r.sentReady = true;
    raw.reply(['READY1', r.nonce, r.binding, raw.pid, process.pid, '0000000000000001', '0000000000000002', r.identities.length, 3, r.hash, ...r.identities].join('\t'));
  };
  let buffer = '';
  raw.stdin.on('data', bytes => {
    buffer += bytes.toString('ascii'); let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); const parts = line.split('\t'); raw.messages.push(parts);
      if (parts[0] === 'ACQUIRE1') {
        const references = Number(parts[6]), identities = [];
        for (let i = 0; i <= references; i++) identities.push(parts[10 + i * 2] + ':0000000000000001:0000000000000002:00000020:1');
        raw.request = {nonce: parts[1], binding: parts[2], hash: parts[3], identities, sentReady: false};
        options.onAcquire?.(raw); if (!options.manualReady) queueMicrotask(() => raw.ready());
      } else if (parts[0] === 'CHECK1') {
        raw.checkCommands++; raw.lastCheckSequence = parts[2];
        if (!options.manualCheck) queueMicrotask(() => raw.reply(['CHECKED1', raw.request.nonce, raw.request.binding, parts[2], raw.request.hash, ...raw.request.identities].join('\t')));
      } else if (parts[0] === 'CLOSE1') {
        raw.closeCommands++; options.beforeClose?.();
        queueMicrotask(() => {
          raw.ready();
          if (options.checkBeforeClose && raw.lastCheckSequence) raw.reply(['CHECKED1', raw.request.nonce, raw.request.binding, raw.lastCheckSequence, raw.request.hash, ...raw.request.identities].join('\t'));
          if (!options.omitClosed) raw.reply(['CLOSED1', raw.request.nonce, raw.request.binding, parts[2], raw.request.identities.length + 3, '0'].join('\t'));
          if (options.trailingOutput) raw.stdout.write(Buffer.from(options.trailingOutput));
          options.afterClosed?.(raw, parts[2]);
          if (!options.manualExit) raw.finish(options.closeCode || 0);
        });
      }
    }
  });
  return raw;
}
async function fixture(t, options = {}) {
  const parent = path.resolve(__dirname), root = path.join(parent, '.tmp-cue-read-lease-' + crypto.randomUUID());
  const runtimeRoot = path.join(root, 'app'), directory = path.join(runtimeRoot, 'native/cue-read-lease/bin'), media = path.join(root, 'media');
  await fs.mkdir(directory, {recursive: true}); await fs.mkdir(media);
  const exe = Buffer.alloc(256); exe.write('MZ'); exe.writeUInt32LE(128, 0x3c); exe.writeUInt32LE(0x4550, 128); exe.writeUInt16LE(0x8664, 132); exe.writeUInt16LE(0x20b, 152);
  const notice = Buffer.from('Synthetic test holder; never executed.');
  await fs.writeFile(path.join(directory, 'StillCueReadLease.exe'), exe); await fs.writeFile(path.join(directory, 'NOTICE.txt'), notice);
  const manifest = {schemaVersion: 1, kind: 'still-cue-read-lease', architecture: 'x64', files: [
    {path: 'StillCueReadLease.exe', bytes: exe.length, sha256: hash(exe)}, {path: 'NOTICE.txt', bytes: notice.length, sha256: hash(notice)}]};
  const writeManifest = () => fs.writeFile(path.join(directory, 'runtime-manifest.json'), JSON.stringify(manifest)); await writeManifest();
  const manifestBytes = await fs.readFile(path.join(directory, 'runtime-manifest.json')), pin = hash(manifestBytes);
  const cue = path.join(media, 'album.cue'), audio = path.join(media, 'audio.wav');
  await fs.writeFile(cue, 'FILE "audio.wav" WAVE\r\n TRACK 01 AUDIO\r\n INDEX 01 00:00:00\r\n'); await fs.writeFile(audio, Buffer.alloc(48));
  if (options.multiReferences) {
    await fs.writeFile(path.join(media, 'second.wav'), Buffer.alloc(48));
    await fs.appendFile(cue, 'FILE "second.wav" WAVE\r\n TRACK 02 AUDIO\r\n INDEX 01 00:00:00\r\n');
  }
  const request = (await createCueReader()(cue, {authorizationRoot: media})).request;
  const children = [], calls = []; let registryReads = 0;
  const originalReader = Object.getOwnPropertyDescriptor(backendJob, 'readCueReadLeaseRuntimeAssets');
  Object.defineProperty(backendJob, 'readCueReadLeaseRuntimeAssets', {configurable: true, writable: true, value: async selected => {
    registryReads++; assert.equal(selected, runtimeRoot);
    if (options.registryError) throw new Error('SYNTHETIC PRIVATE REGISTRY ERROR');
    return {root: runtimeRoot, cueReadLeaseManifest: {relativePath: 'native/cue-read-lease/bin/runtime-manifest.json', sha256: options.pin ?? pin, bytes: manifestBytes}};
  }});
  t.mock.method(childProcess, 'spawn', (...args) => {calls.push(args); const raw = fakeHolder(options); children.push(raw); return raw;});
  t.after(async () => {
    for (const raw of children) if (raw.exitCode === null) raw.finish(2);
    if (originalReader) Object.defineProperty(backendJob, 'readCueReadLeaseRuntimeAssets', originalReader); else delete backendJob.readCueReadLeaseRuntimeAssets;
    assert.equal(path.dirname(root), parent); assert.match(path.basename(root), /^\.tmp-cue-read-lease-/u);
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, runtimeRoot, directory, media, cue, audio, request, children, calls, manifest, writeManifest, pin,
    acquire: input => createCueReadLease({runtimeRoot, request, ...input}), get registryReads() {return registryReads;}};
}

test('the production API exports no constructor, dependency injection or JSON brand restoration', () => {
  assert.deepEqual(Object.keys(require('../src/main/cue-read-lease')).sort(), ['createCueReadLease', 'isVerifiedCueReadLease']);
  assert.equal(isVerifiedCueReadLease({check() {}, close() {}}, {request: {}}), false);
  assert.equal(isVerifiedCueReadLease(JSON.parse('{"verified":true}'), {request: {}}), false);
});

test('malformed and accessor request/options are rejected without reading or spawning', async t => {
  let effects = 0; t.mock.method(childProcess, 'spawn', () => {effects++; throw new Error('unexpected spawn');});
  t.mock.method(fs, 'lstat', async () => {effects++; throw new Error('unexpected read');});
  const valid = {path: 'D:\\authorized\\album.cue', authorizationRoot: 'D:\\authorized', references: ['D:\\authorized\\audio.wav'], trackCount: 1, encoding: 'utf-8', contentHash: 'a'.repeat(64)};
  for (const change of [{...valid, path: 'D:\\authorized\\..\\outside.cue'}, {...valid, references: new Array(1)}, {...valid, trackCount: 0}, {...valid, references: Array(33).fill(valid.references[0])}, {...valid, extra: true},
    {...valid, authorizationRoot: 'D:\\authorized\\\u0130', path: 'D:\\authorized\\i\u0307\\album.cue', references: ['D:\\authorized\\i\u0307\\audio.wav']}]) {
    await assert.rejects(createCueReadLease({runtimeRoot: path.resolve('unused-app'), request: change}), {code: 'ERR_CUE_READ_LEASE_REQUEST'});
  }
  let getter = 0; const bad = {...valid}; Object.defineProperty(bad, 'references', {get() {getter++; return valid.references;}});
  await assert.rejects(createCueReadLease({runtimeRoot: path.resolve('unused-app'), request: bad}), {code: 'ERR_CUE_READ_LEASE_REQUEST'});
  await assert.rejects(createCueReadLease({runtimeRoot: path.resolve('unused-app'), request: valid, spawnProcess() {}}), {code: 'ERR_CUE_READ_LEASE_REQUEST'});
  await assert.rejects(createCueReadLease({runtimeRoot: path.resolve('unused-app'), request: valid, onLost: 0}), {code: 'ERR_CUE_READ_LEASE_REQUEST'});
  assert.equal(effects, 0); assert.equal(getter, 0);
});

test('independent source pin, closed inventory and exact executable integrity precede spawn', nativeOptions, async t => {
  const f = await fixture(t); const changed = Buffer.alloc(256); changed.write('MZ');
  await fs.writeFile(path.join(f.directory, 'StillCueReadLease.exe'), changed);
  f.manifest.files[0].sha256 = hash(changed); await f.writeManifest();
  await assert.rejects(f.acquire(), {code: 'ERR_CUE_READ_LEASE_RUNTIME'}); assert.equal(f.calls.length, 0);
});
test('an absent trusted pin fails closed without helper execution', nativeOptions, async t => {
  const f = await fixture(t, {pin: ''}); await assert.rejects(f.acquire(), {code: 'ERR_CUE_READ_LEASE_RUNTIME'}); assert.equal(f.calls.length, 0);
});
test('extra files are rejected even with a valid trusted manifest pin', nativeOptions, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'injected.dll'), 'SYNTHETIC'); await assert.rejects(f.acquire(), {code: 'ERR_CUE_READ_LEASE_RUNTIME'}); assert.equal(f.calls.length, 0);
});
test('runtime hardlinks are refused before spawn', nativeOptions, async t => {
  const f = await fixture(t); await fs.link(path.join(f.directory, 'StillCueReadLease.exe'), path.join(f.root, 'runtime-alias.exe'));
  await assert.rejects(f.acquire(), {code: 'ERR_CUE_READ_LEASE_RUNTIME'}); assert.equal(f.calls.length, 0);
});
test('a manifest pin mismatch is rejected before its untrusted JSON is parsed', nativeOptions, async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.directory, 'runtime-manifest.json'), '{UNTRUSTED INVALID JSON');
  let parsed = 0; t.mock.method(JSON, 'parse', () => {parsed++; throw new Error('untrusted parse');});
  await assert.rejects(f.acquire(), {code: 'ERR_CUE_READ_LEASE_RUNTIME'}); assert.equal(parsed, 0); assert.equal(f.calls.length, 0);
});
test('request references are reparsed while locked before any verified consumer is admitted', nativeOptions, async t => {
  const f = await fixture(t), other = path.join(f.media, 'other.wav'); await fs.writeFile(other, Buffer.alloc(48));
  await assert.rejects(createCueReadLease({runtimeRoot: f.runtimeRoot, request: {...f.request, references: [other]}}), {code: 'ERR_CUE_READ_LEASE_REQUEST'});
  assert.equal(f.calls.length, 1); assert.equal(f.children[0].closeCommands, 1); assert.equal(f.children[0].exitCode, 0);
});
test('distinct NTFS references merged by Unicode lowercasing cannot leave an unlocked FILE reference', nativeOptions, async t => {
  const f = await fixture(t), names = ['\u0130.wav', 'i\u0307.wav'];
  assert.equal(names[0].toLowerCase(), names[1].toLowerCase());
  for (const name of names) await fs.writeFile(path.join(f.media, name), Buffer.alloc(48));
  const first = await fs.stat(path.join(f.media, names[0]), {bigint: true}), second = await fs.stat(path.join(f.media, names[1]), {bigint: true});
  assert.notEqual(first.ino, second.ino);
  await fs.writeFile(f.cue, `FILE "${names[0]}" WAVE\r\n TRACK 01 AUDIO\r\n INDEX 01 00:00:00\r\nFILE "${names[1]}" WAVE\r\n TRACK 02 AUDIO\r\n INDEX 01 00:00:00\r\n`);
  const full = (await createCueReader()(f.cue, {authorizationRoot: f.media})).request;
  const incomplete = {...full, references: [path.join(f.media, names[0])]};
  await assert.rejects(createCueReadLease({runtimeRoot: f.runtimeRoot, request: incomplete}), {code: 'ERR_CUE_READ_LEASE_REQUEST'});
  assert.equal(f.children[0].closeCommands, 1); assert.equal(f.children[0].exitCode, 0);
});

test('verified lease binds full request and private child generation, checks live identities, and waits for actual closure', nativeOptions, async t => {
  const f = await fixture(t, {manualExit: true}), lease = await f.acquire();
  assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), true);
  assert.equal(isVerifiedCueReadLease({...lease}, {request: f.request}), false);
  assert.equal(isVerifiedCueReadLease(JSON.parse(JSON.stringify(lease)), {request: f.request}), false);
  for (const change of [{...f.request, trackCount: 2}, {...f.request, encoding: 'gb18030'}, {...f.request, contentHash: 'b'.repeat(64)}, {...f.request, path: f.request.path.toUpperCase()}]) assert.equal(isVerifiedCueReadLease(lease, {request: change}), false);
  await Promise.all([lease.check(), lease.check()]); assert.equal(f.children[0].checkCommands, 1);
  const [exe, args, spawn] = f.calls[0]; assert.equal(exe, path.join(f.directory, 'StillCueReadLease.exe')); assert.deepEqual(args, ['--stdio-read-lease-v1', '--parent-pid', String(process.pid)]);
  assert.equal(spawn.windowsHide, true); assert.equal(spawn.detached, false); assert.equal(spawn.shell, false); assert.deepEqual(spawn.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(Object.keys(spawn.env).sort(), ['SystemRoot', 'WINDIR']);
  let closed = false; const closing = lease.close().then(() => {closed = true;}); await until(() => f.children[0].closeCommands === 1); await pause();
  assert.equal(closed, false); assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), false);
  f.children[0].finish(); await closing; await lease.close(); assert.equal(closed, true); assert.equal(f.children[0].closeCommands, 1);
});
test('an acquired cancellation invalidates and notifies without releasing before explicit tree-exit close', nativeOptions, async t => {
  let treeExited = false, lost = 0; const controller = new AbortController();
  const f = await fixture(t, {beforeClose: () => assert.equal(treeExited, true)}), lease = await f.acquire({signal: controller.signal, onLost: () => {lost++;}});
  controller.abort(); await pause(); assert.equal(lost, 1); assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), false);
  assert.equal(f.children[0].closeCommands, 0); assert.equal(f.children[0].exitCode, null);
  await assert.rejects(lease.check(), {code: 'ERR_CUE_READ_LEASE_CANCELLED'});
  treeExited = true; await lease.close(); assert.equal(f.children[0].closeCommands, 1);
});
test('the brand binds ordered references and cannot be reused for a reordered import', nativeOptions, async t => {
  const f = await fixture(t, {multiReferences: true}), lease = await f.acquire();
  assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), true);
  assert.equal(isVerifiedCueReadLease(lease, {request: {...f.request, references: [...f.request.references].reverse()}}), false);
  await lease.close();
});
test('acquisition cancellation closes the pending holder physically before rejecting', nativeOptions, async t => {
  const f = await fixture(t, {manualReady: true}), controller = new AbortController(), acquiring = f.acquire({signal: controller.signal});
  await until(() => f.children[0]?.request); controller.abort();
  await assert.rejects(acquiring, error => error.code === 'ERR_CUE_READ_LEASE_CANCELLED' && error.cleanupPending === false);
  assert.equal(f.children[0].closeCommands, 1); assert.equal(f.children[0].exitCode, 0);
});
test('an acquisition close timeout retains its exact controller and never fabricates physical cleanup', nativeOptions, async t => {
  let entered; const enteredPromise = new Promise(resolve => {entered = resolve;});
  const f = await fixture(t, {manualReady: true, omitClosed: true, manualExit: true, onAcquire: entered}), controller = new AbortController();
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date']});
  const acquiring = f.acquire({signal: controller.signal}); await enteredPromise; controller.abort(); await pause();
  assert.equal(f.children[0].closeCommands, 1); t.mock.timers.tick(5000); let retainedError;
  await assert.rejects(acquiring, error => {retainedError = error; return error.code === 'ERR_CUE_READ_LEASE_CANCELLED' && error.cleanupPending === true && typeof error.retainedController?.close === 'function';});
  assert.equal(f.children[0].exitCode, null); const waiting = retainedError.retainedController.close();
  const raw = f.children[0], sequence = raw.messages.find(parts => parts[0] === 'CLOSE1')[2];
  raw.reply(['CLOSED1', raw.request.nonce, raw.request.binding, sequence, raw.request.identities.length + 3, '0'].join('\t')); raw.finish();
  await waiting; assert.equal(raw.closeCommands, 1); assert.equal(raw.exitCode, 0);
});
test('source/runtime drift and unexpected holder exit permanently revoke the brand', nativeOptions, async t => {
  let lost = 0; const f = await fixture(t), lease = await f.acquire({onLost: () => {lost++;}});
  await fs.writeFile(path.join(f.directory, 'NOTICE.txt'), 'changed synthetic runtime');
  await assert.rejects(lease.check(), {code: 'ERR_CUE_READ_LEASE_LOST'}); assert.equal(lost, 1); assert.equal(f.children[0].checkCommands, 0);
  assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), false); await lease.close();
});
for (const observer of ['throw', 'reject']) test(`holder-loss observer ${observer} cannot skip owner cleanup`, nativeOptions, async t => {
  let calls = 0; const f = await fixture(t), lease = await f.acquire({onLost: () => {calls++; if (observer === 'throw') throw new Error('SYNTHETIC OBSERVER'); return Promise.reject(new Error('SYNTHETIC OBSERVER'));}});
  f.children[0].finish(2); await pause(); assert.equal(calls, 1); assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), false);
  await assert.rejects(lease.close(), {code: 'ERR_CUE_READ_LEASE_CLOSE_UNVERIFIED'});
});
test('an unexpected exit0 without explicit CLOSE/CLOSED is still loss and never successful closure', nativeOptions, async t => {
  let lost = 0; const f = await fixture(t), lease = await f.acquire({onLost: () => {lost++;}});
  f.children[0].finish(0); await pause(); assert.equal(lost, 1); assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), false);
  await assert.rejects(lease.close(), {code: 'ERR_CUE_READ_LEASE_CLOSE_UNVERIFIED'});
});
test('malformed metadata or private stderr never enters an error and cannot restore a revoked brand', nativeOptions, async t => {
  const errors = [], f = await fixture(t), lease = await f.acquire({onLost: error => errors.push(error)}), raw = f.children[0];
  raw.reply('UNKNOWN1\tSYNTHETIC-PRIVATE-PATH'); raw.stderr.write(Buffer.alloc(10000, 65));
  await pause(); assert.equal(errors.length, 1); assert.ok(!errors[0].message.includes('SYNTHETIC'));
  assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), false); await lease.close(); assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), false);
});
for (const [name, options] of [['missing CLOSED', {omitClosed: true}], ['nonzero exit', {closeCode: 2}], ['truncated trailing output', {trailingOutput: 'UNTERMINATED'}]]) {
  test(`close refuses ${name} despite a child close event`, nativeOptions, async t => {
    const f = await fixture(t, options), lease = await f.acquire(); await assert.rejects(lease.close(), {code: 'ERR_CUE_READ_LEASE_CLOSE_UNVERIFIED'});
    assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), false);
  });
}
test('an in-flight CHECKED before CLOSED is drained without turning intentional close into loss', nativeOptions, async t => {
  let lost = 0; const f = await fixture(t, {manualCheck: true, checkBeforeClose: true}), lease = await f.acquire({onLost: () => {lost++;}});
  const checking = lease.check(); checking.catch(() => {}); await until(() => f.children[0].checkCommands === 1);
  const closing = lease.close(); await assert.rejects(checking); await closing; assert.equal(lost, 0);
});
for (const [name, afterClosed] of [
  ['complete unknown frame', raw => raw.reply('GARBAGE1\tSYNTHETIC-PRIVATE')],
  ['duplicate CLOSED', (raw, sequence) => raw.reply(['CLOSED1', raw.request.nonce, raw.request.binding, sequence, raw.request.identities.length + 3, '0'].join('\t'))],
  ['wrong nonce', (raw, sequence) => raw.reply(['CLOSED1', 'f'.repeat(64), raw.request.binding, sequence, raw.request.identities.length + 3, '0'].join('\t'))],
  ['output overflow', raw => raw.stdout.write(Buffer.alloc(65537, 65))],
  ['stderr bytes', raw => raw.stderr.write(Buffer.from('SYNTHETIC-PRIVATE'))],
  ['stdout error', raw => raw.stdout.emit('error', new Error('SYNTHETIC-PRIVATE'))],
  ['stderr error', raw => raw.stderr.emit('error', new Error('SYNTHETIC-PRIVATE'))],
  ['stdin error', raw => raw.stdin.emit('error', new Error('SYNTHETIC-PRIVATE'))]
]) test(`a close-phase ${name} is sticky after valid CLOSED and actual exit0`, nativeOptions, async t => {
  const f = await fixture(t, {afterClosed}), lease = await f.acquire();
  await assert.rejects(lease.close(), error => error.code === 'ERR_CUE_READ_LEASE_CLOSE_UNVERIFIED' && error.cleanupPending === false && !error.message.includes('SYNTHETIC'));
  assert.equal(f.children[0].exitCode, 0); assert.equal(isVerifiedCueReadLease(lease, {request: f.request}), false);
});
