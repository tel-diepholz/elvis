# Siemens LOGO! (S7)

Das Modul „LOGO“ liest eine **Siemens LOGO! 8** (0BA8 und neuer, mit Ethernet-Anschluss) per S7 aus und zeigt alle
Signale auf der Seite **LOGO**: Eingänge (I), Ausgänge (Q), Merker (M), Analogwerte (AI, AQ, AM) und die
Netzwerksignale (NI, NQ, NAI, NAQ). Das Modul gibt es nur in ELVIS full, nicht in ELVIS lite.

## Einrichten

1. In **LOGO! Soft Comfort** unter *Extras → Ethernet-Verbindungen* eine Server-Verbindung anlegen, die den Zugriff
   per S7 erlaubt („Put/Get-Kommunikation zulassen“). Die TSAP-Werte der Verbindung notieren, z. B. Client `01.00` und
   Server `02.00`.
2. In ELVIS unter **Einstellungen → Fahrzeugmodule → LOGO** den Treiber „Siemens LOGO! 8 (S7)“ wählen und eintragen:
   Adresse der LOGO, Port (102), **TSAP von ELVIS** (= Client-TSAP, `0100`) und **TSAP der LOGO** (= Server-TSAP, `0200`).
3. Zum Ausprobieren ohne LOGO gibt es den Treiber „Simulation“: Ein Taster-Impuls auf NIn schaltet dort den Ausgang Qn um.

Abgefragt wird alle 2 Sekunden (einstellbar). Antwortet die LOGO zweimal in Folge nicht, erscheint der Alarm
„Siemens LOGO nicht erreichbar“, und die Werte werden verworfen, damit keine veralteten Zustände Meldungen auslösen.

## Adressen

ELVIS liest Datenbaustein 1 der LOGO („VM-Adressen“). Die Adressen stehen an **einer** Stelle im Quelltext
(`packages/shared/src/logo.ts`, `LOGO_SIGNALS`) und stammen aus dem Siemens-Handbuch. Sie sind bei der ersten
Inbetriebnahme an der verbauten LOGO zu prüfen.

| Signal | Anzahl | Byteadresse (Signal 1) |
| --- | --- | --- |
| I Eingänge | 24 | 1024 |
| AI Analogeingänge | 8 | 1032 |
| Q Ausgänge | 20 | 1064 |
| AQ Analogausgänge | 8 | 1072 |
| M Merker | 64 | 1104 |
| AM Analogmerker | 64 | 1118 |
| NI Netzwerk-Eingänge | 64 | 1246 |
| NAI Netzwerk-Analogeingänge | 32 | 1262 |
| NQ Netzwerk-Ausgänge | 64 | 1390 |
| NAQ Netzwerk-Analogausgänge | 16 | 1406 |

Bits liegen von niedrig nach hoch (Signal 1 = Bit 0), Analogwerte sind 16 Bit mit Vorzeichen.

## Bezeichnungen, Meldungen, Geräte

Alles unter **LOGO** bearbeiten angemeldete Benutzer; es gilt für das ganze Fahrzeug.

- **Bezeichnung:** In der Signalliste neben jeder Kennung eintragen (z. B. `Q7` → „Umfeldbeleuchtung“). Leer löscht sie.
- **Meldungen (Regeln):** „Wenn Signal = Wert, dann Meldung“. Beispiel: `NI1` ist 1 → Warnung „Lichtmast ausgefahren“.
  Bei Analogwerten gehen auch `>`, `<`, `>=`, `<=`, `!=`. Die Meldung steht in der Meldungsleiste, solange die Bedingung
  gilt, und verschwindet von selbst. Schwere: Hinweis, Warnung oder Alarm.
- **Geräte (Taster + Ausgang):** Ein Tasteingang (NI) und ein Schaltausgang (Q, M oder NQ) bilden ein Gerät. Beispiel:
  `NI4` ist der Taster der Umfeldbeleuchtung, `Q7` der Ausgang. Die Karte zeigt den Zustand des **Ausgangs** („an“/„aus“),
  der Knopf „Einschalten/Ausschalten“ setzt `NI4` für die eingestellte Impulsdauer (Vorgabe 300 ms) auf 1 und danach
  wieder auf 0. Das LOGO-Programm muss den Taster als Impuls auswerten (z. B. Stromstoßrelais).

ELVIS schreibt **nur** Netzwerk-Eingänge, die als Taster einer Verknüpfung eingetragen sind. Jedes Schalten steht im
Bedienprotokoll, ebenso das Ändern von Bezeichnungen, Regeln und Verknüpfungen. Ein Taster gehört zu genau einem Ausgang.
