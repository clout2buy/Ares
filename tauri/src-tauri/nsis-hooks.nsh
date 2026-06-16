!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  CreateShortCut "$DESKTOP\Ares.lnk" "$INSTDIR\Ares.exe"
  ; Register the `ares` CLI on the user's PATH using the bundled self-contained
  ; runtime, so `ares` works in PowerShell/cmd right after install.
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\register-cli.ps1" -InstallDir "$INSTDIR"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  Delete "$DESKTOP\Ares.lnk"
  ; Remove the `ares` PATH shim (leaves ~/.ares config + vault intact).
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\unregister-cli.ps1"'
!macroend
