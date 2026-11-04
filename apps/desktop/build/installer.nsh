; Windows-Firewall: Tablets im Fahrzeug-LAN müssen den ELVIS-Server erreichen (Standard-Port 8080, siehe
; desktop.json im Datenordner). Ohne Regel fragt Windows beim ersten Start nach – oder blockiert still.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ELVIS lite"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="ELVIS lite" dir=in action=allow protocol=TCP localport=8080 profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="ELVIS lite"'
!macroend
