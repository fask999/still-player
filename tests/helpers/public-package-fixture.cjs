'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {DESKTOP_MEDIA_FILES, CUE_READ_LEASE_FILES} = require('../../scripts/runtime-assets');
const {sha256, regularBytes, packagePublic, verifyPublicPackage, OFFICIAL_INSTALLER, EXTRACTOR_PATHS} = require('../../scripts/package-public');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'still-public-package-'));
  t.after(() => {
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(root).startsWith('still-public-package-'));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const write = (relative, value) => {fs.mkdirSync(path.dirname(path.join(root, relative)), {recursive: true}); fs.writeFileSync(path.join(root, relative), value);};
  const json = (relative, value) => write(relative, `${JSON.stringify(value, null, 2)}\n`);
  const app = ['src/main/entry.js', 'src/renderer/index.html', 'docs/public-installer.md', 'manifests/public-backend.json', 'src/main/backend-output-policy.json', 'src/main/runtime-assets.json'];
  for (const relative of app) write(relative, relative === 'src/renderer/index.html' ? '<!doctype html><title>STILL</title>' : `Public fixture ${relative}\n`);
  for (const name of DESKTOP_MEDIA_FILES) {
    const relative = `native/desktop-media/bin/${name}`;
    write(relative, fs.readFileSync(path.join(__dirname, '../..', relative)));
    app.push(relative);
  }
  for (const name of CUE_READ_LEASE_FILES) {
    const relative = `native/cue-read-lease/bin/${name}`;
    write(relative, fs.readFileSync(path.join(__dirname, '../..', relative)));
    app.push(relative);
  }
  const pkg = {path: 'node_modules/example', version: '1.0.0', resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', integrity: 'sha512-YWJjZA=='};
  json(`${pkg.path}/package.json`, {name: 'example', version: '1.0.0'}); write(`${pkg.path}/LICENSE`, 'Original MIT fixture license'); write(`${pkg.path}/index.js`, 'module.exports = {};\n');
  const dependencyFiles = ['package.json', 'LICENSE', 'index.js'].map(name => {const relative = `${pkg.path}/${name}`, bytes = fs.readFileSync(path.join(root, relative)); return {path: relative, bytes: bytes.length, sha256: sha256(bytes)};});
  json('installer/dependency-files.json', {schemaVersion: 1, packages: [pkg], files: dependencyFiles});
  json('installer/public-files.json', {schemaVersion: 1, files: app.map(path => ({path}))});
  const electronRoot = path.join(root, 'node_modules/electron/dist');
  for (const name of ['electron.exe', 'LICENSE', 'LICENSES.chromium.html', 'version', 'resources/default_app.asar']) write(`node_modules/electron/dist/${name}`, name === 'version' ? '45.1.0' : `Electron fixture ${name}`);
  const electronFiles = ['electron.exe', 'LICENSE', 'LICENSES.chromium.html', 'version', 'resources/default_app.asar'].map(name => {const bytes = fs.readFileSync(path.join(electronRoot, name)); return {path: name, bytes: bytes.length, sha256: sha256(bytes)};});
  json('installer/electron-files.json', {schemaVersion: 1, version: '45.1.0', architecture: 'x64', archive: 'electron-v45.1.0-win32-x64.zip', archiveSha256: 'a'.repeat(64), files: electronFiles});
  json('package.json', {name: 'still-desktop', version: '1.0.1', main: 'src/main/entry.js', devDependencies: {electron: '45.1.0'}});
  json('package-lock.json', {packages: {'': {}, 'node_modules/electron': {version: '45.1.0', dev: true}, [pkg.path]: {version: pkg.version, resolved: pkg.resolved, integrity: pkg.integrity}}});
  const dependencyList = JSON.parse(regularBytes(root, 'installer/dependency-files.json'));
  dependencyList.source = {packageSha256: sha256(regularBytes(root, 'package.json')), lockfileSha256: sha256(regularBytes(root, 'package-lock.json')), directDependencies: {}};
  json('installer/dependency-files.json', dependencyList);
  const output = path.join(root, 'dist/Still-public-test');
  const setup = Buffer.from('Official installer fixture'); write(OFFICIAL_INSTALLER.relativePath, setup);
  const components = ['foo_beefweb', 'foo_still_spectrum'].map(name => {const sourcePath = `bootstrap/${name}/${name}.dll`, bytes = Buffer.from(`Component fixture ${name}`); write(sourcePath, bytes); return {sourcePath, targetPath: `profile/user-components-x64/${name}/${name}.dll`, bytes: bytes.length, sha256: sha256(bytes)};});
  const extractorFiles = EXTRACTOR_PATHS.map(relativePath => {const bytes = Buffer.from(`Pinned extractor fixture ${relativePath}`); write(relativePath, bytes); return {relativePath, bytes: bytes.length, sha256: sha256(bytes)};});
  const bootstrap = {schemaVersion: 2, deployment: 'extract-original-installer', foobarVersion: '2.26.2', architecture: 'x64', installer: {...OFFICIAL_INSTALLER, bytes: setup.length, sha256: sha256(setup)}, coreFiles: [{relativePath: 'foobar2000.exe', bytes: 123, sha256: 'b'.repeat(64)}, {relativePath: 'portable_mode_enabled', bytes: 0, sha256: sha256(Buffer.alloc(0))}], components, extractor: {executable: EXTRACTOR_PATHS[0], files: extractorFiles}};
  json('manifests/public-backend.json', bootstrap);
  return {root, output, write, json, bootstrap, package: options => packagePublic({sourceRoot: root, outputDirectory: output, bootstrapRoot: root, validateSources: false, pinOfficial: false, recordedAt: '2026-11-08T00:00:00Z', runGit: () => ({status: 1, stdout: ''}), ...options}), verify: () => verifyPublicPackage(output, {sourceRoot: root, pinOfficial: false})};
}

module.exports = {fixture};
