# Funk (Simulation, Reichert ZBE)

Das Modul **Funk** zeigt auf der Seite **Fahrzeug → Funk** den Funkverkehr und die Funkgeräte des Fahrzeugs.

## Funkverkehr (Timeline)

Die Timeline listet die Funksprüche, neueste oben. Jeder Eintrag zeigt:

- die Art: Sprache, SDS, Status, Gesendet (eigenes Gerät)
- den Absender
- die eigenen Geräte, die ihn gehört haben, mit Rufgruppe und Dauer

Ein Gespräch, das mehrere eigene Geräte auf derselben Rufgruppe hören, erscheint als ein Eintrag. Ein laufendes
Gespräch ist mit „spricht …“ markiert.

**Absender:** Ist die ISSI in der laufenden Lage einer Kraft zugeordnet, steht dort deren Funkrufname und Name
(z. B. „Florian Diepholz 1/46-1 · HLF 1“). Sonst steht dort die ISSI mit dem Zusatz „unbekannt“. Eigene Funkgeräte
erscheinen mit ihrem Namen. Bei Sprache meldet die Anlage nur den Funkrufnamen, keine ISSI. Dann steht dort „Sprecher unbekannt“. Auch dann lässt sich eine Meldung
erstellen, der Absender bleibt leer.

**Meldung erstellen:** Eingehende Funksprüche (Sprache, SDS, Status) haben einen Button „Meldung erstellen“. Er
öffnet das Formular für eine Eingangsmeldung:

- Bei bekannter ISSI ist die Kraft bereits als Absender ausgewählt.
- Bei unbekannter ISSI bleibt das Absenderfeld leer.
- SDS- und Statustext stehen schon im Meldungstext.
- Wählt der Fernmelder eine Kraft aus der Lage oder eine Systemeinheit (z. B. Leitstelle), merkt sich ELVIS die ISSI
  für diese Lage. Ab dann erscheint die Kraft bei allen Funksprüchen dieser ISSI, auch bei älteren.
- Ein Freitext-Absender ordnet nichts zu.
- Eine Kraft kann mehrere ISSIs haben. Wählt der Fernmelder für eine ISSI eine andere Kraft, gilt ab dann die neue Zuordnung.

Den Button gibt es nur mit offener Lage und angemeldetem Benutzer. Eingangsmeldungen erfassen nur Benutzer mit
Fernmelder-Rolle (Einstellungen → Meldungen), für alle anderen ist er ausgegraut. Ist keine Fernmelder-Rolle
eingestellt, darf jeder angemeldete Benutzer erfassen.

**Anzeige:**

- „Funksprüche“ zeigt Sprache, SDS, Status und Gesendetes. „Alles“ zeigt zusätzlich Positionsmeldungen und sonstige
  Ereignisse.
- Die Auswahl „Funkgerät“ zeigt nur, was ein Gerät gehört oder gesendet hat, z. B. den eigenen Funkplatz.

**Verlauf:**

- Der Server hält den Funkverkehr der letzten 12 Stunden im Speicher, höchstens 5000 Einträge. Nach einem Neustart
  von ELVIS beginnt die Timeline leer.
- Die Zuordnungen ISSI → Kraft stehen in der Datenbank und gelten je Lage.

## Treiber

| Treiber | Inhalt |
| --- | --- |
| Simulation | Acht Geräte (MRT, FRT, HRT) mit Rufgruppen und Pegel. Auf den Rufgruppen sprechen wechselnde Gegenstellen (ISSI), manchmal ein eigenes Gerät. Dazu kommen gelegentliche SDS und Status. Rufgruppe und Fahrzeugstatus lassen sich schalten. |
| Reichert ZBE | Funkgeräte an den Anschlüssen einer Reichert ZBE. ELVIS meldet sich per TCP als Client an, übernimmt die Funkgeräte aus der Konfiguration der ZBE und wertet Sprache, SDS, Status und Positionsmeldungen aus. Nur lesend. |

### Einstellungen „Reichert ZBE“

Die ZBE (Zentrale Bedieneinheit) verbindet bis zu 20 Funkgeräte, TETRA und analog. Die Anschlüsse 1–20 sind in
ihren Einstellungen eingerichtet.

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Adresse der ZBE / Port | 127.0.0.1 / 9001 | Reichert-Server im Fahrzeugnetz |
| Benutzer / Passwort | leer | Leer = Standardzugang der ZBE (`api` / `api`) |
| Clientnummer | 1 | `context client <n>` bei der Anmeldung |
| Schreibweise der Telegramme | Komma-getrennt | Gilt für die Anmeldung. Nur umstellen, wenn nach dem Verbinden keine Ereignisse kommen. Empfangen werden beide Schreibweisen. |
| Neuer Verbindungsversuch nach | 10 s | Nach Verbindungsabbruch |

- **Funkgeräte:** ELVIS liest sie nach der Anmeldung aus der Konfiguration der ZBE. Name und Anschluss stehen dort.
  Die ZBE meldet auch ELA, DAB und den Intercom. Das sind keine Funkgeräte, ELVIS blendet sie aus. Alle übernommenen
  Funkgeräte erscheinen als Funkplatz, die ISSI des Geräts meldet die ZBE nicht.
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

- Funksprüche mit Funkrufname
- Status
- SDS
- Positionen

Dazu kommen Lebenszeichen der Anlage. In ELVIS dann den Treiber „Reichert ZBE“ mit Adresse `127.0.0.1` wählen.

## Protokoll

Das Protokoll ist nicht öffentlich dokumentiert. Die Beschreibung stammt aus einem Mitschnitt an einer echten Anlage
(IOE Command-Interface 7.0.10D) und aus dem Verhalten bestehender Clients. Mit `?` markierte Stellen sind unsicher.
Ältere Anlagen schreiben die Felder teils mit Leerzeichen statt Komma. ELVIS liest beides.

**Grundsätzliches**

- TCP, Port 9001
- zeilenbasiert, UTF-8, Zeilenende CRLF
- Felder in Anführungszeichen dürfen Komma und Leerzeichen enthalten.
- Der Anschluss steht als Suffix am Telegramm, **ab 0 gezählt**: `.0` = Anschluss 1 … `.19` = Anschluss 20.
- Zeilen mit `#` sind Kommentare der Anlage, zum Beispiel die Begrüßung.

**Anmeldung (Client → ZBE)**

```
login <Benutzer> <Passwort>          (Standard: login api api)
context client <Clientnummer>
main.action.login.-1,1               (andere Schreibweise: main.action.login 0)
ping                                  (Lebenszeichen, die Anlage antwortet mit PONG)
```

Danach schickt die Anlage ihre Konfiguration, den Zustand aller Anschlüsse und fortlaufend `MAIN.EVENT.WATCHDOG`.

**Aktionen (Client → ZBE).** ELVIS sendet sie noch nicht und sie sind an der Anlage 7.0 nicht geprüft.

```
RADIO.ACTION.SM_SEND.<Anschluss-1>,"<ISSI>","TEXT|<Text>"      (FLASH|, STATUS|<Code>, CALLOUT|… analog)
RADIO.ACTION.GPS_REQUEST.<Anschluss-1>,0,"<ISSI>"
```

**Ereignisse (ZBE → Client)**

| Telegramm | Felder nach dem Namen | Bedeutung |
| --- | --- | --- |
| `RADIO.EVENT.CONFIG.-1,<1\|0>` | – | Beginn und Ende der Konfiguration |
| `RADIO.EVENT.CONFIG_LINE.<n>` | `1, <Nr>, 0, "<Name>", "<Art>", NULL, "", "<Kürzel>", …` | Ein Anschluss. Art `TETRA/MOTOROLA-PEI` mit Kürzel `DF` ist ein Funkgerät. `ELA`, `DAB` und Kürzel `IC` (Intercom, `ANALOG/BOSCH`) sind keine Funkgeräte. |
| `RADIO.EVENT.PEAK.<n>` | `<1\|0>, <Pegel>` | Sprache liegt an (1) bzw. ist zu Ende (0). ELVIS zeigt daraus einen Funkspruch mit Dauer. |
| `RADIO.EVENT.SPEAK.<n>` | `<1\|0>, <?>` | Sprechtaste (1 = gedrückt). Wird sie kurz vor `PEAK` gedrückt, zeigt ELVIS „Gesendet“. `?` |
| `RADIO.EVENT.REC_OPTA.<n>` | `<1\|0>, <Länge>, "<Funkrufname>"` | Aufzeichnung mit dem Funkrufnamen des Sprechers. Nach der Anmeldung steht dort der Name des letzten Sprechers. ELVIS übernimmt den Namen nur, solange `PEAK` läuft. |
| `RADIO.EVENT.SM_RECEIVED.<n>` | `"<ID>", "<Absender>", "<Ziel>", "<Funkrufname><Text>", <?>, <?>, ""` | SDS. Die Anlage stellt dem Text den Funkrufnamen des Absenders voran, ohne Trennzeichen. ELVIS schneidet bekannte Namen aus `REC_OPTA` ab. |
| `RADIO.EVENT.GPS_DATA.<n>` | `"<ISSI>", <?>, <Breite>, <Länge>` | Position (Dezimalpunkt) `?` |

Nicht an der Anlage 7.0 gesehen, nur von älteren Clients bekannt: SDS im Format `"<Typ>|<Inhalt>"` mit Typ `TEXT`,
`FLASH`, `STATUS` (TETRA-Code dezimal, z. B. 32771 = 0x8003 = Status 1, oder hexadezimal mit `$`/`&H`/`0x`), `FMS`
oder `POCSAG`. ELVIS liest dieses Format weiter. Statustelegramme der Anlage 7.0 sind noch nicht mitgeschnitten.

ELVIS ignoriert diese Meldungen der Anlage selbst:

- Konfiguration und Lebenszeichen: `STATION.`, `.WATCHDOG.`, `.BUSY.`, `.FACTORY_INFO.`, `.RUNTIME_INFO.`, `.CSPTSS.`
- Bedienteil: `.E2EE.`, `.VOLUME.`, `.SELECT.`, `.ACTIVATE.`, `.CHECKIN_CNF.`, `.EVENT.DISPLAY.`
- Ereignisse von ELA, DAB und Intercom

Andere Ereignisse erscheinen als „Ereignis“.
