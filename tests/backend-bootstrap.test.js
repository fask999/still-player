'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {createBackendBootstrap, validateBootstrapManifest, relativeFile, signatureMatches} = require('../src/main/backend-bootstrap');
const {createHandlers} = require('../src/main/ipc-handlers');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const image = machine => {const bytes = Buffer.alloc(256); bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(machine, 68); bytes.writeUInt16LE(0x20b, 88); return bytes;};
async function fixture(t, options = {}) {
  const {root, parent} = createCanonicalTemp('still-bootstrap-'), appRoot = path.join(root, 'app'), dataDir = path.join(root, 'data'), backendDir = path.join(dataDir, 'backend/foobar2000');
  const original = path.join(root, 'original-profile'); await fs.mkdir(original); await fs.writeFile(path.join(original, 'auth.token'), 'SYNTHETIC NEVER COPY');
  const manifest = {schemaVersion: 1, foobarVersion: '2.26.2', architecture: 'x64', installer: {
    relativePath: 'bootstrap/foobar2000-x64_v2.26.2.exe', bytes: 7954936, sha256: 'ffa739f87d9c374cb030426a2ab4bfb37959d0dbb892fdc742654c14d127f795',
    signerSubject: 'CN=Illustrate Ltd, O=Illustrate Ltd, L=Bury, C=GB', signerThumbprint: '5A4BA9241AD6B108B5E189A3A5043F5B73FCB868'}, coreFiles: [], components: []};
  const core = new Map([['foobar2000.exe', image(0x8664)], ['portable_mode_enabled', Buffer.alloc(0)],
    ['components/foo_ui_std.dll', image(0x8664)], ['components/foo_input_std.dll', image(0x8664)]]);
  for (const [relativePath, bytes] of core) manifest.coreFiles.push({relativePath, bytes: bytes.length, sha256: digest(bytes)});
  if (options.automatic) {
    manifest.schemaVersion = 2; manifest.deployment = 'extract-original-installer';
    const pins = {
      '7z.exe': [574464, 'dc0493429fe28136fcb177a0e77c9875cbb3b0bff5f2f8eeba4df302e98cef76'],
      '7z.dll': [1897984, '500db9eb17f3c21b729ba41dd02ecfe1823da05028c7e4ba129084cc74cc364e'],
      '7z2606-src.7z': [1554409, 'e0364d39e8208557d939472c9a12d02ed1c12f45ca402e3b408bcaa63b36dd93']};
    manifest.extractor = {executable: 'bootstrap/7zip/7z.exe', files: ['7z.exe', '7z.dll', 'License.txt', 'COPYING.txt', '7z2606-src.7z', 'Source-Info.txt'].map(name =>
      ({relativePath: `bootstrap/7zip/${name}`, bytes: pins[name]?.[0] || 12, sha256: pins[name]?.[1] || 'a'.repeat(64)}))};
  }
  for (const name of ['foo_beefweb', 'foo_still_spectrum']) {
    const sourcePath = `bootstrap/${name}/${name}.dll`, targetPath = `profile/user-components-x64/${name}/${name}.dll`, bytes = image(0x8664);
    manifest.components.push({sourcePath, targetPath, bytes: bytes.length, sha256: digest(bytes)});
    await fs.mkdir(path.dirname(path.join(appRoot, sourcePath)), {recursive: true}); await fs.writeFile(path.join(appRoot, sourcePath), bytes);
  }
  await fs.mkdir(path.join(appRoot, 'manifests')); await fs.writeFile(path.join(appRoot, 'manifests/public-backend.json'), JSON.stringify(manifest));
  let launches = 0, running = false, child; const updates = [], extracted = [];
  const make = more => createBackendBootstrap({appRoot, dataDir, backendDir,
    verifyInstaller: async () => {}, isRunning: async () => running, allocatePort: async () => 51941,
    verifyExtractor: async () => {}, extractCoreEntry: async ({entry, signal}) => {assert.equal(signal.aborted, false); extracted.push(entry.relativePath); return Buffer.from(core.get(entry.relativePath));},
    launchInstaller: filename => {assert.equal(filename, path.join(appRoot, manifest.installer.relativePath)); launches++; child = new EventEmitter(); child.pid = 12345; return child;},
    onUpdate: value => updates.push(value), ...options, ...more});
  const service = make();
  t.after(async () => {await service.close(); assert.equal(await fs.readFile(path.join(original, 'auth.token'), 'utf8'), 'SYNTHETIC NEVER COPY');
    assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('still-bootstrap-')); await fs.rm(root, {recursive: true, force: true});});
  return {root, appRoot, dataDir, backendDir, manifest, service, updates, extracted, core, launches: () => launches, make,
    setRunning: value => {running = value;}, finishInstaller: () => child.emit('exit', 0),
    async installCore() {for (const [relative, bytes] of core) {await fs.mkdir(path.dirname(path.join(backendDir, relative)), {recursive: true}); await fs.writeFile(path.join(backendDir, relative), bytes);}}};
}
async function cancelAfterPendingWrite(f) {
  const write = fs.writeFile; let pending = null;
  fs.writeFile = async function(filename, ...args) {
    const result = await write.call(this, filename, ...args);
    if (!pending && String(filename).includes('.still-components-') && /^backend-manifest-[a-f0-9-]{36}\.json$/.test(path.basename(String(filename)))) {
      pending = String(filename); f.service.cancel();
    }
    return result;
  };
  try {await assert.rejects(f.service.complete(), {code: 'STILL_SETUP_CANCELLED'});}
  finally {fs.writeFile = write;}
  assert.ok(pending, 'The exact pending-file/receipt gap was reached');
  return pending;
}

test('schema2 prepares a fresh portable core automatically without launching the official installer or claiming live readiness', async t => {
  const f = await fixture(t, {automatic: true}); await f.service.initialize();
  assert.equal(f.service.getStatus().automatic, true);
  await f.service.begin(); assert.equal(f.launches(), 0);
  assert.equal(f.extracted.length, f.manifest.coreFiles.length - 1); assert.equal(f.extracted.includes('portable_mode_enabled'), false);
  assert.equal((await fs.stat(path.join(f.backendDir, 'portable_mode_enabled'))).size, 0);
  await f.service.complete(); assert.equal(f.service.getStatus().prepared, true); assert.equal(f.service.getStatus().ready, false);
  const local = JSON.parse(await fs.readFile(path.join(f.backendDir, 'backend-manifest.json')));
  assert.equal(local.provenance.deployment, 'extract-original-installer');
});
for (const restart of [false, true]) test(`cancel after pending manifest wx resumes without trusting or overwriting the orphan (${restart ? 'service restart' : 'same instance'})`, async t => {
  const f = await fixture(t, {automatic: true}); await f.service.initialize(); await f.service.begin();
  const pending = await cancelAfterPendingWrite(f), before = await fs.readFile(pending), old = JSON.parse(before);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.dataDir, 'backend-setup.json'))).phase, 'extracting');
  const next = restart ? f.make() : f.service;
  if (restart) await next.initialize();
  try {
    await next.begin(); await next.complete();
    assert.equal(next.getStatus().prepared, true); assert.equal(next.getStatus().ready, false);
    assert.equal((await fs.readFile(pending)).equals(before), true);
    const local = JSON.parse(await fs.readFile(path.join(f.backendDir, 'backend-manifest.json')));
    assert.notEqual(local.backendId, old.backendId, 'Unanchored configuration was not reused');
  } finally {if (restart) await next.close();}
});
test('an unanchored legacy fixed pending file is retained without being read as configuration or blocking preparation', async t => {
  const f = await fixture(t, {automatic: true}); await f.service.initialize(); await f.service.begin();
  const receipt = JSON.parse(await fs.readFile(path.join(f.dataDir, 'backend-setup.json')));
  const stage = path.join(path.dirname(f.backendDir), `.still-components-${receipt.transactionId}`); await fs.mkdir(stage);
  const legacy = path.join(stage, 'backend-manifest.json'); await fs.writeFile(legacy, 'SYNTHETIC UNKNOWN LEGACY ORPHAN');
  await f.service.complete(); assert.equal(f.service.getStatus().prepared, true);
  assert.equal(await fs.readFile(legacy, 'utf8'), 'SYNTHETIC UNKNOWN LEGACY ORPHAN');
});
test('an existing preparing receipt can strictly resume its anchored legacy fixed pending manifest', async t => {
  const f = await fixture(t, {automatic: true}); await f.service.initialize(); await f.service.begin();
  const pending = await cancelAfterPendingWrite(f), bytes = await fs.readFile(pending), saved = JSON.parse(bytes);
  await fs.rename(pending, path.join(path.dirname(pending), 'backend-manifest.json'));
  const receiptPath = path.join(f.dataDir, 'backend-setup.json'), receipt = JSON.parse(await fs.readFile(receiptPath));
  await fs.writeFile(receiptPath, JSON.stringify({...receipt, phase: 'preparing', backendId: saved.backendId, manifestSha256: digest(bytes)}));
  const next = f.make(); await next.initialize();
  try {await next.begin(); await next.complete(); assert.equal(next.getStatus().prepared, true);}
  finally {await next.close();}
});
test('a forged anchored pending configuration cannot enable broader permissions and is never overwritten', async t => {
  const f = await fixture(t, {automatic: true}); await f.service.initialize(); await f.service.begin();
  const pending = await cancelAfterPendingWrite(f), saved = JSON.parse(await fs.readFile(pending));
  saved.configuration.permissions.changeClientConfig = true;
  const bytes = Buffer.from(JSON.stringify(saved, null, 2)); await fs.writeFile(pending, bytes);
  const receiptPath = path.join(f.dataDir, 'backend-setup.json'), receipt = JSON.parse(await fs.readFile(receiptPath));
  await fs.writeFile(receiptPath, JSON.stringify({...receipt, phase: 'preparing', backendId: saved.backendId, manifestSha256: digest(bytes)}));
  const next = f.make(); await next.initialize();
  try {
    await next.begin(); await assert.rejects(next.complete()); assert.equal(next.getStatus().prepared, false);
    assert.equal((await fs.readFile(pending)).equals(bytes), true);
    await assert.rejects(fs.stat(path.join(f.backendDir, 'profile/beefweb/config.json')), {code: 'ENOENT'});
  } finally {await next.close();}
});

test('schema2 verifies every member before committing any core file', async t => {
  let count = 0;
  const f = await fixture(t, {automatic: true, extractCoreEntry: async () => {if (++count > 1) throw new Error('Synthetic extractor failure'); return image(0x8664);}});
  await f.service.initialize(); await assert.rejects(f.service.begin());
  assert.deepEqual(await fs.readdir(f.backendDir), []); assert.equal(f.launches(), 0); assert.equal(f.service.getStatus().prepared, false);
});

test('cancelling an automatic generation prevents late core publication and a new explicit retry can resume its own empty target', async t => {
  let f, cancel = true;
  f = await fixture(t, {automatic: true, onUpdate: value => {if (cancel && value.state === 'extracting-core' && value.progress?.completed === 1) f.service.cancel();}});
  await f.service.initialize(); await assert.rejects(f.service.begin(), {code: 'STILL_SETUP_CANCELLED'});
  assert.deepEqual(await fs.readdir(f.backendDir), []);
  cancel = false; await f.service.begin(); await f.service.complete(); assert.equal(f.service.getStatus().prepared, true); assert.equal(f.launches(), 0);
});
test('cancellation at receipted target publication does not strand an unowned final directory and survives service restart', async t => {
  let f, cancel = true;
  f = await fixture(t, {automatic: true, onUpdate: value => {if (cancel && value.state === 'creating-target') f.service.cancel();}});
  await f.service.initialize(); await assert.rejects(f.service.begin(), {code: 'STILL_SETUP_CANCELLED'});
  await assert.rejects(fs.lstat(f.backendDir), {code: 'ENOENT'});
  cancel = false;
  const restarted = f.make(); await restarted.initialize(); await restarted.begin(); await restarted.complete();
  assert.equal(restarted.getStatus().prepared, true); assert.equal(restarted.getStatus().ready, false); await restarted.close();
});
for (const phase of ['creating-target', 'target-created']) test(`same-instance retry honors its committed receipt when cancelled at ${phase}`, async t => {
  let f, cancel = true;
  f = await fixture(t, {automatic: true, onUpdate: value => {if (cancel && value.state === phase) f.service.cancel();}});
  await f.service.initialize(); await assert.rejects(f.service.begin(), {code: 'STILL_SETUP_CANCELLED'});
  const receipt = JSON.parse(await fs.readFile(path.join(f.dataDir, 'backend-setup.json')));
  assert.equal(receipt.phase, 'creating-target');
  if (phase === 'target-created') assert.deepEqual(await fs.readdir(f.backendDir), []);
  else await assert.rejects(fs.lstat(f.backendDir), {code: 'ENOENT'});
  cancel = false; await f.service.begin(); await f.service.complete(); assert.equal(f.service.getStatus().prepared, true);
});

test('an exact partial automatic core is reusable while mismatching bytes are never overwritten', async t => {
  let fail = true, f;
  f = await fixture(t, {automatic: true, extractCoreEntry: async ({entry}) => {if (fail) throw new Error('Synthetic initial failure'); return Buffer.from(f.core.get(entry.relativePath));}});
  await f.service.initialize(); await assert.rejects(f.service.begin());
  await fs.writeFile(path.join(f.backendDir, 'foobar2000.exe'), f.core.get('foobar2000.exe'));
  fail = false; await f.service.begin(); await f.service.complete(); assert.equal(f.service.getStatus().prepared, true);
});
test('a progress observer cannot transfer a pending core commit to a replacement target directory', async t => {
  let f, swapped = false;
  f = await fixture(t, {automatic: true, onUpdate: value => {
    if (!swapped && value.state === 'committing-core') {
      swapped = true; syncFs.renameSync(f.backendDir, `${f.backendDir}-retained`); syncFs.mkdirSync(f.backendDir);
      syncFs.writeFileSync(path.join(f.backendDir, 'preserve.txt'), 'SYNTHETIC REPLACEMENT DIRECTORY');
    }
  }});
  await f.service.initialize(); await assert.rejects(f.service.begin());
  assert.deepEqual(await fs.readdir(f.backendDir), ['preserve.txt']); assert.equal(f.service.getStatus().prepared, false);
});

test('schema2 rejects special NSIS members, forged tools and missing license/source resources', async t => {
  const f = await fixture(t, {automatic: true});
  for (const member of ['$PLUGINSDIR/evil.dll', '$R0/core.exe', 'uninstall.exe', 'profile/config.sqlite', '*.dll']) {
    const m = structuredClone(f.manifest); m.coreFiles[0].relativePath = member; assert.throws(() => validateBootstrapManifest(m));
  }
  for (const mutate of [m => {m.extractor.executable = 'bootstrap/other.exe';}, m => {m.extractor.files.pop();},
    m => {m.extractor.files[0].sha256 = '0'.repeat(64);}, m => {m.extractor.files[4].sha256 = '0'.repeat(64);}]) {
    const m = structuredClone(f.manifest); mutate(m); assert.throws(() => validateBootstrapManifest(m));
  }
});
test('a clean first-run requires genuine installer completion then creates only a fresh isolated backend with random-port configuration', async t => {
  const f = await fixture(t); assert.equal((await f.service.initialize()).state, 'setup-required');
  await assert.rejects(fs.lstat(f.backendDir), {code: 'ENOENT'});
  await f.service.begin(); assert.equal(f.launches(), 1); assert.equal(f.service.getStatus().installerActive, true);
  await assert.rejects(f.service.complete());
  await f.installCore(); f.finishInstaller(); await f.service.complete({musicDirs: ['C:\\Chosen\\Music']});
  assert.equal(f.service.getStatus().prepared, true); assert.equal(f.service.getStatus().ready, false);
  const config = JSON.parse(await fs.readFile(path.join(f.backendDir, 'profile/beefweb/config.json')));
  assert.equal(config.port, 51941); assert.equal(config.allowRemote, false); assert.deepEqual(config.musicDirs, ['C:\\Chosen\\Music']);
  const local = JSON.parse(await fs.readFile(path.join(f.backendDir, 'backend-manifest.json')));
  assert.equal(local.privateUseOnly, true); assert.equal(local.provenance.kind, 'official-installer-local');
  assert.equal(local.files.some(row => row.relativePath.includes('config.sqlite') || row.relativePath.includes('auth')), false);
  assert.equal(local.files.some(row => row.relativePath.endsWith('foo_beefweb.dll')), true);
  const restarted = f.make(); assert.equal((await restarted.initialize()).prepared, true); assert.equal(restarted.getStatus().ready, false); await restarted.close();
  assert.throws(() => f.service.markReady({...local, pid: 1}, {available: true, owned: true, pid: 1, baseUrl: 'http://127.0.0.1:51941/api/'}), /真实连接/);
});
test('an existing target cannot be adopted as a new installation or overwritten', async t => {
  const f = await fixture(t); await f.service.initialize(); await fs.mkdir(f.backendDir, {recursive: true});
  await fs.writeFile(path.join(f.backendDir, 'keep.txt'), 'keep'); await assert.rejects(f.service.begin());
  assert.equal(f.launches(), 0); assert.equal(await fs.readFile(path.join(f.backendDir, 'keep.txt'), 'utf8'), 'keep');
});
test('replacing the generated directory cannot transfer its receipt to another portable installation', async t => {
  const f = await fixture(t); await f.service.initialize(); await f.service.begin(); f.finishInstaller();
  await fs.rename(f.backendDir, `${f.backendDir}-retained`); await fs.mkdir(f.backendDir); await f.installCore();
  await assert.rejects(f.service.complete()); assert.equal(f.service.getStatus().prepared, false);
  await assert.rejects(fs.lstat(path.join(f.backendDir, 'profile')), {code: 'ENOENT'});
});
test('an installer-started unowned core must close normally before any component/profile preparation', async t => {
  const f = await fixture(t); await f.service.initialize(); await f.service.begin(); await f.installCore(); f.finishInstaller(); f.setRunning(true);
  await assert.rejects(f.service.complete()); await assert.rejects(fs.lstat(path.join(f.backendDir, 'profile')), {code: 'ENOENT'});
  f.setRunning(false); await f.service.complete(); assert.equal(f.service.getStatus().prepared, true);
  const config = JSON.parse(await fs.readFile(path.join(f.backendDir, 'profile/beefweb/config.json'))); assert.deepEqual(config.musicDirs, [path.join(f.dataDir, 'empty-music')]);
});
test('wrong official core bytes or architecture cannot reach component mutation', async t => {
  const f = await fixture(t); await f.service.initialize(); await f.service.begin(); await f.installCore(); f.finishInstaller();
  await fs.writeFile(path.join(f.backendDir, 'foobar2000.exe'), image(0x14c));
  await assert.rejects(f.service.complete()); await assert.rejects(fs.lstat(path.join(f.backendDir, 'profile')), {code: 'ENOENT'});
});
test('component hash failure leaves the fresh official installation without partially installed components', async t => {
  const f = await fixture(t); await f.service.initialize(); await f.service.begin(); await f.installCore(); f.finishInstaller();
  await fs.writeFile(path.join(f.appRoot, f.manifest.components.at(-1).sourcePath), 'bad');
  await assert.rejects(f.service.complete()); await assert.rejects(fs.lstat(path.join(f.backendDir, 'profile')), {code: 'ENOENT'});
});
for (const relative of ['profile/user-components-x64/foreign/foreign.dll', 'profile/user-components-x64/foo_beefweb/extra.dll', 'components/foreign.dll', 'foreign.dll']) {
  test(`unreviewed native component content is rejected before preparation: ${relative}`, async t => {
    const f = await fixture(t); await f.service.initialize(); await f.service.begin(); await f.installCore(); f.finishInstaller();
    const target = path.join(f.backendDir, relative); await fs.mkdir(path.dirname(target), {recursive: true}); await fs.writeFile(target, image(0x8664));
    await assert.rejects(f.service.complete()); assert.equal(f.service.getStatus().prepared, false);
    assert.equal((await fs.readFile(target)).equals(image(0x8664)), true);
    await assert.rejects(fs.lstat(path.join(f.backendDir, 'profile/beefweb/config.json')), {code: 'ENOENT'});
  });
}

test('a hardlinked official file is rejected even when its content hash is correct', async t => {
  const f = await fixture(t); await f.service.initialize(); await f.service.begin(); await f.installCore(); f.finishInstaller();
  await fs.link(path.join(f.backendDir, 'foobar2000.exe'), path.join(f.root, 'alias.exe'));
  await assert.rejects(f.service.complete()); await assert.rejects(fs.lstat(path.join(f.backendDir, 'profile')), {code: 'ENOENT'});
});

test('port conflict and cancellation during allocation never publish readiness and can safely retry the same receipted target', async t => {
  let port = 8880, cancel = false, f;
  f = await fixture(t, {allocatePort: async () => {if (cancel) f.service.cancel(); return port;}});
  await f.service.initialize(); await f.service.begin(); await f.installCore(); f.finishInstaller();
  await assert.rejects(f.service.complete()); assert.equal(f.service.getStatus().prepared, false);
  port = 51941; cancel = true;
  await assert.rejects(f.service.complete(), {code: 'STILL_SETUP_CANCELLED'}); assert.equal(f.service.getStatus().prepared, false);
  cancel = false; await f.service.complete(); assert.equal(f.service.getStatus().prepared, true); assert.equal(f.service.getStatus().ready, false);
});

test('forged persisted receipts cannot approve a different immutable core inventory or manufacture a live ready session', async t => {
  const f = await fixture(t); await f.service.initialize(); await f.service.begin(); await f.installCore(); f.finishInstaller(); await f.service.complete();
  const filename = path.join(f.backendDir, 'backend-manifest.json'), local = JSON.parse(await fs.readFile(filename));
  local.files[0].sha256 = '0'.repeat(64); const bytes = Buffer.from(JSON.stringify(local)); await fs.writeFile(filename, bytes);
  const receiptPath = path.join(f.dataDir, 'backend-setup.json'), receipt = JSON.parse(await fs.readFile(receiptPath)); receipt.manifestSha256 = digest(bytes);
  await fs.writeFile(receiptPath, JSON.stringify(receipt));
  const next = f.make(); await assert.rejects(next.initialize(), /官方文件清单/); await next.close();
});
test('a cancelled verifier cannot launch the installer or create the target after its await resumes', async t => {
  let release; const gate = new Promise(resolve => {release = resolve;}); const f = await fixture(t, {verifyInstaller: () => gate});
  await f.service.initialize(); const starting = f.service.begin(); const failed = starting.catch(error => error);
  f.service.cancel(); release(); assert.equal((await failed).code, 'STILL_SETUP_CANCELLED'); assert.equal(f.launches(), 0);
  await assert.rejects(fs.lstat(f.backendDir), {code: 'ENOENT'});
});
test('an installer spawn denied without a PID is observed once and does not leave an unhandled child error', async t => {
  const child = new EventEmitter();
  const f = await fixture(t, {launchInstaller: () => {queueMicrotask(() => child.emit('error', new Error('SYNTHETIC_DENIAL'))); return child;}});
  await f.service.initialize(); await assert.rejects(f.service.begin(), {code: 'STILL_BACKEND_SETUP_FAILED'});
  assert.equal(f.service.getStatus().installerActive, false); assert.equal(f.service.getStatus().ready, false);
  assert.equal(child.listenerCount('error'), 0, 'The once observer consumed the denied launch');
});
test('real installer hash validation rejects synthetic bytes before signature verification or launch', async t => {
  const f = await fixture(t, {verifyInstaller: undefined, verifySignature: () => {throw new Error('Must not inspect unsigned wrong bytes');}});
  await f.service.initialize(); await fs.mkdir(path.join(f.appRoot, 'bootstrap'), {recursive: true});
  await fs.writeFile(path.join(f.appRoot, f.manifest.installer.relativePath), 'SYNTHETIC NOT EXECUTABLE');
  await assert.rejects(f.service.begin()); assert.equal(f.launches(), 0); await assert.rejects(fs.lstat(f.backendDir), {code: 'ENOENT'});
});
test('PowerShell exit success with empty/nonterminating signature output never approves an installer', async t => {
  const f = await fixture(t), expected = f.manifest.installer;
  for (const value of [null, {}, {status: '', subject: null, thumbprint: null}, {status: 'NotSigned'},
    {status: 'Valid', subject: expected.signerSubject, thumbprint: ''},
    {status: 'Valid', subject: 'wrong', thumbprint: expected.signerThumbprint}]) assert.equal(signatureMatches(value, expected), false);
  assert.equal(signatureMatches({status: 'Valid', subject: expected.signerSubject, thumbprint: expected.signerThumbprint}, expected), true);
});
for (const value of ['../outside', '/absolute', 'C:/absolute', 'a\\b', 'a/../b', 'con.txt', 'bootstrap/file:stream', 'file.']) test(`unsafe setup path is rejected: ${value}`, () => {
  assert.throws(() => relativeFile(value));
});
test('closed public manifest rejects arbitrary installer, original profile, component destination and duplicate paths', async t => {
  const f = await fixture(t);
  const patches = [m => {m.installer.relativePath = 'bootstrap/other.exe';}, m => {m.installer.sha256 = '0'.repeat(64);},
    m => {m.coreFiles[0].relativePath = 'profile/config.sqlite';}, m => {m.components[0].targetPath = '../original-profile/auth.token';},
    m => {m.components.push({...m.components[0]});}, m => {m.extra = true;}];
  for (const patch of patches) {const m = structuredClone(f.manifest); patch(m); assert.throws(() => validateBootstrapManifest(m));}
});
test('setup IPC rejects renderer executable/URL/target/args and retains read-only recovery gating', async () => {
  let calls = 0, readOnly = false;
  const h = createHandlers({library: {list: () => ({tracks: []})}, getRuntimeState: () => ({readOnly}),
    backendSetup: {status: () => ({ready: false}), begin: () => {calls++;}, complete: () => {calls++;}, cancel: () => {calls++;}}});
  for (const field of ['path', 'url', 'target', 'args']) await assert.rejects(h['backend:setupBegin']({[field]: 'SECRET'}), /不接受/);
  assert.equal(calls, 0); await h['backend:setupBegin']({}); assert.equal(calls, 1);
  readOnly = true; await assert.rejects(async () => h['backend:setupComplete']({}), /只读/); assert.deepEqual(await h['backend:setupStatus']({}), {ready: false});
});
test('public first use keeps the existing two-source setup barrier with an actionable message instead of claiming no local resource', async () => {
  let plays = 0;
  const h = createHandlers({library: {list: () => ({tracks: []})}, backendSetup: {status: () => ({ready: false})},
    apple: {getStatus: () => ({available: true, capabilities: {playback: true}}), play: async () => {plays++;}, getState: async () => ({state: 'stopped'})}});
  for (const source of ['local', 'apple']) await assert.rejects(h['player:play']({source, id: 'synthetic'}), /首次设置.*具体共享设备/);
  assert.equal(plays, 0);
});
