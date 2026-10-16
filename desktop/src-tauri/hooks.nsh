; Hooks for Tauri's NSIS installer (bundle.windows.nsis.installerHooks).
; The backend (mtgdeck-backend.exe and the tools it starts) keeps files in resources\backend
; open. The installer only closes the main window's process, so an update or a manual install over a running
; app failed with "cannot open file for writing". End the whole tree before files are copied or removed.

!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM mtgdeck-backend.exe'
  Pop $0
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM mtgdeck-backend.exe'
  Pop $0
  Sleep 800
!macroend

; Until 0.1.9 the app was called "MTG Deckbuilder" and installed to %LOCALAPPDATA%\MTG Deckbuilder. Tauri keys the
; install folder, the Start menu entry and the "Apps" entry on the product name, so the first Conclave install would
; sit next to the old one. Remove the old program silently (only the program: its uninstaller deletes app data only
; when the box is ticked, and the decks live in %APPDATA%\MTG Deckbuilder, which no uninstaller touches).
; "Beim Anmelden starten" is a Run entry under the product name; carry it over before the old uninstaller removes it.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 HKCU "Software\liehrdot\MTG Deckbuilder" ""
  ${If} $R0 != ""
  ${AndIf} $R0 != $INSTDIR
  ${AndIf} ${FileExists} "$R0\uninstall.exe"
    nsExec::ExecToLog 'taskkill /F /IM "MTG Deckbuilder.exe"'
    Pop $0
    ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MTG Deckbuilder"
    ${If} $R1 != ""
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe" --hidden'
    ${EndIf}
    ExecWait '"$R0\uninstall.exe" /S _?=$R0'
    Delete "$R0\uninstall.exe"
    RMDir "$R0"
  ${EndIf}
  DeleteRegKey HKCU "Software\liehrdot\MTG Deckbuilder"
!macroend
