# Bluetooth: Victron-Akkus und weitere Geräte

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
- **Passiv mitlesen** (Vorgabe): ELVIS meldet bei BlueZ einen Advertisement Monitor auf Victrons Hersteller-ID an, der
  Dongle scannt dann durchgehend. Bei der aktiven Suche startet bluetoothd den Scan alle ~10 s neu und setzt dabei jedes
  Mal eine neue Zufallsadresse; manche Realtek-Dongles (RTL8761BU) hängen sich daran nach einer Weile auf. Kann BlueZ
  keinen Advertisement Monitor, sucht ELVIS automatisch aktiv. Wie, steht beim Start im Log
  (`docker logs elvis | grep Bluetooth`). Ob BlueZ es kann:
  `busctl introspect org.bluez /org/bluez/hci0 | grep AdvertisementMonitorManager1`. Fehlt die Zeile, in
  `/etc/bluetooth/main.conf` unter `[General]` `Experimental = true` setzen und `sudo systemctl restart bluetooth`.
- **Wächter:** ELVIS prüft alle 30 s, ob der Adapter noch eingeschaltet ist und die Suche noch läuft, und meldet sich
  nach einem Neustart von bluetoothd neu an. Kommt 5 min lang gar kein Paket, obwohl Geräte eingetragen sind, meldet
  ELVIS „Bluetooth nicht erreichbar“ mit Hinweis auf den Dongle, bis wieder etwas ankommt.
- **Server vorbereiten:**
  1. BlueZ installieren und starten: `sudo apt install bluez`, `sudo systemctl enable --now bluetooth`. Adapter
     prüfen mit `bluetoothctl list` (bzw. `rfkill unblock bluetooth`, falls blockiert).
  2. Freigabe für den ELVIS-Benutzer (UID 1000 im Container):
     `sudo cp deploy/bluetooth/elvis-bluetooth.conf /etc/dbus-1/system.d/ && sudo systemctl reload dbus`
  3. In `deploy/compose.override.yaml` den Socket durchreichen (`/run/dbus/system_bus_socket`, ist in der Vorlage
     schon eingetragen) und `sudo sh deploy/install.sh` bzw. `cd deploy && docker compose up -d` ausführen.
  4. Unter *Einstellungen → Fahrzeugmodule* beim Modul Bluetooth den Treiber BlueZ wählen.
- **Fehlersuche:** `sudo btmon` zeigt, was der Dongle empfängt (Victron: `Company: Victron Energy BV (737)`).
  - Gar keine `Advertising Report`-Zeilen und in `sudo dmesg | grep -i bluetooth` steht
    `firmware file rtl_bt/… not found`: Firmware fehlt, `sudo apt install firmware-realtek` (Paketquelle
    `non-free-firmware`), Dongle neu einstecken.
  - `command 0x2005 tx timeout` bzw. `Opcode 0x2041 failed`: Der Dongle hängt. Nur Ab- und Anstecken hilft
    (`modprobe -r btusb` reicht nicht). Dagegen USB-Autosuspend abschalten:
    `echo "options btusb enable_autosuspend=n" | sudo tee /etc/modprobe.d/btusb.conf`, passiv mitlesen (siehe oben)
    oder einen anderen Dongle nehmen (z. B. CSR8510, Intel).
- **Weitere Geräte** (siehe auch [Treiber entwickeln](../entwicklung/treiber.md)): Neue Gerätearten kommen in `packages/shared/src/bluetooth.ts` (`BluetoothKind`) und als
  Auswertung der Herstellerdaten in `apps/server/src/devices/drivers/bluetooth.ts` hinzu.
