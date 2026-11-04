# Installation

```bash
git clone --recurse-submodules https://github.com/tel-diepholz/elvis.git   # Addons kommen als Submodul mit
cd elvis
npm install
npm run dev          # Backend :8080 (Simulation) + Frontend :5173 mit Hot Reload
```

Installation auf einem Fahrzeug-Server als Docker-Container (richtet den Server zugleich als Docker-Host ein):

```bash
sudo sh deploy/install.sh            # oder --no-docker-host
```

Hardware des Fahrzeugs (Airmar am USB, Bluetooth …) kommt nicht in `deploy/compose.yaml`, sondern in
`deploy/compose.override.yaml`. Die Datei ist nicht im Git, `git pull` bleibt also konfliktfrei:

```bash
cp deploy/compose.override.example.yaml deploy/compose.override.yaml   # anpassen
sudo sh deploy/install.sh            # berücksichtigt die Datei; alternativ: cd deploy && docker compose up -d --build
```

Wer `deploy/compose.yaml` schon angepasst hat: Änderungen in die Override-Datei übernehmen, dann
`git checkout deploy/compose.yaml` und `git pull`.

Dann <http://localhost:5173> öffnen; im Fahrzeug-WLAN auch von Tablets/Smartphones über die IP des Rechners.

Produktion (ein Prozess, ein Port):

```bash
npm run build
cp config/elvis.example.json config/elvis.json   # anpassen
npm start                                        # http://<host>:8080
```

## ELVIS lite (Windows, ELW 1)

Für kleinere Fahrzeuge ohne Fahrzeugserver läuft ELVIS als Windows-Dienst auf einem Laptop: Einsatzführung (Tagebuch,
Kräfte, Meldungen, Schadenkonten, Dokumente, Archiv) und Kommunikation (E-Mail, Kontakte, Nachrichten über Threema,
WhatsApp oder Telegram). Fahrzeugmodule (Funk, Netzwerk, Kameras …) und Addons gibt es dort nicht. Bedient wird im
Browser – auf dem Laptop über die Verknüpfung „ELVIS lite“ (`http://localhost:8222`), auf Tablets im selben Netz über
`http://<Laptop-IP>:8222` (Startmenü → ELVIS lite → „Adresse für Tablets“).

Die Navigation stellt die Lage in den Vordergrund: Oben stehen *Übersicht* und die Bereiche der Lage. Karte, Wetter,
Posteingang, E-Mail, Nachrichten, Kontakte und Taktische Zeichen liegen im aufklappbaren Menü **Werkzeuge**, Archiv,
Benutzer und Einstellungen unter **Verwaltung**. Welche Menüs offen sind, merkt sich der Browser. Das Menü mit der
gerade geöffneten Seite ist immer offen.

- **Installer:** GitHub Actions → Workflow „ELVIS lite (Windows)“ → Artefakt `elvis-lite-installer`, oder selbst bauen
  (Windows oder Linux mit NSIS): `npm ci && npm run dist -w @elvis/windows` → `apps/windows/release/*.exe`.
  Er bringt Node.js mit und richtet den Dienst „ELVIS lite“ ein, der mit Windows startet – auch ohne Anmeldung.
  Ein Update ist eine Installation über die bestehende.
- **Firewall:** Der Installer gibt `node.exe` von ELVIS lite für private und Domänen-Netzwerke frei. Ist das
  Fahrzeugnetz in Windows als „Öffentlich“ eingestuft, auf „Privat“ umstellen – sonst erreichen Tablets den Laptop
  nicht.
- **Port:** Standard ist 8222 (nicht 8080, damit es keinen Konflikt mit einer ELVIS-Entwicklerinstanz gibt – auch nicht
  in WSL, deren Ports Windows weiterleitet). Ist er belegt, melden Installer und Verknüpfung „Achtung: Port … ist
  belegt. Der Server kann nicht starten.“ Anderer Port: `port` in `elvis.json` ändern und den Dienst neu starten.
  Keine Ports 6665–6669 – die sperren Browser.
- **Daten:** `%ProgramData%\ELVIS lite\` – `data\` (Datenbank, Dokumente), `elvis.json` (Serverkonfiguration wie
  `config/elvis.json`), `logs\` (Dienstprotokolle). Bleibt bei Updates und beim Deinstallieren erhalten. Backup und
  Wiederherstellung wie in der Vollversion unter Einstellungen.
- **Update:** Einstellungen → Update → „Nach Updates suchen“ fragt die GitHub-Releases ab, „Update installieren“ lädt den
  neuen Installer, prüft Prüfsumme und Signatur und installiert ihn im Hintergrund (ELVIS ist dabei einige Minuten nicht
  erreichbar). Startet die neue Version nicht, stellt der Installer die bisherige Version samt Datenbank wieder her.
  Jedes Update steht im Bedienprotokoll.
- **Release erstellen:** GitHub-Release mit Tag `vX.Y.Z` veröffentlichen → Workflow „ELVIS lite – Release“ baut den
  Installer, signiert ihn mit dem Secret `ELVIS_UPDATE_SIGNING_KEY` (Ed25519, passend zu `UPDATE_PUBLIC_KEY` in
  `apps/server/src/services/updates.ts`) und hängt `ELVIS-lite-X.Y.Z-setup.exe` samt `.sig` an das Release.
- **Entwicklung:** `ELVIS_EDITION=lite npm run dev` zeigt die lite-Oberfläche im Browser.

Weitere Befehle (Tests, Typprüfung, Labor): siehe [Entwicklung → Tests](entwicklung/tests.md).

Danach: [Benutzer und Anmeldung](benutzer-und-rechte.md) (Ersteinrichtung), [Fahrzeugmodule](fahrzeugmodule/README.md) und [Addons und Docker-Hosts](addons/README.md).
