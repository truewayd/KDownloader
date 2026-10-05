; Update mode only expands the five transaction-owned files. It never registers
; an installation or changes engines, profiles, shortcuts or uninstall state.
!define TRUEDOWN_ROOT "${__FILEDIR__}\.."
!macro NSIS_HOOK_PREINSTALL
  ${GetOptions} $CMDLINE "/TRUEDOWN-STAGE" $R9
  ${IfNot} ${Errors}
    ${If} $UpdateMode != 1
      SetErrorLevel 2
      Quit
    ${EndIf}
    SetOutPath "$INSTDIR"
    ClearErrors
    File "${MAINBINARYSRCPATH}"
    !if "${ARCH}" == "x64"
      File /oname=truedown-core.exe "${TRUEDOWN_ROOT}\desktop\binaries\truedown-core-x86_64-pc-windows-msvc.exe"
      File /oname=truedown-cli.exe "${TRUEDOWN_ROOT}\desktop\binaries\truedown-cli-x86_64-pc-windows-msvc.exe"
    !else if "${ARCH}" == "arm64"
      File /oname=truedown-core.exe "${TRUEDOWN_ROOT}\desktop\binaries\truedown-core-aarch64-pc-windows-msvc.exe"
      File /oname=truedown-cli.exe "${TRUEDOWN_ROOT}\desktop\binaries\truedown-cli-aarch64-pc-windows-msvc.exe"
    !else
      !error "Unsupported TrueDown installer architecture"
    !endif
    File "${TRUEDOWN_ROOT}\THIRD_PARTY_NOTICES.md"
    File "${TRUEDOWN_ROOT}\dist\NATIVE_LICENSES.txt"
    ${If} ${Errors}
      SetErrorLevel 1
    ${Else}
      SetErrorLevel 0
    ${EndIf}
    Quit
  ${EndIf}
!macroend
