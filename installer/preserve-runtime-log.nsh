; Exact, opaque preservation of Chromium's optional application log.
; Caller contract: finish the public-program/payload availability preflight,
; Call un.PreserveRuntimeLog, Pop status. A nonzero status MUST abort before
; deleting any payload and display $STILL_LOG_PRESERVE_MESSAGE.
; No arguments, wildcard enumeration, parsing/output of bytes, or overwrite.
; One bounded copy protocol supports both same-volume and cross-volume installs.
!ifndef STILL_PRESERVE_RUNTIME_LOG_INCLUDED
!define STILL_PRESERVE_RUNTIME_LOG_INCLUDED
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!if ${NSIS_PTR_SIZE} != 4
  !error "Runtime-log preservation requires the reviewed x86 Unicode NSIS ABI"
!endif
!ifndef NSIS_UNICODE
  !error "Runtime-log preservation requires Unicode NSIS"
!endif

Var STILL_LOG_PRESERVE_MESSAGE
Var STILL_LOG_PRESERVE_STATUS
Var STILL_LOG_TARGET_HANDLE
Var STILL_LOG_COPY_COMMITTED

; Metadata-only FILE_STREAM_INFO: reject every named/unknown stream rather
; than deleting bytes this main-stream copy would not preserve. A bounded
; query failure also rejects the source. Stream names are never displayed.
!macro STILL_LOG_REQUIRE_DEFAULT_STREAM
  System::Call 'kernel32::GetFileInformationByHandleEx(p r0, i 7, p r3, i 65536) i.r6'
  ${If} $6 == 0
    StrCpy $STILL_LOG_PRESERVE_MESSAGE "Cannot verify the complete stream layout of debug.log. Retain it manually before retrying; no application files have been removed."
    Goto still_log_cleanup
  ${EndIf}
  ; NextEntryOffset@0, StreamNameLength@4, StreamName@24. Only ::$DATA
  ; (seven UTF-16 code units, 14 bytes), with no following entry, is accepted.
  System::Call '*$3(i.r6, i.r7, &v16, &w7.R6)'
  ${If} $6 != 0
  ${OrIf} $7 != 14
  ${OrIf} $R6 != "::$$DATA"
    StrCpy $STILL_LOG_PRESERVE_MESSAGE "debug.log has additional or unknown streams. Retain the complete file manually before retrying; no application files have been removed."
    Goto still_log_cleanup
  ${EndIf}
!macroend

; The generated, reviewed executable list excludes the running uninstaller.
; Acquire returns one status; Release returns nothing and is safe after failure.
; Only a successful Acquire may precede log preservation / payload deletion.
Var STILL_PROGRAM_FENCE_MESSAGE
Var STILL_PROGRAM_FENCE_STATUS
Var STILL_PROGRAM_FENCE_SESSION
Var STILL_PROGRAM_FENCE_ACTIVE
Var STILL_PROGRAM_FENCE_HANDLES
Var STILL_PROGRAM_FENCE_COUNT
Var STILL_PROGRAM_FENCE_RESOURCES
Var STILL_PROGRAM_FENCE_RESOURCE_COUNT

!macro STILL_FENCE_GUARD EXE
  Push "${EXE}"
  Call un.CheckNoReparse
!macroend

!macro STILL_FENCE_REGISTER EXE
  System::Call '*(&w${NSIS_MAX_STRLEN} "${EXE}") p.r0'
  ${If} $0 == 0
    Goto still_fence_fail
  ${EndIf}
  IntOp $1 $STILL_PROGRAM_FENCE_RESOURCE_COUNT * 4
  IntOp $1 $STILL_PROGRAM_FENCE_RESOURCES + $1
  System::Call '*$1(p r0)'
  IntOp $STILL_PROGRAM_FENCE_RESOURCE_COUNT $STILL_PROGRAM_FENCE_RESOURCE_COUNT + 1
!macroend

!macro STILL_FENCE_LOCK EXE
  ; Read permission makes Windows enforce deny-read sharing for image opens.
  ; No file contents are read. DELETE sharing allows the exact later Delete.
  System::Call 'kernel32::CreateFileW(w "${EXE}", i 0x80000080, i 4, p 0, i 3, i 0x00200000, p 0) p.r0 ?e'
  Pop $7
  ${If} $0 == -1
    ${If} $7 != 2
    ${AndIf} $7 != 3
      Goto still_fence_fail
    ${EndIf}
  ${Else}
    IntOp $1 $STILL_PROGRAM_FENCE_COUNT * 4
    IntOp $1 $STILL_PROGRAM_FENCE_HANDLES + $1
    System::Call '*$1(p r0)'
    IntOp $STILL_PROGRAM_FENCE_COUNT $STILL_PROGRAM_FENCE_COUNT + 1
    System::Call 'kernel32::GetFileType(p r0) i.r6'
    ${If} $6 != 1
      Goto still_fence_fail
    ${EndIf}
    System::Call 'kernel32::GetFileInformationByHandle(p r0, p r2) i.r6'
    ${If} $6 == 0
      Goto still_fence_fail
    ${EndIf}
    System::Call '*$2(i.r6, &v36, i.r7)'
    IntOp $6 $6 & 0x410
    ${If} $6 != 0
    ${OrIf} $7 != 1
      Goto still_fence_fail
    ${EndIf}
    System::Call 'kernel32::GetFullPathNameW(w "${EXE}", i ${NSIS_MAX_STRLEN}, w.r8, p 0) i.r6'
    ${If} $6 == 0
    ${OrIf} $6 >= ${NSIS_MAX_STRLEN}
      Goto still_fence_fail
    ${EndIf}
    System::Call 'kernel32::GetFinalPathNameByHandleW(p r0, w.r9, i ${NSIS_MAX_STRLEN}, i 0) i.r6'
    ${If} $6 == 0
    ${OrIf} $6 >= ${NSIS_MAX_STRLEN}
    ${OrIf} $9 != "\\?\$8"
      Goto still_fence_fail
    ${EndIf}
  ${EndIf}
!macroend

Function un.CheckPublicProgramFenceUsers
  System::Store "s"
  StrCpy $STILL_PROGRAM_FENCE_STATUS 1
  StrCpy $R3 0
  System::Call 'rstrtmgr::RmGetList(i $STILL_PROGRAM_FENCE_SESSION, *i.R0, *i 0 R1, p 0, *i.R2) i.r6'
  ${If} $6 == 0
  ${AndIf} $R0 == 0
  ${AndIf} $R1 == 0
    StrCpy $STILL_PROGRAM_FENCE_STATUS 0
    Goto still_fence_users_done
  ${EndIf}
  ${If} $6 != 234
  ${OrIf} $R0 <= 0
  ${OrIf} $R0 > 1024
    Goto still_fence_users_done
  ${EndIf}
  IntOp $6 $R0 * 668
  System::Alloc $6
  Pop $R3
  ${If} $R3 == 0
    Goto still_fence_users_done
  ${EndIf}
  System::Call 'rstrtmgr::RmGetList(i $STILL_PROGRAM_FENCE_SESSION, *i.R2, *i R0 R1, p R3, *i.R4) i.r6'
  ${If} $6 != 0
  ${OrIf} $R1 < 0
  ${OrIf} $R1 > $R0
  ${OrIf} $R2 > $R0
    Goto still_fence_users_done
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcessId() i.R7'
  StrCpy $R4 0
  ${DoWhile} $R4 < $R1
    ; RM_PROCESS_INFO is 668 bytes on both Windows ABIs; Process.dwProcessId
    ; is its first DWORD. Only this live uninstaller's PID is exempted.
    IntOp $R5 $R4 * 668
    IntOp $R5 $R3 + $R5
    System::Call '*$R5(i.R6)'
    ${If} $R6 != $R7
      Goto still_fence_users_done
    ${EndIf}
    IntOp $R4 $R4 + 1
  ${Loop}
  StrCpy $STILL_PROGRAM_FENCE_STATUS 0
  still_fence_users_done:
    ${If} $R3 != 0
      System::Free $R3
    ${EndIf}
    System::Store "l"
    Push $STILL_PROGRAM_FENCE_STATUS
FunctionEnd

Function un.ReleasePublicProgramFence
  System::Store "s"
  ${DoWhile} $STILL_PROGRAM_FENCE_COUNT > 0
    IntOp $STILL_PROGRAM_FENCE_COUNT $STILL_PROGRAM_FENCE_COUNT - 1
    IntOp $1 $STILL_PROGRAM_FENCE_COUNT * 4
    IntOp $1 $STILL_PROGRAM_FENCE_HANDLES + $1
    System::Call '*$1(p.r0)'
    System::Call 'kernel32::CloseHandle(p r0)'
  ${Loop}
  ${If} $STILL_PROGRAM_FENCE_HANDLES != 0
  ${AndIf} $STILL_PROGRAM_FENCE_HANDLES != ""
    System::Free $STILL_PROGRAM_FENCE_HANDLES
  ${EndIf}
  StrCpy $STILL_PROGRAM_FENCE_HANDLES 0
  ${DoWhile} $STILL_PROGRAM_FENCE_RESOURCE_COUNT > 0
    IntOp $STILL_PROGRAM_FENCE_RESOURCE_COUNT $STILL_PROGRAM_FENCE_RESOURCE_COUNT - 1
    IntOp $1 $STILL_PROGRAM_FENCE_RESOURCE_COUNT * 4
    IntOp $1 $STILL_PROGRAM_FENCE_RESOURCES + $1
    System::Call '*$1(p.r0)'
    System::Free $0
  ${Loop}
  ${If} $STILL_PROGRAM_FENCE_RESOURCES != 0
  ${AndIf} $STILL_PROGRAM_FENCE_RESOURCES != ""
    System::Free $STILL_PROGRAM_FENCE_RESOURCES
  ${EndIf}
  StrCpy $STILL_PROGRAM_FENCE_RESOURCES 0
  ${If} $STILL_PROGRAM_FENCE_ACTIVE == 1
    System::Call 'rstrtmgr::RmEndSession(i $STILL_PROGRAM_FENCE_SESSION) i.r6'
  ${EndIf}
  StrCpy $STILL_PROGRAM_FENCE_ACTIVE 0
  StrCpy $STILL_PROGRAM_FENCE_SESSION 0
  System::Store "l"
FunctionEnd

Function un.AcquirePublicProgramFence
  ; These guards can Abort and therefore run before starting RM / holding locks.
  ${If} $STILL_PROGRAM_FENCE_ACTIVE == 1
    StrCpy $STILL_PROGRAM_FENCE_MESSAGE "An executable fence is already active. Uninstall has stopped."
    Push 1
    Return
  ${EndIf}
  !insertmacro STILL_PUBLIC_EXECUTABLES STILL_FENCE_GUARD
  Push "$INSTDIR\debug.log"
  Call un.CheckNoReparse
  Push "$LOCALAPPDATA\STILL\logs"
  Call un.CheckNoReparse
  System::Store "s"
  StrCpy $STILL_PROGRAM_FENCE_MESSAGE "Close STILL and its installed helpers or dedicated backend, then retry. Their executable files could not be safely locked, or Windows could not verify that all registered programs are closed. No application files have been removed."
  StrCpy $STILL_PROGRAM_FENCE_STATUS 1
  StrCpy $2 0
  ; The caller acquires once. Never silently release a live previous fence.
  ${If} $STILL_PROGRAM_FENCE_ACTIVE == 1
    Goto still_fence_return
  ${EndIf}
  StrCpy $STILL_PROGRAM_FENCE_COUNT 0
  StrCpy $STILL_PROGRAM_FENCE_RESOURCE_COUNT 0
  StrCpy $STILL_PROGRAM_FENCE_HANDLES 0
  StrCpy $STILL_PROGRAM_FENCE_RESOURCES 0
  StrCpy $6 0
  !macro STILL_FENCE_COUNT_EXE EXE
    IntOp $6 $6 + 1
  !macroend
  !insertmacro STILL_PUBLIC_EXECUTABLES STILL_FENCE_COUNT_EXE
  ${If} $6 <= 0
  ${OrIf} $6 > 1024
    Goto still_fence_fail
  ${EndIf}
  IntOp $6 $6 * 4
  System::Alloc $6
  Pop $STILL_PROGRAM_FENCE_HANDLES
  System::Alloc $6
  Pop $STILL_PROGRAM_FENCE_RESOURCES
  System::Alloc 52
  Pop $2
  ${If} $STILL_PROGRAM_FENCE_HANDLES == 0
  ${OrIf} $STILL_PROGRAM_FENCE_RESOURCES == 0
  ${OrIf} $2 == 0
    Goto still_fence_fail
  ${EndIf}
  System::Call 'rstrtmgr::RmStartSession(*i.r0, i 0, w.r1) i.r6'
  ${If} $6 != 0
    Goto still_fence_fail
  ${EndIf}
  StrCpy $STILL_PROGRAM_FENCE_SESSION $0
  StrCpy $STILL_PROGRAM_FENCE_ACTIVE 1
  !insertmacro STILL_PUBLIC_EXECUTABLES STILL_FENCE_REGISTER
  System::Call 'rstrtmgr::RmRegisterResources(i $STILL_PROGRAM_FENCE_SESSION, i $STILL_PROGRAM_FENCE_RESOURCE_COUNT, p $STILL_PROGRAM_FENCE_RESOURCES, i 0, p 0, i 0, p 0) i.r6'
  ${If} $6 != 0
    Goto still_fence_fail
  ${EndIf}
  Call un.CheckPublicProgramFenceUsers
  Pop $6
  ${If} $6 != 0
    Goto still_fence_fail
  ${EndIf}
  !insertmacro STILL_PUBLIC_EXECUTABLES STILL_FENCE_LOCK
  Call un.CheckPublicProgramFenceUsers
  Pop $6
  ${If} $6 != 0
    Goto still_fence_fail
  ${EndIf}
  StrCpy $STILL_PROGRAM_FENCE_STATUS 0
  StrCpy $STILL_PROGRAM_FENCE_MESSAGE ""
  Goto still_fence_return
  still_fence_fail:
    ; CheckPublicProgramFenceUsers may have returned success before a later
    ; failing open; explicitly restore failure rather than return stale zero.
    StrCpy $STILL_PROGRAM_FENCE_STATUS 1
    Call un.ReleasePublicProgramFence
  still_fence_return:
    ${If} $2 != 0
      System::Free $2
    ${EndIf}
    System::Store "l"
    Push $STILL_PROGRAM_FENCE_STATUS
FunctionEnd

Function un.PreserveRuntimeLog
  ; Acquire has already run the original guards before holding any fence.
  ; Standalone callers also run them before this function acquires resources.
  ${If} $STILL_PROGRAM_FENCE_ACTIVE != 1
    Push "$INSTDIR\debug.log"
    Call un.CheckNoReparse
    Push "$LOCALAPPDATA\STILL\logs"
    Call un.CheckNoReparse
  ${EndIf}
  System::Store "s"
  StrCpy $STILL_LOG_PRESERVE_STATUS 1
  StrCpy $STILL_LOG_PRESERVE_MESSAGE "Cannot safely preserve debug.log. It remains in the installation directory; no application files have been removed."
  StrCpy $0 0 ; source handle
  StrCpy $STILL_LOG_TARGET_HANDLE 0
  StrCpy $STILL_LOG_COPY_COMMITTED 0
  StrCpy $2 0 ; current information + source/target identity snapshots
  StrCpy $3 0 ; GUID / opaque 64 KiB copy buffer allocation
  StrCpy $4 0 ; held ancestor handles allocation
  StrCpy $R0 0 ; unconsumed directory paths on the NSIS stack
  StrCpy $R1 0 ; number of ancestor handles
  StrCpy $R9 0 ; 0 = source ancestors, 1 = destination ancestors

  ; Reject truncation before constructing either fixed path.
  StrLen $6 "$INSTDIR"
  IntOp $6 $6 + 11
  ${If} $6 >= ${NSIS_MAX_STRLEN}
    Goto still_log_cleanup
  ${EndIf}
  StrLen $6 "$LOCALAPPDATA"
  IntOp $6 $6 + 12
  ${If} $6 >= ${NSIS_MAX_STRLEN}
    Goto still_log_cleanup
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$INSTDIR\debug.log", i ${NSIS_MAX_STRLEN}, w.r8, p 0) i.r6'
  ${If} $6 == 0
  ${OrIf} $6 >= ${NSIS_MAX_STRLEN}
    Goto still_log_cleanup
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$LOCALAPPDATA\STILL\logs", i ${NSIS_MAX_STRLEN}, w.r9, p 0) i.r6'
  ${If} $6 == 0
  ${OrIf} $6 >= ${NSIS_MAX_STRLEN}
    Goto still_log_cleanup
  ${EndIf}
  ; These are the installer's fixed local drive paths, never UNC/device paths.
  StrCpy $6 $8 2 1
  StrCpy $7 $9 2 1
  ${If} $6 != ":\"
  ${OrIf} $7 != ":\"
    Goto still_log_cleanup
  ${EndIf}
  System::Alloc 156
  Pop $2
  System::Alloc 65536
  Pop $3
  ; Two canonical paths can contain fewer than 2*NSIS_MAX_STRLEN ancestors.
  !define /math STILL_LOG_HANDLE_BYTES ${NSIS_MAX_STRLEN} * 8
  System::Alloc ${STILL_LOG_HANDLE_BYTES}
  Pop $4
  ${If} $2 == 0
  ${OrIf} $3 == 0
  ${OrIf} $4 == 0
    Goto still_log_cleanup
  ${EndIf}
  ${GetParent} "$8" $5

  still_log_collect:
    Push "$5"
    IntOp $R0 $R0 + 1
    ${GetParent} "$5" $6
    StrLen $7 $6
    ${If} $7 == 2
      StrCpy $6 "$6\"
    ${EndIf}
    ${If} $6 == ""
    ${OrIf} $6 == $5
      Goto still_log_open_directory
    ${EndIf}
    StrCpy $5 $6
    Goto still_log_collect

  still_log_open_directory:
    Pop $5
    IntOp $R0 $R0 - 1
    ; FILE_LIST_DIRECTORY | READ_ATTRIBUTES, no write/delete sharing: pin
    ; each root-to-leaf directory. Attribute-only opens do not enforce sharing.
    ; No directory contents are enumerated or read.
    ; OPEN_REPARSE_POINT also inspects the opened directory itself.
    System::Call 'kernel32::CreateFileW(w r5, i 0x81, i 1, p 0, i 3, i 0x02200000, p 0) p.r1 ?e'
    Pop $7
    ${If} $1 == -1
      ${If} $R9 != 1
        Goto still_log_cleanup
      ${EndIf}
      ${If} $7 != 2
      ${AndIf} $7 != 3
        Goto still_log_cleanup
      ${EndIf}
      ; Only the two fixed data-log directories may be created. Their parent
      ; chain is already held, so no ancestor can be substituted during create.
      ${GetParent} "$9" $6
      ${If} $5 != $9
      ${AndIf} $5 != $6
        Goto still_log_cleanup
      ${EndIf}
      System::Call 'kernel32::CreateDirectoryW(w r5, p 0) i.r6 ?e'
      Pop $7
      ${If} $6 == 0
      ${AndIf} $7 != 183
        Goto still_log_cleanup
      ${EndIf}
      System::Call 'kernel32::CreateFileW(w r5, i 0x81, i 1, p 0, i 3, i 0x02200000, p 0) p.r1'
      ${If} $1 == -1
        Goto still_log_cleanup
      ${EndIf}
    ${EndIf}
    ; Track the handle before any failing inspection, for one cleanup path.
    IntOp $R3 $R1 * 4
    IntOp $R3 $4 + $R3
    System::Call '*$R3(p r1)'
    IntOp $R1 $R1 + 1
    System::Call 'kernel32::GetFileInformationByHandle(p r1, p r2) i.r6'
    ${If} $6 == 0
      Goto still_log_cleanup
    ${EndIf}
    System::Call '*$2(i.R4)'
    IntOp $R4 $R4 & 0x410
    ${If} $R4 != 16
      Goto still_log_cleanup
    ${EndIf}
    System::Call 'kernel32::GetFinalPathNameByHandleW(p r1, w.R6, i ${NSIS_MAX_STRLEN}, i 0) i.r6'
    ${If} $6 == 0
    ${OrIf} $6 >= ${NSIS_MAX_STRLEN}
      Goto still_log_cleanup
    ${EndIf}
    ; Reject a reparse ancestor raced in before the directory was opened.
    ${If} $R6 != "\\?\$5"
      Goto still_log_cleanup
    ${EndIf}
    ${If} $R0 > 0
      Goto still_log_open_directory
    ${EndIf}
    ${If} $R9 == 1
      Goto still_log_copy
    ${EndIf}

  ; GENERIC_READ | DELETE | FILE_READ_ATTRIBUTES, share mode zero,
  ; OPEN_EXISTING and OPEN_REPARSE_POINT. Bytes are copied without parsing.
  System::Call 'kernel32::CreateFileW(w r8, i 0x80010080, i 0, p 0, i 3, i 0x00200000, p 0) p.r0 ?e'
  Pop $7
  ${If} $0 == -1
    ${If} $7 == 2
      StrCpy $STILL_LOG_PRESERVE_STATUS 0
      StrCpy $STILL_LOG_PRESERVE_MESSAGE ""
    ${Else}
      StrCpy $STILL_LOG_PRESERVE_MESSAGE "Close STILL and any application using debug.log, then retry. The log remains in the installation directory; no application files have been removed. (Win32 error $7)"
    ${EndIf}
    Goto still_log_cleanup
  ${EndIf}
  System::Call 'kernel32::GetFileType(p r0) i.r6'
  ${If} $6 != 1
    Goto still_log_cleanup
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p r0, p r2) i.r6'
  ${If} $6 == 0
    Goto still_log_cleanup
  ${EndIf}
  ; BY_HANDLE_FILE_INFORMATION: attributes@0, size high/low@32/36,
  ; nNumberOfLinks@40, size=52. Refuse logs over 64 MiB before reading bytes.
  System::Call '*$2(i.R4, &v28, i.R7, i.R8, i.R5)'
  ; Only ordinary Archive / Normal attributes are supported. EFS, sparse,
  ; offline, read-only, hidden, system and every unknown bit are refused.
  IntOp $R4 $R4 & 0xFFFFFF5F
  ${If} $R4 != 0
  ${OrIf} $R5 != 1
    StrCpy $STILL_LOG_PRESERVE_MESSAGE "debug.log has unsupported attributes, a link, or additional links. Retain the complete file manually before retrying; no application files have been removed."
    Goto still_log_cleanup
  ${EndIf}
  ${If} $R7 != 0
  ${OrIf} $R8 < 0
  ${OrIf} $R8 > 67108864
    StrCpy $STILL_LOG_PRESERVE_MESSAGE "debug.log exceeds the 64 MiB preservation limit. Retain it manually before retrying; no application files have been removed."
    Goto still_log_cleanup
  ${EndIf}
  IntOp $R2 $2 + 52
  System::Copy /52 $R2 $2
  !insertmacro STILL_LOG_REQUIRE_DEFAULT_STREAM
  System::Call 'kernel32::GetFinalPathNameByHandleW(p r0, w.R6, i ${NSIS_MAX_STRLEN}, i 0) i.r6'
  ${If} $6 == 0
  ${OrIf} $6 >= ${NSIS_MAX_STRLEN}
  ${OrIf} $R6 != "\\?\$8"
    Goto still_log_cleanup
  ${EndIf}
  StrCpy $R9 1
  StrCpy $5 $9
  Goto still_log_collect

  still_log_copy:
    ; Every ancestor including logs still denies write/delete opens. A new
    ; child CREATE_NEW does not need a conflicting write open of the directory.
    System::Call 'ole32::CoCreateGuid(p r3) i.r6'
    ${If} $6 != 0
      Goto still_log_cleanup
    ${EndIf}
    System::Call 'ole32::StringFromGUID2(p r3, w.R6, i 40) i.r6'
    ${If} $6 != 39
      Goto still_log_cleanup
    ${EndIf}
    StrCpy $R6 "debug-$R6.log"
    StrLen $6 $9
    IntOp $6 $6 + 50
    ${If} $6 >= ${NSIS_MAX_STRLEN}
      Goto still_log_cleanup
    ${EndIf}
    StrCpy $5 "$9\$R6"
    ; GENERIC_WRITE | DELETE | READ_ATTRIBUTES, share0, CREATE_NEW. This never
    ; opens/truncates an existing file, directory, hard link or reparse point.
    System::Call 'kernel32::CreateFileW(w r5, i 0x40010080, i 0, p 0, i 1, i 0x00200000, p 0) p.r1 ?e'
    Pop $7
    ${If} $1 == -1
      StrCpy $STILL_LOG_PRESERVE_MESSAGE "Cannot create a unique preserved log (Win32 error $7). debug.log remains in the installation directory; no application files have been removed."
      Goto still_log_cleanup
    ${EndIf}
    StrCpy $STILL_LOG_TARGET_HANDLE $1
    System::Call 'kernel32::GetFileType(p r1) i.r6'
    ${If} $6 != 1
      Goto still_log_cleanup
    ${EndIf}
    System::Call 'kernel32::GetFileInformationByHandle(p r1, p r2) i.r6'
    ${If} $6 == 0
      Goto still_log_cleanup
    ${EndIf}
    System::Call '*$2(i.R4, &v36, i.R5)'
    IntOp $R4 $R4 & 0xFFFFFF5F
    ${If} $R4 != 0
    ${OrIf} $R5 != 1
      Goto still_log_cleanup
    ${EndIf}
    IntOp $R2 $2 + 104
    System::Copy /52 $R2 $2
    System::Call 'kernel32::GetFinalPathNameByHandleW(p r1, w.R6, i ${NSIS_MAX_STRLEN}, i 0) i.r6'
    ${If} $6 == 0
    ${OrIf} $6 >= ${NSIS_MAX_STRLEN}
    ${OrIf} $R6 != "\\?\$5"
      Goto still_log_cleanup
    ${EndIf}
    StrCpy $R7 0
    still_log_copy_chunk:
      System::Call 'kernel32::ReadFile(p r0, p r3, i 65536, *i.R5, p 0) i.r6'
      ${If} $6 == 0
        Goto still_log_cleanup
      ${EndIf}
      ${If} $R5 == 0
        Goto still_log_verify_copy
      ${EndIf}
      IntOp $R7 $R7 + $R5
      ${If} $R7 > $R8
      ${OrIf} $R7 > 67108864
        Goto still_log_cleanup
      ${EndIf}
      System::Call 'kernel32::WriteFile(p $STILL_LOG_TARGET_HANDLE, p r3, i R5, *i.R2, p 0) i.r6'
      ${If} $6 == 0
      ${OrIf} $R2 != $R5
        Goto still_log_cleanup
      ${EndIf}
      Goto still_log_copy_chunk
    still_log_verify_copy:
    ${If} $R7 != $R8
      Goto still_log_cleanup
    ${EndIf}
    ; Recheck source type, link count and stable length on the original handle.
    System::Call 'kernel32::GetFileInformationByHandle(p r0, p r2) i.r6'
    ${If} $6 == 0
      Goto still_log_cleanup
    ${EndIf}
    System::Call '*$2(i.R4, &v28, i.r6, i.r7, i.R5)'
    IntOp $R4 $R4 & 0xFFFFFF5F
    ${If} $R4 != 0
    ${OrIf} $R5 != 1
    ${OrIf} $6 != 0
    ${OrIf} $7 != $R8
      Goto still_log_cleanup
    ${EndIf}
    ; Stable source identity: volume serial@28 and file index high/low@44/48.
    IntOp $R2 $2 + 52
    System::Call '*$2(&v28, i.r6, &v12, i.r7, i.R5)'
    System::Call '*$R2(&v28, i.R4, &v12, i.R6, i.R7)'
    ${If} $6 != $R4
    ${OrIf} $7 != $R6
    ${OrIf} $R5 != $R7
      Goto still_log_cleanup
    ${EndIf}
    System::Call 'kernel32::GetFileInformationByHandle(p $STILL_LOG_TARGET_HANDLE, p r2) i.r6'
    ${If} $6 == 0
      Goto still_log_cleanup
    ${EndIf}
    System::Call '*$2(i.R4, &v28, i.r6, i.r7, i.R5)'
    IntOp $R4 $R4 & 0xFFFFFF5F
    ${If} $R4 != 0
    ${OrIf} $R5 != 1
    ${OrIf} $6 != 0
    ${OrIf} $7 != $R8
      Goto still_log_cleanup
    ${EndIf}
    IntOp $R2 $2 + 104
    System::Call '*$2(&v28, i.r6, &v12, i.r7, i.R5)'
    System::Call '*$R2(&v28, i.R4, &v12, i.R6, i.R7)'
    ${If} $6 != $R4
    ${OrIf} $7 != $R6
    ${OrIf} $R5 != $R7
      Goto still_log_cleanup
    ${EndIf}
    !insertmacro STILL_LOG_REQUIRE_DEFAULT_STREAM
    System::Call 'kernel32::FlushFileBuffers(p $STILL_LOG_TARGET_HANDLE) i.r6'
    ${If} $6 == 0
      Goto still_log_cleanup
    ${EndIf}
    ; BOOLEAN DeleteFile@0, size1: only this verified, held source is removed.
    ; The complete destination remains held exclusively until source close.
    System::Call '*$2(&i1 1)'
    System::Call 'kernel32::SetFileInformationByHandle(p r0, i 4, p r2, i 1) i.r6'
    ${If} $6 == 0
      Goto still_log_cleanup
    ${EndIf}
    StrCpy $STILL_LOG_COPY_COMMITTED 1
    System::Call 'kernel32::CloseHandle(p r0) i.r6'
    StrCpy $0 0
    ${If} $6 == 0
      StrCpy $STILL_LOG_PRESERVE_MESSAGE "The preserved log is complete at $5, but Windows could not confirm closing its source. Uninstall has stopped."
      Goto still_log_cleanup
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p $STILL_LOG_TARGET_HANDLE) i.r6'
    StrCpy $STILL_LOG_TARGET_HANDLE 0
    ${If} $6 == 0
      StrCpy $STILL_LOG_PRESERVE_MESSAGE "The preserved log is complete at $5, but Windows could not confirm closing it. Uninstall has stopped."
      Goto still_log_cleanup
    ${EndIf}
    StrCpy $STILL_LOG_PRESERVE_STATUS 0
    StrCpy $STILL_LOG_PRESERVE_MESSAGE "Preserved debug.log in $5"

  still_log_cleanup:
    ${DoWhile} $R0 > 0
      Pop $5
      IntOp $R0 $R0 - 1
    ${Loop}
    ${If} $0 != 0
    ${AndIf} $0 != -1
      System::Call 'kernel32::CloseHandle(p r0)'
    ${EndIf}
    ${If} $STILL_LOG_TARGET_HANDLE != 0
      ${If} $STILL_LOG_COPY_COMMITTED != 1
        ; Failure before source commit keeps the source intact. Remove only
        ; our partial CREATE_NEW target by its original exclusive handle.
        System::Call '*$2(&i1 1)'
        System::Call 'kernel32::SetFileInformationByHandle(p $STILL_LOG_TARGET_HANDLE, i 4, p r2, i 1) i.r6'
        ${If} $6 == 0
          StrCpy $STILL_LOG_PRESERVE_MESSAGE "debug.log remains in the installation directory. A partial preserved copy could not be removed at $5. Uninstall has stopped."
        ${EndIf}
      ${EndIf}
      System::Call 'kernel32::CloseHandle(p $STILL_LOG_TARGET_HANDLE)'
      StrCpy $STILL_LOG_TARGET_HANDLE 0
    ${EndIf}
    ${DoWhile} $R1 > 0
      IntOp $R1 $R1 - 1
      IntOp $R3 $R1 * 4
      IntOp $R3 $4 + $R3
      System::Call '*$R3(p.r1)'
      System::Call 'kernel32::CloseHandle(p r1)'
    ${Loop}
    ${If} $4 != 0
      System::Free $4
    ${EndIf}
    ${If} $3 != 0
      System::Free $3
    ${EndIf}
    ${If} $2 != 0
      System::Free $2
    ${EndIf}
    System::Store "l"
    Push $STILL_LOG_PRESERVE_STATUS
FunctionEnd
!endif
