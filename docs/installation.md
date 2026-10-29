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

Weitere Befehle (Tests, Typprüfung, Labor): siehe [Entwicklung → Tests](entwicklung/tests.md).

Danach: [Benutzer und Anmeldung](benutzer-und-rechte.md) (Ersteinrichtung), [Fahrzeugmodule](fahrzeugmodule/README.md) und [Addons und Docker-Hosts](addons/README.md).
