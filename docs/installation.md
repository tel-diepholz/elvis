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

## ELVIS lite (Windows-Desktop, ELW 1)

Für kleinere Fahrzeuge ohne Fahrzeugserver gibt es ELVIS als Windows-App: Einsatzführung (Tagebuch, Kräfte,
Meldungen, Schadenkonten, Dokumente, Archiv) und Kommunikation (E-Mail, Kontakte, Nachrichten über Threema,
WhatsApp oder Telegram). Fahrzeugmodule (Funk, Netzwerk, Kameras …) und Addons gibt es dort nicht. Der Laptop ist
zugleich Server: Tablets im selben Netz öffnen `http://<Laptop-IP>:8080` im Browser (Adresse im Infobereich unter
„Adresse für Tablets …“). Das Fenster zu schließen beendet ELVIS nicht – beenden über das Symbol im Infobereich.

- **Installer:** GitHub Actions → Workflow „ELVIS lite (Windows)“ → Artefakt `elvis-lite-installer`, oder selbst bauen
  (unter Windows): `npm ci && npm run dist -w @elvis/desktop` → `apps/desktop/release/*.exe`.
- **Firewall:** Der Installer gibt ELVIS lite (das Programm, unabhängig vom Port) für private und Domänen-Netzwerke frei.
  Ist das Fahrzeugnetz in Windows als „Öffentlich“ eingestuft, auf „Privat“ umstellen – sonst erreichen Tablets den
  Laptop nicht.
- **Port:** Standard ist 8080. Ist er belegt (z. B. durch einen anderen Webserver oder eine ELVIS-Entwicklerinstanz in
  WSL, deren Ports Windows weiterleitet), schlägt ELVIS beim Start einen freien Port vor und merkt ihn sich in
  `desktop.json`.
- **Daten:** `%APPDATA%\ELVIS lite\` – `data\` (Datenbank, Dokumente), `elvis.json` (optionale Serverkonfiguration),
  `desktop.json` (Port), `logs\server.log`. Backup und Wiederherstellung wie in der Vollversion unter Einstellungen.
- **Entwicklung:** `ELVIS_EDITION=lite npm run dev` zeigt die lite-Oberfläche im Browser; die App selbst mit
  `npm run dev -w @elvis/desktop` (lädt die Oberfläche vom Vite-Server).

Weitere Befehle (Tests, Typprüfung, Labor): siehe [Entwicklung → Tests](entwicklung/tests.md).

Danach: [Benutzer und Anmeldung](benutzer-und-rechte.md) (Ersteinrichtung), [Fahrzeugmodule](fahrzeugmodule/README.md) und [Addons und Docker-Hosts](addons/README.md).
