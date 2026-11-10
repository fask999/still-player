; Public installer arguments. The vendor foobar installer is never invoked by
; this entry point. Do not use the uninstaller as an installation fallback.
Var STILL_ARGUMENT_RAW
Var STILL_ARGUMENT_DESTINATION
Var STILL_ARGUMENT_ERROR

!macro STILL_FATAL PREFIX CODE TEXT
  !if "${PREFIX}" == "un."
    ; Existing uninstall behavior is outside the non-UI installation contract.
    MessageBox MB_OK|MB_ICONSTOP "${TEXT}"
    Abort
  !else
    SetErrorLevel ${CODE}
    IfSilent 0 +2
      Quit
    MessageBox MB_OK|MB_ICONSTOP "${TEXT}"
    Abort
  !endif
!macroend

Function ParsePublicInstallArgumentString
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrCpy $STILL_ARGUMENT_ERROR ""
  StrCpy $STILL_ARGUMENT_DESTINATION ""
  StrLen $4 $STILL_ARGUMENT_RAW
  StrCpy $0 0
  StrCpy $1 $STILL_ARGUMENT_RAW 1
  ${If} $1 == '$\"'
    IntOp $0 $0 + 1
    ${Do}
      StrCpy $1 $STILL_ARGUMENT_RAW 1 $0
      ${If} $1 == ""
        Goto argument_invalid
      ${EndIf}
      IntOp $0 $0 + 1
      ${If} $1 == '$\"'
        ${Break}
      ${EndIf}
    ${Loop}
    StrCpy $1 $STILL_ARGUMENT_RAW 1 $0
    ${If} $1 != ""
    ${AndIf} $1 != " "
    ${AndIf} $1 != "$\t"
      Goto argument_invalid
    ${EndIf}
  ${Else}
    ${Do}
      StrCpy $1 $STILL_ARGUMENT_RAW 1 $0
      ${If} $1 == ""
      ${OrIf} $1 == " "
      ${OrIf} $1 == "$\t"
        ${Break}
      ${EndIf}
      IntOp $0 $0 + 1
    ${Loop}
  ${EndIf}
  ${Do}
    StrCpy $1 $STILL_ARGUMENT_RAW 1 $0
    ${If} $1 != " "
    ${AndIf} $1 != "$\t"
      ${Break}
    ${EndIf}
    IntOp $0 $0 + 1
  ${Loop}
  StrCpy $1 $STILL_ARGUMENT_RAW 2 $0
  StrCmpS $1 "/S" 0 argument_no_s
    IntOp $0 $0 + 2
    StrCpy $1 $STILL_ARGUMENT_RAW 1 $0
    ${If} $1 != ""
    ${AndIf} $1 != " "
    ${AndIf} $1 != "$\t"
      Goto argument_invalid
    ${EndIf}
    ${Do}
      StrCpy $1 $STILL_ARGUMENT_RAW 1 $0
      ${If} $1 != " "
      ${AndIf} $1 != "$\t"
        ${Break}
      ${EndIf}
      IntOp $0 $0 + 1
    ${Loop}
argument_no_s:
  StrCpy $1 $STILL_ARGUMENT_RAW "" $0
  ${If} $1 == ""
    Goto argument_done
  ${EndIf}
  StrCpy $2 $1 3
  StrCmpS $2 "/D=" 0 argument_invalid
  StrCpy $STILL_ARGUMENT_DESTINATION $1 "" 3
  StrLen $3 $STILL_ARGUMENT_DESTINATION
  ${If} $3 < 3
    Goto argument_invalid
  ${EndIf}
  StrCpy $1 $STILL_ARGUMENT_DESTINATION 1 1
  StrCpy $2 $STILL_ARGUMENT_DESTINATION 1 2
  ${If} $1 != ":"
  ${OrIf} $2 != "\"
    Goto argument_invalid
  ${EndIf}
  ; /D consumes the raw remainder, including spaces. Quotes and additional
  ; switch-like tokens are refused rather than silently becoming a new path.
  StrCpy $0 0
  StrCpy $2 ""
  ${DoWhile} $0 < $3
    StrCpy $1 $STILL_ARGUMENT_DESTINATION 1 $0
    ${If} $1 == '$\"'
    ${OrIf} $1 == "'"
    ${OrIf} $1 == "/"
    ${OrIf} $1 == "$\r"
    ${OrIf} $1 == "$\n"
      Goto argument_invalid
    ${EndIf}
    ${If} $1 == "-"
      ${If} $2 == " "
      ${OrIf} $2 == "$\t"
        Goto argument_invalid
      ${EndIf}
    ${EndIf}
    StrCpy $2 $1
    IntOp $0 $0 + 1
  ${Loop}
  Goto argument_done
argument_invalid:
  StrCpy $STILL_ARGUMENT_ERROR "Supported installer arguments are optional /S and a final unquoted /D=<absolute local drive path>. Unknown, repeated, quoted or misplaced switches are refused."
argument_done:
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

Function ValidatePublicInstallArguments
  System::Call 'kernel32::GetCommandLineW() p.r0'
  System::Call 'kernel32::lstrlenW(p r0) i.r1'
  ${If} $1 == 0
  ${OrIf} $1 >= ${NSIS_MAX_STRLEN}
    SetSilent silent
    !insertmacro STILL_FATAL "" 10 "The installer command line is empty or exceeds the supported bound."
  ${EndIf}
  System::Call 'kernel32::GetCommandLineW() w.r0'
  StrCpy $STILL_ARGUMENT_RAW $0
  Call ParsePublicInstallArgumentString
  ${If} $STILL_ARGUMENT_ERROR != ""
    ; Unknown flags must not fall back to an interactive window, including /s.
    SetSilent silent
    !insertmacro STILL_FATAL "" 10 "$STILL_ARGUMENT_ERROR"
  ${EndIf}
  ${If} $STILL_ARGUMENT_DESTINATION != ""
    StrCpy $INSTDIR $STILL_ARGUMENT_DESTINATION
  ${EndIf}
FunctionEnd
