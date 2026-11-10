'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {BEEF_FILES, readBeefwebZip, fetchPinned, verifyInstallerSignature, loadSources} = require('../scripts/prepare-public-bootstrap');
const {sha256, safeRelative, assertPublicPath, loadInputs, regularBytes, PUBLIC_MARKER, OFFICIAL_INSTALLER, validateBootstrapManifest, PUBLIC_POLICY, EXTRACTOR_PATHS, EXTRACTOR_PINS} = require('../scripts/package-public');
const {fixture} = require('./helpers/public-package-fixture.cjs');

test('public packaging excludes all private trees and retains every original license and exact source hash', async t => {
  const f = await fixture(t);
  for (const privatePath of ['backend/foobar2000/foobar2000.exe', 'data/library.json', 'auth/token.txt', 'docs/evidence/user.json', 'review-evidence/private.json', '.env', 'dist/Still-V2-preview-win32-x64/data/secret']) f.write(privatePath, 'PRIVATE_DO_NOT_COPY');
  const result = f.package();
  const info = f.verify();
  assert.equal(info.publicDistribution, true); assert.equal(info.unsigned, true);
  assert.equal(info.sourceSnapshotSha256, result.info.sourceSnapshotSha256);
  assert.deepEqual(JSON.parse(regularBytes(f.output, 'resources/app/public-release.json')), PUBLIC_MARKER);
  assert.deepEqual(JSON.parse(regularBytes(f.output, 'resources/app/src/main/backend-output-policy.json')), PUBLIC_POLICY);
  assert.equal(regularBytes(f.output, 'resources/app/node_modules/example/LICENSE').toString(), 'Original MIT fixture license');
  assert.ok(info.files.LICENSE); assert.ok(info.files['LICENSES.chromium.html']);
  assert.equal(fs.existsSync(path.join(f.output, 'resources/default_app.asar')), false);
  assert.ok(Object.keys(info.files).every(name => !/backend\/foobar2000|(?:^|\/)data\/|(?:^|\/)auth\/|\.env|evidence/.test(name)));
  assert.equal(sha256(regularBytes(f.root, 'src/main/entry.js')), info.sourceFiles['resources/app/src/main/entry.js'].sha256);
  assert.throws(() => f.package(), /already exists/);
});

test('public source unknown file, dependency drift and Electron drift fail before creating output', async t => {
  const f = await fixture(t);
  f.write('src/main/unreviewed.js', 'Unknown'); assert.throws(() => f.package(), /Unknown or missing application source/); assert.equal(fs.existsSync(f.output), false);
  fs.unlinkSync(path.join(f.root, 'src/main/unreviewed.js'));
  f.write('node_modules/example/index.js', 'Modified'); assert.throws(() => f.package(), /hash mismatch/); assert.equal(fs.existsSync(f.output), false);
  f.write('node_modules/example/index.js', 'module.exports = {};\n');
  f.write('node_modules/electron/dist/electron.exe', 'Modified'); assert.throws(() => f.package(), /hash mismatch/); assert.equal(fs.existsSync(f.output), false);
});

test('public input hardlinks and redirected ancestors are rejected without output writes', async t => {
  const f = await fixture(t), input = path.join(f.root, 'src/main/entry.js');
  fs.linkSync(input, path.join(f.root, 'retained-hardlink')); assert.throws(() => f.package(), /unlinked regular/); assert.equal(fs.existsSync(f.output), false);
  fs.unlinkSync(path.join(f.root, 'retained-hardlink'));
  fs.mkdirSync(path.join(f.root, 'elsewhere'));
  fs.symlinkSync(path.join(f.root, 'elsewhere'), path.join(f.root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.package(), /links\/junctions/); assert.equal(fs.readdirSync(path.join(f.root, 'elsewhere')).length, 0);
});

test('package verification rejects unknown additions, payload tampering and incomplete markers', async t => {
  const f = await fixture(t); f.package();
  f.write('dist/Still-public-test/unknown.txt', 'Unknown'); assert.throws(() => f.verify(), /Unknown or missing actual public payload/);
  fs.unlinkSync(path.join(f.output, 'unknown.txt'));
  fs.appendFileSync(path.join(f.output, 'resources/app/src/main/entry.js'), 'Changed'); assert.throws(() => f.verify(), /changed/);
  f.write('dist/Still-public-test/PUBLIC-PACKAGE-INCOMPLETE', 'Build failed'); assert.throws(() => f.verify(), /incomplete/);
});

test('public paths reject traversal, Windows aliases, secrets and build-tool directories', () => {
  for (const value of ['../data/library.json', 'C:/secret', 'src\\main.js', 'src/file:stream', 'src/name.', 'src/name ', 'src/*', 'src/CON.txt']) assert.throws(() => safeRelative(value), /Unsafe/);
  for (const value of ['.env', 'src/.env.local', 'src/auth/token.txt', 'tools/compiler.exe', 'docs/evidence/user.json', '.git/config', 'src/user.key']) assert.throws(() => assertPublicPath(value), /forbidden/);
});

test('runtime package names, lock integrity and license files are mandatory', async t => {
  const f = await fixture(t), list = JSON.parse(regularBytes(f.root, 'installer/dependency-files.json'));
  list.packages[0].integrity = 'sha512-different'; f.json('installer/dependency-files.json', list);
  assert.throws(() => loadInputs(f.root, {bootstrapRoot: f.root}), /Unreviewed public dependency/);
  list.packages[0].integrity = 'sha512-YWJjZA=='; list.files = list.files.filter(item => !item.path.endsWith('/LICENSE')); f.json('installer/dependency-files.json', list);
  assert.throws(() => loadInputs(f.root, {bootstrapRoot: f.root}), /license is missing/);
});

test('official installer pin and component target namespace cannot be relaxed in a release', async t => {
  const f = await fixture(t);
  assert.throws(() => validateBootstrapManifest(f.bootstrap), /Unreviewed official/);
  assert.equal(validateBootstrapManifest(f.bootstrap, {pinOfficial: false}).length, 9);
  f.bootstrap.components[0].targetPath = '../other-profile/foo.dll';
  assert.throws(() => validateBootstrapManifest(f.bootstrap, {pinOfficial: false}), /Unsafe/);
});

test('automatic deployment requires the exact independent tool, full licenses and corresponding source archive', async t => {
  const f = await fixture(t), value = structuredClone(f.bootstrap);
  value.installer = {...OFFICIAL_INSTALLER};
  value.extractor.files = EXTRACTOR_PATHS.map(relativePath => ({relativePath, ...EXTRACTOR_PINS[path.posix.basename(relativePath)]}));
  assert.equal(validateBootstrapManifest(value).length, 9);
  const missingSource = structuredClone(value); missingSource.extractor.files = missingSource.extractor.files.filter(item => !item.relativePath.endsWith('.7z'));
  assert.throws(() => validateBootstrapManifest(missingSource), /public extractor files/);
  const alteredLicense = structuredClone(value); alteredLicense.extractor.files.find(item => item.relativePath.endsWith('/License.txt')).sha256 = '0'.repeat(64);
  assert.throws(() => validateBootstrapManifest(alteredLicense), /Unreviewed public extractor asset/);
  const linkedCode = structuredClone(value); linkedCode.extractor.executable = 'bootstrap/7zip/7z.dll';
  assert.throws(() => validateBootstrapManifest(linkedCode), /extractor executable/);
  const privateCore = structuredClone(value); privateCore.coreFiles.push({relativePath: 'profile/library.json', bytes: 1, sha256: '1'.repeat(64)});
  assert.throws(() => validateBootstrapManifest(privateCore), /forbidden/);
});

test('extractor source manifest rejects undeclared file-reading selectors', async t => {
  const f = await fixture(t), sources = JSON.parse(fs.readFileSync(path.join(__dirname, '../installer/bootstrap-sources.json')));
  f.json('installer/bootstrap-sources.json', sources); assert.equal(loadSources(f.root).value.extractor.files.length, 6);
  sources.extractor.files.find(item => item.name === '7z.exe').repositoryPath = 'auth/session.json';
  f.json('installer/bootstrap-sources.json', sources);
  assert.throws(() => loadSources(f.root), /closed known schema/);
});

test('rewriting the integrity metadata cannot authorize an extra file', async t => {
  const f = await fixture(t); f.package();
  const info = JSON.parse(regularBytes(f.output, 'BUILD-INFO.json'));
  f.write('dist/Still-public-test/extra.js', 'Unauthorized'); info.files['extra.js'] = {bytes: 12, sha256: sha256(Buffer.from('Unauthorized'))};
  const bytes = Buffer.from(`${JSON.stringify(info, null, 2)}\n`); fs.writeFileSync(path.join(f.output, 'BUILD-INFO.json'), bytes); fs.writeFileSync(path.join(f.output, 'BUILD-INFO.sha256'), `${sha256(bytes)}  BUILD-INFO.json\n`);
  assert.throws(() => f.verify(), /recorded public payload/);
});

test('rewritten source hashes and self-checksum cannot authorize modified application code', async t => {
  const f = await fixture(t); f.package();
  const relative = 'resources/app/src/main/entry.js', changed = Buffer.from('Modified application code');
  fs.writeFileSync(path.join(f.output, relative), changed);
  const info = JSON.parse(regularBytes(f.output, 'BUILD-INFO.json')), record = {bytes: changed.length, sha256: sha256(changed)};
  info.files[relative] = record; info.sourceFiles[relative] = record; info.sourceSnapshotSha256 = sha256(Buffer.from(JSON.stringify(info.sourceFiles)));
  const bytes = Buffer.from(`${JSON.stringify(info, null, 2)}\n`); fs.writeFileSync(path.join(f.output, 'BUILD-INFO.json'), bytes); fs.writeFileSync(path.join(f.output, 'BUILD-INFO.sha256'), `${sha256(bytes)}  BUILD-INFO.json\n`);
  assert.throws(() => f.verify(), /differs from the reviewed source/);
});

function beefwebZipFixture({badName = false, linked = false, corruptCrc = false} = {}) {
  const chunks = [], directory = []; let offset = 0;
  for (const [index, original] of BEEF_FILES.entries()) {
    const name = badName && original === 'foo_beefweb.dll' ? 'foo_beefweb.cmd' : original;
    const data = name.endsWith('/') ? Buffer.alloc(0) : Buffer.from(`Public zip fixture ${name}`);
    const bytes = original === 'x64/foo_beefweb.dll' ? Buffer.alloc(128) : data;
    if (original === 'x64/foo_beefweb.dll') {bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 0x3c); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68);}
    const filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), crc = zlib.crc32(bytes);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(corruptCrc && index === 1 ? (crc ^ 1) >>> 0 : crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(linked && index === 1 ? 0xa0000000 : 0, 38); central.writeUInt32LE(offset, 42);
    chunks.push(local, filename, bytes); directory.push(central, filename); offset += local.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(BEEF_FILES.length, 8); end.writeUInt16LE(BEEF_FILES.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}

test('only the exact Beefweb archive namespace, CRC and unlinked x64 DLL are accepted', () => {
  assert.equal(readBeefwebZip(beefwebZipFixture()).size, BEEF_FILES.length);
  assert.throws(() => readBeefwebZip(beefwebZipFixture({badName: true})), /Unreviewed/);
  assert.throws(() => readBeefwebZip(beefwebZipFixture({linked: true})), /linked/);
  assert.throws(() => readBeefwebZip(beefwebZipFixture({corruptCrc: true})), /CRC/);
});

test('bootstrap downloader pins bytes and restricts redirects without live network', async () => {
  const bytes = Buffer.from('Pinned official artifact'), spec = {url: 'https://www.foobar2000.org/downloads/pinned.exe', bytes: bytes.length, sha256: sha256(bytes)};
  assert.deepEqual(await fetchPinned(spec, {fetcher: async () => new Response(bytes)}), bytes);
  await assert.rejects(fetchPinned({...spec, sha256: '0'.repeat(64)}, {fetcher: async () => new Response(bytes)}), /integrity/);
  let calls = 0;
  await assert.rejects(fetchPinned(spec, {fetcher: async () => {calls++; return new Response(null, {status: 302, headers: {location: 'https://unreviewed.invalid/payload.exe'}});}}), /Unexpected.*origin/);
  assert.equal(calls, 1);
});

test('official signature inspection requires the pinned valid publisher and thumbprint', () => {
  const run = value => (_executable, args) => {assert.match(args[3], /Import-Module \(Join-Path \$PSHOME 'Modules\\Microsoft\.PowerShell\.Security/); assert.match(args[3], /Get-AuthenticodeSignature[^;]+-ErrorAction Stop/); return {status: 0, stdout: JSON.stringify(value), stderr: ''};};
  const good = {status: 'Valid', subject: OFFICIAL_INSTALLER.signerSubject, thumbprint: OFFICIAL_INSTALLER.signerThumbprint};
  assert.deepEqual(verifyInstallerSignature('fixture.exe', {run: run(good)}), good);
  assert.throws(() => verifyInstallerSignature('fixture.exe', {run: run({...good, thumbprint: 'unknown'})}), /publisher/);
});

test('unknown private source/output namespaces are rejected without opening their contents', async t => {
  const f = await fixture(t), source = path.join(f.root, 'src/auth/session.json');
  f.write('src/auth/session.json', 'Private contents must never be read');
  const before = fs.openSync; let privateOpens = 0;
  const forbid = target => {fs.openSync = (filename, ...args) => {if (path.resolve(String(filename)).toLowerCase() === target.toLowerCase()) {privateOpens++; throw new Error('Private content was opened before namespace validation');} return before(filename, ...args);};};
  forbid(source);
  try {assert.throws(() => loadInputs(f.root, {bootstrapRoot: f.root}), /Unknown or missing application source/);}
  finally {fs.openSync = before;}
  assert.equal(privateOpens, 0); assert.equal(fs.existsSync(f.output), false);
  fs.unlinkSync(source); fs.rmdirSync(path.dirname(source)); f.package();
  const output = path.join(f.output, 'resources/app/auth/session.json'); f.write('dist/Still-public-test/resources/app/auth/session.json', 'Private output must never be read');
  forbid(output);
  try {assert.throws(() => f.verify(), /Unknown or missing actual public payload/);}
  finally {fs.openSync = before;}
  assert.equal(privateOpens, 0);
});
