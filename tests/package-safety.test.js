'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {assertPackageStopped, readValidationEvidence} = require('../scripts/package');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'still-package-safety-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(directory).startsWith('still-package-safety-'));
    await fs.rm(directory, {recursive: true, force: true});
  });
  return directory;
}
test('package preflight rejects exact app/source/backend processes before manifest checks or writes', async t => {
  const directory = await fixture(t), sourceRoot = path.join(directory, 'source'), output = path.join(directory, 'dist', 'V2');
  const executables = [path.join(output, 'Still.exe'), path.join(sourceRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(sourceRoot, 'backend', 'foobar2000', 'foobar2000.exe'), path.join(output, 'backend', 'foobar2000', 'foobar2000.exe')];
  for (const running of executables) {
    let manifestChecks = 0;
    await assert.rejects(assertPackageStopped(output, {sourceRoot,
      isRunning: async file => {assert.ok(executables.includes(file)); return file === running;},
      verifyBackend: async () => {manifestChecks++;}}), /Close STILL/);
    assert.equal(manifestChecks, 0);
    await assert.rejects(fs.stat(output), {code: 'ENOENT'});
  }
});
test('package preflight validates both existing private backends after stopped checks', async t => {
  const directory = await fixture(t), sourceRoot = path.join(directory, 'source'), output = path.join(directory, 'dist', 'V2');
  const backend = path.join(output, 'backend', 'foobar2000');
  await fs.mkdir(backend, {recursive: true});
  const checked = [], processes = [];
  await assertPackageStopped(output, {sourceRoot, isRunning: async file => {processes.push(file); return false;},
    verifyBackend: async file => {assert.equal(processes.length, 4); checked.push(file);}});
  assert.deepEqual(checked, [path.join(sourceRoot, 'backend', 'foobar2000'), backend]);
  await assert.rejects(assertPackageStopped(output, {sourceRoot, isRunning: async () => false,
    verifyBackend: async file => {if (file === backend) throw new Error('Invalid private manifest');}}), /Invalid private manifest/);
});
test('current validation preserves actual failed/unverified status and binds exact evidence bytes', async t => {
  const root = await fixture(t), directory = path.join(root, 'review-evidence', 'delivery');
  await fs.mkdir(directory, {recursive: true});
  const filename = path.join(directory, 'validation.json');
  const validation = {recordedAt: '2026-10-31T00:00:00Z', source: {
    tests: {command: 'node --test tests/*.test.js', passed: 9, failed: 1, skipped: 2, log: 'source-tests.log'},
    build: {command: 'node scripts/build.js', passed: false, log: 'source-build.log'}},
  review: {status: 'pending', report: 'review.md'}, package: {status: 'pending'}, unverified: ['Real app launch']};
  const bytes = JSON.stringify(validation, null, 2);
  await fs.writeFile(filename, bytes);
  const result = await readValidationEvidence(filename, root);
  assert.deepEqual(result.value, validation);
  assert.equal(result.provenance.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.provenance.file, 'review-evidence/delivery/validation.json');
  await assert.rejects(readValidationEvidence(path.join(root, 'private.json'), root), /under project/);
  await fs.writeFile(filename, JSON.stringify({source: {}}));
  await assert.rejects(readValidationEvidence(filename, root), /Invalid current-delivery/);
});
