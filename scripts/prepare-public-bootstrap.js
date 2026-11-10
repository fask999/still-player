'use strict';
// Fetch only pinned upstream artifacts. The official foobar installer is never
// extracted or executed here; only the upstream Beefweb component ZIP is read.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const {ROOT, OFFICIAL_INSTALLER, EXTRACTOR_PATHS, EXTRACTOR_PINS, sha256, assertNoLinks, regularBytes, safeRelative, validateBootstrapManifest, walkFiles} = require('./package-public');
const SOURCES_PATH = 'installer/bootstrap-sources.json';
const DEFAULT_STAGE = path.join(ROOT, 'tools/public-bootstrap-auto-20261108');
const BEEF_FILES = ['beefweb.root/', 'beefweb.root/bundle.css', 'beefweb.root/bundle.js', 'beefweb.root/index.html', 'beefweb.root/sprite.svg', 'beefweb.root/third-party-licenses.txt', 'foo_beefweb.dll', 'x64/', 'x64/foo_beefweb.dll'];
const SPECTRUM_FILES = ['foo_still_spectrum.dll', 'foobar2000-sdk-license.txt', 'pfc-license.txt', 'COMPONENT-DETAILS.md'];
function readBeefwebZip(bytes) {
  // This exact upstream archive uses ordinary single-disk ZIP entries. Reject
  // Zip64, encryption, links and any added namespace instead of generalizing.
  const eocd = bytes.length - 22;
  if (eocd < 0 || bytes.readUInt32LE(eocd) !== 0x06054b50 || bytes.readUInt16LE(eocd + 20) !== 0 ||
      bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0 || bytes.readUInt16LE(eocd + 8) !== bytes.readUInt16LE(eocd + 10)) throw new Error('Unsupported Beefweb ZIP end record');
  const count = bytes.readUInt16LE(eocd + 10), centralSize = bytes.readUInt32LE(eocd + 12), centralOffset = bytes.readUInt32LE(eocd + 16);
  if (count !== BEEF_FILES.length || centralOffset + centralSize !== eocd) throw new Error('Beefweb ZIP namespace differs from the reviewed archive');
  const files = new Map(); let cursor = centralOffset;
  for (let index = 0; index < count; index++) {
    if (cursor > eocd - 46 || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid Beefweb ZIP directory');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), disk = bytes.readUInt16LE(cursor + 34), attributes = bytes.readUInt32LE(cursor + 38), offset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || flags & 1 || ![0, 8].includes(method) || disk !== 0 || compressed === 0xffffffff || size > 4 * 1024 * 1024 || (attributes >>> 16 & 0xf000) === 0xa000 || attributes & 0x400) throw new Error('Unsupported, oversized or linked Beefweb ZIP entry');
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!BEEF_FILES.includes(name) || files.has(name)) throw new Error(`Unreviewed Beefweb ZIP path: ${name}`);
    if (offset > centralOffset - 30 || bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) throw new Error('Invalid Beefweb ZIP local header');
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtraLength = bytes.readUInt16LE(offset + 28), start = offset + 30 + localNameLength + localExtraLength;
    if (bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8') !== name || start + compressed > centralOffset) throw new Error('Beefweb ZIP local path or extent differs');
    const data = bytes.subarray(start, start + compressed), output = method === 8 ? zlib.inflateRawSync(data, {maxOutputLength: 4 * 1024 * 1024}) : Buffer.from(data);
    if (output.length !== size || zlib.crc32(output) !== crc) throw new Error('Beefweb ZIP CRC/size mismatch');
    files.set(name, output); cursor = next;
  }
  if (cursor !== eocd || !BEEF_FILES.every(name => files.has(name))) throw new Error('Incomplete Beefweb ZIP');
  const dll = files.get('x64/foo_beefweb.dll'), peOffset = dll.length >= 64 ? dll.readUInt32LE(0x3c) : 0;
  if (dll.length < 64 || dll.readUInt16LE(0) !== 0x5a4d || peOffset > dll.length - 26 || dll.readUInt32LE(peOffset) !== 0x4550 || dll.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error('Beefweb component is not x64 PE');
  return files;
}
function loadSources(sourceRoot = ROOT) {
  const bytes = regularBytes(sourceRoot, SOURCES_PATH), value = JSON.parse(bytes);
  if (value.schemaVersion !== 2 || value.foobarInstaller.sha256 !== OFFICIAL_INSTALLER.sha256 || value.foobarInstaller.bytes !== OFFICIAL_INSTALLER.bytes ||
      value.foobarInstaller.url !== 'https://www.foobar2000.org/downloads/foobar2000-x64_v2.26.2.exe' ||
      value.beefweb.url !== 'https://github.com/hyperblast/beefweb/releases/download/v0.10/foo_beefweb-0.10.fb2k-component' ||
      value.beefweb.sha256 !== 'e59005e1681f70b9ca12e12b08bf2e6d30b5fbffe6bf3d5918f39926fe8efb47' || value.beefweb.bytes !== 1102816 ||
      value.beefwebLicense.path !== 'docs/licenses/Beefweb-v0.10-LICENSE.txt' || value.beefwebLicense.sha256 !== '432217f8773da16fe66df61da05e3333975cf5b90c4ff43d112280510deb0959' ||
      value.extractor?.version !== '26.06' || !Array.isArray(value.extractor.files) || value.extractor.files.length !== EXTRACTOR_PATHS.length) throw new Error('Unreviewed bootstrap download sources');
  const expected = EXTRACTOR_PATHS.map(relativePath => relativePath.slice('bootstrap/7zip/'.length));
  if (JSON.stringify(value.extractor.files.map(item => item.name).sort()) !== JSON.stringify([...expected].sort())) throw new Error('Unexpected extractor source namespace');
  for (const item of value.extractor.files) {
    const keys = ['name', 'bytes', 'sha256', ...(['License.txt', 'COPYING.txt', 'Source-Info.txt'].includes(item.name) ? ['repositoryPath'] : item.name === '7z2606-src.7z' ? ['url'] : [])];
    if (Object.keys(item).length !== keys.length || !keys.every(key => Object.hasOwn(item, key))) throw new Error('Extractor source entries must use the closed known schema');
    const fixed = EXTRACTOR_PINS[item.name];
    if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256) || fixed && (fixed.bytes !== item.bytes || fixed.sha256 !== item.sha256)) throw new Error('Extractor source pin changed');
    const knownRepositoryFiles = {'License.txt': 'docs/licenses/7-Zip-26.06-BINARY-LICENSE.txt', 'COPYING.txt': 'docs/licenses/7-Zip-26.06-LGPL-2.1.txt', 'Source-Info.txt': 'docs/licenses/7-Zip-26.06-SOURCE-INFO.txt'};
    if (knownRepositoryFiles[item.name] && item.repositoryPath !== knownRepositoryFiles[item.name]) throw new Error('Unreviewed extractor notice source');
    if (item.name === '7z2606-src.7z' && item.url !== 'https://github.com/ip7z/7zip/releases/download/26.06/7z2606-src.7z') throw new Error('Unreviewed extractor source archive');
  }
  return {value, sha256: sha256(bytes)};
}
async function fetchPinned(spec, {fetcher = fetch} = {}) {
  const allowed = new Set(['www.foobar2000.org', 'github.com', 'release-assets.githubusercontent.com']);
  let url = new URL(spec.url);
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (url.protocol !== 'https:' || !allowed.has(url.hostname) || url.username || url.password) throw new Error('Unexpected bootstrap download origin');
    const response = await fetcher(url.href, {redirect: 'manual', signal: AbortSignal.timeout(60000)});
    if ([301, 302, 303, 307, 308].includes(response.status)) {const location = response.headers.get('location'); if (!location) throw new Error('Bootstrap download redirect is missing'); url = new URL(location, url); continue;}
    if (!response.ok || !response.body) throw new Error(`Bootstrap download HTTP ${response.status}`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {length += chunk.length; if (length > spec.bytes) throw new Error('Bootstrap download exceeds the pinned size'); chunks.push(chunk);}
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== spec.bytes || sha256(bytes) !== spec.sha256) throw new Error('Bootstrap download integrity mismatch');
    return bytes;
  }
  throw new Error('Too many bootstrap download redirects');
}
function verifyInstallerSignature(filename, {run = spawnSync} = {}) {
  const escaped = path.resolve(filename).replaceAll("'", "''");
  // A PowerShell 7 parent can supply PSModulePath entries incompatible with
  // Windows PowerShell 5.1. Import its own built-in signing module explicitly;
  // never relax signature validation or mutate the inherited module path.
  const command = `Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $s=Get-AuthenticodeSignature -LiteralPath '${escaped}' -ErrorAction Stop; $r=[ordered]@{status=$s.Status.ToString();subject=[string]$s.SignerCertificate.Subject;thumbprint=[string]$s.SignerCertificate.Thumbprint}; $r | ConvertTo-Json -Compress`;
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {encoding: 'utf8', windowsHide: true, timeout: 30000});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Official installer signature inspection failed: ${(result.stderr || '').trim().slice(0, 1200)}`);
  const signature = JSON.parse(result.stdout);
  if (signature.status !== 'Valid' || signature.subject !== OFFICIAL_INSTALLER.signerSubject || signature.thumbprint !== OFFICIAL_INSTALLER.signerThumbprint) throw new Error('Official installer signature does not match the supported publisher');
  return signature;
}
async function prepareBootstrap({sourceRoot = ROOT, stageRoot = DEFAULT_STAGE, fromDirectory, extractorDirectory = path.join(sourceRoot, 'tools/7zip-26.06-official-core/portable'), extractorSourceFile, fetcher, verifySignature = verifyInstallerSignature} = {}) {
  const sources = loadSources(sourceRoot), stage = assertNoLinks(stageRoot, {allowMissing: true});
  if (path.resolve(stage).toLowerCase() !== path.join(sourceRoot, 'tools/public-bootstrap-auto-20261108').toLowerCase()) throw new Error('Bootstrap resources must use the fixed ignored project stage');
  if (fs.existsSync(stage)) throw new Error('Bootstrap stage already exists; retain it and verify its contents instead of overwriting it');
  const obtain = async (spec, name) => {
    const bytes = fromDirectory ? regularBytes(fromDirectory, name) : await fetchPinned(spec, {fetcher});
    if (bytes.length !== spec.bytes || sha256(bytes) !== spec.sha256) throw new Error(`Pinned bootstrap resource changed: ${name}`);
    return bytes;
  };
  const installer = await obtain(sources.value.foobarInstaller, 'foobar2000-x64_v2.26.2.exe');
  const beefweb = await obtain(sources.value.beefweb, 'foo_beefweb-0.10.fb2k-component'), entries = readBeefwebZip(beefweb);
  const license = regularBytes(sourceRoot, sources.value.beefwebLicense.path);
  if (sha256(license) !== sources.value.beefwebLicense.sha256) throw new Error('Beefweb original license changed');
  const staged = [{path: OFFICIAL_INSTALLER.relativePath, bytes: installer}];
  const extractorFiles = [];
  for (const item of sources.value.extractor.files) {
    let bytes;
    if (['7z.exe', '7z.dll'].includes(item.name)) bytes = regularBytes(extractorDirectory, item.name);
    else if (item.repositoryPath) bytes = regularBytes(sourceRoot, item.repositoryPath);
    else if (item.name === '7z2606-src.7z') {
      if (extractorSourceFile) {
        if (path.basename(extractorSourceFile) !== item.name) throw new Error('The corresponding source file must have its unchanged official archive name');
        bytes = regularBytes(path.dirname(extractorSourceFile), path.basename(extractorSourceFile));
      } else bytes = await fetchPinned(item, {fetcher});
    } else throw new Error('Unknown extractor resource');
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error(`Pinned extractor resource changed: ${item.name}`);
    const relativePath = `bootstrap/7zip/${item.name}`;
    staged.push({path: relativePath, bytes}); extractorFiles.push({relativePath, bytes: bytes.length, sha256: sha256(bytes)});
  }
  const component = (sourcePath, targetPath, bytes) => {staged.push({path: sourcePath, bytes}); return {sourcePath, targetPath, bytes: bytes.length, sha256: sha256(bytes)};};
  const components = [];
  for (const name of ['x64/foo_beefweb.dll', ...BEEF_FILES.filter(name => name.startsWith('beefweb.root/') && !name.endsWith('/'))]) {
    const relative = name === 'x64/foo_beefweb.dll' ? 'foo_beefweb.dll' : name;
    components.push(component(`bootstrap/components/foo_beefweb/${relative}`, `profile/user-components-x64/foo_beefweb/${relative}`, entries.get(name)));
  }
  components.push(component('bootstrap/components/foo_beefweb/LICENSE.txt', 'profile/user-components-x64/foo_beefweb/LICENSE.txt', license));
  for (const name of SPECTRUM_FILES) components.push(component(`bootstrap/components/foo_still_spectrum/${name}`, `profile/user-components-x64/foo_still_spectrum/${name}`, regularBytes(sourceRoot, `native/foobar-spectrum/package/${name}`)));
  fs.mkdirSync(path.dirname(stage), {recursive: true}); assertNoLinks(path.dirname(stage)); fs.mkdirSync(stage); assertNoLinks(stage);
  fs.writeFileSync(path.join(stage, 'BOOTSTRAP-INCOMPLETE'), 'Do not package incomplete bootstrap resources.\n', {flag: 'wx'});
  for (const item of staged) {safeRelative(item.path); const destination = path.join(stage, item.path); fs.mkdirSync(path.dirname(destination), {recursive: true}); assertNoLinks(path.dirname(destination)); fs.writeFileSync(destination, item.bytes, {flag: 'wx'});}
  const signature = verifySignature(path.join(stage, OFFICIAL_INSTALLER.relativePath));
  const record = {schemaVersion: 2, deployment: 'extract-original-installer', sourceManifestSha256: sources.sha256, officialInstaller: {...OFFICIAL_INSTALLER, signature}, components,
    extractor: {executable: EXTRACTOR_PATHS[0], files: extractorFiles},
    files: staged.map(item => ({path: item.path, bytes: item.bytes.length, sha256: sha256(item.bytes)}))};
  fs.writeFileSync(path.join(stage, 'BOOTSTRAP-RESOURCES.json'), `${JSON.stringify(record, null, 2)}\n`, {flag: 'wx'});
  if (loadSources(sourceRoot).sha256 !== sources.sha256) throw new Error('Bootstrap source manifest changed during preparation');
  fs.unlinkSync(path.join(stage, 'BOOTSTRAP-INCOMPLETE'));
  return {stageRoot: stage, record};
}
function writeBootstrapManifest(coreFiles, {sourceRoot = ROOT, stageRoot = DEFAULT_STAGE} = {}) {
  if (fs.existsSync(path.join(stageRoot, 'BOOTSTRAP-INCOMPLETE'))) throw new Error('Bootstrap resources are incomplete');
  const record = JSON.parse(regularBytes(stageRoot, 'BOOTSTRAP-RESOURCES.json'));
  if (record.sourceManifestSha256 !== loadSources(sourceRoot).sha256) throw new Error('Bootstrap resource provenance changed');
  const expected = record.files.map(item => item.path).concat('BOOTSTRAP-RESOURCES.json');
  if (JSON.stringify(walkFiles(stageRoot).sort()) !== JSON.stringify(expected.sort())) throw new Error('Unknown bootstrap stage file');
  for (const item of record.files) {const bytes = regularBytes(stageRoot, item.path); if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error('Staged bootstrap resource changed');}
  const manifest = {schemaVersion: 2, deployment: 'extract-original-installer', foobarVersion: '2.26.2', architecture: 'x64', installer: {...OFFICIAL_INSTALLER}, coreFiles, components: record.components, extractor: record.extractor};
  validateBootstrapManifest(manifest);
  const destination = path.join(sourceRoot, 'manifests/public-backend.json');
  assertNoLinks(destination, {allowMissing: true}); fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
  return manifest;
}
async function main(args = process.argv.slice(2)) {
  const options = {};
  const switches = {'--from-directory': 'fromDirectory', '--extractor-directory': 'extractorDirectory', '--extractor-source': 'extractorSourceFile'};
  if (args.length % 2) throw new Error('Expected explicit source option/value pairs');
  for (let index = 0; index < args.length; index += 2) {
    const key = switches[args[index]];
    if (!key || Object.hasOwn(options, key) || !args[index + 1]) throw new Error('Usage: node scripts/prepare-public-bootstrap.js [--from-directory <original-artifacts>] [--extractor-directory <pinned-7z-cli>] [--extractor-source <7z2606-src.7z>]');
    options[key] = path.resolve(args[index + 1]);
  }
  const result = await prepareBootstrap(options);
  process.stdout.write(`Pinned bootstrap resources prepared: ${result.stageRoot}\n${result.record.files.length} verified resource files; no official installer executed.\n`);
}
if (require.main === module) main().catch(error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
module.exports = {SOURCES_PATH, DEFAULT_STAGE, BEEF_FILES, SPECTRUM_FILES, readBeefwebZip, loadSources, fetchPinned, verifyInstallerSignature, prepareBootstrap, writeBootstrapManifest, main};
