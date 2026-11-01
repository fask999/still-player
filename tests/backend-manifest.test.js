'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { planBackend, materializeBackend, ROOT_FILES, STANDARD_COMPONENTS, USER_COMPONENTS, COMPONENT_SETTINGS } = require('../scripts/backend-manifest');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'still-backend-manifest-'));
  const sourceDir = path.join(root, 'original'), destinationDir = path.join(root, 'private', 'backend');
  async function write(relative, contents = `FAKE DATA ONLY ${relative}`) {
    const filename = path.join(sourceDir, relative); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, contents);
  }
  for (const relative of ROOT_FILES) await write(relative);
  for (const name of STANDARD_COMPONENTS) await write(`components/${name}.dll`);
  for (const name of USER_COMPONENTS) await write(`profile/user-components-x64/${name}/${name}.dll`);
  for (const name of COMPONENT_SETTINGS) await write(`profile/configuration/${name}.dll.cfg`);
  await write('runtime/runtime.manifest'); await write('profile/version.txt');
  await write('Still/DO-NOT-COPY.wav', 'original media sentinel'); await write('Still-backup-before/keep.txt', 'backup sentinel');
  await write('profile/playlists-v2.0/original.fpl', 'user playlist sentinel');
  const database = new DatabaseSync(path.join(sourceDir, 'profile/config.sqlite'));
  database.exec('CREATE TABLE test_settings(name TEXT PRIMARY KEY,value TEXT); INSERT INTO test_settings VALUES (\'output\',\'DX1 II\')'); database.close();
  const options = { sourceDir, destinationDir, musicDirs: ['E:\\音乐'], port: 18880 };
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, sourceDir, destinationDir, options, write };
}

test('dry-run hashes only explicit allowlist and leaves original, backup, media and destination unchanged', async t => {
  const f = await fixture(t);
  const plan = await planBackend(f.options);
  assert.equal(plan.dryRun, true); assert.equal(plan.privateUseOnly, true);
  assert.ok(plan.files.every(item => item.sha256.length === 64));
  assert.ok(!plan.files.some(item => /Still|playlists|backup|\.wav$/.test(item.relativePath)));
  assert.equal(await fs.stat(f.destinationDir).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(f.sourceDir, 'Still/DO-NOT-COPY.wav'), 'utf8'), 'original media sentinel');
  assert.deepEqual(plan.configuration, { port: 18880, allowRemote: false, musicDirs: ['E:\\音乐'],
    permissions: { changePlaylists: true, changeOutput: true, changeClientConfig: false } });
});

test('private fake-file assembly preserves source and uses read-only clean SQLite snapshot with evidence', async t => {
  const f = await fixture(t), plan = await planBackend(f.options);
  const copied = await materializeBackend(plan, { privateUse: true, isSourceRunning: async () => false });
  assert.equal(copied.dryRun, false);
  assert.equal(copied.profileSnapshotEvidence.sourceReadOnly, true);
  assert.equal(copied.profileSnapshotEvidence.sourceBeforeHash, copied.profileSnapshotEvidence.sourceAfterHash);
  assert.equal(copied.profileSnapshotEvidence.destinationIntegrityCheck, 'ok');
  assert.equal(await fs.stat(path.join(f.destinationDir, 'Still')).then(() => true, () => false), false);
  const privateDb = new DatabaseSync(path.join(f.destinationDir, 'profile/config.sqlite'), { readOnly: true });
  assert.equal(privateDb.prepare('SELECT value FROM test_settings WHERE name=?').get('output').value, 'DX1 II'); privateDb.close();
  assert.equal(await fs.readFile(path.join(f.sourceDir, 'Still-backup-before/keep.txt'), 'utf8'), 'backup sentinel');
  assert.equal(await fs.stat(path.join(f.sourceDir, 'profile/config.sqlite-shm')).then(() => true, () => false), false);
  await assert.rejects(materializeBackend(plan, { privateUse: true, isSourceRunning: async () => false }), /already exists/);
});

test('running source, WAL/SHM, changed review and missing private-use consent fail before assembly', async t => {
  const f = await fixture(t), plan = await planBackend(f.options);
  await assert.rejects(materializeBackend(plan, { isSourceRunning: async () => false }), /Explicit private/);
  await assert.rejects(materializeBackend(plan, { privateUse: true, isSourceRunning: async () => true }), /Close the original/);
  await f.write('profile/config.sqlite-wal', 'do not open sqlite');
  await assert.rejects(materializeBackend(plan, { privateUse: true, isSourceRunning: async () => false }), /-wal still exists/);
  await fs.rm(path.join(f.sourceDir, 'profile/config.sqlite-wal'));
  await f.write('foobar2000.exe', 'changed since dry-run');
  await assert.rejects(materializeBackend(plan, { privateUse: true, isSourceRunning: async () => false }), /changed after review/);
  assert.equal(await fs.stat(f.destinationDir).then(() => true, () => false), false);
});

test('source/destination boundaries, dedicated port and absolute roots are validated', async t => {
  const f = await fixture(t);
  await assert.rejects(planBackend({ ...f.options, destinationDir: f.sourceDir }), /replace or contain/);
  await assert.rejects(planBackend({ ...f.options, port: 8880 }), /dedicated/);
  await assert.rejects(planBackend({ ...f.options, musicDirs: ['relative'] }), /absolute Windows/);
  await assert.rejects(planBackend({ ...f.options, musicDirs: [] }), /explicitly/);
});
