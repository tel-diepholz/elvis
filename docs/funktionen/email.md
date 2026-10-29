# E-Mail (Postfach des ELW)

Jeder ELW kann über das Cloud-Relay ein eigenes Postfach `<name>@einsatzleitwagen.app` bekommen. Alle Bediener lesen
und schreiben es unter **E-Mail** (Navigation unter „Fahrzeug“, sichtbar sobald das Postfach aktiv ist).

```
Absender ──SMTP──▶ Relay (verschlüsselt sofort) ◀──signierter Abruf alle 30 s── ELVIS (entschlüsselt im ELW)
```

- **Beantragen:** *Einstellungen → Dienste → E-Mail*: Adresse und eine Admin-Kontaktadresse außerhalb von ELVIS
  eintragen. ELVIS erzeugt einen OpenPGP-Schlüssel (Curve25519) und einen Ed25519-Schlüssel für signierte Abrufe. Der
  Admin bestätigt per Link und bekommt **einmalig** Fingerprint, öffentlichen Schlüssel und Widerrufszertifikat per Mail.
  Der private Schlüssel verlässt den ELW nie. Er liegt passphrasegeschützt in der Datenbank, die Passphrase in
  `<dataDir>/mail.secret` (nur für den Dienst lesbar). Für eine Sicherung braucht es beides.
- **Empfang:** Das Relay verschlüsselt jede Mail beim Eingang komplett mit dem Schlüssel des ELW. ELVIS holt sie ab,
  entschlüsselt sie und packt PGP/MIME aus (verschlüsselt und/oder signiert, Signatur geprüft). Die Liste zeigt, ob eine
  Mail Ende zu Ende verschlüsselt war oder nur beim Eingang. HTML-Mails erscheinen in einer Sandbox ohne Skripte und ohne
  nachgeladene Inhalte.
- **Senden:** ELVIS sucht für jeden Empfänger einen Schlüssel: aus eingegangenen Mails (Autocrypt), im Web Key Directory
  der Empfängerdomain oder von Hand importiert (*E-Mail → Schlüssel*). Gibt es für alle einen, geht die Mail signiert und
  verschlüsselt hinaus. Sonst warnt der Editor und sendet erst nach Bestätigung, dann nur signiert. Jede Mail trägt einen
  Autocrypt-Kopf, der eigene Schlüssel steht per WKD unter `openpgpkey.einsatzleitwagen.app`. Gesendete Mails stehen im
  Bedienprotokoll. Die Adresszeilen (An, Cc, Bcc) schlagen beim Tippen Adressen aus den **Kontakten** und aus bisherigen
  Mails vor.
- **Abruf nur durch den ELW:** Jeder Abruf ist zusätzlich zum Zugangstoken mit dem Ed25519-Schlüssel signiert
  (Zeitfenster und Einmal-Nonce gegen Wiederholung). Anders als die App-Anbindung meldet sich ELVIS bei Mail-Fehlern
  nicht neu beim Relay an. Die Mail-Karte zeigt Zeit und Land des letzten Abrufs.
- **Neuinstallation:** In der Mail-Karte „Bestehendes übernehmen“ wählen, Adresse und die hinterlegte Admin-Adresse
  eintragen. Nach Bestätigung per Link gehört die Adresse der neuen Installation. Ältere und noch nicht abgeholte Mails
  sind dann nicht mehr lesbar (bewusst kein Schlüssel-Backup). Die alte Installation zeigt „übertragen“.
- **Kündigen:** Nicht abgeholte Mails löscht das Relay, die Adresse ist 90 Tage gesperrt. Abgeholte Mails bleiben in ELVIS.
- **Status:** Störungen des Mail-Dienstes zeigt <https://einsatzleitwagen.app/status>; die Mail-Karte zeigt den
  Gesamtstatus ebenfalls an.

```json
"mail": { "enabled": true, "pollMs": 30000, "domain": "einsatzleitwagen.app" }
```

E-Mail nutzt die Relay-Adresse aus `app.relayUrl` (siehe [App-Anbindung](kraefte-und-personal.md#app-anbindung-positionen-von-einsatzkräften)). `"enabled": false` blendet den Bereich aus.
