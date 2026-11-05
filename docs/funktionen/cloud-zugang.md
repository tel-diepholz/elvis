# Cloud-Zugang (Datenpflege)

Im Portal **<https://cloud.einsatzleitwagen.app>** arbeiten Verwalter von Landkreis, Gemeinde und Ortsfeuerwehr
zusammen. Dort pflegen sie Stammdaten (Kräfte, Einsatzstichworte, Rollen, Benutzer, Aufgabenvorlagen, die
[Objektbibliothek](objektbibliothek.md#in-der-cloud)) und sehen den
Zustand der Cloud-Module ihrer ELVIS-Installationen. Das Portal läuft über dasselbe Cloud-Relay wie E-Mail und Cloud
Messaging.

## Baustruktur und Rollen

- Die Ebenen sind die **Gebietskörperschaften** (Land › Kreis › Gemeindeverband › Gemeinde, aus dem
  Gemeindeverzeichnis). Darunter lassen sich **eigene Knoten** anlegen, z. B. Ortsfeuerwehren, Züge oder Fachgruppen.
- Rollen gelten für einen Knoten und alles darunter:
  - **Lesen** zeigt Stammdaten und Status.
  - **Pflegen** erlaubt das Pflegen von Stammdaten.
  - **Verwalten** erlaubt dazu, Personen einzuladen, Installationen zu verknüpfen und Unterknoten anzulegen.
- Wer den Landkreis verwaltet, verwaltet damit auch jede Gemeinde im Kreis.
- **Anmelden** geht ohne Passwort: Das Portal schickt einen Code an die E-Mail-Adresse. Beim ersten Mal entsteht dabei
  das Konto.
- **Einladen:** Verwalter laden Personen per E-Mail mit einer Rolle ein. Der Link gilt 14 Tage und nur für die
  eingeladene Adresse.
- Die ersten Verwalter eines Landkreises oder einer Gemeinde setzt der Betreiber des Relays ein.

## Installation verknüpfen

1. *Einstellungen → Cloud-Zugang* (Admins): Name im Portal prüfen (Vorgabe: Fahrzeugname) und
   **Verknüpfungscode anfordern**.
2. Ein Verwalter öffnet im Portal den Bereich, z. B. die Gemeinde. Dort gibt er unter **Installation verknüpfen** den
   Code ein, etwa `V7GN-3CJG`. Der Code gilt eine Stunde.
3. ELVIS merkt die Verknüpfung von selbst und zeigt den Bereich. **Trennen** geht in ELVIS und im Portal.

Für die Verknüpfung erzeugt ELVIS einen eigenen Ed25519-Schlüssel. Jeder Aufruf beim Relay ist damit signiert,
ein Postfach braucht es dafür nicht. Der private Schlüssel liegt versiegelt in der Datenbank, die Passphrase wie beim
Postfach in `<dataDir>/mail.secret`. Beides ist im [Backup](../backup.md) enthalten. Anfordern und Trennen stehen im
Bedienprotokoll (Ziel `cloud`).

## Stammdaten-Abgleich

Ist die Installation verknüpft, startet ein Admin unter *Einstellungen → Cloud-Zugang* den **Abgleich**. Danach
gleicht ELVIS jede Minute ab.

- **Wer sieht was:**
  - **Kräfte und Einsatzstichworte** kommen von allen Knoten darüber und darunter. Der Kreis-ELW kennt also auch die
    Fahrzeuge der Gemeinden, der ELW Weyhe die des Kreises.
  - **Rollen, Benutzer und Aufgabenvorlagen** kommen nur von oben. Die Rollen des Kreises gelten in jeder Gemeinde.
- **Wer ändert was:**
  - ELVIS ändert nur die Datensätze des **eigenen Bereichs** (Badge „Cloud“). Was ein anderer Bereich pflegt, ist
    hier nur lesbar (Schloss mit dessen Namen). Ändern geht dann nur im Portal mit der Rolle *Pflegen*.
  - Ausnahme: Adressen und Rufnummern, die ELVIS sich aus eingegangenen Nachrichten merkt, bleiben lokal. Das gilt,
    solange die Cloud keine eigenen kennt.
- **Erster Abgleich:**
  - Alles, was nur lokal existiert, geht an den eigenen Bereich.
  - Was es in der Cloud schon gibt, wird zusammengeführt statt doppelt angelegt. Bei Kräften zählt der Funkrufname,
    sonst Name und Organisation, bei Benutzern Vor- und Nachname, sonst der Name.
  - Ein zusammengeführter Datensatz eines anderen Bereichs ist danach hier nur lesbar.
- **Konflikte:** Ändern ELVIS und Portal denselben Datensatz gleichzeitig, gilt der Stand der Cloud. Die verworfene
  Änderung steht in der Karte unter „Konflikte“ und im Bedienprotokoll (Ziel `cloud`).
- **Benutzer** kommen ohne PIN, nur Name und Admin-Recht kommen aus der Cloud.
  - Solange keine PIN gesetzt ist, steht „PIN fehlt“ am Benutzer und er erscheint nicht in der Anmeldeauswahl.
  - Ein Admin setzt die PIN unter *Benutzer → Bearbeiten*.
  - Der letzte Admin mit PIN bleibt immer Admin und wird nie gelöscht.
- **Aufgabenvorlagen** verweisen auf Rollen und auf Dokumentvorlagen. Dokumentvorlagen werden nicht abgeglichen.
  ELVIS sucht sie lokal nach ihrem Namen, fehlt sie, bleibt die Aufgabe ohne Vorlage.
- **Laufende Lagen** bleiben unberührt, sie arbeiten mit Kopien.
- **Steuerung:** *Jetzt abgleichen* stößt einen Durchlauf an, *Alles neu laden* holt alles noch einmal ab, *Beenden*
  stoppt den Abgleich.
- **Trennen:** Die Daten bleiben als lokale stehen.

## Status im Portal

Je Installation zeigt das Portal:

- den letzten Kontakt zum Relay und die ELVIS-Version,
- beim Postfach die Zahl und Größe der wartenden Mails, die älteste davon, den letzten Abruf mit Land und die heute
  gesendeten Mails,
- beim Cloud Messaging die wartenden Ereignisse, offenen Chats und den Verzeichniseintrag,
- gekoppelte Apps mit wartenden Positionen und Personalbögen,
- Messenger-Webhooks und Cloud-Backups.

Das Portal sieht nur diese Zähler, keine Inhalte. Mails, Nachrichten und Backups bleiben für das Relay verschlüsselt.

## Konfiguration

```json
"app": { "relayUrl": "https://relay.einsatzleitwagen.app", "cloudUrl": "https://cloud.einsatzleitwagen.app" }
```

Die Umgebungsvariable `ELVIS_CLOUD_URL` überschreibt `cloudUrl`, z. B. für ein lokales Relay. Ohne `relayUrl` ist
der Cloud-Zugang aus.
