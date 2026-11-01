'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {REGISTRY_PATH, loadBackendBaselines} = require('../scripts/backend-baselines');
const {copySpectrumRuntime, verifyPrivateBackend, verifySpectrumManifestLineage, verifySpectrumBackend, copyPrivateBackend} = require('../scripts/package');
const {verifySpectrumDelivery, resolveRelative, assertPeX64, planSpectrumInstall, planSha256, assertStopped,
  applySpectrumInstall, rollbackSpectrumInstall, DELIVERY_PATH, DELIVERY_SHA256, COMPONENT_DIRECTORY, INCOMPLETE_MARKER,
  APPLY_AUTHORIZATION, ROLLBACK_AUTHORIZATION} = require('../scripts/install-spectrum-component');
const project = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stopped = async () => [];
async function write(root, relative, bytes) {
  const filename = path.join(root, ...relative.split('/'));
  await fs.mkdir(path.dirname(filename), {recursive: true});
  await fs.writeFile(filename, bytes);
}
async function reviewFixtureManifest(sourceRoot, manifest, kind) {
  const registry = JSON.parse(JSON.stringify(loadBackendBaselines(sourceRoot).policy));
  registry.baselines[kind] = {...registry.baselines[kind], sha256: hash(JSON.stringify(manifest, null, 2)),
    canonicalSha256: hash(JSON.stringify(manifest)), backendId: manifest.backendId};
  await write(sourceRoot, REGISTRY_PATH, JSON.stringify(registry, null, 2));
}
async function tree(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name), relative = path.relative(root, filename).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) result[relative] = `LINK:${await fs.readlink(filename)}`;
      else if (entry.isDirectory()) {result[`${relative}/`] = 'directory'; await visit(filename);}
      else result[relative] = hash(await fs.readFile(filename));
    }
  }
  await visit(root); return result;
}
async function fixture(t) {
  const evidenceRoot = process.env.STILL_SPECTRUM_TEST_EVIDENCE;
  if (evidenceRoot) {
    const resolved = path.resolve(evidenceRoot);
    assert.ok(resolved.startsWith(path.join(project, 'review-evidence') + path.sep));
    assert.match(path.basename(resolved), /^spectrum-package-/);
    await fs.mkdir(resolved, {recursive: true});
  }
  const directory = await fs.mkdtemp(path.join(evidenceRoot || os.tmpdir(), 'still-spectrum-package-'));
  t.after(async () => {
    if (evidenceRoot) {t.diagnostic(`Retained pure-file fixture: ${directory}`); return;}
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(directory).startsWith('still-spectrum-package-'));
    await fs.rm(directory, {recursive: true, force: true});
  });
  const sourceRoot = path.join(directory, 'project'), backendDir = path.join(sourceRoot, 'backend', 'foobar2000');
  await write(sourceRoot, 'package.json', JSON.stringify({name: 'still-desktop', private: true}));
  const delivery = verifySpectrumDelivery(project);
  const sources = new Set([DELIVERY_PATH, delivery.clientSource.relativePath,
    ...delivery.applicationRuntimeFiles.map(file => file.sourceRelativePath), ...delivery.privateBackendComponentFiles.map(file => file.sourceRelativePath)]);
  for (const relative of sources) await write(sourceRoot, relative, await fs.readFile(path.join(project, ...relative.split('/'))));
  for (const name of ['tools', 'cache', 'shared', 'vendor', 'build']) await write(sourceRoot, `native/foobar-spectrum/${name}/DO-NOT-COPY.txt`, `FORBIDDEN TOOL/CACHE ${name}`);
  const entries = [
    {relativePath: 'foobar2000.exe', mutable: false, content: 'FAKE EXE NEVER RUN'},
    {relativePath: 'fooHelper.exe', mutable: false, content: 'FAKE HELPER NEVER RUN'},
    {relativePath: 'portable_mode_enabled', mutable: false, content: ''},
    {relativePath: 'components/foo_ui_std.dll', mutable: false, content: 'FAKE DLL NEVER LOAD'},
    {relativePath: 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll', mutable: false, content: 'FAKE BEEFWEB NEVER LOAD'},
    {relativePath: 'profile/config.sqlite', mutable: true, content: 'FAKE SQLITE BYTES DO NOT OPEN'},
    {relativePath: 'profile/configuration/foo_out_asio.dll.cfg', mutable: true, content: 'existing output volume and DSP stay unchanged'}
  ];
  const files = [];
  for (const {relativePath, mutable, content} of entries) {
    await write(backendDir, relativePath, content);
    files.push({relativePath, mutable, mode: 'copy', bytes: Buffer.byteLength(content), sha256: hash(content), sourceSha256: hash(content)});
  }
  const configuration = {port: 18880, allowRemote: false, musicDirs: ['E:\\音乐'], permissions: {changePlaylists: true, changeOutput: true, changeClientConfig: false}};
  const manifest = {schemaVersion: 1, privateUseOnly: true, backendId: '11111111-2222-4333-8444-555555555555', destinationDir: backendDir, executable: 'foobar2000.exe',
    totalFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files, configuration,
    createdAt: '2026-01-01T00:00:00.000Z', profileSnapshotEvidence: {doNotRewrite: true}, untouchedMetadata: {nested: ['preserve', 'all', 'values']}};
  await write(backendDir, 'backend-manifest.json', JSON.stringify(manifest, null, 2));
  await write(sourceRoot, REGISTRY_PATH, JSON.stringify(loadBackendBaselines(project).policy));
  await reviewFixtureManifest(sourceRoot, manifest, 'source');
  await reviewFixtureManifest(sourceRoot, {...manifest, backendId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
    destinationDir: path.join(sourceRoot, 'dist/Still-V2-preview-win32-x64/backend/foobar2000')}, 'target');
  await write(backendDir, 'profile/beefweb/config.json', JSON.stringify(configuration, null, 2));
  await write(sourceRoot, 'data/library.sqlite', 'CURRENT DATA MUST NEVER BE OPENED');
  await write(sourceRoot, 'data/apple-music/official-webview-profile/keep.txt', 'AUTH PROFILE SENTINEL');
  const options = {sourceRoot, backendDir};
  const evidenceDir = path.join(sourceRoot, 'review-evidence', 'spectrum-package-transaction');
  const plan = () => planSpectrumInstall(options);
  const apply = (value, extra = {}) => applySpectrumInstall(value, {expectedPlanSha256: planSha256(value), authorization: APPLY_AUTHORIZATION, evidenceDir, processInspector: stopped, ...extra});
  const rollback = (value, extra = {}) => rollbackSpectrumInstall(evidenceDir, {sourceRoot, expectedPlanSha256: planSha256(value), authorization: ROLLBACK_AUTHORIZATION, processInspector: stopped, ...extra});
  return {directory, sourceRoot, backendDir, options, evidenceDir, manifest, delivery, plan, apply, rollback};
}

test('reviewed delivery verifies fixed manifest/client hashes, lengths and both x64 PE artifacts without executing them', async t => {
  const f = await fixture(t), delivery = verifySpectrumDelivery(f.sourceRoot);
  assert.equal(delivery.manifestSha256, DELIVERY_SHA256);
  assert.equal(delivery.applicationRuntimeFiles.length, 4);
  assert.equal(delivery.privateBackendComponentFiles.length, 4);
  for (const relative of ['../escape', 'safe/../../escape', 'C:/escape', 'safe\\escape', '/escape', 'safe//escape', 'safe/file:stream', 'safe/file.']) assert.throws(() => resolveRelative(f.sourceRoot, relative), /path|root/i);
  const fake = Buffer.alloc(128); fake.write('MZ'); fake.writeUInt32LE(64, 60); fake.writeUInt32LE(0x4550, 64); fake.writeUInt16LE(0x14c, 68); fake.writeUInt16LE(0x10b, 88);
  assert.throws(() => assertPeX64(fake, 'fake-x86.exe'), /x64/);
  await fs.appendFile(path.join(f.sourceRoot, delivery.applicationRuntimeFiles[0].sourceRelativePath), 'tampered');
  assert.throws(() => verifySpectrumDelivery(f.sourceRoot), /integrity failed/);
});

test('runtime copy emits exactly reader and three notices, excludes DLL/tool/cache/vendor trees and returns snapshot hashes', async t => {
  const f = await fixture(t), app = path.join(f.directory, 'app');
  const result = await copySpectrumRuntime(f.sourceRoot, app), contents = await tree(app);
  const files = Object.keys(contents).filter(name => !name.endsWith('/'));
  assert.deepEqual(files.sort(), f.delivery.applicationRuntimeFiles.map(file => file.appRelativePath).sort());
  assert.equal(result.deliveryManifestSha256, DELIVERY_SHA256);
  assert.ok(!files.some(name => /foo_still_spectrum\.dll|tools|cache|vendor|shared|build/.test(name)));
  for (const file of f.delivery.applicationRuntimeFiles) assert.equal(result.hashes[file.appRelativePath], file.sha256);
  const sourceBefore = await tree(f.sourceRoot);
  await copySpectrumRuntime(f.sourceRoot, app);
  assert.deepEqual(await tree(f.sourceRoot), sourceBefore);
});

test('tampered delivery and unknown app DLL fail before any runtime copy writes', async t => {
  const f = await fixture(t), app = path.join(f.directory, 'app');
  await write(app, 'native/foobar-spectrum/package/foo_still_spectrum.dll', 'unknown DLL');
  const before = await tree(app);
  await assert.rejects(copySpectrumRuntime(f.sourceRoot, app), /Unknown spectrum runtime destination/);
  assert.deepEqual(await tree(app), before);
  await fs.appendFile(path.join(f.sourceRoot, DELIVERY_PATH), ' ');
  await assert.rejects(copySpectrumRuntime(f.sourceRoot, path.join(f.directory, 'absent-app')), /reviewed SHA256/);
  await assert.rejects(fs.stat(path.join(f.directory, 'absent-app')), {code: 'ENOENT'});
});

test('plan has zero writes and only appends four immutable entries while preserving UUID, config, old entries and mutable current bytes', async t => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.backendDir, 'profile/config.sqlite'), ' normal runtime state drift');
  const before = await tree(f.sourceRoot), plan = f.plan();
  assert.deepEqual(await tree(f.sourceRoot), before);
  assert.deepEqual(plan.afterManifest.files.slice(0, f.manifest.files.length), f.manifest.files);
  for (const key of ['backendId', 'destinationDir', 'configuration', 'createdAt', 'profileSnapshotEvidence', 'untouchedMetadata']) assert.deepEqual(plan.afterManifest[key], f.manifest[key]);
  assert.equal(plan.afterManifest.files.length, f.manifest.files.length + 4);
  assert.equal(plan.afterManifest.totalFiles, f.manifest.totalFiles + 4);
  assert.ok(plan.componentFiles.every(file => file.action === 'added'));
  assert.deepEqual(plan.writes.componentFiles, f.delivery.privateBackendComponentFiles.map(file => file.privateBackendRelativePath));
  assert.equal(plan.oldFiles.find(file => file.relativePath === 'profile/config.sqlite').sha256, before['backend/foobar2000/profile/config.sqlite']);
});

test('unknown component files, immutable mismatch, path duplicates and non-target directories fail closed with zero writes', async t => {
  const f = await fixture(t);
  assert.throws(() => planSpectrumInstall({...f.options, backendDir: path.join(f.sourceRoot, '..')}), /exact private/);
  await write(f.backendDir, `${COMPONENT_DIRECTORY}/foo_still_spectrum.dll`, 'unknown existing same name');
  const before = await tree(f.sourceRoot);
  assert.throws(f.plan, /Unknown existing component file/);
  assert.deepEqual(await tree(f.sourceRoot), before);
  await fs.unlink(path.join(f.backendDir, COMPONENT_DIRECTORY, 'foo_still_spectrum.dll'));
  await fs.appendFile(path.join(f.backendDir, 'foobar2000.exe'), 'changed');
  assert.throws(f.plan, /Immutable old backend entry mismatch/);
  const duplicate = {...f.manifest, files: [...f.manifest.files, {...f.manifest.files[0], relativePath: 'FOOBAR2000.EXE'}], totalFiles: f.manifest.totalFiles + 1, totalBytes: f.manifest.totalBytes + f.manifest.files[0].bytes};
  await write(f.backendDir, 'foobar2000.exe', 'FAKE EXE NEVER RUN');
  await write(f.backendDir, 'backend-manifest.json', JSON.stringify(duplicate, null, 2));
  await reviewFixtureManifest(f.sourceRoot, duplicate, 'source');
  assert.throws(f.plan, /duplicate old manifest/);
});

test('linked/hardlinked delivery, linked component parents and redirected app destinations are rejected', async t => {
  const f = await fixture(t), reader = path.join(f.sourceRoot, f.delivery.applicationRuntimeFiles[0].sourceRelativePath);
  await fs.link(reader, path.join(f.directory, 'reader-hardlink'));
  assert.throws(() => verifySpectrumDelivery(f.sourceRoot), /unlinked regular file/);
  await fs.unlink(path.join(f.directory, 'reader-hardlink'));
  const external = path.join(f.directory, 'external'); await fs.mkdir(external);
  const component = path.join(f.backendDir, COMPONENT_DIRECTORY);
  await fs.symlink(external, component, 'junction');
  assert.throws(f.plan, /Link or junction/);
  const app = path.join(f.directory, 'app'); await fs.mkdir(app);
  await fs.symlink(external, path.join(app, 'native'), 'junction');
  await assert.rejects(copySpectrumRuntime(f.sourceRoot, app), /Link or junction/);
  assert.deepEqual(await tree(external), {});
});

test('running, unreadable same-name and inspector failure reject apply before evidence, markers or backend writes', async t => {
  const f = await fixture(t), plan = f.plan(), before = await tree(f.sourceRoot);
  for (const processInspector of [
    async () => [{name: 'foobar2000.exe', executablePath: path.join(f.backendDir, 'foobar2000.exe')}],
    async () => [{name: 'StillSpectrumReader.exe', executablePath: null}],
    async () => [{name: 'fooHelper.exe', executablePath: ''}],
    async () => {throw new Error('CIM unavailable');}
  ]) {
    await assert.rejects(f.apply(plan, {processInspector}), /running|unreadable|CIM unavailable/);
    assert.deepEqual(await tree(f.sourceRoot), before);
  }
  await assert.rejects(f.apply(plan, {authorization: undefined}), /authorization/);
  await assert.rejects(f.apply(plan, {expectedPlanSha256: '0'.repeat(64)}), /reviewed plan/);
  assert.deepEqual(await tree(f.sourceRoot), before);
});

test('freshly closed gate rejects runtime markers and mutable drift; unrelated readable same-name process is not killed or adopted', async t => {
  const f = await fixture(t), plan = f.plan();
  await assertStopped(plan, async () => [{name: 'foobar2000.exe', executablePath: path.join(f.directory, 'unrelated', 'foobar2000.exe')}]);
  await write(f.backendDir, 'profile/config.sqlite-wal', 'fake active WAL');
  const before = await tree(f.sourceRoot);
  await assert.rejects(f.apply(plan), /freshly closed/);
  assert.deepEqual(await tree(f.sourceRoot), before);
  await fs.unlink(path.join(f.backendDir, 'profile/config.sqlite-wal'));
  await fs.appendFile(path.join(f.backendDir, 'profile/config.sqlite'), 'drift after reviewed plan');
  const drifted = await tree(f.sourceRoot);
  await assert.rejects(f.apply(plan), /changed after review/);
  assert.deepEqual(await tree(f.sourceRoot), drifted);
});

test('target plan preserves its own destination and UUID and rejects its running packaged app before writes', async t => {
  const f = await fixture(t), target = path.join(f.sourceRoot, 'dist/Still-V2-preview-win32-x64/backend/foobar2000');
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.cp(f.backendDir, target, {recursive: true});
  const targetManifest = {...f.manifest, backendId: '66666666-7777-4888-8999-aaaaaaaaaaaa', destinationDir: target};
  await write(target, 'backend-manifest.json', JSON.stringify(targetManifest, null, 2));
  const plan = planSpectrumInstall({sourceRoot: f.sourceRoot, backendDir: target}), before = await tree(f.sourceRoot);
  assert.equal(plan.backendKind, 'target');
  assert.equal(plan.afterManifest.backendId, targetManifest.backendId);
  assert.equal(plan.afterManifest.destinationDir, target);
  await assert.rejects(f.apply(plan, {processInspector: async () => [{name: 'Still.exe', executablePath: path.join(f.sourceRoot, 'dist/Still-V2-preview-win32-x64/Still.exe')}]}), /running/);
  assert.deepEqual(await tree(f.sourceRoot), before);
  assert.equal(hash(await fs.readFile(path.join(f.backendDir, 'backend-manifest.json'))), hash(JSON.stringify(f.manifest, null, 2)));
});

test('a helper appearing during staging preserves old backend bytes and retains only failed evidence outside the backend', async t => {
  const f = await fixture(t), plan = f.plan(), before = await tree(f.backendDir);
  let inspection = 0;
  await assert.rejects(f.apply(plan, {processInspector: async () => ++inspection === 1 ? [] : [{name: 'fooHelper.exe', executablePath: path.join(f.backendDir, 'fooHelper.exe')}]}), /running/);
  assert.deepEqual(await tree(f.backendDir), before);
  const failure = JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')));
  assert.equal(failure.phase, 'failed'); assert.equal(failure.failedPhase, 'staging');
  await assert.rejects(fs.stat(path.join(f.backendDir, INCOMPLETE_MARKER)), {code: 'ENOENT'});
});

test('dedicated config changes and linked or outside evidence paths are refused before deployment writes', async t => {
  const f = await fixture(t), plan = f.plan(), before = await tree(f.sourceRoot);
  await assert.rejects(f.apply(plan, {evidenceDir: path.join(f.directory, 'spectrum-package-outside')}), /under project review-evidence/);
  assert.deepEqual(await tree(f.sourceRoot), before);
  const external = path.join(f.directory, 'external-evidence'); await fs.mkdir(external);
  await fs.mkdir(path.join(f.sourceRoot, 'review-evidence'));
  await fs.symlink(external, f.evidenceDir, 'junction');
  const linkedBefore = await tree(f.sourceRoot);
  await assert.rejects(f.apply(plan), /Link or junction/);
  assert.deepEqual(await tree(f.sourceRoot), linkedBefore);
  assert.deepEqual(await tree(external), {});
  await write(f.backendDir, 'profile/beefweb/config.json', JSON.stringify({...f.manifest.configuration, port: 8880}));
  assert.throws(f.plan, /Dedicated backend configuration/);
});

test('temporary apply preserves all old backend/data/auth bytes and UUID; explicit rollback restores exact old manifest and leaves evidence', async t => {
  const f = await fixture(t), plan = f.plan(), before = await tree(f.backendDir), outsideBefore = await tree(path.join(f.sourceRoot, 'data'));
  const result = await f.apply(plan);
  assert.equal(result.backendId, f.manifest.backendId);
  assert.equal(result.addedFiles.length, 4);
  assert.equal(result.oldBackendBytesUnchanged, true);
  assert.equal(result.currentDataTouched, false);
  const manifest = JSON.parse(await fs.readFile(path.join(f.backendDir, 'backend-manifest.json')));
  assert.deepEqual(manifest.files.slice(0, f.manifest.files.length), f.manifest.files);
  assert.deepEqual(await tree(path.join(f.sourceRoot, 'data')), outsideBefore);
  await assert.rejects(fs.stat(path.join(f.backendDir, INCOMPLETE_MARKER)), {code: 'ENOENT'});
  assert.equal((JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')))).phase, 'completed');
  const restored = await f.rollback(plan);
  assert.equal(restored.rolledBack, true);
  assert.deepEqual(await tree(f.backendDir), before);
  assert.deepEqual(await tree(path.join(f.sourceRoot, 'data')), outsideBefore);
  assert.equal((JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')))).phase, 'rolled-back');
  assert.equal(hash(await fs.readFile(path.join(f.evidenceDir, 'before/backend-manifest.json'))), plan.beforeManifestSha256);
});

test('partial temporary apply retains marker, backup and failure evidence and can be rolled back without touching old state', async t => {
  const f = await fixture(t), plan = f.plan(), before = await tree(f.backendDir);
  await assert.rejects(f.apply(plan, {onPhase: async phase => {if (phase === 'file:foo_still_spectrum.dll') throw new Error('injected copy interruption');}}), /injected copy interruption/);
  const failed = JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')));
  assert.equal(failed.phase, 'failed'); assert.equal(failed.failedPhase, 'installing-files');
  assert.ok(await fs.stat(path.join(f.backendDir, INCOMPLETE_MARKER)));
  assert.equal(hash(await fs.readFile(path.join(f.evidenceDir, 'before/backend-manifest.json'))), plan.beforeManifestSha256);
  assert.throws(f.plan, /incomplete spectrum transaction/);
  await f.rollback(plan);
  assert.deepEqual(await tree(f.backendDir), before);
});

test('post-commit failure is recoverable; interrupted rollback retains its marker and detailed failure journal for a reviewed retry', async t => {
  const f = await fixture(t), plan = f.plan(), before = await tree(f.backendDir);
  await assert.rejects(f.apply(plan, {onPhase: async phase => {if (phase === 'manifest-committed') throw new Error('injected post-commit interruption');}}), /post-commit interruption/);
  assert.equal(hash(await fs.readFile(path.join(f.backendDir, 'backend-manifest.json'))), plan.afterManifestSha256);
  await assert.rejects(f.rollback(plan, {onPhase: async phase => {if (phase === 'manifest-restored') throw new Error('injected rollback interruption');}}), /rollback interruption/);
  assert.ok(await fs.stat(path.join(f.backendDir, INCOMPLETE_MARKER)));
  assert.equal((JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')))).phase, 'rollback-failed');
  await f.rollback(plan);
  assert.deepEqual(await tree(f.backendDir), before);
});

test('rollback refuses running state, modified installed files and changed backup with zero additional writes', async t => {
  const f = await fixture(t), plan = f.plan(); await f.apply(plan);
  let before = await tree(f.sourceRoot);
  await assert.rejects(f.rollback(plan, {processInspector: async () => [{name: 'Still.exe', executablePath: path.join(f.sourceRoot, 'Still.exe')}]}), /running/);
  assert.deepEqual(await tree(f.sourceRoot), before);
  const installedDll = path.join(f.backendDir, COMPONENT_DIRECTORY, 'foo_still_spectrum.dll');
  await fs.appendFile(installedDll, 'unknown bytes'); before = await tree(f.sourceRoot);
  await assert.rejects(f.rollback(plan), /Component changed/);
  assert.deepEqual(await tree(f.sourceRoot), before);
  await fs.writeFile(installedDll, await fs.readFile(path.join(f.sourceRoot, 'native/foobar-spectrum/package/foo_still_spectrum.dll')));
  await fs.appendFile(path.join(f.evidenceDir, 'before/backend-manifest.json'), 'tampered backup'); before = await tree(f.sourceRoot);
  await assert.rejects(f.rollback(plan), /backup integrity/);
  assert.deepEqual(await tree(f.sourceRoot), before);
});

test('release packaging refuses a source without migration and accepts only actual exact four files plus reviewed manifest provenance', async t => {
  const f = await fixture(t), before = await tree(f.sourceRoot);
  await assert.rejects(verifyPrivateBackend(f.backendDir, {sourceRoot: f.sourceRoot}), /separately reviewed four-file/);
  assert.deepEqual(await tree(f.sourceRoot), before);
  const plan = f.plan(); await f.apply(plan);
  const manifest = await verifyPrivateBackend(f.backendDir, {sourceRoot: f.sourceRoot});
  const status = await verifySpectrumBackend(f.backendDir, manifest, {sourceRoot: f.sourceRoot});
  assert.equal(status.installed, true); assert.equal(status.actualFilesVerified, true);
  assert.equal(status.manifestSha256, plan.afterManifestSha256);
  await write(f.backendDir, INCOMPLETE_MARKER, 'incomplete');
  await assert.rejects(verifyPrivateBackend(f.backendDir, {sourceRoot: f.sourceRoot}), /incomplete spectrum component/);
  await fs.unlink(path.join(f.backendDir, INCOMPLETE_MARKER));
  await write(f.backendDir, `${COMPONENT_DIRECTORY}/unknown.dll`, 'unknown unreviewed DLL');
  await assert.rejects(verifySpectrumBackend(f.backendDir, manifest, {sourceRoot: f.sourceRoot}), /unknown or linked entry/);
});

test('backend reuse never installs spectrum implicitly and validates real component hashes again before accepting reuse', async t => {
  const f = await fixture(t), target = path.join(f.sourceRoot, 'dist/Still-V2-preview-win32-x64/backend/foobar2000');
  await fs.mkdir(path.dirname(target), {recursive: true}); await fs.cp(f.backendDir, target, {recursive: true});
  const targetManifest = {...f.manifest, backendId: '66666666-7777-4888-8999-aaaaaaaaaaaa', destinationDir: target};
  await write(target, 'backend-manifest.json', JSON.stringify(targetManifest, null, 2));
  const plan = f.plan(); await f.apply(plan);
  const options = {sourceRoot: f.sourceRoot, isRunning: async () => false};
  let before = await tree(f.sourceRoot);
  await assert.rejects(copyPrivateBackend(f.backendDir, target, options), /separately reviewed four-file/);
  assert.deepEqual(await tree(f.sourceRoot), before);
  const targetPlan = planSpectrumInstall({sourceRoot: f.sourceRoot, backendDir: target});
  await f.apply(targetPlan, {evidenceDir: path.join(f.sourceRoot, 'review-evidence', 'spectrum-package-target-transaction')});
  before = await tree(f.sourceRoot);
  const reused = await copyPrivateBackend(f.backendDir, target, options);
  assert.equal(reused.reused, true); assert.equal(reused.manifest.backendId, targetManifest.backendId);
  assert.deepEqual(await tree(f.sourceRoot), before);
  await fs.appendFile(path.join(target, COMPONENT_DIRECTORY, 'foo_still_spectrum.dll'), 'tamper');
  const tampered = await tree(f.sourceRoot);
  await assert.rejects(copyPrivateBackend(f.backendDir, target, options), /integrity check/);
  assert.deepEqual(await tree(f.sourceRoot), tampered);
});

test('release manifest lineage rejects any old-entry/UUID/config delta and admits only a controlled fresh package identity', async t => {
  const f = await fixture(t), plan = f.plan();
  const baselines = [{kind: 'source', sha256: plan.beforeManifestSha256, canonicalSha256: hash(JSON.stringify(f.manifest)), backendId: f.manifest.backendId, destinationDir: f.backendDir}];
  const options = {sourceRoot: f.sourceRoot, baselines};
  assert.equal(verifySpectrumManifestLineage(plan.afterManifest, f.delivery, options).oldManifestContentVerified, true);
  for (const alter of [
    value => {value.backendId = '66666666-7777-4888-8999-aaaaaaaaaaaa';},
    value => {value.files[0].bytes++;},
    value => {value.files[0].mutable = true;},
    value => {value.configuration.musicDirs = ['Z:\\unreviewed'];},
    value => {value.untouchedMetadata.nested.push('unreviewed');},
    value => {value.spectrumComponent.extra = true;},
    value => {value.files.at(-1).mode = 'unreviewed';}
  ]) {
    const changed = structuredClone(plan.afterManifest); alter(changed);
    assert.throws(() => verifySpectrumManifestLineage(changed, f.delivery, options), /reviewed|Old backend/);
  }
  const clone = {...plan.afterManifest, backendId: '66666666-7777-4888-8999-aaaaaaaaaaaa', destinationDir: path.join(f.sourceRoot, 'dist/New-package/backend/foobar2000'),
    packagedAt: '2026-11-01T00:00:00.000Z', packagedFromBackendId: f.manifest.backendId};
  assert.equal(verifySpectrumManifestLineage(clone, f.delivery, options).oldManifestContentVerified, true);
  const escaped = {...clone, destinationDir: path.join(f.directory, 'outside/backend/foobar2000')};
  assert.throws(() => verifySpectrumManifestLineage(escaped, f.delivery, options), /unreviewed package identity or destination/);
});

test('CLI rejects an ignored backend selector or mixed rollback arguments before reading or changing any backend', () => {
  for (const args of [['--apply', '--backend', 'target'], ['--rollback', 'unused', '--backend', 'source'], ['--rollback', 'unused', '--evidence-dir', 'unused']]) {
    const result = spawnSync(process.execPath, [path.join(project, 'scripts/install-spectrum-component.js'), ...args], {encoding: 'utf8'});
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, /backend only through the reviewed plan|rollback uses only its recorded backend/);
  }
});

async function interruptedR1Fixture(t, {afterCommit = false} = {}) {
  const f = await fixture(t), reviewedPlan = f.plan();
  const interruption = afterCommit ? 'manifest-committed' : 'file:foo_still_spectrum.dll';
  await assert.rejects(f.apply(reviewedPlan, {onPhase: async phase => {if (phase === interruption) throw new Error('R1 fake interrupted install');}}), /R1 fake interrupted install/);
  const journal = JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')));
  return {...f, reviewedPlan, installed: path.join(f.backendDir, COMPONENT_DIRECTORY, 'foo_still_spectrum.dll'),
    temporary: path.join(f.backendDir, `.spectrum-component-manifest-${journal.transactionId}.json`)};
}
async function assertR1FailureEvidence(f) {
  assert.ok(await fs.stat(path.join(f.backendDir, INCOMPLETE_MARKER)));
  const journal = JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')));
  assert.equal(journal.phase, 'rollback-failed');
  assert.equal(journal.planSha256, planSha256(f.reviewedPlan));
  assert.equal(typeof journal.error, 'string');
  return journal;
}

test('R1: same-name unknown DLL introduced by manifest-restored hook is preserved with marker and failed recovery evidence', async t => {
  const f = await interruptedR1Fixture(t), unknown = Buffer.from('UNKNOWN NEW BYTES MUST BE RETAINED');
  await assert.rejects(f.rollback(f.reviewedPlan, {onPhase: async phase => {if (phase === 'manifest-restored') await fs.writeFile(f.installed, unknown);}}), /Component changed during recovery/);
  assert.deepEqual(await fs.readFile(f.installed), unknown);
  await assertR1FailureEvidence(f);
});

test('R1: same-name replacement inside the final stopped-state await is revalidated before unlink', async t => {
  const f = await interruptedR1Fixture(t), unknown = Buffer.from('UNKNOWN BYTES FROM FINAL STOPPED INSPECTION');
  let armed = false, injected = false;
  await assert.rejects(f.rollback(f.reviewedPlan, {
    onPhase: async phase => {if (phase === 'manifest-restored') armed = true;},
    processInspector: async () => {if (armed && !injected) {injected = true; await fs.writeFile(f.installed, unknown);} return [];}
  }), /Component changed during recovery/);
  assert.equal(injected, true); assert.deepEqual(await fs.readFile(f.installed), unknown);
  await assertR1FailureEvidence(f);
});

test('R1: existing unknown additional filename is retained without deleting the authorized DLL or clearing the marker', async t => {
  const f = await interruptedR1Fixture(t), unknown = path.join(f.backendDir, COMPONENT_DIRECTORY, 'user-added-keep.txt');
  await fs.writeFile(unknown, 'KEEP UNKNOWN USER BYTES');
  await assert.rejects(f.rollback(f.reviewedPlan), /ENOTEMPTY/);
  assert.equal(await fs.readFile(unknown, 'utf8'), 'KEEP UNKNOWN USER BYTES');
  assert.equal(hash(await fs.readFile(f.installed)), f.reviewedPlan.componentFiles[0].sha256);
  await assertR1FailureEvidence(f);
});

for (const role of ['delivery source', 'manifest backup', 'planned manifest backup', 'staged source', 'current manifest', 'old mutable file']) {
  test(`R1: ${role} drift after initial rollback checks is retained and cannot yield successful recovery`, async t => {
    const f = await interruptedR1Fixture(t);
    const targets = {
      'delivery source': path.join(f.sourceRoot, 'native/foobar-spectrum/package/StillSpectrumReader.exe'),
      'manifest backup': path.join(f.evidenceDir, 'before/backend-manifest.json'),
      'planned manifest backup': path.join(f.evidenceDir, 'after-backend-manifest.json'),
      'staged source': path.join(f.evidenceDir, 'stage/foo_still_spectrum.dll'),
      'current manifest': path.join(f.backendDir, 'backend-manifest.json'),
      'old mutable file': path.join(f.backendDir, 'profile/configuration/foo_out_asio.dll.cfg')
    };
    const target = targets[role], unknown = Buffer.from(`UNKNOWN CHANGED ${role}`);
    await assert.rejects(f.rollback(f.reviewedPlan, {onPhase: async phase => {if (phase === 'manifest-restored') await fs.writeFile(target, unknown);}}), /integrity|backup|source|manifest|Old backend bytes changed/i);
    assert.deepEqual(await fs.readFile(target), unknown);
    assert.equal(hash(await fs.readFile(f.installed)), f.reviewedPlan.componentFiles[0].sha256);
    await assertR1FailureEvidence(f);
  });
}

for (const role of ['delivery source', 'manifest backup', 'current manifest']) {
  test(`R1: ${role} drift at the final manifest-restore gate prevents rename and preserves unknown bytes`, async t => {
    const f = await interruptedR1Fixture(t, {afterCommit: true});
    const target = role === 'delivery source' ? path.join(f.sourceRoot, 'native/foobar-spectrum/package/StillSpectrumReader.exe') :
      role === 'manifest backup' ? path.join(f.evidenceDir, 'before/backend-manifest.json') : path.join(f.backendDir, 'backend-manifest.json');
    const unknown = Buffer.from(`UNKNOWN BYTES BEFORE MANIFEST RENAME ${role}`);
    let injected = false;
    await assert.rejects(f.rollback(f.reviewedPlan, {processInspector: async () => {
      const journal = JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')));
      const temporary = await fs.readFile(f.temporary).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
      if (!injected && journal.phase === 'rolling-back' && temporary && hash(temporary) === f.reviewedPlan.beforeManifestSha256) {injected = true; await fs.writeFile(target, unknown);}
      return [];
    }}), /integrity|backup|source|manifest/i);
    assert.equal(injected, true); assert.deepEqual(await fs.readFile(target), unknown);
    if (role !== 'current manifest') assert.equal(hash(await fs.readFile(path.join(f.backendDir, 'backend-manifest.json'))), f.reviewedPlan.afterManifestSha256);
    assert.equal(hash(await fs.readFile(f.temporary)), f.reviewedPlan.beforeManifestSha256);
    assert.equal(hash(await fs.readFile(f.installed)), f.reviewedPlan.componentFiles[0].sha256);
    await assertR1FailureEvidence(f);
  });
}

test('R1: an owned manifest staging filename replaced during the final stopped check is never unlinked', async t => {
  const f = await interruptedR1Fixture(t, {afterCommit: true});
  await fs.writeFile(f.temporary, await fs.readFile(path.join(f.evidenceDir, 'after-backend-manifest.json')));
  const unknown = Buffer.from('UNKNOWN SAME-NAME MANIFEST STAGE');
  let injected = false;
  await assert.rejects(f.rollback(f.reviewedPlan, {processInspector: async () => {
    const journal = JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')));
    if (!injected && journal.phase === 'rolling-back') {injected = true; await fs.writeFile(f.temporary, unknown);}
    return [];
  }}), /Manifest staging file changed during recovery/);
  assert.equal(injected, true); assert.deepEqual(await fs.readFile(f.temporary), unknown);
  assert.equal(hash(await fs.readFile(path.join(f.backendDir, 'backend-manifest.json'))), f.reviewedPlan.afterManifestSha256);
  await assertR1FailureEvidence(f);
});

test('R1: source drift at the final marker-removal gate retains the marker and records failure after file restoration', async t => {
  const f = await interruptedR1Fixture(t), source = path.join(f.sourceRoot, 'native/foobar-spectrum/package/StillSpectrumReader.exe');
  const unknown = Buffer.from('UNKNOWN SOURCE BEFORE MARKER CLEAR');
  let injected = false;
  await assert.rejects(f.rollback(f.reviewedPlan, {processInspector: async () => {
    const journal = JSON.parse(await fs.readFile(path.join(f.evidenceDir, 'transaction.json')));
    if (!injected && journal.phase === 'rolled-back') {injected = true; await fs.writeFile(source, unknown);}
    return [];
  }}), /integrity failed/);
  assert.equal(injected, true); assert.deepEqual(await fs.readFile(source), unknown);
  assert.equal(hash(await fs.readFile(path.join(f.backendDir, 'backend-manifest.json'))), f.reviewedPlan.beforeManifestSha256);
  const journal = await assertR1FailureEvidence(f);
  assert.equal(journal.failedPhase, 'rolled-back');
  assert.equal(Object.hasOwn(journal, 'rolledBackAt'), false);
});
