'use strict';
// The public distribution deliberately has no dependency on package.js or a
// private backend. Every byte copied below must occur in a reviewed file list.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawnSync} = require('node:child_process');
const {DESKTOP_MEDIA_ASSET, DESKTOP_MEDIA_FILES, CUE_READ_LEASE_ASSET, CUE_READ_LEASE_FILES, verifyDesktopMediaRuntimeAssets, verifyCueReadLeaseRuntimeAssets} = require('./runtime-assets');
const ROOT = path.resolve(__dirname, '..');
const HASH = /^[a-f0-9]{64}$/;
const PRIVATE_SEGMENTS = /^(?:backend|data|auth|authentication|cookies|profiles?|user data|webview2-profile|evidence|review-evidence|\.git|tools?|toolchains?|vendor|cache)$/i;
const PRIVATE_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.git-credentials|.*\.(?:pem|key|pfx|p12|p8|token|log|bak|tmp))$/i;
const MANIFESTS = ['installer/public-files.json', 'installer/dependency-files.json', 'installer/electron-files.json'];
const MARKER_PATH = 'public-release.json';
const PUBLIC_MARKER = Object.freeze({schemaVersion: 1, distribution: 'public', userDataDirectory: 'STILL', backendBootstrapManifest: 'manifests/public-backend.json'});
const PUBLIC_POLICY = Object.freeze({schemaVersion: 1, policyId: 'still-public-in-process-v1', outputs: []});
const PRIVATE_RUNTIME_SOURCE_PATHS = ['src/main/backend-output-policy.json', 'src/main/runtime-assets.json'];
const PUBLIC_LAUNCHER_SHA256 = '8267a6511f4b3bedecc90c56a9046304db1ccb52b7a2f10c6965add9a550a824';
const OFFICIAL_INSTALLER = Object.freeze({relativePath: 'bootstrap/foobar2000-x64_v2.26.2.exe', bytes: 7954936, sha256: 'ffa739f87d9c374cb030426a2ab4bfb37959d0dbb892fdc742654c14d127f795', signerSubject: 'CN=Illustrate Ltd, O=Illustrate Ltd, L=Bury, C=GB', signerThumbprint: '5A4BA9241AD6B108B5E189A3A5043F5B73FCB868'});
const EXTRACTOR_PATHS = Object.freeze(['7z.exe', '7z.dll', 'License.txt', 'COPYING.txt', '7z2606-src.7z', 'Source-Info.txt'].map(name => `bootstrap/7zip/${name}`));
const EXTRACTOR_PINS = Object.freeze({
  '7z.exe': {bytes: 574464, sha256: 'dc0493429fe28136fcb177a0e77c9875cbb3b0bff5f2f8eeba4df302e98cef76'},
  '7z.dll': {bytes: 1897984, sha256: '500db9eb17f3c21b729ba41dd02ecfe1823da05028c7e4ba129084cc74cc364e'},
  'License.txt': {bytes: 6031, sha256: '519ac0a4bded9c18ea02e0afb71f663d8c47373bd9facd3ac96a79f51d77765d'},
  'COPYING.txt': {bytes: 27032, sha256: '1e7e6bae5a5bde32f1ae5a7c37a082d1ab03cf89354f7f936ac40be9e39a6531'},
  '7z2606-src.7z': {bytes: 1554409, sha256: 'e0364d39e8208557d939472c9a12d02ed1c12f45ca402e3b408bcaa63b36dd93'},
  'Source-Info.txt': {bytes: 2191, sha256: '58eeac59d63b749b6bee8e7c2da06fd62bae83f8408eeea6a6e7cc306ffc80d4'}
});
const normalize = value => value.replaceAll('\\', '/');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || value !== normalize(value) || value.startsWith('/') ||
      !value.split('/').every(part => /^[a-zA-Z0-9@_().+ -]+$/.test(part) && !['.', '..'].includes(part) && !part.endsWith('.') && !part.endsWith(' ') && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(part)) ||
      /[\x00-\x1f:"<>|?*$]/.test(value)) throw new Error(`Unsafe public package path: ${value}`);
  return value;
}
function assertPublicPath(relative) {
  safeRelative(relative);
  if (relative.split('/').some(part => PRIVATE_SEGMENTS.test(part) || PRIVATE_FILES.test(part))) throw new Error(`Private public-package input is forbidden: ${relative}`);
  return relative;
}
function assertNoLinks(filename, {allowMissing = false} = {}) {
  const target = path.resolve(filename);
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    let stat;
    try {stat = fs.lstatSync(cursor);} catch (error) {if (error.code !== 'ENOENT' || !allowMissing) throw error;}
    if (stat?.isSymbolicLink()) throw new Error(`Public package links/junctions are forbidden: ${cursor}`);
    if (path.dirname(cursor) === cursor) break;
  }
  return target;
}
function regularBytes(root, relative) {
  safeRelative(relative);
  const filename = assertNoLinks(path.join(root, relative)), descriptor = fs.openSync(filename, 'r');
  try {
    const before = fs.fstatSync(descriptor, {bigint: true});
    if (!before.isFile() || before.nlink !== 1n) throw new Error(`Expected an unlinked regular public input: ${relative}`);
    const bytes = fs.readFileSync(descriptor), after = fs.fstatSync(descriptor, {bigint: true});
    const named = fs.lstatSync(assertNoLinks(filename), {bigint: true});
    if (![after, named].every(stat => stat.isFile() && stat.nlink === 1n && ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => stat[key] === before[key])) || BigInt(bytes.length) !== before.size) throw new Error(`Public input changed while reading: ${relative}`);
    return bytes;
  } finally {fs.closeSync(descriptor);}
}
function walkFiles(directory, prefix = '') {
  assertNoLinks(directory);
  const result = [];
  for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    safeRelative(relative);
    if (entry.isSymbolicLink()) throw new Error(`Linked public input is forbidden: ${relative}`);
    if (entry.isDirectory()) result.push(...walkFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) {
      const stat = fs.lstatSync(assertNoLinks(path.join(directory, entry.name)));
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Expected an unlinked regular public input: ${relative}`);
      result.push(relative);
    }
    else throw new Error(`Special public input is forbidden: ${relative}`);
  }
  return result;
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error(`Invalid closed ${label} schema`);
}
function validateFileList(value, {hashed = false, label = 'file list'} = {}) {
  if (value.schemaVersion !== 1 || !Array.isArray(value.files) || !value.files.length) throw new Error(`Invalid public ${label}`);
  const seen = new Set();
  for (const item of value.files) {
    exactKeys(item, hashed ? ['path', 'bytes', 'sha256'] : ['path'], label);
    assertPublicPath(item.path);
    const key = item.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate public ${label} path: ${item.path}`);
    seen.add(key);
    if (hashed && (!Number.isSafeInteger(item.bytes) || item.bytes < 0 || !HASH.test(item.sha256))) throw new Error(`Invalid public ${label} hash: ${item.path}`);
  }
  return value.files;
}
function assertExactFiles(actual, expected, label) {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(`Unknown or missing ${label} files; review and update the explicit allowlist`);
}
function validateBootstrapManifest(value, {pinOfficial = true} = {}) {
  const automatic = value?.schemaVersion === 2;
  exactKeys(value, ['schemaVersion', 'foobarVersion', 'architecture', 'installer', 'coreFiles', 'components', ...(automatic ? ['deployment', 'extractor'] : [])], 'public bootstrap manifest');
  exactKeys(value.installer, Object.keys(OFFICIAL_INSTALLER), 'official installer');
  if ((!automatic && (pinOfficial || value.schemaVersion !== 1)) || automatic && value.deployment !== 'extract-original-installer' || value.foobarVersion !== '2.26.2' || value.architecture !== 'x64' ||
      !Object.entries(OFFICIAL_INSTALLER).every(([key, expected]) => !pinOfficial && ['bytes', 'sha256'].includes(key) || value.installer[key] === expected) ||
      !Number.isSafeInteger(value.installer.bytes) || value.installer.bytes <= 0 || !HASH.test(value.installer.sha256) ||
      !Array.isArray(value.coreFiles) || !value.coreFiles.length || !Array.isArray(value.components) || !value.components.length) throw new Error('Unreviewed official public bootstrap');
  const corePaths = new Set(), componentSources = new Set(), componentTargets = new Set();
  for (const item of value.coreFiles) {
    exactKeys(item, ['relativePath', 'bytes', 'sha256'], 'official portable core file'); assertPublicPath(item.relativePath);
    if (corePaths.has(item.relativePath.toLowerCase()) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !HASH.test(item.sha256)) throw new Error('Invalid official core hash list');
    corePaths.add(item.relativePath.toLowerCase());
  }
  if (!corePaths.has('foobar2000.exe') || !corePaths.has('portable_mode_enabled')) throw new Error('Official portable core list is incomplete');
  for (const item of value.components) {
    exactKeys(item, ['sourcePath', 'targetPath', 'bytes', 'sha256'], 'public component'); assertPublicPath(item.sourcePath); safeRelative(item.targetPath);
    if (!item.sourcePath.startsWith('bootstrap/') || item.sourcePath === value.installer.relativePath || !/^profile\/user-components-x64\/(?:foo_beefweb|foo_still_spectrum)\//.test(item.targetPath) ||
        componentSources.has(item.sourcePath.toLowerCase()) || componentTargets.has(item.targetPath.toLowerCase()) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !HASH.test(item.sha256)) throw new Error('Public component escapes the reviewed bootstrap contract');
    componentSources.add(item.sourcePath.toLowerCase()); componentTargets.add(item.targetPath.toLowerCase());
  }
  if (!value.components.some(item => item.targetPath === 'profile/user-components-x64/foo_beefweb/foo_beefweb.dll') || !value.components.some(item => item.targetPath === 'profile/user-components-x64/foo_still_spectrum/foo_still_spectrum.dll')) throw new Error('Public component DLL list is incomplete');
  let extractorFiles = [];
  if (automatic) {
    exactKeys(value.extractor, ['executable', 'files'], 'public extractor');
    if (value.extractor.executable !== EXTRACTOR_PATHS[0] || !Array.isArray(value.extractor.files)) throw new Error('Unreviewed public extractor executable');
    assertExactFiles(value.extractor.files.map(item => item.relativePath), EXTRACTOR_PATHS, 'public extractor');
    extractorFiles = value.extractor.files.map(item => {
      exactKeys(item, ['relativePath', 'bytes', 'sha256'], 'public extractor file'); assertPublicPath(item.relativePath);
      const pin = EXTRACTOR_PINS[path.posix.basename(item.relativePath)];
      if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > 4 * 1024 * 1024 || !HASH.test(item.sha256) ||
          pinOfficial && pin && (item.bytes !== pin.bytes || item.sha256 !== pin.sha256)) throw new Error(`Unreviewed public extractor asset: ${item.relativePath}`);
      return {sourcePath: item.relativePath, bytes: item.bytes, sha256: item.sha256};
    });
  }
  return [{sourcePath: value.installer.relativePath, bytes: value.installer.bytes, sha256: value.installer.sha256}, ...value.components, ...extractorFiles];
}
function publicRuntimeFiles() {
  const policy = Buffer.from(`${JSON.stringify(PUBLIC_POLICY, null, 2)}\n`);
  const registry = Buffer.from(`${JSON.stringify({schemaVersion: 1, assets: {
    backendOutputPolicy: {relativePath: PRIVATE_RUNTIME_SOURCE_PATHS[0], sha256: sha256(policy)},
    backendLauncher: {relativePath: 'native/backend-job/StillBackendLauncher.exe', sha256: PUBLIC_LAUNCHER_SHA256},
    desktopMediaManifest: {relativePath: DESKTOP_MEDIA_ASSET.relativePath, sha256: DESKTOP_MEDIA_ASSET.reviewedSha256},
    cueReadLeaseManifest: {relativePath: CUE_READ_LEASE_ASSET.relativePath, sha256: CUE_READ_LEASE_ASSET.reviewedSha256}}}, null, 2)}\n`);
  return {[PRIVATE_RUNTIME_SOURCE_PATHS[0]]: policy, [PRIVATE_RUNTIME_SOURCE_PATHS[1]]: registry};
}
function loadInputs(sourceRoot = ROOT, {dependencyRoot = sourceRoot, electronRoot = path.join(sourceRoot, 'node_modules/electron/dist'), bootstrapRoot = path.join(sourceRoot, 'tools/public-bootstrap-auto-20261108'), pinOfficial = true} = {}) {
  sourceRoot = assertNoLinks(sourceRoot); dependencyRoot = assertNoLinks(dependencyRoot); electronRoot = assertNoLinks(electronRoot); bootstrapRoot = assertNoLinks(bootstrapRoot);
  const manifestBytes = MANIFESTS.map(relative => regularBytes(sourceRoot, relative));
  const [app, dependencies, electron] = manifestBytes.map(bytes => JSON.parse(bytes));
  const appFiles = validateFileList(app), dependencyFiles = validateFileList(dependencies, {hashed: true, label: 'dependency list'}), electronFiles = validateFileList(electron, {hashed: true, label: 'Electron list'});
  if (electron.version !== '45.1.0' || electron.architecture !== 'x64' || electron.archive !== 'electron-v45.1.0-win32-x64.zip' || !HASH.test(electron.archiveSha256)) throw new Error('Unreviewed Electron distribution');
  const packageBytes = regularBytes(sourceRoot, 'package.json'), packageInfo = JSON.parse(packageBytes), lockBytes = regularBytes(sourceRoot, 'package-lock.json'), lock = JSON.parse(lockBytes);
  exactKeys(dependencies.source, ['packageSha256', 'lockfileSha256', 'directDependencies'], 'production dependency source pins');
  if (dependencies.source.packageSha256 !== sha256(packageBytes) || dependencies.source.lockfileSha256 !== sha256(lockBytes) ||
      JSON.stringify(Object.entries(dependencies.source.directDependencies || {}).sort()) !== JSON.stringify(Object.entries(packageInfo.dependencies || {}).sort()) ||
      JSON.stringify(Object.entries(lock.packages?.['']?.dependencies || {}).sort()) !== JSON.stringify(Object.entries(packageInfo.dependencies || {}).sort())) throw new Error('Production dependency package/lock/direct metadata differs from the reviewed pins');
  if (packageInfo.devDependencies?.electron !== electron.version || lock.packages?.['node_modules/electron']?.version !== electron.version || !/^\d+\.\d+\.\d+$/.test(packageInfo.version)) throw new Error('Package version/Electron differs from public release contract');
  const runtimePackages = Object.entries(lock.packages || {}).filter(([name, info]) => name && !info.dev);
  const declarations = dependencies.packages;
  if (!Array.isArray(declarations) || declarations.length !== runtimePackages.length) throw new Error('Public runtime dependencies differ from the lockfile');
  for (const [name, info] of runtimePackages) {
    assertPublicPath(name);
    const declared = declarations.find(item => item.path === name);
    if (!declared || declared.version !== info.version || declared.integrity !== info.integrity || declared.resolved !== info.resolved ||
        !info.resolved.startsWith('https://registry.npmjs.org/') || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(info.integrity)) throw new Error(`Unreviewed public dependency: ${name}`);
    const prefix = `${name}/`, packageFiles = dependencyFiles.filter(item => item.path.startsWith(prefix));
    const readmeLicense = name === 'node_modules/@tokenizer/token' && info.version === '0.3.0' && packageFiles.some(item => item.path === `${name}/README.md` && item.sha256 === 'a88c936c259cc261d5b37a2433735e9819e01f824bdc26e644d46ccd3055c8d7');
    if (!packageFiles.some(item => /^licen[cs]e(?:\.[a-z]+)?$/i.test(path.posix.basename(item.path))) && !readmeLicense) throw new Error(`Dependency license is missing: ${name}`);
    assertExactFiles(walkFiles(path.join(dependencyRoot, name)).map(relative => prefix + relative), packageFiles.map(item => item.path), `runtime dependency ${name}`);
    const installed = JSON.parse(regularBytes(dependencyRoot, `${name}/package.json`));
    if (installed.version !== info.version) throw new Error(`Installed dependency version changed: ${name}`);
  }
  if (dependencyFiles.some(item => !runtimePackages.some(([name]) => item.path.startsWith(`${name}/`)))) throw new Error('Undeclared public dependency input');
  const srcExpected = appFiles.filter(item => item.path.startsWith('src/')).map(item => item.path.slice(4));
  assertExactFiles(walkFiles(path.join(sourceRoot, 'src')), srcExpected, 'application source');
  assertExactFiles(walkFiles(electronRoot), electronFiles.map(item => item.path), 'Electron runtime');
  const inputs = [];
  function add(base, source, destination, expected) {
    assertPublicPath(destination);
    const bytes = regularBytes(base, source), hash = sha256(bytes);
    if (expected && (bytes.length !== expected.bytes || hash !== expected.sha256)) throw new Error(`Public input hash mismatch: ${source}`);
    inputs.push({base, source, destination, bytes: bytes.length, sha256: hash});
  }
  for (const item of appFiles) {
    if (!/^(?:src\/|native\/(?:apple-host\/bin|backend-job|foobar-spectrum\/package|desktop-media\/bin|cue-read-lease\/bin)\/|scripts\/foobar-coreaudio-probe\.(?:exe|cs)$|manifests\/|docs\/public-[a-z-]+\.md$|installer\/NSIS-COPYING\.txt$)/.test(item.path)) throw new Error(`Unapproved application input: ${item.path}`);
    if (PRIVATE_RUNTIME_SOURCE_PATHS.includes(item.path)) continue;
    add(sourceRoot, item.path, `resources/app/${item.path}`);
  }
  if (!appFiles.some(item => item.path === PUBLIC_MARKER.backendBootstrapManifest)) throw new Error('Public bootstrap manifest must be explicitly allowlisted');
  const bootstrap = JSON.parse(regularBytes(sourceRoot, PUBLIC_MARKER.backendBootstrapManifest));
  const bootstrapFiles = validateBootstrapManifest(bootstrap, {pinOfficial});
  if (fs.existsSync(path.join(bootstrapRoot, 'BOOTSTRAP-INCOMPLETE'))) throw new Error('Public bootstrap resource stage is incomplete');
  if (pinOfficial) {
    const desktop = verifyDesktopMediaRuntimeAssets(sourceRoot);
    assertExactFiles(appFiles.filter(item => item.path.startsWith('native/desktop-media/')).map(item => item.path), DESKTOP_MEDIA_FILES.map(name => `native/desktop-media/bin/${name}`), 'desktop media runtime allowlist');
    for (const file of desktop.files) {
      const copiedInput = inputs.find(item => item.destination === `resources/app/${file.relativePath}`);
      if (!copiedInput || copiedInput.sha256 !== file.sha256) throw new Error('Desktop media runtime differs from its top-level approved pin');
    }
    const cue = verifyCueReadLeaseRuntimeAssets(sourceRoot);
    assertExactFiles(appFiles.filter(item => item.path.startsWith('native/cue-read-lease/')).map(item => item.path), CUE_READ_LEASE_FILES.map(name => `native/cue-read-lease/bin/${name}`), 'CUE lease runtime allowlist');
    for (const file of cue.files) {
      const copiedInput = inputs.find(item => item.destination === `resources/app/${file.relativePath}`);
      if (!copiedInput || copiedInput.sha256 !== file.sha256) throw new Error('CUE lease runtime differs from its top-level approved pin');
    }
    const receipt = JSON.parse(regularBytes(bootstrapRoot, 'BOOTSTRAP-RESOURCES.json')), signature = receipt.officialInstaller?.signature;
    if (receipt.sourceManifestSha256 !== sha256(regularBytes(sourceRoot, 'installer/bootstrap-sources.json')) || signature?.status !== 'Valid' ||
        signature.subject !== OFFICIAL_INSTALLER.signerSubject || signature.thumbprint !== OFFICIAL_INSTALLER.signerThumbprint) throw new Error('Public bootstrap preparation/signature receipt is invalid');
    assertExactFiles(walkFiles(bootstrapRoot), [...bootstrapFiles.map(item => item.sourcePath), 'BOOTSTRAP-RESOURCES.json'], 'bootstrap resource stage');
  }
  for (const item of bootstrapFiles) add(bootstrapRoot, item.sourcePath, `resources/app/${item.sourcePath}`, item);
  if (pinOfficial) {
    const launcher = inputs.find(item => item.destination === 'resources/app/native/backend-job/StillBackendLauncher.exe');
    if (!launcher || launcher.sha256 !== PUBLIC_LAUNCHER_SHA256 || !inputs.some(item => item.destination === 'resources/app/installer/NSIS-COPYING.txt')) throw new Error('Public launcher or installer license is missing or changed');
  }
  for (const item of dependencyFiles) add(dependencyRoot, item.path, `resources/app/${item.path}`, item);
  for (const item of electronFiles) {
    if (item.path === 'resources/default_app.asar') continue;
    add(electronRoot, item.path, item.path === 'electron.exe' ? 'Still.exe' : item.path, item);
  }
  for (const file of ['package.json', 'package-lock.json']) add(sourceRoot, file, `resources/app/${file}`);
  const destinations = inputs.map(item => item.destination.toLowerCase());
  if (new Set(destinations).size !== destinations.length) throw new Error('Public output destination collision');
  return {inputs, packageInfo, bootstrap, manifests: MANIFESTS.map((file, index) => ({path: file, sha256: sha256(manifestBytes[index])})), electron: {version: electron.version, archive: electron.archive, archiveSha256: electron.archiveSha256}, dependencies: declarations};
}
function validateOutput(sourceRoot, outputDirectory) {
  const distribution = assertNoLinks(path.join(sourceRoot, 'dist'), {allowMissing: true}), output = assertNoLinks(outputDirectory, {allowMissing: true});
  if (path.dirname(output).toLowerCase() !== distribution.toLowerCase() || !/^Still-public-[a-zA-Z0-9][a-zA-Z0-9._-]{0,70}$/.test(path.basename(output))) throw new Error('Public package output must be a new named Still-public-* direct child of dist');
  if (fs.existsSync(output)) throw new Error('Public package output already exists; use a fresh build name and retain the existing package');
  return output;
}
function snapshotFiles(directory) {
  return Object.fromEntries(walkFiles(directory).map(relative => {assertPublicPath(relative); const bytes = regularBytes(directory, relative); return [relative, {bytes: bytes.length, sha256: sha256(bytes)}];}));
}
function verifyPublicPackage(directory, {sourceRoot = ROOT, pinOfficial = true} = {}) {
  assertNoLinks(directory);
  if (fs.existsSync(path.join(directory, 'PUBLIC-PACKAGE-INCOMPLETE'))) throw new Error('Public package is incomplete');
  const bytes = regularBytes(directory, 'BUILD-INFO.json'), info = JSON.parse(bytes);
  if (info.schemaVersion !== 1 || info.publicDistribution !== true || info.platform !== 'win32' || info.arch !== 'x64' || !info.files || typeof info.files !== 'object') throw new Error('Invalid public build metadata');
  if (regularBytes(directory, 'BUILD-INFO.sha256').toString('utf8') !== `${sha256(bytes)}  BUILD-INFO.json\n`) throw new Error('Public build metadata hash mismatch');
  // BUILD-INFO is an integrity record, not authority to extend the payload.
  // Bind its complete namespace to the independently reviewed source lists.
  const lists = MANIFESTS.map(relative => {const raw = regularBytes(sourceRoot, relative); return {path: relative, sha256: sha256(raw), value: JSON.parse(raw)};});
  if (JSON.stringify(info.inputAllowlists) !== JSON.stringify(lists.map(({path: file, sha256: hash}) => ({path: file, sha256: hash})))) throw new Error('Public package allowlist provenance differs from the reviewed source');
  const [app, dependencies, electron] = lists.map(item => item.value);
  const bootstrapBytes = regularBytes(directory, `resources/app/${PUBLIC_MARKER.backendBootstrapManifest}`);
  if (!bootstrapBytes.equals(regularBytes(sourceRoot, PUBLIC_MARKER.backendBootstrapManifest))) throw new Error('Packaged bootstrap manifest differs from the reviewed source');
  const bootstrap = JSON.parse(bootstrapBytes);
  const bootstrapFiles = validateBootstrapManifest(bootstrap, {pinOfficial});
  const approvedSources = [...validateFileList(app).filter(item => !PRIVATE_RUNTIME_SOURCE_PATHS.includes(item.path)).map(item => `resources/app/${item.path}`),
    ...validateFileList(dependencies, {hashed: true}).map(item => `resources/app/${item.path}`),
    ...validateFileList(electron, {hashed: true}).filter(item => item.path !== 'resources/default_app.asar').map(item => item.path === 'electron.exe' ? 'Still.exe' : item.path),
    ...bootstrapFiles.map(item => `resources/app/${item.sourcePath}`), 'resources/app/package.json', 'resources/app/package-lock.json'];
  assertExactFiles(Object.keys(info.sourceFiles || {}), approvedSources, 'recorded public source');
  assertExactFiles(Object.keys(info.files), [...approvedSources, ...PRIVATE_RUNTIME_SOURCE_PATHS.map(relative => `resources/app/${relative}`), `resources/app/${MARKER_PATH}`, 'START-HERE.txt', 'THIRD-PARTY-NOTICES.txt'], 'recorded public payload');
  assertExactFiles(walkFiles(directory), [...Object.keys(info.files), 'BUILD-INFO.json', 'BUILD-INFO.sha256'], 'actual public payload');
  const actual = snapshotFiles(directory);
  delete actual['BUILD-INFO.json']; delete actual['BUILD-INFO.sha256'];
  for (const relative of Object.keys(actual)) assertPublicPath(relative);
  if (JSON.stringify(actual) !== JSON.stringify(info.files)) throw new Error('Public package has missing, changed, linked or unknown files');
  for (const [relative, record] of Object.entries(info.sourceFiles)) if (JSON.stringify(record) !== JSON.stringify(info.files[relative])) throw new Error('Public source hash record differs from its actual payload');
  for (const relative of [...app.files.map(item => item.path).filter(relative => !PRIVATE_RUNTIME_SOURCE_PATHS.includes(relative)), 'package.json', 'package-lock.json']) {
    const source = regularBytes(sourceRoot, relative), actual = info.files[`resources/app/${relative}`];
    if (actual.bytes !== source.length || actual.sha256 !== sha256(source)) throw new Error(`Packaged application differs from the reviewed source: ${relative}`);
  }
  for (const [relative, expected] of Object.entries(publicRuntimeFiles())) if (!regularBytes(directory, `resources/app/${relative}`).equals(expected)) throw new Error('Public output policy or asset registry is not the fixed isolated public policy');
  verifyDesktopMediaRuntimeAssets(path.join(directory, 'resources/app'));
  verifyCueReadLeaseRuntimeAssets(path.join(directory, 'resources/app'));
  for (const item of [...dependencies.files.map(item => ({...item, destination: `resources/app/${item.path}`})),
    ...electron.files.filter(item => item.path !== 'resources/default_app.asar').map(item => ({...item, destination: item.path === 'electron.exe' ? 'Still.exe' : item.path})),
    ...bootstrapFiles.map(item => ({...item, destination: `resources/app/${item.sourcePath}`}))]) {
    const actual = info.files[item.destination];
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw new Error(`Frozen public runtime hash mismatch: ${item.destination}`);
  }
  if (sha256(Buffer.from(JSON.stringify(info.sourceFiles))) !== info.sourceSnapshotSha256 || info.sourceFrozenSnapshot !== info.sourceSnapshotSha256) throw new Error('Public source snapshot hash mismatch');
  const marker = JSON.parse(regularBytes(directory, `resources/app/${MARKER_PATH}`));
  if (JSON.stringify(marker) !== JSON.stringify(PUBLIC_MARKER)) throw new Error('Invalid public distribution marker');
  return info;
}
function packagePublic({sourceRoot = ROOT, outputDirectory, dependencyRoot = sourceRoot, electronRoot, bootstrapRoot, recordedAt = new Date().toISOString(), validateSources = true, runGit = spawnSync, pinOfficial = true} = {}) {
  if (!outputDirectory) throw new Error('A fresh public output directory is required');
  if (!Number.isFinite(Date.parse(recordedAt))) throw new Error('Invalid public build timestamp');
  const output = validateOutput(sourceRoot, outputDirectory);
  const loaded = loadInputs(sourceRoot, {dependencyRoot, ...(electronRoot ? {electronRoot} : {}), ...(bootstrapRoot ? {bootstrapRoot} : {}), pinOfficial});
  if (validateSources) {
    require('./build').checkRendererAssets(path.join(sourceRoot, 'src/renderer'));
    require('./runtime-assets').verifyRuntimeAssets(sourceRoot);
    require('./install-spectrum-component').verifySpectrumDelivery(sourceRoot);
  }
  // Validate every input before the first output write. An output is never
  // reused, so there is no existing app, backend or user profile to overwrite.
  fs.mkdirSync(path.dirname(output), {recursive: true}); assertNoLinks(path.dirname(output)); fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'PUBLIC-PACKAGE-INCOMPLETE'), 'Build incomplete; do not distribute or run.\n', {flag: 'wx'});
  for (const input of loaded.inputs) {
    const bytes = regularBytes(input.base, input.source);
    if (bytes.length !== input.bytes || sha256(bytes) !== input.sha256) throw new Error(`Public input changed after preflight: ${input.source}`);
    const target = assertNoLinks(path.join(output, input.destination), {allowMissing: true});
    fs.mkdirSync(path.dirname(target), {recursive: true}); assertNoLinks(path.dirname(target));
    fs.writeFileSync(target, bytes, {flag: 'wx'});
  }
  const writeGenerated = (relative, value) => {assertPublicPath(relative); fs.writeFileSync(path.join(output, relative), value, {flag: 'wx'});};
  for (const [relative, bytes] of Object.entries(publicRuntimeFiles())) {
    fs.mkdirSync(path.dirname(path.join(output, 'resources/app', relative)), {recursive: true});
    writeGenerated(`resources/app/${relative}`, bytes);
  }
  writeGenerated(`resources/app/${MARKER_PATH}`, `${JSON.stringify(PUBLIC_MARKER, null, 2)}\n`);
  writeGenerated('START-HERE.txt', 'STILL · 静室 — Windows x64\r\n\r\nInstall using the STILL setup. On first launch STILL prepares its dedicated local backend from the carried unchanged official foobar2000 installer using the separate, verified 7-Zip CLI.\r\nOnly allowlisted original members are deployed on this computer; no existing foobar installation or user profile is imported.\r\nApplication data, library, sign-in state and the dedicated backend live under %LOCALAPPDATA%\\STILL.\r\nUninstalling STILL retains this data. Imported audio remains in its original location.\r\nThis build is unsigned. No successful installation or audio playback is claimed by artifact checks.\r\nSee resources\\app\\docs\\public-installer.md for setup and limitations.\r\n');
  const notices = [
    'STILL retains the existing project authorization. No additional project-wide license is granted by this package.', '',
    `Electron ${loaded.electron.version}: LICENSE and LICENSES.chromium.html at the install root.`,
    'WebView2: resources/app/native/apple-host/bin/WebView2-LICENSE.txt and WebView2-NOTICE.txt.',
    'STILL backend job helper: resources/app/native/backend-job/LICENSE.txt.',
    'STILL desktop media controls helper: resources/app/native/desktop-media/bin/LICENSE.txt and NOTICE.txt; the top-level runtime registry pins its reviewed runtime-manifest.json and exact binary/notices. No additional project-wide license is granted.',
    'STILL CUE read lease helper: resources/app/native/cue-read-lease/bin/NOTICE.txt and the reviewed top-level cueReadLeaseManifest pin. No additional project-wide license is granted.',
    'foobar2000 SDK/PFC: resources/app/native/foobar-spectrum/package/*license.txt.',
    'NSIS with zlib compression: resources/app/installer/NSIS-COPYING.txt (unaltered upstream COPYING).',
    '7-Zip 26.06 separate unchanged CLI: resources/app/bootstrap/7zip/7z.exe and 7z.dll. Complete binary notices (including UnRAR/BSD), full LGPL 2.1 and complete same-version source are adjacent as License.txt, COPYING.txt and 7z2606-src.7z; see Source-Info.txt. These component rights remain intact; STILL does not link 7-Zip code or change its own project authorization.',
    'Runtime npm packages (original license files are retained in each package; @tokenizer/token 0.3.0 retains its complete original MIT notice in README.md):',
    ...loaded.dependencies.map(item => `${item.path} ${item.version}`), '',
    'foobar2000 itself is included only as the unmodified official setup file; its own license remains applicable. Only the recipient-side app deploys the allowlisted original members into a fresh dedicated directory. No third-party author endorsement is implied.', ''
  ].join('\r\n');
  writeGenerated('THIRD-PARTY-NOTICES.txt', notices);
  for (const input of loaded.inputs) {
    const source = regularBytes(input.base, input.source), target = regularBytes(output, input.destination);
    if (sha256(source) !== input.sha256 || sha256(target) !== input.sha256) throw new Error(`Public snapshot drift: ${input.source}`);
  }
  for (const manifest of loaded.manifests) if (sha256(regularBytes(sourceRoot, manifest.path)) !== manifest.sha256) throw new Error('Public input allowlist changed during build');
  const files = snapshotFiles(output); delete files['PUBLIC-PACKAGE-INCOMPLETE'];
  const sourceFiles = Object.fromEntries(loaded.inputs.map(item => [item.destination, {bytes: item.bytes, sha256: item.sha256}]));
  const sourceSnapshotSha256 = sha256(Buffer.from(JSON.stringify(sourceFiles)));
  const commit = runGit('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8', windowsHide: true});
  const gitCommit = commit.status === 0 && /^[a-f0-9]{40}$/.test(commit.stdout.trim()) ? commit.stdout.trim() : null;
  const worktree = runGit('git', ['status', '--porcelain', '--untracked-files=normal'], {cwd: sourceRoot, encoding: 'utf8', windowsHide: true});
  const gitDirty = worktree.status === 0 ? Boolean(worktree.stdout.trim()) : null;
  const info = {schemaVersion: 1, builtAt: recordedAt, version: loaded.packageInfo.version, platform: 'win32', arch: 'x64', publicDistribution: true,
    privateUseOnly: false, unsigned: true, gitCommit, gitDirty, sourceSnapshotSha256, sourceFrozenSnapshot: sourceSnapshotSha256, inputAllowlists: loaded.manifests, electron: loaded.electron,
    dependencies: loaded.dependencies, storage: PUBLIC_MARKER, sourceFiles, files,
    validation: {status: 'artifact-integrity-only', unverified: ['Interactive install/uninstall and upgrade on a clean Windows account', 'First-run automatic recipient-side backend deployment and real playback', 'Code signing and SmartScreen reputation']}};
  const infoBytes = Buffer.from(`${JSON.stringify(info, null, 2)}\n`);
  writeGenerated('BUILD-INFO.json', infoBytes); writeGenerated('BUILD-INFO.sha256', `${sha256(infoBytes)}  BUILD-INFO.json\n`);
  fs.unlinkSync(path.join(output, 'PUBLIC-PACKAGE-INCOMPLETE'));
  verifyPublicPackage(output, {sourceRoot, pinOfficial});
  return {outputDirectory: output, info, buildInfoSha256: sha256(infoBytes)};
}
function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/package-public.js --output dist/Still-public-<fresh-name>');
  const result = packagePublic({outputDirectory: path.resolve(ROOT, args[1])});
  process.stdout.write(`Public package verified: ${result.outputDirectory}\nBUILD-INFO SHA256: ${result.buildInfoSha256}\n`);
}
if (require.main === module) {try {main();} catch (error) {process.stderr.write(`${error.message}\n`); process.exitCode = 1;}}
module.exports = {ROOT, HASH, MANIFESTS, MARKER_PATH, PUBLIC_MARKER, PUBLIC_POLICY, OFFICIAL_INSTALLER, EXTRACTOR_PATHS, EXTRACTOR_PINS, sha256, safeRelative, assertPublicPath, assertNoLinks, regularBytes, walkFiles,
  validateFileList, validateBootstrapManifest, publicRuntimeFiles, assertExactFiles, loadInputs, validateOutput, snapshotFiles, verifyPublicPackage, packagePublic, main};
