; -*- coding: utf-8 -*-
; Only the reviewed compiler and the generated explicit payload list are used.
Unicode true
RequestExecutionLevel user
SetCompressor /SOLID zlib
CRCCheck force
ManifestDPIAware true
ManifestSupportedOS all
Name "STILL · 静室"
Var STILL_PATH_GUARD_MESSAGE
OutFile "${STILL_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\STILL"
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${STILL_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "STILL"
VIAddVersionKey /LANG=1033 "FileDescription" "STILL current-user installer (Windows x64)"
VIAddVersionKey /LANG=1033 "FileVersion" "${STILL_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "STILL contributors; third-party notices retained"
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "${STILL_NONUI_HELPER_INCLUDE}"
!include "${STILL_DIRECTORY_HELPER_INCLUDE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TEXT "STILL is installed for this Windows user.$\r$\n$\r$\nOn first launch STILL automatically prepares its dedicated local backend from the unchanged official installer using the separately supplied 7-Zip CLI. Library, sign-in state and backend data are stored in %LOCALAPPDATA%\STILL and are retained when you uninstall.$\r$\n$\r$\nThis build is unsigned."
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE ValidateInstallDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!define MUI_UNCONFIRMPAGE_TEXT_TOP "Uninstall STILL application files for this user? Your library, sign-in state, settings and dedicated backend in %LOCALAPPDATA%\STILL will be retained. Imported music is untouched."
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!define MUI_UNFINISHPAGE_TEXT "STILL application file removal is complete. Your library, sign-in state, settings, dedicated backend and any preserved logs remain in %LOCALAPPDATA%\STILL. Unknown files may remain in the former installation directory."
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

; Both entry points check every existing ancestor. No installer operation may
; follow a user-created junction, directory symlink or file symlink.
!macro ReparseGuard PREFIX
Function ${PREFIX}CheckNoReparse
  Exch $2
  Push $0
  Push $1
  Push $3
  Push $4
  StrCpy $STILL_PATH_GUARD_MESSAGE ""
  ${If} $2 == ""
    StrCpy $STILL_PATH_GUARD_MESSAGE "An empty installation path cannot be inspected."
    Goto guard_restore
  ${EndIf}
  ; NSIS's GetFullPathName instruction clears missing paths. The Win32 API
  ; canonicalizes a future destination without requiring it to exist. Keep
  ; input and output separate and reject failure/truncation before inspecting.
  System::Call 'kernel32::GetFullPathNameW(w r2, i ${NSIS_MAX_STRLEN}, w.r4, p 0) i.r0 ?e'
  Pop $1
  ${If} $0 == 0
  ${OrIf} $0 >= ${NSIS_MAX_STRLEN}
  ${OrIf} $4 == ""
    StrCpy $STILL_PATH_GUARD_MESSAGE "Cannot canonicalize installation path (Win32 error $1): $2"
    Goto guard_restore
  ${EndIf}
  StrCpy $2 $4
  ${Do}
    ; Capture this call's last-error value atomically. A separate plug-in call
    ; to GetLastError can observe the plug-in's own later Win32 activity.
    System::Call 'kernel32::GetFileAttributesW(w r2) i.r0 ?e'
    Pop $1
    ${If} $0 == -1
      ${If} $1 != 2
      ${AndIf} $1 != 3
        StrCpy $STILL_PATH_GUARD_MESSAGE "Cannot safely inspect installation path (Win32 error $1): $2"
        Goto guard_restore
      ${EndIf}
    ${Else}
      IntOp $1 $0 & 0x400
      ${If} $1 != 0
        StrCpy $STILL_PATH_GUARD_MESSAGE "Installation path contains a link or junction. No changes were made to that path: $2"
        Goto guard_restore
      ${EndIf}
    ${EndIf}
    ${GetParent} "$2" $3
    ; FileFunc returns C: as the parent of C:\Users. Inspect C:\ itself;
    ; C: alone would resolve to that drive's current working directory.
    StrLen $0 $3
    StrCpy $4 $3 1 1
    ${If} $0 == 2
    ${AndIf} $4 == ":"
      StrCpy $3 "$3\"
    ${EndIf}
    ${If} $3 == ""
    ${OrIf} $3 == $2
      ${Break}
    ${EndIf}
    StrCpy $2 $3
  ${Loop}
guard_restore:
  Pop $4
  Pop $3
  Pop $1
  Pop $0
  Pop $2
  ${If} $STILL_PATH_GUARD_MESSAGE != ""
    !if "${PREFIX}" == "un."
      Call un.ReleasePublicProgramFence
    !endif
    !insertmacro STILL_FATAL "${PREFIX}" 21 "$STILL_PATH_GUARD_MESSAGE"
  ${EndIf}
FunctionEnd
!macroend
!insertmacro ReparseGuard ""
!insertmacro ReparseGuard "un."
!include "${STILL_EXECUTABLES_INCLUDE}"
!include "${STILL_LOG_HELPER_INCLUDE}"

Function CheckNewFile
  Exch $2
  Push $0
  Push "$2"
  Call CheckNoReparse
  System::Call 'kernel32::GetFileAttributesW(w r2) i.r0'
  ${If} $0 != -1
    !insertmacro STILL_FATAL "" 23 "A setup file or shortcut already exists. It will not be overwritten. Retain or move that file before installing: $2"
  ${EndIf}
  Pop $0
  Pop $2
FunctionEnd

!macro CopyNewFile SOURCE DESTINATION
  Push "${SOURCE}"
  Call CheckNoReparse
  Push "${DESTINATION}"
  Call CheckNewFile
  System::Call 'kernel32::CopyFileW(w "${SOURCE}", w "${DESTINATION}", i 1) i.r0'
  ${If} $0 == 0
    !insertmacro STILL_FATAL "" 24 "A setup destination could not be created or appeared while setup was running. Existing files will not be overwritten."
  ${EndIf}
!macroend

; Read-only exclusive opens precede all deletions. A running executable, DLL,
; another process's open file, denied access, or a replaced directory asks the
; user to close the application. No process is terminated by this installer.
Function un.CheckFileAvailable
  Exch $2
  Push $0
  Push $1
  System::Call 'kernel32::GetFileAttributesW(w r2) i.r0'
  ${If} $0 != -1
    IntOp $1 $0 & 0x10
    ${If} $1 != 0
      MessageBox MB_OK|MB_ICONSTOP "An installed file was replaced by a directory. Retain that directory and restore the installation before uninstalling: $2"
      Abort
    ${EndIf}
    System::Call 'kernel32::CreateFileW(w r2, i 0x80000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
    ${If} $0 == -1
      MessageBox MB_OK|MB_ICONSTOP "Close STILL and any application using its installed files before uninstalling. No application files have been removed: $2"
      Abort
    ${EndIf}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
  Pop $1
  Pop $0
  Pop $2
FunctionEnd

Function .onInit
  Call ValidatePublicInstallArguments
  ${IfNot} ${AtLeastWin10}
    !insertmacro STILL_FATAL "" 16 "STILL requires Windows 10 or later."
  ${EndIf}
  ${IfNot} ${RunningX64}
    !insertmacro STILL_FATAL "" 16 "STILL requires 64-bit Windows."
  ${EndIf}
  SetShellVarContext current
  SetRegView 64
  Call AcquireStillSetupMutex
  Call CheckExistingStillRegistration
  Push "$SMPROGRAMS\STILL\STILL.lnk"
  Call CheckNewFile
  Push "$SMPROGRAMS\STILL\Uninstall STILL.lnk"
  Call CheckNewFile
FunctionEnd

Function un.onInit
  SetShellVarContext current
  SetRegView 64
  Call un.BindInstallReceipt
FunctionEnd

Section "STILL" SEC_MAIN
  SetShellVarContext current
  SetRegView 64
  ; Recheck the selected dedicated path immediately before payload writes.
  Call ValidateInstallDirectory
  Push "$SMPROGRAMS\STILL\STILL.lnk"
  Call CheckNewFile
  Push "$SMPROGRAMS\STILL\Uninstall STILL.lnk"
  Call CheckNewFile
  InitPluginsDir
  Push "$PLUGINSDIR\STILL-payload"
  Call CheckNoReparse
  ClearErrors
  CreateDirectory "$PLUGINSDIR\STILL-payload"
  SetOutPath "$PLUGINSDIR\STILL-payload"
  ${If} ${Errors}
    !insertmacro STILL_FATAL "" 24 "The private extraction directory could not be prepared."
  ${EndIf}
  SetOverwrite off
  AllowSkipFiles off
  ; The generated include has one File instruction per reviewed payload file.
  !include "${STILL_PAYLOAD_INCLUDE}"
  SetOutPath "$INSTDIR"
  ${If} ${Errors}
    !insertmacro STILL_FATAL "" 24 "Some STILL files could not be installed. No application data was modified."
  ${EndIf}
  Push "$PLUGINSDIR\STILL-Uninstall.exe"
  Call CheckNewFile
  ClearErrors
  WriteUninstaller "$PLUGINSDIR\STILL-Uninstall.exe"
  ${If} ${Errors}
    !insertmacro STILL_FATAL "" 24 "The temporary uninstaller could not be created. Existing files were not overwritten."
  ${EndIf}
  !insertmacro CopyNewFile "$PLUGINSDIR\STILL-Uninstall.exe" "$INSTDIR\Uninstall.exe"
  Push "$SMPROGRAMS\STILL\STILL.lnk"
  Call CheckNoReparse
  Push "$SMPROGRAMS\STILL\Uninstall STILL.lnk"
  Call CheckNoReparse
  CreateDirectory "$SMPROGRAMS\STILL"
  Push "$PLUGINSDIR\STILL.lnk"
  Call CheckNewFile
  ClearErrors
  CreateShortcut "$PLUGINSDIR\STILL.lnk" "$INSTDIR\Still.exe"
  ${If} ${Errors}
    !insertmacro STILL_FATAL "" 24 "The temporary STILL shortcut could not be created."
  ${EndIf}
  !insertmacro CopyNewFile "$PLUGINSDIR\STILL.lnk" "$SMPROGRAMS\STILL\STILL.lnk"
  Push "$PLUGINSDIR\Uninstall-STILL.lnk"
  Call CheckNewFile
  ClearErrors
  CreateShortcut "$PLUGINSDIR\Uninstall-STILL.lnk" "$INSTDIR\Uninstall.exe"
  ${If} ${Errors}
    !insertmacro STILL_FATAL "" 24 "The temporary uninstall shortcut could not be created."
  ${EndIf}
  !insertmacro CopyNewFile "$PLUGINSDIR\Uninstall-STILL.lnk" "$SMPROGRAMS\STILL\Uninstall STILL.lnk"
  Call WriteInstallReceipt
  Call CheckExistingStillRegistration
  ClearErrors
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "DisplayName" "STILL · 静室"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "DisplayVersion" "${STILL_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "Publisher" "STILL contributors"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "DisplayIcon" "$INSTDIR\Still.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "StillReceiptId" "$STILL_INSTALL_RECEIPT_ID"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "StillBuildId" "${STILL_INSTALL_BUILD_ID}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL" "NoRepair" 1
  ${If} ${Errors}
    !insertmacro STILL_FATAL "" 24 "The installation registration could not be written. Setup did not complete successfully."
  ${EndIf}
  Call CheckWrittenInstallPostconditions
  SetErrorLevel 0
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  Call un.CheckRegistrationOwnership
  Push "$SMPROGRAMS\STILL\STILL.lnk"
  Call un.CheckNoReparse
  Push "$SMPROGRAMS\STILL\Uninstall STILL.lnk"
  Call un.CheckNoReparse
  !include "${STILL_PREFLIGHT_INCLUDE}"
  Call un.AcquirePublicProgramFence
  Pop $0
  ${If} $0 != 0
    Call un.ReleasePublicProgramFence
    MessageBox MB_OK|MB_ICONSTOP "$STILL_PROGRAM_FENCE_MESSAGE"
    Abort
  ${EndIf}
  Call un.PreserveRuntimeLog
  Pop $0
  ${If} $0 != 0
    Call un.ReleasePublicProgramFence
    MessageBox MB_OK|MB_ICONSTOP "$STILL_LOG_PRESERVE_MESSAGE"
    Abort
  ${EndIf}
  DetailPrint "$STILL_LOG_PRESERVE_MESSAGE"
  ; Only exact compiled payload files are removed while the launch fence is
  ; held. Unknown entries, including any unconfirmed debug.log, are retained.
  !include "${STILL_UNINSTALL_INCLUDE}"
  Call un.CheckRegistrationOwnership
  ClearErrors
  Delete "$INSTDIR\INSTALL-RECEIPT.ini"
  ${If} ${Errors}
    Call un.ReleasePublicProgramFence
    MessageBox MB_OK|MB_ICONSTOP "The installation receipt could not be removed. Personal data and unknown files are retained."
    Abort
  ${EndIf}
  ClearErrors
  Delete "$INSTDIR\Uninstall.exe"
  ${If} ${Errors}
    Call un.ReleasePublicProgramFence
    MessageBox MB_OK|MB_ICONSTOP "The uninstaller could not be removed. Personal data and unknown files are retained."
    Abort
  ${EndIf}
  Delete "$SMPROGRAMS\STILL\STILL.lnk"
  Delete "$SMPROGRAMS\STILL\Uninstall STILL.lnk"
  Call un.ReleasePublicProgramFence
  ; Close delete-shared executable handles before removing empty directories.
  !include "${STILL_REMOVE_DIRECTORIES_INCLUDE}"
  RMDir "$INSTDIR"
  RMDir "$SMPROGRAMS\STILL"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\STILL"
SectionEnd
