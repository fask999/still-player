'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {fixture} = require('./helpers/public-package-fixture.cjs');
const {sha256} = require('../scripts/package-public');
const {fileRecord, readTree} = require('../scripts/release-public-integrity');
const {assetNames, checksumText, verifyCandidateDirectory} = require('../scripts/release-public');
const {loadRecipe} = require('../scripts/prepare-release-tools');
async function bundle(t) {
  const f = await fixture(t), commit = 'a'.repeat(40);
  f.package({runGit: (_name, args) => ({status: 0, stdout: args[0] === 'rev-parse' ? commit : ''})});
  const policy = loadRecipe(), output = path.join(f.root, 'bundle'), publicRoot = path.join(output, 'public'), releaseRoot = path.join(output, 'release');
  fs.mkdirSync(output); fs.cpSync(f.output, publicRoot, {recursive: true}); fs.mkdirSync(releaseRoot);
  const info = JSON.parse(fs.readFileSync(path.join(publicRoot, 'BUILD-INFO.json'))), version = info.version, names = assetNames(version), setup = Buffer.alloc(2048); setup.write('MZ');
  fs.writeFileSync(path.join(releaseRoot, names[0]), setup);
  fs.copyFileSync(path.join(publicRoot, 'BUILD-INFO.json'), path.join(releaseRoot, 'BUILD-INFO.json'));
  const installer = {version, installer: {file: names[0], sha256: sha256(setup)}, packageBuildInfoSha256: sha256(fs.readFileSync(path.join(releaseRoot, 'BUILD-INFO.json'))), sourceSnapshotSha256: info.sourceSnapshotSha256};
  fs.writeFileSync(path.join(releaseRoot, 'INSTALLER-INFO.json'), JSON.stringify(installer));
  const metadata = {schemaVersion: 1, version, commit, gitDirty: false, sourceSnapshotSha256: info.sourceSnapshotSha256,
    context: {repository: policy.repository, repositoryId: policy.repositoryId, actor: 'fask999', event: 'push', ref: `refs/heads/release-candidate/${version}`, workflow: policy.candidateWorkflow, workflowSha: commit, runId: 10, runAttempt: 1},
    assets: Object.fromEntries([names[0], 'BUILD-INFO.json', 'INSTALLER-INFO.json'].map(name => [name, fileRecord(fs.readFileSync(path.join(releaseRoot, name)))])), publicFiles: readTree(publicRoot)};
  const writeMetadata = () => {fs.writeFileSync(path.join(releaseRoot, 'RELEASE-INFO.json'), JSON.stringify(metadata)); fs.writeFileSync(path.join(releaseRoot, 'SHA256SUMS.txt'), checksumText(releaseRoot, version));};
  writeMetadata();
  const expected = {version, commit, candidate_run_id: 10, candidate_run_attempt: 1, setup_sha256: sha256(setup), source_snapshot_sha256: info.sourceSnapshotSha256, release_info_sha256: sha256(fs.readFileSync(path.join(releaseRoot, 'RELEASE-INFO.json')))};
  return {...f, output, publicRoot, releaseRoot, metadata, expected, writeMetadata, verify: options => verifyCandidateDirectory(output, {sourceRoot: f.root, policy, expected, pinOfficial: false, ...options})};
}
test('candidate artifact verifies exact public namespace plus only the five release assets', async t => {
  const f = await bundle(t), result = f.verify();
  assert.equal(Object.keys(result.assets).length, 5);
  assert.equal(result.metadata.gitDirty, false);
  fs.writeFileSync(path.join(f.releaseRoot, 'compiler.log'), 'DO NOT PUBLISH');
  assert.throws(() => f.verify(), /five-file namespace/);
});
test('candidate rejects dirty/source/version/attempt/hash drift rather than accepting new metadata', async t => {
  const f = await bundle(t);
  for (const patch of [{gitDirty: true}, {commit: 'b'.repeat(40)}, {version: '2.0.0'}, {context: {...f.metadata.context, event: 'pull_request'}}]) {
    const saved = {...f.metadata}; Object.assign(f.metadata, patch); f.writeMetadata();
    assert.throws(() => f.verify()); Object.assign(f.metadata, saved);
  }
  f.writeMetadata();
  assert.throws(() => f.verify({expected: {...f.expected, candidate_run_attempt: 2}}), /exact annotated/);
  fs.appendFileSync(path.join(f.publicRoot, 'resources/app/src/main/entry.js'), 'UNREVIEWED');
  assert.throws(() => f.verify(), /changed|missing|differs/);
});
