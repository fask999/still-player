'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ROOT, packagePublic, verifyPublicPackage, regularBytes, sha256, walkFiles, assertNoLinks} = require('./package-public');
const {buildInstaller} = require('./build-installer');
const {loadRecipe} = require('./prepare-release-tools');
const {HASH, COMMIT, VERSION, exact, integer, assertNames, fileRecord, readTree, writeJsonNew, safeZipEntries, writeEntries} = require('./release-public-integrity');
const METADATA = 'RELEASE-INFO.json';
function assetNames(version) {
  if (!VERSION.test(version)) throw new Error('Invalid release version');
  return [`STILL-${version}-Setup-x64.exe`, 'SHA256SUMS.txt', 'BUILD-INFO.json', 'INSTALLER-INFO.json', METADATA];
}
function artifactName(version, commit) {if (!VERSION.test(version) || !COMMIT.test(commit)) throw new Error('Invalid candidate identity'); return `still-public-${version}-${commit}`;}
function gitState(root, run = spawnSync) {
  const execute = args => {const r = run('git', args, {cwd: root, encoding: 'utf8', windowsHide: true}); if (r.error || r.status !== 0) throw new Error('Cannot establish source Git identity'); return r.stdout.trim();};
  const commit = execute(['rev-parse', 'HEAD']), status = execute(['status', '--porcelain', '--untracked-files=normal']);
  if (!COMMIT.test(commit) || status) throw new Error('Release requires an exact clean committed source tree');
  return commit;
}
function candidateContext(env, version, commit, policy) {
  const branch = `release-candidate/${version}`, ref = `refs/heads/${branch}`;
  if (!VERSION.test(version) || !COMMIT.test(commit) || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REPOSITORY !== policy.repository || integer(env.GITHUB_REPOSITORY_ID, 'repository ID') !== policy.repositoryId ||
      env.GITHUB_REF !== ref || env.GITHUB_SHA !== commit || env.GITHUB_WORKFLOW_SHA !== commit || !policy.allowedActors.includes(env.GITHUB_ACTOR) || !policy.allowedActors.includes(env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_ACTOR) ||
      env.GITHUB_WORKFLOW_REF !== `${policy.repository}/${policy.candidateWorkflow}@${ref}`) throw new Error('Candidate event/source/workflow is not the approved own-repository push');
  return {repository: policy.repository, repositoryId: policy.repositoryId, actor: env.GITHUB_ACTOR, event: 'push', ref, workflow: policy.candidateWorkflow, workflowSha: commit,
    runId: integer(env.GITHUB_RUN_ID, 'candidate run ID'), runAttempt: integer(env.GITHUB_RUN_ATTEMPT, 'candidate run attempt')};
}
function promotionFromJson(message) {
  if (typeof message !== 'string' || Buffer.byteLength(message) > 4096) throw new Error('Invalid annotated tag message bound');
  const trimmed = message.trim(), value = JSON.parse(trimmed);
  exact(value, ['schemaVersion', 'version', 'commit', 'candidate_run_id', 'candidate_run_attempt', 'artifact_id', 'artifact_digest', 'setup_sha256', 'source_snapshot_sha256', 'release_info_sha256'], 'release promotion');
  // Canonical compact JSON also rejects duplicate keys and hidden trailing text.
  if (trimmed !== JSON.stringify(value) || value.schemaVersion !== 1 || !VERSION.test(value.version) || !COMMIT.test(value.commit) || !/^sha256:[a-f0-9]{64}$/.test(value.artifact_digest) ||
      ![value.setup_sha256, value.source_snapshot_sha256, value.release_info_sha256].every(hash => HASH.test(hash))) throw new Error('Invalid canonical annotated release promotion');
  for (const key of ['candidate_run_id', 'candidate_run_attempt', 'artifact_id']) if (typeof value[key] !== 'number' || integer(value[key], key) !== value[key]) throw new Error('Promotion IDs must be exact positive JSON integers');
  return Object.freeze(value);
}
function copyKnown(sourceRoot, relative, destinationRoot, destination) {
  const bytes = regularBytes(sourceRoot, relative), target = assertNoLinks(path.join(destinationRoot, destination), {allowMissing: true});
  fs.mkdirSync(path.dirname(target), {recursive: true}); assertNoLinks(path.dirname(target)); fs.writeFileSync(target, bytes, {flag: 'wx'});
  if (!regularBytes(destinationRoot, destination).equals(bytes)) throw new Error('Release copy differs');
}
function checksumText(releaseRoot, version) {
  return assetNames(version).filter(name => name !== 'SHA256SUMS.txt').map(name => `${sha256(regularBytes(releaseRoot, name))}  ${name}\n`).join('');
}
function verifyCandidateDirectory(bundleRoot, {sourceRoot = ROOT, expected, policy = loadRecipe(sourceRoot), pinOfficial = true} = {}) {
  bundleRoot = assertNoLinks(bundleRoot);
  const releaseRoot = path.join(bundleRoot, 'release'), raw = regularBytes(releaseRoot, METADATA), metadata = JSON.parse(raw);
  exact(metadata, ['schemaVersion', 'version', 'commit', 'gitDirty', 'sourceSnapshotSha256', 'context', 'assets', 'publicFiles'], 'candidate release metadata');
  if (metadata.schemaVersion !== 1 || !VERSION.test(metadata.version) || !COMMIT.test(metadata.commit) || metadata.gitDirty !== false || !HASH.test(metadata.sourceSnapshotSha256)) throw new Error('Candidate is not an exact clean version/commit');
  const context = metadata.context;
  exact(context, ['repository', 'repositoryId', 'actor', 'event', 'ref', 'workflow', 'workflowSha', 'runId', 'runAttempt'], 'candidate context');
  if (context.repository !== policy.repository || context.repositoryId !== policy.repositoryId || !policy.allowedActors.includes(context.actor) || context.event !== 'push' ||
      context.ref !== `refs/heads/release-candidate/${metadata.version}` || context.workflow !== policy.candidateWorkflow || context.workflowSha !== metadata.commit) throw new Error('Unapproved candidate origin');
  integer(context.runId, 'run ID'); integer(context.runAttempt, 'run attempt');
  const names = assetNames(metadata.version), sourceAssets = names.filter(name => !['SHA256SUMS.txt', METADATA].includes(name));
  assertNames(Object.keys(metadata.assets), sourceAssets, 'release asset hash table');
  assertNames(walkFiles(releaseRoot), names, 'release five-file namespace');
  for (const name of sourceAssets) {
    exact(metadata.assets[name], ['bytes', 'sha256'], 'release asset record');
    if (JSON.stringify(fileRecord(regularBytes(releaseRoot, name))) !== JSON.stringify(metadata.assets[name])) throw new Error('Candidate release asset differs');
  }
  if (regularBytes(releaseRoot, 'SHA256SUMS.txt').toString('utf8') !== checksumText(releaseRoot, metadata.version)) throw new Error('Candidate checksum table differs');
  const publicRoot = path.join(bundleRoot, 'public'), info = verifyPublicPackage(publicRoot, {sourceRoot, pinOfficial});
  if (info.version !== metadata.version || info.gitCommit !== metadata.commit || info.gitDirty !== false || info.sourceSnapshotSha256 !== metadata.sourceSnapshotSha256 || JSON.stringify(readTree(publicRoot)) !== JSON.stringify(metadata.publicFiles)) throw new Error('Candidate public tree/source binding differs');
  if (!regularBytes(publicRoot, 'BUILD-INFO.json').equals(regularBytes(releaseRoot, 'BUILD-INFO.json'))) throw new Error('Release and directory BUILD metadata differ');
  const installer = JSON.parse(regularBytes(releaseRoot, 'INSTALLER-INFO.json'));
  if (installer.version !== metadata.version || installer.installer.file !== names[0] || installer.installer.sha256 !== metadata.assets[names[0]].sha256 || installer.packageBuildInfoSha256 !== sha256(regularBytes(releaseRoot, 'BUILD-INFO.json')) || installer.sourceSnapshotSha256 !== metadata.sourceSnapshotSha256) throw new Error('Installer metadata differs from the promoted source/payload');
  assertNames(walkFiles(bundleRoot), [...Object.keys(metadata.publicFiles).map(name => `public/${name}`), ...names.map(name => `release/${name}`)], 'candidate artifact namespace');
  if (expected && (expected.version !== metadata.version || expected.commit !== metadata.commit || expected.candidate_run_id !== context.runId || expected.candidate_run_attempt !== context.runAttempt || expected.setup_sha256 !== metadata.assets[names[0]].sha256 || expected.source_snapshot_sha256 !== metadata.sourceSnapshotSha256 || expected.release_info_sha256 !== sha256(raw))) throw new Error('Candidate bytes do not match the exact annotated promotion');
  return {metadata, releaseRoot, releaseInfoSha256: sha256(raw), assets: Object.fromEntries(names.map(name => [name, fileRecord(regularBytes(releaseRoot, name))]))};
}
function buildCandidate({root = ROOT, env = process.env, runGit = spawnSync} = {}) {
  if (env.GH_TOKEN) throw new Error('Release-write token must not enter candidate build');
  const policy = loadRecipe(root), packageInfo = JSON.parse(regularBytes(root, 'package.json')), version = packageInfo.version, commit = gitState(root, runGit);
  const context = candidateContext(env, version, commit, policy);
  const packageRoot = path.join(root, `dist/Still-public-ci-${commit}`), installerRoot = path.join(root, `dist/Still-public-installer-ci-${commit}`);
  const bundleRoot = assertNoLinks(path.join(root, `dist/release-candidate-${commit}`), {allowMissing: true});
  if (fs.existsSync(bundleRoot)) throw new Error('Candidate bundle already exists');
  packagePublic({sourceRoot: root, outputDirectory: packageRoot, dependencyRoot: path.join(root, 'tools/release-ci/production')});
  buildInstaller({sourceRoot: root, packageDirectory: packageRoot, outputDirectory: installerRoot});
  if (gitState(root, runGit) !== commit) throw new Error('Source commit changed during candidate build');
  fs.mkdirSync(bundleRoot); fs.mkdirSync(path.join(bundleRoot, 'public')); fs.mkdirSync(path.join(bundleRoot, 'release'));
  for (const relative of walkFiles(packageRoot)) copyKnown(packageRoot, relative, bundleRoot, `public/${relative}`);
  const names = assetNames(version), releaseRoot = path.join(bundleRoot, 'release');
  copyKnown(installerRoot, names[0], bundleRoot, `release/${names[0]}`);
  copyKnown(packageRoot, 'BUILD-INFO.json', bundleRoot, 'release/BUILD-INFO.json');
  copyKnown(installerRoot, 'INSTALLER-INFO.json', bundleRoot, 'release/INSTALLER-INFO.json');
  const info = JSON.parse(regularBytes(packageRoot, 'BUILD-INFO.json'));
  const metadata = {schemaVersion: 1, version, commit, gitDirty: false, sourceSnapshotSha256: info.sourceSnapshotSha256, context,
    assets: Object.fromEntries([names[0], 'BUILD-INFO.json', 'INSTALLER-INFO.json'].map(name => [name, fileRecord(regularBytes(releaseRoot, name))])), publicFiles: readTree(path.join(bundleRoot, 'public'))};
  writeJsonNew(path.join(releaseRoot, METADATA), metadata);
  fs.writeFileSync(path.join(releaseRoot, 'SHA256SUMS.txt'), checksumText(releaseRoot, version), {flag: 'wx'});
  verifyCandidateDirectory(bundleRoot, {sourceRoot: root, policy});
  return {bundleRoot, artifactName: artifactName(version, commit), commit, version};
}
function inspectArtifact(archivePath, artifactMetadataPath, destination, {root = ROOT} = {}) {
  const policy = loadRecipe(root), archive = regularBytes(path.dirname(path.resolve(archivePath)), path.basename(archivePath)), artifact = JSON.parse(regularBytes(path.dirname(path.resolve(artifactMetadataPath)), path.basename(artifactMetadataPath)));
  if (artifact.expired !== false || artifact.digest !== `sha256:${sha256(archive)}` || artifact.size_in_bytes !== archive.length) throw new Error('Downloaded archive differs from its exact Actions artifact metadata');
  integer(artifact.id, 'artifact ID');
  writeEntries(safeZipEntries(archive), destination);
  const verified = verifyCandidateDirectory(destination, {sourceRoot: root, policy}), m = verified.metadata;
  if (artifact.name !== artifactName(m.version, m.commit) || artifact.workflow_run?.id !== m.context.runId || artifact.workflow_run?.head_sha !== m.commit || artifact.workflow_run?.repository_id !== policy.repositoryId || artifact.workflow_run?.head_repository_id !== policy.repositoryId || gitState(root) !== m.commit) throw new Error('Artifact/source metadata is not the checked out exact candidate');
  const promotion = {schemaVersion: 1, version: m.version, commit: m.commit, candidate_run_id: m.context.runId, candidate_run_attempt: m.context.runAttempt, artifact_id: artifact.id,
    artifact_digest: artifact.digest, setup_sha256: verified.assets[assetNames(m.version)[0]].sha256, source_snapshot_sha256: m.sourceSnapshotSha256, release_info_sha256: verified.releaseInfoSha256};
  promotionFromJson(JSON.stringify(promotion));
  const output = path.resolve(destination) + '.promotion.json'; assertNoLinks(output, {allowMissing: true}); fs.writeFileSync(output, JSON.stringify(promotion) + '\n', {flag: 'wx'});
  return {promotion, output};
}
function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === 'candidate') {
    const result = buildCandidate();
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact_name=${result.artifactName}\nartifact_path=${result.bundleRoot}\n`);
    process.stdout.write(`Clean candidate bundle prepared: ${result.artifactName}\n`); return;
  }
  if (args.length === 4 && args[0] === 'inspect') {const result = inspectArtifact(args[1], args[2], args[3]); process.stdout.write(`Exact artifact verified. Promotion JSON prepared only: ${result.output}\nNo tag, installation or release was created.\n`); return;}
  throw new Error('Usage: node scripts/release-public.js candidate | inspect <artifact.zip> <artifact-metadata.json> <fresh-directory>');
}
if (require.main === module) {try {main();} catch (error) {process.stderr.write(`${error.message}\n`); process.exitCode = 1;}}
module.exports = {METADATA, assetNames, artifactName, gitState, candidateContext, promotionFromJson, checksumText, verifyCandidateDirectory, buildCandidate, inspectArtifact};
