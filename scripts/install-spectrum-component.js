'use strict';
// This command plans by default. It never launches or stops a player/helper.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {loadBackendBaselines, selectBackendBaseline} = require('./backend-baselines');
const {verifySpectrumClientRevision} = require('./spectrum-client-revision');
const execute = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const DELIVERY_PATH = 'native/foobar-spectrum/delivery-manifest.json';
const DELIVERY_SHA256 = '284dae8ad48b96a464c635d8e848bc20d1699dfa74948987f8765d4ac94a131f';
const COMPONENT_DIRECTORY = 'profile/user-components-x64/foo_still_spectrum';
// Consumer contract: the backend manager gates this marker; main may give the
// reader only its current verified owned backendSession. The fixed reader does
// not read backend paths, profiles or this marker itself.
const INCOMPLETE_MARKER = '.spectrum-component-install-incomplete.json';
const APPLY_AUTHORIZATION = 'apply-reviewed-spectrum-component-only';
const ROLLBACK_AUTHORIZATION = 'rollback-reviewed-spectrum-component-only';
const RUNTIME_NAMES = Object.freeze(['StillSpectrumReader.exe', 'foobar2000-sdk-license.txt', 'pfc-license.txt', 'COMPONENT-DETAILS.md']);
const COMPONENT_NAMES = Object.freeze(['foo_still_spectrum.dll', 'foobar2000-sdk-license.txt', 'pfc-license.txt', 'COMPONENT-DETAILS.md']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function inside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function resolveRelative(root, relative) {
  if (typeof relative !== 'string' || !relative || /[\\:\0-\x1f]/.test(relative) || relative.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) throw new Error('Invalid closed relative path');
  const filename = path.resolve(root, ...relative.split('/'));
  if (!inside(root, filename)) throw new Error('Relative path escapes root');
  return filename;
}
const closedDestination = (root, relative) => assertNoLinks(resolveRelative(root, relative), {allowMissing: true});
function assertNoLinks(filename, {allowMissing = false} = {}) {
  const resolved = path.resolve(filename);
  for (let cursor = resolved; ; cursor = path.dirname(cursor)) {
    let entry;
    try {entry = fs.lstatSync(cursor);} catch (error) {if (allowMissing && error.code === 'ENOENT') entry = null; else throw error;}
    if (entry?.isSymbolicLink()) throw new Error(`Link or junction is forbidden: ${cursor}`);
    if (path.dirname(cursor) === cursor) break;
  }
  if (fs.existsSync(resolved) && !samePath(fs.realpathSync(resolved), resolved)) throw new Error('Resolved path differs from its closed path');
  return resolved;
}
function exactFileStat(stat) {
  if (!['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => typeof stat[key] === 'bigint')) throw new Error('Expected exact bigint spectrum file identity');
  return stat;
}
function regularBytes(root, relative) {
  const filename = assertNoLinks(resolveRelative(root, relative)), descriptor = fs.openSync(filename, 'r');
  try {
    const before = exactFileStat(fs.fstatSync(descriptor, {bigint: true}));
    if (!before.isFile() || before.nlink !== 1n) throw new Error(`Expected an unlinked regular file: ${relative}`);
    const bytes = fs.readFileSync(descriptor), after = exactFileStat(fs.fstatSync(descriptor, {bigint: true}));
    const named = exactFileStat(fs.lstatSync(assertNoLinks(filename), {bigint: true}));
    if (![after, named].every(stat => stat.isFile() && stat.nlink === 1n && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === before[key])) ||
      BigInt(bytes.length) !== before.size) throw new Error(`File changed during snapshot: ${relative}`);
    return bytes;
  } finally {fs.closeSync(descriptor);}
}
function assertPeX64(bytes, filename) {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error(`Not a Windows PE x64 image: ${filename}`);
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 26 || bytes.readUInt32LE(offset) !== 0x4550 || bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b) throw new Error(`Not a Windows PE x64 image: ${filename}`);
}
function verifySpectrumDelivery(sourceRoot = ROOT) {
  sourceRoot = assertNoLinks(path.resolve(sourceRoot));
  const manifestBytes = regularBytes(sourceRoot, DELIVERY_PATH);
  if (sha256(manifestBytes) !== DELIVERY_SHA256) throw new Error('Spectrum delivery manifest does not match the reviewed SHA256');
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schemaVersion !== 1 || manifest.architecture !== 'x64') throw new Error('Invalid spectrum delivery schema or architecture');
  const checkGroup = (items, names, destinationKey, prefix) => {
    if (!Array.isArray(items) || items.length !== names.length) throw new Error('Spectrum delivery whitelist count differs');
    return items.map((item, index) => {
      const name = names[index];
      if (item.sourceRelativePath !== `native/foobar-spectrum/package/${name}` || item[destinationKey] !== `${prefix}/${name}` ||
        !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Spectrum delivery entry escapes the fixed whitelist');
      const bytes = regularBytes(sourceRoot, item.sourceRelativePath);
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`Spectrum delivery integrity failed: ${name}`);
      if (/\.(exe|dll)$/i.test(name)) assertPeX64(bytes, name);
      return {...item};
    });
  };
  const applicationRuntimeFiles = checkGroup(manifest.applicationRuntimeFiles, RUNTIME_NAMES, 'appRelativePath', 'native/foobar-spectrum/package');
  const privateBackendComponentFiles = checkGroup(manifest.privateBackendComponentFiles, COMPONENT_NAMES, 'privateBackendRelativePath', COMPONENT_DIRECTORY);
  const client = manifest.clientSource;
  if (client?.relativePath !== 'src/main/spectrum-client.js' || client.bytes !== 20573 || client.sha256 !== 'b7967d3723ab742b9f426a8ae0d00024616d04f2849bd1a2bf30a50b5da7b652') throw new Error('Spectrum client differs from the reviewed source contract');
  const revision = verifySpectrumClientRevision(sourceRoot);
  return {manifestSha256: DELIVERY_SHA256, applicationRuntimeFiles, privateBackendComponentFiles, ...revision, runtimeNotValidated: [...manifest.runtimeNotValidated]};
}
function componentStatus(manifest, delivery = verifySpectrumDelivery()) {
  const installed = delivery.privateBackendComponentFiles.every(file => manifest.files?.some(entry => entry.relativePath === file.privateBackendRelativePath && entry.mutable === false && entry.bytes === file.bytes && entry.sha256 === file.sha256));
  return {installed, deliveryManifestSha256: delivery.manifestSha256,
    files: delivery.privateBackendComponentFiles.map(file => ({relativePath: file.privateBackendRelativePath, bytes: file.bytes, sha256: file.sha256}))};
}
function backendLocation(sourceRoot, backendDir) {
  sourceRoot = assertNoLinks(path.resolve(sourceRoot));
  backendDir = assertNoLinks(path.resolve(backendDir));
  const locations = {source: path.join(sourceRoot, 'backend', 'foobar2000'), target: path.join(sourceRoot, 'dist', 'Still-V2-preview-win32-x64', 'backend', 'foobar2000')};
  const kind = Object.keys(locations).find(key => samePath(locations[key], backendDir));
  if (!kind) throw new Error('Backend must be the exact private source or V2 preview backend directory');
  const project = JSON.parse(regularBytes(sourceRoot, 'package.json'));
  if (project.name !== 'still-desktop' || project.private !== true) throw new Error('The source root must be the private STILL project');
  return {sourceRoot, backendDir, kind};
}
function fileSnapshot(backendDir, relativePath) {
  const bytes = regularBytes(backendDir, relativePath);
  return {relativePath, bytes: bytes.length, sha256: sha256(bytes)};
}
function present(root, relative) {
  const filename = assertNoLinks(resolveRelative(root, relative), {allowMissing: true});
  try {return exactFileStat(fs.lstatSync(filename, {bigint: true}));} catch (error) {if (error.code === 'ENOENT') return null; throw error;}
}
function planSpectrumInstall({sourceRoot = ROOT, backendDir = path.join(sourceRoot, 'backend', 'foobar2000')} = {}) {
  const location = backendLocation(sourceRoot, backendDir);
  ({sourceRoot, backendDir} = location);
  const delivery = verifySpectrumDelivery(sourceRoot);
  if (present(backendDir, INCOMPLETE_MARKER)) throw new Error('An incomplete spectrum transaction requires reviewed recovery');
  const beforeBytes = regularBytes(backendDir, 'backend-manifest.json'), manifest = JSON.parse(beforeBytes);
  const beforeManifestSha256 = sha256(beforeBytes);
  const registry = loadBackendBaselines(sourceRoot), baseline = selectBackendBaseline(registry, location.kind, sourceRoot);
  if (beforeManifestSha256 !== baseline.sha256 || manifest.backendId !== baseline.backendId) throw new Error('Private backend manifest differs from the exact reviewed pre-install baseline');
  if (manifest.schemaVersion !== 1 || manifest.privateUseOnly !== true || !Array.isArray(manifest.files) || !manifest.files.length ||
    !/^[a-f0-9-]{36}$/i.test(manifest.backendId) || !samePath(manifest.destinationDir, backendDir) || manifest.executable !== 'foobar2000.exe') throw new Error('Invalid private backend identity or destination');
  if (manifest.totalFiles !== manifest.files.length || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes !== manifest.files.reduce((sum, entry) => sum + entry.bytes, 0)) throw new Error('Private backend manifest totals are inconsistent');
  const seen = new Set(), oldFiles = manifest.files.map(entry => {
    resolveRelative(backendDir, entry.relativePath);
    const key = entry.relativePath.toLowerCase();
    if (seen.has(key) || typeof entry.mutable !== 'boolean' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.mode !== 'string') throw new Error('Invalid or duplicate old manifest entry');
    seen.add(key);
    const snapshot = fileSnapshot(backendDir, entry.relativePath);
    if (!entry.mutable && (snapshot.bytes !== entry.bytes || snapshot.sha256 !== entry.sha256)) throw new Error(`Immutable old backend entry mismatch: ${entry.relativePath}`);
    return snapshot;
  });
  for (const required of ['foobar2000.exe', 'portable_mode_enabled', 'components/foo_ui_std.dll', 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll']) {
    if (!seen.has(required.toLowerCase())) throw new Error(`Private backend is missing ${required}`);
  }
  const configBytes = regularBytes(backendDir, 'profile/beefweb/config.json'), config = JSON.parse(configBytes);
  if (JSON.stringify(config) !== JSON.stringify(manifest.configuration) || config.allowRemote !== false || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || config.port === 8880 || !Array.isArray(config.musicDirs) || !config.musicDirs.length) throw new Error('Dedicated backend configuration differs from its reviewed manifest');
  const componentDirectoryExisted = Boolean(present(backendDir, COMPONENT_DIRECTORY));
  if (componentDirectoryExisted) {
    if (!fs.statSync(resolveRelative(backendDir, COMPONENT_DIRECTORY)).isDirectory()) throw new Error('Component destination is not a directory');
    for (const name of fs.readdirSync(resolveRelative(backendDir, COMPONENT_DIRECTORY))) {
      if (!COMPONENT_NAMES.includes(name)) throw new Error(`Unknown component destination entry: ${name}`);
    }
  }
  const additions = [], files = delivery.privateBackendComponentFiles.map(file => {
    const relativePath = file.privateBackendRelativePath, existing = manifest.files.find(entry => entry.relativePath === relativePath);
    if (!existing && present(backendDir, relativePath)) throw new Error(`Unknown existing component file: ${relativePath}`);
    if (existing && (existing.mutable !== false || existing.bytes !== file.bytes || existing.sha256 !== file.sha256)) throw new Error(`Existing authorized component differs from delivery: ${relativePath}`);
    if (!existing) additions.push({relativePath, mutable: false, mode: 'copy', bytes: file.bytes, sha256: file.sha256, sourceSha256: file.sha256});
    return {...file, action: existing ? 'retained' : 'added'};
  });
  const afterManifest = {...manifest, totalFiles: manifest.totalFiles + additions.length,
    totalBytes: manifest.totalBytes + additions.reduce((sum, entry) => sum + entry.bytes, 0), files: [...manifest.files, ...additions],
    spectrumComponent: {schemaVersion: 1, deliveryManifestSha256: delivery.manifestSha256, beforeManifestSha256, componentDirectory: COMPONENT_DIRECTORY}};
  return {schemaVersion: 1, operation: 'install-private-spectrum-component', dryRun: true, sourceRoot, backendDir, backendKind: location.kind,
    backendId: manifest.backendId, baselinePolicySha256: registry.policySha256, deliveryManifestSha256: delivery.manifestSha256, beforeManifestSha256, beforeManifestBytes: beforeBytes.length,
    afterManifestSha256: sha256(jsonBytes(afterManifest)), oldFiles, configuration: {...fileSnapshot(backendDir, 'profile/beefweb/config.json')},
    componentDirectoryExisted, componentFiles: files, afterManifest, writes: {componentFiles: files.filter(file => file.action === 'added').map(file => file.privateBackendRelativePath),
      manifest: 'backend-manifest.json', temporaryMarker: INCOMPLETE_MARKER}, runtimeNotValidated: delivery.runtimeNotValidated};
}
const planSha256 = plan => sha256(Buffer.from(JSON.stringify(plan)));
async function inspectProcesses(names) {
  if (process.platform !== 'win32') throw new Error('Exact stopped-state inspection requires Windows');
  if (!names.every(name => /^[a-z0-9._-]+\.exe$/i.test(name))) throw new Error('Invalid process name');
  const clauses = names.map(name => `Name='${name}'`).join(' OR ');
  const command = `$items = @(Get-CimInstance Win32_Process -Filter \"${clauses}\" -ErrorAction Stop | ForEach-Object { [PSCustomObject]@{name=$_.Name; executablePath=$_.ExecutablePath} }); ConvertTo-Json -InputObject $items -Compress`;
  const {stdout} = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {windowsHide: true, timeout: 10000});
  const result = JSON.parse(stdout);
  if (!Array.isArray(result)) throw new Error('Unable to verify stopped state');
  return result;
}
async function assertStopped(plan, processInspector = inspectProcesses) {
  const backendExecutables = plan.afterManifest.files.filter(file => /\.exe$/i.test(file.relativePath)).map(file => resolveRelative(plan.backendDir, file.relativePath));
  const applicationRoot = plan.backendKind === 'source' ? plan.sourceRoot : path.dirname(path.dirname(plan.backendDir));
  const appRoot = plan.backendKind === 'source' ? applicationRoot : path.join(applicationRoot, 'resources', 'app');
  const executables = [...backendExecutables, path.join(applicationRoot, 'Still.exe'),
    ...(plan.backendKind === 'source' ? [path.join(plan.sourceRoot, 'node_modules', 'electron', 'dist', 'electron.exe')] : []),
    path.join(appRoot, 'native', 'apple-host', 'bin', 'StillAppleHost.exe'), path.join(appRoot, 'native', 'foobar-spectrum', 'package', 'StillSpectrumReader.exe')];
  const names = [...new Set(executables.map(file => path.basename(file).toLowerCase()))];
  const processes = await processInspector(names);
  if (!Array.isArray(processes)) throw new Error('Stopped-state inspector returned invalid evidence');
  for (const item of processes) {
    if (!item || typeof item.name !== 'string' || !names.includes(item.name.toLowerCase()) || (item.executablePath != null && typeof item.executablePath !== 'string')) throw new Error('Stopped-state inspector returned an invalid process');
    if (!item.executablePath || executables.some(file => samePath(file, item.executablePath)) || inside(plan.backendDir, item.executablePath)) throw new Error(`Private backend/app/helper is running or same-name executable path is unreadable: ${item.name}`);
  }
  for (const relative of ['profile/running', 'profile/config.sqlite-wal', 'profile/config.sqlite-shm']) {
    if (present(plan.backendDir, relative)) throw new Error(`Require a freshly closed backend without ${relative}`);
  }
  return {checkedAt: new Date().toISOString(), processNames: names, matchingProcesses: 0, runtimeArtifactsAbsent: true};
}
function evidenceLocation(sourceRoot, evidenceDir) {
  const directory = path.resolve(evidenceDir);
  if (!inside(path.join(sourceRoot, 'review-evidence'), directory) || !/^spectrum-package-[a-z0-9._-]+$/i.test(path.basename(directory))) throw new Error('Transaction evidence must be a spectrum-package-* directory under project review-evidence');
  return assertNoLinks(directory, {allowMissing: true});
}
async function writeJournal(directory, value) {
  const temporary = path.join(directory, `.journal-${randomUUID()}.json`);
  await writeExclusive(temporary, jsonBytes(value));
  await fsp.rename(temporary, path.join(directory, 'transaction.json'));
}
async function writeExclusive(filename, bytes) {
  assertNoLinks(filename, {allowMissing: true});
  const handle = await fsp.open(filename, 'wx');
  try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
}
function unchangedOldFiles(plan) {
  for (const expected of [...plan.oldFiles, plan.configuration]) {
    const actual = fileSnapshot(plan.backendDir, expected.relativePath);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw new Error(`Old backend bytes changed: ${expected.relativePath}`);
  }
}
function assertReviewedPlan(plan, expectedPlanSha256) {
  if (plan?.schemaVersion !== 1 || plan.operation !== 'install-private-spectrum-component' || plan.dryRun !== true || !/^[a-f0-9]{64}$/.test(expectedPlanSha256 || '') || planSha256(plan) !== expectedPlanSha256) throw new Error('An exact reviewed plan SHA256 is required');
  backendLocation(plan.sourceRoot, plan.backendDir);
  verifySpectrumDelivery(plan.sourceRoot);
}
function assertInstallPolicy(plan, expectedPlanSha256) {
  if (planSha256(plan) !== expectedPlanSha256 || loadBackendBaselines(plan.sourceRoot).policySha256 !== plan.baselinePolicySha256) throw new Error('Reviewed backend baseline policy or plan changed during installation');
}
function writeBackendExclusive(plan, expectedPlanSha256, filename, bytes, {firstWrite = false} = {}) {
  assertNoLinks(filename, {allowMissing: true});
  if (firstWrite && planSha256(planSpectrumInstall({sourceRoot: plan.sourceRoot, backendDir: plan.backendDir})) !== expectedPlanSha256) throw new Error('Backend baseline policy or bytes changed before first write');
  assertInstallPolicy(plan, expectedPlanSha256);
  // Keep validation and the actual backend mutation in one synchronous turn.
  // Evidence/journal I/O stays asynchronous; rollback uses its recorded plan.
  const descriptor = fs.openSync(filename, 'wx');
  try {fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor);} finally {fs.closeSync(descriptor);}
}
async function applySpectrumInstall(plan, {expectedPlanSha256, authorization, evidenceDir, processInspector = inspectProcesses, onPhase = async () => {}} = {}) {
  if (authorization !== APPLY_AUTHORIZATION) throw new Error('Explicit reviewed component-only apply authorization is required');
  assertReviewedPlan(plan, expectedPlanSha256);
  const fresh = planSpectrumInstall({sourceRoot: plan.sourceRoot, backendDir: plan.backendDir});
  if (planSha256(fresh) !== expectedPlanSha256) throw new Error('Backend bytes or manifest changed after review; generate a fresh plan');
  const stopped = await assertStopped(plan, processInspector);
  if (!evidenceDir) throw new Error('A transaction evidence directory is required');
  evidenceDir = evidenceLocation(plan.sourceRoot, evidenceDir);
  if (fs.existsSync(evidenceDir)) throw new Error('Transaction evidence directory already exists');
  // No filesystem mutation occurs above this point, including on running failures.
  const transactionId = randomUUID();
  const journal = {schemaVersion: 1, transactionId, planSha256: expectedPlanSha256, phase: 'staging', plan, stopped};
  await fsp.mkdir(evidenceDir, {recursive: true});
  try {
    await writeJournal(evidenceDir, journal);
    await fsp.mkdir(path.join(evidenceDir, 'stage'));
    await fsp.mkdir(path.join(evidenceDir, 'before'));
    await writeExclusive(path.join(evidenceDir, 'before', 'backend-manifest.json'), regularBytes(plan.backendDir, 'backend-manifest.json'));
    await writeExclusive(path.join(evidenceDir, 'after-backend-manifest.json'), jsonBytes(plan.afterManifest));
    for (const file of plan.componentFiles) {
      const name = path.basename(file.privateBackendRelativePath), bytes = regularBytes(plan.sourceRoot, file.sourceRelativePath);
      await writeExclusive(path.join(evidenceDir, 'stage', name), bytes);
      if (file.action === 'retained') await writeExclusive(path.join(evidenceDir, 'before', name), regularBytes(plan.backendDir, file.privateBackendRelativePath));
    }
    if (planSha256(planSpectrumInstall({sourceRoot: plan.sourceRoot, backendDir: plan.backendDir})) !== expectedPlanSha256) throw new Error('Backend changed while staging; no backend write performed');
    journal.stoppedBeforeCommit = await assertStopped(plan, processInspector);
    journal.phase = 'prepared'; await writeJournal(evidenceDir, journal); await onPhase('prepared');
    await assertStopped(plan, processInspector);
    const marker = {schemaVersion: 1, transactionId, planSha256: expectedPlanSha256, evidenceDir};
    writeBackendExclusive(plan, expectedPlanSha256, closedDestination(plan.backendDir, INCOMPLETE_MARKER), jsonBytes(marker), {firstWrite: true});
    journal.phase = 'installing-files'; await writeJournal(evidenceDir, journal);
    const componentDestination = closedDestination(plan.backendDir, COMPONENT_DIRECTORY);
    assertInstallPolicy(plan, expectedPlanSha256);
    fs.mkdirSync(componentDestination, {recursive: true});
    for (const file of plan.componentFiles) {
      await assertStopped(plan, processInspector);
      if (file.action === 'added') {
        const staged = regularBytes(evidenceDir, `stage/${path.basename(file.privateBackendRelativePath)}`);
        if (staged.length !== file.bytes || sha256(staged) !== file.sha256) throw new Error('Staged component integrity failed');
        writeBackendExclusive(plan, expectedPlanSha256, closedDestination(plan.backendDir, file.privateBackendRelativePath), staged);
      }
      await onPhase(`file:${path.basename(file.privateBackendRelativePath)}`);
    }
    unchangedOldFiles(plan);
    await assertStopped(plan, processInspector);
    journal.phase = 'committing-manifest'; await writeJournal(evidenceDir, journal);
    const temporary = closedDestination(plan.backendDir, `.spectrum-component-manifest-${transactionId}.json`);
    writeBackendExclusive(plan, expectedPlanSha256, temporary, jsonBytes(plan.afterManifest));
    const manifestDestination = closedDestination(plan.backendDir, 'backend-manifest.json');
    assertInstallPolicy(plan, expectedPlanSha256);
    fs.renameSync(temporary, manifestDestination);
    await onPhase('manifest-committed');
    unchangedOldFiles(plan);
    for (const file of plan.componentFiles) {
      const actual = fileSnapshot(plan.backendDir, file.privateBackendRelativePath);
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) throw new Error('Installed component verification failed');
    }
    if (sha256(regularBytes(plan.backendDir, 'backend-manifest.json')) !== plan.afterManifestSha256) throw new Error('Installed manifest verification failed');
    assertInstallPolicy(plan, expectedPlanSha256);
    journal.phase = 'completed'; journal.completedAt = new Date().toISOString();
    journal.report = {backendId: plan.backendId, beforeManifestSha256: plan.beforeManifestSha256, afterManifestSha256: plan.afterManifestSha256,
      addedFiles: plan.componentFiles.filter(file => file.action === 'added').map(file => ({relativePath: file.privateBackendRelativePath, bytes: file.bytes, sha256: file.sha256})),
      oldManifestEntriesUnchanged: true, oldBackendBytesUnchanged: true, configurationUnchanged: true, currentDataTouched: false};
    await writeJournal(evidenceDir, journal);
    const markerDestination = closedDestination(plan.backendDir, INCOMPLETE_MARKER);
    assertInstallPolicy(plan, expectedPlanSha256);
    fs.unlinkSync(markerDestination);
    return {...journal.report, transactionId, evidenceDir};
  } catch (error) {
    delete journal.completedAt;
    journal.failedPhase = journal.phase; journal.phase = 'failed'; journal.error = error.message;
    await writeJournal(evidenceDir, journal).catch(() => {});
    error.transactionEvidence = evidenceDir;
    throw error;
  }
}
async function rollbackSpectrumInstall(evidenceDir, {sourceRoot = ROOT, expectedPlanSha256, authorization, processInspector = inspectProcesses, onPhase = async () => {}} = {}) {
  if (authorization !== ROLLBACK_AUTHORIZATION) throw new Error('Explicit reviewed component-only rollback authorization is required');
  evidenceDir = evidenceLocation(path.resolve(sourceRoot), evidenceDir);
  const journal = JSON.parse(regularBytes(evidenceDir, 'transaction.json')), plan = journal.plan;
  if (!samePath(plan?.sourceRoot || '', sourceRoot) || journal.planSha256 !== expectedPlanSha256 || !/^[a-f0-9-]{36}$/.test(journal.transactionId || '')) throw new Error('Recovery evidence identity differs');
  assertReviewedPlan(plan, expectedPlanSha256);
  const beforeBytes = regularBytes(evidenceDir, 'before/backend-manifest.json');
  if (sha256(beforeBytes) !== plan.beforeManifestSha256 || sha256(regularBytes(evidenceDir, 'after-backend-manifest.json')) !== plan.afterManifestSha256) throw new Error('Recovery manifest backup integrity failed');
  let expectedManifestSha256 = sha256(regularBytes(plan.backendDir, 'backend-manifest.json'));
  if (![plan.beforeManifestSha256, plan.afterManifestSha256].includes(expectedManifestSha256)) throw new Error('Current manifest has unknown changes; recovery refused');
  const markerStat = present(plan.backendDir, INCOMPLETE_MARKER);
  let expectedMarker = markerStat ? fileSnapshot(plan.backendDir, INCOMPLETE_MARKER) : null;
  if (markerStat) {
    const marker = JSON.parse(regularBytes(plan.backendDir, INCOMPLETE_MARKER));
    if (marker.transactionId !== journal.transactionId || marker.planSha256 !== expectedPlanSha256 || !samePath(marker.evidenceDir, evidenceDir)) throw new Error('Recovery marker identity differs');
  } else if (journal.phase !== 'completed') throw new Error('Incomplete recovery is missing its transaction marker');
  unchangedOldFiles(plan);
  const expectedComponents = new Map();
  for (const file of plan.componentFiles) {
    if (present(plan.backendDir, file.privateBackendRelativePath)) {
      const current = fileSnapshot(plan.backendDir, file.privateBackendRelativePath);
      if (current.bytes !== file.bytes || current.sha256 !== file.sha256) throw new Error(`Component changed after transaction; recovery refused: ${file.privateBackendRelativePath}`);
      expectedComponents.set(file.privateBackendRelativePath, current);
    } else {
      if (file.action === 'retained') throw new Error('An old authorized component disappeared; recovery refused');
      expectedComponents.set(file.privateBackendRelativePath, null);
    }
  }
  const temporaryRelative = `.spectrum-component-manifest-${journal.transactionId}.json`;
  let expectedTemporary = present(plan.backendDir, temporaryRelative) ? fileSnapshot(plan.backendDir, temporaryRelative) : null;
  if (expectedTemporary && ![plan.beforeManifestSha256, plan.afterManifestSha256].includes(expectedTemporary.sha256)) throw new Error('Unknown manifest staging bytes; recovery refused');
  function componentDirectorySnapshot() {
    const entry = present(plan.backendDir, COMPONENT_DIRECTORY);
    if (!entry) return null;
    if (!entry.isDirectory()) throw new Error('Recovery component directory changed to an unknown entry');
    return {dev: entry.dev, ino: entry.ino};
  }
  let expectedDirectory = componentDirectorySnapshot();
  function requireSnapshot(relative, expected, label) {
    const actual = present(plan.backendDir, relative) ? fileSnapshot(plan.backendDir, relative) : null;
    if (Boolean(actual) !== Boolean(expected) || (actual && (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256))) throw new Error(`${label} changed during recovery; retained for review: ${relative}`);
  }
  // Synchronous revalidation runs after the final awaited stopped check and
  // immediately before every destructive call. It closes the onPhase/await gap;
  // it is not a filesystem lock against arbitrary privileged concurrent writers.
  function revalidateRecoveryState() {
    assertReviewedPlan(plan, expectedPlanSha256);
    const freshBefore = regularBytes(evidenceDir, 'before/backend-manifest.json');
    if (sha256(freshBefore) !== plan.beforeManifestSha256 || sha256(regularBytes(evidenceDir, 'after-backend-manifest.json')) !== plan.afterManifestSha256) throw new Error('Recovery manifest backup integrity changed during recovery');
    for (const file of plan.componentFiles) {
      const name = path.basename(file.privateBackendRelativePath), staged = regularBytes(evidenceDir, `stage/${name}`);
      if (staged.length !== file.bytes || sha256(staged) !== file.sha256) throw new Error(`Recovery staged source changed: ${name}`);
      if (file.action === 'retained') {
        const original = regularBytes(evidenceDir, `before/${name}`);
        if (original.length !== file.bytes || sha256(original) !== file.sha256) throw new Error(`Recovery component backup integrity changed: ${name}`);
      }
    }
    unchangedOldFiles(plan);
    if (sha256(regularBytes(plan.backendDir, 'backend-manifest.json')) !== expectedManifestSha256) throw new Error('Current manifest changed during recovery; retained for review');
    requireSnapshot(INCOMPLETE_MARKER, expectedMarker, 'Recovery marker');
    requireSnapshot(temporaryRelative, expectedTemporary, 'Manifest staging file');
    const directory = componentDirectorySnapshot();
    if (Boolean(directory) !== Boolean(expectedDirectory) || (directory && (directory.dev !== expectedDirectory.dev || directory.ino !== expectedDirectory.ino))) throw new Error('Recovery component directory identity changed; retained for review');
    for (const [relative, expected] of expectedComponents) requireSnapshot(relative, expected, 'Component');
    if (directory) for (const name of fs.readdirSync(resolveRelative(plan.backendDir, COMPONENT_DIRECTORY))) {
      if (!COMPONENT_NAMES.includes(name)) throw new Error(`ENOTEMPTY: unknown component filename retained for review: ${name}`);
    }
    return freshBefore;
  }
  await assertStopped(plan, processInspector);
  // All recovery validation precedes the first recovery write.
  try {
    if (!markerStat) {
      const markerBytes = jsonBytes({schemaVersion: 1, transactionId: journal.transactionId, planSha256: expectedPlanSha256, evidenceDir});
      await writeExclusive(closedDestination(plan.backendDir, INCOMPLETE_MARKER), markerBytes);
      expectedMarker = {bytes: markerBytes.length, sha256: sha256(markerBytes)};
    }
    journal.phase = 'rolling-back'; await writeJournal(evidenceDir, journal);
    await assertStopped(plan, processInspector);
    revalidateRecoveryState();
    if (expectedManifestSha256 !== plan.beforeManifestSha256) {
      const temporary = closedDestination(plan.backendDir, temporaryRelative);
      if (expectedTemporary) {
        await assertStopped(plan, processInspector);
        revalidateRecoveryState();
        await fsp.unlink(temporary);
        expectedTemporary = null;
      }
      await assertStopped(plan, processInspector);
      const freshBefore = revalidateRecoveryState();
      await writeExclusive(temporary, freshBefore);
      expectedTemporary = {bytes: freshBefore.length, sha256: plan.beforeManifestSha256};
      await assertStopped(plan, processInspector);
      revalidateRecoveryState();
      await fsp.rename(temporary, closedDestination(plan.backendDir, 'backend-manifest.json'));
      expectedTemporary = null; expectedManifestSha256 = plan.beforeManifestSha256;
    }
    await onPhase('manifest-restored');
    for (const file of plan.componentFiles.filter(file => file.action === 'added')) {
      await assertStopped(plan, processInspector);
      revalidateRecoveryState();
      if (expectedComponents.get(file.privateBackendRelativePath)) {
        await fsp.unlink(closedDestination(plan.backendDir, file.privateBackendRelativePath));
        expectedComponents.set(file.privateBackendRelativePath, null);
      }
    }
    if (expectedTemporary) {
      await assertStopped(plan, processInspector);
      revalidateRecoveryState();
      await fsp.unlink(closedDestination(plan.backendDir, temporaryRelative));
      expectedTemporary = null;
    }
    if (!plan.componentDirectoryExisted && expectedDirectory) {
      await assertStopped(plan, processInspector);
      revalidateRecoveryState();
      await fsp.rmdir(closedDestination(plan.backendDir, COMPONENT_DIRECTORY));
      expectedDirectory = null;
    }
    journal.phase = 'rolled-back'; journal.rolledBackAt = new Date().toISOString();
    await writeJournal(evidenceDir, journal);
    await assertStopped(plan, processInspector);
    revalidateRecoveryState();
    if (expectedManifestSha256 !== plan.beforeManifestSha256) throw new Error('Restored manifest integrity failed');
    await fsp.unlink(closedDestination(plan.backendDir, INCOMPLETE_MARKER));
    return {rolledBack: true, backendId: plan.backendId, manifestSha256: plan.beforeManifestSha256, evidenceDir};
  } catch (error) {
    journal.failedPhase = journal.phase; journal.phase = 'rollback-failed'; journal.error = error.message;
    delete journal.rolledBackAt;
    await writeJournal(evidenceDir, journal).catch(() => {});
    error.transactionEvidence = evidenceDir; throw error;
  }
}
async function main(args = process.argv.slice(2), {print = value => console.log(value)} = {}) {
  const options = {}, values = new Set(['--backend', '--reviewed-plan', '--plan-sha256', '--evidence-dir', '--authorization', '--rollback']);
  let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') apply = true;
    else if (values.has(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error('Use optional --backend source|target (default: read-only plan); apply/rollback require exact reviewed plan SHA256, authorization and evidence directory');
  }
  if (options.rollback) {
    if (apply || options['reviewed-plan'] || options.backend || options['evidence-dir']) throw new Error('Choose one reviewed apply or rollback; rollback uses only its recorded backend and evidence directory');
    print(JSON.stringify(await rollbackSpectrumInstall(options.rollback, {expectedPlanSha256: options['plan-sha256'], authorization: options.authorization}), null, 2));
  } else if (apply) {
    if (options.backend) throw new Error('Apply identifies its backend only through the reviewed plan; --backend is plan-only');
    if (!options['reviewed-plan']) throw new Error('Apply requires an exact reviewed plan file');
    const filename = path.resolve(options['reviewed-plan']);
    if (!inside(path.join(ROOT, 'review-evidence'), filename)) throw new Error('Reviewed plan must be under project review-evidence');
    const value = JSON.parse(regularBytes(ROOT, path.relative(ROOT, filename).replaceAll('\\', '/'))), plan = value.plan || value;
    if (value.planSha256 && value.planSha256 !== options['plan-sha256']) throw new Error('Plan envelope SHA256 differs from reviewed argument');
    if (!samePath(plan.sourceRoot, ROOT)) throw new Error('CLI cannot apply another project root');
    print(JSON.stringify(await applySpectrumInstall(plan, {expectedPlanSha256: options['plan-sha256'], authorization: options.authorization, evidenceDir: options['evidence-dir']}), null, 2));
  } else {
    if (options.authorization || options['reviewed-plan'] || options['evidence-dir'] || options['plan-sha256']) throw new Error('Planning accepts only --backend source|target');
    if (options.backend && !['source', 'target'].includes(options.backend)) throw new Error('Backend must be source or target');
    const backendDir = options.backend === 'target' ? path.join(ROOT, 'dist', 'Still-V2-preview-win32-x64', 'backend', 'foobar2000') : path.join(ROOT, 'backend', 'foobar2000');
    const plan = planSpectrumInstall({backendDir});
    print(JSON.stringify({planSha256: planSha256(plan), plan}, null, 2));
  }
}
if (require.main === module) main().catch(error => {console.error(error.message); if (error.transactionEvidence) console.error(`Evidence retained: ${error.transactionEvidence}`); process.exitCode = 1;});
module.exports = {verifySpectrumDelivery, componentStatus, resolveRelative, assertNoLinks, regularBytes, assertPeX64, planSpectrumInstall, planSha256,
  assertStopped, applySpectrumInstall, rollbackSpectrumInstall, DELIVERY_PATH, DELIVERY_SHA256, COMPONENT_DIRECTORY, INCOMPLETE_MARKER, RUNTIME_NAMES, COMPONENT_NAMES,
  APPLY_AUTHORIZATION, ROLLBACK_AUTHORIZATION, main};
