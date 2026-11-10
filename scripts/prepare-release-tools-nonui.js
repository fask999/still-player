'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const {sha256} = require(path.join(root, 'scripts/package-public'));
const {loadToolchain, nsisString, generatePayloadIncludes} = require(path.join(root, 'scripts/build-installer'));
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n');
const main = source('installer/still.nsi'), directory = source('installer/install-directory.nsh'), nonui = source('installer/nonui-install.nsh');
function block(text, start, end) {const a = text.indexOf(start), b = text.indexOf(end, a); if (a < 0 || b < 0) throw new Error(start); return text.slice(a, b + end.length);}
const fn = (text, name) => block(text, 'Function ' + name + '\n', '\nFunctionEnd');
const macro = (text, name) => block(text, '!macro ' + name + ' ', '\n!macroend');
const dest = path.join(root, 'tools/release-ci/nonui-fixture'); fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.mkdirSync(dest);
const defaultTarget = path.join(dest, 'default-target');
const vars = directory.match(/^Var \w+$/gm).concat(['Var STILL_PATH_GUARD_MESSAGE', 'Var FIXTURE_CONFLICT', 'Var FIXTURE_TAMPER', 'Var FIXTURE_COLLISION', 'Var FIXTURE_ID']);
const canaryNonui = nonui.replace(/MessageBox MB_OK\|MB_ICONSTOP "[^\n]*"\n\s*Abort/g, 'SetErrorLevel 98\n    Quit');
if (canaryNonui.includes('MessageBox')) throw new Error('Native fixture must replace the UI branch with an exit-98 canary');
const guard = macro(main, 'ReparseGuard');
const canonical = macro(directory, 'CanonicalFuturePath');
let safety = macro(directory, 'DirectorySafety').replaceAll('"$LOCALAPPDATA\\STILL"', '"' + nsisString(path.join(dest, 'data-root')) + '"');
const fakeRegistration = ['Function CheckExistingStillRegistration', '  ${If} $FIXTURE_CONFLICT == "1"', '    !insertmacro STILL_FATAL "" 22 "Isolated existing-registration conflict"', '  ${EndIf}', 'FunctionEnd'].join('\n');
let post = fn(directory, 'CheckWrittenInstallPostconditions');
post = post.replace(/^\s*ReadRegStr (\$[012]) HKCU "[^\n]+" "(InstallLocation|StillReceiptId|StillBuildId)"$/gm, (_all, variable, field) => '  StrCpy ' + variable + ' ' + ({InstallLocation: '"$INSTDIR"', StillReceiptId: '"$STILL_INSTALL_RECEIPT_ID"', StillBuildId: '"${STILL_INSTALL_BUILD_ID}"'}[field]));
post = post.replace('  ${If} ${Errors}', '  ${If} $FIXTURE_TAMPER == "1"\n    StrCpy $2 "WRONG-BUILD"\n  ${EndIf}\n  ${If} ${Errors}');
fs.writeFileSync(path.join(dest, 'payload.txt'), 'ISOLATED NATIVE FIXTURE PAYLOAD');
const generated = generatePayloadIncludes(dest, ['payload.txt']);
fs.writeFileSync(path.join(dest, 'payload.nsh'), generated.payload);
const lines = [
  'Unicode true', 'RequestExecutionLevel user', 'CRCCheck force', 'Name "STILL isolated non-UI fixture"', 'OutFile "' + nsisString(path.join(dest, 'fixture setup.exe')) + '"',
  'InstallDir "' + nsisString(defaultTarget) + '"', '!define STILL_VERSION "1.1.0"', '!define STILL_INSTALL_BUILD_ID "' + 'b'.repeat(64) + '"', '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
  ...vars, canaryNonui, guard, '!insertmacro ReparseGuard ""', canonical, '!insertmacro CanonicalFuturePath ""', macro(directory, 'RejectProgramTree'), macro(directory, 'RejectProgramExact'), safety, '!insertmacro DirectorySafety ""',
  fakeRegistration, fn(directory, 'ValidateInstallDirectory'), fn(main, 'CheckNewFile'), macro(main, 'CopyNewFile'), fn(directory, 'WriteInstallReceipt'), post,
  'Function .onInit', '  Call ValidatePublicInstallArguments', '  IfSilent fixture_silent_ok', '    SetSilent silent', '    SetErrorLevel 99', '    Quit', 'fixture_silent_ok:',
  '  ReadEnvStr $FIXTURE_CONFLICT "STILL_NCI_CONFLICT"', '  ReadEnvStr $FIXTURE_TAMPER "STILL_NCI_TAMPER"', '  ReadEnvStr $FIXTURE_COLLISION "STILL_NCI_COLLISION"', '  Call CheckExistingStillRegistration', 'FunctionEnd',
  'Section "Isolated metadata/payload fixture"', '  Call ValidateInstallDirectory', '  InitPluginsDir', '  CreateDirectory "$PLUGINSDIR\\STILL-payload"', '  SetOutPath "$PLUGINSDIR\\STILL-payload"', '  SetOverwrite off', '  AllowSkipFiles off',
  '  ${If} $FIXTURE_COLLISION == "1"', '    CreateDirectory "$INSTDIR"', '    FileOpen $0 "$INSTDIR\\payload.txt" w', '    FileWrite $0 "KEEP-COLLISION"', '    FileClose $0', '  ${EndIf}',
  '!include "' + nsisString(path.join(dest, 'payload.nsh')) + '"', '  Call WriteInstallReceipt', '  Call CheckWrittenInstallPostconditions', '  SetErrorLevel 0', 'SectionEnd'
];
const nsi = lines.join('\n');
if (/\b(?:MessageBox|Exec|ExecWait|ExecShell|ReadRegStr|WriteRegStr|RegOpenKeyExW|CreateShortcut|WriteUninstaller)\b/.test(nsi)) throw new Error('Fixture has a forbidden live/GUI/registry operation');
fs.writeFileSync(path.join(dest, 'fixture.nsi'), nsi);
const tool = loadToolchain(root, path.join(root, 'tools/nsis-3.13/nsis-3.13/makensis.exe'));
const result = spawnSync(tool.compiler, ['/NOCONFIG', '/INPUTCHARSET', 'UTF8', '/V3', path.join(dest, 'fixture.nsi')], {encoding: 'utf8', windowsHide: true, env: {...process.env, NSISDIR: tool.toolRoot}});
fs.writeFileSync(path.join(dest, 'compiler.log'), (result.stdout || '') + (result.stderr || ''));
if (result.error) throw result.error;
if (result.status !== 0) throw new Error((result.stdout || '') + (result.stderr || ''));
const record = {directory: dest, defaultTarget, exe: path.join(dest, 'fixture setup.exe'), fixtureSourceSha256: sha256(Buffer.from(nsi)), fixtureExeSha256: sha256(fs.readFileSync(path.join(dest, 'fixture setup.exe'))),
  productionSourceHashes: Object.fromEntries(['installer/still.nsi', 'installer/install-directory.nsh', 'installer/nonui-install.nsh'].map(file => [file, sha256(fs.readFileSync(path.join(root, file)))])),
  scope: 'No public installer or uninstaller executed; no UI calls or registry API. Real command line, directory guards, CopyNew, UTF16 receipt and postcondition code with fake registration reads; UI branch exit98 canary.', executed: false};
fs.writeFileSync(path.join(dest, 'prepared.json'), JSON.stringify(record, null, 2) + '\n');
process.stdout.write(JSON.stringify(record) + '\n');
