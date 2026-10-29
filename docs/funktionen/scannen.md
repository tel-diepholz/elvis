# Scannen (Eingang)

Multifunktionsgeräte wie der HP Color LaserJet Pro MFP 3302sdwg schicken Scans per **Scan an E-Mail** direkt an ELVIS.
ELVIS betreibt dafür einen eigenen SMTP-Empfänger (Port 2525, `scan.smtpPort` in der Konfiguration bzw.
`ELVIS_SCAN_PORT`, `off` schaltet ihn ab). Weitere Dienste braucht es nicht.

- **Posteingang** (*Fahrzeug → Posteingang*, angemeldet): Jeder PDF-Anhang wird ein Scan mit Absender, Betreff und
  Zeit. Ansehen, herunterladen, aus dem Eingang löschen oder nachträglich im laufenden Einsatz ablegen. Scans im Eingang
  werden nach der eingestellten Frist (Vorgabe 14 Tage) gelöscht; abgelegte Dokumente bleiben im Einsatz.
- **Ablage:** Ist ein Einsatz eröffnet, legt ELVIS jeden Scan zusätzlich in dessen Dokumentverwaltung ab (Vorgabe
  `Scans/{{datum.iso}}`, Platzhalter wie bei [Vorlagen](dokumente.md)) und vermerkt das im Einsatztagebuch.
- **Einstellungen** (*Einstellungen → Scannen*, nur Admins): Annahme an/aus, Ablage, erlaubte Geräte (IP-Adressen) und
  optional SMTP-Anmeldung (PLAIN/LOGIN). Mails ohne PDF-Anhang lehnt ELVIS ab, das Gerät zeigt dann einen Fehler.
- **HP-Drucker einrichten:** Embedded Web Server des Druckers öffnen → *Scannen* → *Scan an E-Mail* → *Ausgehende
  E-Mail-Profile*: SMTP-Server = Adresse des ELVIS-Servers, Port 2525, SSL/TLS aus, ggf. Authentifizierung mit den
  Zugangsdaten aus ELVIS. Absender beliebig (z. B. `scanner@elvis`), im Adressbuch einen Empfänger wie `scan@elvis`
  anlegen (die Adresse selbst spielt keine Rolle) und als Dateityp PDF wählen.
- **Sicherheit:** Der SMTP-Empfänger nimmt nur Scans an und leitet nichts weiter. Ohne STARTTLS gehen Scans und
  Anmeldung unverschlüsselt durchs Netz – Port 2525 sollte nur aus dem Fahrzeug-LAN erreichbar sein, am besten nur
  für die IP des Druckers freigegeben.
- **Technik:** `smtp-server` und `mailparser` (`apps/server/src/services/scanning.ts`). Endpunkte: `GET /api/scans`,
  `GET /api/scans/:id/file`, `POST /api/scans/:id/assign`, `DELETE /api/scans/:id`, `GET|PUT /api/system/scanning`.
