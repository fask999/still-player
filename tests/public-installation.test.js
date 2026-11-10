'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const {readPublicInstallation, publicInstallationPaths, assertPublicDataPaths, assertPublicBackendCode} = require('../src/main/public-installation');
const marker = {schemaVersion: 1, distribution: 'public', userDataDirectory: 'STILL', backendBootstrapManifest: 'manifests/public-backend.json'};
async function fixture(t) {
  const {root, parent} = createCanonicalTemp('still-public-install-');
  t.after(async () => {assert.equal(path.dirname(root), parent); assert.ok(path.basename(root).startsWith('still-public-install-')); await fs.rm(root, {recursive: true, force: true});});
  return root;
}
test('missing public marker preserves the private distribution decision without creating user data', async t => {
  const root = await fixture(t);
  assert.equal(await readPublicInstallation(root), null); assert.deepEqual(await fs.readdir(root), []);
});
test('validated public marker resolves per-user isolated data/backend and explicit QA override', async t => {
  const root = await fixture(t); await fs.writeFile(path.join(root, 'public-release.json'), JSON.stringify(marker));
  const trusted = await readPublicInstallation(root);
  const normal = publicInstallationPaths({marker: trusted, localAppData: root});
  assert.equal(normal.dataDir, path.join(root, 'STILL')); assert.equal(normal.backendDir, path.join(root, 'STILL/backend/foobar2000'));
  assert.equal(publicInstallationPaths({marker: trusted, dataOverride: path.join(root, 'qa')}).dataDir, path.join(root, 'qa'));
  assert.throws(() => publicInstallationPaths({marker: {...trusted}, localAppData: root}), /未验证/);
  assert.throws(() => publicInstallationPaths({marker: trusted, localAppData: 'relative'}), /本地数据/);
});
for (const value of ['{broken', JSON.stringify({...marker, unexpected: true}), JSON.stringify({...marker, userDataDirectory: '../original'}),
  JSON.stringify({...marker, backendBootstrapManifest: '../private.json'}), JSON.stringify({...marker, distribution: 'private'}), 'x'.repeat(4097)]) {
  test(`a malformed public marker fails closed: ${value.slice(0, 45)}`, async t => {
    const root = await fixture(t); await fs.writeFile(path.join(root, 'public-release.json'), value);
    await assert.rejects(readPublicInstallation(root)); assert.deepEqual(await fs.readdir(root), ['public-release.json']);
  });
}
test('linked public marker cannot activate installation mode', async t => {
  const root = await fixture(t), source = path.join(root, 'original.json'); await fs.writeFile(source, JSON.stringify(marker));
  await fs.link(source, path.join(root, 'public-release.json'));
  await assert.rejects(readPublicInstallation(root), /标记无效/);
});
for (const child of ['STILL', 'STILL/electron']) test(`a preexisting ${child} junction is rejected before public data can be created outside its root`, async t => {
  const root = await fixture(t), outside = path.join(root, 'outside'), target = path.join(root, child);
  await fs.mkdir(outside); await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertPublicDataPaths(path.join(root, 'STILL')), /junction/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('the public 2.26.2 core pins the entire private SxS runtime assembly declared by the official installer', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '../manifests/public-backend.json'), 'utf8'));
  const runtime = manifest.coreFiles.filter(row => row.relativePath.startsWith('runtime/'))
    .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  assert.equal(runtime.length, 47);
  assert.equal(runtime.reduce((sum, row) => sum + row.bytes, 0), 2485138);
  // The digest comes from the official archive audit, after checking the 46
  // file declarations against the original runtime.manifest member.
  assert.equal(createHash('sha256').update(JSON.stringify(runtime)).digest('hex'),
    '48cf00a8afd465ce5a5e9584ef6fe10aea366f2346b628914907e958c7662ac0');
});
test('the core includes the complete verified 2.26.2 Portable resources needed at startup', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '../manifests/public-backend.json'), 'utf8'));
  const files = [...manifest.coreFiles].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  // These rows match 110 unmodified members from the official archive and
  // the empty Portable marker. The runtime alone can start a child that
  // exits before the service becomes healthy.
  assert.equal(files.length, 111);
  assert.equal(files.reduce((sum, row) => sum + row.bytes, 0), 23313201);
  assert.equal(createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    '2cd15455fcf225c8b1ed87297d21220408de3fde5eaa2295abce5ff9ab95c5de');
});
for (const [directory, member] of [['runtime', 'runtime.manifest'], ['themes', 'Default.fth'], ['doc', 'license.html']]) test(`the public backend refuses extra files in ${directory}`, async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, directory));
  const manifestPath = `${directory}/${member}`;
  await fs.writeFile(path.join(root, manifestPath), 'fixture');
  await assertPublicBackendCode(root, [{relativePath: manifestPath}]);
  await fs.writeFile(path.join(root, directory, 'unreviewed.dll'), 'fixture');
  await assert.rejects(assertPublicBackendCode(root, [{relativePath: manifestPath}]), /来源清单之外/);
});
