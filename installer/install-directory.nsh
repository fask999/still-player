; Selected program directory and per-user installation identity. No migration
; of an existing installation, data directory, registration or shortcut.
Var STILL_PATH_INPUT
Var STILL_PATH_OUTPUT
Var STILL_PATH_ERROR
Var STILL_INSTALL_LOCATION
Var STILL_REGISTERED_LOCATION
Var STILL_FIXED_DATA_ROOT
Var STILL_INSTALL_RECEIPT_ID
Var STILL_SETUP_MUTEX
Var STILL_RECEIPT_HANDLE

!macro CanonicalFuturePath PREFIX
Function ${PREFIX}CanonicalFuturePath
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  StrCpy $STILL_PATH_OUTPUT ""
  StrCpy $STILL_PATH_ERROR ""
  StrCpy $0 $STILL_PATH_INPUT 2
  StrCpy $1 $STILL_PATH_INPUT 1 1
  StrCpy $2 $STILL_PATH_INPUT 1 2
  ${If} $0 == "\\"
  ${OrIf} $1 != ":"
    StrCpy $STILL_PATH_ERROR "Select an absolute folder on a local drive, not a UNC or device path."
    Goto canonical_restore
  ${EndIf}
  ${If} $2 != "\"
  ${AndIf} $2 != "/"
    StrCpy $STILL_PATH_ERROR "A drive-relative installation path is not allowed."
    Goto canonical_restore
  ${EndIf}
  System::Call 'kernel32::GetFullPathNameW(w "$STILL_PATH_INPUT", i ${NSIS_MAX_STRLEN}, w.r1, p 0) i.r2 ?e'
  Pop $3
  ${If} $2 == 0
  ${OrIf} $2 >= ${NSIS_MAX_STRLEN}
  ${OrIf} $1 == ""
    StrCpy $STILL_PATH_ERROR "The selected absolute path could not be normalized."
    Goto canonical_restore
  ${EndIf}
  StrCpy $5 $1
  StrCpy $4 ""
  ; Expand existing 8.3 ancestors before comparing with the data root. Missing
  ; tail components are preserved; no directory or file is created here.
  ${Do}
    System::Call 'kernel32::GetLongPathNameW(w r5, w.r0, i ${NSIS_MAX_STRLEN}) i.r2 ?e'
    Pop $3
    ${If} $2 > 0
    ${AndIf} $2 < ${NSIS_MAX_STRLEN}
    ${AndIf} $0 != ""
      ${If} $4 != ""
        StrCpy $3 $0 1 -1
        ${If} $3 == "\"
          StrCpy $0 $0 -1
        ${EndIf}
        StrCpy $0 "$0\$4"
      ${EndIf}
      StrLen $2 $0
      ${If} $2 >= ${NSIS_MAX_STRLEN}
        StrCpy $STILL_PATH_ERROR "The normalized installation path is too long."
      ${Else}
        StrCpy $STILL_PATH_OUTPUT $0
      ${EndIf}
      Goto canonical_restore
    ${EndIf}
    ${If} $3 != 2
    ${AndIf} $3 != 3
      StrCpy $STILL_PATH_ERROR "An existing ancestor could not be safely normalized."
      Goto canonical_restore
    ${EndIf}
    ${GetFileName} "$5" $0
    ${If} $4 == ""
      StrCpy $4 $0
    ${Else}
      StrCpy $4 "$0\$4"
    ${EndIf}
    ${GetParent} "$5" $5
    StrLen $2 $5
    StrCpy $3 $5 1 1
    ${If} $2 == 2
    ${AndIf} $3 == ":"
      StrCpy $5 "$5\"
    ${EndIf}
    ${If} $5 == ""
      StrCpy $STILL_PATH_ERROR "No accessible local drive ancestor was found."
      Goto canonical_restore
    ${EndIf}
  ${Loop}
canonical_restore:
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend
!insertmacro CanonicalFuturePath ""
!insertmacro CanonicalFuturePath "un."

!macro RejectProgramTree ROOT PREFIX
  StrCpy $STILL_PATH_INPUT "${ROOT}"
  Call ${PREFIX}CanonicalFuturePath
  ${If} $STILL_PATH_ERROR != ""
    !insertmacro STILL_FATAL "${PREFIX}" 20 "$STILL_PATH_ERROR"
  ${EndIf}
  StrCpy $0 "$STILL_PATH_OUTPUT\"
  StrLen $1 $0
  StrCpy $2 "$INSTDIR\" $1
  ${If} $2 == $0
    !insertmacro STILL_FATAL "${PREFIX}" 20 "Choose a dedicated STILL folder outside Windows and system program directories."
  ${EndIf}
!macroend

!macro RejectProgramExact ROOT PREFIX
  ${If} $INSTDIR == "${ROOT}"
    !insertmacro STILL_FATAL "${PREFIX}" 20 "Do not select a special user folder itself. Choose a dedicated STILL subfolder."
  ${EndIf}
!macroend

!macro DirectorySafety PREFIX
Function ${PREFIX}ValidateDirectorySafety
  StrCpy $STILL_PATH_INPUT $INSTDIR
  Call ${PREFIX}CanonicalFuturePath
  ${If} $STILL_PATH_ERROR != ""
    !insertmacro STILL_FATAL "${PREFIX}" 20 "$STILL_PATH_ERROR"
  ${EndIf}
  StrCpy $INSTDIR $STILL_PATH_OUTPUT
  Push "$INSTDIR"
  Call ${PREFIX}CheckNoReparse
  ${GetRoot} "$INSTDIR" $0
  StrCpy $0 "$0\"
  ${If} $INSTDIR == $0
    !insertmacro STILL_FATAL "${PREFIX}" 20 "A drive root cannot be used as the STILL installation directory."
  ${EndIf}
  System::Call 'kernel32::GetDriveTypeW(w r0) i.r1'
  ${If} $1 != 2
  ${AndIf} $1 != 3
    !insertmacro STILL_FATAL "${PREFIX}" 20 "Select a dedicated folder on a local fixed or removable drive."
  ${EndIf}
  StrCpy $STILL_PATH_INPUT "$LOCALAPPDATA\STILL"
  Call ${PREFIX}CanonicalFuturePath
  ${If} $STILL_PATH_ERROR != ""
    !insertmacro STILL_FATAL "${PREFIX}" 20 "$STILL_PATH_ERROR"
  ${EndIf}
  StrCpy $STILL_FIXED_DATA_ROOT $STILL_PATH_OUTPUT
  Push "$STILL_FIXED_DATA_ROOT"
  Call ${PREFIX}CheckNoReparse
  StrCpy $0 "$STILL_FIXED_DATA_ROOT\"
  StrLen $1 $0
  StrCpy $2 "$INSTDIR\" $1
  ${If} $2 == $0
    !insertmacro STILL_FATAL "${PREFIX}" 20 "The program directory cannot equal or be inside the separate STILL data directory."
  ${EndIf}
  StrCpy $0 "$INSTDIR\"
  StrLen $1 $0
  StrCpy $2 "$STILL_FIXED_DATA_ROOT\" $1
  ${If} $2 == $0
    !insertmacro STILL_FATAL "${PREFIX}" 20 "The program directory cannot contain the separate STILL data directory."
  ${EndIf}
  !insertmacro RejectProgramTree "$WINDIR" "${PREFIX}"
  !insertmacro RejectProgramTree "$PROGRAMFILES" "${PREFIX}"
  !insertmacro RejectProgramTree "$PROGRAMFILES64" "${PREFIX}"
  !insertmacro RejectProgramExact "$PROFILE" "${PREFIX}"
  !insertmacro RejectProgramExact "$APPDATA" "${PREFIX}"
  !insertmacro RejectProgramExact "$LOCALAPPDATA" "${PREFIX}"
  !insertmacro RejectProgramExact "$LOCALAPPDATA\Programs" "${PREFIX}"
  !insertmacro RejectProgramExact "$DESKTOP" "${PREFIX}"
  !insertmacro RejectProgramExact "$DOCUMENTS" "${PREFIX}"
  !insertmacro RejectProgramExact "$MUSIC" "${PREFIX}"
  !insertmacro RejectProgramExact "$PICTURES" "${PREFIX}"
  !insertmacro RejectProgramExact "$VIDEOS" "${PREFIX}"
  !insertmacro RejectProgramExact "$TEMP" "${PREFIX}"
  StrCpy $STILL_INSTALL_LOCATION $INSTDIR
FunctionEnd
!macroend
!insertmacro DirectorySafety ""
!insertmacro DirectorySafety "un."

Function AcquireStillSetupMutex
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\STILL.Public.Setup") p.r0 ?e'
  Pop $1
  ${If} $0 == 0
    !insertmacro STILL_FATAL "" 22 "Setup could not acquire its installation lock."
  ${EndIf}
  ${If} $1 == 183
    System::Call 'kernel32::CloseHandle(p r0)'
    !insertmacro STILL_FATAL "" 22 "Another STILL setup is already open. Close it before continuing."
  ${EndIf}
  StrCpy $STILL_SETUP_MUTEX $0
FunctionEnd

Function CheckExistingStillRegistration
  System::Call 'advapi32::RegOpenKeyExW(p 0x80000001, w "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL", i 0, i 0x20119, *p.r0) i.r1'
  ${If} $1 == 0
    System::Call 'advapi32::RegCloseKey(p r0)'
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "InstallLocation"
    !insertmacro STILL_FATAL "" 22 "Another STILL installation is registered for this user: $0$\r$\nClose STILL and normally uninstall that installation before installing or changing location. Its data is retained. Setup will not replace its registration or shortcuts."
  ${EndIf}
  ${If} $1 != 2
  ${AndIf} $1 != 3
    !insertmacro STILL_FATAL "" 22 "The existing STILL registration could not be safely inspected. No installation will be changed."
  ${EndIf}
FunctionEnd

Function ValidateInstallDirectory
  Call CheckExistingStillRegistration
  Call ValidateDirectorySafety
  System::Call 'kernel32::GetFileAttributesW(w "$INSTDIR") i.r0 ?e'
  Pop $1
  ${If} $0 == -1
    ${If} $1 == 2
    ${OrIf} $1 == 3
      Return
    ${EndIf}
    !insertmacro STILL_FATAL "" 20 "The selected directory cannot be inspected."
  ${EndIf}
  IntOp $1 $0 & 0x10
  ${If} $1 == 0
    !insertmacro STILL_FATAL "" 20 "The selected destination is an existing file. It will not be changed."
  ${EndIf}
  ClearErrors
  FindFirst $0 $1 "$INSTDIR\*"
  ${If} ${Errors}
    !insertmacro STILL_FATAL "" 20 "The selected directory cannot be confirmed empty."
  ${EndIf}
  ${DoWhile} $1 != ""
    ${If} $1 != "."
    ${AndIf} $1 != ".."
      FindClose $0
      !insertmacro STILL_FATAL "" 20 "The selected directory contains existing files. Choose a new or empty dedicated STILL folder. Nothing in that directory will be overwritten."
    ${EndIf}
    FindNext $0 $1
  ${Loop}
  FindClose $0
FunctionEnd

Function WriteInstallReceipt
  System::Call 'ole32::CoCreateGuid(g.r0) i.r1'
  ${If} $1 != 0
    !insertmacro STILL_FATAL "" 24 "A unique installation receipt could not be created."
  ${EndIf}
  StrCpy $STILL_INSTALL_RECEIPT_ID $0
  Push "$PLUGINSDIR\INSTALL-RECEIPT.ini"
  Call CheckNewFile
  ClearErrors
  FileOpen $0 "$PLUGINSDIR\INSTALL-RECEIPT.ini" w
  ${If} ${Errors}
    !insertmacro STILL_FATAL "" 24 "The installation receipt could not be written."
  ${EndIf}
  FileWriteByte $0 0xff
  FileWriteByte $0 0xfe
  FileWriteUTF16LE $0 "[STILL]$\r$\nSchemaVersion=1$\r$\nProduct=STILL-current-user$\r$\nReceiptId=$STILL_INSTALL_RECEIPT_ID$\r$\nInstallDirectory=$INSTDIR$\r$\nVersion=${STILL_VERSION}$\r$\nBuildId=${STILL_INSTALL_BUILD_ID}$\r$\n"
  FileClose $0
  ${If} ${Errors}
    !insertmacro STILL_FATAL "" 24 "The complete installation receipt could not be written."
  ${EndIf}
  Push "$INSTDIR\INSTALL-RECEIPT.ini"
  Call CheckNewFile
  System::Call 'kernel32::CopyFileW(w "$PLUGINSDIR\INSTALL-RECEIPT.ini", w "$INSTDIR\INSTALL-RECEIPT.ini", i 1) i.r0'
  ${If} $0 == 0
    !insertmacro STILL_FATAL "" 24 "The installation receipt destination already exists or cannot be created. It will not be overwritten."
  ${EndIf}
FunctionEnd

Function CheckWrittenInstallPostconditions
  Push "$INSTDIR\INSTALL-RECEIPT.ini"
  Call CheckNoReparse
  ClearErrors
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "InstallLocation"
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "StillReceiptId"
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "StillBuildId"
  ${If} ${Errors}
  ${OrIf} $0 != $INSTDIR
  ${OrIf} $1 != $STILL_INSTALL_RECEIPT_ID
  ${OrIf} $2 != "${STILL_INSTALL_BUILD_ID}"
    !insertmacro STILL_FATAL "" 25 "The installation registration could not be verified. Setup did not complete successfully."
  ${EndIf}
  ClearErrors
  ReadINIStr $0 "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "InstallDirectory"
  ReadINIStr $1 "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "ReceiptId"
  ReadINIStr $2 "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "BuildId"
  ReadINIStr $3 "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "SchemaVersion"
  ReadINIStr $4 "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "Product"
  ${If} ${Errors}
  ${OrIf} $0 != $INSTDIR
  ${OrIf} $1 != $STILL_INSTALL_RECEIPT_ID
  ${OrIf} $2 != "${STILL_INSTALL_BUILD_ID}"
  ${OrIf} $3 != "1"
  ${OrIf} $4 != "STILL-current-user"
    !insertmacro STILL_FATAL "" 25 "The persisted installation receipt could not be verified. Setup did not complete successfully."
  ${EndIf}
FunctionEnd

Function un.CloseReceiptHandle
  ${If} $STILL_RECEIPT_HANDLE != ""
  ${AndIf} $STILL_RECEIPT_HANDLE != 0
  ${AndIf} $STILL_RECEIPT_HANDLE != -1
    System::Call 'kernel32::CloseHandle(p "$STILL_RECEIPT_HANDLE")'
  ${EndIf}
  StrCpy $STILL_RECEIPT_HANDLE 0
FunctionEnd

Function un.CheckReceiptFile
  StrCpy $STILL_RECEIPT_HANDLE 0
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\INSTALL-RECEIPT.ini", i 0x80000080, i 1, p 0, i 3, i 0x200000, p 0) p.r3'
  ${If} $3 == -1
    MessageBox MB_OK|MB_ICONSTOP "The installation receipt cannot be safely opened. No files will be removed."
    Abort
  ${EndIf}
  StrCpy $STILL_RECEIPT_HANDLE $3
  System::Call 'kernel32::GetFileType(p r3) i.r0'
  ${If} $0 != 1
    Call un.CloseReceiptHandle
    MessageBox MB_OK|MB_ICONSTOP "The installation receipt is not an ordinary disk file."
    Abort
  ${EndIf}
  System::Alloc 52
  Pop $4
  ${If} $4 == 0
    Call un.CloseReceiptHandle
    MessageBox MB_OK|MB_ICONSTOP "The receipt identity could not be inspected."
    Abort
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p r3, p r4) i.r5'
  ${If} $5 == 0
    System::Free $4
    Call un.CloseReceiptHandle
    MessageBox MB_OK|MB_ICONSTOP "The receipt identity could not be inspected."
    Abort
  ${EndIf}
  System::Call '*$4(i.r0, i, i, i, i, i, i, i, i, i, i.r1, i, i)'
  System::Free $4
  IntOp $0 $0 & 0x410
  ${If} $0 != 0
  ${OrIf} $1 != 1
    Call un.CloseReceiptHandle
    MessageBox MB_OK|MB_ICONSTOP "A linked or non-regular receipt cannot authorize removal."
    Abort
  ${EndIf}
  System::Call 'kernel32::GetFinalPathNameByHandleW(p r3, w.r0, i ${NSIS_MAX_STRLEN}, i 0) i.r5'
  ${If} $5 == 0
  ${OrIf} $5 >= ${NSIS_MAX_STRLEN}
  ${OrIf} $0 == ""
    Call un.CloseReceiptHandle
    MessageBox MB_OK|MB_ICONSTOP "The held receipt path could not be verified."
    Abort
  ${EndIf}
  StrCpy $1 $0 4
  ${If} $1 == "\\?\"
    StrCpy $0 $0 "" 4
  ${EndIf}
  ${If} $0 != "$INSTDIR\INSTALL-RECEIPT.ini"
    Call un.CloseReceiptHandle
    MessageBox MB_OK|MB_ICONSTOP "The held receipt is not at this exact registered installation path."
    Abort
  ${EndIf}
FunctionEnd

Function un.BindInstallReceipt
  ; Compare the registered absolute location before reading any receipt. A
  ; moved uninstaller cannot inspect an arbitrary copied receipt directory.
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "InstallLocation"
  ReadRegStr $STILL_INSTALL_RECEIPT_ID HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "StillReceiptId"
  ${If} $0 == ""
  ${OrIf} $STILL_INSTALL_RECEIPT_ID == ""
    MessageBox MB_OK|MB_ICONSTOP "This uninstaller has no matching current-user installation registration. No files will be removed."
    Abort
  ${EndIf}
  StrCpy $STILL_PATH_INPUT $0
  Call un.CanonicalFuturePath
  ${If} $STILL_PATH_ERROR != ""
    MessageBox MB_OK|MB_ICONSTOP "$STILL_PATH_ERROR"
    Abort
  ${EndIf}
  StrCpy $STILL_REGISTERED_LOCATION $STILL_PATH_OUTPUT
  Call un.ValidateDirectorySafety
  ${If} $INSTDIR != $STILL_REGISTERED_LOCATION
    MessageBox MB_OK|MB_ICONSTOP "The uninstaller was moved away from its registered installation. No files will be removed."
    Abort
  ${EndIf}
  Push "$INSTDIR\INSTALL-RECEIPT.ini"
  Call un.CheckNoReparse
  Call un.CheckReceiptFile
  ReadINIStr $0 "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "SchemaVersion"
  ReadINIStr $1 "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "Product"
  ReadINIStr $2 "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "ReceiptId"
  ${If} $0 != "1"
  ${OrIf} $1 != "STILL-current-user"
  ${OrIf} $2 != $STILL_INSTALL_RECEIPT_ID
    Call un.CloseReceiptHandle
    MessageBox MB_OK|MB_ICONSTOP "The installation receipt does not match this registered installation. No files will be removed."
    Abort
  ${EndIf}
  ReadINIStr $STILL_PATH_INPUT "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "InstallDirectory"
  Call un.CanonicalFuturePath
  ${If} $STILL_PATH_ERROR != ""
  ${OrIf} $STILL_PATH_OUTPUT != $INSTDIR
    Call un.CloseReceiptHandle
    MessageBox MB_OK|MB_ICONSTOP "The receipt is bound to a different program directory. No files will be removed."
    Abort
  ${EndIf}
  ReadINIStr $0 "$INSTDIR\INSTALL-RECEIPT.ini" "STILL" "BuildId"
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "StillBuildId"
  ${If} $0 != "${STILL_INSTALL_BUILD_ID}"
  ${OrIf} $1 != "${STILL_INSTALL_BUILD_ID}"
    Call un.CloseReceiptHandle
    MessageBox MB_OK|MB_ICONSTOP "This uninstaller does not match the registered installation build. No files will be removed."
    Abort
  ${EndIf}
  Call un.CloseReceiptHandle
FunctionEnd

Function un.CheckRegistrationOwnership
  ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "InstallLocation"
  ReadRegStr $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "StillReceiptId"
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "StillBuildId"
  ${If} $0 != $INSTDIR
  ${OrIf} $1 != $STILL_INSTALL_RECEIPT_ID
  ${OrIf} $2 != "${STILL_INSTALL_BUILD_ID}"
    Call un.ReleasePublicProgramFence
    MessageBox MB_OK|MB_ICONSTOP "The STILL registration changed during removal. Its registration and shortcuts will be retained."
    Abort
  ${EndIf}
FunctionEnd
