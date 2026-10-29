# Wetterstation Airmar 150WX (NMEA 2000 über Actisense NGX-1)

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
