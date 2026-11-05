# Cloud-Zugang (Datenpflege)

Im Portal **<https://cloud.einsatzleitwagen.app>** arbeiten Verwalter von Landkreis, Gemeinde und Ortsfeuerwehr
zusammen. Dort sehen sie den Zustand der Cloud-Module ihrer ELVIS-Installationen. Künftig pflegen sie dort auch
Stammdaten (Kräfte, Einsatzstichworte, Rollen, Benutzer, Aufgabenvorlagen, Objektbibliothek). Das Portal läuft
über dasselbe Cloud-Relay wie E-Mail und Cloud Messaging.

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
