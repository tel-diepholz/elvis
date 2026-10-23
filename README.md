# ELVIS – Einsatzleitwagen-Verwaltungs- und Informationssystem

Zentrale, responsive Weboberfläche für den ELW 2 der Freiwilligen Feuerwehr. ELVIS fasst die
Einzelsysteme des Fahrzeugs (Funk, Netzwerk, Medien, Wetterstation mit GPS – weitere folgen) und die
Einsatzführung (Einsatztagebuch, Kräfte, Dokumente) in einer Anwendung zusammen.

## Bereiche

| Bereich | Verfügbarkeit | Inhalt |
| --- | --- | --- |
| **Fahrzeug** | immer | Übersicht, Fahrzeugzustand, Karte, Wetterstation, Netzwerk, Medien |
| **Einsatz** | Unterseiten erst mit aufgelegtem Einsatz | Einsatztagebuch, Kräfteübersicht, Dokumente |
| **Verwaltung** | immer | Einsatzarchiv (schreibgeschützt), System/Bedienprotokoll |

Die Sperre der Einsatzbereiche wird im Backend durchgesetzt: Schreibzugriffe sind nur auf den offenen
Einsatz möglich, abgeschlossene Einsätze sind nur lesbar.

## Schnellstart

```bash
git clone --recurse-submodules https://github.com/tel-diepholz/elvis.git   # Addons kommen als Submodul mit
cd elvis
npm install
npm run dev          # Backend :8080 (Simulation) + Frontend :5173 mit Hot Reload
```

Installation auf einem Fahrzeug-Server als Docker-Container (richtet den Server zugleich als Docker-Host ein):

```bash
sudo sh deploy/install.sh            # oder --no-docker-host
```

Dann <http://localhost:5173> öffnen; im Fahrzeug-WLAN auch von Tablets/Smartphones über die IP des Rechners.

Produktion (ein Prozess, ein Port):

```bash
npm run build
cp config/elvis.example.json config/elvis.json   # anpassen
npm start                                        # http://<host>:8080
```

Weitere Befehle: `npm test` (Backend-Tests), `npm run typecheck`.

## Architektur

```
packages/shared   Gemeinsame Typen: Gerätezustände, Einsatzdaten, WebSocket-Protokoll
apps/server       Fastify-Backend
  devices/        Adapter-Schicht: ein Treiber je Gerät (aktuell Simulatoren in devices/sim)
  alerts.ts       Alarmregeln (Sturm, GPS, Funk, Internet …)
  services/       Einsatzführung inkl. automatischer Tagebucheinträge
  db/             SQLite (better-sqlite3), Migrationen, revisionssicheres Tagebuch
apps/web          React + Vite, React Query, Leaflet
```

- **Live-Daten:** Der Server schickt Gerätezustände und Meldungen per WebSocket (`/api/live`). REST-Daten
  (Tagebuch, Kräfte, Dokumente) werden über `invalidate`-Nachrichten auf allen Clients aktualisiert.
- **Befehle:** `POST /api/devices/:id/commands` mit `{ action, params }`. Jeder Befehl landet im
  Bedienprotokoll, auch abgelehnte (z. B. Rufgruppe eines Handfunkgeräts umschalten).
- **Einsatztagebuch:** Einträge sind per Datenbank-Trigger unveränderlich. Korrekturen werden als neue
  Einträge mit Verweis erfasst. Kräfte-Statuswechsel, Abschnittszuordnung, Dokumente sowie das Eröffnen
  und Beenden eines Einsatzes werden automatisch als Systemeintrag protokolliert. CSV-Export ist möglich.

## Echte Hardware anbinden

Jedes Gerät implementiert `DeviceAdapter` (`apps/server/src/devices/adapter.ts`) und veröffentlicht den
Zustand aus `packages/shared/src/devices.ts`. Für einen echten Treiber:

1. Klasse anlegen, z. B. `devices/victron/power.ts extends BaseAdapter<'power'>`, und die Befehle mit
   denselben Aktionsnamen wie im Simulator umsetzen.
2. In `devices/drivers.ts` registrieren: `power: { drivers: { sim: …, victron: (o) => new VictronPower(o) } }`.
3. In `config/elvis.json` auswählen: `"devices": { "power": { "driver": "victron", "options": { "host": "…" } } }`.

Typische Schnittstellen: Victron/Modbus-TCP (Energie), CAN/FMS-Gateway (Fahrgestell), Relais-/SPS-I/O
(Licht, Mast), TETRA-PEI (Funk), Router-API/SNMP (Netzwerk), RS-232/IP (Videomatrix), ONVIF (Kameras).
Befehle mit dem Präfix `sim.` gibt es nur im Simulator.

## Ausbreitungsberechnung (Karte)

Ab dem Einsatzort zeigt die Karte wahlweise eine **Gauß-Fahne** oder den schematischen **60°-Sektor**
in Windrichtung. Die Werte für Wind und Richtung kommen live von der Wetterstation.

- **Modell** (`packages/shared/src/dispersion.ts`): stationäre Gauß-Fahne mit Bodenreflexion und Windprofil,
  angelehnt an den Ansatz von VDI 3783 Blatt 1. Die Ausbreitungsklasse nach Klug/Manier (I–V) wird automatisch
  aus Wind, Sonnenhöhe und Bedeckungsgrad (manuell) bestimmt oder von Hand gewählt.
- **Parameter:** σy/σz nach Briggs (offenes Gelände bzw. Bebauung). Sie sind in `SIGMA_PARAMETERS` gekapselt und
  sollten durch die Koeffizienten aus VDI 3783 Blatt 1 ersetzt werden, sobald die Norm vorliegt.
- **Darstellung:** drei Stufen c/Q ≥ 10⁻³ / 10⁻⁴ / 10⁻⁵ s/m³. Mit einer Freisetzungsrate in kg/s erscheinen
  die Stufen in mg/m³.
- **Grenzen:** kein Gelände, keine Bebauung im Detail, kein Schwergas, kein thermischer Auftrieb, kein
  Inversionsdeckel. Bei Wind unter 1 m/s ist das Modell nicht belastbar, dann erscheint ein Warnhinweis.
  Das Ergebnis ist **nur eine Orientierung**, keine Grundlage für Grenzwertentscheidungen.

## Karten, Offline-Cache und Druck

Kartenkacheln laufen über den Fahrzeugserver (`/api/map/tiles/…`). Jede geladene Kachel wird unter
`data/tiles/` gespeichert und steht danach auch ohne Internet zur Verfügung. Nach `cacheMaxAgeDays` wird
sie neu geladen, offline bleibt der alte Stand nutzbar. Kartenquellen werden in `config/elvis.json`
festgelegt:

```json
"map": {
  "sources": [
    { "id": "osm", "name": "OpenStreetMap", "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      "attribution": "© OpenStreetMap-Mitwirkende", "maxZoom": 19 },
    { "id": "lokal", "name": "Lokaler Kartenserver", "url": "http://elw-server:8081/tiles/{z}/{x}/{y}.png",
      "attribution": "© OpenStreetMap-Mitwirkende", "maxZoom": 18 }
  ]
}
```

Platzhalter: `{z}`, `{x}`, `{y}`, optional `{s}` (Subdomain aus `subdomains`) und `{r}` (`@2x` bei
`"pixelRatio": 2`). Sind mehrere Quellen konfiguriert, erscheint auf der Karte und im Druckdialog eine Auswahl.

**Lagekarte drucken:** Auf der Karte öffnet „Drucken“ einen Dialog mit Format (A4/A3/A2/A1), Ausrichtung,
Zoomstufe (mit Maßstabsangabe) und Kartenstil. In der Vorschau wird der Ausschnitt gewählt, indem man die Karte
unter dem Druckrahmen verschiebt. Fahrzeugstandort, Einsatzort und Ausbreitung lassen sich einzeln zuschalten.
Das PDF entsteht auf dem Server (`POST /api/print/map`): Die Kacheln werden direkt eingebettet, Markierungen und
Ausbreitung als Vektorgrafik. Dazu kommen ein Infokasten mit Titel, DTG, Maßstab, Maßstabsleiste, Legende, Wind
und Quellenangabe sowie ein Nordpfeil. Jeder Druck wird im Bedienprotokoll vermerkt.

Hinweis zu OpenStreetMap: Die öffentlichen Kachelserver sind nicht für Massenabrufe gedacht
([Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)). Ein A1-Druck braucht rund 150 Kacheln.
Für regelmäßigen Betrieb einen eigenen oder kommerziellen Kacheldienst eintragen.

**Refill-Stil:** Die Refill-Stile von Mapzen sind Tangram-Vektorstile ohne öffentlichen Rasterdienst. Um sie zu
nutzen, die Vektorkacheln mit dem Refill-Stil selbst zu Rasterkacheln rendern (z. B. auf einem lokalen
Kartenserver) und dessen XYZ-URL als weitere Quelle eintragen. Ein ähnlicher, druckfreundlicher
Schwarz-Weiß-Stil ist Stamen Toner (Refills Vorgänger), z. B. über einen Kacheldienst mit API-Schlüssel.

## Fahrzeugmodule

Fahrzeugsysteme sind Treiber im Kern (`apps/server/src/devices/`). Admins konfigurieren sie unter
**System → Fahrzeugmodule**:

- Modul aktivieren oder deaktivieren. Ein deaktiviertes Modul erzeugt keine Meldungen, und seine Seite zeigt einen Hinweis.
- Treiber wählen, z. B. „Simulation“ oder „Airmar über Actisense“. Das Formular mit den Treiber-Einstellungen
  entsteht aus der Treiberdefinition. Serielle Schnittstellen liest ELVIS vom Server aus und bietet sie als Auswahl an,
  USB-Geräte bevorzugt unter ihrem stabilen Namen `/dev/serial/by-id/…`. Ein eigener Pfad ist ebenfalls möglich.
- „Übernehmen“ startet den Treiber sofort neu, ohne dass ELVIS neu gestartet werden muss. Gespeichert wird die
  Einstellung in der Datenbank, und jede Änderung landet im Bedienprotokoll.

`config/elvis.json` (`devices`) liefert nur die Vorgaben, solange in der Oberfläche nichts gespeichert wurde.
Ohne Angabe läuft der Simulator (`sim`). Neue Treiber, z. B. weitere Wetterstationen, werden in
`apps/server/src/devices/drivers.ts` eingetragen und erscheinen dann automatisch in der Auswahl.

Läuft ELVIS im Container, muss das USB-Gerät durchgereicht werden (siehe `deploy/compose.yaml`, `devices:`).

### ELW-Router Teltonika RUTM59 (RutOS-Web-API)

Treiber `teltonika-rutos` für Teltonika-Router mit RutOS ab Firmware 7.x. Er arbeitet nur lesend und fragt zyklisch ab:

| Anzeige | Quelle (RutOS-API) |
| --- | --- |
| SIM 1 und SIM 2: aktiv/Reserve, Status (verbunden, PIN/PUK, keine SIM …), Betreiber, Netz/Band, Signal, ICCID | `GET /api/modems/status` |
| Failover: Reihenfolge, Zustand je Verbindung, aktive Verbindung, „Ausweichverbindung aktiv“ | `GET /api/failover/status` + Metrik aus `GET /api/interfaces/status` |
| WAN-Port: Link und Geschwindigkeit, IP-Adresse, Gateway | `GET /api/ports_settings/status`, `GET /api/interfaces/status` |
| DHCP-Leases (IPv4): Gerät, IP, MAC, Netz, fest/dynamisch, Restlaufzeit | `GET /api/dhcp/leases/ipv4/status`, feste Zuweisungen aus `GET /api/dhcp/static_leases/ipv4/config` |

- Anmeldung über `POST /api/login` mit Bearer-Token. Das Token wird vor Ablauf erneuert. Am besten im Router einen
  eigenen Benutzer mit Leserechten **ohne** Zwei-Faktor-Anmeldung anlegen.
- Ab RutOS 7.15 ist HTTPS mit selbstsigniertem Zertifikat Standard. Deshalb ist „Zertifikat prüfen“ ab Werk aus.
- Der WAN-Port bekommt in den Moduleinstellungen eine eigene Bezeichnung (z. B. „LAN Feuerwache“). Sie erscheint
  überall statt „WAN“.
- Das Modem des RUTM59 bedient immer nur eine SIM. Für die Reserve-SIM zeigt ELVIS die zuletzt bekannten Werte aus
  der Zeit, als sie aktiv war. Nach einem ELVIS-Neustart ist ihr Zustand bis zur nächsten Umschaltung unbekannt.
- Endpunkte, die eine ältere Firmware nicht kennt, werden übersprungen. Dann fehlt z. B. der Link-Status des Ports.
- Meldungen: „keine Internetverbindung“ (Alarm), SIM-Probleme wie fehlende SIM oder PIN (Warnung) und
  „Ausweichverbindung aktiv“ (Hinweis).

### NDI-Gateway (Addon)

Macht NDI-Quellen im Browser sichtbar, z. B. als Kachel „Video (NDI)“ auf den Bildschirmen.

```
NDI-Quellen ─▶ Gateway (GStreamer, ndisrc → H.264) ─RTSP─▶ MediaMTX ─WebRTC─▶ Browser/Bildschirm
```

- **Gateway-Image:** Es wird beim Installieren auf dem Docker-Host gebaut (`builds` im Manifest, einmalig einige
  Minuten). Das NDI-Plugin für GStreamer wird dabei aus dem offiziellen Quellcode kompiliert
  (gst-plugins-rs 0.14.5, MPL-2.0).
- **NDI-Laufzeit (libndi):** Sie ist proprietär und deshalb nicht im Image. Der Job „NDI-Laufzeit laden“ holt sie erst,
  wenn in den Einstellungen „NDI-Lizenzbedingungen akzeptiert“ gesetzt ist, und legt nur die Bibliothek für die
  Rechnerarchitektur ins Volume. Die Lizenzbedingungen (NDI SDK License Agreement) prüft ihr als Lizenznehmer selbst.
- **Encoder wählbar:**
  - CPU (x264)
  - Intel/AMD-Grafik per VA-API: ELVIS reicht `/dev/dri` durch.
  - NVIDIA per NVENC: ELVIS fordert die GPU an, dafür braucht der Host NVIDIA-Treiber und das NVIDIA Container
    Toolkit.
  - Ausgabe immer als H.264 „Constrained Baseline“, 4:2:0, ohne B-Frames, Schlüsselbild alle 2 s, damit jeder
    Browser per WebRTC abspielt.
- **Weitere Optionen:** Auflösung 720p oder 1080p, Bitrate, Bildrate, Ton (Opus), Filter auf Quellnamen, Höchstzahl der
  Ströme, optional NDI Discovery Server statt mDNS sowie die Ports.
- **Übertragung:** Vorgabe ist TCP. Beim NDI-Standard „Reliable UDP“ schickt die Quelle UDP-Pakete zurück an den
  Empfänger. Hinter NAT, Firewalls oder in Docker Desktop gehen sie verloren, es erscheint „Keine Bilddaten von der
  Quelle“ (GStreamer: „Could not demultiplex stream“). Mit TCP laufen die Daten über die Verbindung, die das Gateway
  selbst aufbaut. Im Labor: bei blockiertem UDP 0 Bilder über Reliable UDP, 300 Bilder in 12 s über TCP.
- **Suche:** per mDNS über Avahi im Container. Beide Container laufen im Netzwerk des Hosts. MediaMTX nimmt Ströme nur
  von localhost an, Ansehen geht für alle im LAN.
- **Ton:** NDI-Ton mit beliebig vielen Kanälen und Abtastraten wird auf Stereo mit 48 kHz als Opus umgerechnet, das
  einzige Format, das alle Browser per WebRTC zuverlässig abspielen.
- **Player in der Kachel:** ein eigener WebRTC-Player (WHEP), der immer stumm startet, denn Browser verweigern den
  automatischen Start mit Ton. Ist „Ton“ eingeschaltet, schaltet er ihn danach ein. Blockiert der Browser das (z. B.
  Safari/iPad), läuft das Bild stumm weiter, und der Knopf „Ton einschalten“ erscheint. Kiosk-Browser mit
  `--autoplay-policy=no-user-gesture-required` spielen Ton immer sofort.
- **Einbindung in ELVIS:** ELVIS fragt den Status des Gateways ab (`provides.videoSources`, nur lesend, Port
  „Status“). Die Ströme erscheinen unter `/api/video/sources` und in der Kachel „Video (NDI)“. Bildschirme müssen den
  Docker-Host direkt erreichen (WebRTC, Ports „WebRTC“ und „WebRTC-Medien“).
- **Erprobt:** im Labor mit einer NDI-Testquelle bis zur Wiedergabe im Browser (720p, x264). VA-API und NVENC sind
  eingebaut, mangels Hardware hier aber nicht getestet.

**Neue Manifest-Funktionen** (auch für andere Addons):
- `builds`: Images aus einem Dockerfile im Addon bauen, Verweis per `image: "build:<name>"`.
- `devices` und `gpus` mit Bedingung `when: { option, equals }`, z. B. nur bei passender Encoder-Wahl.
- `provides.videoSources`: Gateways mit Status-Adresse und WebRTC-Basisadresse.

### Bildschirme

Bildschirme im Fahrzeug (z. B. Lagetisch, Monitor im Führungsraum) zeigen die Seite `/bildschirm`, im Kiosk-Browser
oder später in einer App (WebView). Was dort zu sehen ist, steuert man in ELVIS unter **Bildschirme**.

- **Koppeln (Admin):** `/bildschirm` öffnen, der Bildschirm zeigt einen 6-stelligen Code (10 Minuten gültig). Unter
  System → Bildschirme → „Bildschirm koppeln“ den Code und einen Namen eintragen. Der Bildschirm erhält ein dauerhaftes
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
  Szenen lassen sich umbenennen, überschreiben, sortieren und löschen. Sie bleiben unabhängig vom Einsatz erhalten,
  und jede Aktion landet im Bedienprotokoll. Beim Entkoppeln eines Bildschirms werden seine Szenen gelöscht.
- **Kacheln:** Lagekarte (Fahrzeug und Einsatzort, Kartenstil, Mittelpunkt, Mitführen, Zoom), Kamera (Livebild),
  Wetter, Uhr (DTG), Meldungen, Netzwerk (Router/Failover). Am Bildschirm bleiben sie bedienbar, z. B. lässt sich die
  Karte per Touch verschieben und zoomen.
- **Rechte:** Gekoppelte Bildschirme dürfen ohne Benutzeranmeldung zusätzlich den laufenden Einsatz lesen (für den
  Einsatzort auf der Karte), sonst nur, was auch anonyme Arbeitsplätze sehen.
- **Kiosk-Browser:** mit dauerhaftem Profil starten, nicht im Inkognito-Modus, sonst geht die Kopplung bei jedem
  Neustart verloren. Beispiel: `chromium --kiosk --noerrdialogs --disable-session-crashed-bubble http://<elvis>:8080/bildschirm`.
- Geplant: Android-App (Vollbild-WebView mit Autostart) und ein NDI-Viewer. Browser können NDI nicht direkt abspielen,
  dafür ist ein Umsetzer auf dem Server nötig, etwa nach WebRTC oder MJPEG.

### Kameras (Axis über VAPIX)

Modul „Kameras“: beliebig viele Kameras, angelegt unter **System → Kameras** (nur Admins). Je Kamera gibt es Name,
Typ (Axis oder Demo ohne Hardware), Adresse, Benutzer, Passwort und die Auflösung des Livebilds. „Verbindung testen“
zeigt Modell und Funktionen der Kamera.

- **Livebild:** ELVIS holt das MJPEG-Bild von der Kamera (Digest-Anmeldung, MD5 oder SHA-256) und reicht es an den
  Browser weiter (`/api/cameras/<id>/stream`). Zugangsdaten verlassen den Server nicht. Wie der Fahrzeugzustand ist das
  Bild auch für anonyme Arbeitsplätze sichtbar, bedienen können nur angemeldete Benutzer.
- **Bedienung je nach Kamera:** ELVIS erkennt beim Verbinden, welche Funktionen eine Kamera hat, und zeigt nur die passenden Bedienelemente. „Verbindung testen“ zeigt, welche Schnittstelle was übernimmt.
  - Neuere Kameras mit Motorobjektiv: Optics Control API (`opticscontrol.cgi`, Version wird ausgehandelt) für Zoom,
    Fokus, Autofokus und IR-Sperrfilter.
  - Ältere feste Kameras wie die **P3225-LVE Mk II** (an der echten Kamera geprüft): Zoom und Fokus über
    `opticssetup.cgi`. Der Zustand kommt über `monitor=poll` (XML, Werte 0…1), die Befehle `rzoom`/`rfocus` sind nur
    relativ, dazu `autofocus=perform`. Tag/Nacht läuft über den Parameter `ImageSource.I0.DayNight.IrCutFilter`
    (`yes`/`no`/`auto`). `ptz.cgi` meldet dort Standardgrenzen, ist aber abgeschaltet („PTZ disabled“) und wird
    ignoriert.
  - PTZ-Kameras über `ptz.cgi`: nur Befehle aus der Befehlsliste der Kamera (`info=1`). Schwenken/Neigen und Zoom
    per Gedrückthalten, Grundstellung.
  - Bewegungen stoppen spätestens 1,2 s nach dem letzten Befehl von selbst, auch wenn die Verbindung zum Tablet abreißt.
    Bewegungen per Gedrückthalten stehen nicht im Bedienprotokoll, alle anderen Befehle schon.
- **Gespeicherte Positionen** gehören zum laufenden Einsatz. ELVIS speichert die absolute Position (Schwenk, Neigung,
  Zoom, Fokus), nicht die Presets der Kamera. Bei Kameras mit nur relativen Befehlen fährt ELVIS die Differenz an:
  erst den Zoom, dann den Fokus, mit Nachkorrektur wegen des Getriebespiels. Wird der Einsatz beendet oder ein neuer eröffnet, ist die Liste leer.
  Die Einträge bleiben dem alten Einsatz zugeordnet.
- Für Zoom und Fokus über die Optics Control API und für Tag/Nacht über `param.cgi` braucht ELVIS ein Kamerakonto mit
  Administratorrechten. Für das Livebild reicht ein Konto mit geringeren Rechten.

### Wetterstation Airmar 150WX (NMEA 2000 über Actisense NGX-1)

Treiber `actisense-airmar`: liest die Station über ein Actisense-Gateway (NGX-1 oder NGT-1) am USB-Port.

```json
"devices": {
  "weather": { "driver": "actisense-airmar", "options": { "port": "/dev/ttyUSB0", "baudRate": 115200 } }
}
```

| Option | Standard | Bedeutung |
| --- | --- | --- |
| `port` | – | Serielle Schnittstelle, stabiler über `/dev/serial/by-id/…` |
| `baudRate` | `115200` | Baudrate des Gateways, 115200 oder 230400 (im Actisense Toolkit einstellbar) |
| `sourceAddress` | leer | Nur diese NMEA-2000-Adresse auswerten (bei mehreren Sensoren am Bus) |
| `setRxAll` | `true` | Gateway beim Verbinden in „NGT Transfer Rx All“ versetzen |

- **Protokoll:** BST-93 (empfangene NMEA-2000-Nachrichten, Fast-Packets vom Gateway zusammengesetzt). Beim Verbinden
  sendet ELVIS den Befehl „Rx All“, damit das Gateway alle PGNs weiterleitet. Ein NGX-1 im „CAN Packet Mode“
  (BST-95) wird nicht unterstützt und muss im Actisense Toolkit auf einen Transfer-Modus gestellt werden.
- **Ausgewertete PGNs:** 130306 (Wind), 130310–130314 (Temperatur, Luftfeuchte, Luftdruck), 129025 und 129029
  (Position, GPS-Fix), 127250 (Kurs).
  - Wahrer Wind bezogen auf Nord hat Vorrang. Sonst wird der scheinbare Wind über den Kurs auf Nord umgerechnet.
  - Mittelwind = 2-Minuten-Mittel, Böe = höchster 3-Sekunden-Mittelwert der letzten 10 Minuten (die Station sendet
    keine Böen).
  - Werte, die die Station nicht misst (z. B. Luftfeuchte ohne Feuchtemodul), bleiben leer.
- **Fahrzeugstandort:** Das GPS der Station liefert die Fahrzeugposition für Karte und Druck.
- **Verbindung:** Bei Abbruch verbindet sich der Treiber alle 5 s neu. Ohne Daten seit 15 s gilt die Station als nicht
  erreichbar (Meldung in ELVIS).
- **Docker:** Gerät in `deploy/compose.yaml` durchreichen (`devices`, `group_add: dialout`, siehe Kommentar dort).
- **Diagnose:** Zeigt live, welche PGNs von welcher Adresse ankommen und was ELVIS daraus liest:
  - Entwicklung: `npm run n2k:monitor -w @elvis/server -- /dev/ttyUSB0`
  - Container: `docker exec -it elvis node apps/server/dist/tools/n2k-monitor.js /dev/ttyUSB0`

## Benutzer und Anmeldung

- **Anmeldung:** Den eigenen Namen in der durchsuchbaren Liste wählen und die 4-stellige PIN eingeben, per
  Ziffernblock (Touch) oder Tastatur. Benutzernamen und Passwörter gibt es nicht. „Benutzer wechseln“ im
  Kontomenü ist für gemeinsam genutzte Arbeitsplätze gedacht.
- **Ersteinrichtung:** Beim allerersten Start legt man den ersten Benutzer an, er ist Admin. `deploy/install.sh` fragt
  ihn im Terminal ab.
- **Rechte:**
  - **Jeder Benutzer** darf alles Operative: Einsatz, Tagebuch, Kräfte, Dokumente, Fahrzeugbedienung, Druck. Er darf
    auch neue Benutzer anlegen, aber ohne Admin-Rechte.
  - **Nur Admins** dürfen das Admin-Flag vergeben, andere Benutzer bearbeiten oder löschen, deren PIN zurücksetzen
    und Addons sowie Docker-Hosts verwalten. Der letzte Admin kann weder herabgestuft noch gelöscht werden.
  - **Anonyme Arbeitsplätze** sehen den Fahrzeugbereich (Übersicht, Fahrzeugzustand, Karte, Wetter, Netzwerk,
    Medien) nur lesend. Einsatzdaten, Archiv, Benutzer und System erfordern eine Anmeldung. Der Server setzt das
    durch (`apps/server/src/auth/access.ts`). Unbekannte Endpunkte verlangen standardmäßig eine Anmeldung.
- **Sicherheit:**
  - Die PINs werden mit scrypt gehasht gespeichert.
  - Nach 3 Fehlversuchen wird der Benutzer gesperrt: zuerst 30 s, danach jeweils doppelt so lang, höchstens 15 min.
    Ein Gerät, das 10 Fehlversuche in 10 min erreicht, wird für 10 min gesperrt.
  - Sitzungen laufen über ein HttpOnly-Cookie und enden nach 12 h Inaktivität, spätestens nach 7 Tagen. Das Ändern
    oder Zurücksetzen der PIN beendet andere Sitzungen.
  - Eine 4-stellige PIN ist bewusst einfach gehalten. Sie schützt vor versehentlicher und unbefugter Bedienung im
    Fahrzeug, nicht vor einem gezielten Angriff aus einem offenen Netz.
- Einträge im Einsatztagebuch und im Bedienprotokoll tragen den Namen des angemeldeten Benutzers.

## Taktische Zeichen und Systemeinstellungen

- **Generator** (*Verwaltung → Taktische Zeichen*, auch ohne Anmeldung): Zeichen nach der Empfehlung „Taktische
  Zeichen im Bevölkerungsschutz“ (DV 102) zusammenstellen und als SVG herunterladen. Häufige Zeichen gibt es als
  Vorlagen.
  - Grundzeichen: taktische Einheit, Befehlsstelle (mit Fahnenmast), Stelle/Einrichtung, Person (Führer mit
    gefüllter Spitze), Fahrzeug (gewölbte Oberkante; ohne Antrieb, Kfz, geländegängig, Kette, Anhänger)
  - Organisationsfarben nach DV 102 Tabelle 2
  - Größenordnungen Trupp bis Großverband
  - Fachaufgaben Führung, Brandbekämpfung, Rettungswesen, Technische Hilfe, IuK, Betreuung, Logistik
  - Text im Zeichen, Organisationskürzel, Bezeichnung rechts
- **Umsetzung:** Das Zeichen wird einmal als Geometrie beschrieben (`packages/shared/src/tactical.ts`). Daraus
  entstehen das SVG im Browser und auf der Karte sowie die Vektorgrafik im Druck-PDF. Weitere Fachaufgaben werden in
  `functionSymbol()` ergänzt.
- **Systemeinstellungen** (*Verwaltung → System*): Fahrzeugname, Funkrufname, Einheit und das taktische Zeichen für
  den Fahrzeugstandort auf Karte und Druck. Ändern dürfen nur Admins, lesen dürfen alle. Ohne gespeicherte Werte
  gelten `vehicle` aus `config/elvis.json` und das Zeichen „ELW 2“ der Feuerwehr.

## Addons und Docker-Hosts

ELVIS kann zusätzliche Dienste (z. B. einen lokalen Kartenserver) als Docker-Container auf den Fahrzeug-Servern
betreiben, ähnlich dem Addon-System von Home Assistant. Abschaltbar über `"docker": { "enabled": false }`.

**Docker-Hosts** (*Verwaltung → Docker-Hosts*): ELVIS spricht direkt mit der Docker-Engine-API per TLS
(Port 2376, gegenseitige Zertifikatsprüfung). Beim Hinzufügen erzeugt ELVIS mit seiner eigenen kleinen CA ein
Server-Zertifikat und einen einmalig gültigen Befehl:

```bash
curl -fsS http://<elvis>:8080/api/docker/setup/<token>.sh | sudo sh
```

Das Skript legt die Zertifikate unter `/etc/docker/tls/` ab, ergänzt `dockerd` per systemd-Override um
`-H tcp://0.0.0.0:2376 --tlsverify …`, startet Docker neu und meldet sich bei ELVIS. Es ist wiederholbar, z. B. zur
Zertifikatserneuerung. Alternativ lassen sich vorhandene Zertifikate (CA, Client-Zertifikat, Schlüssel) eintragen.
CA und Client-Schlüssel von ELVIS liegen in `data/docker-tls/`.
**Port 2376 per Firewall nur aus dem Fahrzeug-LAN erreichbar machen.** Wer Zugriff auf die Docker-API hat, hat
Root-Rechte auf dem Server. Die Addon- und Host-Verwaltung ist daher Admins vorbehalten. Alle Aktionen stehen im
Bedienprotokoll.

**Docker-Host unter Windows/WSL (z. B. zum Testen):** Docker Desktop für Windows lässt sich nicht als Docker-Host
anbinden, weil seine Engine in einer eigenen VM läuft und keine TLS-Konfiguration erlaubt. Stattdessen Docker Engine
direkt in einer WSL2-Distribution (z. B. Ubuntu) betreiben:

1. In der Distribution systemd aktivieren: `/etc/wsl.conf` mit `[boot]` und `systemd=true` anlegen, in Windows
   `wsl --shutdown` ausführen und die Distribution neu starten.
2. In Docker Desktop unter *Settings → Resources → WSL Integration* die Integration für diese Distribution
   abschalten (oder Docker Desktop beenden), damit sich die beiden nicht in die Quere kommen.
3. Docker Engine installieren: `curl -fsSL https://get.docker.com | sudo sh`
4. Den Einrichtungsbefehl aus ELVIS in der Distribution ausführen.
5. **Adresse:** Läuft ELVIS auf demselben Rechner, die IP der Distribution verwenden (`hostname -I`). Von anderen
   Rechnern aus ist WSL2 standardmäßig nicht erreichbar (NAT). Unter Windows 11 hilft
   `networkingMode=mirrored` im Abschnitt `[wsl2]` der Datei `%UserProfile%\.wslconfig`, dann gilt die LAN-IP des
   Windows-Rechners. Port 2376 muss zusätzlich in der Windows-Firewall freigegeben sein.

**Addons** (*Verwaltung → Addons*): Repositories enthalten eine `repository.yaml` und je Addon ein Verzeichnis mit
`addon.yaml`. Die Addons liegen im eigenen Repository
[tel-diepholz/elvis-addons](https://github.com/tel-diepholz/elvis-addons):
- **Eingebaut (offline):** Das Repository ist als Git-Submodul unter `addons/` eingebunden. Nach einem Klonen ohne
  `--recurse-submodules` holt `git submodule update --init` es nach. Auch das Docker-Image enthält es.
- **Online:** Weitere Repositories (GitHub-Raw-URLs) stehen unter `"addons": { "repositories": [...] }` oder in
  `ELVIS_ADDON_REPOSITORIES` (kommagetrennt). Das Docker-Image trägt
  `https://raw.githubusercontent.com/tel-diepholz/elvis-addons/main` ein, damit neue Addon-Versionen ohne
  ELVIS-Update erscheinen. Gibt es ein Addon mehrfach, gewinnt die höhere Version, bei gleicher Version die eingebaute.
- **Addons aktualisieren:** `git submodule update --remote addons` holt den neuesten Stand ins eingebaute Repository.

Aus den `options` des Manifests erzeugt ELVIS das Konfigurationsformular.
Client und Server prüfen mit demselben Schema (`packages/shared/src/addons.ts`).

```yaml
id: hello
name: Hallo ELVIS
version: 1.0.0
arch: [amd64, arm64]
options:
  port: { type: int, label: Port auf dem Host, default: 8099, min: 1024, max: 65535 }
containers:
  - name: web
    image: traefik/whoami:v1.10          # besser per Digest festlegen
    env: { WHOAMI_PORT_NUMBER: "8080" }
    ports: [{ container: 8080, host: "{{options.port}}" }]
jobs:                                     # einmalige Container, z. B. Daten erzeugen
  stamp: { label: Zeitstempel, image: alpine:3.20, command: [...], volumes: [{ name: data, target: /data }] }
provides:                                 # Integration in ELVIS
  mapSources: [{ id: basic, name: Lokale Karte, url: "http://{{host.address}}:{{options.port}}/{z}/{x}/{y}.png" }]
```

- Optionstypen: `string`, `password`, `int`, `bool`, `select`, `ip`. Platzhalter: `{{options.*}}`,
  `{{addon.id}}`, `{{addon.version}}`, `{{host.address}}`, `{{host.name}}`.
- Daten liegen in benannten Volumes (`elvis-addon-<id>-<name>`) und bleiben bei Updates und Neukonfiguration
  erhalten. Privilegierte Container gibt es nicht. Host-Netzwerk, Capabilities und Ports werden vor der Installation
  angezeigt.
- Fehlt dem Zielhost das Internet, überträgt ELVIS das Image von einem anderen Host (`docker save` → `docker load`).
  Eine Registry ist nicht nötig.
- Laufende Addons mit `provides.mapSources` erscheinen automatisch als Kartenstil auf der Karte und im Druck.

**Labor:** `npm run test:lab` startet ELVIS und zwei Docker-Daemons (dind) und prüft den kompletten Ablauf gegen
echte Docker-APIs: TLS, Installation, Neukonfiguration, Job, Protokolle, Image-Übertragung, Deinstallation.
Voraussetzung: Docker und Node auf dem Entwicklungsrechner.

## Offene Punkte / nächste Schritte

- **TLS für die Weboberfläche:** Die Sitzungs-Cookies laufen im Fahrzeug-LAN derzeit über HTTP.
- Echte Treiber für die verbauten Systeme.
- Druckansicht/PDF für Einsatztagebuch und Kräfteübersicht, Backup/Export der Datenbank.

## Lizenz

ELVIS steht unter der [MIT-Lizenz](LICENSE). Addons laden Software Dritter erst bei der Installation und unter deren
eigenen Lizenzen, z. B. das NDI-Gateway die NDI-Laufzeit (NDI SDK License Agreement, nur nach Zustimmung).
