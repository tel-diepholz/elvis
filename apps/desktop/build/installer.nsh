; Windows-Firewall: Tablets im Fahrzeug-LAN müssen den ELVIS-Server erreichen. Die Regel gilt für das Programm statt
; für einen festen Port, weil ELVIS bei belegtem Port auf einen anderen ausweicht (desktop.json im Datenordner). Der
; Server läuft als Unterprozess derselben .exe und ist damit abgedeckt. Ohne Regel fragt Windows beim ersten Start
; nach – oder blockiert still.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ELVIS lite"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ELVIS lite" dir=in action=allow program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ELVIS lite"'
!macroend
