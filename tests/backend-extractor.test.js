'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {createHash} = require('node:crypto');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {captureExtractorEntry, assertExtractorNamespace} = require('../src/main/backend-bootstrap');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const flush = () => new Promise(resolve => setImmediate(resolve));
const bytes = Buffer.from('SYNTHETIC APPROVED CORE MEMBER');
function fixture({signal, timeoutMs = 1000, member = 'components/foo_input_std.dll'} = {}) {
  const child = new EventEmitter(); Object.assign(child, {stdout: new PassThrough(), stderr: new PassThrough(), pid: 12345});
  let kills = 0, calls = 0, invocation;
  child.kill = () => {kills++; return true;};
  const result = () => captureExtractorEntry({executable: 'C:\\Fixture\\7z.exe', archivePath: 'C:\\Fixture\\original.exe',
    cwd: 'C:\\Fixture', member, expectedBytes: bytes.length, expectedSha256: hash(bytes), signal}, {
    timeoutMs, spawnProcess: (executable, args, options) => {calls++; invocation = {executable, args, options}; return child;}});
  return {child, result, kills: () => kills, calls: () => calls, invocation: () => invocation};
}
test('exact fixed member stdout resolves only after a successful physical close and uses no shell or extraction destination', async () => {
  const f = fixture(), reading = f.result(); let settled = false; reading.finally(() => {settled = true;});
  f.child.stdout.write(bytes); await flush(); assert.equal(settled, false);
  f.child.emit('close', 0, null); assert.equal((await reading).equals(bytes), true);
  assert.deepEqual(f.invocation().args, ['x', '-so', '-spd', '--', 'C:\\Fixture\\original.exe', 'components/foo_input_std.dll']);
  assert.equal(f.invocation().options.shell, false); assert.equal(f.invocation().options.windowsHide, true);
  assert.equal(f.kills(), 0);
});
for (const mode of ['oversize', 'wrong-hash', 'nonzero-exit', 'stderr-overflow', 'stdout-error']) test(`unapproved extractor output fails closed: ${mode}`, async () => {
  const f = fixture(), reading = f.result(), failed = reading.catch(error => error);
  if (mode === 'oversize') f.child.stdout.write(Buffer.alloc(bytes.length + 1));
  else if (mode === 'wrong-hash') f.child.stdout.write(Buffer.alloc(bytes.length));
  else if (mode === 'stderr-overflow') f.child.stderr.write(Buffer.alloc(65537));
  else if (mode === 'stdout-error') f.child.stdout.emit('error', new Error('SYNTHETIC PIPE ERROR'));
  else f.child.stdout.write(bytes);
  f.child.emit('close', mode === 'nonzero-exit' ? 2 : 0, null);
  assert.equal((await failed).code, 'STILL_CORE_EXTRACT_FAILED');
  assert.equal(f.kills(), ['oversize', 'stderr-overflow', 'stdout-error'].includes(mode) ? 1 : 0);
});
test('a cancellation cannot settle the extraction fence before its own child close or dispatch another helper', async () => {
  const controller = new AbortController(), f = fixture({signal: controller.signal}), reading = f.result();
  let settled = false; const failed = reading.catch(error => {settled = true; return error;});
  controller.abort(); await flush(); assert.equal(f.kills(), 1); assert.equal(settled, false); assert.equal(f.calls(), 1);
  f.child.emit('close', null, 'SIGTERM'); assert.equal((await failed).code, 'STILL_SETUP_CANCELLED');
});
test('an already cancelled extraction never starts a process', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture({signal: controller.signal});
  await assert.rejects(f.result(), {code: 'STILL_SETUP_CANCELLED'}); assert.equal(f.calls(), 0);
});
test('a deadline requests termination only of the owned extractor and waits for its close witness', async () => {
  const f = fixture({timeoutMs: 5}), reading = f.result(); let settled = false;
  const failed = reading.catch(error => {settled = true; return error;});
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.kills(), 1); assert.equal(settled, false);
  f.child.emit('close', null, 'SIGTERM'); assert.equal((await failed).code, 'STILL_CORE_EXTRACT_TIMEOUT');
});
test('an asynchronous spawn denial is consumed and still requires the close event', async () => {
  const f = fixture(), failed = f.result().catch(error => error);
  f.child.emit('error', new Error('SYNTHETIC DENIED')); f.child.emit('close', -2, null);
  assert.equal((await failed).code, 'STILL_CORE_EXTRACT_FAILED');
});
for (const member of ['../outside', '$PLUGINSDIR/file.dll', '$R0/file.exe', 'uninstall.exe', '*.dll', 'profile/config.sqlite', '-oC:/outside']) {
  test(`a special or unbounded member cannot invoke the helper: ${member}`, async () => {
    const f = fixture({member}); await assert.rejects(async () => f.result()); assert.equal(f.calls(), 0);
  });
}
test('the extractor namespace rejects extra DLLs/Codecs/link metadata without reading unknown content', async t => {
  const {root, parent} = createCanonicalTemp('still-extractor-namespace-');
  t.after(async () => {assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('still-extractor-namespace-')); await fs.rm(root, {recursive: true, force: true});});
  const directory = path.join(root, 'bootstrap/7zip'); await fs.mkdir(directory, {recursive: true});
  const names = ['7z.exe', '7z.dll', 'License.txt', 'COPYING.txt', '7z2606-src.7z', 'Source-Info.txt'];
  const manifest = {extractor: {files: names.map(name => ({relativePath: `bootstrap/7zip/${name}`}))}};
  for (const name of names) await fs.writeFile(path.join(directory, name), 'SYNTHETIC');
  await assertExtractorNamespace(root, manifest);
  await fs.writeFile(path.join(directory, 'foreign.dll'), 'SYNTHETIC UNKNOWN');
  await assert.rejects(assertExtractorNamespace(root, manifest), /闭合/); await fs.unlink(path.join(directory, 'foreign.dll'));
  await fs.mkdir(path.join(directory, 'Codecs')); await assert.rejects(assertExtractorNamespace(root, manifest), /闭合/); await fs.rmdir(path.join(directory, 'Codecs'));
  const original = path.join(directory, '7z.dll'); await fs.rename(original, path.join(root, 'owned-copy'));
  await fs.link(path.join(root, 'owned-copy'), original); await assert.rejects(assertExtractorNamespace(root, manifest), /链接/);
});
