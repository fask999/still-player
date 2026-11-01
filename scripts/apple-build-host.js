'use strict';

// Build our own host against an explicitly supplied Microsoft WebView2 SDK.
// No downloads, installers, CDM handling or third-party client bundles here.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
function buildAppleHost({sdkDir, outputDir = path.join(root, 'native', 'apple-host', 'bin')} = {}) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The official Apple host build requires Windows x64');
  if (typeof sdkDir !== 'string' || !path.isAbsolute(sdkDir)) throw new Error('Pass --sdk-dir with an extracted official Microsoft.Web.WebView2 SDK package');
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const core = path.join(sdkDir, 'lib', 'net462', 'Microsoft.Web.WebView2.Core.dll');
  const forms = path.join(sdkDir, 'lib', 'net462', 'Microsoft.Web.WebView2.WinForms.dll');
  const loader = path.join(sdkDir, 'runtimes', 'win-x64', 'native', 'WebView2Loader.dll');
  for (const file of [compiler, core, forms, loader]) if (!fs.existsSync(file)) throw new Error(`Build input missing: ${path.basename(file)}`);
  fs.mkdirSync(outputDir, {recursive: true});
  const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${path.join(outputDir, 'StillAppleHost.exe')}`,
    '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    '/reference:System.Web.Extensions.dll', `/reference:${core}`, `/reference:${forms}`, path.join(root, 'native', 'apple-host', 'StillAppleHost.cs')],
  {encoding: 'utf8', windowsHide: true, timeout: 30000});
  if (result.error || result.status !== 0) throw new Error(`Official host compilation failed: ${result.error?.message || result.stdout || result.stderr}`);
  for (const file of [core, forms, loader]) fs.copyFileSync(file, path.join(outputDir, path.basename(file)));
  fs.copyFileSync(path.join(root, 'native', 'apple-host', 'official-bridge.js'), path.join(outputDir, 'official-bridge.js'));
  for (const name of fs.readdirSync(sdkDir).filter(file => /license|notice/i.test(file))) {
    const file = path.join(sdkDir, name); if (fs.statSync(file).isFile()) fs.copyFileSync(file, path.join(outputDir, `WebView2-${name}`));
  }
  return outputDir;
}
if (require.main === module) {
  try {const index = process.argv.indexOf('--sdk-dir'); console.log(buildAppleHost({sdkDir: index < 0 ? undefined : process.argv[index + 1]}));}
  catch (error) {console.error(error.message); process.exitCode = 1;}
}
module.exports = {buildAppleHost};
