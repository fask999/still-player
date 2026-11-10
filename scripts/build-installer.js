'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {ROOT, HASH, assertPublicPath, assertNoLinks, regularBytes, walkFiles, sha256, verifyPublicPackage, validateOutput} = require('./package-public');
const NSIS_MANIFEST = 'installer/nsis-toolchain.json';
const INSTALLER_SOURCE = 'installer/still.nsi';
const LOG_HELPER_SOURCE = 'installer/preserve-runtime-log.nsh';
const DIRECTORY_HELPER_SOURCE = 'installer/install-directory.nsh';
const NONUI_HELPER_SOURCE = 'installer/nonui-install.nsh';
const nsisString = value => value.replaceAll('$', () => '$$').replaceAll('"', '$\\"').replaceAll('\r', '').replaceAll('\n', '');
function generatePayloadIncludes(packageDirectory, files) {
  const names = [...files].sort();
  if (!names.length || new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('Invalid installer file list');
  names.forEach(assertPublicPath);
  const directories = new Set();
  for (const name of names) {
    for (let directory = path.posix.dirname(name); directory !== '.'; directory = path.posix.dirname(directory)) directories.add(directory);
  }
  const asWindows = value => nsisString(value.replaceAll('/', '\\'));
  const payload = ['; -*- coding: utf-8 -*-', '; Generated exact public payload. CopyFileW atomically refuses an existing destination.'];
  let previousDirectory;
  for (const [index, name] of names.entries()) {
    const directory = path.posix.dirname(name), targetDirectory = directory === '.' ? '$INSTDIR' : `$INSTDIR\\${asWindows(directory)}`;
    if (directory !== previousDirectory) {
      payload.push(`Push "${targetDirectory}"`, 'Call CheckNoReparse', 'ClearErrors', `CreateDirectory "${targetDirectory}"`, '${If} ${Errors}',
        '!insertmacro STILL_FATAL "" 24 "The installation directory could not be created. No existing application data was changed."', '${EndIf}');
      previousDirectory = directory;
    }
    const temporary = `$PLUGINSDIR\\STILL-payload\\payload-${String(index).padStart(4, '0')}.bin`, destination = `$INSTDIR\\${asWindows(name)}`;
    for (const leaf of [temporary, destination]) payload.push(`Push "${leaf}"`, 'Call CheckNoReparse',
      `System::Call 'kernel32::GetFileAttributesW(w "${leaf}") i.r0'`, '${If} $0 != -1',
      '!insertmacro STILL_FATAL "" 23 "A setup destination already exists. It will not be overwritten. Close setup and preserve the conflicting file."', '${EndIf}');
    payload.push('ClearErrors', `File /oname=payload-${String(index).padStart(4, '0')}.bin "${nsisString(path.join(packageDirectory, name))}"`, '${If} ${Errors}',
      '!insertmacro STILL_FATAL "" 24 "A packaged file could not be extracted. Setup did not overwrite an existing destination."', '${EndIf}',
      `Push "${temporary}"`, 'Call CheckNoReparse', `Push "${destination}"`, 'Call CheckNoReparse',
      `System::Call 'kernel32::CopyFileW(w "${temporary}", w "${destination}", i 1) i.r0'`, '${If} $0 == 0',
      '!insertmacro STILL_FATAL "" 24 "A setup file could not be created, or a destination appeared while setup was running. Existing files will not be overwritten."', '${EndIf}');
  }
  const preflight = ['; -*- coding: utf-8 -*-', '; Complete preflight before the program fence, log preservation, or any deletion.'];
  const uninstall = ['; -*- coding: utf-8 -*-', '; Generated exact installed-file removal. User data is outside $INSTDIR.'];
  // Preflight the complete list before removal; unknown entries are untouched.
  for (const name of ['Uninstall.exe', 'INSTALL-RECEIPT.ini', ...names]) preflight.push(`Push "$INSTDIR\\${asWindows(name)}"`, 'Call un.CheckNoReparse');
  for (const name of ['INSTALL-RECEIPT.ini', ...names]) preflight.push(`Push "$INSTDIR\\${asWindows(name)}"`, 'Call un.CheckFileAvailable');
  for (const name of names) uninstall.push('ClearErrors', `Delete "$INSTDIR\\${asWindows(name)}"`, '${If} ${Errors}',
    'Call un.ReleasePublicProgramFence', 'MessageBox MB_OK|MB_ICONSTOP "Close STILL before uninstalling. Some application files could not be removed; your data is retained."', 'Abort', '${EndIf}');
  const deepestFirst = [...directories].sort((a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a, 'en'));
  const removeDirectories = deepestFirst.map(directory => `RMDir "$INSTDIR\\${asWindows(directory)}"`);
  const publicExecutables = names.filter(name => /\.exe$/i.test(name) && path.posix.basename(name).toLowerCase() !== 'uninstall.exe');
  const executableMacro = ['; -*- coding: utf-8 -*-', '!macro STILL_PUBLIC_EXECUTABLES ACTION',
    ...publicExecutables.map(name => '!insertmacro ${ACTION} "$INSTDIR\\' + asWindows(name) + '"'),
    '!insertmacro ${ACTION} "$LOCALAPPDATA\\STILL\\backend\\foobar2000\\foobar2000.exe"', '!macroend'];
  return {payload: `${payload.join('\r\n')}\r\n`, preflight: `${preflight.join('\r\n')}\r\n`, uninstall: `${uninstall.join('\r\n')}\r\n`,
    removeDirectories: `${removeDirectories.join('\r\n')}\r\n`, executableMacro: `${executableMacro.join('\r\n')}\r\n`, publicExecutables, files: names, directories: deepestFirst};
}
function loadToolchain(sourceRoot, compilerPath) {
  const bytes = regularBytes(sourceRoot, NSIS_MANIFEST), manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || manifest.version !== '3.13' || manifest.source !== 'https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13.zip/download' ||
      !HASH.test(manifest.archiveSha256) || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid reviewed NSIS toolchain');
  const compiler = assertNoLinks(compilerPath), toolRoot = path.dirname(compiler);
  if (path.basename(compiler).toLowerCase() !== 'makensis.exe' || !manifest.files.some(item => item.path === 'makensis.exe')) throw new Error('Expected the reviewed NSIS compiler');
  const actual = walkFiles(toolRoot), expected = manifest.files.map(item => item.path);
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error('Unknown or missing NSIS toolchain file');
  for (const item of manifest.files) {
    assertPublicPath(item.path);
    const file = regularBytes(toolRoot, item.path);
    if (!HASH.test(item.sha256) || item.bytes !== file.length || sha256(file) !== item.sha256) throw new Error(`NSIS toolchain integrity mismatch: ${item.path}`);
  }
  return {compiler, toolRoot, manifest, manifestSha256: sha256(bytes)};
}
function buildInstaller({sourceRoot = ROOT, packageDirectory, outputDirectory, compilerPath = path.join(sourceRoot, 'tools/nsis-3.13/nsis-3.13/makensis.exe'), runCompiler = spawnSync} = {}) {
  if (!packageDirectory || !outputDirectory) throw new Error('Installer requires a verified package and fresh output directory');
  const info = verifyPublicPackage(packageDirectory, {sourceRoot}), output = validateOutput(sourceRoot, outputDirectory);
  const toolchain = loadToolchain(sourceRoot, compilerPath), installerBytes = regularBytes(sourceRoot, INSTALLER_SOURCE), logHelperBytes = regularBytes(sourceRoot, LOG_HELPER_SOURCE), directoryHelperBytes = regularBytes(sourceRoot, DIRECTORY_HELPER_SOURCE);
  const nonUiHelperBytes = regularBytes(sourceRoot, NONUI_HELPER_SOURCE);
  const installBuildId = sha256(Buffer.from([info.sourceSnapshotSha256, sha256(installerBytes), sha256(logHelperBytes), sha256(directoryHelperBytes), sha256(nonUiHelperBytes), toolchain.manifestSha256].join('\n')));
  const packageFiles = [...Object.keys(info.files), 'BUILD-INFO.json', 'BUILD-INFO.sha256'];
  const includes = generatePayloadIncludes(path.resolve(packageDirectory), packageFiles), filename = `STILL-${info.version}-Setup-x64.exe`;
  fs.mkdirSync(path.dirname(output), {recursive: true}); assertNoLinks(path.dirname(output)); fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'INSTALLER-INCOMPLETE'), 'Installer build incomplete; do not distribute.\n', {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'payload.nsh'), includes.payload, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'preflight.nsh'), includes.preflight, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'uninstall.nsh'), includes.uninstall, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'remove-directories.nsh'), includes.removeDirectories, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'executables.nsh'), includes.executableMacro, {flag: 'wx'});
  const plan = `; -*- coding: utf-8 -*-\r\n!define STILL_VERSION "${info.version}"\r\n!define STILL_INSTALL_BUILD_ID "${installBuildId}"\r\n!define STILL_OUTPUT "${nsisString(path.join(output, filename))}"\r\n!define STILL_PAYLOAD_INCLUDE "${nsisString(path.join(output, 'payload.nsh'))}"\r\n!define STILL_PREFLIGHT_INCLUDE "${nsisString(path.join(output, 'preflight.nsh'))}"\r\n!define STILL_UNINSTALL_INCLUDE "${nsisString(path.join(output, 'uninstall.nsh'))}"\r\n!define STILL_REMOVE_DIRECTORIES_INCLUDE "${nsisString(path.join(output, 'remove-directories.nsh'))}"\r\n!define STILL_EXECUTABLES_INCLUDE "${nsisString(path.join(output, 'executables.nsh'))}"\r\n!define STILL_LOG_HELPER_INCLUDE "${nsisString(path.join(sourceRoot, LOG_HELPER_SOURCE))}"\r\n!define STILL_DIRECTORY_HELPER_INCLUDE "${nsisString(path.join(sourceRoot, DIRECTORY_HELPER_SOURCE))}"\r\n!include "${nsisString(path.join(sourceRoot, INSTALLER_SOURCE))}"\r\n`;
  const nonUiDefinition = '!define STILL_NONUI_HELPER_INCLUDE "' + nsisString(path.join(sourceRoot, NONUI_HELPER_SOURCE)) + '"\r\n';
  fs.writeFileSync(path.join(output, 'compile.nsi'), nonUiDefinition + plan, {flag: 'wx'});
  // No ambient nsisconf.nsh, shell evaluation, compiler installation, automatic
  // app launch, or foobar installer invocation is permitted here.
  const result = runCompiler(toolchain.compiler, ['/NOCONFIG', '/INPUTCHARSET', 'UTF8', '/V3', path.join(output, 'compile.nsi')], {cwd: output, encoding: 'utf8', windowsHide: true, env: {...process.env, NSISDIR: toolchain.toolRoot}, maxBuffer: 16 * 1024 * 1024});
  fs.writeFileSync(path.join(output, 'compiler.log'), `${result.stdout || ''}${result.stderr || ''}`, {flag: 'wx'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`NSIS failed with exit status ${result.status}; incomplete output retained`);
  const artifact = regularBytes(output, filename);
  if (artifact.length < 1024 || artifact.readUInt16LE(0) !== 0x5a4d) throw new Error('NSIS did not produce a Windows installer');
  const after = verifyPublicPackage(packageDirectory, {sourceRoot});
  if (JSON.stringify(after) !== JSON.stringify(info) || sha256(regularBytes(sourceRoot, INSTALLER_SOURCE)) !== sha256(installerBytes) || sha256(regularBytes(sourceRoot, LOG_HELPER_SOURCE)) !== sha256(logHelperBytes) || sha256(regularBytes(sourceRoot, DIRECTORY_HELPER_SOURCE)) !== sha256(directoryHelperBytes)) throw new Error('Installer input changed during compilation');
  if (sha256(regularBytes(sourceRoot, NONUI_HELPER_SOURCE)) !== sha256(nonUiHelperBytes)) throw new Error('Non-UI installer input changed during compilation');
  const toolAfter = loadToolchain(sourceRoot, compilerPath);
  if (toolAfter.manifestSha256 !== toolchain.manifestSha256) throw new Error('NSIS toolchain changed during compilation');
  const artifactHash = sha256(artifact), packageHash = sha256(regularBytes(packageDirectory, 'BUILD-INFO.json'));
  const record = {schemaVersion: 1, version: info.version, platform: 'win32', arch: 'x64', installer: {file: filename, bytes: artifact.length, sha256: artifactHash, unsigned: true, bootstrapArchitecture: 'x86-unicode', payloadArchitecture: 'x64'},
    nonUiHelperSourceSha256: sha256(nonUiHelperBytes),
    packageBuildInfoSha256: packageHash, sourceSnapshotSha256: info.sourceSnapshotSha256, installBuildId, installerSourceSha256: sha256(installerBytes), logPreservationSourceSha256: sha256(logHelperBytes), directoryHelperSourceSha256: sha256(directoryHelperBytes), compiler: {version: toolchain.manifest.version, manifestSha256: toolchain.manifestSha256, archiveSha256: toolchain.manifest.archiveSha256},
    fileList: includes.files, publicExecutableResources: includes.publicExecutables, generatedInputHashes: Object.fromEntries(['compile.nsi', 'payload.nsh', 'preflight.nsh', 'uninstall.nsh', 'remove-directories.nsh', 'executables.nsh'].map(file => [file, sha256(regularBytes(output, file))])),
    installScope: 'current-user', defaultInstallDirectory: '%LOCALAPPDATA%\\Programs\\STILL', installDirectory: 'User-selected dedicated absolute local directory; receipt and per-user registration bound', generatedInstalledFiles: ['Uninstall.exe', 'INSTALL-RECEIPT.ini'], preservedDataDirectory: '%LOCALAPPDATA%\\STILL', upgrade: 'Uninstall the registered previous application version first; retain data',
    validation: {compiled: true, payloadHashesVerified: true, interactiveInstallation: 'unrun', interactiveUninstallation: 'unrun', firstRunBackend: 'unrun', realPlayback: 'unrun', signature: 'unsigned'}};
  fs.writeFileSync(path.join(output, 'INSTALLER-INFO.json'), `${JSON.stringify(record, null, 2)}\n`, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${artifactHash}  ${filename}\n${sha256(regularBytes(output, 'INSTALLER-INFO.json'))}  INSTALLER-INFO.json\n`, {flag: 'wx'});
  fs.unlinkSync(path.join(output, 'INSTALLER-INCOMPLETE'));
  return {outputDirectory: output, artifactPath: path.join(output, filename), record};
}
function main(args = process.argv.slice(2)) {
  if (args.length !== 4 || args[0] !== '--package' || args[2] !== '--output') throw new Error('Usage: node scripts/build-installer.js --package dist/Still-public-<package> --output dist/Still-public-<installer>');
  const result = buildInstaller({packageDirectory: path.resolve(ROOT, args[1]), outputDirectory: path.resolve(ROOT, args[3])});
  process.stdout.write(`Unsigned installer built: ${result.artifactPath}\nSHA256: ${result.record.installer.sha256}\n`);
}
if (require.main === module) {try {main();} catch (error) {process.stderr.write(`${error.message}\n`); process.exitCode = 1;}}
module.exports = {NSIS_MANIFEST, INSTALLER_SOURCE, LOG_HELPER_SOURCE, DIRECTORY_HELPER_SOURCE, NONUI_HELPER_SOURCE, nsisString, generatePayloadIncludes, loadToolchain, buildInstaller, main};
