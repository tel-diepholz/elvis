# Fahrzeugmodule

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
`apps/server/src/devices/drivers.ts` eingetragen (siehe [Treiber entwickeln](../entwicklung/treiber.md)) und erscheinen dann automatisch in der Auswahl.

Läuft ELVIS im Container, muss das USB-Gerät durchgereicht werden (`devices:` in `deploy/compose.override.yaml`, Vorlage
`deploy/compose.override.example.yaml`).

## Module

| Modul | Seite |
| --- | --- |
| ELW-Router Teltonika RUTM59 | [router-teltonika.md](router-teltonika.md) |
| Wetterstation Airmar 150WX | [wetterstation-airmar.md](wetterstation-airmar.md) |
| Bluetooth: Victron-Akkus und weitere Geräte | [bluetooth-victron.md](bluetooth-victron.md) |
| Kameras (Axis über VAPIX) | [kameras-axis.md](kameras-axis.md) |
| WLAN (OpenWrt-Accesspoints) | [wlan-openwrt.md](wlan-openwrt.md) |
| Monitoring (SNMP, Node Exporter) | [monitoring.md](monitoring.md) |

Das NDI-Gateway ist ein Addon: [NDI-Gateway](../addons/ndi-gateway.md). Bildschirme stehen unter
[Funktionen → Bildschirme](../funktionen/bildschirme.md).
