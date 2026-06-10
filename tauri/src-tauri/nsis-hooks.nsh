!macro NSIS_HOOK_POSTINSTALL
  SetShellVarContext current
  CreateShortCut "$DESKTOP\Ares.lnk" "$INSTDIR\Ares.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  SetShellVarContext current
  Delete "$DESKTOP\Ares.lnk"
!macroend
