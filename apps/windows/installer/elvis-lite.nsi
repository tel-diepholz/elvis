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
!include "FileFunc.nsh"

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
Var Output

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

; PowerShell-Aufrufe geben ihr Ergebnis als Text aus und enden immer mit ausdrücklichem exit – der Exit-Code von
; „-Command“ hängt sonst auch an unterdrückten Fehlern (Get-NetTCPConnection meldet bei freiem Port einen Fehler).
!define PS `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`
; Port aus elvis.json (Vorgabe ${DEFAULT_PORT})
!define PS_PORT `$$p = ${DEFAULT_PORT}; $$c = Join-Path $$env:ProgramData '${APP}\elvis.json'; if (Test-Path $$c) { try { $$v = (Get-Content $$c -Raw | ConvertFrom-Json).port; if ($$v) { $$p = [int]$$v } } catch {} };`

; Zeile mit Zeitstempel in %ProgramData%\ELVIS lite\logs\installer.log (und in die Detailansicht)
!macro Log text
  DetailPrint "${text}"
  Push "${text}"
  Call WriteLog
!macroend
Function WriteLog
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  ${GetTime} "" "L" $R2 $R3 $R4 $R5 $R6 $R7 $R8
  CreateDirectory "$DataDir\logs"
  FileOpen $R1 "$DataDir\logs\installer.log" a
  FileSeek $R1 0 END
  FileWrite $R1 "$R4-$R3-$R2 $R6:$R7:$R8  [${VERSION}] $R0$\r$\n"
  FileClose $R1
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
FunctionEnd

; Port lesen → $Port
Function ReadPort
  nsExec::ExecToStack `${PS} "${PS_PORT} [Console]::Write($$p); exit 0"`
  Pop $0
  Pop $Port
  ${If} $Port == ""
    StrCpy $Port ${DEFAULT_PORT}
  ${EndIf}
FunctionEnd

; Wartet bis zu 2 Minuten, bis der Dienst mit der neuen Version antwortet → $Output „OK“ oder Grund
Function WaitHealthy
  !insertmacro Log "Warte, bis ELVIS ${VERSION} auf Port $Port antwortet …"
  nsExec::ExecToStack `${PS} "${PS_PORT} $$last = 'keine Antwort'; $$until = (Get-Date).AddSeconds(120); while ((Get-Date) -lt $$until) { try { $$j = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ('http://127.0.0.1:' + $$p + '/api/info')).Content | ConvertFrom-Json; if ($$j.version -eq '${VERSION}') { [Console]::Write('OK'); exit 0 }; $$last = 'antwortet mit Version ' + $$j.version } catch { $$last = $$_.Exception.Message }; Start-Sleep -Seconds 2 }; [Console]::Write($$last); exit 0"`
  Pop $0
  Pop $Output
  ${If} $0 != 0
    StrCpy $Output "PowerShell: $0 $Output"
  ${EndIf}
FunctionEnd

; Wer belegt den Port? → $Output „FREI“, „EIGEN …“ (node.exe dieses Programmordners) oder „BELEGT <Programm>“.
; Lauschende Sockets = ohne Gegenstelle; nicht über -State Listen, das zeigt Windows je nach Sitzung als „Closed“.
Function PortOwner
  nsExec::ExecToStack `${PS} "${PS_PORT} $$o = 'FREI'; foreach ($$l in @(Get-NetTCPConnection -LocalPort $$p -ErrorAction SilentlyContinue | Where-Object { $$_.RemotePort -eq 0 })) { $$pr = Get-Process -Id $$l.OwningProcess -ErrorAction SilentlyContinue; if ($$pr -and $$pr.Path -eq '$INSTDIR\node.exe') { $$o = 'EIGEN ELVIS (PID ' + $$pr.Id + ')' } elseif ($$pr) { $$o = 'BELEGT ' + $$pr.ProcessName + ' (PID ' + $$pr.Id + ')' } }; [Console]::Write($$o); exit 0"`
  Pop $0
  Pop $Output
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
    !insertmacro Log "Update von $OldVersion: beende den laufenden Dienst"
    nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" stop'
    nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" uninstall'
    ; Programmordner und Datenbank sichern (Datenbank-Änderungen einer neuen Version lassen sich nicht zurücknehmen)
    !insertmacro Log "Sichere Version $OldVersion und Datenbank nach $Prev"
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

  ; Dienst anmelden und immer starten – ein gestoppter Dienst ist der schlechteste Ausgang. Belegt ein anderes Programm
  ; den Port, startet der Dienst von selbst neu (onfailure), sobald der Port frei wird.
  nsExec::ExecToStack '"$INSTDIR\elvis-lite-dienst.exe" install'
  Pop $0
  Pop $Output
  !insertmacro Log "Dienst eingerichtet (Code $0) $Output"
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Der Dienst „${APP}“ konnte nicht eingerichtet werden (Code $0)." /SD IDOK
  ${EndIf}
  Call ReadPort
  nsExec::ExecToStack '"$INSTDIR\elvis-lite-dienst.exe" start'
  Pop $0
  Pop $Output
  !insertmacro Log "Dienst gestartet (Code $0) $Output"
  Call WaitHealthy
  !insertmacro Log "Ergebnis: $Output"
  ${If} $Output == "OK"
    StrCpy $Ok "true"
  ${Else}
    Call PortOwner
    !insertmacro Log "Port $Port: $Output"
    StrCpy $1 $Output 6
    ${If} $1 == "BELEGT"
      ; Zurückrollen hilft nicht – die alte Version bräuchte denselben Port
      MessageBox MB_ICONEXCLAMATION "Achtung: Port $Port ist belegt ($Output). Der Server kann nicht starten.$\r$\n$\r$\nDas andere Programm beenden – ELVIS startet dann von selbst – oder in $DataDir\elvis.json einen anderen Port eintragen und den Dienst „${APP}“ neu starten." /SD IDOK
    ${ElseIf} $OldVersion != ""
    ${AndIf} ${FileExists} "$Prev\program\elvis-lite-dienst.exe"
      ; Neue Version kommt nicht hoch: alte Version samt Datenbank zurück
      !insertmacro Log "ELVIS ${VERSION} startet nicht – stelle Version $OldVersion wieder her"
      nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" stop'
      nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" uninstall'
      RMDir /r "$INSTDIR\server"
      RMDir /r "$INSTDIR\web"
      RMDir /r "$INSTDIR\node_modules"
      CopyFiles /SILENT "$Prev\program\*.*" "$INSTDIR"
      Delete "$DataDir\data\elvis.sqlite*"
      CopyFiles /SILENT "$Prev\data\*.*" "$DataDir\data"
      nsExec::ExecToLog '"$INSTDIR\elvis-lite-dienst.exe" install'
      nsExec::ExecToStack '"$INSTDIR\elvis-lite-dienst.exe" start'
      Pop $0
      Pop $Output
      !insertmacro Log "Version $OldVersion wiederhergestellt, Dienst gestartet (Code $0)"
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
