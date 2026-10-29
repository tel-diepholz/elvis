# Bildschirme

Bildschirme im Fahrzeug (z. B. Lagetisch, Monitor im Führungsraum) zeigen die Seite `/bildschirm`, im Kiosk-Browser
oder später in einer App (WebView). Was dort zu sehen ist, steuert man in ELVIS unter **Bildschirme**.

- **Koppeln (Admin):** `/bildschirm` öffnen, der Bildschirm zeigt einen 6-stelligen Code (10 Minuten gültig). Unter
  Einstellungen → Bildschirme → „Bildschirm koppeln“ den Code und einen Namen eintragen. Der Bildschirm erhält ein dauerhaftes
  Gerätecookie, in der Datenbank steht nur dessen Hash. Entkoppeln widerruft es sofort, der Bildschirm zeigt dann
  wieder einen Code.
- **Inhalte (angemeldete Benutzer):** zwischen Bildschirmen umschalten, Vorschau in Originalauflösung des Bildschirms,
  „Erkennen“ (Name groß einblenden), „Neu laden“. Unter „Konfigurieren“ werden Kacheln im Raster angeordnet:
  - ziehen zum Verschieben, an der Ecke ziehen für die Größe, Pfeiltasten bzw. Umschalt+Pfeiltasten
  - Überlappungen werden nicht übernommen
  - Rastergröße wählbar (Standard 12×8)
  - Änderungen erscheinen sofort auf dem Bildschirm.
- **Szenen je Bildschirm:** Die aktuelle Anordnung lässt sich als Szene speichern, z. B. „Anfahrt“, „Lage“ oder
  „Kameras“. Ein Klick auf die Szene stellt den Bildschirm sofort um. Die gerade angezeigte Szene erkennt ELVIS am
  Inhalt. Nach Änderungen im Editor steht „Anordnung geändert“, bis man neu speichert oder eine Szene überschreibt.
  Szenen lassen sich umbenennen, überschreiben, sortieren und löschen. Admins können eine Szene im Verwalten-Dialog
  per Schloss schützen; sie lässt sich dann weder überschreiben noch löschen (umbenennen und aufrufen geht weiter). Sie bleiben unabhängig vom Einsatz erhalten,
  und jede Aktion landet im Bedienprotokoll. Beim Entkoppeln eines Bildschirms werden seine Szenen gelöscht.
- **Kacheln:** Lagekarte (Fahrzeug und Einsatzort, Kartenstil, Mittelpunkt, Mitführen, Zoom), [Kamera](../fahrzeugmodule/kameras-axis.md) (Livebild),
  Wetter (mit amtlichen Warnungen), Wettervorhersage (24 Stunden und/oder 7 Tage), Uhr (DTG), Meldungen, Netzwerk (Router/Failover), Gast-WLAN (QR-Code, Netzname und Passwort des Gastnetzes
  im laufenden Einsatz, siehe [WLAN](../fahrzeugmodule/wlan-openwrt.md)), Bild (hochgeladenes PNG, JPEG, GIF oder WebP bis 20 MB, ohne Kachelrahmen) und
  Szenenwahl (Szenen und Hell/Dunkel per Touch am Bildschirm). Eine mitgeführte Karte folgt Fahrzeug bzw. Einsatzort und
  lässt sich nicht verschieben. Ohne Mitführen lässt sie sich am Bildschirm per Touch und unter „Bildschirme“ direkt in
  der Vorschau verschieben und zoomen – der Bildschirm folgt und behält den Ausschnitt, auch nach „Neu laden“.
- **Design:** Jeder Bildschirm ist hell oder dunkel (Standard), umschaltbar unter „Bildschirme“ oder am Bildschirm über
  die Kachel „Szenenwahl“. Im dunklen Design ist der Hintergrund hinter den Kacheln schwarz.
- **Rechte:** Gekoppelte Bildschirme dürfen ohne Benutzeranmeldung zusätzlich den laufenden Einsatz lesen (für den
  Einsatzort auf der Karte), das Gastnetz (Kachel „Gast-WLAN“) und die Bilder der Kachel „Bild“, sonst nur, was auch
  anonyme Arbeitsplätze sehen. Szenen aufrufen und das Design wechseln darf ein Bildschirm selbst nur, solange er eine
  Kachel „Szenenwahl“ zeigt.
- **Kiosk-Browser:** mit dauerhaftem Profil starten, nicht im Inkognito-Modus, sonst geht die Kopplung bei jedem
  Neustart verloren. Beispiel: `chromium --kiosk --noerrdialogs --disable-session-crashed-bubble http://<elvis>:8080/bildschirm`.
- **Smart-TV / Android:** Die App [ELVIS Bildschirm](https://github.com/tel-diepholz/elvis-tv) zeigt `/bildschirm` im
  Vollbild, startet auf Wunsch nach dem Einschalten und fragt beim ersten Start nach der Adresse des Servers. Den
  Download-Link der neuesten APK zeigt ELVIS unter *Einstellungen → Bildschirme* beim Koppeln
  (`https://github.com/tel-diepholz/elvis-tv/releases/latest/download/elvis-tv.apk`).
