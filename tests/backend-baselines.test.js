'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const {createCanonicalTemp} = require('./helpers/canonical-temp.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {REGISTRY_PATH, DESTINATIONS, sha256, loadBackendBaselines, selectBackendBaseline, validateBackendBaselines} = require('../scripts/backend-baselines');
const {planBaselineCandidate, main: promotionMain} = require('../scripts/promote-backend-baseline');
const {CLIENT_REVISION_PATH} = require('../scripts/spectrum-client-revision');
const {verifySpectrumDelivery, planSpectrumInstall, planSha256, applySpectrumInstall, rollbackSpectrumInstall,
  APPLY_AUTHORIZATION, ROLLBACK_AUTHORIZATION} = require('../scripts/install-spectrum-component');
const {verifySpectrumManifestLineage, verifyPrivateBackend, copyPrivateBackend} = require('../scripts/package');
const project = path.resolve(__dirname, '..');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const clone = value => JSON.parse(JSON.stringify(value));
const stopped = async () => [];
async function write(root, relative, bytes) {
  const filename = path.join(root, ...relative.split('/'));
  await fsp.mkdir(path.dirname(filename), {recursive: true});
  await fsp.writeFile(filename, bytes);
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
async function fixture(t, {delivery = false} = {}) {
  const {root: sourceRoot, parent: temporaryParent} = createCanonicalTemp('still-baselines-');
  t.after(async () => {
    assert.equal(path.dirname(sourceRoot).toLowerCase(), temporaryParent.toLowerCase());
    assert.ok(path.basename(sourceRoot).startsWith('still-baselines-'));
    await fsp.rm(sourceRoot, {recursive: true, force: true});
  });
  const policy = clone(loadBackendBaselines(project).policy);
  await write(sourceRoot, REGISTRY_PATH, json(policy));
  await fsp.mkdir(path.join(sourceRoot, 'review-evidence'));
  const files = ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll'].map(relativePath => ({
    relativePath, mutable: false, mode: 'copy', bytes: Buffer.byteLength(relativePath), sha256: sha256(relativePath), sourceSha256: sha256(relativePath)}));
  const backendDir = path.join(sourceRoot, ...DESTINATIONS.source.split('/'));
  const manifest = {schemaVersion: 1, privateUseOnly: true, backendId: '11111111-2222-4333-8444-555555555555', destinationDir: backendDir,
    executable: 'foobar2000.exe', totalFiles: files.length, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files,
    configuration: {port: 18880, allowRemote: false, musicDirs: ['X:\\PRIVATE MUSIC SENTINEL'], permissions: {changeClientConfig: false}},
    sourceDir: 'X:\\PRIVATE ORIGINAL SENTINEL', untouchedMetadata: {value: 'preserve old metadata'}};
  const targetManifest = {...manifest, backendId: '66666666-7777-4888-8999-aaaaaaaaaaaa', destinationDir: path.join(sourceRoot, ...DESTINATIONS.target.split('/'))};
  for (const [kind, value] of [['source', manifest], ['target', targetManifest]]) {
    policy.baselines[kind] = {...policy.baselines[kind], sha256: sha256(json(value)), canonicalSha256: sha256(JSON.stringify(value)), backendId: value.backendId};
    if (delivery) {
      for (const file of files) await write(value.destinationDir, file.relativePath, file.relativePath);
      await write(value.destinationDir, 'backend-manifest.json', json(value));
      await write(value.destinationDir, 'profile/beefweb/config.json', json(value.configuration));
    }
  }
  await write(sourceRoot, REGISTRY_PATH, json(policy));
  await write(sourceRoot, 'review-evidence/snapshot.json', json(manifest));
  if (delivery) {
    await write(sourceRoot, 'package.json', json({name: 'still-desktop', private: true}));
    const verified = verifySpectrumDelivery(project), paths = new Set(['native/foobar-spectrum/delivery-manifest.json', CLIENT_REVISION_PATH, verified.clientSource.relativePath,
      ...verified.applicationRuntimeFiles.map(file => file.sourceRelativePath), ...verified.privateBackendComponentFiles.map(file => file.sourceRelativePath)]);
    for (const relative of paths) await write(sourceRoot, relative, await fsp.readFile(path.join(project, ...relative.split('/'))));
  }
  const candidate = extra => planBaselineCandidate({sourceRoot, backend: 'source', manifest: 'review-evidence/snapshot.json', expectedCurrentSha256: loadBackendBaselines(sourceRoot).policySha256, ...extra});
  return {sourceRoot, policy, manifest, targetManifest, backendDir, candidate};
}

test('reviewed registry preserves exact original hashes and resolves only the two fixed relative destinations', () => {
  const registry = loadBackendBaselines(project);
  assert.equal(registry.policy.baselines.source.sha256, '1f0de056014825a60f3f49838b8d4f76cfef82e8930fddf0135ba68a8e01e5c5');
  assert.equal(registry.policy.baselines.source.canonicalSha256, 'd923d4c5dfa922ba7d52639a9c21c31879b0e4e0112c451d029bc2a3b985f81e');
  assert.equal(registry.policy.baselines.target.sha256, '48117102e48e6d52d3ff15d79bac71ca9b1dffef29423691597c3b9638cea490');
  assert.equal(registry.policy.baselines.target.canonicalSha256, '436aa700ef931f8aec7f0cf9ea80444c55c3331cd543aad0aa5a3f38c661ec18');
  for (const kind of ['source', 'target']) {
    assert.equal(selectBackendBaseline(registry, kind, project).destinationDir, path.join(project, ...DESTINATIONS[kind].split('/')));
    assert.ok(Object.isFrozen(registry.policy.baselines[kind]));
  }
  assert.throws(() => selectBackendBaseline(registry, 'other', project), /source or target/);
  assert.ok(!/[A-Za-z]:[\\/]/.test(JSON.stringify(registry.policy)));
});

test('closed registry rejects unknown, missing, wrong typed and redirected policy fields', () => {
  const policy = loadBackendBaselines(project).policy;
  const changes = [
    value => {value.extra = true;}, value => {delete value.purpose;}, value => {value.schemaVersion = 2;},
    value => {value.purpose = 'candidate';}, value => {value.baselines.extra = {};}, value => {delete value.baselines.target;},
    value => {value.baselines.source = [];}, value => {value.baselines.source.extra = true;},
    value => {delete value.baselines.source.sha256;}, value => {value.baselines.source.sha256 = 'A'.repeat(64);},
    value => {value.baselines.source.canonicalSha256 = 123;}, value => {value.baselines.source.backendId = 'not-a-uuid';},
    value => {value.baselines.source.backendId = value.baselines.target.backendId;}, value => {value.baselines.source.sha256 = value.baselines.target.sha256;}
  ];
  for (const invalidPath of ['../backend', 'C:/backend', '/backend', 'backend\\foobar2000', 'dist/Other/backend/foobar2000', 'backend/foobar2000:stream']) changes.push(value => {value.baselines.source.destinationRelativePath = invalidPath;});
  for (const change of changes) {const value = clone(policy); change(value); assert.throws(() => validateBackendBaselines(value), /baseline/i);}
});

test('registry reads fresh exact bytes and rejects malformed, oversized, hardlinked or redirected files', async t => {
  const f = await fixture(t), filename = path.join(f.sourceRoot, ...REGISTRY_PATH.split('/'));
  const before = loadBackendBaselines(f.sourceRoot);
  await fsp.appendFile(filename, '\n');
  assert.notEqual(loadBackendBaselines(f.sourceRoot).policySha256, before.policySha256);
  await fsp.writeFile(filename, '{'); assert.throws(() => loadBackendBaselines(f.sourceRoot), SyntaxError);
  await fsp.writeFile(filename, ' '.repeat(64 * 1024 + 1)); assert.throws(() => loadBackendBaselines(f.sourceRoot), /small unlinked/);
  await fsp.writeFile(filename, json(f.policy));
  const linked = path.join(f.sourceRoot, 'policy-link'); await fsp.link(filename, linked);
  assert.throws(() => loadBackendBaselines(f.sourceRoot), /small unlinked/);
  await fsp.unlink(linked);
  const moved = path.join(f.sourceRoot, 'saved-manifests'); await fsp.rename(path.dirname(filename), moved);
  await fsp.symlink(moved, path.dirname(filename), 'junction');
  assert.throws(() => loadBackendBaselines(f.sourceRoot), /link or junction/);
});

test('promotion default validates policy without backend reads or writes', async t => {
  const f = await fixture(t), before = await tree(f.sourceRoot);
  let printed = '';
  const result = promotionMain([], {sourceRoot: f.sourceRoot, print: value => {printed = value;}});
  assert.equal(result.operation, 'validate-backend-baselines'); assert.equal(result.approved, false);
  assert.equal(JSON.parse(printed).policySha256, loadBackendBaselines(f.sourceRoot).policySha256);
  assert.deepEqual(await tree(f.sourceRoot), before);
  await assert.rejects(fsp.stat(f.backendDir), {code: 'ENOENT'});
});

test('promotion only emits an unapproved candidate with exact raw/canonical digests and no private metadata', async t => {
  const f = await fixture(t), beforePolicy = await fsp.readFile(path.join(f.sourceRoot, ...REGISTRY_PATH.split('/')));
  const proposedManifest = {...f.manifest, backendId: '77777777-8888-4999-aaaa-bbbbbbbbbbbb'};
  await write(f.sourceRoot, 'review-evidence/snapshot.json', json(proposedManifest));
  const result = f.candidate({output: 'review-evidence/candidate.json'}), text = JSON.stringify(result);
  assert.equal(result.approved, false); assert.equal(result.candidateOnly, true);
  assert.equal(result.candidate.sha256, sha256(json(proposedManifest)));
  assert.equal(result.candidate.canonicalSha256, sha256(JSON.stringify(proposedManifest)));
  assert.deepEqual(result.proposedPolicy.baselines.target, f.policy.baselines.target);
  assert.ok(!/PRIVATE|sourceDir|musicDirs|configuration|[A-Za-z]:[\\/]/.test(text));
  assert.deepEqual(await fsp.readFile(path.join(f.sourceRoot, ...REGISTRY_PATH.split('/'))), beforePolicy);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(f.sourceRoot, 'review-evidence/candidate.json'))), result);
});

test('candidate guards reject stale policy, unsafe paths and existing outputs without writes', async t => {
  const f = await fixture(t), before = await tree(f.sourceRoot);
  for (const extra of [
    {expectedCurrentSha256: '0'.repeat(64)}, {backend: 'other'}, {manifest: REGISTRY_PATH}, {manifest: '../snapshot.json'},
    {output: REGISTRY_PATH}, {output: 'review-evidence/snapshot.json'}, {output: 'review-evidence/missing/candidate.json'},
    {output: 'review-evidence/../manifests/backend-baselines.json'}, {output: 'review-evidence/candidate.json:stream'}
  ]) assert.throws(() => f.candidate(extra));
  assert.deepEqual(await tree(f.sourceRoot), before);
  f.candidate({output: 'review-evidence/candidate.json'});
  const existing = await tree(f.sourceRoot); assert.throws(() => f.candidate({output: 'review-evidence/candidate.json'}), /already exists/);
  assert.deepEqual(await tree(f.sourceRoot), existing);
});

test('candidate rejects malformed, migrated, escaped, inconsistent and non-loopback snapshots', async t => {
  const f = await fixture(t);
  const changes = [
    value => {value.spectrumComponent = {};}, value => {value.packagedAt = 'today';}, value => {value.packagedFromBackendId = value.backendId;},
    value => {value.destinationDir = path.dirname(f.sourceRoot);}, value => {value.backendId = 'bad';},
    value => {value.configuration.allowRemote = true;}, value => {value.configuration.port = 8880;},
    value => {value.configuration.musicDirs = ['relative'];}, value => {value.totalFiles++;}, value => {value.totalBytes++;},
    value => {value.files.push({...value.files[0]});}, value => {value.files[0].relativePath = '../escape';},
    value => {value.files[0].sha256 = 'bad';}, value => {value.files[0].relativePath = 'profile/user-components-x64/foo_still_spectrum/foo_still_spectrum.dll';}
  ];
  for (const change of changes) {
    const value = clone(f.manifest); change(value); await write(f.sourceRoot, 'review-evidence/snapshot.json', json(value));
    const before = await tree(f.sourceRoot); assert.throws(() => f.candidate({output: 'review-evidence/candidate.json'})); assert.deepEqual(await tree(f.sourceRoot), before);
  }
});

test('candidate snapshot hardlinks and evidence parent junctions are refused', async t => {
  const f = await fixture(t), snapshot = path.join(f.sourceRoot, 'review-evidence/snapshot.json'), linked = path.join(f.sourceRoot, 'snapshot-link');
  await fsp.link(snapshot, linked); assert.throws(() => f.candidate(), /small unlinked/); await fsp.unlink(linked);
  const saved = path.join(f.sourceRoot, 'saved-evidence'); await fsp.rename(path.dirname(snapshot), saved);
  await fsp.symlink(saved, path.dirname(snapshot), 'junction');
  assert.throws(() => f.candidate(), /link or junction/);
});

for (const drifting of ['policy', 'snapshot']) {
  test(`candidate ${drifting} drift before final comparison leaves no output or approved registry write`, async t => {
    const f = await fixture(t), options = {sourceRoot: f.sourceRoot, backend: 'source', manifest: 'review-evidence/snapshot.json',
      expectedCurrentSha256: loadBackendBaselines(f.sourceRoot).policySha256, output: 'review-evidence/candidate.json'};
    const original = fs.readFileSync;
    let reads = 0;
    t.mock.method(fs, 'readFileSync', function (...args) {
      const bytes = original.apply(this, args); reads++;
      if (reads === (drifting === 'policy' ? 2 : 3)) fs.appendFileSync(path.join(f.sourceRoot, drifting === 'policy' ? REGISTRY_PATH : 'review-evidence/snapshot.json'), '\n');
      return bytes;
    });
    assert.throws(() => planBaselineCandidate(options), /changed during planning/);
    await assert.rejects(fsp.stat(path.join(f.sourceRoot, 'review-evidence/candidate.json')), {code: 'ENOENT'});
  });
}

test('promotion CLI rejects apply, receipts, duplicate and incomplete arguments before file I/O', () => {
  for (const args of [['--apply'], ['--receipt', 'unused'], ['--backend', 'source'], ['--output', 'unused'],
    ['--backend', 'source', '--backend', 'target'], ['--manifest', '--backend']]) {
    assert.throws(() => promotionMain(args, {sourceRoot: path.join(os.tmpdir(), 'STILL-BASELINE-NONEXISTENT-ROOT'), print: () => assert.fail('unexpected output')}), /Candidate requires|Use no arguments/);
  }
});

test('temporary source and target roots enforce the shared registry for installer and package lineage', async t => {
  const f = await fixture(t, {delivery: true}), delivery = verifySpectrumDelivery(f.sourceRoot);
  for (const [kind, manifest] of [['source', f.manifest], ['target', f.targetManifest]]) {
    const plan = planSpectrumInstall({sourceRoot: f.sourceRoot, backendDir: manifest.destinationDir});
    assert.equal(plan.beforeManifestSha256, f.policy.baselines[kind].sha256);
    assert.equal(plan.baselinePolicySha256, loadBackendBaselines(f.sourceRoot).policySha256);
    assert.equal(verifySpectrumManifestLineage(plan.afterManifest, delivery, {sourceRoot: f.sourceRoot}).oldManifestContentVerified, true);
  }
  const registryFile = path.join(f.sourceRoot, ...REGISTRY_PATH.split('/'));
  for (const field of ['sha256', 'backendId']) {
    const changed = clone(f.policy); changed.baselines.source[field] = field === 'sha256' ? '0'.repeat(64) : '77777777-8888-4999-aaaa-bbbbbbbbbbbb';
    await fsp.writeFile(registryFile, json(changed));
    assert.throws(() => planSpectrumInstall({sourceRoot: f.sourceRoot}), /reviewed pre-install baseline/);
  }
  await fsp.writeFile(registryFile, json(f.policy));
  const plan = planSpectrumInstall({sourceRoot: f.sourceRoot}), changed = clone(f.policy); changed.baselines.source.canonicalSha256 = '0'.repeat(64);
  await fsp.writeFile(registryFile, json(changed));
  assert.throws(() => verifySpectrumManifestLineage(plan.afterManifest, delivery, {sourceRoot: f.sourceRoot}), /Old backend manifest/);
  await fsp.unlink(registryFile);
  assert.throws(() => planSpectrumInstall({sourceRoot: f.sourceRoot}), /ENOENT/);
  assert.throws(() => verifySpectrumManifestLineage(plan.afterManifest, delivery, {sourceRoot: f.sourceRoot}), /ENOENT/);
});

test('policy byte drift invalidates reviewed install plans before writes while candidates never authorize a backend', async t => {
  const f = await fixture(t, {delivery: true}), plan = planSpectrumInstall({sourceRoot: f.sourceRoot});
  f.candidate({output: 'review-evidence/candidate.json'});
  await assert.rejects(verifyPrivateBackend(f.backendDir, {sourceRoot: f.sourceRoot}), /separately reviewed four-file/);
  await fsp.appendFile(path.join(f.sourceRoot, ...REGISTRY_PATH.split('/')), '\n');
  assert.notEqual(planSha256(planSpectrumInstall({sourceRoot: f.sourceRoot})), planSha256(plan));
  const before = await tree(f.sourceRoot);
  await assert.rejects(applySpectrumInstall(plan, {authorization: APPLY_AUTHORIZATION, expectedPlanSha256: planSha256(plan),
    evidenceDir: path.join(f.sourceRoot, 'review-evidence/spectrum-package-stale'), processInspector: stopped}), /changed after review/);
  assert.deepEqual(await tree(f.sourceRoot), before);
});

test('recorded transaction rollback remains authorized after the current registry is removed', async t => {
  const f = await fixture(t, {delivery: true}), plan = planSpectrumInstall({sourceRoot: f.sourceRoot}), evidenceDir = path.join(f.sourceRoot, 'review-evidence/spectrum-package-recovery');
  const before = await tree(f.backendDir);
  await applySpectrumInstall(plan, {authorization: APPLY_AUTHORIZATION, expectedPlanSha256: planSha256(plan), evidenceDir, processInspector: stopped});
  await fsp.unlink(path.join(f.sourceRoot, ...REGISTRY_PATH.split('/')));
  const result = await rollbackSpectrumInstall(evidenceDir, {sourceRoot: f.sourceRoot, authorization: ROLLBACK_AUTHORIZATION,
    expectedPlanSha256: planSha256(plan), processInspector: stopped});
  assert.equal(result.rolledBack, true); assert.deepEqual(await tree(f.backendDir), before);
});

test('legacy transaction plans without a policy digest retain their reviewed rollback contract', async t => {
  const f = await fixture(t, {delivery: true}), plan = planSpectrumInstall({sourceRoot: f.sourceRoot}), evidenceDir = path.join(f.sourceRoot, 'review-evidence/spectrum-package-legacy');
  const before = await tree(f.backendDir);
  await applySpectrumInstall(plan, {authorization: APPLY_AUTHORIZATION, expectedPlanSha256: planSha256(plan), evidenceDir, processInspector: stopped});
  const legacyPlan = clone(plan); delete legacyPlan.baselinePolicySha256;
  const journalFile = path.join(evidenceDir, 'transaction.json'), journal = JSON.parse(await fsp.readFile(journalFile));
  journal.plan = legacyPlan; journal.planSha256 = planSha256(legacyPlan);
  await fsp.writeFile(journalFile, json(journal));
  await fsp.unlink(path.join(f.sourceRoot, ...REGISTRY_PATH.split('/')));
  const result = await rollbackSpectrumInstall(evidenceDir, {sourceRoot: f.sourceRoot, authorization: ROLLBACK_AUTHORIZATION,
    expectedPlanSha256: planSha256(legacyPlan), processInspector: stopped});
  assert.equal(result.rolledBack, true); assert.deepEqual(await tree(f.backendDir), before);
});

test('fresh package clones retain source lineage through staged verification with the shared registry', async t => {
  const f = await fixture(t, {delivery: true}), plan = planSpectrumInstall({sourceRoot: f.sourceRoot}), evidenceDir = path.join(f.sourceRoot, 'review-evidence/spectrum-package-clone');
  await applySpectrumInstall(plan, {authorization: APPLY_AUTHORIZATION, expectedPlanSha256: planSha256(plan), evidenceDir, processInspector: stopped});
  const before = await tree(f.backendDir), target = path.join(f.sourceRoot, 'dist/Fresh-package/backend/foobar2000');
  const result = await copyPrivateBackend(f.backendDir, target, {sourceRoot: f.sourceRoot, isRunning: async () => false});
  assert.equal(result.reused, false); assert.equal(result.manifest.packagedFromBackendId, f.manifest.backendId);
  assert.notEqual(result.manifest.backendId, f.manifest.backendId);
  assert.equal((await verifyPrivateBackend(target, {sourceRoot: f.sourceRoot})).backendId, result.manifest.backendId);
  assert.deepEqual(await tree(f.backendDir), before);
});

for (const point of ['prepared hook', 'last stopped await']) {
  test(`repair: policy drift in ${point} rejects before the first backend write`, async t => {
    const f = await fixture(t, {delivery: true}), plan = planSpectrumInstall({sourceRoot: f.sourceRoot});
    const evidenceDir = path.join(f.sourceRoot, 'review-evidence/spectrum-package-prewrite'), before = await tree(f.backendDir);
    let prepared = false, injected = false, failure;
    const drift = async () => {injected = true; await fsp.appendFile(path.join(f.sourceRoot, ...REGISTRY_PATH.split('/')), '\n');};
    try {
      await applySpectrumInstall(plan, {authorization: APPLY_AUTHORIZATION, expectedPlanSha256: planSha256(plan), evidenceDir,
        onPhase: async phase => {if (phase === 'prepared') {prepared = true; if (point === 'prepared hook') await drift();}},
        processInspector: async () => {if (prepared && !injected && point === 'last stopped await') await drift(); return [];}});
    } catch (error) {failure = error;}
    assert.equal(injected, true);
    assert.deepEqual(await tree(f.backendDir), before, 'policy drift before first write must leave every backend byte and directory unchanged');
    assert.match(failure?.message || '', /policy.*changed|changed.*review|Backend changed/i);
    const journal = JSON.parse(await fsp.readFile(path.join(evidenceDir, 'transaction.json')));
    assert.equal(journal.phase, 'failed'); assert.equal(journal.failedPhase, 'prepared');
    await assert.rejects(fsp.stat(path.join(f.backendDir, '.spectrum-component-install-incomplete.json')), {code: 'ENOENT'});
    assert.equal(sha256(await fsp.readFile(path.join(evidenceDir, 'before/backend-manifest.json'))), plan.beforeManifestSha256);
  });
}

for (const point of ['file:foo_still_spectrum.dll', 'file:COMPONENT-DETAILS.md', 'manifest-committed']) {
  test(`repair: policy drift at ${point} retains transaction evidence and remains recoverable`, async t => {
    const f = await fixture(t, {delivery: true}), plan = planSpectrumInstall({sourceRoot: f.sourceRoot});
    const evidenceDir = path.join(f.sourceRoot, 'review-evidence/spectrum-package-drift-recovery'), before = await tree(f.backendDir);
    let injected = false;
    await assert.rejects(applySpectrumInstall(plan, {authorization: APPLY_AUTHORIZATION, expectedPlanSha256: planSha256(plan), evidenceDir, processInspector: stopped,
      onPhase: async phase => {if (phase === point) {injected = true; await fsp.appendFile(path.join(f.sourceRoot, ...REGISTRY_PATH.split('/')), '\n');}}}), /policy.*changed/i);
    assert.equal(injected, true);
    assert.ok(await fsp.stat(path.join(f.backendDir, '.spectrum-component-install-incomplete.json')));
    const journal = JSON.parse(await fsp.readFile(path.join(evidenceDir, 'transaction.json')));
    assert.equal(journal.phase, 'failed'); assert.equal(journal.planSha256, planSha256(plan));
    assert.equal(sha256(await fsp.readFile(path.join(f.backendDir, 'backend-manifest.json'))), point === 'manifest-committed' ? plan.afterManifestSha256 : plan.beforeManifestSha256);
    if (point === 'file:foo_still_spectrum.dll') await assert.rejects(fsp.stat(path.join(f.backendDir, 'profile/user-components-x64/foo_still_spectrum/foobar2000-sdk-license.txt')), {code: 'ENOENT'});
    const restored = await rollbackSpectrumInstall(evidenceDir, {sourceRoot: f.sourceRoot, authorization: ROLLBACK_AUTHORIZATION,
      expectedPlanSha256: planSha256(plan), processInspector: stopped});
    assert.equal(restored.rolledBack, true); assert.deepEqual(await tree(f.backendDir), before);
  });
}

test('repair: policy drift during completed journal await preserves the marker and rejects success', async t => {
  const f = await fixture(t, {delivery: true}), plan = planSpectrumInstall({sourceRoot: f.sourceRoot});
  const evidenceDir = path.join(f.sourceRoot, 'review-evidence/spectrum-package-final-gate'), before = await tree(f.backendDir), original = fsp.rename;
  let injected = false;
  t.mock.method(fsp, 'rename', async function (source, destination) {
    const result = await original.call(this, source, destination);
    if (destination === path.join(evidenceDir, 'transaction.json') && JSON.parse(await fsp.readFile(destination)).phase === 'completed') {
      injected = true; await fsp.appendFile(path.join(f.sourceRoot, ...REGISTRY_PATH.split('/')), '\n');
    }
    return result;
  });
  await assert.rejects(applySpectrumInstall(plan, {authorization: APPLY_AUTHORIZATION, expectedPlanSha256: planSha256(plan), evidenceDir, processInspector: stopped}), /policy.*changed/i);
  assert.equal(injected, true); assert.ok(await fsp.stat(path.join(f.backendDir, '.spectrum-component-install-incomplete.json')));
  const journal = JSON.parse(await fsp.readFile(path.join(evidenceDir, 'transaction.json')));
  assert.equal(journal.phase, 'failed'); assert.equal(journal.failedPhase, 'completed');
  assert.equal(Object.hasOwn(journal, 'completedAt'), false);
  const restored = await rollbackSpectrumInstall(evidenceDir, {sourceRoot: f.sourceRoot, authorization: ROLLBACK_AUTHORIZATION,
    expectedPlanSha256: planSha256(plan), processInspector: stopped});
  assert.equal(restored.rolledBack, true); assert.deepEqual(await tree(f.backendDir), before);
});
