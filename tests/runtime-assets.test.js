'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {sha256, readRegularBytes} = require('../scripts/backend-baselines');
const {RUNTIME_REGISTRY_PATH, RUNTIME_ASSETS, loadRuntimeAssetRegistry, validateRuntimeAssetRegistry, verifyRuntimeAssets,
  assertRuntimeAssetSnapshot, assertRuntimeAssetHashes} = require('../scripts/runtime-assets');
const {planRuntimeAssetCandidate, main: promotionMain} = require('../scripts/promote-runtime-assets');
const {CLIENT_SOURCE_PATH, CLIENT_REVISION_PATH, NATIVE_MANIFEST_SHA256, ORIGINAL_CLIENT_SOURCE} = require('../scripts/spectrum-client-revision');
const {copyRuntimeAssets, copySpectrumClientRevision, copySpectrumRuntime, createPackageIncompleteMarker, finalizePackage: finalizePackageImpl, frozenSourceSnapshot, PACKAGE_INCOMPLETE_TEXT} = require('../scripts/package');
const {build} = require('../scripts/build');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const clone = value => JSON.parse(JSON.stringify(value));
function finalizePackage(f, options) {return finalizePackageImpl(f, {verifyClientRevision: f.verifyClientRevision, ...options});}
function copyClientRevision(f) {return copySpectrumClientRevision(f.sourceRoot, f.appDirectory, {verifyClientRevision: f.verifyClientRevision});}
async function write(root, relative, bytes) {
  const filename = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(filename), {recursive: true}); await fsp.writeFile(filename, bytes);
}
async function tree(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name), relative = path.relative(root, filename).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) result[relative] = `link:${await fsp.readlink(filename)}`;
      else if (entry.isDirectory()) {result[`${relative}/`] = 'directory'; await visit(filename);}
      else result[relative] = sha256(await fsp.readFile(filename));
    }
  }
  await visit(root); return result;
}
async function fixture(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'still-runtime-assets-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(directory).startsWith('still-runtime-assets-'));
    await fsp.rm(directory, {recursive: true, force: true});
  });
  const sourceRoot = path.join(directory, 'source'), appDirectory = path.join(directory, 'app');
  const raw = {backendOutputPolicy: Buffer.from(json({fixture: 'SYNTHETIC JSON; NOT RUNTIME AUTHORIZATION'})),
    backendLauncher: Buffer.from('SYNTHETIC NONEXECUTABLE LAUNCHER BYTES; NEVER RUN')};
  const registry = {schemaVersion: 1, assets: Object.fromEntries(Object.entries(RUNTIME_ASSETS).map(([key, value]) => [key, {relativePath: value.relativePath, sha256: sha256(raw[key])}]))};
  for (const [key, value] of Object.entries(RUNTIME_ASSETS)) await write(sourceRoot, value.relativePath, raw[key]);
  await write(sourceRoot, RUNTIME_REGISTRY_PATH, json(registry));
  const clientBytes = Buffer.from('SYNTHETIC CURRENT CLIENT SOURCE; NEVER EXECUTE'), legacyClientBytes = Buffer.from('SYNTHETIC EXACT LEGACY CLIENT VECTOR; NEVER EXECUTE');
  const clientSource = {relativePath: CLIENT_SOURCE_PATH, bytes: clientBytes.length, sha256: sha256(clientBytes)};
  const clientRecord = {schemaVersion: 1, nativeManifestSha256: NATIVE_MANIFEST_SHA256, originalClientSha256: ORIGINAL_CLIENT_SOURCE.sha256, clientSource, proofHash: 'f'.repeat(64)};
  const recordBytes = Buffer.from(json(clientRecord)), rawSha256 = sha256(recordBytes);
  const spectrumClient = {clientSource, clientRevision: {recordPath: CLIENT_REVISION_PATH, rawSha256, proofHash: clientRecord.proofHash,
    nativeManifestSha256: NATIVE_MANIFEST_SHA256, originalClientSha256: ORIGINAL_CLIENT_SOURCE.sha256}, clientHashes: {[CLIENT_REVISION_PATH]: rawSha256, [CLIENT_SOURCE_PATH]: clientSource.sha256}};
  const legacySpectrumClient = {clientSource: {relativePath: CLIENT_SOURCE_PATH, bytes: legacyClientBytes.length, sha256: sha256(legacyClientBytes)}, clientRevision: null,
    clientHashes: {[CLIENT_SOURCE_PATH]: sha256(legacyClientBytes)}};
  await write(sourceRoot, CLIENT_SOURCE_PATH, clientBytes); await write(sourceRoot, CLIENT_REVISION_PATH, recordBytes);
  // This DI verifier is a synthetic known vector. The shared helper's separate
  // suite owns the real pinned revision/legacy vectors and closed-schema checks.
  const verifyClientRevision = candidateRoot => {
    const bytes = readRegularBytes(candidateRoot, CLIENT_SOURCE_PATH, 1024 * 1024);
    if (bytes.equals(legacyClientBytes)) return clone(legacySpectrumClient);
    if (sha256(readRegularBytes(candidateRoot, CLIENT_REVISION_PATH, 8192)) !== rawSha256) throw new Error('SYNTHETIC client revision record changed');
    if (!bytes.equals(clientBytes)) throw new Error('SYNTHETIC current client source changed');
    return clone(spectrumClient);
  };
  await fsp.mkdir(path.join(sourceRoot, 'review-evidence'));
  const prepareApp = async () => {
    for (const relative of [RUNTIME_REGISTRY_PATH, RUNTIME_ASSETS.backendOutputPolicy.relativePath]) await write(appDirectory, relative, await fsp.readFile(path.join(sourceRoot, relative)));
  };
  const candidate = extra => planRuntimeAssetCandidate({sourceRoot, asset: 'launcher', expectedCurrentSha256: loadRuntimeAssetRegistry(sourceRoot).registrySha256, ...extra});
  const prepareClientApp = () => write(appDirectory, CLIENT_SOURCE_PATH, clientBytes);
  return {directory, sourceRoot, appDirectory, registry, raw, prepareApp, candidate, prepareClientApp, verifyClientRevision,
    spectrumClient, legacySpectrumClient, clientBytes, legacyClientBytes, recordBytes};
}
async function prepareBuild(f) {
  for (const relative of ['src/main/entry.js', 'src/main/main.js', 'src/main/preload.js', 'src/main/settings.js', 'src/main/foobar.js', 'src/main/backend.js',
    'src/main/playback-coordinator.js', 'src/main/library.js', 'src/main/lyrics.js', 'scripts/fixture.js',
    'docs/foobar-install-restore.md', 'scripts/foobar-coreaudio-probe.cs']) await write(f.sourceRoot, relative, 'SYNTHETIC STATIC FIXTURE');
  await write(f.sourceRoot, 'src/renderer/index.html', '<html><body>fixture</body></html>');
  await write(f.sourceRoot, 'scripts/foobar-coreaudio-probe.exe', 'MZ SYNTHETIC; NEVER RUN');
  const baselineEntry = (kind, suffix) => ({sha256: suffix.repeat(64), canonicalSha256: suffix.repeat(64), backendId: kind === 'source' ? '11111111-2222-4333-8444-555555555555' : '66666666-7777-4888-8999-aaaaaaaaaaaa',
    destinationRelativePath: kind === 'source' ? 'backend/foobar2000' : 'dist/Still-V2-preview-win32-x64/backend/foobar2000'});
  await write(f.sourceRoot, 'manifests/backend-baselines.json', json({schemaVersion: 1, purpose: 'still-private-backend-spectrum-baselines',
    baselines: {source: baselineEntry('source', 'a'), target: baselineEntry('target', 'b')}}));
  for (const filename of ['StillAppleHost.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'official-bridge.js', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt']) {
    await write(f.sourceRoot, `native/apple-host/bin/${filename}`, /\.(exe|dll)$/.test(filename) ? 'MZ SYNTHETIC; NEVER LOAD' : 'SYNTHETIC NOTICE');
  }
}
async function finalizationFixture(t) {
  const f = await fixture(t); await f.prepareApp(); await copyRuntimeAssets(f.sourceRoot, f.appDirectory);
  await f.prepareClientApp();
  const spectrumClient = await copySpectrumClientRevision(f.sourceRoot, f.appDirectory, {verifyClientRevision: f.verifyClientRevision});
  const outputDirectory = path.join(f.directory, 'package'), appDirectory = path.join(outputDirectory, 'resources/app');
  await fsp.mkdir(path.dirname(appDirectory), {recursive: true}); await fsp.rename(f.appDirectory, appDirectory);
  const ownedMarker = await createPackageIncompleteMarker(outputDirectory);
  const runtimeAssets = verifyRuntimeAssets(f.sourceRoot), hashes = Object.fromEntries(Object.entries(runtimeAssets.hashes).map(([relative, hash]) => [`resources/app/${relative}`, hash]));
  for (const [relative, sha256] of Object.entries(spectrumClient.clientHashes)) hashes[`resources/app/${relative}`] = sha256;
  const buildInfo = {fixture: true, runtimeAssets: {...runtimeAssets, launcherRuntimeValidated: false}, spectrum: {...spectrumClient}, hashes, sourceFrozenSnapshot: frozenSourceSnapshot(hashes)};
  return {...f, outputDirectory, appDirectory, runtimeAssets, buildInfo, ownedMarker, spectrumClient};
}
function afterMetadataStage(t, mutate, phase = 'sync') {
  const originalOpen = fsp.open; let calls = 0;
  t.mock.method(fsp, 'open', async function (filename, ...args) {
    const file = await originalOpen.call(this, filename, ...args);
    if (path.basename(filename).startsWith('.package-metadata-')) {
      const originalOperation = file[phase];
      t.mock.method(file, phase, async function () {await originalOperation.call(this); calls++; await mutate(filename);});
    }
    return file;
  });
  return () => calls;
}

for (const relative of ['BUILD-INFO.json', '.package-incomplete']) {
  test(`metadata repair: preexisting ${relative} hardlink rejects before writer and preserves external alias`, async t => {
    const f = await finalizationFixture(t), target = path.join(f.outputDirectory, relative), alias = path.join(f.directory, 'external-metadata-alias');
    const unknown = Buffer.from(`KEEP PREEXISTING EXTERNAL ${relative} BYTES`);
    await fsp.writeFile(target, unknown); await fsp.link(target, alias);
    const original = fsp.writeFile, originalOpen = fsp.open; let writes = 0, failure;
    t.mock.method(fsp, 'writeFile', async function (...args) {writes++; return original.apply(this, args);});
    t.mock.method(fsp, 'open', async function (...args) {writes++; return originalOpen.apply(this, args);});
    try {await (relative === 'BUILD-INFO.json' ? finalizePackage(f) : createPackageIncompleteMarker(f.outputDirectory));} catch (error) {failure = error;}
    assert.deepEqual(await fsp.readFile(alias), unknown, 'An external alias must never be truncated');
    assert.equal(writes, 0, 'Unsafe metadata must be rejected before invoking any writer');
    assert.match(failure?.message || '', /unlinked regular/);
    assert.deepEqual(await fsp.readFile(target), unknown);
  });
}

test('client revision integration: copies exactly the fixed record and reports the effective current client', async t => {
  const f = await fixture(t); await f.prepareClientApp();
  await write(f.sourceRoot, 'manifests/backend-baselines.json', 'DO NOT COPY BASELINES');
  await write(f.sourceRoot, 'manifests/unknown/keep.json', 'DO NOT COPY UNKNOWN MANIFESTS');
  const before = await tree(f.sourceRoot), inputClient = await fsp.readFile(path.join(f.appDirectory, CLIENT_SOURCE_PATH));
  const copied = await copyClientRevision(f); assert.deepEqual(copied, f.spectrumClient);
  assert.deepEqual(Object.keys(await tree(f.appDirectory)).filter(name => !name.endsWith('/')).sort(), [CLIENT_REVISION_PATH, CLIENT_SOURCE_PATH].sort());
  assert.deepEqual(await fsp.readFile(path.join(f.appDirectory, CLIENT_REVISION_PATH)), f.recordBytes);
  assert.deepEqual(await fsp.readFile(path.join(f.appDirectory, CLIENT_SOURCE_PATH)), inputClient); assert.deepEqual(await tree(f.sourceRoot), before);
  const delivery = {manifestSha256: NATIVE_MANIFEST_SHA256, applicationRuntimeFiles: [], ...f.spectrumClient, runtimeNotValidated: []};
  const runtime = await copySpectrumRuntime(f.sourceRoot, f.appDirectory, {verifySpectrum: () => delivery, verifyClientRevision: f.verifyClientRevision});
  assert.deepEqual(runtime.clientSource, f.spectrumClient.clientSource); assert.notEqual(runtime.clientSource.sha256, ORIGINAL_CLIENT_SOURCE.sha256);
  assert.deepEqual(runtime.clientRevision, f.spectrumClient.clientRevision); assert.deepEqual(runtime.clientHashes, f.spectrumClient.clientHashes);
  assert.equal(runtime.deliveryManifestSha256, NATIVE_MANIFEST_SHA256);
});

test('client revision integration: unknown native runtime destination rejects before the revision record is copied', async t => {
  const f = await fixture(t); await f.prepareClientApp(); await write(f.appDirectory, 'native/foobar-spectrum/keep-unknown.txt', 'KEEP UNKNOWN NATIVE INPUT');
  const before = await tree(f.appDirectory), delivery = {manifestSha256: NATIVE_MANIFEST_SHA256, applicationRuntimeFiles: [], ...f.spectrumClient, runtimeNotValidated: []};
  t.mock.method(fsp, 'open', () => assert.fail('Unknown native destination must block revision staging'));
  await assert.rejects(copySpectrumRuntime(f.sourceRoot, f.appDirectory, {verifySpectrum: () => delivery, verifyClientRevision: f.verifyClientRevision}), /Unknown spectrum runtime destination/);
  assert.deepEqual(await tree(f.appDirectory), before);
});

test('client revision integration: native destination changed during record staging is retained with the incomplete marker', async t => {
  const f = await finalizationFixture(t), unknown = path.join(f.appDirectory, 'native/foobar-spectrum/keep-unknown.txt');
  const delivery = {manifestSha256: NATIVE_MANIFEST_SHA256, applicationRuntimeFiles: [], ...f.spectrumClient, runtimeNotValidated: []};
  afterMetadataStage(t, async () => {await fsp.mkdir(path.dirname(unknown), {recursive: true}); await fsp.writeFile(unknown, 'KEEP LATE UNKNOWN NATIVE ENTRY');});
  await assert.rejects(copySpectrumRuntime(f.sourceRoot, f.appDirectory, {verifySpectrum: () => delivery, verifyClientRevision: f.verifyClientRevision}), /Unknown spectrum runtime destination/);
  assert.equal(await fsp.readFile(unknown, 'utf8'), 'KEEP LATE UNKNOWN NATIVE ENTRY');
  assert.deepEqual(await fsp.readFile(path.join(f.appDirectory, CLIENT_REVISION_PATH)), f.recordBytes);
  assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
});

for (const invalid of ['missing source record', 'changed source record', 'changed source client', 'different copied client', 'different copied record', 'unknown destination', 'leftover stage']) {
  test(`client revision integration: ${invalid} rejects before writes and retains all input bytes`, async t => {
    const f = await fixture(t); await f.prepareClientApp();
    if (invalid === 'missing source record') await fsp.unlink(path.join(f.sourceRoot, CLIENT_REVISION_PATH));
    else if (invalid === 'changed source record') await fsp.appendFile(path.join(f.sourceRoot, CLIENT_REVISION_PATH), '\n');
    else if (invalid === 'changed source client') await fsp.appendFile(path.join(f.sourceRoot, CLIENT_SOURCE_PATH), 'CHANGED');
    else if (invalid === 'different copied client') await fsp.appendFile(path.join(f.appDirectory, CLIENT_SOURCE_PATH), 'CHANGED');
    else if (invalid === 'different copied record') await write(f.appDirectory, CLIENT_REVISION_PATH, 'KEEP UNKNOWN RECORD');
    else await write(f.appDirectory, `manifests/${invalid === 'leftover stage' ? '.package-metadata-unknown.tmp' : 'unknown.json'}`, 'KEEP UNKNOWN DESTINATION');
    const before = await tree(f.appDirectory);
    t.mock.method(fsp, 'open', () => assert.fail('Invalid client revision must not open a writable stage'));
    await assert.rejects(copyClientRevision(f), /ENOENT|changed|differs|unknown/i);
    assert.deepEqual(await tree(f.appDirectory), before);
  });
}

for (const kind of ['hardlink', 'symlink']) {
  test(`client revision integration: preexisting record ${kind} preserves its outside alias with zero writer calls`, async t => {
    const f = await fixture(t); await f.prepareClientApp();
    const alias = path.join(f.directory, 'external-client-record'), target = path.join(f.appDirectory, CLIENT_REVISION_PATH);
    await fsp.writeFile(alias, f.recordBytes); await fsp.mkdir(path.dirname(target));
    if (kind === 'hardlink') await fsp.link(alias, target); else await fsp.symlink(alias, target, 'file');
    t.mock.method(fsp, 'open', () => assert.fail('Linked client record must not open a writable stage'));
    await assert.rejects(copyClientRevision(f), /unlinked regular|unknown/i);
    assert.deepEqual(await fsp.readFile(alias), f.recordBytes); assert.deepEqual(await fsp.readFile(target), f.recordBytes);
  });
}

for (const drifting of ['source record', 'source client', 'copied client', 'unknown destination', 'late hardlink']) {
  test(`client revision integration: ${drifting} during stage fsync prevents publication without cleanup`, async t => {
    const f = await fixture(t); await f.prepareClientApp(); let changed;
    const target = path.join(f.appDirectory, CLIENT_REVISION_PATH), alias = path.join(f.directory, 'external-late-client-record');
    if (drifting === 'late hardlink') await fsp.writeFile(alias, 'KEEP LATE CLIENT RECORD ALIAS');
    const calls = afterMetadataStage(t, async () => {
      if (drifting === 'late hardlink') await fsp.link(alias, target);
      else if (drifting === 'unknown destination') {changed = path.join(f.appDirectory, 'manifests/keep-unknown.json'); await fsp.writeFile(changed, 'KEEP UNKNOWN MANIFEST');}
      else {changed = path.join(drifting === 'copied client' ? f.appDirectory : f.sourceRoot, drifting === 'source record' ? CLIENT_REVISION_PATH : CLIENT_SOURCE_PATH); await fsp.appendFile(changed, 'KEEP DRIFT BYTES');}
    });
    await assert.rejects(copyClientRevision(f), /changed|unknown|unlinked regular/i); assert.equal(calls(), 1);
    const stages = (await fsp.readdir(path.dirname(target))).filter(name => name.startsWith('.package-metadata-')); assert.equal(stages.length, 1);
    assert.deepEqual(await fsp.readFile(path.join(path.dirname(target), stages[0])), f.recordBytes);
    if (drifting === 'late hardlink') assert.equal(await fsp.readFile(alias, 'utf8'), 'KEEP LATE CLIENT RECORD ALIAS');
    else {await assert.rejects(fsp.stat(target), {code: 'ENOENT'}); assert.match(await fsp.readFile(changed, 'utf8'), /KEEP/);}
  });
}

test('client revision integration: a replacement manifests directory retains both paths and the owned stage', async t => {
  const f = await fixture(t); await f.prepareClientApp(); const directory = path.join(f.appDirectory, 'manifests'), saved = path.join(f.directory, 'saved-original-manifests');
  afterMetadataStage(t, async () => {
    await fsp.rename(directory, saved); await fsp.mkdir(directory); await fsp.writeFile(path.join(f.appDirectory, CLIENT_REVISION_PATH), 'KEEP REPLACEMENT RECORD');
  }, 'close');
  await assert.rejects(copyClientRevision(f), /ancestor changed/);
  assert.equal(await fsp.readFile(path.join(f.appDirectory, CLIENT_REVISION_PATH), 'utf8'), 'KEEP REPLACEMENT RECORD');
  const stages = (await fsp.readdir(saved)).filter(name => name.startsWith('.package-metadata-')); assert.equal(stages.length, 1);
  assert.deepEqual(await fsp.readFile(path.join(saved, stages[0])), f.recordBytes);
});

test('client revision integration: exact legacy vector omits the record and rejects a leftover current record', async t => {
  const f = await fixture(t); await fsp.writeFile(path.join(f.sourceRoot, CLIENT_SOURCE_PATH), f.legacyClientBytes);
  await fsp.unlink(path.join(f.sourceRoot, CLIENT_REVISION_PATH)); await write(f.appDirectory, CLIENT_SOURCE_PATH, f.legacyClientBytes);
  const before = await tree(f.appDirectory); assert.deepEqual(await copyClientRevision(f), f.legacySpectrumClient); assert.deepEqual(await tree(f.appDirectory), before);
  await write(f.appDirectory, CLIENT_REVISION_PATH, f.recordBytes); const withRecord = await tree(f.appDirectory);
  t.mock.method(fsp, 'open', () => assert.fail('Legacy package must never write a revision record'));
  await assert.rejects(copyClientRevision(f), /must omit/); assert.deepEqual(await tree(f.appDirectory), withRecord);
});

test('client revision integration: sourceFrozen includes the fixed revision record and excludes other manifests', async t => {
  const f = await fixture(t), hashes = Object.fromEntries(Object.entries(f.spectrumClient.clientHashes).map(([relative, hash]) => [`resources/app/${relative}`, hash]));
  const frozen = frozenSourceSnapshot(hashes);
  assert.notEqual(frozenSourceSnapshot({...hashes, [`resources/app/${CLIENT_REVISION_PATH}`]: '0'.repeat(64)}), frozen);
  assert.equal(frozenSourceSnapshot({...hashes, 'resources/app/manifests/DO-NOT-INCLUDE.json': '0'.repeat(64)}), frozen);
  delete hashes[`resources/app/${CLIENT_REVISION_PATH}`]; assert.notEqual(frozenSourceSnapshot(hashes), frozen);
});

for (const side of ['source', 'package']) for (const relative of [CLIENT_REVISION_PATH, CLIENT_SOURCE_PATH]) {
  test(`client revision integration: ${side} ${relative} drift during BUILD await retains incomplete marker and unknown bytes`, async t => {
    const f = await finalizationFixture(t), target = path.join(side === 'source' ? f.sourceRoot : f.appDirectory, relative);
    const unknown = Buffer.concat([await fsp.readFile(target), Buffer.from('\nKEEP UNKNOWN REVISION DRIFT')]);
    await assert.rejects(finalizePackage(f, {writeBuildInfo: async (_filename, _bytes, publish) => {
      const owned = await publish(); await fsp.writeFile(target, unknown); return owned;
    }}), /client.*changed/i);
    assert.deepEqual(await fsp.readFile(target), unknown); assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
  });
}

for (const field of ['old clientSource', 'revision raw hash', 'revision proof', 'clientHashes', 'omitted record hash', 'old top-level client hash']) {
  test(`client revision integration: incorrect ${field} metadata blocks the BUILD writer`, async t => {
    const f = await finalizationFixture(t);
    if (field === 'old clientSource') f.buildInfo.spectrum.clientSource = {...ORIGINAL_CLIENT_SOURCE};
    else if (field === 'revision raw hash') f.buildInfo.spectrum.clientRevision.rawSha256 = '0'.repeat(64);
    else if (field === 'revision proof') f.buildInfo.spectrum.clientRevision.proofHash = '0'.repeat(64);
    else if (field === 'clientHashes') f.buildInfo.spectrum.clientHashes[CLIENT_SOURCE_PATH] = ORIGINAL_CLIENT_SOURCE.sha256;
    else if (field === 'omitted record hash') delete f.buildInfo.hashes[`resources/app/${CLIENT_REVISION_PATH}`];
    else f.buildInfo.hashes[`resources/app/${CLIENT_SOURCE_PATH}`] = ORIGINAL_CLIENT_SOURCE.sha256;
    f.buildInfo.sourceFrozenSnapshot = frozenSourceSnapshot(f.buildInfo.hashes); const before = await tree(f.outputDirectory); let writes = 0;
    await assert.rejects(finalizePackage(f, {writeBuildInfo: () => {writes++; assert.fail('Wrong revision metadata must not reach BUILD writer');}}), /spectrum client|snapshot/i);
    assert.equal(writes, 0); assert.deepEqual(await tree(f.outputDirectory), before);
  });
}

test('client revision integration: on-disk BUILD revision proof alteration is retained with incomplete marker', async t => {
  const f = await finalizationFixture(t); let unknown;
  await assert.rejects(finalizePackage(f, {writeBuildInfo: async (filename, bytes, publish) => {
    const owned = await publish(), altered = JSON.parse(bytes); altered.spectrum.clientRevision.proofHash = '0'.repeat(64);
    unknown = Buffer.from(json(altered)); await fsp.writeFile(filename, unknown); return owned;
  }}), /BUILD-INFO/);
  assert.deepEqual(await fsp.readFile(path.join(f.outputDirectory, 'BUILD-INFO.json')), unknown);
  assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
});

test('client revision integration: a legacy package finalizes only with omitted record and exact legacy BUILD metadata', async t => {
  const f = await finalizationFixture(t);
  for (const candidateRoot of [f.sourceRoot, f.appDirectory]) {await fsp.writeFile(path.join(candidateRoot, CLIENT_SOURCE_PATH), f.legacyClientBytes); await fsp.unlink(path.join(candidateRoot, CLIENT_REVISION_PATH));}
  f.spectrumClient = clone(f.legacySpectrumClient); f.buildInfo.spectrum = clone(f.spectrumClient);
  delete f.buildInfo.hashes[`resources/app/${CLIENT_REVISION_PATH}`]; f.buildInfo.hashes[`resources/app/${CLIENT_SOURCE_PATH}`] = f.spectrumClient.clientSource.sha256;
  f.buildInfo.sourceFrozenSnapshot = frozenSourceSnapshot(f.buildInfo.hashes); await finalizePackage(f);
  await assert.rejects(fsp.stat(path.join(f.outputDirectory, '.package-incomplete')), {code: 'ENOENT'});
  assert.equal(JSON.parse(await fsp.readFile(path.join(f.outputDirectory, 'BUILD-INFO.json'))).spectrum.clientRevision, null);
  await assert.rejects(fsp.stat(path.join(f.appDirectory, CLIENT_REVISION_PATH)), {code: 'ENOENT'});
});

test('client revision integration: missing new-client record fails build before syntax or spectrum actions', async t => {
  const f = await fixture(t); await fsp.unlink(path.join(f.sourceRoot, CLIENT_REVISION_PATH)); const before = await tree(f.sourceRoot);
  assert.throws(() => build({sourceRoot: f.sourceRoot, verifyClientRevision: f.verifyClientRevision,
    runSyntax: () => assert.fail('Missing revision must fail before syntax'), verifySpectrum: () => assert.fail('Missing revision must fail before spectrum')}), /ENOENT/);
  assert.deepEqual(await tree(f.sourceRoot), before);
});

for (const relative of [CLIENT_REVISION_PATH, CLIENT_SOURCE_PATH]) {
  test(`client revision integration: ${relative} drift during syntax cannot report build success`, async t => {
    const f = await fixture(t); await prepareBuild(f); let changed = false;
    assert.throws(() => build({sourceRoot: f.sourceRoot, verifyClientRevision: f.verifyClientRevision,
      runSyntax: () => {if (!changed) {changed = true; fs.appendFileSync(path.join(f.sourceRoot, relative), 'SYNTHETIC BUILD DRIFT');} return {status: 0};},
      verifySpectrum: () => ({applicationRuntimeFiles: [], ...f.spectrumClient})}), /client.*changed/i);
  });
}

for (const relative of ['BUILD-INFO.json', '.package-incomplete']) for (const kind of ['symlink', 'directory']) {
  test(`metadata repair: preexisting ${relative} ${kind} has zero staging writes`, async t => {
    const f = await finalizationFixture(t), target = path.join(f.outputDirectory, relative), alias = path.join(f.directory, 'outside-metadata');
    const unknown = 'KEEP OUTSIDE METADATA'; await fsp.writeFile(alias, unknown);
    if (relative === '.package-incomplete') await fsp.unlink(target);
    if (kind === 'symlink') await fsp.symlink(alias, target, 'file'); else await fsp.mkdir(target);
    const before = await tree(f.outputDirectory);
    t.mock.method(fsp, 'open', () => assert.fail('Unsafe metadata must not open a writable stage'));
    await assert.rejects(relative === 'BUILD-INFO.json' ? finalizePackage(f) : createPackageIncompleteMarker(f.outputDirectory), /link or junction|unlinked regular/i);
    assert.deepEqual(await tree(f.outputDirectory), before); assert.equal(await fsp.readFile(alias, 'utf8'), unknown);
  });
}

test('metadata repair: unknown existing marker bytes reject before any staging write', async t => {
  const f = await finalizationFixture(t), marker = path.join(f.outputDirectory, '.package-incomplete');
  await fsp.writeFile(marker, 'KEEP UNKNOWN MARKER'); const before = await tree(f.outputDirectory);
  t.mock.method(fsp, 'open', () => assert.fail('Unknown marker must not reach stage writer'));
  await assert.rejects(createPackageIncompleteMarker(f.outputDirectory), /unknown bytes/);
  assert.deepEqual(await tree(f.outputDirectory), before);
});

for (const operation of ['create', 'finalize']) {
  test(`metadata repair: redirected output ancestor blocks ${operation} before staging`, async t => {
    const f = await finalizationFixture(t), saved = path.join(f.directory, 'saved-package');
    await fsp.rename(f.outputDirectory, saved); await fsp.symlink(saved, f.outputDirectory, 'junction');
    const before = await tree(saved);
    t.mock.method(fsp, 'open', () => assert.fail('Redirected metadata must not reach stage writer'));
    await assert.rejects(operation === 'create' ? createPackageIncompleteMarker(f.outputDirectory) : finalizePackage(f), /link or junction/i);
    assert.deepEqual(await tree(saved), before);
  });
}

test('metadata repair: replacing an old constant marker establishes a new owned identity', async t => {
  const f = await finalizationFixture(t), marker = path.join(f.outputDirectory, '.package-incomplete');
  const previous = await fsp.lstat(marker, {bigint: true}), ownedMarker = await createPackageIncompleteMarker(f.outputDirectory);
  assert.notEqual((await fsp.lstat(marker, {bigint: true})).ino, previous.ino);
  let writes = 0;
  await assert.rejects(finalizePackage(f, {writeBuildInfo: () => {writes++; assert.fail('Old marker receipt must not reach writer');}}), /identity or bytes changed/);
  assert.equal(writes, 0); assert.equal(await fsp.readFile(marker, 'utf8'), PACKAGE_INCOMPLETE_TEXT);
  await finalizePackage({...f, ownedMarker});
  await assert.rejects(fsp.stat(marker), {code: 'ENOENT'});
});

test('metadata repair: same-byte marker replacement during BUILD await is retained', async t => {
  const f = await finalizationFixture(t), marker = path.join(f.outputDirectory, '.package-incomplete'), saved = path.join(f.directory, 'original-owned-marker');
  await assert.rejects(finalizePackage(f, {writeBuildInfo: async (_filename, _bytes, publish) => {
    const owned = await publish(); await fsp.rename(marker, saved); await fsp.writeFile(marker, PACKAGE_INCOMPLETE_TEXT); return owned;
  }}), /identity or bytes changed/);
  assert.equal(await fsp.readFile(marker, 'utf8'), PACKAGE_INCOMPLETE_TEXT); assert.equal(await fsp.readFile(saved, 'utf8'), PACKAGE_INCOMPLETE_TEXT);
});

test('metadata repair: same-byte BUILD replacement during final await retains the marker and both identities', async t => {
  const f = await finalizationFixture(t), filename = path.join(f.outputDirectory, 'BUILD-INFO.json'), saved = path.join(f.directory, 'original-published-build');
  await assert.rejects(finalizePackage(f, {writeBuildInfo: async (_filename, bytes, publish) => {
    const owned = await publish(); await fsp.rename(filename, saved); await fsp.writeFile(filename, bytes); return owned;
  }}), /identity or bytes changed/);
  assert.deepEqual(await fsp.readFile(filename), await fsp.readFile(saved));
  assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
});

test('metadata repair: an unchanged old regular BUILD is replaced by the verified stage', async t => {
  const f = await finalizationFixture(t), filename = path.join(f.outputDirectory, 'BUILD-INFO.json');
  await fsp.writeFile(filename, 'OLD REGULAR BUILD'); const previous = await fsp.lstat(filename, {bigint: true});
  await finalizePackage(f);
  assert.notEqual((await fsp.lstat(filename, {bigint: true})).ino, previous.ino);
  assert.deepEqual(JSON.parse(await fsp.readFile(filename)), f.buildInfo);
  assert.deepEqual((await fsp.readdir(f.outputDirectory)).filter(name => name.startsWith('.package-metadata-')), []);
});

for (const relative of ['BUILD-INFO.json', '.package-incomplete']) {
  test(`metadata repair: same-byte ${relative} target replacement during stage close is retained`, async t => {
    const f = await finalizationFixture(t), target = path.join(f.outputDirectory, relative), saved = path.join(f.directory, 'saved-original-metadata');
    const previous = relative === 'BUILD-INFO.json' ? 'PREVIOUS BUILD BYTES' : PACKAGE_INCOMPLETE_TEXT;
    if (relative === 'BUILD-INFO.json') await fsp.writeFile(target, previous);
    afterMetadataStage(t, async () => {await fsp.rename(target, saved); await fsp.writeFile(target, previous);}, 'close');
    await assert.rejects(relative === 'BUILD-INFO.json' ? finalizePackage(f) : createPackageIncompleteMarker(f.outputDirectory), /changed during staging/);
    assert.equal(await fsp.readFile(target, 'utf8'), previous); assert.equal(await fsp.readFile(saved, 'utf8'), previous);
    const stages = (await fsp.readdir(f.outputDirectory)).filter(name => name.startsWith('.package-metadata-')); assert.equal(stages.length, 1);
    assert.equal(await fsp.readFile(path.join(f.outputDirectory, stages[0]), 'utf8'), relative === 'BUILD-INFO.json' ? JSON.stringify(f.buildInfo, null, 2) : PACKAGE_INCOMPLETE_TEXT);
  });

  test(`metadata repair: ${relative} hardlink introduced during fsync retains alias, marker and complete stage`, async t => {
    const f = await finalizationFixture(t), target = path.join(f.outputDirectory, relative), alias = path.join(f.directory, 'late-external-alias');
    const unknown = Buffer.from('KEEP LATE EXTERNAL ALIAS'); await fsp.writeFile(alias, unknown);
    const calls = afterMetadataStage(t, async () => {
      if (relative === '.package-incomplete') await fsp.rename(target, path.join(f.directory, 'saved-owned-marker'));
      await fsp.link(alias, target);
    });
    await assert.rejects(relative === 'BUILD-INFO.json' ? finalizePackage(f) : createPackageIncompleteMarker(f.outputDirectory), /unlinked regular/);
    assert.equal(calls(), 1); assert.deepEqual(await fsp.readFile(alias), unknown); assert.deepEqual(await fsp.readFile(target), unknown);
    const stages = (await fsp.readdir(f.outputDirectory)).filter(name => name.startsWith('.package-metadata-')); assert.equal(stages.length, 1);
    assert.equal(await fsp.readFile(path.join(f.outputDirectory, stages[0]), 'utf8'), relative === 'BUILD-INFO.json' ? JSON.stringify(f.buildInfo, null, 2) : PACKAGE_INCOMPLETE_TEXT);
    assert.equal(await fsp.readFile(relative === 'BUILD-INFO.json' ? path.join(f.outputDirectory, '.package-incomplete') : path.join(f.directory, 'saved-owned-marker'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
  });

  test(`metadata repair: failed ${relative} fsync leaves old target and stage intact`, async t => {
    const f = await finalizationFixture(t), target = path.join(f.outputDirectory, relative);
    const previous = relative === 'BUILD-INFO.json' ? 'KEEP OLD BUILD ON FSYNC FAILURE' : PACKAGE_INCOMPLETE_TEXT;
    if (relative === 'BUILD-INFO.json') await fsp.writeFile(target, previous);
    const calls = afterMetadataStage(t, async () => {throw new Error('SYNTHETIC FSYNC FAILURE');});
    await assert.rejects(relative === 'BUILD-INFO.json' ? finalizePackage(f) : createPackageIncompleteMarker(f.outputDirectory), /SYNTHETIC FSYNC FAILURE/);
    assert.equal(calls(), 1); assert.equal(await fsp.readFile(target, 'utf8'), previous);
    assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
    const stages = (await fsp.readdir(f.outputDirectory)).filter(name => name.startsWith('.package-metadata-')); assert.equal(stages.length, 1);
    assert.equal(await fsp.readFile(path.join(f.outputDirectory, stages[0]), 'utf8'), relative === 'BUILD-INFO.json' ? JSON.stringify(f.buildInfo, null, 2) : PACKAGE_INCOMPLETE_TEXT);
  });
}

test('metadata repair: a partial stage write failure retains the original BUILD and incomplete marker', async t => {
  const f = await finalizationFixture(t), target = path.join(f.outputDirectory, 'BUILD-INFO.json'), originalOpen = fsp.open;
  await fsp.writeFile(target, 'KEEP PREVIOUS BUILD'); let stage;
  t.mock.method(fsp, 'open', async function (filename, ...args) {
    const file = await originalOpen.call(this, filename, ...args);
    if (path.basename(filename).startsWith('.package-metadata-')) {
      stage = filename; const originalWrite = file.writeFile;
      t.mock.method(file, 'writeFile', async function () {await originalWrite.call(this, 'RETAIN PARTIAL STAGE'); throw new Error('SYNTHETIC PARTIAL WRITE FAILURE');});
    }
    return file;
  });
  await assert.rejects(finalizePackage(f), /SYNTHETIC PARTIAL WRITE FAILURE/);
  assert.equal(await fsp.readFile(target, 'utf8'), 'KEEP PREVIOUS BUILD'); assert.equal(await fsp.readFile(stage, 'utf8'), 'RETAIN PARTIAL STAGE');
  assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
});

test('metadata repair: changed same-name BUILD bytes during fsync are retained with the complete stage', async t => {
  const f = await finalizationFixture(t), target = path.join(f.outputDirectory, 'BUILD-INFO.json'), unknown = 'KEEP CHANGED BUILD';
  await fsp.writeFile(target, 'OLD BUILD');
  afterMetadataStage(t, async () => {await fsp.writeFile(target, unknown);});
  await assert.rejects(finalizePackage(f), /changed during staging/);
  assert.equal(await fsp.readFile(target, 'utf8'), unknown);
  assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
  assert.equal((await fsp.readdir(f.outputDirectory)).filter(name => name.startsWith('.package-metadata-')).length, 1);
});

test('metadata repair: a same-byte stage replacement cannot be published or deleted', async t => {
  const f = await finalizationFixture(t), saved = path.join(f.directory, 'saved-complete-stage'); let replaced;
  afterMetadataStage(t, async temporary => {
    const bytes = await fsp.readFile(temporary); await fsp.rename(temporary, saved); await fsp.writeFile(temporary, bytes); replaced = temporary;
  });
  await assert.rejects(finalizePackage(f), /stage identity or bytes changed/);
  assert.deepEqual(await fsp.readFile(replaced), await fsp.readFile(saved));
  assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
  await assert.rejects(fsp.stat(path.join(f.outputDirectory, 'BUILD-INFO.json')), {code: 'ENOENT'});
});

test('metadata repair: replacement output directory during stage close retains both directories and unknown metadata', async t => {
  const f = await finalizationFixture(t), saved = path.join(f.directory, 'saved-original-package'), unknown = 'KEEP REPLACEMENT DIRECTORY METADATA';
  afterMetadataStage(t, async () => {
    await fsp.rename(f.outputDirectory, saved); await fsp.mkdir(f.outputDirectory);
    await fsp.writeFile(path.join(f.outputDirectory, 'BUILD-INFO.json'), unknown);
    await fsp.writeFile(path.join(f.outputDirectory, '.package-incomplete'), unknown);
  }, 'close');
  await assert.rejects(finalizePackage(f), /ancestor changed/);
  for (const relative of ['BUILD-INFO.json', '.package-incomplete']) assert.equal(await fsp.readFile(path.join(f.outputDirectory, relative), 'utf8'), unknown);
  assert.equal(await fsp.readFile(path.join(saved, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
  assert.equal((await fsp.readdir(saved)).filter(name => name.startsWith('.package-metadata-')).length, 1);
});

test('runtime asset registry binds only fixed raw files and exact original bytes without defining policy semantics', async t => {
  const f = await fixture(t), before = await tree(f.sourceRoot), snapshot = verifyRuntimeAssets(f.sourceRoot);
  assert.equal(Object.keys(snapshot.hashes).length, 3);
  assert.equal(snapshot.registrySha256, sha256(json(f.registry)));
  for (const key of Object.keys(RUNTIME_ASSETS)) {
    assert.equal(snapshot.assets[key].sha256, sha256(f.raw[key])); assert.ok(Object.isFrozen(snapshot.assets[key]));
  }
  assert.deepEqual(await tree(f.sourceRoot), before);
  await fsp.appendFile(path.join(f.sourceRoot, RUNTIME_ASSETS.backendOutputPolicy.relativePath), '\n');
  assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /reviewed SHA256/);
});

test('runtime registry is closed against missing assets, extra metadata, bad hashes and any path override', async t => {
  const f = await fixture(t), changes = [
    value => {value.schemaVersion = 2;}, value => {value.extra = true;}, value => {delete value.assets.backendLauncher;},
    value => {value.assets.tools = {};}, value => {value.assets.backendLauncher.extra = true;},
    value => {value.assets.backendOutputPolicy.sha256 = 'A'.repeat(64);}, value => {value.assets.backendLauncher.sha256 = 123;},
    value => {value.assets.backendLauncher.relativePath = 'native/backend-job/tools/unreviewed.exe';},
    value => {value.assets.backendLauncher.relativePath = 'D:/private/launcher.exe';},
    value => {value.assets.backendOutputPolicy.relativePath = '../policy.json';}
  ];
  for (const change of changes) {const value = clone(f.registry); change(value); assert.throws(() => validateRuntimeAssetRegistry(value), /runtime|Runtime/);}
  const file = path.join(f.sourceRoot, RUNTIME_REGISTRY_PATH);
  await fsp.writeFile(file, '{}'); assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /runtime/);
  await fsp.unlink(file); assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /ENOENT/);
});

test('runtime asset reads reject missing, malformed, oversized, empty and hardlinked raw inputs', async t => {
  const f = await fixture(t), policy = path.join(f.sourceRoot, RUNTIME_ASSETS.backendOutputPolicy.relativePath), launcher = path.join(f.sourceRoot, RUNTIME_ASSETS.backendLauncher.relativePath);
  await fsp.writeFile(policy, '{'); assert.throws(() => verifyRuntimeAssets(f.sourceRoot), SyntaxError);
  await fsp.writeFile(policy, Buffer.alloc(64 * 1024 + 1)); assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /small unlinked/);
  await fsp.writeFile(policy, f.raw.backendOutputPolicy);
  await fsp.writeFile(launcher, ''); assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /empty/);
  await fsp.writeFile(launcher, Buffer.alloc(RUNTIME_ASSETS.backendLauncher.maxBytes + 1)); assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /small unlinked/);
  await fsp.writeFile(launcher, f.raw.backendLauncher);
  const linked = path.join(f.directory, 'linked-launcher'); await fsp.link(launcher, linked);
  assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /small unlinked/); await fsp.unlink(linked);
  await fsp.unlink(launcher); assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /ENOENT/);
});

test('runtime registry hardlinks and redirected asset ancestors fail closed', async t => {
  const f = await fixture(t), registry = path.join(f.sourceRoot, RUNTIME_REGISTRY_PATH), linked = path.join(f.directory, 'registry-link');
  await fsp.link(registry, linked); assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /small unlinked/); await fsp.unlink(linked);
  const directory = path.join(f.sourceRoot, 'native/backend-job'), saved = path.join(f.directory, 'saved-backend-job');
  await fsp.rename(directory, saved); await fsp.symlink(saved, directory, 'junction');
  assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /link or junction/);
});

test('build rejects an unreviewed or absent launcher before any syntax child or other build action', async t => {
  const f = await fixture(t); let syntaxCalls = 0, spectrumCalls = 0;
  const options = {sourceRoot: f.sourceRoot, verifyClientRevision: f.verifyClientRevision, runSyntax: () => {syntaxCalls++; assert.fail('syntax must follow runtime asset validation');},
    verifySpectrum: () => {spectrumCalls++; assert.fail('spectrum must follow runtime asset validation');}};
  await fsp.appendFile(path.join(f.sourceRoot, RUNTIME_ASSETS.backendLauncher.relativePath), 'changed');
  const before = await tree(f.sourceRoot); assert.throws(() => build(options), /reviewed SHA256/);
  assert.equal(syntaxCalls, 0); assert.equal(spectrumCalls, 0); assert.deepEqual(await tree(f.sourceRoot), before);
  await fsp.unlink(path.join(f.sourceRoot, RUNTIME_ASSETS.backendLauncher.relativePath));
  assert.throws(() => build(options), /ENOENT/); assert.equal(syntaxCalls, 0);
});

test('build DI retains syntax, required files, baseline, renderer, spectrum and Apple static validation', async t => {
  const f = await fixture(t); await prepareBuild(f); const syntaxCalls = [];
  let spectrumCalls = 0;
  const options = {sourceRoot: f.sourceRoot, verifyClientRevision: f.verifyClientRevision, runSyntax: (executable, args) => {assert.equal(executable, process.execPath); assert.equal(args[0], '--check'); syntaxCalls.push(args[1]); return {status: 0};},
    verifySpectrum: root => {assert.equal(root, f.sourceRoot); spectrumCalls++; return {applicationRuntimeFiles: [], ...f.verifyClientRevision(root)};}};
  const result = build(options); assert.ok(syntaxCalls.length > 0); assert.equal(spectrumCalls, 1);
  assertRuntimeAssetSnapshot(verifyRuntimeAssets(f.sourceRoot), result.runtimeAssets);
  await fsp.unlink(path.join(f.sourceRoot, 'src/main/entry.js')); assert.throws(() => build(options), /Required application file missing: src\/main\/entry\.js/);
  await write(f.sourceRoot, 'src/main/entry.js', 'SYNTHETIC');
  await fsp.unlink(path.join(f.sourceRoot, 'src/main/backend.js')); assert.throws(() => build(options), /Required application file missing/);
  await write(f.sourceRoot, 'src/main/backend.js', 'SYNTHETIC');
  await fsp.unlink(path.join(f.sourceRoot, 'native/apple-host/bin/WebView2Loader.dll')); assert.throws(() => build(options), /ENOENT/);
});

test('build refuses asset drift during injected syntax checks before reporting success', async t => {
  const f = await fixture(t); await prepareBuild(f); let changed = false;
  assert.throws(() => build({sourceRoot: f.sourceRoot, verifyClientRevision: f.verifyClientRevision, runSyntax: () => {if (!changed) {changed = true; fs.appendFileSync(path.join(f.sourceRoot, RUNTIME_ASSETS.backendLauncher.relativePath), 'drift');} return {status: 0};},
    verifySpectrum: () => ({applicationRuntimeFiles: [], ...f.spectrumClient})}), /reviewed SHA256/);
});

test('package runtime copy emits only the fixed launcher and keeps source/package registry, policy and launcher hashes equal', async t => {
  const f = await fixture(t); await f.prepareApp();
  await write(f.sourceRoot, 'native/backend-job/tools/DO-NOT-COPY.txt', 'SYNTHETIC FORBIDDEN TOOL');
  await write(f.sourceRoot, 'native/backend-job/cache/DO-NOT-COPY.txt', 'SYNTHETIC FORBIDDEN CACHE');
  const before = await tree(f.sourceRoot), snapshot = await copyRuntimeAssets(f.sourceRoot, f.appDirectory), packaged = verifyRuntimeAssets(f.appDirectory);
  assertRuntimeAssetSnapshot(snapshot, packaged); assertRuntimeAssetSnapshot(snapshot, verifyRuntimeAssets(f.sourceRoot));
  const files = Object.keys(await tree(f.appDirectory)).filter(relative => !relative.endsWith('/')).sort();
  assert.deepEqual(files, Object.keys(snapshot.hashes).sort()); assert.deepEqual(await tree(f.sourceRoot), before);
  await copyRuntimeAssets(f.sourceRoot, f.appDirectory);
});

test('unreviewed source and mismatched copied metadata cause zero runtime-copy writes', async t => {
  const f = await fixture(t); await f.prepareApp(); const before = await tree(f.appDirectory);
  await fsp.appendFile(path.join(f.sourceRoot, RUNTIME_ASSETS.backendLauncher.relativePath), 'tamper');
  await assert.rejects(copyRuntimeAssets(f.sourceRoot, f.appDirectory), /reviewed SHA256/); assert.deepEqual(await tree(f.appDirectory), before);
  await fsp.writeFile(path.join(f.sourceRoot, RUNTIME_ASSETS.backendLauncher.relativePath), f.raw.backendLauncher);
  await fsp.appendFile(path.join(f.appDirectory, RUNTIME_ASSETS.backendOutputPolicy.relativePath), '\n');
  const mismatched = await tree(f.appDirectory);
  await assert.rejects(copyRuntimeAssets(f.sourceRoot, f.appDirectory), /metadata differs/); assert.deepEqual(await tree(f.appDirectory), mismatched);
});

test('package copy refuses unknown tools, destination hardlinks and redirected native parents without touching their bytes', async t => {
  const f = await fixture(t); await f.prepareApp();
  await write(f.appDirectory, 'native/backend-job/tools/keep.txt', 'KEEP UNKNOWN BYTES');
  const before = await tree(f.appDirectory); await assert.rejects(copyRuntimeAssets(f.sourceRoot, f.appDirectory), /unknown or linked/); assert.deepEqual(await tree(f.appDirectory), before);
  const moved = path.join(f.directory, 'saved-app-job'); await fsp.rename(path.join(f.appDirectory, 'native/backend-job'), moved);
  await fsp.symlink(moved, path.join(f.appDirectory, 'native/backend-job'), 'junction');
  await assert.rejects(copyRuntimeAssets(f.sourceRoot, f.appDirectory), /Link or junction/);
  await fsp.unlink(path.join(f.appDirectory, 'native/backend-job'));
  await write(f.appDirectory, RUNTIME_ASSETS.backendLauncher.relativePath, 'UNCHANGED LINKED BYTES');
  const launcher = path.join(f.appDirectory, RUNTIME_ASSETS.backendLauncher.relativePath), linked = path.join(f.directory, 'package-launcher-link');
  await fsp.link(launcher, linked); await assert.rejects(copyRuntimeAssets(f.sourceRoot, f.appDirectory), /unlinked regular/);
  assert.equal(await fsp.readFile(linked, 'utf8'), 'UNCHANGED LINKED BYTES');
});

test('package copy preserves a same-name hardlink introduced during launcher staging', async t => {
  const f = await fixture(t); await f.prepareApp();
  const sentinel = path.join(f.directory, 'keep-external-bytes'), target = path.join(f.appDirectory, RUNTIME_ASSETS.backendLauncher.relativePath), original = fsp.writeFile;
  await fsp.writeFile(sentinel, 'KEEP UNKNOWN SAME-NAME BYTES'); let injected = false;
  t.mock.method(fsp, 'writeFile', async function (filename, ...args) {
    const result = await original.call(this, filename, ...args);
    if (path.basename(filename).startsWith('.runtime-launcher-')) {injected = true; await fsp.link(sentinel, target);}
    return result;
  });
  await assert.rejects(copyRuntimeAssets(f.sourceRoot, f.appDirectory), /unlinked regular/);
  assert.equal(injected, true); assert.equal(await fsp.readFile(sentinel, 'utf8'), 'KEEP UNKNOWN SAME-NAME BYTES');
  assert.equal(await fsp.readFile(target, 'utf8'), 'KEEP UNKNOWN SAME-NAME BYTES');
});

test('source drift during launcher staging prevents publication and retains only the incomplete stage', async t => {
  const f = await fixture(t); await f.prepareApp(); const original = fsp.writeFile;
  let injected = false;
  t.mock.method(fsp, 'writeFile', async function (filename, ...args) {
    const result = await original.call(this, filename, ...args);
    if (path.basename(filename).startsWith('.runtime-launcher-')) {injected = true; await fsp.appendFile(path.join(f.sourceRoot, RUNTIME_ASSETS.backendOutputPolicy.relativePath), '\n');}
    return result;
  });
  await assert.rejects(copyRuntimeAssets(f.sourceRoot, f.appDirectory), /reviewed SHA256/);
  assert.equal(injected, true);
  await assert.rejects(fsp.stat(path.join(f.appDirectory, RUNTIME_ASSETS.backendLauncher.relativePath)), {code: 'ENOENT'});
  assert.equal((await fsp.readdir(path.join(f.appDirectory, 'native/backend-job'))).filter(name => name.startsWith('.runtime-launcher-')).length, 1);
});

test('BUILD hash checks require every raw runtime asset and registry in sourceFrozen inputs and reject drift', async t => {
  const f = await fixture(t), snapshot = verifyRuntimeAssets(f.sourceRoot);
  const hashes = Object.fromEntries(Object.entries(snapshot.hashes).map(([relative, hash]) => [`resources/app/${relative}`, hash]));
  assertRuntimeAssetHashes(snapshot, hashes);
  const frozen = Object.keys(hashes).filter(filename => /^resources\/app\/(src|native|scripts)\//.test(filename));
  assert.equal(frozen.length, 3);
  for (const relative of Object.keys(snapshot.hashes)) {
    const changed = {...hashes, [`resources/app/${relative}`]: '0'.repeat(64)}; assert.throws(() => assertRuntimeAssetHashes(snapshot, changed), /snapshot was frozen/);
    delete changed[`resources/app/${relative}`]; assert.throws(() => assertRuntimeAssetHashes(snapshot, changed), /snapshot was frozen/);
  }
});

test('runtime candidate default validates exact files without writes or approval', async t => {
  const f = await fixture(t), before = await tree(f.sourceRoot); let printed;
  const result = promotionMain([], {sourceRoot: f.sourceRoot, print: value => {printed = JSON.parse(value);}});
  assert.equal(result.approved, false); assert.equal(printed.operation, 'validate-runtime-assets');
  assert.deepEqual(await tree(f.sourceRoot), before);
});

for (const asset of ['policy', 'launcher']) {
  test(`runtime ${asset} candidate binds changed fixed raw bytes and never writes registry or asset`, async t => {
    const f = await fixture(t), key = asset === 'policy' ? 'backendOutputPolicy' : 'backendLauncher', relative = RUNTIME_ASSETS[key].relativePath;
    await fsp.writeFile(path.join(f.sourceRoot, relative), asset === 'policy' ? json({fixture: 'PRIVATE SENTINEL; HASH ONLY'}) : 'NEW SYNTHETIC LAUNCHER; NEVER RUN');
    const registryBefore = await fsp.readFile(path.join(f.sourceRoot, RUNTIME_REGISTRY_PATH)), assetBefore = await fsp.readFile(path.join(f.sourceRoot, relative));
    const result = f.candidate({asset, output: 'review-evidence/candidate.json'});
    assert.equal(result.approved, false); assert.equal(result.candidateOnly, true); assert.equal(result.candidate.sha256, sha256(assetBefore));
    assert.ok(!/[A-Za-z]:[\\/]|PRIVATE|SYNTHETIC/.test(JSON.stringify(result)));
    assert.deepEqual(await fsp.readFile(path.join(f.sourceRoot, RUNTIME_REGISTRY_PATH)), registryBefore);
    assert.deepEqual(await fsp.readFile(path.join(f.sourceRoot, relative)), assetBefore);
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(f.sourceRoot, 'review-evidence/candidate.json'))), result);
    assert.throws(() => verifyRuntimeAssets(f.sourceRoot), /reviewed SHA256/);
  });
}

test('runtime candidate rejects stale registry, alias/path/output overrides and never accepts apply mode', async t => {
  const f = await fixture(t), before = await tree(f.sourceRoot);
  for (const extra of [{expectedCurrentSha256: '0'.repeat(64)}, {asset: 'other'}, {output: RUNTIME_REGISTRY_PATH},
    {output: RUNTIME_ASSETS.backendOutputPolicy.relativePath}, {output: '../outside.json'}, {output: 'review-evidence/missing/candidate.json'}]) assert.throws(() => f.candidate(extra));
  assert.deepEqual(await tree(f.sourceRoot), before);
  f.candidate({output: 'review-evidence/candidate.json'}); const existing = await tree(f.sourceRoot);
  assert.throws(() => f.candidate({output: 'review-evidence/candidate.json'}), /already exists/); assert.deepEqual(await tree(f.sourceRoot), existing);
  for (const args of [['--apply'], ['--snapshot', 'unused'], ['--asset', 'launcher'], ['--asset', 'launcher', '--asset', 'policy'], ['--output', 'unused']]) {
    assert.throws(() => promotionMain(args, {sourceRoot: path.join(f.directory, 'absent'), print: () => assert.fail('Unexpected CLI output')}), /Use no arguments|candidate requires/);
  }
});

for (const drifting of ['registry', 'asset']) {
  test(`runtime candidate ${drifting} drift before output fails without a candidate file`, async t => {
    const f = await fixture(t), expectedCurrentSha256 = loadRuntimeAssetRegistry(f.sourceRoot).registrySha256, original = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, 'readFileSync', function (...args) {
      const bytes = original.apply(this, args); reads++;
      if (reads === (drifting === 'registry' ? 2 : 3)) fs.appendFileSync(path.join(f.sourceRoot, drifting === 'registry' ? RUNTIME_REGISTRY_PATH : RUNTIME_ASSETS.backendLauncher.relativePath), '\n');
      return bytes;
    });
    assert.throws(() => planRuntimeAssetCandidate({sourceRoot: f.sourceRoot, asset: 'launcher', expectedCurrentSha256, output: 'review-evidence/candidate.json'}), /changed during planning/);
    await assert.rejects(fsp.stat(path.join(f.sourceRoot, 'review-evidence/candidate.json')), {code: 'ENOENT'});
  });
}

for (const side of ['source', 'package']) for (const relative of [RUNTIME_REGISTRY_PATH, ...Object.values(RUNTIME_ASSETS).map(value => value.relativePath)]) {
  test(`finalize repair: ${side} ${relative} drift during BUILD await retains marker and changed bytes`, async t => {
    const f = await finalizationFixture(t), target = path.join(side === 'source' ? f.sourceRoot : f.appDirectory, relative);
    const unknown = Buffer.concat([await fsp.readFile(target), Buffer.from('\nUNKNOWN BYTES AFTER FINAL CHECK')]);
    let failure;
    try {
      await finalizePackage(f, {writeBuildInfo: async (_filename, _bytes, publish) => {const owned = await publish(); await fsp.writeFile(target, unknown); return owned;}});
    } catch (error) {failure = error;}
    assert.ok(failure, 'Asset drift during BUILD write must reject package completion');
    assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
    assert.deepEqual(await fsp.readFile(target), unknown);
  });
}

for (const field of ['hashes', 'sourceFrozenSnapshot', 'runtimeAssets']) {
  test(`finalize repair: on-disk BUILD ${field} drift is retained with incomplete marker`, async t => {
    const f = await finalizationFixture(t); let unknown;
    await assert.rejects(finalizePackage(f, {writeBuildInfo: async (filename, bytes, publish) => {
      const owned = await publish();
      const altered = JSON.parse(bytes);
      if (field === 'hashes') altered.hashes[`resources/app/${RUNTIME_REGISTRY_PATH}`] = '0'.repeat(64);
      else if (field === 'runtimeAssets') altered.runtimeAssets.registrySha256 = '0'.repeat(64);
      else altered.sourceFrozenSnapshot = '0'.repeat(64);
      unknown = Buffer.from(json(altered)); await fsp.writeFile(filename, unknown);
      return owned;
    }}), /BUILD|runtime|snapshot/i);
    assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
    assert.deepEqual(await fsp.readFile(path.join(f.outputDirectory, 'BUILD-INFO.json')), unknown);
  });
}

test('finalize repair: an incomplete marker replaced during BUILD await is never deleted', async t => {
  const f = await finalizationFixture(t), unknown = Buffer.from('UNKNOWN SAME-NAME MARKER MUST BE RETAINED');
  await assert.rejects(finalizePackage(f, {writeBuildInfo: async (_filename, _bytes, publish) => {
    const owned = await publish(); await fsp.writeFile(path.join(f.outputDirectory, '.package-incomplete'), unknown); return owned;
  }}), /marker/i);
  assert.deepEqual(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete')), unknown);
});

test('finalize repair: successful completion verifies BUILD bytes and uses no asynchronous final unlink', async t => {
  const f = await finalizationFixture(t);
  t.mock.method(fsp, 'unlink', () => assert.fail('Final completion cannot await marker unlink'));
  await finalizePackage(f);
  await assert.rejects(fsp.stat(path.join(f.outputDirectory, '.package-incomplete')), {code: 'ENOENT'});
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(f.outputDirectory, 'BUILD-INFO.json'))), f.buildInfo);
});

for (const field of ['hashes', 'sourceFrozenSnapshot', 'runtimeAssets']) {
  test(`finalize repair: invalid ${field} metadata blocks BUILD writer before any completion writes`, async t => {
    const f = await finalizationFixture(t), before = await tree(f.outputDirectory);
    if (field === 'hashes') f.buildInfo.hashes[`resources/app/${RUNTIME_REGISTRY_PATH}`] = '0'.repeat(64);
    else if (field === 'runtimeAssets') f.buildInfo.runtimeAssets.launcherRuntimeValidated = true;
    else f.buildInfo.sourceFrozenSnapshot = '0'.repeat(64);
    let writes = 0;
    await assert.rejects(finalizePackage(f, {writeBuildInfo: async () => {writes++; assert.fail('Invalid metadata must not reach BUILD writer');}}), /BUILD|runtime|snapshot/i);
    assert.equal(writes, 0); assert.deepEqual(await tree(f.outputDirectory), before);
  });
}

for (const relative of ['BUILD-INFO.json', '.package-incomplete']) {
  test(`finalize repair: ${relative} hardlinked during BUILD await blocks marker removal`, async t => {
    const f = await finalizationFixture(t), alias = path.join(f.directory, 'external-alias');
    await assert.rejects(finalizePackage(f, {writeBuildInfo: async (_filename, _bytes, publish) => {
      const owned = await publish(); await fsp.link(path.join(f.outputDirectory, relative), alias); return owned;
    }}), /unlinked regular/);
    assert.equal(await fsp.readFile(path.join(f.outputDirectory, '.package-incomplete'), 'utf8'), PACKAGE_INCOMPLETE_TEXT);
    assert.deepEqual(await fsp.readFile(path.join(f.outputDirectory, relative)), await fsp.readFile(alias));
  });
}
