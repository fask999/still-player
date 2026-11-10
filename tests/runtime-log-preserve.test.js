'use strict';
require('./helpers/test-effect-guard.cjs').installTestEffectGuard();
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../installer/preserve-runtime-log.nsh'), 'utf8');
const body = name => {
  const match = source.match(new RegExp(`Function un\\.${name}\\r?\\n([\\s\\S]*?)FunctionEnd`));
  assert.ok(match, `missing function ${name}`);
  return match[1];
};
const log = body('PreserveRuntimeLog');
const statements = source.split(/\r?\n/).filter(line => !line.trimStart().startsWith(';')).join('\n');

test('log preservation only accepts its fixed exact source and creates a new unique destination', () => {
  assert.match(log, /GetFullPathNameW\(w "\$INSTDIR\\debug\.log"/);
  assert.match(log, /GetFullPathNameW\(w "\$LOCALAPPDATA\\STILL\\logs"/);
  assert.match(log, /CoCreateGuid/);
  assert.match(log, /CreateFileW\(w r5, i 0x40010080, i 0, p 0, i 1, i 0x00200000/);
  assert.doesNotMatch(statements, /\b(?:CopyFile\w*|MoveFile\w*|Rename|DeleteFile\w*|ReadFileText|FileRead|FileWrite|FindFirst\w*|FindNext\w*)\b/);
  assert.doesNotMatch(log, /\b(?:Exch|Exec|ExecWait|ExecShell)\b/);
});

test('source is exclusively held, ordinary, single linked and bounded before copying opaque bytes', () => {
  assert.match(log, /CreateFileW\(w r8, i 0x80010080, i 0, p 0, i 3, i 0x00200000/);
  assert.match(log, /GetFileType\(p r0\)/);
  assert.equal((log.match(/\$R4 & 0xFFFFFF5F/g) || []).length, 4);
  assert.ok(log.indexOf('$R4 & 0xFFFFFF5F') < log.indexOf('kernel32::ReadFile'));
  assert.match(log, /\$R5 != 1/);
  assert.ok(log.indexOf('$R8 > 67108864') < log.indexOf('kernel32::ReadFile'));
  assert.match(log, /ReadFile\(p r0, p r3, i 65536, \*i\.R5, p 0\)/);
  assert.match(log, /WriteFile\(p \$STILL_LOG_TARGET_HANDLE, p r3, i R5, \*i\.R2, p 0\)/);
  assert.match(log, /\$R2 != \$R5/);
  assert.match(log, /\$R7 != \$R8/);
});

test('named or unknown data streams are refused before copying and again before deletion commit', () => {
  assert.match(source, /GetFileInformationByHandleEx\(p r0, i 7, p r3, i 65536\)/);
  assert.match(source, /\*\$3\(i\.r6, i\.r7, &v16, &w7\.R6\)/);
  assert.match(source, /\$6 != 0[\s\S]*\$7 != 14[\s\S]*\$R6 != "::\$\$DATA"/);
  assert.equal((log.match(/!insertmacro STILL_LOG_REQUIRE_DEFAULT_STREAM/g) || []).length, 2);
  assert.ok(log.indexOf('!insertmacro STILL_LOG_REQUIRE_DEFAULT_STREAM') < log.indexOf('kernel32::ReadFile'));
  assert.ok(log.lastIndexOf('!insertmacro STILL_LOG_REQUIRE_DEFAULT_STREAM') < log.indexOf('kernel32::FlushFileBuffers'));
  assert.doesNotMatch(source, /(?:MessageBox|DetailPrint|PRESERVE_MESSAGE)[^\r\n]*\$R6/);
});

test('every directory ancestor uses a real read access lock, denies write and delete sharing, and verifies its handle path', () => {
  assert.equal((log.match(/CreateFileW\(w r5, i 0x81, i 1, p 0, i 3, i 0x02200000/g) || []).length, 2);
  assert.match(log, /\$R4 != 16/);
  assert.match(log, /GetFinalPathNameByHandleW\(p r1/);
  assert.match(log, /\$R6 != "\\\\\?\\\$5"/);
  assert.ok(log.indexOf('System::Store "s"') > log.indexOf('Call un.CheckNoReparse'));
  assert.match(log, /\$5 != \$9[\s\S]*\$5 != \$6[\s\S]*CreateDirectoryW/);
});

test('both original file identities, lengths and link counts are rechecked before durable-copy commit', () => {
  const verify = log.slice(log.indexOf('still_log_verify_copy:'));
  assert.equal((verify.match(/GetFileInformationByHandle/g) || []).length, 2);
  assert.equal((verify.match(/\$R5 != 1/g) || []).length, 2);
  assert.equal((verify.match(/\$7 != \$R8/g) || []).length, 2);
  assert.equal((verify.match(/&v28, i\.r6, &v12, i\.r7, i\.R5/g) || []).length, 2);
  assert.equal((verify.match(/\$R5 != \$R7/g) || []).length, 2);
  const flush = verify.indexOf('kernel32::FlushFileBuffers');
  const removeSource = verify.indexOf('SetFileInformationByHandle(p r0, i 4, p r2, i 1)');
  assert.ok(flush > verify.lastIndexOf('GetFileInformationByHandle') && removeSource > flush);
  assert.ok(verify.indexOf('StrCpy $STILL_LOG_COPY_COMMITTED 1') > removeSource);
});

test('failures clean only the original target handle and report post-commit outcomes accurately', () => {
  const cleanup = log.slice(log.indexOf('still_log_cleanup:'));
  assert.match(cleanup, /\$STILL_LOG_COPY_COMMITTED != 1[\s\S]*SetFileInformationByHandle\(p \$STILL_LOG_TARGET_HANDLE, i 4, p r2, i 1\)/);
  assert.match(cleanup, /CloseHandle\(p r0\)/);
  assert.match(cleanup, /CloseHandle\(p \$STILL_LOG_TARGET_HANDLE\)/);
  assert.match(cleanup, /\$R0 > 0[\s\S]*Pop \$5/);
  assert.match(cleanup, /\$R1 > 0[\s\S]*CloseHandle\(p r1\)/);
  assert.match(cleanup, /System::Free \$4[\s\S]*System::Free \$3[\s\S]*System::Free \$2[\s\S]*System::Store "l"[\s\S]*Push \$STILL_LOG_PRESERVE_STATUS/);
  assert.match(log, /preserved log is complete at \$5, but Windows could not confirm closing/);
});

test('program fence uses Restart Manager before and after persistent deny-read image locks without terminating processes', () => {
  const acquire = body('AcquirePublicProgramFence');
  assert.match(source, /CreateFileW\(w "\$\{EXE\}", i 0x80000080, i 4, p 0, i 3, i 0x00200000/);
  assert.equal((acquire.match(/Call un.CheckPublicProgramFenceUsers/g) || []).length, 2);
  const first = acquire.indexOf('Call un.CheckPublicProgramFenceUsers');
  const locks = acquire.indexOf('!insertmacro STILL_PUBLIC_EXECUTABLES STILL_FENCE_LOCK');
  const second = acquire.lastIndexOf('Call un.CheckPublicProgramFenceUsers');
  assert.ok(first < locks && locks < second);
  assert.match(acquire, /still_fence_fail:[\s\S]*StrCpy \$STILL_PROGRAM_FENCE_STATUS 1[\s\S]*Call un.ReleasePublicProgramFence/);
  assert.doesNotMatch(statements, /(?:TerminateProcess|RmShutdown|RmRestart|taskkill|Stop-Process)/i);
});

test('Restart Manager parses bounded process records, preserves in/out counts, and exempts only the live caller PID', () => {
  const users = body('CheckPublicProgramFenceUsers');
  assert.match(users, /\*i 0 R1/);
  assert.match(users, /\*i R0 R1/);
  assert.doesNotMatch(users, /\*i (?:0|R0)\.R1/);
  assert.match(users, /\$R0 > 1024/);
  assert.match(users, /\$R1 > \$R0/);
  assert.match(users, /\$R4 \* 668/);
  assert.match(users, /GetCurrentProcessId\(\) i\.R7/);
  assert.match(users, /\$R6 != \$R7[\s\S]*Goto still_fence_users_done/);
  assert.match(users, /System::Free \$R3[\s\S]*System::Store "l"/);
});

test('release closes every fence handle and Restart Manager session while keeping the NSIS stack balanced', () => {
  const release = body('ReleasePublicProgramFence');
  assert.match(release, /\$STILL_PROGRAM_FENCE_COUNT > 0[\s\S]*CloseHandle/);
  assert.match(release, /\$STILL_PROGRAM_FENCE_RESOURCE_COUNT > 0[\s\S]*System::Free \$0/);
  assert.match(release, /RmEndSession/);
  assert.match(release, /StrCpy \$STILL_PROGRAM_FENCE_ACTIVE 0/);
  assert.match(release, /System::Store "s"[\s\S]*System::Store "l"/);
  assert.doesNotMatch(release, /^\s*(?:Push|Pop)\b/m);
});
