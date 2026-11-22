'use strict';

const guard = require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const {createHash, randomBytes} = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createInterface} = require('node:readline');
const test = require('node:test');

// Build with native/cue-read-lease/build.ps1 -FixtureOutputDirectory first.
// Run directly: node tests/native-helper-lifetime.test.js --cue-fixture <isolated exe>
const skip = guard.active || process.argv[2] !== '--cue-fixture'
  ? 'Requires an explicitly selected isolated CUE binary and direct invocation'
  : process.platform !== 'win32' || process.arch !== 'x64' ? 'Requires Windows x64 and NTFS' : false;
const options = {skip, timeout: 90000};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function identity(filename, directory = false) {
  const stat = await fs.stat(filename, {bigint: true});
  const volume = stat.dev.toString(16).padStart(8, '0');
  const index = stat.ino.toString(16).padStart(16, '0');
  return directory ? `${volume}:${index}` : `${volume}:${index}:${stat.size}`;
}

async function fixture(t) {
  assert.equal(process.argv.length, 4, 'Pass one isolated fixture executable');
  const evidence = await fs.realpath(path.resolve(__dirname, '../review-evidence/20261108-public-release/cue-read-lease'));
  const executable = await fs.realpath(process.argv[3]);
  const relative = path.relative(evidence, executable);
  assert.ok(relative && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  assert.equal(path.basename(executable), 'StillCueReadLease.exe');

  const root = await fs.mkdtemp(path.join(__dirname, '.tmp-cue-native-lifetime-'));
  const cue = path.join(root, 'album.cue'), audio = path.join(root, 'audio.wav');
  const renamed = path.join(root, 'renamed.wav');
  let child, exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    for (const file of [cue, audio, renamed]) await fs.rm(file, {force: true});
    await fs.rmdir(root);
  });

  const cueBytes = Buffer.from('FILE "audio.wav" WAVE\r\n  TRACK 01 AUDIO\r\n    INDEX 01 00:00:00\r\n');
  const audioBytes = Buffer.alloc(48);
  await fs.writeFile(cue, cueBytes);
  await fs.writeFile(audio, audioBytes);
  const nonce = randomBytes(32).toString('hex'), contentHash = sha256(cueBytes);
  const base64 = value => Buffer.from(value).toString('base64');
  const cueId = await identity(cue), audioId = await identity(audio);
  const tokens = [contentHash, 'utf-8', '1', '1', base64(root), await identity(root, true), base64(cue), cueId, base64(audio), audioId];
  const binding = sha256(tokens.join('\t'));
  child = spawn(executable, ['--stdio-read-lease-v1', '--parent-pid', String(process.pid)], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: t.signal
  });
  let spawnError, stderrBytes = 0;
  child.on('error', error => {spawnError = error;});
  child.stdin.on('error', () => {});
  child.stderr.on('data', bytes => {stderrBytes += bytes.length;});
  exited = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal, spawnError, stderrBytes})));
  const lines = createInterface({input: child.stdout, crlfDelay: Infinity})[Symbol.asyncIterator]();
  const read = async () => {
    const {value, done} = await lines.next();
    if (done) return null;
    return value.split('\t');
  };
  const send = fields => child.stdin.write(fields.join('\t') + '\n');
  send(['ACQUIRE1', nonce, binding, ...tokens]);
  const ready = await read();
  assert.deepEqual(ready?.slice(0, 5), ['READY1', nonce, binding, String(child.pid), String(process.pid)]);
  const metadata = ready.slice(10);
  assert.deepEqual(metadata.map(row => row.split(':').slice(0, 3).join(':')), [cueId, audioId]);
  assert.equal(ready[7], '2');
  assert.match(ready[8], /^[1-9]\d*$/u);
  assert.equal(ready[9], contentHash);

  async function check(sequence) {
    send(['CHECK1', nonce, sequence]);
    assert.deepEqual(await read(), ['CHECKED1', nonce, binding, String(sequence), contentHash, ...metadata], `CHECK sequence ${sequence}`);
  }
  async function expectExit(code) {
    assert.equal(await read(), null, 'Unexpected extra native output');
    assert.deepEqual(await exited, {code, signal: null, spawnError: undefined, stderrBytes: 0});
  }
  async function openForWrite(filename) {
    const handle = await fs.open(filename, 'r+');
    await handle.close();
  }
  async function assertHeld() {
    const denied = error => ['EBUSY', 'EACCES', 'EPERM'].includes(error.code);
    await assert.rejects(openForWrite(cue), denied);
    await assert.rejects(openForWrite(audio), denied);
    await assert.rejects(fs.rename(audio, renamed), denied);
    assert.deepEqual(await fs.readFile(audio), audioBytes);
  }
  async function assertReleased() {
    await openForWrite(cue);
    await openForWrite(audio);
    await fs.rename(audio, renamed);
    await fs.rename(renamed, audio);
    assert.deepEqual(await fs.readFile(cue), cueBytes);
    assert.deepEqual(await fs.readFile(audio), audioBytes);
  }
  return {nonce, binding, closedCount: Number(ready[7]) + Number(ready[8]), check, send, read, expectExit, assertHeld, assertReleased, end: () => child.stdin.end()};
}

test('native CUE holder retains sharing protection past 4096 CHECKs and closes cleanly', options, async t => {
  const lease = await fixture(t);
  await lease.assertHeld();
  const checks = 4200;
  for (let sequence = 1; sequence <= checks; sequence++) {
    await lease.check(sequence);
    if (sequence === 4095) {
      await lease.assertHeld();
      t.diagnostic('Sequence 4095 acknowledged with both file write opens and the audio rename blocked');
    }
  }
  await lease.assertHeld();
  const closeSequence = String(checks + 1);
  lease.send(['CLOSE1', lease.nonce, closeSequence]);
  assert.deepEqual(await lease.read(), ['CLOSED1', lease.nonce, lease.binding, closeSequence, String(lease.closedCount), '0']);
  await lease.expectExit(0);
  await lease.assertReleased();
  t.diagnostic(`All ${checks} CHECKs acknowledged, sharing still held at ${checks}, CLOSE ${closeSequence} released both files`);
});

for (const [name, error, finish] of [
  ['replayed sequence', 'PROTOCOL', lease => lease.send(['CHECK1', lease.nonce, '1'])],
  ['overlong line', 'PROTOCOL', lease => lease.send(['CHECK1', lease.nonce, '1'.repeat(250)])],
  ['pipe EOF', 'EOF', lease => lease.end()]
]) {
  test(`native CUE holder rejects ${name} and releases its files`, options, async t => {
    const lease = await fixture(t);
    await lease.check(1);
    await lease.assertHeld();
    finish(lease);
    assert.deepEqual(await lease.read(), ['ERROR1', lease.nonce, lease.binding, error]);
    await lease.expectExit(2);
    await lease.assertReleased();
  });
}

// The executable returns from its fixture branch before starting Windows Forms.
test('native Apple host reclaims expired and invalidated page RPCs without accepting stale replies', {
  skip: guard.active || process.argv[2] !== '--apple-fixture' ? 'Requires direct invocation with --apple-fixture' :
    process.platform !== 'win32' || process.arch !== 'x64' ? 'Requires Windows x64' : false,
  timeout: 15000
}, () => {
  assert.equal(process.argv.length, 3, 'The Apple fixture uses the working-tree executable');
  const executable = path.resolve(__dirname, '../native/apple-host/bin/StillAppleHost.exe');
  const result = spawnSync(executable, ['--protocol-self-test'], {encoding: 'utf8', windowsHide: true, timeout: 10000});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.fixtureOnly, true);
  assert.equal(value.rpcLifetimePassed, true);
  for (const name of [
    'coversNodeDeadline', 'navigationReclaimsCapacity', 'processFailureReclaimsCapacity', 'closeReclaimsCapacity',
    'timeoutReclaimsCapacity', 'hangingEvaluationExpires', 'duplicateIdKeepsOriginal', 'lateEvaluationAndReplyCannotRetireReplacement',
    'evaluationFailureRetiresOnlyItsRequests', 'readTimeoutPreservesAuthorizedPlayback', 'matchingReplyAtDeadlineFailsClosedBeforeReply',
    'autoplayDeadlineStartsBeforeUiDispatch', 'expiredGrantCannotAuthorizeMatchedStart', 'unexpiredGrantAuthorizesOnlyNextExactStart'
  ]) assert.equal(value.rpcLifetimeChecks[name], true, name);
});
