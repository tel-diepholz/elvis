# Druckserver

- **Addon „Druckserver (CUPS)“:** Es betreibt die Drucker, entweder im Fahrzeug-LAN oder per USB (Option „USB-Drucker
  durchreichen“). Drucker richtet man auf zwei Wegen ein:
  - in der CUPS-Verwaltung unter `http://<Docker-Host>:631/admin` (Benutzer `admin`, Passwort aus den Addon-Optionen), auch mit Treiber
  - über die Option **Drucker** (`Name=ipp://192.168.1.50/ipp/print, …`). Fehlende Drucker legt das Addon beim Start als IPP-Everywhere-Drucker an.
    Mit `;` angehängte Optionen (`Plotter=ipp://…/ipp/print;cupsFinishingTemplate=trim-after-sheets`) setzt es bei jedem
    Start per `lpadmin -o` als Vorgabe, auch bei bestehenden Druckern. Mögliche Optionen zeigt `lpoptions -p <Name> -l` im Container.

  Drucker und PPDs liegen im Volume `elvis-addon-druckserver-config`. Die `cupsd.conf` schreibt das Addon bei jedem Start neu.
- **Drucken** (*Fahrzeug → Drucken*, auch ohne Anmeldung): PDF hochladen (max. 50 MB) und in der Vorschau prüfen. Dann
  Drucker, Kopien, Papier, Seitenbereich, ein- oder beidseitig, Farbe/Graustufen, Ausrichtung, Seiten pro Blatt und
  „An Papiergröße anpassen“ wählen. ELVIS bietet nur an, was der Drucker meldet, und prüft das auch auf dem Server.
  Danach zeigt die Seite den Status des Auftrags.
- **Lagekarte:** Läuft ein Druckserver, bietet der Druckdialog der Karte die Ausgabe „Drucker“ neben „PDF herunterladen“.
  ELVIS wählt das Papier passend zum Kartenformat (A4–A1). Kennt der Drucker das Format nicht, wird die Karte auf sein
  Standardpapier verkleinert.
- **Collabora:** Der Druck-Knopf im Editor öffnet den ELVIS-Druckdialog (WOPI `DownloadAsPostMessage`). ELVIS lädt das
  PDF vom Office-Server, auch mit noch nicht gespeicherten Änderungen, und druckt es unter dem Dokumentnamen
  (`POST /api/printing/office`, nur angemeldet und nur von der Adresse des laufenden Office-Servers). Ohne Drucker
  lässt sich das PDF im Browser öffnen. Export und Präsentation laufen wie bisher im Browser.
- **Route:** Der Dialog „Route drucken“ der Routenplanung bietet dieselbe Wahl. Das PDF ist immer A4 hoch und kann
  über mehrere Seiten gehen.
- Gedruckte Lagekarten und Dokumente landen wie jeder Druck im eingestellten Ablageordner.
- **Technik:** ELVIS spricht IPP direkt mit CUPS (`apps/server/src/services/ipp.ts`) und braucht dafür keine weitere
  Bibliothek. Addons melden Druckserver über `provides.printServers` (`{ id, name, url }`). Endpunkte:
  `GET /api/printing`, `POST /api/printing/jobs` (Multipart: `options` als JSON, dann `file`) und
  `GET /api/printing/jobs/:ref`; Gastdrucker: `GET /api/printing/guest`, `GET …/:id/file`, `POST …/:id/release`,
  `DELETE …/:id`.
- **Ablage** (*Einstellungen → Druckserver*, nur Admins): Ist ein Einsatz eröffnet, landet jeder Druck als PDF in dessen
  Dokumentverwaltung. Der Ablageort lässt sich mit Platzhaltern wie bei [Vorlagen](dokumente.md) festlegen (Vorgabe `Drucke`), fehlende
  Ordner werden angelegt. Jeder Druck steht im Bedienprotokoll, die Ablage zusätzlich im Einsatztagebuch. Ohne offenen
  Einsatz wird gedruckt, aber nichts abgelegt. Die Karte zeigt außerdem die letzten Aufträge und den vorausgewählten Drucker.
- **Sicherheit:** Drucken über CUPS ist im Netz ohne Anmeldung möglich, die CUPS-Verwaltung braucht ein Passwort.
  Port 631 sollte nur aus dem Fahrzeug-LAN erreichbar sein.
- **Gastdrucker (AirPrint, Android, Windows):** Mit der Addon-Option „Gastdrucker im Gastnetz“ kündigt ein zweiter
  Container (`gast`, Netzwerk des Hosts) per Bonjour/mDNS einen virtuellen Drucker an. iPhone/iPad (AirPrint), Android
  (Standarddruckdienst) und Windows 10/11 (Einstellungen → Drucker hinzufügen) finden ihn ohne App oder Treiber.
  - Ein eigener, abgespeckter CUPS (Vorgabe Port 8631, keine Verwaltung, nur drucken) wandelt PDF, JPEG, Apple- und
    PWG-Raster in PDF. Das Backend `elvis` schickt jeden Auftrag an `POST /api/printing/guest/submit`, angemeldet mit
    einem je Addon festen Geheimnis (`{{addon.secret}}`, Manifest: `provides.guestPrinters`).
  - *Einstellungen → Druckserver → Gastdrucker:* **Aus** (Aufträge ablehnen), **Direkt drucken** (fester Drucker, Farbe und
    Seiten einstellbar, nur was der Drucker kann) oder **Freigabe durch Personal**: Die Aufträge erscheinen
    angemeldet unter *Drucken* mit Vorschau, werden dort mit den üblichen Einstellungen freigegeben oder verworfen und
    nach 24 Stunden gelöscht. Höchstzahl Kopien je Auftrag einstellbar; Vorgabe: nur annehmen, solange das [Gast-WLAN](../fahrzeugmodule/wlan-openwrt.md)
    läuft (Einsatz eröffnet). Ablage, Bedienprotokoll und Einsatztagebuch wie bei jedem Druck.
  - **Netz:** Der Docker-Host braucht eine Adresse im Gastnetz (z. B. VLAN-Schnittstelle `eth0.20`). Diese
    Schnittstelle in der Option „Netzwerkschnittstelle zum Gastnetz“ eintragen: CUPS und avahi laufen dann nur dort.
    Außerdem „Adresse von ELVIS“ eintragen (wie der Docker-Host ELVIS erreicht). Per Firewall aus dem Gastnetz nur
    den Gastdrucker-Port (TCP 8631) und mDNS (UDP 5353) zum Docker-Host freigeben, nicht ELVIS oder Port 631.
  - Kein TLS (`ipps`) und kein WSD: Windows vor 10 21H2 findet den Drucker unter Umständen nicht.
