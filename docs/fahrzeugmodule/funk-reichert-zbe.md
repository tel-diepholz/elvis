# Funk (Simulation, Reichert ZBE)

Das Modul **Funk** zeigt auf der Seite **Fahrzeug → Funk** den Funkverkehr und die Funkgeräte des Fahrzeugs.

## Funkverkehr (Timeline)

Die Timeline listet die Funksprüche, neueste oben. Jeder Eintrag zeigt:

- die Art: Sprache, SDS, Status, Gesendet (eigenes Gerät)
- den Absender
- die eigenen Geräte, die ihn gehört haben, mit Rufgruppe und Dauer

Ein Gespräch, das mehrere eigene Geräte auf derselben Rufgruppe hören, erscheint als ein Eintrag. Ein laufendes
Gespräch ist mit „spricht …“ markiert.

**Absender:** Ist die ISSI im laufenden Einsatz einer Kraft zugeordnet, steht dort deren Funkrufname und Name
(z. B. „Florian Diepholz 1/46-1 · HLF 1“). Sonst steht dort die ISSI mit dem Zusatz „unbekannt“. Eigene Funkgeräte
erscheinen mit ihrem Namen. Konnte die Anlage den Sprecher nicht melden, steht dort „Sprecher unbekannt“. Auch dann lässt sich eine Meldung
erstellen, der Absender bleibt leer.

**Meldung erstellen:** Eingehende Funksprüche (Sprache, SDS, Status) haben einen Button „Meldung erstellen“. Er
öffnet das Formular für eine Eingangsmeldung:

- Bei bekannter ISSI ist die Kraft bereits als Absender ausgewählt.
- Bei unbekannter ISSI bleibt das Absenderfeld leer.
- SDS- und Statustext stehen schon im Meldungstext.
- Wählt der Fernmelder eine Kraft aus dem Einsatz oder eine Systemeinheit (z. B. Leitstelle), merkt sich ELVIS die ISSI
  für diesen Einsatz. Ab dann erscheint die Kraft bei allen Funksprüchen dieser ISSI, auch bei älteren.
- Ein Freitext-Absender ordnet nichts zu.
- Eine Kraft kann mehrere ISSIs haben. Wählt der Fernmelder für eine ISSI eine andere Kraft, gilt ab dann die neue Zuordnung.

Den Button gibt es nur mit offenem Einsatz und angemeldetem Benutzer. Eingangsmeldungen erfassen nur Benutzer mit
Fernmelder-Rolle (Einstellungen → Meldungen), für alle anderen ist er ausgegraut.

**Anzeige:**

- „Funksprüche“ zeigt Sprache, SDS, Status und Gesendetes. „Alles“ zeigt zusätzlich Positionsmeldungen und sonstige
  Ereignisse.
- Die Auswahl „Funkgerät“ zeigt nur, was ein Gerät gehört oder gesendet hat, z. B. den eigenen Funkplatz.

**Verlauf:**

- Der Server hält den Funkverkehr der letzten 12 Stunden im Speicher, höchstens 5000 Einträge. Nach einem Neustart
  von ELVIS beginnt die Timeline leer.
- Die Zuordnungen ISSI → Kraft stehen in der Datenbank und gelten je Einsatz.

## Treiber

| Treiber | Inhalt |
| --- | --- |
| Simulation | Acht Geräte (MRT, FRT, HRT) mit Rufgruppen und Pegel. Auf den Rufgruppen sprechen wechselnde Gegenstellen (ISSI), manchmal ein eigenes Gerät. Dazu kommen gelegentliche SDS und Status. Rufgruppe und Fahrzeugstatus lassen sich schalten. |
| Reichert ZBE | Funkgeräte an den Anschlüssen einer Reichert ZBE. ELVIS meldet sich per TCP als Client an und wertet Sprache (mit Sprecher), SDS, Status und Positionsmeldungen aus. Nur lesend. |

### Einstellungen „Reichert ZBE“

Die ZBE (Zentrale Bedieneinheit) verbindet bis zu 20 Funkgeräte, TETRA und analog. In ihren Einstellungen ist jedem
Anschluss 1–20 eine Geräteart zugeordnet.

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Adresse der ZBE / Port | 127.0.0.1 / 9001 | Reichert-Server im Fahrzeugnetz |
| Benutzer / Passwort | leer | Leer = Standardzugang der ZBE (`api` / `api`) |
| Clientnummer | 1 | `context client <n>` bei der Anmeldung |
| Funkgeräte | `1:MRT:MRT Fahrzeug; 2:FRT:Funkplatz 1; 3:FRT:Funkplatz 2` | Je Gerät `Anschluss:Typ:Name[:ISSI]` mit dem Anschluss wie an der ZBE (1–20), getrennt durch Semikolon. Meldet die ZBE einen anderen Anschluss, legt ELVIS ihn als „Anschluss <Nummer>“ an. |
| Schreibweise der Telegramme | Komma-getrennt | Gilt für die Anmeldung. Nur umstellen, wenn nach dem Verbinden keine Ereignisse kommen. Empfangen werden beide Schreibweisen. |
| Neuer Verbindungsversuch nach | 10 s | Nach Verbindungsabbruch |

- Ohne Verbindung zur ZBE meldet ELVIS „Funk nicht erreichbar“.
- Alle 30 s sendet ELVIS ein Lebenszeichen (`ping`).
- Ereignisse, die ELVIS noch nicht auswertet, erscheinen in der Timeline unter „Alles“ als „Ereignis“. Jeder neue
  Ereignisname wird einmal im Server-Log notiert (`Reichert ZBE: noch nicht ausgewertetes Ereignis …`). So lassen
  sich an der echten Anlage weitere Telegramme erkennen.

### Ohne Anlage testen

```bash
npm run zbe:sim -w @elvis/server -- 9001 1,2,3                         # Port, Anschlüsse
docker exec -it elvis node apps/server/dist/tools/zbe-sim.js 9001 1,2,3   # im Container
```

Der Simulator nimmt jede Anmeldung an. Alle paar Sekunden schickt er auf den angegebenen Anschlüssen zufällig:

- Funksprüche mit Sprecher
- Status
- SDS
- Positionen

Dazu kommen Lebenszeichen der Anlage. In ELVIS dann den Treiber „Reichert ZBE“ mit Adresse `127.0.0.1` wählen.

## Protokoll

Das Protokoll ist nicht öffentlich dokumentiert. Die Beschreibung ist aus dem Verhalten zweier bestehender Clients
rekonstruiert und noch nicht an einer echten Anlage mitgeschnitten. Die beiden Clients schreiben die Felder
unterschiedlich: der eine mit Komma, der andere mit Leerzeichen. ELVIS liest beides. Mit `?` markierte Stellen sind
unsicher.

**Grundsätzliches**

- TCP, Port 9001
- zeilenbasiert, UTF-8, Zeilenende CRLF
- Felder in Anführungszeichen dürfen Komma und Leerzeichen enthalten.
- Der Anschluss steht als Suffix am Telegramm, **ab 0 gezählt**: `.0` = Anschluss 1 … `.19` = Anschluss 20.
- Absender kommen meist als TSI (`262 1001 0…`, 15 Stellen). ELVIS kürzt sie auf die ISSI.

**Anmeldung (Client → ZBE)**

```
login <Benutzer> <Passwort>          (Standard: login api api)
context client <Clientnummer>
main.action.login.-1,1               (andere Schreibweise: main.action.login 0)
ping                                  (Lebenszeichen, danach regelmäßig)
```

**Aktionen (Client → ZBE).** ELVIS sendet sie noch nicht.

```
RADIO.ACTION.SM_SEND.<Anschluss-1>,"<ISSI>","TEXT|<Text>"      (FLASH|, STATUS|<Code>, CALLOUT|… analog)
RADIO.ACTION.SM_SEND.<Anschluss-1>,"","ZVEI|<Schleife>"         (analog: FMS|…, POCSAG|A:…)
RADIO.ACTION.GPS_REQUEST.<Anschluss-1>,0,"<ISSI>"
```

**Ereignisse (ZBE → Client)**

| Telegramm | Felder nach dem Namen | Bedeutung |
| --- | --- | --- |
| `RADIO.EVENT.SM_RECEIVED.<n>` | `<?>, "<Absender>", "<Ziel>", "<Typ>\|<Inhalt>"` | SDS. Typ `TEXT`, `FLASH`, `STATUS` (TETRA-Code dezimal, z. B. 32771 = 0x8003 = Status 1, oder hexadezimal mit `$`/`&H`/`0x`), `FMS`, `POCSAG` |
| `RADIO.EVENT.GPS_DATA.<n>` | `"<ISSI>", <?>, <Breite>, <Länge>` | Position (Dezimalpunkt) |
| `RADIO.EVENT.DOKU_REC_INFO.<n>` | `<?>, <?>, "<Ruf?>-<Sprecher>"` | Aufzeichnungsinfo: Der Teil nach dem `-` ist die TSI des Sprechers |
| `RADIO.EVENT.SPEAK.<n>` | – | Es wird gesprochen; der Sprecher stammt aus der Aufzeichnungsinfo davor |

Zur Sprache:

- ELVIS zeigt jedes `SPEAK` als Funkspruch „Sprache“ mit dem Sprecher aus der letzten Aufzeichnungsinfo des
  Anschlusses. Die Aufzeichnungsinfo gilt höchstens 10 s.
- Kommt sie erst kurz nach `SPEAK` (bis 3 s), trägt ELVIS den Sprecher nach.
- Eine Dauer liefert die ZBE nicht. Ein Ende-Telegramm ist nicht bekannt.

ELVIS ignoriert diese Meldungen der Anlage selbst:

- Konfiguration und Lebenszeichen: `.CONFIG_LINE.`, `STATION.`, `.WATCHDOG.`, `.BUSY.`, `.FACTORY_INFO.`,
  `.RUNTIME_INFO.`, `.CSPTSS.`
- Bedienteil: `.E2EE.`, `.VOLUME.`, `.SELECT.`, `.ACTIVATE.`, `.CHECKIN_CNF.`, `.EVENT.DISPLAY.`
- Zeilen, die mit `#` beginnen

`REC_OPTA` und andere unbekannte Ereignisse erscheinen als „Ereignis“.
