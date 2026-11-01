'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {sha256} = require('../scripts/backend-baselines');
const {CLIENT_SOURCE_PATH, CLIENT_REVISION_PATH, CLIENT_REVISION_SHA256, NATIVE_MANIFEST_SHA256, ORIGINAL_CLIENT_SOURCE,
  validateSpectrumClientRevision, verifySpectrumClientRevision} = require('../scripts/spectrum-client-revision');
const {DELIVERY_PATH, DELIVERY_SHA256, verifySpectrumDelivery, componentStatus} = require('../scripts/install-spectrum-component');
const project = path.resolve(__dirname, '..');
const legacyFixture = path.join(__dirname, 'fixtures/spectrum-client-legacy-0bf.fixture');
const clone = value => JSON.parse(JSON.stringify(value));
async function write(root, relative, bytes) {
  const filename = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(filename), {recursive: true}); await fsp.writeFile(filename, bytes);
}
async function fixture(t, {native = false} = {}) {
  const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-client-revision-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(sourceRoot)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(sourceRoot).startsWith('still-client-revision-'));
    await fsp.rm(sourceRoot, {recursive: true, force: true});
  });
  const clientBytes = await fsp.readFile(path.join(project, CLIENT_SOURCE_PATH)), recordBytes = await fsp.readFile(path.join(project, CLIENT_REVISION_PATH));
  await write(sourceRoot, CLIENT_SOURCE_PATH, clientBytes); await write(sourceRoot, CLIENT_REVISION_PATH, recordBytes);
  if (native) {
    const delivery = verifySpectrumDelivery(project), files = new Set([DELIVERY_PATH, ...delivery.applicationRuntimeFiles.map(file => file.sourceRelativePath), ...delivery.privateBackendComponentFiles.map(file => file.sourceRelativePath)]);
    for (const relative of files) await write(sourceRoot, relative, await fsp.readFile(path.join(project, relative)));
  }
  return {sourceRoot, clientBytes, recordBytes};
}

test('approved current source uses its pinned independent revision without native payloads or ignored proof files', async t => {
  const f = await fixture(t), result = verifySpectrumClientRevision(f.sourceRoot);
  assert.equal(result.clientSource.bytes, 22952);
  assert.equal(result.clientSource.sha256, '7a286d3bf33fb4ff129ebfd0bb50c9a3859399ff9f432bd49745d61131ec2a39');
  assert.equal(sha256(f.recordBytes), CLIENT_REVISION_SHA256);
  assert.deepEqual(result.clientRevision, {recordPath: CLIENT_REVISION_PATH, rawSha256: CLIENT_REVISION_SHA256,
    proofHash: '971796d9b2b969ab524d6b39b5b6ab167b627f7bbe831240056e54009285bf78', nativeManifestSha256: NATIVE_MANIFEST_SHA256, originalClientSha256: ORIGINAL_CLIENT_SOURCE.sha256});
  assert.deepEqual(result.clientHashes, {[CLIENT_REVISION_PATH]: CLIENT_REVISION_SHA256, [CLIENT_SOURCE_PATH]: result.clientSource.sha256});
  assert.ok(Object.isFrozen(result.clientHashes)); assert.ok(Object.isFrozen(result.clientRevision));
  await assert.rejects(fsp.stat(path.join(f.sourceRoot, 'native')), {code: 'ENOENT'});
  await assert.rejects(fsp.stat(path.join(f.sourceRoot, 'review-evidence')), {code: 'ENOENT'});
});

test('legacy acceptance requires the exact tracked original vector and needs no revision record', async t => {
  const f = await fixture(t), legacy = await fsp.readFile(legacyFixture);
  assert.equal(legacy.length, 20573); assert.equal(sha256(legacy), ORIGINAL_CLIENT_SOURCE.sha256);
  await fsp.writeFile(path.join(f.sourceRoot, CLIENT_SOURCE_PATH), legacy); await fsp.unlink(path.join(f.sourceRoot, CLIENT_REVISION_PATH));
  const result = verifySpectrumClientRevision(f.sourceRoot);
  assert.deepEqual(result.clientSource, ORIGINAL_CLIENT_SOURCE); assert.equal(result.clientRevision, null);
  assert.deepEqual(result.clientHashes, {[CLIENT_SOURCE_PATH]: ORIGINAL_CLIENT_SOURCE.sha256});
  // An inactive record is not approval for legacy bytes; the package consumer
  // separately rejects shipping such a record in a legacy bundle.
  await write(f.sourceRoot, CLIENT_REVISION_PATH, '{unapproved inactive record');
  assert.equal(verifySpectrumClientRevision(f.sourceRoot).clientRevision, null);
});

test('unknown bytes cannot enter the legacy branch or fall back after a missing or bad new record', async t => {
  const f = await fixture(t), record = path.join(f.sourceRoot, CLIENT_REVISION_PATH), client = path.join(f.sourceRoot, CLIENT_SOURCE_PATH);
  await fsp.unlink(record); assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /ENOENT/);
  await fsp.writeFile(record, f.recordBytes); await fsp.appendFile(client, '\n'); assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /integrity failed/);
  const legacy = Buffer.from(await fsp.readFile(legacyFixture)); legacy[0] ^= 1;
  await fsp.writeFile(client, legacy); assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /integrity failed/);
  await fsp.writeFile(record, '{}'); assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /reviewed raw SHA256/);
});

test('revision schema rejects unknown keys, alternate source/native anchors, bad sizes and malformed proof hashes', async t => {
  const f = await fixture(t), record = JSON.parse(f.recordBytes), changes = [
    value => {value.extra = true;}, value => {delete value.proofHash;}, value => {value.schemaVersion = 2;},
    value => {value.nativeManifestSha256 = '0'.repeat(64);}, value => {value.originalClientSha256 = '0'.repeat(64);},
    value => {value.clientSource.extra = true;}, value => {value.clientSource.relativePath = '../source.js';},
    value => {value.clientSource.relativePath = 'D:/source.js';}, value => {value.clientSource.bytes = 0;},
    value => {value.clientSource.bytes = 0.5;}, value => {value.clientSource.bytes = 1024 * 1024 + 1;},
    value => {value.clientSource.sha256 = 'A'.repeat(64);}, value => {value.proofHash = 'not-approved';},
    value => {value.proofHash = 123;}, value => {value.clientSource = [];}];
  for (const change of changes) {const value = clone(record); change(value); assert.throws(() => validateSpectrumClientRevision(value), /Spectrum|spectrum/);}
});

test('editing both record and client never overrides the code pin, including an attempted expected-pin argument', async t => {
  const f = await fixture(t), client = Buffer.from('UNKNOWN SOURCE MUST NEVER BE APPROVED'), altered = JSON.parse(f.recordBytes);
  altered.clientSource.bytes = client.length; altered.clientSource.sha256 = sha256(client);
  const bytes = Buffer.from(JSON.stringify(altered)); await fsp.writeFile(path.join(f.sourceRoot, CLIENT_SOURCE_PATH), client);
  await fsp.writeFile(path.join(f.sourceRoot, CLIENT_REVISION_PATH), bytes);
  assert.throws(() => verifySpectrumClientRevision(f.sourceRoot, {expectedPin: sha256(bytes)}), /reviewed raw SHA256/);
  await fsp.writeFile(path.join(f.sourceRoot, CLIENT_SOURCE_PATH), f.clientBytes);
  await fsp.writeFile(path.join(f.sourceRoot, CLIENT_REVISION_PATH), Buffer.concat([f.recordBytes, Buffer.from('\n')]));
  assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /reviewed raw SHA256/);
});

test('missing, oversized, hardlinked and redirected source or record files fail closed', async t => {
  const f = await fixture(t), client = path.join(f.sourceRoot, CLIENT_SOURCE_PATH), record = path.join(f.sourceRoot, CLIENT_REVISION_PATH);
  await fsp.unlink(client); assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /ENOENT/); await fsp.writeFile(client, f.clientBytes);
  await fsp.writeFile(record, ' '.repeat(8 * 1024 + 1)); assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /small unlinked/);
  await fsp.writeFile(record, f.recordBytes); await fsp.writeFile(client, Buffer.alloc(1024 * 1024 + 1)); assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /small unlinked/);
  await fsp.writeFile(client, f.clientBytes);
  const alias = path.join(f.sourceRoot, 'alias');
  for (const file of [client, record]) {await fsp.link(file, alias); assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /small unlinked/); await fsp.unlink(alias);}
  const saved = path.join(f.sourceRoot, 'saved-manifests'); await fsp.rename(path.dirname(record), saved); await fsp.symlink(saved, path.dirname(record), 'junction');
  assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /link or junction/);
});

test('exact legacy bytes still require a safe unlinked regular source file', async t => {
  const f = await fixture(t), client = path.join(f.sourceRoot, CLIENT_SOURCE_PATH);
  await fsp.writeFile(client, await fsp.readFile(legacyFixture)); await fsp.unlink(path.join(f.sourceRoot, CLIENT_REVISION_PATH));
  await fsp.link(client, path.join(f.sourceRoot, 'legacy-alias'));
  assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /small unlinked/);
});

for (const drifting of ['client', 'record']) {
  test(`${drifting} drift between revision reads is rejected without modifying unknown bytes`, async t => {
    const f = await fixture(t), original = fs.readFileSync, target = path.join(f.sourceRoot, drifting === 'client' ? CLIENT_SOURCE_PATH : CLIENT_REVISION_PATH);
    let reads = 0;
    t.mock.method(fs, 'readFileSync', function (...args) {
      const bytes = original.apply(this, args); reads++;
      if (reads === (drifting === 'client' ? 2 : 3)) fs.appendFileSync(target, '\nUNKNOWN DRIFT');
      return bytes;
    });
    assert.throws(() => verifySpectrumClientRevision(f.sourceRoot), /integrity failed|changed during verification/);
    assert.ok((await fsp.readFile(target, 'utf8')).endsWith('\nUNKNOWN DRIFT'));
  });
}

test('native composite keeps SHA284, historical client metadata and the same component status across current/legacy source', async t => {
  const f = await fixture(t, {native: true}), before = await fsp.readFile(path.join(f.sourceRoot, DELIVERY_PATH));
  const current = verifySpectrumDelivery(f.sourceRoot), entries = current.privateBackendComponentFiles.map(file => ({relativePath: file.privateBackendRelativePath, mutable: false, bytes: file.bytes, sha256: file.sha256}));
  assert.equal(current.manifestSha256, DELIVERY_SHA256); assert.equal(current.clientSource.bytes, 22952);
  assert.equal(current.clientRevision.rawSha256, CLIENT_REVISION_SHA256);
  assert.deepEqual(JSON.parse(before).clientSource, ORIGINAL_CLIENT_SOURCE);
  const currentStatus = componentStatus({files: entries}, current);
  await fsp.writeFile(path.join(f.sourceRoot, CLIENT_SOURCE_PATH), await fsp.readFile(legacyFixture)); await fsp.unlink(path.join(f.sourceRoot, CLIENT_REVISION_PATH));
  const legacy = verifySpectrumDelivery(f.sourceRoot);
  assert.equal(legacy.manifestSha256, NATIVE_MANIFEST_SHA256); assert.equal(legacy.clientRevision, null);
  assert.deepEqual(legacy.applicationRuntimeFiles, current.applicationRuntimeFiles); assert.deepEqual(legacy.privateBackendComponentFiles, current.privateBackendComponentFiles);
  assert.deepEqual(componentStatus({files: entries}, legacy), currentStatus);
  assert.deepEqual(await fsp.readFile(path.join(f.sourceRoot, DELIVERY_PATH)), before); assert.equal(sha256(before), DELIVERY_SHA256);
});

test('native composite still rejects a changed native manifest before client revision can authorize it', async t => {
  const f = await fixture(t, {native: true}); await fsp.appendFile(path.join(f.sourceRoot, DELIVERY_PATH), '\n');
  assert.throws(() => verifySpectrumDelivery(f.sourceRoot), /delivery manifest.*reviewed SHA256/);
});
