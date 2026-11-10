'use strict';
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const {spawnSync, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash, randomUUID} = require('node:crypto');
const {checkRendererAssets} = require('./build');
const {regularFile, sourceIsRunning} = require('./backend-manifest');
const {loadBackendBaselines, selectBackendBaseline} = require('./backend-baselines');
const {RUNTIME_REGISTRY_PATH, RUNTIME_ASSETS, readRuntimeAsset, verifyRuntimeAssets, assertRuntimeAssetSnapshot, assertRuntimeAssetHashes} = require('./runtime-assets');
const {CLIENT_SOURCE_PATH, CLIENT_REVISION_PATH, verifySpectrumClientRevision} = require('./spectrum-client-revision');
const {verifySpectrumDelivery, componentStatus, assertNoLinks, resolveRelative, regularBytes, COMPONENT_DIRECTORY, INCOMPLETE_MARKER} = require('./install-spectrum-component');
const root = path.resolve(__dirname, '..');
const defaultOutput = path.join(root, 'dist', 'Still-win32-x64');
const PACKAGE_INCOMPLETE_TEXT = 'Build in progress. Do not run this package until packaging finishes successfully.\r\n';
const RUNTIME_TOOLS = Object.freeze(['foobar-coreaudio-probe.exe', 'foobar-coreaudio-probe.cs']);
const APPLE_HOST_FILES = Object.freeze(['StillAppleHost.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll',
  'WebView2Loader.dll', 'official-bridge.js', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt']);
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const execute = promisify(execFile);
async function executableIsRunning(executable) {
  if (process.platform !== 'win32') return false;
  const filename = path.resolve(executable), name = path.basename(filename);
  if (!/^[a-z0-9._-]+\.exe$/i.test(name)) throw new Error('Invalid package executable name');
  const escaped = filename.replace(/'/g, "''");
  // An inaccessible executable path is uncertain, so fail closed for that name.
  const command = `$p = @(Get-CimInstance Win32_Process -Filter "Name='${name}'" -ErrorAction Stop | Where-Object { -not $_.ExecutablePath -or $_.ExecutablePath -eq '${escaped}' }); [Console]::Write($p.Count)`;
  const {stdout} = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide: true, timeout: 5000});
  if (!/^\d+$/.test(stdout.trim())) throw new Error('Unable to verify whether the package executable is running');
  return Number(stdout.trim()) > 0;
}
async function assertPackageStopped(output, {sourceRoot = root, isRunning = executableIsRunning, verifyBackend = verifyPrivateBackend} = {}) {
  // All checks precede runtime/app overwrites and never touch the original install.
  for (const executable of [path.join(output, 'Still.exe'), path.join(sourceRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(sourceRoot, 'backend', 'foobar2000', 'foobar2000.exe'), path.join(output, 'backend', 'foobar2000', 'foobar2000.exe')]) {
    if (await isRunning(executable)) throw new Error(`Close STILL and its private backend before packaging: ${executable}`);
  }
  await verifyBackend(path.join(sourceRoot, 'backend', 'foobar2000'));
  const target = path.join(output, 'backend', 'foobar2000');
  const existing = await fs.lstat(target).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
  if (existing) await verifyBackend(target);
}
async function readValidationEvidence(filename, sourceRoot = root) {
  const resolved = path.resolve(filename), relative = path.relative(sourceRoot, resolved).replaceAll('\\', '/');
  if (!/^(review-evidence|docs\/evidence)\/.+\.json$/.test(relative)) throw new Error('Validation evidence must be a JSON file under project review-evidence or docs/evidence');
  const file = await regularFile(sourceRoot, relative), stat = await fs.stat(file);
  if (stat.size > 1024 * 1024) throw new Error('Validation evidence is too large');
  const bytes = await fs.readFile(file), value = JSON.parse(bytes);
  if (!Number.isFinite(Date.parse(value.recordedAt)) || typeof value.source?.tests?.command !== 'string' ||
    !['passed', 'failed', 'skipped'].every(key => Number.isInteger(value.source.tests[key]) && value.source.tests[key] >= 0) ||
    typeof value.source.tests.log !== 'string' || typeof value.source?.build?.command !== 'string' ||
    typeof value.source.build.passed !== 'boolean' || typeof value.source.build.log !== 'string' ||
    typeof value.review?.status !== 'string' || typeof value.review.report !== 'string' || !Array.isArray(value.unverified) ||
    !value.unverified.every(item => typeof item === 'string')) throw new Error('Invalid current-delivery validation evidence');
  return {value, provenance: {file: relative, sha256: digest(bytes), recordedAt: value.recordedAt}};
}
async function preparePackageOutput(outputDirectory, distributionDirectory = path.join(root, 'dist')) {
  const output = path.resolve(outputDirectory), distribution = path.resolve(distributionDirectory);
  if (path.dirname(output).toLowerCase() !== distribution.toLowerCase() || !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,78}[a-zA-Z0-9_-])?$/.test(path.basename(output))) throw new Error('Package output must be a named direct child of Still/dist');
  // Reject redirected ancestors before creating a marker or copying a runtime.
  for (let cursor = output; ; cursor = path.dirname(cursor)) {
    const entry = await fs.lstat(cursor).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
    if (entry?.isSymbolicLink()) throw new Error('Package output or its parent cannot be a link or junction');
    if (path.dirname(cursor) === cursor) break;
  }
  await fs.mkdir(output, {recursive: true});
  if ((await fs.realpath(output)).toLowerCase() !== output.toLowerCase()) throw new Error('Resolved package output differs from the requested directory');
  return output;
}
async function copyRuntimeTools(sourceDirectory, appDirectory) {
  const target = path.join(appDirectory, 'scripts');
  await fs.mkdir(target, {recursive: true});
  for (const filename of RUNTIME_TOOLS) {
    const source = path.join(sourceDirectory, filename);
    const bytes = await fs.readFile(source);
    if (filename.endsWith('.exe') && !bytes.subarray(0, 2).equals(Buffer.from('MZ'))) throw new Error('CoreAudio release probe is not a Windows executable');
    await fs.writeFile(path.join(target, filename), bytes);
  }
}
async function copyAppleHost(sourceDirectory, appDirectory) {
  const target = path.join(appDirectory, 'native', 'apple-host', 'bin');
  await fs.mkdir(target, {recursive: true});
  for (const filename of APPLE_HOST_FILES) {
    const bytes = await fs.readFile(path.join(sourceDirectory, filename));
    if (/\.(exe|dll)$/.test(filename) && !bytes.subarray(0, 2).equals(Buffer.from('MZ'))) throw new Error(`Official web host resource is not a Windows executable: ${filename}`);
    await fs.writeFile(path.join(target, filename), bytes);
  }
}
async function copyRuntimeAssets(sourceRoot, appDirectory) {
  const snapshot = verifyRuntimeAssets(sourceRoot);
  assertNoLinks(appDirectory);
  // Optional reviewed desktop media payload. Legacy two-asset packages keep
  // the exact original copy path; never recurse over native source/build.
  const optionalGroups = [{asset: snapshot.desktopMedia, prefix: 'native/desktop-media/bin'}, {asset: snapshot.cueReadLease, prefix: 'native/cue-read-lease/bin'}].filter(group => group.asset);
  function assertOptionalDestinations(temporary) {
    for (const group of optionalGroups) {
      const outputDirectory = resolveRelative(appDirectory, group.prefix), parent = path.dirname(outputDirectory);
      for (const [directory, isParent] of [[parent, true], [outputDirectory, false]]) {
      assertNoLinks(directory, {allowMissing: true});
      if (!syncFs.existsSync(directory)) continue;
      if (!syncFs.lstatSync(directory).isDirectory()) throw new Error('Desktop media destination is not a directory');
      for (const entry of syncFs.readdirSync(directory, {withFileTypes: true})) {
        if (isParent) {
          if (entry.name !== 'bin' || !entry.isDirectory()) throw new Error('Desktop media destination contains an unknown entry');
          continue;
        }
        const relativePath = `${group.prefix}/${entry.name}`, expected = group.asset.files.find(file => file.relativePath === relativePath);
        if (!entry.isFile() || !expected && !(group.prefix === temporary?.prefix && entry.name === temporary.name)) throw new Error('Desktop media/CUE destination contains an unknown or linked entry');
        const bytes = regularBytes(appDirectory, relativePath), expectedSha = expected?.sha256 || temporary.sha256;
        if (digest(bytes) !== expectedSha) throw new Error('Desktop media destination has changed or unreviewed bytes');
        }
      }
    }
  }
  assertOptionalDestinations();
  const optionalInputs = optionalGroups.flatMap(group => group.asset.files.map(file => {
    const bytes = regularBytes(sourceRoot, file.relativePath);
    if (digest(bytes) !== file.sha256) throw new Error('Desktop media source changed after validation');
    return {file, bytes, prefix: group.prefix};
  }));
  // The existing src copy supplies the reviewed policy and registry. Only the
  // one fixed launcher is copied from native; never recurse over backend-job.
  for (const relative of [RUNTIME_REGISTRY_PATH, RUNTIME_ASSETS.backendOutputPolicy.relativePath]) {
    if (digest(regularBytes(appDirectory, relative)) !== snapshot.hashes[relative]) throw new Error('Copied runtime asset metadata differs from the reviewed source snapshot');
  }
  const relative = RUNTIME_ASSETS.backendLauncher.relativePath, directory = resolveRelative(appDirectory, 'native/backend-job');
  assertNoLinks(directory, {allowMissing: true});
  const existing = await fs.lstat(directory).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
  if (existing && !existing.isDirectory()) throw new Error('Runtime launcher destination is not a directory');
  if (existing) for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    if (entry.name !== path.basename(relative) || !entry.isFile()) throw new Error('Runtime launcher destination has an unknown or linked entry');
    regularBytes(appDirectory, relative);
  }
  const bytes = readRuntimeAsset(sourceRoot, 'backendLauncher');
  if (digest(bytes) !== snapshot.hashes[relative]) throw new Error('Runtime launcher changed after validation');
  assertRuntimeAssetSnapshot(snapshot, verifyRuntimeAssets(sourceRoot));
  await fs.mkdir(directory, {recursive: true});
  const temporary = assertNoLinks(path.join(directory, `.runtime-launcher-${randomUUID()}.tmp`), {allowMissing: true});
  await fs.writeFile(temporary, bytes, {flag: 'wx'});
  if (digest(regularBytes(appDirectory, path.relative(appDirectory, temporary).replaceAll('\\', '/'))) !== snapshot.hashes[relative]) throw new Error('Staged runtime launcher changed');
  const target = assertNoLinks(resolveRelative(appDirectory, relative), {allowMissing: true});
  const targetEntry = await fs.lstat(target).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
  if (targetEntry) regularBytes(appDirectory, relative);
  assertRuntimeAssetSnapshot(snapshot, verifyRuntimeAssets(sourceRoot));
  // Rename a separately verified file instead of truncating a possible
  // same-name hardlink introduced while the source snapshot was copied.
  await fs.rename(temporary, target);
  if (optionalGroups.length) {
    assertOptionalDestinations();
    for (const group of optionalGroups) await fs.mkdir(resolveRelative(appDirectory, group.prefix), {recursive: true});
    assertOptionalDestinations();
    for (const input of optionalInputs) {
      assertRuntimeAssetSnapshot(snapshot, verifyRuntimeAssets(sourceRoot));
      const name = `.optional-runtime-${randomUUID()}.tmp`, staged = assertNoLinks(path.join(resolveRelative(appDirectory, input.prefix), name), {allowMissing: true});
      await fs.writeFile(staged, input.bytes, {flag: 'wx'});
      assertOptionalDestinations({name, sha256: input.file.sha256, prefix: input.prefix});
      assertRuntimeAssetSnapshot(snapshot, verifyRuntimeAssets(sourceRoot));
      const destination = assertNoLinks(resolveRelative(appDirectory, input.file.relativePath), {allowMissing: true});
      if (syncFs.existsSync(destination)) regularBytes(appDirectory, input.file.relativePath);
      await fs.rename(staged, destination);
      assertOptionalDestinations();
    }
  }
  assertRuntimeAssetSnapshot(snapshot, verifyRuntimeAssets(appDirectory));
  assertRuntimeAssetSnapshot(snapshot, verifyRuntimeAssets(sourceRoot));
  return snapshot;
}
function spectrumClientSnapshot(value) {
  return JSON.parse(JSON.stringify({clientSource: value.clientSource, clientRevision: value.clientRevision, clientHashes: value.clientHashes}));
}
function assertSpectrumClientSnapshot(expected, actual) {
  if (JSON.stringify(spectrumClientSnapshot(expected)) !== JSON.stringify(spectrumClientSnapshot(actual))) throw new Error('Spectrum client revision snapshot changed');
}
function assertClientRevisionDirectory(directory, {temporaryRelative} = {}) {
  assertNoLinks(directory, {allowMissing: true});
  let existing;
  try {existing = syncFs.lstatSync(directory);} catch (error) {if (error.code === 'ENOENT') return; throw error;}
  if (!existing.isDirectory()) throw new Error('Spectrum client revision destination is not a directory');
  for (const entry of syncFs.readdirSync(directory, {withFileTypes: true})) {
    if (![path.basename(CLIENT_REVISION_PATH), temporaryRelative].includes(entry.name) || !entry.isFile()) throw new Error(`Unknown spectrum client revision destination entry: ${entry.name}`);
    metadataFileSnapshot(directory, entry.name);
  }
}
function assertPackagedSpectrumClient(appDirectory, snapshot, verifyClientRevision) {
  assertSpectrumClientSnapshot(snapshot, verifyClientRevision(appDirectory));
  const directory = resolveRelative(appDirectory, 'manifests');
  assertClientRevisionDirectory(directory);
  if (snapshot.clientRevision === null && metadataFileSnapshot(appDirectory, CLIENT_REVISION_PATH, {allowMissing: true}) !== null) throw new Error('Legacy spectrum client package must omit the client revision record');
}
async function copySpectrumClientRevision(sourceRoot, appDirectory, {verifyClientRevision = verifySpectrumClientRevision} = {}) {
  const snapshot = spectrumClientSnapshot(verifyClientRevision(sourceRoot));
  const appAncestors = metadataAncestors(appDirectory), directory = resolveRelative(appDirectory, 'manifests'), relative = path.basename(CLIENT_REVISION_PATH);
  assertClientRevisionDirectory(directory);
  const previous = metadataFileSnapshot(appDirectory, CLIENT_REVISION_PATH, {allowMissing: true});
  const clientBytes = regularBytes(appDirectory, CLIENT_SOURCE_PATH);
  if (clientBytes.length !== snapshot.clientSource.bytes || digest(clientBytes) !== snapshot.clientSource.sha256) throw new Error('Copied spectrum client differs from the reviewed source revision');
  if (snapshot.clientRevision === null) {
    if (previous !== null) throw new Error('Legacy spectrum client package must omit the client revision record');
    assertPackagedSpectrumClient(appDirectory, snapshot, verifyClientRevision);
    assertSpectrumClientSnapshot(snapshot, verifyClientRevision(sourceRoot));
    return snapshot;
  }
  const bytes = regularBytes(sourceRoot, CLIENT_REVISION_PATH), expectedSha256 = snapshot.clientRevision.rawSha256;
  if (digest(bytes) !== expectedSha256 || snapshot.clientHashes[CLIENT_REVISION_PATH] !== expectedSha256) throw new Error('Spectrum client revision record differs from its verified snapshot');
  if (previous && previous.sha256 !== expectedSha256) throw new Error('Copied spectrum client revision record has unknown bytes; retained for review');
  const existingAncestors = syncFs.existsSync(directory) ? metadataAncestors(directory) : null;
  await fs.mkdir(directory, {recursive: true});
  assertMetadataAncestors(appAncestors);
  if (existingAncestors) assertMetadataAncestors(existingAncestors);
  assertClientRevisionDirectory(directory);
  const expected = prepareMetadataWrite(directory, relative);
  if (!sameMetadataFile(expected.target, previous)) throw new Error('Spectrum client revision destination changed before staging; retained for review');
  assertSpectrumClientSnapshot(snapshot, verifyClientRevision(sourceRoot));
  await publishPackageMetadata(directory, relative, bytes, expected, temporaryRelative => {
    assertClientRevisionDirectory(directory, {temporaryRelative});
    assertSpectrumClientSnapshot(snapshot, verifyClientRevision(sourceRoot));
    const currentClient = regularBytes(appDirectory, CLIENT_SOURCE_PATH);
    if (currentClient.length !== snapshot.clientSource.bytes || digest(currentClient) !== snapshot.clientSource.sha256) throw new Error('Copied spectrum client changed during revision staging');
  });
  assertMetadataAncestors(appAncestors);
  assertPackagedSpectrumClient(appDirectory, snapshot, verifyClientRevision);
  assertSpectrumClientSnapshot(snapshot, verifyClientRevision(sourceRoot));
  return snapshot;
}
async function copySpectrumRuntime(sourceRoot, appDirectory, {verifySpectrum = verifySpectrumDelivery, verifyClientRevision = verifySpectrumClientRevision} = {}) {
  const delivery = verifySpectrum(sourceRoot);
  assertNoLinks(appDirectory, {allowMissing: true});
  const spectrumDirectory = resolveRelative(appDirectory, 'native/foobar-spectrum');
  const packageDirectory = resolveRelative(appDirectory, 'native/foobar-spectrum/package');
  // A previous build must not smuggle tools, caches, a DLL or other native files
  // into the recursive BUILD-INFO hash walk below.
  async function assertRuntimeDestination() {
    for (const [directory, allowed] of [[spectrumDirectory, ['package']],
      [packageDirectory, delivery.applicationRuntimeFiles.map(file => path.basename(file.appRelativePath))]]) {
      assertNoLinks(directory, {allowMissing: true});
      const existing = await fs.lstat(directory).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
      if (existing && !existing.isDirectory()) throw new Error('Spectrum runtime destination is not a directory');
      if (existing) for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
        if (!allowed.includes(entry.name) || entry.isSymbolicLink() || (directory === packageDirectory && !entry.isFile())) throw new Error(`Unknown spectrum runtime destination entry: ${entry.name}`);
        assertNoLinks(path.join(directory, entry.name));
        if (entry.isFile() && (await fs.stat(path.join(directory, entry.name))).nlink !== 1) throw new Error('Linked spectrum runtime destination is forbidden');
      }
    }
  }
  await assertRuntimeDestination();
  // Read and validate the complete allowlist before creating any destination.
  const entries = delivery.applicationRuntimeFiles.map(file => ({file, bytes: regularBytes(sourceRoot, file.sourceRelativePath)}));
  assertSpectrumClientSnapshot(delivery, verifyClientRevision(sourceRoot));
  const client = await copySpectrumClientRevision(sourceRoot, appDirectory, {verifyClientRevision});
  assertSpectrumClientSnapshot(delivery, client);
  // The added record staging await must not leave the original native
  // destination checks stale before the existing native copy sequence.
  await assertRuntimeDestination();
  await fs.mkdir(packageDirectory, {recursive: true});
  const hashes = {};
  for (const {file, bytes} of entries) {
    const target = assertNoLinks(resolveRelative(appDirectory, file.appRelativePath), {allowMissing: true});
    await fs.writeFile(target, bytes);
    if (digest(await fs.readFile(target)) !== file.sha256) throw new Error(`Packaged spectrum runtime verification failed: ${file.appRelativePath}`);
    hashes[file.appRelativePath] = file.sha256;
  }
  return {deliveryManifestSha256: delivery.manifestSha256, ...client, hashes, runtimeNotValidated: delivery.runtimeNotValidated};
}
function verifySpectrumManifestLineage(manifest, delivery, {sourceRoot = root, baselines} = {}) {
  if (!baselines) {
    const registry = loadBackendBaselines(sourceRoot);
    baselines = ['source', 'target'].map(kind => selectBackendBaseline(registry, kind, sourceRoot));
  }
  const provenance = manifest.spectrumComponent, baseline = baselines.find(item => item.sha256 === provenance?.beforeManifestSha256);
  if (!baseline) throw new Error('Private spectrum migration provenance has an unreviewed baseline');
  const expectedProvenance = {schemaVersion: 1, deliveryManifestSha256: delivery.manifestSha256, beforeManifestSha256: baseline.sha256, componentDirectory: COMPONENT_DIRECTORY};
  const expectedTail = delivery.privateBackendComponentFiles.map(file => ({relativePath: file.privateBackendRelativePath, mutable: false, mode: 'copy', bytes: file.bytes, sha256: file.sha256, sourceSha256: file.sha256}));
  if (JSON.stringify(provenance) !== JSON.stringify(expectedProvenance) || JSON.stringify(manifest.files.slice(-4)) !== JSON.stringify(expectedTail)) throw new Error('Private spectrum manifest differs from the exact reviewed four-entry delta');
  const restored = {...manifest, totalFiles: manifest.totalFiles - 4, totalBytes: manifest.totalBytes - expectedTail.reduce((sum, file) => sum + file.bytes, 0), files: manifest.files.slice(0, -4)};
  delete restored.spectrumComponent;
  if (baseline.kind === 'source' && manifest.packagedFromBackendId !== undefined) {
    const destination = path.resolve(manifest.destinationDir), packageDirectory = path.dirname(path.dirname(destination));
    if (manifest.packagedFromBackendId !== baseline.backendId || !/^[a-f0-9-]{36}$/i.test(manifest.backendId) || manifest.backendId === baseline.backendId ||
      !Number.isFinite(Date.parse(manifest.packagedAt)) || path.basename(destination).toLowerCase() !== 'foobar2000' || path.basename(path.dirname(destination)).toLowerCase() !== 'backend' ||
      path.dirname(packageDirectory).toLowerCase() !== path.join(sourceRoot, 'dist').toLowerCase() || !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,78}[a-zA-Z0-9_-])?$/.test(path.basename(packageDirectory))) throw new Error('A cloned spectrum backend has an unreviewed package identity or destination');
    restored.backendId = baseline.backendId; restored.destinationDir = baseline.destinationDir;
    delete restored.packagedAt; delete restored.packagedFromBackendId;
  }
  if (digest(Buffer.from(JSON.stringify(restored))) !== baseline.canonicalSha256) throw new Error('Old backend manifest entries or metadata changed beyond the reviewed spectrum delta');
  return {reviewedBaselineSha256: baseline.sha256, oldManifestContentVerified: true};
}
async function verifySpectrumBackend(directory, manifest, {sourceRoot = root} = {}) {
  const delivery = verifySpectrumDelivery(sourceRoot);
  async function rejectIncompleteMarker() {
    if (await fs.lstat(path.join(directory, INCOMPLETE_MARKER)).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;})) throw new Error('Private backend has an incomplete spectrum component transaction');
  }
  await rejectIncompleteMarker();
  const actualManifest = regularBytes(directory, 'backend-manifest.json');
  if (JSON.stringify(JSON.parse(actualManifest)) !== JSON.stringify(manifest)) throw new Error('Private backend manifest changed during spectrum verification');
  const status = componentStatus(manifest, delivery), provenance = manifest.spectrumComponent;
  if (!status.installed || provenance?.schemaVersion !== 1 || provenance.deliveryManifestSha256 !== delivery.manifestSha256 || provenance.componentDirectory !== COMPONENT_DIRECTORY ||
    !/^[a-f0-9]{64}$/.test(provenance.beforeManifestSha256 || '')) throw new Error('Private backend requires the separately reviewed four-file spectrum component migration; packaging never installs it implicitly');
  const componentEntries = manifest.files.filter(file => file.relativePath.startsWith(`${COMPONENT_DIRECTORY}/`));
  const expectedNames = delivery.privateBackendComponentFiles.map(file => path.basename(file.privateBackendRelativePath));
  if (componentEntries.length !== 4) throw new Error('Private spectrum manifest must contain exactly the reviewed four component entries');
  for (const entry of await fs.readdir(resolveRelative(directory, COMPONENT_DIRECTORY), {withFileTypes: true})) {
    if (!expectedNames.includes(entry.name) || !entry.isFile()) throw new Error('Private spectrum component directory has an unknown or linked entry');
  }
  const lineage = verifySpectrumManifestLineage(manifest, delivery, {sourceRoot});
  for (const file of delivery.privateBackendComponentFiles) {
    const bytes = regularBytes(directory, file.privateBackendRelativePath);
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Installed private spectrum component integrity failed: ${file.privateBackendRelativePath}`);
  }
  await rejectIncompleteMarker();
  return {...status, ...lineage, actualFilesVerified: true, manifestSha256: digest(actualManifest)};
}
async function verifyPrivateBackend(directory, {sourceRoot = root} = {}) {
  assertNoLinks(directory);
  const resolved = path.resolve(directory), real = await fs.realpath(resolved);
  if (real.toLowerCase() !== resolved.toLowerCase()) throw new Error('Private backend cannot be a junction or symbolic link');
  const manifest = JSON.parse(await fs.readFile(await regularFile(directory, 'backend-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.privateUseOnly !== true || !Array.isArray(manifest.files)) throw new Error('A reviewed, assembled private backend manifest is required');
  for (const required of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    if (!manifest.files.some(item => item.relativePath === required)) throw new Error(`Private backend manifest is missing ${required}`);
  }
  for (const item of manifest.files) {
    const file = await regularFile(directory, item.relativePath);
    if (!item.mutable && digest(await fs.readFile(file)) !== item.sha256) throw new Error(`Private backend failed integrity check: ${item.relativePath}`);
  }
  const config = JSON.parse(await fs.readFile(await regularFile(directory, 'profile/beefweb/config.json'), 'utf8'));
  if (config.port !== manifest.configuration?.port || config.port === 8880 || !Number.isInteger(config.port) || config.allowRemote !== false || !config.musicDirs?.length) throw new Error('Private backend configuration is not the reviewed dedicated loopback configuration');
  await verifySpectrumBackend(directory, manifest, {sourceRoot});
  return manifest;
}
async function copyPrivateBackend(source, target, {sourceRoot = root, isRunning = sourceIsRunning} = {}) {
  const manifest = await verifyPrivateBackend(source, {sourceRoot});
  if (await isRunning(source)) throw new Error('Close the source STILL backend before packaging its private profile');
  if (await fs.lstat(target).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;})) {
    const existing = await verifyPrivateBackend(target, {sourceRoot});
    if (await isRunning(target)) throw new Error('Close the packaged STILL backend before rebuilding');
    await verifySpectrumBackend(source, manifest, {sourceRoot});
    await verifySpectrumBackend(target, existing, {sourceRoot});
    return {reused: true, manifest: existing};
  }
  await fs.mkdir(path.dirname(target), {recursive: true});
  const parent = await fs.realpath(path.dirname(target));
  if (path.resolve(parent).toLowerCase() !== path.resolve(path.dirname(target)).toLowerCase()) throw new Error('Private backend package parent cannot be a link');
  const stage = path.join(path.dirname(target), `.still-package-backend-${randomUUID()}`);
  await fs.mkdir(stage);
  // Only the reviewed manifest files and dedicated config are copied. Never
  // recurse over the original installation, music, caches, playlists or backups.
  for (const relative of [...manifest.files.map(item => item.relativePath), 'profile/beefweb/config.json']) {
    const destination = path.join(stage, ...relative.split('/'));
    await fs.mkdir(path.dirname(destination), {recursive: true});
    await fs.copyFile(await regularFile(source, relative), destination);
  }
  await fs.writeFile(path.join(stage, 'backend-manifest.json'), JSON.stringify({...manifest, backendId: randomUUID(),
    destinationDir: target, packagedAt: new Date().toISOString(), packagedFromBackendId: manifest.backendId}, null, 2), {flag: 'wx'});
  await verifyPrivateBackend(stage, {sourceRoot});
  if (await isRunning(source)) throw new Error(`Source backend started while packaging; incomplete stage retained at ${stage}`);
  await verifySpectrumBackend(source, manifest, {sourceRoot});
  await fs.rename(stage, target);
  return {reused: false, manifest: await verifyPrivateBackend(target, {sourceRoot})};
}
function frozenSourceSnapshot(hashes) {
  return digest(Buffer.from(JSON.stringify(Object.entries(hashes)
    .filter(([filename]) => /^resources\/app\/(src|native|scripts)\//.test(filename) || filename === `resources/app/${CLIENT_REVISION_PATH}`).sort(([a], [b]) => a.localeCompare(b)))));
}
function assertFinalSpectrumRecords(snapshot, buildInfo) {
  assertSpectrumClientSnapshot(snapshot, buildInfo.spectrum || {});
  for (const [relative, sha256] of Object.entries(snapshot.clientHashes)) {
    if (buildInfo.hashes[`resources/app/${relative}`] !== sha256) throw new Error('BUILD spectrum client hashes differ from the frozen revision');
  }
  if (snapshot.clientRevision === null && Object.hasOwn(buildInfo.hashes, `resources/app/${CLIENT_REVISION_PATH}`)) throw new Error('Legacy BUILD cannot include a spectrum client revision record');
}
function assertFinalRuntimeRecords(runtimeAssets, buildInfo) {
  if (!buildInfo.hashes || typeof buildInfo.hashes !== 'object' || Array.isArray(buildInfo.hashes)) throw new Error('BUILD runtime hashes are missing');
  assertRuntimeAssetHashes(runtimeAssets, buildInfo.hashes);
  if (buildInfo.sourceFrozenSnapshot !== frozenSourceSnapshot(buildInfo.hashes)) throw new Error('BUILD sourceFrozen snapshot differs from its hash map');
  if (JSON.stringify(buildInfo.runtimeAssets) !== JSON.stringify({...runtimeAssets, launcherRuntimeValidated: false})) throw new Error('BUILD runtime asset record differs from the verified snapshot');
}
function metadataAncestors(outputDirectory) {
  const result = [];
  for (let cursor = assertNoLinks(path.resolve(outputDirectory)); ; cursor = path.dirname(cursor)) {
    const entry = syncFs.lstatSync(cursor, {bigint: true});
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Package metadata ancestor is not an unlinked directory');
    // A temporary file changes its parent's timestamps; only volume/file IDs
    // identify these directories across the awaited stage write.
    result.push(Object.freeze({filename: cursor, dev: entry.dev, ino: entry.ino}));
    if (path.dirname(cursor) === cursor) break;
  }
  return Object.freeze(result);
}
function assertMetadataAncestors(expected) {
  for (const {filename, dev, ino} of expected) {
    const entry = syncFs.lstatSync(assertNoLinks(filename), {bigint: true});
    if (!entry.isDirectory() || entry.dev !== dev || entry.ino !== ino) throw new Error('Package metadata ancestor changed; retained for review');
  }
}
function sameMetadataFile(actual, expected) {
  return actual === null || expected === null ? actual === expected :
    ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'sha256'].every(key => actual[key] === expected[key]);
}
function metadataFileSnapshot(outputDirectory, relative, {allowMissing = false} = {}) {
  const filename = assertNoLinks(resolveRelative(outputDirectory, relative), {allowMissing});
  let named;
  try {named = syncFs.lstatSync(filename, {bigint: true});} catch (error) {if (allowMissing && error.code === 'ENOENT') return null; throw error;}
  const valid = stat => stat.isFile() && stat.nlink === 1n && stat.size <= 16n * 1024n * 1024n;
  if (!valid(named)) throw new Error('Package metadata must be a small unlinked regular file');
  const descriptor = syncFs.openSync(filename, 'r');
  try {
    const before = syncFs.fstatSync(descriptor, {bigint: true});
    if (!valid(before)) throw new Error('Package metadata must be a small unlinked regular file');
    const bytes = syncFs.readFileSync(descriptor), after = syncFs.fstatSync(descriptor, {bigint: true});
    const current = syncFs.lstatSync(assertNoLinks(filename), {bigint: true});
    if (![named, after, current].every(stat => valid(stat) && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === before[key])) ||
      BigInt(bytes.length) !== before.size) throw new Error('Package metadata changed during snapshot; retained for review');
    return Object.freeze({dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs, sha256: digest(bytes)});
  } finally {syncFs.closeSync(descriptor);}
}
function prepareMetadataWrite(outputDirectory, relative) {
  return {ancestors: metadataAncestors(outputDirectory), target: metadataFileSnapshot(outputDirectory, relative, {allowMissing: true})};
}
function assertMetadataReceipt(outputDirectory, relative, owned, expectedSha256) {
  const label = relative === '.package-incomplete' ? 'incomplete marker' : relative;
  if (!owned || owned.directory !== path.resolve(outputDirectory) || owned.relative !== relative) throw new Error(`Package ${label} ownership is missing`);
  assertMetadataAncestors(owned.ancestors);
  const current = metadataFileSnapshot(outputDirectory, relative);
  if (!sameMetadataFile(current, owned.file) || current.sha256 !== expectedSha256) throw new Error(`Package ${label} identity or bytes changed; retained for review`);
}
async function publishPackageMetadata(outputDirectory, relative, bytes, expected, beforeRename) {
  const filename = resolveRelative(outputDirectory, relative);
  const temporaryRelative = `.package-metadata-${randomUUID()}.tmp`, temporary = resolveRelative(outputDirectory, temporaryRelative);
  assertMetadataAncestors(expected.ancestors);
  if (!sameMetadataFile(metadataFileSnapshot(outputDirectory, relative, {allowMissing: true}), expected.target)) throw new Error(`Package ${relative} changed before staging; retained for review`);
  const file = await fs.open(temporary, 'wx');
  let stagedIdentity;
  try {
    stagedIdentity = syncFs.fstatSync(file.fd, {bigint: true});
    const named = metadataFileSnapshot(outputDirectory, temporaryRelative);
    assertMetadataAncestors(expected.ancestors);
    if (named.dev !== stagedIdentity.dev || named.ino !== stagedIdentity.ino || stagedIdentity.nlink !== 1n || stagedIdentity.size !== 0n ||
      !sameMetadataFile(metadataFileSnapshot(outputDirectory, relative, {allowMissing: true}), expected.target)) throw new Error(`Package ${relative} or its stage changed before writing; retained for review`);
    await file.writeFile(bytes);
    await file.sync();
  } finally {await file.close();}
  // No await separates these identity/byte checks from publication. Never
  // truncate a destination or clean up a path that another writer replaced.
  assertMetadataAncestors(expected.ancestors);
  if (beforeRename) beforeRename(temporaryRelative);
  assertMetadataAncestors(expected.ancestors);
  if (!sameMetadataFile(metadataFileSnapshot(outputDirectory, relative, {allowMissing: true}), expected.target)) throw new Error(`Package ${relative} changed during staging; retained for review`);
  const staged = metadataFileSnapshot(outputDirectory, temporaryRelative), expectedSha256 = digest(Buffer.from(bytes));
  if (staged.dev !== stagedIdentity.dev || staged.ino !== stagedIdentity.ino || staged.size !== BigInt(Buffer.byteLength(bytes)) || staged.sha256 !== expectedSha256) throw new Error('Package metadata stage identity or bytes changed; retained for review');
  syncFs.renameSync(temporary, filename);
  assertMetadataAncestors(expected.ancestors);
  const published = metadataFileSnapshot(outputDirectory, relative);
  if (published.dev !== staged.dev || published.ino !== staged.ino || published.size !== staged.size || published.sha256 !== expectedSha256) throw new Error('Published package metadata changed; retained for review');
  return Object.freeze({directory: path.resolve(outputDirectory), relative, ancestors: expected.ancestors, file: published});
}
function assertPackageIncompleteMarker(outputDirectory, ownedMarker) {
  assertMetadataReceipt(outputDirectory, '.package-incomplete', ownedMarker, digest(Buffer.from(PACKAGE_INCOMPLETE_TEXT)));
}
async function createPackageIncompleteMarker(outputDirectory) {
  const relative = '.package-incomplete', expected = prepareMetadataWrite(outputDirectory, relative);
  if (expected.target && expected.target.sha256 !== digest(Buffer.from(PACKAGE_INCOMPLETE_TEXT))) throw new Error('Package incomplete marker has unknown bytes; retained for review');
  return publishPackageMetadata(outputDirectory, relative, PACKAGE_INCOMPLETE_TEXT, expected);
}
async function finalizePackage({sourceRoot = root, outputDirectory, runtimeAssets, buildInfo, ownedMarker, spectrumClient}, {writeBuildInfo, verifyClientRevision = verifySpectrumClientRevision} = {}) {
  const appDirectory = path.join(outputDirectory, 'resources', 'app');
  const client = spectrumClientSnapshot(spectrumClient || verifyClientRevision(sourceRoot));
  // Capture immutable expected bytes before the awaited writer can yield.
  const serialized = JSON.stringify(buildInfo, null, 2), expectedBuildSha256 = digest(Buffer.from(serialized)), recorded = JSON.parse(serialized);
  assertRuntimeAssetSnapshot(runtimeAssets, verifyRuntimeAssets(sourceRoot));
  assertRuntimeAssetSnapshot(runtimeAssets, verifyRuntimeAssets(appDirectory));
  assertFinalRuntimeRecords(runtimeAssets, recorded);
  assertSpectrumClientSnapshot(client, verifyClientRevision(sourceRoot));
  assertPackagedSpectrumClient(appDirectory, client, verifyClientRevision);
  assertFinalSpectrumRecords(client, recorded);
  assertPackageIncompleteMarker(outputDirectory, ownedMarker);
  const expected = prepareMetadataWrite(outputDirectory, 'BUILD-INFO.json');
  const publish = () => publishPackageMetadata(outputDirectory, 'BUILD-INFO.json', serialized, expected);
  const ownedBuild = await (writeBuildInfo ? writeBuildInfo(path.join(outputDirectory, 'BUILD-INFO.json'), serialized, publish) : publish());
  // This entire completion gate is synchronous. A failed comparison retains
  // the marker, BUILD evidence and any unknown bytes for explicit review.
  assertRuntimeAssetSnapshot(runtimeAssets, verifyRuntimeAssets(sourceRoot));
  assertRuntimeAssetSnapshot(runtimeAssets, verifyRuntimeAssets(appDirectory));
  assertFinalRuntimeRecords(runtimeAssets, recorded);
  assertSpectrumClientSnapshot(client, verifyClientRevision(sourceRoot));
  assertPackagedSpectrumClient(appDirectory, client, verifyClientRevision);
  assertFinalSpectrumRecords(client, recorded);
  assertMetadataReceipt(outputDirectory, 'BUILD-INFO.json', ownedBuild, expectedBuildSha256);
  assertPackageIncompleteMarker(outputDirectory, ownedMarker);
  syncFs.unlinkSync(path.join(outputDirectory, '.package-incomplete'));
}
async function main({outputDir = defaultOutput, visualVersion = 'V1 functionality preview', validationFile} = {}) {
  const runtimeAssetPreflight = verifyRuntimeAssets(root);
  const clientPreflight = spectrumClientSnapshot(verifySpectrumClientRevision(root));
  const output = await preparePackageOutput(outputDir);
  if (typeof visualVersion !== 'string' || !/^[a-zA-Z0-9 ._-]{1,80}$/.test(visualVersion)) throw new Error('Invalid visual version label');
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the Windows x64 directory package on Windows x64');
  const evidence = validationFile ? await readValidationEvidence(validationFile) : null;
  await assertPackageStopped(output);
  const build = spawnSync(process.execPath, [path.join(__dirname, 'build.js')], {stdio: 'inherit'});
  if (build.status !== 0) process.exit(build.status || 1);
  // Avoid deleting previous builds or any portable user data. Build each version in place.
  await fs.mkdir(output, {recursive: true});
  const ownedMarker = await createPackageIncompleteMarker(output);
  const electronDir = path.dirname(require('electron'));
  await fs.cp(electronDir, output, {recursive: true, force: true});
  const electronExe = path.join(output, 'electron.exe');
  await fs.copyFile(electronExe, path.join(output, 'Still.exe'));
  await fs.unlink(electronExe);
  const appDir = path.join(output, 'resources', 'app');
  await fs.mkdir(appDir, {recursive: true});
  await fs.cp(path.join(root, 'src'), path.join(appDir, 'src'), {recursive: true, force: true});
  await fs.cp(path.join(root, 'docs'), path.join(appDir, 'docs'), {recursive: true, force: true});
  const runtimeAssets = await copyRuntimeAssets(root, appDir);
  assertRuntimeAssetSnapshot(runtimeAssetPreflight, runtimeAssets);
  await copyRuntimeTools(path.join(root, 'scripts'), appDir);
  await copyAppleHost(path.join(root, 'native', 'apple-host', 'bin'), appDir);
  const spectrumRuntime = await copySpectrumRuntime(root, appDir);
  assertSpectrumClientSnapshot(clientPreflight, spectrumRuntime);
  const backend = await copyPrivateBackend(path.join(root, 'backend', 'foobar2000'), path.join(output, 'backend', 'foobar2000'));
  for (const filename of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(root, filename), path.join(appDir, filename));
  console.log('Application source/native snapshot copied into the private package.');
  // npm ci resolves exactly the audited lockfile, excluding Electron and all dev packages.
  const npmCli = path.join(root, 'tools', 'npm', 'bin', 'npm-cli.js');
  const install = spawnSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'], {cwd: appDir, stdio: 'inherit'});
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error('Runtime dependency installation failed; package is incomplete.');
  await fs.mkdir(path.join(output, 'data'), {recursive: true});
  await fs.writeFile(path.join(output, 'START-HERE.txt'), `STILL · 静室\r\n\r\n` +
    `运行 / Run\r\n` +
    `1. 保持整个 ${path.basename(output)} 目录完整，双击 Still.exe。不要单独移动 exe。\r\n` +
    `   Keep this whole directory together and run Still.exe.\r\n` +
    `2. STILL 自动管理 backend\\foobar2000 中的专属便携内核，仅显示新界面；无需另开原 foobar2000。\r\n` +
    `   STILL manages its own private portable backend; no separate original foobar2000 window is needed.\r\n` +
    `3. 后端离线时应用会显示未连接；音乐库导入成功不等于后端已获文件访问权限。\r\n` +
    `   Offline status and backend file-access failures remain visible.\r\n\r\n` +
    `设备断开与内核连接状态分别显示。原设备重连后，请明确点击重试；不会自动恢复播放。\r\n` +
    `Device disconnection and backend connection are shown separately. After reconnecting the original device, explicitly retry; playback does not resume automatically.\r\n\r\n` +
    `位置 / Locations\r\n` +
    `后端固定为本目录 backend\\foobar2000；缺失或异常时显示真实离线状态，不回连原安装。\r\n` +
    `The backend is backend\\foobar2000 beside Still.exe. Missing/failed backends remain visibly offline.\r\n` +
    `data 是 STILL 自身库、列表、歌词与偏好；音乐文件仍留在原位置。\r\n` +
    `data contains STILL state. Imported audio stays at its original location.\r\n\r\n` +
    `界面 / Interface\r\n` +
    `设置可选封面原色或主题色。矩阵显示当前真实播放列表的相邻项；拖动通过原生上一首/下一首切换并读回结果。\r\n` +
    `Settings offers original artwork colors or theme colors. The matrix shows adjacent items in the current playlist; dragging uses native previous/next and reads the result back.\r\n` +
    `底栏仅保留一条波形进度条与播放控制；歌词、播放模式、临时队列与输出统一在设置内。\r\n` +
    `The bottom bar contains one waveform seek bar and playback controls. Lyrics, playback mode, temporary queue and output are in Settings.\r\n` +
    `频谱仅使用经验证的本地 SDK 实际 PCM 数据；Apple 或无有效数据时显示静态轨道。sampleRate 是分析采样率，不代表 DAC 输出采样率。\r\n` +
    `Spectrum uses verified local SDK PCM only; Apple or missing data leaves the spectrum track static. sampleRate is the analysis rate, not the DAC output rate.\r\n` +
    `界面与限制 / UI and limits: resources\\app\\docs\\ui-redesign-glass.md\r\n` +
    `频谱说明 / Spectrum: resources\\app\\docs\\audio-spectrum.md\r\n\r\n` +
    `恢复 / Restore\r\n` +
    `先退出 STILL，再复制/重命名 data 作备份。不要把旧 foobar profile 备份覆盖到 STILL data。\r\n` +
    `Close STILL before copying or renaming data. The original foobar profile is a separate backup.\r\n` +
    `完整说明 / Full guide: resources\\app\\docs\\foobar-install-restore.md\r\n` +
    `原备份（不由本程序改动）/ Original backup (never changed by this app):\r\n` +
    `D:\\foobar2000\\Still-backup-20261028-before-beefweb\r\n\r\n` +
    `Apple Music 使用官方网页的系统共享音频路线；本应用不提供其 USB 真独占、bit-perfect 或自动切率。现有认证状态原地保留。\r\n` +
    `Apple Music uses the official web player and system audio. This adapter does not provide USB exclusive output, bit-perfect playback or automatic DAC rate switching. Existing sign-in state stays in place.\r\n` +
    `当前检查结果和未验证项见 BUILD-INFO.json 中的 validation；设备恢复和 Apple 输出边界见 resources\\app\\docs\\playback-recovery-20261108.md。\r\n` +
    `See BUILD-INFO.json validation for current check results and unverified items, and resources\\app\\docs\\playback-recovery-20261108.md for output limits and recovery.\r\n` +
    `此目录包只供本用户私用，不是可公开分发的修改版 foobar2000。保留所有许可证。\r\n` +
    `Private local bundle only; do not redistribute this assembled foobar2000. Retain all licenses.\r\n` +
    `此目录包未签名。没有安装器，也不需要管理员权限。\r\n` +
    `Unsigned directory build. No installer or administrator privileges required.\r\n`);
  checkRendererAssets(path.join(appDir, 'src', 'renderer'));
  if (!(await fs.readFile(path.join(output, 'Still.exe'))).subarray(0, 2).equals(Buffer.from('MZ'))) throw new Error('Packaged executable is not a Windows PE image');
  const hashes = {};
  async function hashFiles(directory) {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await hashFiles(filename);
      else if (entry.isFile()) hashes[path.relative(output, filename).replaceAll('\\', '/')] = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    }
  }
  await hashFiles(path.join(appDir, 'src'));
  await hashFiles(path.join(appDir, 'docs'));
  await hashFiles(path.join(appDir, 'scripts'));
  await hashFiles(path.join(appDir, 'native'));
  for (const [relative, expected] of Object.entries(spectrumRuntime.clientHashes)) {
    const actual = digest(regularBytes(appDir, relative)), key = `resources/app/${relative}`;
    if (actual !== expected || (Object.hasOwn(hashes, key) && hashes[key] !== expected)) throw new Error('Spectrum client revision changed before the package snapshot was frozen');
    hashes[key] = actual;
  }
  assertRuntimeAssetSnapshot(runtimeAssets, verifyRuntimeAssets(root));
  assertRuntimeAssetSnapshot(runtimeAssets, verifyRuntimeAssets(appDir));
  assertRuntimeAssetHashes(runtimeAssets, hashes);
  for (const [relative, expected] of Object.entries(spectrumRuntime.hashes)) {
    if (hashes[`resources/app/${relative}`] !== expected) throw new Error('Spectrum runtime changed before the package snapshot was frozen');
  }
  if (hashes[`resources/app/${spectrumRuntime.clientSource.relativePath}`] !== spectrumRuntime.clientSource.sha256) throw new Error('Spectrum client changed before the package snapshot was frozen');
  hashes['Still.exe'] = digest(await fs.readFile(path.join(output, 'Still.exe')));
  for (const relative of [...backend.manifest.files.map(item => item.relativePath), 'backend-manifest.json', 'profile/beefweb/config.json']) {
    const file = await regularFile(path.join(output, 'backend', 'foobar2000'), relative);
    hashes[`backend/foobar2000/${relative}`] = digest(await fs.readFile(file));
  }
  for (const filename of ['package.json', 'package-lock.json']) hashes[`resources/app/${filename}`] = createHash('sha256').update(await fs.readFile(path.join(appDir, filename))).digest('hex');
  const sourceFrozenSnapshot = frozenSourceSnapshot(hashes);
  const spectrumBackend = await verifySpectrumBackend(path.join(output, 'backend', 'foobar2000'), backend.manifest);
  for (const file of spectrumBackend.files) {
    if (hashes[`backend/foobar2000/${file.relativePath}`] !== file.sha256) throw new Error('Private spectrum files changed before BUILD-INFO was frozen');
  }
  if (hashes['backend/foobar2000/backend-manifest.json'] !== spectrumBackend.manifestSha256) throw new Error('Private backend manifest changed before BUILD-INFO was frozen');
  const validation = evidence?.value ?? await fs.readFile(path.join(root, 'docs', 'evidence', 'desktop-test-status-20261030.json'), 'utf8').then(JSON.parse, () => null);
  const buildInfo = {builtAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    electron: require('electron/package.json').version, appVersion: require('../package.json').version,
    privateUseOnly: true, preview: true, visualVersion, applePlaybackMaintenance: require('../src/main/main').APPLE_PLAYBACK_MAINTENANCE, sourceFrozenSnapshot, validation,
    validationProvenance: evidence?.provenance ?? {file: 'docs/evidence/desktop-test-status-20261030.json', historical: true},
    backendReused: backend.reused, backendId: backend.manifest.backendId,
    runtimeAssets: {...runtimeAssets, launcherRuntimeValidated: false},
    spectrum: {...spectrumRuntime, hostRuntimeValidated: false, backendComponent: spectrumBackend}, hashes};
  await finalizePackage({sourceRoot: root, outputDirectory: output, runtimeAssets, buildInfo, ownedMarker, spectrumClient: spectrumRuntime});
  console.log(`Windows directory package: ${path.join(output, 'Still.exe')}`);
}
if (require.main === module) {
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--output-dir' && args[index + 1]) options.outputDir = args[++index];
    else if (args[index] === '--visual-version' && args[index + 1]) options.visualVersion = args[++index];
    else if (args[index] === '--validation-file' && args[index + 1]) options.validationFile = args[++index];
    else throw new Error('Use --output-dir <Still/dist/name>, optional --visual-version <label> and --validation-file <project evidence JSON>');
  }
  main(options).catch(error => {console.error(error); process.exitCode = 1;});
}
module.exports = {preparePackageOutput, assertPackageStopped, executableIsRunning, readValidationEvidence,
  copyRuntimeTools, copyAppleHost, copyRuntimeAssets, copySpectrumClientRevision, copySpectrumRuntime, verifySpectrumManifestLineage, verifySpectrumBackend, verifyPrivateBackend, copyPrivateBackend,
  createPackageIncompleteMarker, finalizePackage, frozenSourceSnapshot, PACKAGE_INCOMPLETE_TEXT, RUNTIME_TOOLS, APPLE_HOST_FILES};
