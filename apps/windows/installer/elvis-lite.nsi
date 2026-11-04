; ELVIS lite – Windows-Installer (NSIS 3). Bauen: npm run dist -w @elvis/windows (ruft scripts/installer.mjs).
; Erwartet /DVERSION=x.y.z /DSTAGE=<Programmordner aus scripts/stage.mjs> /DOUTFILE=<Ziel .exe>.
;
; Installiert ELVIS als Windows-Dienst „ELVIS lite“ (WinSW um node.exe), der mit Windows startet. Bedient wird im
; Browser: http://localhost:<Port> auf dem Laptop, http://<Laptop-IP>:<Port> auf Tablets (Standard-Port 8222).
; Daten, Konfiguration und Protokolle liegen in %ProgramData%\ELVIS lite und bleiben bei Updates und beim
; Deinstallieren erhalten. Ein Update ist eine Installation über die bestehende.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef VERSION
  !error "VERSION fehlt (/DVERSION=x.y.z)"
!endif
!define APP "ELVIS lite"
!define SERVICE "elvis-lite"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SERVICE}"
!define DEFAULT_PORT 8222

Name "${APP}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\${APP}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "${APP} – Installer"
VIAddVersionKey "LegalCopyright" "MIT-Lizenz"

!define MUI_ICON "elvis.ico"
!define MUI_UNICON "elvis.ico"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "ELVIS im Browser öffnen"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenElvis
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "German"

Var DataDir
Var Port
Var Prev
Var OldVersion
Var Installed
Var Ok
Var RolledBack

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "${APP} benötigt ein 64-Bit-Windows."
    Abort
  ${EndIf}
  SetRegView 64
  ; Bestehende Installation (auch in einem eigenen Ordner) – erst nach SetRegView 64 lesbar, daher kein InstallDirRegKey
  ReadRegStr $0 HKLM "${UNINST_KEY}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
FunctionEnd

Function OpenElvis
  Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\elvis-oeffnen.ps1"'
FunctionEnd

; Port aus elvis.json (Vorgabe ${DEFAULT_PORT}); als PowerShell-Ausschnitt für die Prüfungen unten
!define PS `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command`
!define PS_PORT `$$p = ${DEFAULT_PORT}; $$c = Join-Path $$env:ProgramData '${APP}\elvis.json'; if (Test-Path $$c) { $$v = (Get-Content $$c -Raw | ConvertFrom-Json).port; if ($$v) { $$p = [int]$$v } };`

; Wartet bis zu 2 Minuten, bis der Dienst mit der neuen Version antwortet. Ergebnis auf dem Stack: 0 = läuft
Function WaitHealthy
  DetailPrint "Warte, bis ELVIS ${VERSION} antwortet …"
  nsExec::ExecToLog `${PS} "${PS_PORT} $$until = (Get-Date).AddSeconds(120); while ((Get-Date) -lt $$until) { try { $$r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ('http://127.0.0.1:' + $$p + '/api/info'); if ($$r.Content -match '\"version\":\"${VERSION}\"') { exit 0 } } catch {}; Start-Sleep -Seconds 2 }; exit 1"`
FunctionEnd

Section "ELVIS lite"
  SetShellVarContext all
  ReadEnvStr $DataDir PROGRAMDATA
  StrCpy $DataDir "$DataDir\${APP}"
  StrCpy $Prev "$DataDir\updates\prev"
  StrCpy $OldVersion ""
  StrCpy $Installed "${VERSION}"
  StrCpy $Ok "false"
  StrCpy $RolledBack "false"

  ; Update (auch aus Einstellungen → Update, dann still mit /S): alten Stand für ein Zurückrollen sichern
  ${If} ${FileExists} "$INSTDIR\elvis-lite-dienst.exe"
    ${If} ${FileExists} "$INSTDIR\VERSION"
      FileOpen $0 "$INSTDIR\VERSION" r
      FileRead $0 $OldVersion
      FileClose $0
      StrCpy $1 $OldVersion 1 -1
      ${If} $1 == "$\n"
        StrCpy $OldVersion $OldVersion -1
      ${EndIf}
      StrCpy $1 $OldVersion 1 -1
      ${If} $1 == "$\r"
        StrCpy $OldVersion $OldVersion -1
      ${EndIf}
    ${EndIf}
    ${If} $OldVersion == ""
      StrCpy $OldVersion "unbekannt"
    ${EndIf}
    DetailPrint "Beende den laufenden Dienst (Version $OldVersion) …"
    nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" stop'
    nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" uninstall'
    ; Programmordner und Datenbank sichern (Datenbank-Änderungen einer neuen Version lassen sich nicht zurücknehmen)
    DetailPrint "Sichere Version $OldVersion und Datenbank …"
    RMDir /r "$Prev"
    CreateDirectory "$Prev\program"
    CopyFiles /SILENT "$INSTDIR\*.*" "$Prev\program"
    CreateDirectory "$Prev\data"
    CopyFiles /SILENT "$DataDir\data\elvis.sqlite*" "$Prev\data"
  ${EndIf}

  ; Alte Programmdateien entfernen (keine Reste alter Versionen), Daten liegen woanders
  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\web"
  RMDir /r "$INSTDIR\node_modules"
  SetOutPath "$INSTDIR"
  File /r "${STAGE}\*.*"

  ; Konfiguration nur beim ersten Mal anlegen – danach gehört sie dem Betreiber
  CreateDirectory "$DataDir"
  ${IfNot} ${FileExists} "$DataDir\elvis.json"
    FileOpen $0 "$DataDir\elvis.json" w
    FileWrite $0 '{$\r$\n  "edition": "lite",$\r$\n  "port": ${DEFAULT_PORT}$\r$\n}$\r$\n'
    FileClose $0
  ${EndIf}

  ; Firewall: für node.exe dieses Programmordners statt für einen Port (Port ist einstellbar)
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APP}"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${APP}" dir=in action=allow program="$INSTDIR\node.exe" enable=yes profile=private,domain'

  ; Dienst anmelden
  DetailPrint "Richte den Dienst „${APP}“ ein …"
  nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Der Dienst „${APP}“ konnte nicht eingerichtet werden (Code $0)." /SD IDOK
  ${EndIf}

  ; Port prüfen (der eigene Dienst ist gestoppt, also belegt ihn ein fremdes Programm); gibt den Port aus
  nsExec::ExecToStack `${PS} "${PS_PORT} [Console]::Write($$p); if (Get-NetTCPConnection -LocalPort $$p -State Listen -ErrorAction SilentlyContinue) { exit 1 }"`
  Pop $0
  Pop $Port
  ${If} $0 == 1
    MessageBox MB_ICONEXCLAMATION "Achtung: Port $Port ist belegt. Der Server kann nicht starten.$\r$\n$\r$\nDas andere Programm beenden und danach den Dienst „${APP}“ starten – oder in $DataDir\elvis.json einen anderen Port eintragen." /SD IDOK
  ${Else}
    DetailPrint "Starte den Dienst …"
    nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" start'
    Call WaitHealthy
    Pop $0
    ${If} $0 == 0
      StrCpy $Ok "true"
    ${ElseIf} $OldVersion != ""
    ${AndIf} ${FileExists} "$Prev\program\elvis-lite-dienst.exe"
      ; Neue Version kommt nicht hoch: alte Version samt Datenbank zurück
      DetailPrint "ELVIS ${VERSION} startet nicht – stelle Version $OldVersion wieder her …"
      nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" stop'
      nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" uninstall'
      RMDir /r "$INSTDIR\server"
      RMDir /r "$INSTDIR\web"
      RMDir /r "$INSTDIR\node_modules"
      CopyFiles /SILENT "$Prev\program\*.*" "$INSTDIR"
      Delete "$DataDir\data\elvis.sqlite*"
      CopyFiles /SILENT "$Prev\data\*.*" "$DataDir\data"
      nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" install'
      nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" start'
      StrCpy $RolledBack "true"
      StrCpy $Installed $OldVersion
      MessageBox MB_ICONSTOP "ELVIS ${VERSION} ist nicht gestartet. Version $OldVersion und die Datenbank wurden wiederhergestellt.$\r$\n$\r$\nProtokolle: $DataDir\logs" /SD IDOK
    ${Else}
      MessageBox MB_ICONEXCLAMATION "ELVIS antwortet noch nicht. Protokolle: $DataDir\logs" /SD IDOK
    ${EndIf}
  ${EndIf}

  ; Ergebnis für Einstellungen → Update; die einmalige Aufgabe des Updates aufräumen
  ${If} $OldVersion != ""
    CreateDirectory "$DataDir\updates"
    FileOpen $0 "$DataDir\updates\result.json" w
    FileWrite $0 '{"from":"$OldVersion","to":"${VERSION}","ok":$Ok,"rolledBack":$RolledBack}$\r$\n'
    FileClose $0
  ${EndIf}
  nsExec::Exec 'schtasks /Delete /TN "${APP} Update" /F'

  ; Verknüpfungen: ELVIS im Browser öffnen, Adresse für Tablets
  StrCpy $1 '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\elvis-oeffnen.ps1"'
  CreateShortcut "$DESKTOP\${APP}.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '$1' "$INSTDIR\elvis.ico" 0 SW_SHOWMINIMIZED
  CreateDirectory "$SMPROGRAMS\${APP}"
  CreateShortcut "$SMPROGRAMS\${APP}\${APP}.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '$1' "$INSTDIR\elvis.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\${APP}\Adresse für Tablets.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" '$1 -Adressen' "$INSTDIR\elvis.ico" 0 SW_SHOWMINIMIZED
  CreateShortcut "$SMPROGRAMS\${APP}\Daten und Protokolle.lnk" "$DataDir"
  CreateShortcut "$SMPROGRAMS\${APP}\${APP} deinstallieren.lnk" "$INSTDIR\uninstall.exe"

  ; Programme und Features
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "$Installed"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "ELVIS"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\elvis.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext all
  SetRegView 64
  nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" stop'
  nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" uninstall'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APP}"'
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$SMPROGRAMS\${APP}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"
  ReadEnvStr $DataDir PROGRAMDATA
  MessageBox MB_ICONINFORMATION "${APP} wurde entfernt. Einsatzdaten und Einstellungen bleiben in $DataDir\${APP} erhalten."
SectionEnd
