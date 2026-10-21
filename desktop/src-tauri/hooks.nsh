; Hooks for Tauri's NSIS installer (bundle.windows.nsis.installerHooks).
; The backend (conclave-backend.exe, until 0.2.0 mtgdeck-backend.exe, and the tools it starts) keeps files in
; resources\backend open. The installer only closes the main window's process, so an update or a manual install over a
; running app failed with "cannot open file for writing". End the whole tree before files are copied or removed.
; Until 0.2.0 the main program was mtgdeck-desktop.exe; the installer only looks for the new name (Conclave.exe), so
; end the old one too.

!macro NSIS_HOOK_PREINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM conclave-backend.exe'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /T /IM mtgdeck-backend.exe'
  Pop $0
  nsExec::ExecToLog 'taskkill /F /IM mtgdeck-desktop.exe'
  Pop $0
  Sleep 800
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'taskkill /F /T /IM conclave-backend.exe'
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
    ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "MTG Deckbuilder"
    ${If} $R1 != ""
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe" --hidden'
    ${EndIf}
    ; Its uninstaller removes its desktop shortcut; put a Conclave one in its place.
    ${If} ${FileExists} "$DESKTOP\MTG Deckbuilder.lnk"
    ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    ExecWait '"$R0\uninstall.exe" /S _?=$R0'
    Delete "$R0\uninstall.exe"
    RMDir "$R0"
  ${EndIf}
  DeleteRegKey HKCU "Software\liehrdot\MTG Deckbuilder"

  ; After 0.2.0 the programs were renamed the programs: mtgdeck-desktop.exe -> Conclave.exe, mtgdeck-backend.exe -> conclave-backend.exe.
  ; Tauri deletes the old main exe and moves Start menu and desktop shortcuts over; the old backend exe, a pinned
  ; taskbar icon and the autostart entry still point to the old files.
  Delete "$INSTDIR\backend\mtgdeck-backend.exe"
  Delete "$INSTDIR\mtgdeck-desktop.exe"
  StrCpy $R2 "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\${PRODUCTNAME}.lnk"
  !insertmacro IsShortcutTarget "$R2" "$INSTDIR\mtgdeck-desktop.exe"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$R2" "$INSTDIR\${MAINBINARYNAME}.exe"
  ${EndIf}
  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${If} $R1 != ""
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}" '"$INSTDIR\${MAINBINARYNAME}.exe" --hidden'
  ${EndIf}

  ; An update (/UPDATE, which the in-app updater uses) never creates a Start menu entry, it only fixes existing ones.
  ; The update from "MTG Deckbuilder" to "Conclave" changed the entry's name, so the old uninstaller removed
  ; "MTG Deckbuilder" and nothing created "Conclave": the app was missing from the Start menu and Windows Search.
  ; Create it once if it is missing (once, so an entry the user deleted on purpose stays deleted).
  ReadRegStr $R1 HKCU "${MANUPRODUCTKEY}" "StartMenuChecked"
  ${If} $R1 == ""
    ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    WriteRegStr HKCU "${MANUPRODUCTKEY}" "StartMenuChecked" "1"
  ${EndIf}
!macroend
