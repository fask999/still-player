'use strict';
// Explicit CLI only. Every helper invocation uses --self-test or --protocol-test.
// These branches never create a window or activate/register SMTC.
const assert = require('node:assert/strict');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {parseStrictJson, verifyNativeMediaRuntime, LIMITS} = require('../../src/main/media-controls-native');
const root = path.resolve(__dirname, '..', '..');
const generation = '0a'.repeat(16);
const sample = (sequence = 1) => ({schemaVersion: 1, sessionId: 'protocol-test-local', sequence, source: 'local', state: 'paused',
  metadata: {title: 'Protocol only · 静室', artist: 'Synthetic fixture', album: ''}, position: 5, duration: 100,
  capabilities: {play: true, pause: true, stop: true, next: false, previous: false, seek: true}});

function openHelper() {
  const runtime = verifyNativeMediaRuntime(root), child = spawn(runtime.executable, ['--protocol-test', '--parent-pid', String(process.pid), '--generation', generation],
    {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: runtime.directory});
  const messages = [], waits = []; let buffer = Buffer.alloc(0), id = 0, stderr = 0;
  child.stdin.on('error', () => {});
  child.stdout.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]); assert.ok(buffer.length < 65536);
    let newline; while ((newline = buffer.indexOf(10)) >= 0) {
      messages.push(parseStrictJson(buffer.subarray(0, newline))); buffer = buffer.subarray(newline + 1);
      for (const waiter of [...waits]) if (waiter.predicate(messages.at(-1))) {clearTimeout(waiter.timer); waits.splice(waits.indexOf(waiter), 1); waiter.resolve(messages.at(-1));}
    }
  });
  child.stderr.on('data', bytes => {stderr += bytes.length; assert.ok(stderr <= 16384);});
  const exited = new Promise((resolve, reject) => {child.once('error', reject); child.once('exit', (code, signal) => resolve({code, signal}));});
  function until(predicate, timeout = 3000) {
    const previous = messages.find(predicate); if (previous) return Promise.resolve(previous);
    return new Promise((resolve, reject) => {
      const waiter = {predicate, resolve, timer: null}; waiter.timer = setTimeout(() => {waits.splice(waits.indexOf(waiter), 1); reject(new Error('Protocol response deadline'));}, timeout); waits.push(waiter);
    });
  }
  async function exit(timeout = 3000) {
    let timer;
    try {return await Promise.race([exited, new Promise((_, reject) => {timer = setTimeout(() => {child.kill(); reject(new Error('Helper exit deadline'));}, timeout);})]);}
    finally {clearTimeout(timer);}
  }
  function send(type, extra = {}) {const message = {v: 1, type, id: ++id, generation, ...extra}; child.stdin.write(`${JSON.stringify(message)}\n`); return message;}
  async function hello() {const message = send('hello'); const response = await until(value => value.type === 'ready'); assert.equal(response.id, message.id); assert.equal(response.protocolTest, true); return response;}
  return {child, messages, until, exit, send, hello};
}

async function checkProtocol() {
  const runtime = verifyNativeMediaRuntime(root), checks = [];
  const self = spawnSync(runtime.executable, ['--self-test'], {windowsHide: true, encoding: 'utf8', timeout: 5000});
  assert.equal(self.status, 0); const selfReport = JSON.parse(self.stdout.trim()); assert.equal(selfReport.smtcRegistered, false); assert.equal(selfReport.windowCreated, false); checks.push('pure-self-test');
  {
    const h = openHelper(); await h.hello();
    let request = h.send('update', {snapshot: sample()}); const ack = await h.until(value => value.type === 'ack' && value.id === request.id); assert.equal(ack.sessionId, 'protocol-test-local'); assert.equal(ack.sequence, 1);
    request = h.send('ping'); assert.equal((await h.until(value => value.type === 'pong')).id, request.id);
    h.send('shutdown'); await h.until(value => value.type === 'bye'); assert.equal((await h.exit()).code, 0); checks.push('hello-update-ping-shutdown');
  }
  {
    const h = openHelper(); await h.hello(); const bytes = Buffer.alloc(LIMITS.artworkBytes); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.write('IHDR', 12); bytes.writeUInt32BE(1, 16); bytes.writeUInt32BE(1, 20);
    const snapshot = sample(); snapshot.metadata.artwork = {mimeType: 'image/png', dataBase64: bytes.toString('base64')}; h.send('update', {snapshot}); await h.until(value => value.type === 'ack'); h.child.stdin.end(); assert.equal((await h.exit()).code, 0); checks.push('maximum-artwork-byte-envelope-no-decoder');
  }
  const invalid = [
    ['duplicate-json-key', h => h.child.stdin.write(`{"v":1,"v":1,"type":"ping","id":2,"generation":"${generation}"}\n`)],
    ['wrong-generation', h => h.send('ping', {generation: 'ff'.repeat(16)})],
    ['unavailable-cannot-own-capabilities', h => h.send('update', {snapshot: {...sample(), state: 'unavailable'}})],
    ['invalid-timeline', h => h.send('update', {snapshot: {...sample(), position: 101}})],
    ['untrusted-artwork-path', h => {const snapshot = sample(); snapshot.metadata.artwork = {path: 'C:\\never-read.png'}; h.send('update', {snapshot});}],
    ['unknown-request-field', h => h.send('ping', {url: 'https://example.invalid'})],
    ['invalid-utf8', h => h.child.stdin.write(Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125, 10]))],
    ['bounded-input-line', h => h.child.stdin.write(Buffer.alloc(LIMITS.snapshotBytes + 1, 32))],
    ['bounded-input-rate', h => {for (let i = 0; i < 45; i++) h.send('ping');}]
  ];
  for (const [name, invoke] of invalid) {
    const h = openHelper(); await h.hello(); invoke(h); await h.until(value => value.type === 'error'); assert.equal((await h.exit()).code, 2); checks.push(name);
  }
  {
    const h = openHelper(); await h.hello(); h.send('update', {snapshot: sample()}); await h.until(value => value.type === 'ack'); h.send('update', {snapshot: sample()}); await h.until(value => value.type === 'error'); assert.equal((await h.exit()).code, 2); checks.push('monotonic-snapshot-sequence');
  }
  {
    const h = openHelper(); await h.hello(); h.child.stdin.end(); assert.equal((await h.exit()).code, 0); checks.push('stdin-eof-cleanup');
  }
  {
    const h = openHelper(); h.child.stdin.write('{"v":1'); h.child.stdin.end(); assert.equal((await h.exit()).code, 2); checks.push('truncated-input-cleanup');
  }
  {
    const h = openHelper(); assert.equal((await h.exit(6500)).code, 2); checks.push('initial-handshake-timeout');
  }
  {
    const h = openHelper(); await h.hello(); assert.equal((await h.exit(16500)).code, 2); checks.push('idle-parent-heartbeat-timeout');
  }
  {
    // The owned short-lived parent exits with its helper pipe open. The helper
    // must release the inherited stdout pipe too; otherwise close never fires.
    // Windows can deliver stdin EOF alongside parent death in this scenario.
    const parent = spawn(process.execPath, [__filename, '--parent-fixture'], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', timer, helperPid = null;
    parent.stdout.on('data', bytes => {output += bytes.toString('utf8'); assert.ok(output.length < 8192); const first = output.split('\n')[0]; try {helperPid = JSON.parse(first).helperPid;} catch { /* A partial first line is expected. */ }});
    parent.stderr.resume();
    try {
      const code = await new Promise((resolve, reject) => {
        timer = setTimeout(() => {parent.kill(); if (Number.isSafeInteger(helperPid)) {try {process.kill(helperPid);} catch {}} reject(new Error('Parent-exit helper cleanup deadline'));}, 4000);
        parent.once('error', reject); parent.once('close', resolve);
      });
      assert.equal(code, 0); const lines = output.trim().split('\n').map(line => JSON.parse(line));
      assert.ok(Number.isSafeInteger(lines[0].helperPid)); assert.ok(lines.some(value => value.type === 'ready' && value.protocolTest === true)); checks.push('owned-parent-exit-with-inherited-pipe-cleanup');
    } finally {clearTimeout(timer);}
  }
  return {status: 'passed', checks, helperInvocations: checks.length, smtcRegistered: false, windowCreated: false, audioOpened: false};
}

if (require.main === module) {
  if (process.argv[2] === '--parent-fixture') {
    const runtime = verifyNativeMediaRuntime(root), child = spawn(runtime.executable, ['--protocol-test', '--parent-pid', String(process.pid), '--generation', generation], {windowsHide: true, stdio: ['pipe', 'inherit', 'inherit']});
    process.stdout.write(`${JSON.stringify({helperPid: child.pid})}\n`); child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify({v: 1, type: 'hello', id: 1, generation})}\n`); child.unref(); setTimeout(() => process.exit(0), 350);
  } else checkProtocol().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`), () => {process.stderr.write('Desktop media protocol check failed; no SMTC registration was requested.\n'); process.exitCode = 1;});
}
module.exports = {checkProtocol};
