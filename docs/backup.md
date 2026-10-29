# Backup und Wiederherstellung

ELVIS sichert Datenbank, Dateien und Konfiguration verschlüsselt über einen Backup-Treiber. Mit dem
**Wiederherstellungsschlüssel** lässt sich eine frisch installierte Instanz bei der Ersteinrichtung wiederherstellen.

## Einrichten

*Einstellungen → Dienste → Backup*: „Backup aktiv“ einschalten, Treiber wählen, „Einrichten …“.

- ELVIS zeigt den Wiederherstellungsschlüssel **einmal** an (`ELVIS-XXXX-…`, 12 Gruppen mit Prüfsumme gegen
  Tippfehler). Kopieren oder als Textdatei speichern und getrennt vom Fahrzeug aufbewahren. Zur Bestätigung tippt der
  Admin die letzten zwei Gruppen ab, danach läuft sofort das erste Backup.
- Einstellbar sind das Intervall (15 Minuten, 1 Stunde, 24 Stunden) und die Anzahl aufbewahrter Backups. Ältere löscht
  ELVIS nach jedem Backup. „Jetzt sichern“ startet ein Backup außer der Reihe.
- Nach einem Fehler versucht ELVIS es spätestens nach 15 Minuten erneut. Die Karte zeigt letztes und nächstes Backup,
  belegten Speicher und den letzten Fehler.
- Abschalten löscht die Schlüssel in ELVIS. Vorhandene Backups bleiben beim Treiber und lassen sich mit dem alten
  Schlüssel weiter wiederherstellen.

## Treiber

| Treiber | Speicher |
|---|---|
| einsatzleitwagen.app – Cloud | Cloud-Relay (`app.relayUrl`) in Cloudflare R2, Kontingent je Tresor (Anzahl, Größe) vom Relay |

## Inhalt und Verschlüsselung

- **Gesichert:** `elvis.sqlite` (konsistenter Snapshot über die SQLite-Backup-API), `mail.secret`, `documents/`,
  `templates/`, `display-images/`, `scans/`, `docker-tls/` und `config/elvis.json`. Caches (Kacheln, Umrisse,
  Addon-Repos, Wetter) und Gastdruck-Dateien bleiben draußen.
- **Schlüssel:** Aus dem Zufallsanteil des Wiederherstellungsschlüssels (224 Bit) leitet HKDF-SHA256 Tresor-ID, Zugang
  beim Treiber und AES-256-Schlüssel ab. ELVIS speichert nur diese abgeleiteten Werte, nicht den Schlüssel selbst. Eine
  frische Installation findet ihre Backups also allein mit dem Schlüssel.
- **Format:** tar.gz, in Blöcken von 4 MiB mit AES-256-GCM verschlüsselt (Nonce mit Zähler und Markierung des letzten
  Blocks: abgeschnittene oder umsortierte Dateien fallen auf). Ein Manifest mit SHA-256 aller Dateien und der
  Schema-Version liegt im Archiv. Das Relay sieht nur Größe, Zeit und verschlüsselte Metadaten.

## Wiederherstellen

1. ELVIS frisch installieren und die Weboberfläche öffnen.
2. In der **Ersteinrichtung** „Aus Backup wiederherstellen“ wählen, Treiber und Schlüssel eingeben, „Backups suchen“.
3. Ein Backup wählen und „Wiederherstellen“. ELVIS lädt es herunter, entschlüsselt und prüft es und startet neu.
4. Anmelden mit einem Benutzer und der PIN aus dem Backup.

- Die alte Installation vorher abschalten: Die neue übernimmt Cloud-Anmeldung, gekoppelte Apps, das Postfach und das
  Backup (es läuft im selben Tresor weiter).
- Backups einer neueren ELVIS-Version werden abgelehnt. Ältere bringen die Migrationen beim Start auf den aktuellen Stand.
- Die bisherigen Daten der frischen Installation liegen danach in `<dataDir>/.pre-restore-<Zeit>/` und können gelöscht
  werden.
- Wiederherstellen geht nur, solange es noch keinen Benutzer gibt (`/api/restore/*`).
