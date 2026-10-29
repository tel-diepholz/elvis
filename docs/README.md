# ELVIS – Dokumentation

## Einrichtung und Betrieb

- [Installation](installation.md) – Entwicklung, Docker auf dem Fahrzeug-Server, `compose.override.yaml`, Produktion
- [Benutzer und Anmeldung](benutzer-und-rechte.md) – PIN-Anmeldung, Rechte, Sperren, Sitzungen
- [Rollen im Einsatz](rollen.md) – Rollen übernehmen, Aufgaben, Meldungsweg, Beschaffungsrolle
- [Taktische Zeichen und Einstellungen](einstellungen.md) – Zeichengenerator, Einstellungsseite, Bedienprotokoll
- [Backup und Wiederherstellung](backup.md) – verschlüsselte Sicherung, Wiederherstellungsschlüssel, Neuinstallation

## Funktionen

- [Karte](funktionen/karte.md) – Kartenquellen, Offline-Cache, Ortssuche, Overpass, Regenradar, Lagekarte drucken
- [Ausbreitungsberechnung](funktionen/ausbreitung.md) – Gauß-Fahne und 60°-Sektor
- [Flugzeuge und Schiffe](funktionen/luft-und-schiffsverkehr.md) – ADS-B und AIS auf der Karte
- [Wetter](funktionen/wetter.md) – DWD-Warnungen und Prognose
- [Kräfte und Personal](funktionen/kraefte-und-personal.md) – Personalbögen, Cloud-Personalabfrage, Ortung per App
- [Kontakte](funktionen/kontakte.md) – Adressbuch des ELW
- [E-Mail](funktionen/email.md) – Postfach des ELW über das Relay, OpenPGP
- [Dokumente, Vorlagen und Collabora](funktionen/dokumente.md)
- [Drucken](funktionen/drucken.md) – Druckserver (CUPS), Lagekarten, Gastdrucker
- [Scannen](funktionen/scannen.md) – Scan an E-Mail in den Posteingang
- [Bildschirme](funktionen/bildschirme.md) – Kacheln, Szenen, Kiosk und Smart-TV

## Fahrzeugmodule

- [Überblick](fahrzeugmodule/README.md) – Module aktivieren, Treiber wählen
- [ELW-Router Teltonika RUTM59](fahrzeugmodule/router-teltonika.md)
- [Wetterstation Airmar 150WX](fahrzeugmodule/wetterstation-airmar.md)
- [Bluetooth: Victron-Akkus und weitere Geräte](fahrzeugmodule/bluetooth-victron.md)
- [Kameras (Axis über VAPIX)](fahrzeugmodule/kameras-axis.md)
- [WLAN (OpenWrt-Accesspoints)](fahrzeugmodule/wlan-openwrt.md)
- [Monitoring (SNMP, Node Exporter)](fahrzeugmodule/monitoring.md)

## Addons

- [Addons und Docker-Hosts](addons/README.md) – Docker-Hosts anbinden, Addon-Repositories
- [Manifest-Referenz](addons/manifest.md) – Aufbau der `addon.yaml`
- [NDI-Gateway](addons/ndi-gateway.md)
- [Arbeitsplätze (PXE)](addons/arbeitsplaetze-pxe.md)

## Entwicklung

- [Architektur](entwicklung/architektur.md)
- [Echte Hardware anbinden](entwicklung/treiber.md) – eigene Treiber schreiben
- [Tests](entwicklung/tests.md) – Tests, Typprüfung, Labor
- [Offene Punkte](roadmap.md)
