# Monitoring (SNMP, Node Exporter)

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
