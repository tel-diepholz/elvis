# ELVIS – Einsatzleitwagen-Verwaltungs- und Informationssystem

Zentrale, responsive Weboberfläche für den ELW 2 der Freiwilligen Feuerwehr. ELVIS fasst die
Einzelsysteme des Fahrzeugs (Funk, Netzwerk, Medien, Wetterstation mit GPS – weitere folgen) und die
Einsatzführung (Einsatztagebuch, Kräfte, Dokumente) in einer Anwendung zusammen.

## Bereiche

| Bereich | Verfügbarkeit | Inhalt |
| --- | --- | --- |
| **Fahrzeug** | immer | Übersicht, Fahrzeugzustand, Karte, Wetter, Netzwerk, Medien |
| **Einsatz** | Unterseiten erst mit aufgelegtem Einsatz | Einsatztagebuch, Kräfteübersicht, Dokumente |
| **Verwaltung** | immer | Einsatzarchiv (schreibgeschützt); nur Admins: Bedienprotokoll, Einstellungen |

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

Hardware des Fahrzeugs (Airmar am USB, Bluetooth …) kommt nicht in `deploy/compose.yaml`, sondern in
`deploy/compose.override.yaml`. Die Datei ist nicht im Git, `git pull` bleibt also konfliktfrei:

```bash
cp deploy/compose.override.example.yaml deploy/compose.override.yaml   # anpassen
sudo sh deploy/install.sh            # berücksichtigt die Datei; alternativ: cd deploy && docker compose up -d --build
```

Wer `deploy/compose.yaml` schon angepasst hat: Änderungen in die Override-Datei übernehmen, dann
`git checkout deploy/compose.yaml` und `git pull`.

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

## Wetter

Die Seite „Wetter“ zeigt für den Fahrzeugstandort (GPS der Wetterstation, ohne GPS der Einsatzort) die
**amtlichen Warnungen des DWD** (Gemeinde-Warngebiet, über [Bright Sky](https://brightsky.dev)) und eine
**Prognose** von [Open-Meteo](https://open-meteo.com): aktuelle Lage, die nächsten 24 Stunden und 7 Tage.
Böen ab 70 % bzw. 100 % von `alerts.stormWarnMs` werden hervorgehoben. Darunter stehen die Live-Werte der
Wetterstation, sofern das Modul aktiv ist.

Das Backend fragt beide Dienste ab (Standort auf ca. 1 km gerundet) und hält die Antworten vor – Prognose
15 Minuten, Warnungen 5 Minuten. Ist ein Dienst nicht erreichbar, bleibt der letzte Stand bis zu 12 Stunden sichtbar.
Unwetterwarnungen (Stufe 3, Stufe 4 als Alarm) erscheinen zusätzlich unter „Meldungen“; Bildschirme zeigen
Warnungen und Prognose in den Kacheln „Wetter“ und „Wettervorhersage“.

```json
"weather": { "forecastUrl": "https://api.open-meteo.com", "warningsUrl": "https://api.brightsky.dev" }
```

`null` schaltet den jeweiligen Dienst ab.

## Ausbreitungsberechnung (Karte)

Über „Objekte“ in der Karte lassen sich beliebig viele **Gauß-Fahnen** und schematische **60°-Sektoren** in
Windrichtung einfügen – per Tipp in die Karte oder direkt am Einsatzort. Ihre Einstellungen stehen in der
Objektliste. Wind und Richtung kommen live von der Wetterstation.

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

**Bedienung:** Oben links stehen Suche, das Menü „Objekte“ (Einsatzort setzen, Gauß-Fahne oder Sektor 60°
einfügen) und „Drucken“, oben rechts die Wahl des Kartenstils, unten links der Wind. Rechts liegt die einklappbare
**Objektliste** des laufenden Einsatzes: an erster Stelle das eigene Fahrzeug (nur ausblendbar), dann Einsatzort,
Ausbreitungen und übernommene Suchtreffer. Ein Klick fliegt
hin; Objekte lassen sich ein- und ausblenden, einstellen, einfärben (Flächen, Punkte, Sektoren – Gauß-Fahnen
behalten ihre Stufenfarben) und entfernen. Die Objekte gehören zum Einsatz
(`/api/incidents/:id/objects`): Alle Arbeitsplätze und die Kartenkacheln der Bildschirme sehen sie, sie erscheinen
im Druck, Hinzufügen und Entfernen stehen im Einsatztagebuch, und nach dem Einsatz bleiben sie im Archiv lesbar.

**Ortssuche:** Das Suchfeld oben links in der Karte findet Straßen, Orte und Adressen. Treffer in der Nähe der
Kartenmitte stehen vorn. Ein Treffer fliegt die Karte an, setzt eine Markierung mit UTMREF und lässt sich per
„Zur Objektliste“ (mit Umriss als Fläche, sonst als Punkt) oder „Als Einsatzort setzen“ übernehmen. Bei Orten, Ortsteilen und Landkreisen zeigt die Karte zusätzlich den Umriss,
sofern er in OpenStreetMap als Grenze erfasst ist (manche Ortsteile sind dort nur ein Punkt). Koordinaten erkennt ELVIS selbst, auch ohne Internet: Dezimalgrad
(`52.70986, 8.50425`), Grad/Minuten/Sekunden (`N 52° 42.591' E 8° 30.255'`), UTM (`32U 466507 5840110`) und
UTMREF/MGRS (`32U MD 66507 40110`). Gesucht wird über den Server (`GET /api/map/search`):

1. Läuft das Addon **OSM-Daten** (eigenes Nominatim mit den OSM-Daten der gewählten Regionen), fragt ELVIS zuerst dort –
   Suche und Umrisse funktionieren dann komplett offline. Dasselbe Addon liefert aus denselben Daten auch die lokale
   Karte, Routing (Valhalla) und eine Overpass-API. Es aktualisiert sich nicht selbst: Regionen in der Konfiguration
   ergänzen und den Job „Kartendaten bauen“ starten – geladen und in die Suche nachimportiert wird nur, was neu ist.
2. Findet es nichts (Nominatim erkennt halb getippte Wörter oft nicht) oder läuft kein Addon, fragt ELVIS den
   öffentlichen Dienst [photon.komoot.io](https://photon.komoot.io), einstellbar über `"map": { "geocoderUrl": "…" }`
   (`null` = nur lokal). Treffer bleiben einen Tag im Speicher und helfen auch bei kurzen Ausfällen.
3. Umrisse ohne Addon kommen vom öffentlichen Nominatim (`"map": { "outlineUrl": "…" }`, höchstens eine Anfrage je
   Sekunde). Jeder geladene Umriss bleibt in `data/outlines/` und steht danach auch offline zur Verfügung.

**Lagekarte drucken:** Auf der Karte öffnet „Drucken“ einen Dialog mit Format (A4/A3/A2/A1), Ausrichtung,
Zoomstufe (mit Maßstabsangabe) und Kartenstil. In der Vorschau wird der Ausschnitt gewählt, indem man die Karte
unter dem Druckrahmen verschiebt. Fahrzeugstandort, Einsatzort und die sichtbaren Kartenobjekte lassen sich
einzeln zuschalten.
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
**Einstellungen → Fahrzeugmodule**. Jedes Modul ist dort ein aufklappbarer Abschnitt. Die Kopfzeile zeigt Zustand und
Treiber, aufgeklappt folgen die Einstellungen und darunter die Geräte des Moduls (z. B. Kameras, Accesspoints,
Monitoring-Ziele, Bluetooth-Geräte):

- Modul aktivieren oder deaktivieren. Ein deaktiviertes Modul erzeugt keine Meldungen, und seine Seite zeigt einen Hinweis.
- Treiber wählen, z. B. „Simulation“ oder „Airmar über Actisense“. Das Formular mit den Treiber-Einstellungen
  entsteht aus der Treiberdefinition. Serielle Schnittstellen liest ELVIS vom Server aus und bietet sie als Auswahl an,
  USB-Geräte bevorzugt unter ihrem stabilen Namen `/dev/serial/by-id/…`. Ein eigener Pfad ist ebenfalls möglich.
- „Übernehmen“ startet den Treiber sofort neu, ohne dass ELVIS neu gestartet werden muss. Gespeichert wird die
  Einstellung in der Datenbank, und jede Änderung landet im Bedienprotokoll.

`config/elvis.json` (`devices`) liefert nur die Vorgaben, solange in der Oberfläche nichts gespeichert wurde.
Ohne Angabe läuft der Simulator (`sim`). Neue Treiber, z. B. weitere Wetterstationen, werden in
`apps/server/src/devices/drivers.ts` eingetragen und erscheinen dann automatisch in der Auswahl.

Läuft ELVIS im Container, muss das USB-Gerät durchgereicht werden (`devices:` in `deploy/compose.override.yaml`, Vorlage
`deploy/compose.override.example.yaml`).

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
- **Kacheln:** Lagekarte (Fahrzeug und Einsatzort, Kartenstil, Mittelpunkt, Mitführen, Zoom), Kamera (Livebild),
  Wetter (mit amtlichen Warnungen), Wettervorhersage (24 Stunden und/oder 7 Tage), Uhr (DTG), Meldungen, Netzwerk (Router/Failover), Gast-WLAN (QR-Code, Netzname und Passwort des Gastnetzes
  im laufenden Einsatz, siehe „WLAN“). Eine mitgeführte Karte folgt Fahrzeug bzw. Einsatzort und
  lässt sich nicht verschieben. Ohne Mitführen lässt sie sich am Bildschirm per Touch und unter „Bildschirme“ direkt in
  der Vorschau verschieben und zoomen – der Bildschirm folgt und behält den Ausschnitt, auch nach „Neu laden“.
- **Rechte:** Gekoppelte Bildschirme dürfen ohne Benutzeranmeldung zusätzlich den laufenden Einsatz lesen (für den
  Einsatzort auf der Karte) und das Gastnetz (Kachel „Gast-WLAN“), sonst nur, was auch anonyme Arbeitsplätze sehen.
- **Kiosk-Browser:** mit dauerhaftem Profil starten, nicht im Inkognito-Modus, sonst geht die Kopplung bei jedem
  Neustart verloren. Beispiel: `chromium --kiosk --noerrdialogs --disable-session-crashed-bubble http://<elvis>:8080/bildschirm`.
- **Smart-TV / Android:** Die App [ELVIS Bildschirm](https://github.com/tel-diepholz/elvis-tv) zeigt `/bildschirm` im
  Vollbild, startet auf Wunsch nach dem Einschalten und fragt beim ersten Start nach der Adresse des Servers. Den
  Download-Link der neuesten APK zeigt ELVIS unter *Einstellungen → Bildschirme* beim Koppeln
  (`https://github.com/tel-diepholz/elvis-tv/releases/latest/download/elvis-tv.apk`).

### Kameras (Axis über VAPIX)

Modul „Kameras“: beliebig viele Kameras, angelegt unter **Einstellungen → Kameras** (nur Admins). Je Kamera gibt es Name,
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

### WLAN (OpenWrt-Accesspoints)

Unter **Einstellungen → WLAN-Accesspoints** (nur Admins) beliebig viele OpenWrt-Geräte anlegen: Adresse, Konto (meist
`root`), das Netz für das Betriebs-WLAN (meist `lan`) und die **Gastnetz-Bridge** (z. B. `br-guests`). Angegeben
werden kann jeweils eine OpenWrt-Schnittstelle (`lan`), eine Bridge (`br-lan`) oder ein Bridge-Port (`eth0`). Die Bridge
muss auf dem AP bereits eingerichtet sein; hat sie noch keine Schnittstelle (nur unter *Netzwerk → Geräte* angelegt),
legt ELVIS dafür die Schnittstelle `elvis_guest` (ohne IP) an und entfernt sie mit dem Gastnetz wieder. Leer = auf
diesem AP kein Gastnetz.

- **Zugriff:** wie LuCI über ubus/JSON-RPC (`/ubus`, Paket `uhttpd-mod-ubus`, bei LuCI dabei); Änderungen werden mit
  `uci apply` übernommen (das root-Konto von LuCI darf kein `uci commit`). ELVIS legt je Funkmodul
  eigene WLANs an (`elvis_ops_<radio>`, `elvis_guest_<radio>`, WPA2), schaltet ausgeschaltete Funkmodule ein und lässt
  alle anderen WLANs unverändert. Geschrieben und neu geladen wird nur bei Abweichungen; der Abgleich läuft bei jeder
  Änderung und jede Minute (holt zurückgesetzte APs wieder auf den Sollstand). „Jetzt übertragen“ stößt ihn sofort an.
- **Betriebs-WLAN** (Einstellungen → WLAN-Accesspoints): Netzname und Passwort, dauerhaft auf allen aktiven APs.
- **Gastnetz:** einschaltbar mit eigenem Netznamen. Sobald ein Einsatz eröffnet ist, richtet ELVIS es auf allen APs
  mit Gastnetz-Bridge ein – Netzname mit angehängter Einsatznummer (`Gast-12`), Passwort je Einsatz neu erzeugt, Clients
  untereinander abgeschottet. Mit Ende des Einsatzes verschwindet es wieder.
- **Fahrzeugmodul „WLAN-Accesspoints“** (Treiber *OpenWrt*, unter *Einstellungen → Fahrzeugmodule*): fragt alle aktiven APs
  im Hintergrund ab (Vorgabe alle 10 s, `iwinfo assoclist`, Zuordnung der WLANs über `luci-rpc`) und schreibt die
  angemeldeten Geräte in die Tabelle `wifi_clients` – nur der aktuelle Stand, abgemeldete Geräte verschwinden. Unter
  *Netzwerk* zeigen zwei Tabellen (nur angemeldet) daraus die Geräte im Betriebs-WLAN und im Gastnetz mit AP, Band,
  Signal, Datenrate und Verbindungsdauer. Namen und IPs kommen aus den Host-Hinweisen des APs und, falls das Modul
  ELW-Router läuft, aus dessen DHCP-Leases.
- **Alarm:** Antwortet ein AP nicht, meldet das Modul „Accesspoint … nicht erreichbar“ (Alarm); seine Geräte bleiben
  bis zur nächsten erfolgreichen Abfrage mit dem letzten Stand stehen.
- Entfernte oder deaktivierte APs fasst ELVIS nicht mehr an; dort bereits eingerichtete WLANs bleiben bestehen.
- Ergebnis und Fehler je AP (nicht erreichbar, Anmeldung abgelehnt, Gastnetz-Bridge fehlt) stehen in der Liste;
  Übertragungen und neue Fehler im Bedienprotokoll.

### Monitoring (SNMP, Node Exporter)

Das Modul „Monitoring“ fragt Geräte im Fahrzeugnetz regelmäßig ab (Vorgabe alle 30 s, einstellbar unter
Fahrzeugmodule). Die Ziele legen Admins unter **Einstellungen → Monitoring** an, „Verbindung testen“ zeigt die Messwerte
vor dem Speichern. Den aktuellen Stand sehen alle auf der Seite **Monitoring**, Auffälligkeiten stehen in der Meldungsleiste.

| Art | Abfrage | Fest eingebaute Prüfungen |
| --- | --- | --- |
| Drucker (SNMP) | SNMP v1/v2c, Port 161 | Zustand, Störungen aus `hrPrinterDetectedErrorState` (Papierstau, kein Papier, Klappe offen …), Füllstände aus der Drucker-MIB (Warnung unter x %) |
| Gerät (SNMP) | SNMP v1/v2c, Port 161 | nur Name und Laufzeit, Messwerte über eigene Prüfungen |
| Rechner (Node Exporter) | `http://<host>:9100/metrics` | Last je Kern, freier Arbeitsspeicher, freier Platz je Dateisystem, höchste Temperatur |

Zusätzlich lassen sich je Ziel **eigene Prüfungen** anlegen: eine OID (SNMP) bzw. eine Metrik mit Labels
(`node_filesystem_avail_bytes{mountpoint="/data"}`), dazu ein Faktor, eine Einheit und Grenzen für Warnung und Alarm
(jeweils „unter“ und „über“, leer bedeutet keine Prüfung).

**Dauerhaft eingeschaltet:** Ist ein Gerät so markiert und antwortet zweimal in Folge nicht, gibt es einen Alarm.
Ohne diese Markierung (z. B. ein Drucker, der nur im Einsatz eingeschaltet wird) gilt „nicht erreichbar“ als
ausgeschaltet. Dann gibt es keine Meldung, und die letzten Messwerte werden nur noch grau angezeigt. Gemeldet werden
nur Probleme in den Messwerten, solange das Gerät läuft.

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
- **Docker:** Gerät in `deploy/compose.override.yaml` durchreichen (`devices`, `group_add: dialout`, siehe Vorlage
  `deploy/compose.override.example.yaml`).
- **Diagnose:** Zeigt live, welche PGNs von welcher Adresse ankommen und was ELVIS daraus liest:
  - Entwicklung: `npm run n2k:monitor -w @elvis/server -- /dev/ttyUSB0`
  - Container: `docker exec -it elvis node apps/server/dist/tools/n2k-monitor.js /dev/ttyUSB0`

### Bluetooth: Victron-Akkus und weitere Geräte

Modul **Bluetooth** (System Energie, Seite **Energie**): ELVIS liest über den Bluetooth-Dongle des Servers die
Werbepakete der eingetragenen Geräte mit. Gekoppelt wird nicht, die Geräte senden ihre Werte von selbst, und
VictronConnect lässt sich weiter parallel nutzen.

- **Geräte** unter *Einstellungen → Bluetooth*: Name, Geräteart, Bluetooth-Adresse, Schlüssel und optional eine
  Spannungsgrenze für eine Warnung. Victron-Geräte, die in Reichweite senden, aber noch nicht eingetragen sind,
  erscheinen unter „In der Nähe gefunden“ und lassen sich mit Adresse und Namen übernehmen.
- **Victron Instant Readout:** Im Gerät muss „Instant Readout über Bluetooth“ eingeschaltet sein. Den Schlüssel zeigt
  VictronConnect: Gerät → Einstellungen (Zahnrad) → ⋮ → Produktinfo → *Verschlüsselungsdaten anzeigen*. Die Art des
  Geräts erkennt ELVIS selbst:

  | Gerät | Werte |
  | --- | --- |
  | Lithium Battery Smart (LiFePO4) | Spannung, Zellspannungen, Temperatur, Zellausgleich, Fehler |
  | SmartShunt, BMV | Ladezustand, Spannung, Strom, Restlaufzeit, entnommene Ah, Hilfseingang, Alarme |
  | SmartSolar/BlueSolar MPPT | Solarleistung, Ladestrom, Batteriespannung, Ertrag heute, Ladephase |
  | Orion Smart (DC/DC) | Ein- und Ausgangsspannung, Zustand |
  | Blue Smart / Phoenix Smart Ladegerät | Ausgänge (Spannung, Strom), Temperatur, Zustand |

  Eine Lithium Battery Smart meldet keinen Ladezustand und keinen Strom. Dafür braucht es einen SmartShunt oder BMV.
- **Meldungen:** „kein Empfang“ (Warnung) nach der eingestellten Zeit ohne Paket, Schlüssel passt nicht (Warnung),
  Batteriefehler und Zellspannung außerhalb des Bereichs (Alarm), Alarme des Batteriemonitors (Alarm), Störung eines
  Ladereglers (Warnung) und Unterschreiten der eigenen Spannungsgrenze (Warnung). Ist der Bluetooth-Adapter nicht
  nutzbar, meldet ELVIS „Bluetooth nicht erreichbar“ mit dem Grund auf der Seite Energie und versucht es alle 15 s erneut.
- **Treiber:** „Simulation“ (Vorgabe) oder „Bluetooth-Adapter des Servers (BlueZ)“ mit Adapter (`hci0`) und der Zeit
  bis „kein Empfang“. ELVIS spricht dazu bluetoothd des Hosts über den D-Bus-System-Bus an. Es braucht keine
  besonderen Rechte und kein Host-Netzwerk.
- **Server vorbereiten:**
  1. BlueZ installieren und starten: `sudo apt install bluez`, `sudo systemctl enable --now bluetooth`. Adapter
     prüfen mit `bluetoothctl list` (bzw. `rfkill unblock bluetooth`, falls blockiert).
  2. Freigabe für den ELVIS-Benutzer (UID 1000 im Container):
     `sudo cp deploy/bluetooth/elvis-bluetooth.conf /etc/dbus-1/system.d/ && sudo systemctl reload dbus`
  3. In `deploy/compose.override.yaml` den Socket durchreichen (`/run/dbus/system_bus_socket`, ist in der Vorlage
     schon eingetragen) und `sudo sh deploy/install.sh` bzw. `cd deploy && docker compose up -d` ausführen.
  4. Unter *Einstellungen → Fahrzeugmodule* beim Modul Bluetooth den Treiber BlueZ wählen.
- **Weitere Geräte:** Neue Gerätearten kommen in `packages/shared/src/bluetooth.ts` (`BluetoothKind`) und als
  Auswertung der Herstellerdaten in `apps/server/src/devices/drivers/bluetooth.ts` hinzu.

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

## Taktische Zeichen und Einstellungen

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
- **Einstellungen** (*Verwaltung → Einstellungen*, nur Admins): aufklappbare Abschnitte in den Gruppen Fahrzeug,
  Fahrzeugmodule, Dienste und Einsatz. Links aus anderen Seiten öffnen den passenden Abschnitt direkt, z. B.
  `/einstellungen#modul-bluetooth` oder `/einstellungen#scannen`. Die alte Adresse `/system` leitet dorthin um.
  - *Fahrzeug & Einheit:* Fahrzeugname, Funkrufname, Einheit und das taktische Zeichen für den Fahrzeugstandort auf
    Karte und Druck. Ohne gespeicherte Werte gelten `vehicle` aus `config/elvis.json` und das Zeichen „ELW 2“ der
    Feuerwehr.
  - Das Farbschema stellt jeder über das Symbol oben rechts um.
- **Bedienprotokoll** (*Verwaltung → Bedienprotokoll*, nur Admins): die letzten 100 Bedienvorgänge.

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

**Neue IP-Adresse:** Hat ein Server eine neue IP-Adresse oder einen neuen Namen bekommen, beides unter *Bearbeiten*
am Host ändern. Installierte Addons bleiben erhalten. Bei ELVIS-Zertifikaten stehen Name und Adresse im
Serverzertifikat. ELVIS zeigt deshalb nach dem Speichern einen neuen Einrichtungsbefehl, der auf dem Server ausgeführt
werden muss (`PATCH /api/docker/hosts/:id`).

**Host entfernen:** Ein Host, auf dem noch Addons eingetragen sind, lässt sich nach einer zweiten Bestätigung trotzdem
entfernen (`DELETE …?force=true`), z. B. wenn der Server nicht mehr existiert. Die Addons werden dann nur aus ELVIS
ausgetragen. Container und Volumes auf dem Server bleiben unberührt.
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
  `{{addon.id}}`, `{{addon.version}}`, `{{addon.secret}}` (je Addon festes Geheimnis, z. B. für Rückrufe an ELVIS),
  `{{host.address}}`, `{{host.name}}`.
- Daten liegen in benannten Volumes (`elvis-addon-<id>-<name>`) und bleiben bei Updates und Neukonfiguration
  erhalten. Privilegierte Container gibt es nicht. Host-Netzwerk, Capabilities und Ports werden vor der Installation
  angezeigt.
- Fehlt dem Zielhost das Internet, überträgt ELVIS das Image von einem anderen Host (`docker save` → `docker load`).
  Eine Registry ist nicht nötig.
- Laufende Addons mit `provides.mapSources` erscheinen automatisch als Kartenstil auf der Karte und im Druck.
  `provides.geocoders` (`{ id, name, type: photon|nominatim, url }`) ersetzt den öffentlichen Suchdienst der
  Ortssuche; bei Nominatim auch für Umrisse. `provides.routers` (`{ id, name, type: valhalla, url }`) und
  `provides.overpass` (`{ id, name, url }`) melden Routing und Overpass (noch ohne Nutzung in der Oberfläche).
  `provides.office` (`{ id, name, url, wopiBase }`) meldet einen
  Office-Server mit WOPI (Collabora) für die Dokumentbearbeitung. `shmSize` (z. B. `"1g"`) vergrößert `/dev/shm`, etwa für PostgreSQL.
- Ein Job-Schritt mit `stopContainers: [<name>]` hält diese Container des Addons für die Dauer des Schritts an, etwa
  wenn Job und Dienst dieselbe Datenbank nutzen. Danach (auch nach einem Fehler) laufen sie wieder.

**Labor:** `npm run test:lab` startet ELVIS und zwei Docker-Daemons (dind) und prüft den kompletten Ablauf gegen
echte Docker-APIs: TLS, Installation, Neukonfiguration, Job, Protokolle, Image-Übertragung, Deinstallation.
Voraussetzung: Docker und Node auf dem Entwicklungsrechner.

## Dokumente, Vorlagen und Collabora

- **Ordner je Einsatz:** Beim Eröffnen erhält jeder Einsatz eine Ordnerstruktur, die Admins unter *Einstellungen →
  Ordnervorgabe für Dokumente* festlegen. Die Struktur ist virtuell: Ordner gibt es nur in der Datenbank, die Dateien
  liegen flach unter `data/documents/<uuid>`. Benutzer können Ordner ergänzen, aber keine löschen. Admins dürfen nur
  leere, selbst angelegte Ordner entfernen, etwa zur Korrektur eines Tippfehlers. Spätere Änderungen an der Vorgabe
  gelten nur für neue Einsätze.
- **Vorlagen** (*Verwaltung → Vorlagen*, nur Admins): Vorlagen liegen in einem eigenen Ordnerbaum. Jede Vorlage legt
  fest:
  - einen **Ablageort** im Einsatz, etwa `Lagemeldungen/{{datum.iso}}`; fehlende Ordner werden angelegt
  - einen **Dateinamen**, etwa `Lagemeldung {{ordner.laufnummer}}`
  - ob Platzhalter auch **im Dokument** ersetzt werden (docx, xlsx, pptx, odt, ods, odp). Word zerlegt Platzhalter
    oft in mehrere Textläufe; das wird berücksichtigt. Unbekannte Platzhalter bleiben im Text stehen.

  Verfügbare Platzhalter: `einsatz.*`, `datum.*`, `benutzer.name`, `fahrzeug.*` und `ordner.laufnummer`. Die
  vollständige Liste steht in `packages/shared/src/documents.ts` und im Formular.
- **Arbeiten im Einsatz** (*Einsatz → Dokumente*):
  - **Aus Vorlage:** Vorlage suchen (Name, Beschreibung, Ordner) und öffnen. ELVIS legt eine Kopie am Ablageort an
    und öffnet sie in Collabora.
  - **Neues Dokument:** Text, Tabelle, Präsentation oder Zeichnung, mit frei gewähltem Ordner.
  - **Hochladen:** in den gewählten Ordner, wie bisher.
  - Neu erstellte Dokumente sind **Entwürfe**: Nur der Ersteller sieht sie, bis Collabora sie zum ersten Mal speichert.
    Ab dann sehen alle das Dokument und können es gleichzeitig bearbeiten. Nie gespeicherte Entwürfe verfallen nach
    24 h.
- **Collabora (Addon „Office (Collabora)“):**
  - ELVIS ist der WOPI-Host (`/api/wopi/files/…`). Collabora holt und speichert die Dateien dort mit einem
    Zugriffstoken. Das Token gilt für eine Datei und einen Benutzer, 10 h lang.
  - Bei abgeschlossenen Einsätzen ist nur Lesen möglich.
  - Die Option **Adresse von ELVIS** muss vom Docker-Host aus erreichbar sein. Der Browser lädt den Editor direkt vom
    Docker-Host (Port 9980). Läuft ELVIS künftig über HTTPS, braucht auch Collabora TLS, sonst blockiert der Browser
    den gemischten Inhalt.
  - Ohne laufendes Addon bleiben Hochladen, Anzeigen und Herunterladen möglich; „Neues Dokument“ und die Bearbeitung
    im Browser sind dann gesperrt.

## Druckserver

- **Addon „Druckserver (CUPS)“:** Es betreibt die Drucker, entweder im Fahrzeug-LAN oder per USB (Option „USB-Drucker
  durchreichen“). Drucker richtet man auf zwei Wegen ein:
  - in der CUPS-Verwaltung unter `http://<Docker-Host>:631/admin` (Benutzer `admin`, Passwort aus den Addon-Optionen), auch mit Treiber
  - über die Option **Drucker** (`Name=ipp://192.168.1.50/ipp/print, …`). Fehlende Drucker legt das Addon beim Start als IPP-Everywhere-Drucker an.

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
- Gedruckte Lagekarten und Dokumente landen wie jeder Druck im eingestellten Ablageordner.
- **Technik:** ELVIS spricht IPP direkt mit CUPS (`apps/server/src/services/ipp.ts`) und braucht dafür keine weitere
  Bibliothek. Addons melden Druckserver über `provides.printServers` (`{ id, name, url }`). Endpunkte:
  `GET /api/printing`, `POST /api/printing/jobs` (Multipart: `options` als JSON, dann `file`) und
  `GET /api/printing/jobs/:ref`; Gastdrucker: `GET /api/printing/guest`, `GET …/:id/file`, `POST …/:id/release`,
  `DELETE …/:id`.
- **Ablage** (*Einstellungen → Druckserver*, nur Admins): Ist ein Einsatz eröffnet, landet jeder Druck als PDF in dessen
  Dokumentverwaltung. Der Ablageort lässt sich mit Platzhaltern wie bei Vorlagen festlegen (Vorgabe `Drucke`), fehlende
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
    nach 24 Stunden gelöscht. Höchstzahl Kopien je Auftrag einstellbar; Vorgabe: nur annehmen, solange das Gast-WLAN
    läuft (Einsatz eröffnet). Ablage, Bedienprotokoll und Einsatztagebuch wie bei jedem Druck.
  - **Netz:** Der Docker-Host braucht eine Adresse im Gastnetz (z. B. VLAN-Schnittstelle `eth0.20`). Diese
    Schnittstelle in der Option „Netzwerkschnittstelle zum Gastnetz“ eintragen: CUPS und avahi laufen dann nur dort.
    Außerdem „Adresse von ELVIS“ eintragen (wie der Docker-Host ELVIS erreicht). Per Firewall aus dem Gastnetz nur
    den Gastdrucker-Port (TCP 8631) und mDNS (UDP 5353) zum Docker-Host freigeben, nicht ELVIS oder Port 631.
  - Kein TLS (`ipps`) und kein WSD: Windows vor 10 21H2 findet den Drucker unter Umständen nicht.

## Scannen (Scan-Eingang)

Multifunktionsgeräte wie der HP Color LaserJet Pro MFP 3302sdwg schicken Scans per **Scan an E-Mail** direkt an ELVIS.
ELVIS betreibt dafür einen eigenen SMTP-Empfänger (Port 2525, `scan.smtpPort` in der Konfiguration bzw.
`ELVIS_SCAN_PORT`, `off` schaltet ihn ab). Weitere Dienste braucht es nicht.

- **Scan-Eingang** (*Fahrzeug → Scan-Eingang*, angemeldet): Jeder PDF-Anhang wird ein Scan mit Absender, Betreff und
  Zeit. Ansehen, herunterladen, aus dem Eingang löschen oder nachträglich im laufenden Einsatz ablegen. Scans im Eingang
  werden nach der eingestellten Frist (Vorgabe 14 Tage) gelöscht; abgelegte Dokumente bleiben im Einsatz.
- **Ablage:** Ist ein Einsatz eröffnet, legt ELVIS jeden Scan zusätzlich in dessen Dokumentverwaltung ab (Vorgabe
  `Scans/{{datum.iso}}`, Platzhalter wie bei Vorlagen) und vermerkt das im Einsatztagebuch.
- **Einstellungen** (*Einstellungen → Scannen*, nur Admins): Annahme an/aus, Ablage, erlaubte Geräte (IP-Adressen) und
  optional SMTP-Anmeldung (PLAIN/LOGIN). Mails ohne PDF-Anhang lehnt ELVIS ab, das Gerät zeigt dann einen Fehler.
- **HP-Drucker einrichten:** Embedded Web Server des Druckers öffnen → *Scannen* → *Scan an E-Mail* → *Ausgehende
  E-Mail-Profile*: SMTP-Server = Adresse des ELVIS-Servers, Port 2525, SSL/TLS aus, ggf. Authentifizierung mit den
  Zugangsdaten aus ELVIS. Absender beliebig (z. B. `scanner@elvis`), im Adressbuch einen Empfänger wie `scan@elvis`
  anlegen (die Adresse selbst spielt keine Rolle) und als Dateityp PDF wählen.
- **Sicherheit:** Der SMTP-Empfänger nimmt nur Scans an und leitet nichts weiter. Ohne STARTTLS gehen Scans und
  Anmeldung unverschlüsselt durchs Netz – Port 2525 sollte nur aus dem Fahrzeug-LAN erreichbar sein, am besten nur
  für die IP des Druckers freigegeben.
- **Technik:** `smtp-server` und `mailparser` (`apps/server/src/services/scanning.ts`). Endpunkte: `GET /api/scans`,
  `GET /api/scans/:id/file`, `POST /api/scans/:id/assign`, `DELETE /api/scans/:id`, `GET|PUT /api/system/scanning`.

## Arbeitsplätze (PXE)

Das Addon **„ELVIS Arbeitsplatz (PXE)“** installiert Notebooks per Netzwerkstart mit einem Ubuntu-System (24.04 LTS,
KDE Plasma). Man meldet sich dort mit den Benutzern und PINs aus ELVIS an.

- **Abbild bauen** (Job beim Installieren des Addons, einmalig mit Internet): `mmdebstrap` baut das Arbeitsplatz-System
  (`rootfs.tar.zst`), den Installer (Live-System mit `live-boot`, wird per HTTP in den RAM geladen) und die
  Startdateien für den Netzwerkstart. Danach läuft die Installation ganz ohne Internet. Der Bau läuft
  mit `SYS_ADMIN` und **ohne AppArmor-Profil** (neues Manifestfeld `apparmor: unconfined`, wird vor der Installation
  angezeigt), aber nie privilegiert.
- **Netzwerkstart:** Der Container `pxe` (Netzwerk des Hosts) betreibt dnsmasq als **ProxyDHCP** und TFTP sowie nginx
  (Option „HTTP-Port“, Vorgabe 8089). Adressen vergibt weiter der Router, dnsmasq ergänzt nur die Startangaben.
  - **UEFI:** shim und GRUB, von Ubuntu signiert. Das funktioniert auch mit Secure Boot.
  - **BIOS:** lpxelinux.
  - Das Startmenü wählt nach 10 Sekunden **„Von Festplatte starten“**. Installiert wird nur, wenn man das ausdrücklich
    auswählt.
- **Installer** (Textoberfläche auf dem Notebook): Er fragt immer ab:
  - die **Zielplatte**: Liste mit Größe, Modell, Anschluss und den vorhandenen Partitionen, USB-Sticks markiert
  - das **Ziel des Bootloaders**:
    - UEFI: eine neue EFI-Partition auf der Zielplatte oder eine vorhandene EFI-Partition (Dual-Boot); außerdem, ob
      ein UEFI-Booteintrag angelegt wird und/oder der Standardpfad `EFI/BOOT/BOOTX64.EFI` genutzt wird
    - BIOS: den MBR einer gewählten Platte
  - den Rechnernamen

  Danach folgt eine Zusammenfassung, und man muss **JA** eintippen. Bis dahin wird nichts verändert. Vor dem Löschen
  registriert sich das Notebook bei ELVIS. Ist ELVIS nicht erreichbar, bleibt die Platte unberührt.
- **Installer-ISO** (ohne PXE): *Einstellungen → Arbeitsplätze → Installer-ISO* lädt eine hybride ISO (ca. 150 MB) herunter.
  Sie startet per BIOS und UEFI (auch mit Secure Boot) und funktioniert als CD oder auf einem USB-Stick
  (balenaEtcher, Rufus im DD-Modus oder `dd`). Die ISO enthält nur Kernel und initrd. Installer-System und
  Abbild lädt das Notebook per Netzwerkkabel vom Addon. Der Container `pxe` erzeugt sie bei jedem Start mit seiner
  aktuellen Adresse (`/iso/elvis-installer.iso`). Dafür braucht er einmal einen Lauf von „Installer neu bauen“
  (Addon ab 1.1.0).
- **Anmeldung:** Die Anmeldemaske (SDDM-Theme) zeigt alle Benutzer aus ELVIS mit Suche, angemeldet wird mit der PIN.
  - Die PIN prüft der Dienst `elvis-clientd` über `POST /api/clients/login` mit denselben Sperren wie in ELVIS. Dabei
    entsteht keine Web-Sitzung, der Eintrag steht im Bedienprotokoll.
  - Danach meldet SDDM ein lokales Profilkonto **je Benutzer und Einsatz** an (`e<Einsatz-ID>u<Benutzer-ID>`,
    UID 50000–59999, ohne Einsatz `e0u…`), und zwar mit einem Einmalpasswort (PAM: `pam_exec`).
  - Abmelden und wieder Anmelden im selben Einsatz führt ins selbe Profil. In einem neuen Einsatz gibt es ein neues,
    leeres Profil; alte Profile bleiben auf dem Notebook, werden aber nicht mehr genutzt.
  - Beim Start der Sitzung weist ein Dialog darauf hin, dass die Anpassungen nur für den aktuellen Einsatz gelten
    (Name und ID).
- **Offline:** Ist ELVIS nicht erreichbar, kommen nur Benutzer hinein, die sich an diesem Gerät schon einmal angemeldet
  haben.
  - Der Dienst merkt sich dafür einen scrypt-Verifier der PIN. Er wird verworfen, sobald sich die PIN in ELVIS ändert
    (`pinStamp`) oder der Benutzer gelöscht wird.
  - Offline gilt der zuletzt bekannte Einsatz.
  - Grenze: Wer Root-Zugriff auf die Platte hat, kann eine vierstellige PIN aus dem Verifier leicht erraten. Die
    Profile sind ohnehin unverschlüsselt.
- **Keine automatischen Updates:** Folgendes ist entfernt bzw. maskiert, damit das System nicht von sich aus nach
  Updates sucht oder welche lädt (Updates nur auf Auftrag, siehe unten):
  - entfernt: unattended-upgrades, update-notifier, Discover, PackageKit und snapd
  - maskiert: die apt-, fwupd- und motd-Timer
  - geleert: die Paketquellen (die alten liegen unter `/etc/apt/sources.disabled`)

  Firefox kommt als deb von Mozilla, die Update-Prüfung im Browser ist per Richtlinie aus, und die Startseite ist ELVIS.
- **Aussehen:** Fluent-Theme (vinceliuice, GPL-3.0) für Plasma, Kvantum, GTK und Symbole. Eine Taskleiste unten mit
  Start und Programmen in der Mitte, Fensterknöpfe rechts, ELVIS-Hintergrund. Das Look-and-Feel-Paket
  `de.elvis.desktop` gilt für jedes neue Profil.
- **Updates** (*Einstellungen → Arbeitsplätze*, je Gerät oder „Alle aktualisieren“): Pakete (`apt dist-upgrade`) und/oder
  Firmware (fwupd/LVFS) auf Auftrag aus ELVIS.
  - **Quelle:** Die Pakete kommen über den apt-Cache des Addons (Container `aptcache`, apt-cacher-ng, Option
    „Port des apt-Caches“, Vorgabe 3142). Nur der Docker-Host braucht Internet, jedes Paket wird einmal geladen.
    Firefox (Mozilla) und Firmware (LVFS) gehen per HTTPS ungecacht durch, nur zu diesen Zielen.
  - **Ablauf:** Das Notebook holt den Auftrag beim Abgleich (alle 30 s) und startet erst, wenn niemand angemeldet ist,
    sonst nach der nächsten Abmeldung. Während des Updates sperrt die Anmeldemaske. Danach werden die Paketquellen
    wieder verworfen, und bei Bedarf (neuer Kernel, Firmware) startet das Notebook selbst neu.
  - **Rückmeldung:** Stand, Ergebnis und Protokoll (Ende der Ausgabe) erscheinen in der Liste und im
    Bedienprotokoll. Ein wartendes Update lässt sich zurücknehmen.
  - **Automatisch** sucht das System weiterhin nichts.
  - **Technik:** `POST|DELETE /api/system/workstations/:id/update` (`:id` = `all` für alle),
    Rückmeldung `POST /api/clients/update`, Auftrag in `GET /api/clients/state`.
- **Betriebs-WLAN:** Ist unter *Einstellungen → WLAN-Accesspoints* das Betriebs-WLAN eingeschaltet, hinterlegt jeder Arbeitsplatz es
  automatisch als systemweite Verbindung „ELVIS Betrieb“ (NetworkManager, WPA2, verbindet sich selbst).
  - Änderungen an Netzname oder Passwort übernimmt das Notebook beim nächsten Abgleich (30 s). Schaltet man das
    Betriebs-WLAN in ELVIS ab, wird die Verbindung entfernt.
  - Die Zugangsdaten gehen über `GET /api/clients/state` an registrierte Arbeitsplätze (wie alles im Fahrzeug-LAN per
    HTTP).
  - Je nach polkit-Regel von Ubuntu können angemeldete Benutzer das Passwort in den Netzwerkeinstellungen sehen.
  - Das Gast-WLAN wird nicht hinterlegt.
- **Notfall-Admin:** Das Konto `elvisadmin` (Passwort aus den Addon-Optionen, `sudo`) meldet sich nur an der
  Textkonsole an (Strg+Alt+F3), nicht an der Anmeldemaske.
- **Verwaltung** (*Einstellungen → Arbeitsplätze*, nur Admins): Übersicht mit Rechnername, MAC-Adresse, zuletzt gesehen,
  angemeldetem Benutzer und Version.
  - Umbenennen ist möglich.
  - **Entfernen** sperrt das Gerätetoken. Beim nächsten Kontakt verwirft das Notebook auch seine Offline-Anmeldedaten.
  - Eine Neuinstallation mit derselben MAC-Adresse ersetzt den Eintrag.
- **Sicherheit:** Das Registrierungstoken (`{{addon.secret}}`, `provides.workstations`) liefert nginx ohne Anmeldung an
  den Installer aus. Den HTTP-Port des Addons deshalb nur im LAN der Arbeitsplätze erreichbar machen. Gerätetokens
  speichert ELVIS nur als Hash.
- **Technik:**
  - Endpunkte: `POST /api/clients/enroll` (Addon-Token), `GET /api/clients/state`, `POST /api/clients/login`,
    `POST /api/clients/heartbeat` (Gerätetoken als `Authorization: Bearer`), `GET|PUT|DELETE /api/system/workstations`.
  - Quellen des Client-Systems: `addons/arbeitsplatz/files/client/` (Dienst, PAM, SDDM-Theme, Plasma-Vorgaben).

## Offene Punkte / nächste Schritte

- **TLS für die Weboberfläche:** Die Sitzungs-Cookies laufen im Fahrzeug-LAN derzeit über HTTP.
- Echte Treiber für die verbauten Systeme.
- Druckansicht/PDF für Einsatztagebuch und Kräfteübersicht, Backup/Export der Datenbank.

## Lizenz

ELVIS steht unter der [MIT-Lizenz](LICENSE). Addons laden Software Dritter erst bei der Installation und unter deren
eigenen Lizenzen, z. B. das NDI-Gateway die NDI-Laufzeit (NDI SDK License Agreement, nur nach Zustimmung).
