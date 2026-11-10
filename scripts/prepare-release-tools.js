'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ROOT, sha256, assertNoLinks, regularBytes, walkFiles} = require('./package-public');
const {safeZipEntries, writeEntries, assertNames, HASH, exact} = require('./release-public-integrity');
const {prepareBootstrap, loadSources} = require('./prepare-public-bootstrap');
const {loadToolchain} = require('./build-installer');
function loadRecipe(root = ROOT) {
  const value = JSON.parse(regularBytes(root, 'installer/release-tools.json'));
  exact(value, ['schemaVersion', 'repository', 'repositoryId', 'allowedActors', 'candidateWorkflow', 'node', 'electron', 'nsis', 'sevenZipBootstrap', 'sevenZipArchive', 'actions'], 'release tool recipe');
  if (value.schemaVersion !== 1 || value.node.version !== '24.22.1' || value.electron.version !== '45.1.0' || value.nsis.version !== '3.13') throw new Error('Unreviewed release tool versions');
  for (const key of ['node', 'electron', 'nsis', 'sevenZipBootstrap', 'sevenZipArchive']) {
    const entry = value[key], url = new URL(entry.url);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || entry.bytes > 200 * 1024 ** 2 || !HASH.test(entry.sha256) || url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid pinned tool specification');
  }
  return value;
}
function allowedDownload(url, original) {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (['nodejs.org', 'github.com', 'release-assets.githubusercontent.com'].includes(url.hostname)) return true;
  return original.hostname === 'downloads.sourceforge.net' && (url.hostname === original.hostname || /^[a-z0-9-]+\.dl\.sourceforge\.net$/.test(url.hostname)) && decodeURIComponent(url.pathname) === decodeURIComponent(original.pathname);
}
async function fetchTool(spec, {fetcher = fetch} = {}) {
  const original = new URL(spec.url); let url = original, refreshes = 0;
  for (let redirects = 0; redirects <= 6; redirects++) {
    if (!allowedDownload(url, original)) throw new Error('Unapproved tool download redirect');
    const response = await fetcher(url.href, {redirect: 'manual', signal: AbortSignal.timeout(spec.bytes > 128 * 1024 ** 2 ? 600000 : 120000)});
    if ([301, 302, 303, 307, 308].includes(response.status)) {const next = response.headers.get('location'); if (!next) throw new Error('Missing tool redirect'); url = new URL(next, url); continue;}
    if (!response.ok || !response.body) throw new Error(`Pinned tool download failed: HTTP ${response.status}`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {length += chunk.length; if (length > Math.max(spec.bytes, 512 * 1024)) throw new Error('Tool response exceeds fixed size'); chunks.push(chunk);}
    const bytes = Buffer.concat(chunks);
    if (bytes.length === spec.bytes && sha256(bytes) === spec.sha256) return bytes;
    if (original.hostname === 'downloads.sourceforge.net' && !refreshes && bytes.length < 512 * 1024) {
      const match = bytes.toString('utf8').match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*?url=([^"'>]+)["']/i);
      if (match) {refreshes++; url = new URL(match[1].replaceAll('&amp;', '&'), url); continue;}
    }
    throw new Error('Pinned tool hash/size mismatch');
  }
  throw new Error('Too many pinned tool redirects');
}
function verifyFiles(root, files) {
  assertNames(walkFiles(root), files.map(file => file.path), 'reviewed runtime/tool namespace');
  for (const file of files) {const bytes = regularBytes(root, file.path); if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Reviewed file differs: ${file.path}`);}
}
function runNode(node, args, {cwd, env, run = spawnSync} = {}) {
  const result = run(node, args, {cwd, env, stdio: 'inherit', windowsHide: true});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Pinned Node/npm operation failed');
}
async function prepareReleaseTools({root = ROOT, fetcher = fetch, run = spawnSync} = {}) {
  if (process.env.GH_TOKEN) throw new Error('Release-write token must not enter tool/build preparation');
  const recipe = loadRecipe(root);
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== recipe.node.version) throw new Error('Use the reviewed Windows x64 portable Node bootstrap');
  root = assertNoLinks(root);
  if (fs.existsSync(path.join(root, 'node_modules'))) throw new Error('Release preparation requires a fresh workspace without node_modules');
  const stage = path.join(root, 'tools/release-ci');
  fs.mkdirSync(stage, {recursive: true}); assertNoLinks(stage);
  const userConfig = path.join(stage, 'npm-user.conf'), globalConfig = path.join(stage, 'npm-global.conf');
  fs.writeFileSync(userConfig, 'registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\n', {flag: 'wx'});
  fs.writeFileSync(globalConfig, '', {flag: 'wx'});
  const node = process.execPath, npm = path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js');
  if (!fs.existsSync(npm)) throw new Error('Portable Node ZIP npm is missing');
  const lock = JSON.parse(regularBytes(root, 'package-lock.json'));
  for (const [name, item] of Object.entries(lock.packages || {})) {
    if (!name) continue;
    if (item.link || !item.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity || '')) throw new Error('All dependency downloads must be fixed npm SRI entries');
  }
  const environment = {...process.env, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_cache: path.join(stage, 'npm-cache')};
  runNode(node, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: root, env: environment, run});
  const electron = JSON.parse(regularBytes(root, 'installer/electron-files.json'));
  if (electron.archiveSha256 !== recipe.electron.sha256) throw new Error('Electron recipe and reviewed leaf list disagree');
  const electronBytes = await fetchTool(recipe.electron, {fetcher});
  const electronRoot = path.join(root, 'node_modules/electron/dist');
  writeEntries(safeZipEntries(electronBytes, {expectedFiles: electron.files.map(file => file.path)}), electronRoot);
  verifyFiles(electronRoot, electron.files);
  fs.writeFileSync(path.join(root, 'node_modules/electron/path.txt'), 'electron.exe');
  const nsisBytes = await fetchTool(recipe.nsis, {fetcher});
  const nsisManifest = JSON.parse(regularBytes(root, 'installer/nsis-toolchain.json'));
  if (nsisManifest.archiveSha256 !== recipe.nsis.sha256) throw new Error('NSIS recipe and reviewed tool list disagree');
  const nsisRoot = path.join(root, 'tools/nsis-3.13/nsis-3.13');
  writeEntries(safeZipEntries(nsisBytes, {prefix: recipe.nsis.prefix, expectedFiles: nsisManifest.files.map(file => file.path)}), nsisRoot);
  loadToolchain(root, path.join(nsisRoot, 'makensis.exe'));
  const bootstrap = await fetchTool(recipe.sevenZipBootstrap, {fetcher}), archive = await fetchTool(recipe.sevenZipArchive, {fetcher});
  const archiverRoot = path.join(root, 'tools/7zip-26.06-official-core');
  fs.mkdirSync(archiverRoot); const bootstrapPath = path.join(archiverRoot, '7zr.exe'), archivePath = path.join(archiverRoot, '7z2606-x64.exe');
  fs.writeFileSync(bootstrapPath, bootstrap, {flag: 'wx'}); fs.writeFileSync(archivePath, archive, {flag: 'wx'});
  const portable = path.join(archiverRoot, 'portable'); fs.mkdirSync(portable);
  const sourceRecipe = loadSources(root).value;
  for (const name of ['7z.exe', '7z.dll', 'License.txt']) {
    const expected = sourceRecipe.extractor.files.find(file => file.name === name);
    const result = run(bootstrapPath, ['x', '-so', '-spd', '--', archivePath, name], {windowsHide: true, timeout: 30000, maxBuffer: expected.bytes + 1024});
    if (result.error) throw result.error;
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length !== expected.bytes || sha256(result.stdout) !== expected.sha256) throw new Error('Exact 7-Zip CLI archive member differs');
    fs.writeFileSync(path.join(portable, name), result.stdout, {flag: 'wx'});
  }
  await prepareBootstrap({sourceRoot: root, extractorDirectory: portable, fetcher});
  const dependencyRoot = path.join(stage, 'production'); fs.mkdirSync(dependencyRoot);
  for (const file of ['package.json', 'package-lock.json']) fs.writeFileSync(path.join(dependencyRoot, file), regularBytes(root, file), {flag: 'wx'});
  runNode(node, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: dependencyRoot, env: environment, run});
  const dependencies = JSON.parse(regularBytes(root, 'installer/dependency-files.json'));
  for (const item of dependencies.files) {const bytes = regularBytes(dependencyRoot, item.path); if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error('Clean production dependency leaf differs');}
  fs.writeFileSync(path.join(stage, 'prepared.json'), `${JSON.stringify({schemaVersion: 1, nodeVersion: recipe.node.version, dependencyRoot: 'tools/release-ci/production', allRuntimeArchivesVerified: true}, null, 2)}\n`, {flag: 'wx'});
  return {dependencyRoot, electronRoot, compilerPath: path.join(nsisRoot, 'makensis.exe')};
}
if (require.main === module) prepareReleaseTools().then(() => process.stdout.write('Pinned fresh release tools/dependencies prepared.\n')).catch(error => {process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
module.exports = {loadRecipe, allowedDownload, fetchTool, verifyFiles, prepareReleaseTools};
