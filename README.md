# ELVIS – Einsatzleitwagen-Verwaltungs- und Informationssystem

Zentrale, responsive Weboberfläche für den ELW 2 der Freiwilligen Feuerwehr. ELVIS fasst die
Einzelsysteme des Fahrzeugs (Funk, Netzwerk, Medien, Wetterstation mit GPS – weitere folgen) und die
Einsatzführung (Einsatztagebuch, Kräfte, Dokumente) in einer Anwendung zusammen.

Projekthomepage mit Bildern und Funktionsübersicht: **<https://einsatzleitwagen.app>**
([Quelle](https://github.com/tel-diepholz/elvis-homepage))

## Bereiche

| Bereich | Verfügbarkeit | Inhalt |
| --- | --- | --- |
| **Fahrzeug** | immer | Übersicht, Karte, Wetter, Netzwerk, E-Mail (mit Postfach), Kontakte |
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

Dann <http://localhost:5173> (Entwicklung) bzw. `http://<host>:8080` öffnen. Hardware, Produktion und weitere
Befehle: [Installation](docs/installation.md).

## Dokumentation

Die vollständige Doku steht in [`docs/`](docs/README.md):

- **Einrichtung:** [Installation](docs/installation.md) · [Benutzer und Anmeldung](docs/benutzer-und-rechte.md) ·
  [Einstellungen](docs/einstellungen.md)
- **Funktionen:** [Karte](docs/funktionen/karte.md) · [Ausbreitung](docs/funktionen/ausbreitung.md) ·
  [Flugzeuge und Schiffe](docs/funktionen/luft-und-schiffsverkehr.md) · [Wetter](docs/funktionen/wetter.md) ·
  [Kräfte und Personal](docs/funktionen/kraefte-und-personal.md) · [Kontakte](docs/funktionen/kontakte.md) ·
  [E-Mail](docs/funktionen/email.md) · [Dokumente](docs/funktionen/dokumente.md) ·
  [Drucken](docs/funktionen/drucken.md) · [Scannen](docs/funktionen/scannen.md) ·
  [Bildschirme](docs/funktionen/bildschirme.md)
- **Fahrzeugmodule:** [Überblick](docs/fahrzeugmodule/README.md) · [Router](docs/fahrzeugmodule/router-teltonika.md) ·
  [Wetterstation](docs/fahrzeugmodule/wetterstation-airmar.md) · [Bluetooth](docs/fahrzeugmodule/bluetooth-victron.md) ·
  [Kameras](docs/fahrzeugmodule/kameras-axis.md) · [WLAN](docs/fahrzeugmodule/wlan-openwrt.md) ·
  [Monitoring](docs/fahrzeugmodule/monitoring.md)
- **Addons:** [Addons und Docker-Hosts](docs/addons/README.md) · [Manifest](docs/addons/manifest.md) ·
  [NDI-Gateway](docs/addons/ndi-gateway.md) · [Arbeitsplätze (PXE)](docs/addons/arbeitsplaetze-pxe.md)
- **Entwicklung:** [Architektur](docs/entwicklung/architektur.md) · [Treiber](docs/entwicklung/treiber.md) ·
  [Tests](docs/entwicklung/tests.md) · [Offene Punkte](docs/roadmap.md)

## Lizenz

ELVIS steht unter der [MIT-Lizenz](LICENSE). Addons laden Software Dritter erst bei der Installation und unter deren
eigenen Lizenzen, z. B. das NDI-Gateway die NDI-Laufzeit (NDI SDK License Agreement, nur nach Zustimmung).
