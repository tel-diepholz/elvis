# Wechselrichter: Victron MultiPlus am VE.Bus (MK3-USB, z. B. am Router)

Modul **Wechselrichter**, Treiber `victron-vebus`. Er spricht über ein Victron **MK3-USB** (VE.Bus auf USB) mit dem
MultiPlus bzw. Quattro und nutzt dabei das MK2-Protokoll aus Victrons Dokument „Interfacing with VE.Bus products – MK2
Protocol“ (3.14). Funktionen:

- **Bus-Scan:** erkennt die Geräte am VE.Bus (Adressen 0–31, Master/Slave, Firmware). Der Scan läuft beim Verbinden
  und auf Knopfdruck.
- **Messwerte:** Landstrom (Spannung, Strom, Frequenz), Ausgang (Spannung, Strom bzw. Leistung), Batterie (Spannung,
  Strom), Zustand mit Ladephase und die LEDs. Bei mehreren Phasen erscheinen die Werte je Phase.
- **Schalten wie ein Digital Multi Control:** Ein, Nur Laden, Nur Wechselrichter, Aus und die Landstrom-Begrenzung.
  Das Ausschalten in der Oberfläche fragt vorher nach. Jeder Befehl landet im Bedienprotokoll, und Schalten ist nur
  angemeldet möglich.
- **Meldungen:** Überlast, niedrige Batteriespannung und Übertemperatur. Leuchtet die LED, ist es ein Alarm, blinkt sie,
  eine Vorwarnung. Dazu „nicht erreichbar“ und der Hinweis auf eine erkannte Fernbedienung.

## Aufbau: MK3 am Router (Fernwartung)

Das MK3 steckt am dauerhaft eingeschalteten Router (z. B. Teltonika RUTX50). Der Router gibt die serielle Schnittstelle
als TCP-Port frei. ELVIS verbindet sich darüber, und für die Fernwartung geht das auch per VPN, wenn ELVIS aus ist.

1. **Digital Multi Control ausbauen.** Eine Fernbedienung am VE.Bus hat Vorrang: Steht ihr Schalter auf „Aus“, kann
   nichts anderes den MultiPlus einschalten. ELVIS erkennt eine Fernbedienung (ab Firmware 415 des MultiPlus) und
   weist darauf hin.
2. **Den Schalter am MultiPlus auf „On“ lassen.** „Aus“ heißt dann Standby über VE.Bus, und der MultiPlus bleibt
   erreichbar. Steht der Schalter auf „Off“, ist das Gerät ganz aus und lässt sich nicht fernschalten.
3. **MK3 am Router einrichten** (RutOS, *Services → Serial Utilities*):
   - Das MK3 per USB anschließen. Der Router erkennt es als FTDI-Gerät, die Schnittstelle erscheint als USB-Seriell.
   - Eine Instanz *Over IP* anlegen:
     - Modus *TCP server*, Port z. B. `4001`
     - 2400 Baud, 8 Datenbits, keine Parität, 1 Stoppbit, keine Flusssteuerung
   - Den Zugriff nur aus dem Fahrzeugnetz und per VPN erlauben, nicht aus dem Internet. Wer den Port erreicht, kann
     den Wechselrichter schalten.
4. **In ELVIS einstellen** unter *Einstellungen → Fahrzeugmodule → Wechselrichter*: Treiber „Victron VE.Bus über
   MK3-USB“, Anschluss „Über das Netzwerk“, dazu die Adresse des Routers und den Port.

Steckt das MK3 direkt am ELVIS-Server, stattdessen „USB am ELVIS-Server“ wählen und die Schnittstelle angeben. Im
Container muss das Gerät durchgereicht werden (siehe `deploy/compose.override.example.yaml`).

| Option | Standard | Bedeutung |
| --- | --- | --- |
| `transport` | `tcp` | `tcp` = Router mit Serial over IP, `serial` = USB am Server |
| `host`, `port` | `192.168.1.1`, `4001` | Router und Port aus „Over IP“ |
| `serialPort` | – | Schnittstelle bei USB am Server, besser `/dev/serial/by-id/…` |
| `repeatPanelState` | `true` | Das MK3 wiederholt die gewählte Betriebsart alle ½ s selbst, wie ein DMC. Das wirkt auch, wenn ELVIS aus ist. |
| `pollSeconds` | `3` | Abfrageintervall |
| `reconnectSeconds` | `10` | Neuer Verbindungsversuch nach Abbruch |

## Fernwartung ohne ELVIS

Das Werkzeug `vebus` nutzt denselben Treiber, z. B. per VPN vom Laptop:

```bash
npm run vebus -w @elvis/server -- 10.0.0.1:4001            # Status mit Bus-Scan
npm run vebus -w @elvis/server -- 10.0.0.1:4001 on         # einschalten (auch: off, charger-only, inverter-only)
npm run vebus -w @elvis/server -- 10.0.0.1:4001 limit 16   # Landstrom-Begrenzung 16 A
npm run vebus -w @elvis/server -- /dev/ttyUSB0             # MK3 direkt am Rechner
```

Im Container lautet der Aufruf `docker exec -it elvis node apps/server/dist/tools/vebus.js …`. Mit `--once` sendet das
Werkzeug die Betriebsart nur einmal.

Der Router lässt **nur einen Client gleichzeitig** zu. Solange ELVIS mit diesem Treiber läuft, hält es die
Verbindung. Dann über die Weboberfläche schalten oder das Modul kurz deaktivieren.

## Ohne Gerät testen

- Treiber „Simulation“: ein MultiPlus 24 V hinter einem MK3, der dasselbe Protokoll spricht. Landstrom ist abwechselnd
  20 Minuten da und 10 Minuten weg.
- TCP-Simulator wie der Router: `npm run vebus:sim -w @elvis/server -- 4001 [Geräte] [--dmc]`. In ELVIS dann
  Adresse `127.0.0.1`, Port `4001` eintragen.

## Gut zu wissen

- **Reihenfolge beim Einschalten:** Bekommt das MK3 vor dem MultiPlus Strom (USB am Router), kann es im falschen Modus
  starten. ELVIS erkennt das und setzt das MK3 zurück.
- **Noch am Gerät zu prüfen:**
  - Bleibt die über VE.Bus gewählte Betriebsart nach einem Neustart des MultiPlus bzw. des Routers erhalten?
  - Liefert die Firmware des MultiPlus das Schalterregister? Ohne Schalterregister zeigt ELVIS die zuletzt aus
    ELVIS gewählte Betriebsart.
- **Ein GX-Gerät am selben Bus** (Cerbo GX o. Ä.) verträgt sich nicht mit einem zweiten MK3. In dem Fall besser
  Modbus-TCP vom GX nutzen. Dafür gibt es noch keinen Treiber.
