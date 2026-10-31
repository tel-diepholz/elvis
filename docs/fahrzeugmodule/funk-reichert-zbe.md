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
erscheinen mit ihrem Namen.

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
| Reichert ZBE | Funkgeräte an einer Reichert ZBE. ELVIS meldet sich per TCP als Client an und wertet eingehende SDS, Status und Positionsmeldungen aus. Sprache ist noch nicht enthalten (siehe Protokoll). Nur lesend. |

### Einstellungen „Reichert ZBE“

| Einstellung | Standard | Bedeutung |
| --- | --- | --- |
| Adresse der ZBE / Port | 127.0.0.1 / 1234 | Reichert-Server im Fahrzeugnetz |
| Benutzer / Passwort | demo / – | Anmeldung an der ZBE |
| Clientnummer | 1 | `context client <n>` bei der Anmeldung |
| Funkgeräte | `1:MRT:MRT Fahrzeug; 2:FRT:Funkplatz 1; 3:FRT:Funkplatz 2` | Je Gerät `FuG-Nummer:Typ:Name[:ISSI]`, getrennt durch Semikolon. Meldet die ZBE eine andere Nummer, legt ELVIS das Gerät als „FuG <Nummer>“ an. |
| Neuer Verbindungsversuch nach | 10 s | Nach Verbindungsabbruch |

Ohne Verbindung zur ZBE meldet ELVIS „Funk nicht erreichbar“. Ereignisse, die ELVIS noch nicht auswertet, erscheinen
in der Timeline unter „Alles“ als „Ereignis“. Jeder neue Ereignisname wird einmal im Server-Log notiert
(`Reichert ZBE: noch nicht ausgewertetes Ereignis …`). So lassen sich an der echten Anlage weitere Telegramme erkennen.

### Ohne Anlage testen

```bash
npm run zbe:sim -w @elvis/server -- 1234 1,2,3                    # Port, FuG-Nummern
docker exec -it elvis node apps/server/dist/tools/zbe-sim.js 1234 1,2,3   # im Container
```

Der Simulator nimmt jede Anmeldung an und schickt alle paar Sekunden zufällige SDS, Status und Positionen auf den
angegebenen FuG-Nummern. In ELVIS dann den Treiber „Reichert ZBE“ mit Adresse `127.0.0.1` und dem Port wählen.

## Protokoll

Das Protokoll ist nicht öffentlich dokumentiert. Die folgende Beschreibung ist rekonstruiert und noch nicht an einer
echten Anlage mitgeschnitten. Mit `?` markierte Stellen sind unsicher.

- TCP, zeilenbasiert, UTF-8, Zeilenende CRLF
- Anmeldung (Client → ZBE):

  ```
  login <Benutzer> <Passwort>
  context client <Clientnummer>
  main.action.login 0
  ```

- Aktionen (Client → ZBE). ELVIS sendet sie noch nicht:

  ```
  RADIO.ACTION.SM_SEND.<FuG> "<ISSI>" "TEXT|<Text>"        (FLASH|, STATUS|, CALLOUT|… analog)
  RADIO.ACTION.SM_SEND.<FuG> "" "ZVEI|<Schleife>"
  RADIO.ACTION.GPS_REQUEST.<FuG> 0 "<ISSI>"
  ```

- Ereignisse (ZBE → Client). Die FuG-Nummer als Suffix ist optional. Ohne Suffix ordnet ELVIS das Ereignis dem ersten Gerät zu:

  ```
  RADIO.EVENT.SM_RECEIVED[.<FuG>] "<Absender>" "<Ziel?>" "<Typ>|<Inhalt>" …
  RADIO.EVENT.GPS_DATA[.<FuG>] "<ISSI>" <?> <Breite> <Länge> …
  RADIO.EVENT.REC_OPTA[.<FuG>] "<TSI>" …
  ```

  - Typen bei `SM_RECEIVED`: `TEXT`, `FLASH`, `STATUS` und `FMS`. Ohne Typ gilt der Inhalt als Text.
  - `STATUS` ist der TETRA-Statuscode, dezimal oder mit `$`/`0x` hexadezimal. 0x8002–0x800B entsprechen den Status 0–9.
  - Absender kommen teils als TSI (`262 1001 0…`). ELVIS kürzt sie auf die ISSI.

Sprechen und Empfang (Rufaufbau, PTT) sind im bekannten Protokollumfang nicht enthalten. Sobald die Telegramme dafür an
der Anlage mitgeschnitten sind, lassen sie sich in `apps/server/src/devices/drivers/reichert/protocol.ts` ergänzen.
