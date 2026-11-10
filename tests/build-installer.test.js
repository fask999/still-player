'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {generatePayloadIncludes, nsisString, buildInstaller} = require('../scripts/build-installer');
const ROOT = path.resolve(__dirname, '..');

test('installer includes enumerate only exact paths and uninstall checks every path before its first delete', () => {
  const files = ['Still.exe', 'LICENSE', 'resources/app/src/main/entry.js', 'resources/app/node_modules/example/LICENSE'];
  const includes = generatePayloadIncludes('D:\\reviewed payload', files);
  assert.equal(includes.payload.match(/^File /gm).length, files.length);
  assert.equal(includes.payload.match(/kernel32::CopyFileW\([^\n]+i 1\) i\.r0/g).length, files.length);
  assert.match(includes.payload, /\$PLUGINSDIR\\STILL-payload\\payload-0000\.bin/);
  assert.equal(includes.uninstall.match(/^Delete /gm).length, files.length);
  assert.equal(includes.preflight.match(/^Call un.CheckNoReparse$/gm).length, files.length + 2);
  assert.equal(includes.preflight.match(/^Call un.CheckFileAvailable$/gm).length, files.length + 1);
  assert.doesNotMatch(includes.preflight, /^Delete |^RMDir /m);
  assert.doesNotMatch(includes.uninstall, /^RMDir /m);
  assert.equal(includes.uninstall.match(/^Call un.ReleasePublicProgramFence$/gm).length, files.length);
  assert.match(includes.executableMacro, /\$INSTDIR\\Still\.exe/);
  assert.match(includes.executableMacro, /\$LOCALAPPDATA\\STILL\\backend\\foobar2000\\foobar2000\.exe/);
  assert.doesNotMatch(includes.executableMacro, /Uninstall\.exe/);
  const statements = text => text.split(/\r?\n/).filter(line => !line.startsWith(';')).join('\n');
  assert.doesNotMatch(statements(includes.payload), /^File\s+\/r\b|[?*]/m);
  assert.doesNotMatch(statements(includes.uninstall), /RMDir\s+\/r\b|[?*]|\\(?:data|auth|profile)\\/i);
  assert.ok(includes.directories.indexOf('resources/app/src/main') < includes.directories.indexOf('resources/app'));
  assert.throws(() => generatePayloadIncludes('D:\\payload', ['Still.exe', 'still.exe']), /Invalid/);
  assert.throws(() => generatePayloadIncludes('D:\\payload', ['data/library.json']), /forbidden/);
  assert.throws(() => generatePayloadIncludes('D:\\payload', ['../outside.txt']), /Unsafe/);
});

test('installer uses per-user fixed path, explicit data retention, no automatic application or backend execution', () => {
  const script = fs.readFileSync(path.join(ROOT, 'installer/still.nsi'), 'utf8');
  assert.match(script, /^RequestExecutionLevel user$/m);
  assert.match(script, /\$\{AtLeastWin10\}/);
  assert.match(script, /InstallDir "\$LOCALAPPDATA\\Programs\\STILL"/);
  assert.match(script, /MUI_PAGE_DIRECTORY/);
  assert.match(script, /Function \.onInit[\s\S]*Call CheckExistingStillRegistration/);
  assert.match(script, /Function un\.onInit[\s\S]*Call un\.BindInstallReceipt/);
  assert.match(script, /GetFileAttributesW/); assert.match(script, /& 0x400/);
  assert.doesNotMatch(script, /^\s*GetFullPathName\b/m);
  assert.match(script, /GetFullPathNameW\(w r2, i \$\{NSIS_MAX_STRLEN\}, w\.r4, p 0\) i\.r0 \?e/);
  assert.match(script, /\$0 >= \$\{NSIS_MAX_STRLEN\}/);
  assert.match(script, /GetFileAttributesW\(w r2\) i\.r0 \?e'\r?\n\s+Pop \$1/);
  assert.doesNotMatch(script, /kernel32::GetLastError\(/);
  assert.match(script, /Call ValidateInstallDirectory/);
  assert.match(script, /SetOverwrite off/);
  assert.match(script, /WriteUninstaller "\$PLUGINSDIR\\STILL-Uninstall\.exe"/);
  assert.doesNotMatch(script, /WriteUninstaller "\$INSTDIR/);
  assert.doesNotMatch(script, /CreateShortcut "\$SMPROGRAMS/);
  assert.equal((script.match(/!insertmacro CopyNewFile /g) || []).length, 3);
  assert.match(script, /Function CheckNewFile[\s\S]*GetFileAttributesW[\s\S]*STILL_FATAL/);
  assert.doesNotMatch(script, /\b(?:Exec|ExecWait|ExecShell|RMDir \/r|File \/r)\b/);
  assert.doesNotMatch(script, /^\s*(?:WriteReg\w+|DeleteReg\w+) HKLM/m);
  assert.doesNotMatch(script, /^\s*(?:Delete|RMDir) "\$LOCALAPPDATA\\STILL/m);
  assert.match(script, /will be retained/);
  const section = script.slice(script.indexOf('Section "Uninstall"'));
  assert.ok(section.indexOf('${STILL_PREFLIGHT_INCLUDE}') < section.indexOf('Call un.AcquirePublicProgramFence'));
  assert.ok(section.indexOf('Call un.AcquirePublicProgramFence') < section.indexOf('Call un.PreserveRuntimeLog'));
  assert.ok(section.indexOf('Call un.PreserveRuntimeLog') < section.indexOf('${STILL_UNINSTALL_INCLUDE}'));
  assert.ok(section.indexOf('${STILL_UNINSTALL_INCLUDE}') < section.indexOf('${STILL_REMOVE_DIRECTORIES_INCLUDE}'));
  assert.match(section, /\$0 != 0\s+Call un\.ReleasePublicProgramFence[\s\S]*?Abort/);
  assert.doesNotMatch(section, /Delete[^\r\n]*debug\.log/i);
});

test('public non-UI installation strictly parses original arguments and only exits zero after postconditions', () => {
  const source = fs.readFileSync(path.join(ROOT, 'installer/nonui-install.nsh'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'installer/still.nsi'), 'utf8');
  assert.match(source, /GetCommandLineW/);
  assert.match(source, /StrCmpS \$1 "\/S"/);
  assert.match(source, /StrCmpS \$2 "\/D="/);
  assert.doesNotMatch(source, /GetParameters|GetOptions/);
  assert.match(source, /SetErrorLevel \$\{CODE\}\s+IfSilent 0 \+2\s+Quit\s+MessageBox/);
  assert.match(script, /Function \.onInit\s+Call ValidatePublicInstallArguments/);
  assert.match(script, /Call CheckWrittenInstallPostconditions\s+SetErrorLevel 0/);
  assert.match(script, /AllowSkipFiles off/);
  assert.doesNotMatch(generatePayloadIncludes('D:\\fixture', ['Still.exe']).payload, /MessageBox|\bAbort\b/);
});

test('selected directory and uninstaller identity retain data separation and reject another registered install', () => {
  const directory = fs.readFileSync(path.join(ROOT, 'installer/install-directory.nsh'), 'utf8');
  assert.match(directory, /GetLongPathNameW/);
  assert.match(directory, /StrCpy \$0 "\$STILL_FIXED_DATA_ROOT\\"/);
  assert.match(directory, /StrCpy \$2 "\$INSTDIR\\" \$1/);
  assert.match(directory, /StrCpy \$0 "\$INSTDIR\\"/);
  assert.match(directory, /StrCpy \$2 "\$STILL_FIXED_DATA_ROOT\\" \$1/);
  assert.match(directory, /RegOpenKeyExW/);
  assert.match(directory, /FindFirst[\s\S]*existing files/);
  assert.match(directory, /FileWriteUTF16LE/);
  assert.match(directory, /CopyFileW\([^\n]+INSTALL-RECEIPT\.ini[^\n]+i 1\)/);
  assert.match(directory, /\$INSTDIR != \$STILL_REGISTERED_LOCATION/);
  assert.match(directory, /GetFileInformationByHandle/);
  assert.match(directory, /CreateFileW\([^\n]+i 0x80000080, i 1/);
  assert.match(directory, /GetFinalPathNameByHandleW/);
  assert.match(directory, /\$0 != "\$INSTDIR\\INSTALL-RECEIPT\.ini"/);
  assert.match(directory, /\$1 != 1/);
  assert.match(directory, /StillBuildId/);
  assert.doesNotMatch(directory, /D:\\工具|D:\\foobar2000/);
});

test('NSIS quoting escapes compiler interpolation and invalid package fails before compiler execution', () => {
  assert.equal(nsisString('C:\\$USER\\"quote"'), 'C:\\$$USER\\$\\"quote$\\"');
  let ran = false;
  assert.throws(() => buildInstaller({packageDirectory: path.join(ROOT, 'does-not-exist'), outputDirectory: path.join(ROOT, 'dist/Still-public-installer-negative'), runCompiler: () => {ran = true;}}), /ENOENT/);
  assert.equal(ran, false); assert.equal(fs.existsSync(path.join(ROOT, 'dist/Still-public-installer-negative')), false);
});
