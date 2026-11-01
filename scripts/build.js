'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {pathToFileURL, fileURLToPath} = require('node:url');
const {verifySpectrumDelivery} = require('./install-spectrum-component');
const {loadBackendBaselines} = require('./backend-baselines');
const {verifyRuntimeAssets, assertRuntimeAssetSnapshot} = require('./runtime-assets');
const {verifySpectrumClientRevision} = require('./spectrum-client-revision');
const root = path.resolve(__dirname, '..');
function checkRendererAssets(rendererDirectory) {
  const renderer = fs.realpathSync(rendererDirectory);
  const visited = new Set();
  const checked = [];
  function check(reference, owner, allowEmbedded = false) {
    if (allowEmbedded && (reference.startsWith('#') || reference.startsWith('data:'))) return;
    if (!reference) throw new Error('Renderer asset reference is empty');
    const url = new URL(reference, pathToFileURL(owner));
    if (url.protocol !== 'file:' || url.host) throw new Error(`External renderer asset is forbidden: ${reference}`);
    const filename = fileURLToPath(url);
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error(`Renderer asset missing: ${reference} (in ${path.relative(root, owner)})`);
    const real = fs.realpathSync(filename);
    const relative = path.relative(renderer, real);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Renderer asset escapes its directory: ${reference}`);
    if (visited.has(real)) return;
    visited.add(real); checked.push(real);
    if (path.extname(real).toLowerCase() === '.css') {
      const css = fs.readFileSync(real, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of css.matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/gi)) check(match[1] || match[2], real, true);
    }
  }
  const html = path.join(renderer, 'index.html');
  for (const tag of fs.readFileSync(html, 'utf8').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attributes = Object.fromEntries([...tag[2].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(match => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4]]));
    if (tag[1].toLowerCase() === 'script' && attributes.src) check(attributes.src, html);
    if (tag[1].toLowerCase() === 'link' && attributes.rel?.toLowerCase().split(/\s+/).includes('stylesheet')) {
      if (!attributes.href) throw new Error('Stylesheet link is missing href');
      check(attributes.href, html);
    }
  }
  return checked;
}
function build({sourceRoot = root, runSyntax = spawnSync, verifySpectrum = verifySpectrumDelivery, verifyClientRevision = verifySpectrumClientRevision} = {}) {
  // Fail before syntax subprocesses or any build action when a reviewed raw
  // policy/launcher asset is absent, linked, malformed or changed.
  const runtimeAssets = verifyRuntimeAssets(sourceRoot);
  const client = JSON.stringify(verifyClientRevision(sourceRoot));
  for (const directory of ['src/main', 'src/renderer', 'scripts']) {
    for (const filename of fs.readdirSync(path.join(sourceRoot, directory)).filter(file => file.endsWith('.js'))) {
      const result = runSyntax(process.execPath, ['--check', path.join(sourceRoot, directory, filename)], {stdio: 'inherit'});
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Syntax check failed: ${directory}/${filename}`);
    }
  }
  for (const file of ['src/main/entry.js', 'src/main/main.js', 'src/main/preload.js', 'src/main/settings.js', 'src/main/foobar.js', 'src/main/backend.js', 'src/main/playback-coordinator.js', 'src/main/library.js', 'src/main/lyrics.js', 'src/renderer/index.html', 'docs/foobar-install-restore.md', 'scripts/foobar-coreaudio-probe.exe', 'scripts/foobar-coreaudio-probe.cs']) {
    if (!fs.existsSync(path.join(sourceRoot, file))) throw new Error(`Required application file missing: ${file}`);
  }
  const assets = checkRendererAssets(path.join(sourceRoot, 'src/renderer'));
  // Validate only the reviewed policy JSON; no private backend is read here.
  loadBackendBaselines(sourceRoot);
  // Hash/PE checks only: never require a host module or execute the delivered reader.
  const spectrum = verifySpectrum(sourceRoot);
  if (JSON.stringify({clientSource: spectrum.clientSource, clientRevision: spectrum.clientRevision, clientHashes: spectrum.clientHashes}) !== client) throw new Error('Spectrum delivery differs from the verified client revision');
  if (!fs.readFileSync(path.join(sourceRoot, 'scripts', 'foobar-coreaudio-probe.exe')).subarray(0, 2).equals(Buffer.from('MZ'))) throw new Error('CoreAudio release probe is not a Windows executable');
  const appleHost = path.join(sourceRoot, 'native', 'apple-host', 'bin');
  for (const filename of ['StillAppleHost.exe', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll', 'official-bridge.js', 'WebView2-LICENSE.txt', 'WebView2-NOTICE.txt']) {
    if (!fs.statSync(path.join(appleHost, filename)).isFile()) throw new Error(`Official web host resource is missing: ${filename}`);
    if (/\.(exe|dll)$/.test(filename) && !fs.readFileSync(path.join(appleHost, filename)).subarray(0, 2).equals(Buffer.from('MZ'))) throw new Error(`Official web host resource is not a Windows executable: ${filename}`);
  }
  assertRuntimeAssetSnapshot(runtimeAssets, verifyRuntimeAssets(sourceRoot));
  if (JSON.stringify(verifyClientRevision(sourceRoot)) !== client) throw new Error('Spectrum client revision changed during build validation');
  console.log(`Application sources passed syntax and completeness checks (${assets.length} renderer assets; ${spectrum.applicationRuntimeFiles.length} reviewed spectrum runtime files).`);
  return {runtimeAssets};
}
if (require.main === module) {try {build();} catch (error) {console.error(error.message); process.exitCode = 1;}}
module.exports = {checkRendererAssets, build};
