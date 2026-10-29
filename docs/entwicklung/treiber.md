# Echte Hardware anbinden

Jedes Gerät implementiert `DeviceAdapter` (`apps/server/src/devices/adapter.ts`) und veröffentlicht den
Zustand aus `packages/shared/src/devices.ts`. Für einen echten Treiber:

1. Klasse anlegen, z. B. `devices/victron/power.ts extends BaseAdapter<'power'>`, und die Befehle mit
   denselben Aktionsnamen wie im Simulator umsetzen.
2. In `devices/drivers.ts` registrieren: `power: { drivers: { sim: …, victron: (o) => new VictronPower(o) } }`.
3. In `config/elvis.json` auswählen: `"devices": { "power": { "driver": "victron", "options": { "host": "…" } } }`.

Typische Schnittstellen: Victron/Modbus-TCP (Energie), CAN/FMS-Gateway (Fahrgestell), Relais-/SPS-I/O
(Licht, Mast), TETRA-PEI (Funk), Router-API/SNMP (Netzwerk), RS-232/IP (Videomatrix), ONVIF (Kameras).
Befehle mit dem Präfix `sim.` gibt es nur im Simulator.

Module erscheinen nach dem Registrieren automatisch unter *Einstellungen → Fahrzeugmodule* (siehe [Fahrzeugmodule](../fahrzeugmodule/README.md)). Neue Bluetooth-Gerätearten: siehe [Bluetooth](../fahrzeugmodule/bluetooth-victron.md).
