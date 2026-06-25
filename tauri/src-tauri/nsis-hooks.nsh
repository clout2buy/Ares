!macro NSIS_HOOK_PREINSTALL
  ; Free the files the updater must overwrite. The running app, the node daemon /
  ; Telegram bridge it spawned, AND any GHOST node left orphaned by a previous
  ; run all hold Ares.exe and the bundled node.exe open — which made in-app
  ; updates die with "node in use" (retry/ignore/abort) and left the daemon
  ; unable to rebind/restart afterward. Kill the app (no /T — the updater itself
  ; may be a child of Ares.exe and we must not kill it), then any node.exe whose
  ; image lives under THIS install dir (never the user's unrelated node).
  nsExec::ExecToLog 'taskkill /F /IM Ares.exe'
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
  ; Let Windows release the file handles before the copy step begins.
  Sleep 1000
!macroend

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
