---
name: run-elvis
description: Start, run and drive ELVIS (Fahrzeugserver + Weboberfläche) headless – eigene Instanz neben der Entwicklerinstanz starten, anmelden, Karte/Einstellungen im Browser bedienen, Screenshots machen, Tests ausführen. Use when asked to run, start, screenshot or click through the ELVIS web app, or to check a UI change in the real app.
---

ELVIS ist ein Fastify-Server (`apps/server`) mit React/Vite-Weboberfläche (`apps/web`). Für Agenten gilt: Mit
`start.sh` eine **isolierte** Instanz starten (eigene Ports, frisches Datenverzeichnis, Admin angelegt). Dann die
Oberfläche mit `driver.mjs` bedienen (Playwright, Befehle zeilenweise über stdin) und am Ende `stop.sh` aufrufen.
Alle Pfade sind relativ zum Repo-Wurzelverzeichnis.

## Voraussetzungen

Node 20 (`node --version` → v20.19.5) mit installierten Workspaces. Playwright ist **kein** Projektpaket. Der Treiber
lädt es aus dem npx-Cache (`~/.npm/_npx/*/node_modules/playwright`) oder aus `PLAYWRIGHT_DIR`:

```bash
npm install
npx -y playwright@1.63.0 install chromium
```

## Run (Agentenpfad)

```bash
.claude/skills/run-elvis/start.sh --incident     # Server :8091, Web :5183, Daten /tmp/elvis-run, Admin + Einsatz
node .claude/skills/run-elvis/driver.mjs <<'EOF'
view 52.6 8.37 9
layers aircraft
nav /karte
wait .map-marker.traffic
sleep 2000
text .map-traffic-status
ss karte-flugzeuge
clickcenter .map-marker.traffic
wait .leaflet-popup-content
sleep 600
ss popup
press Escape
click button[aria-label="Objekte"]
click text=Flugzeug oder Schiff suchen
fill input[aria-label="Flugzeug oder Schiff suchen"] | RYR
sleep 1500
ss suche
nav /einstellungen#verkehr
waittext aisstream.io-Schlüssel
ss einstellungen-verkehr
errors
EOF
.claude/skills/run-elvis/stop.sh
```

- **Screenshots** liegen in `/tmp/elvis-run/shots/<name>.png`. Bei einem Fehler entsteht `fehler.png`, und der Treiber endet mit Exit-Code 1.
- **Befehle** sind im Kopf von `driver.mjs` beschrieben: `view`, `layers` und `size` gelten vor dem ersten `nav`. Dazu kommen `nav`, `wait`, `waittext`, `gone`, `click`, `clickcenter`, `fill <sel> | <text>`, `press`, `sleep`, `text`, `count`, `ss` und `errors`.
- **Mit der API arbeiten:** Das Sitzungs-Cookie steht in `/tmp/elvis-run/cookie`, z. B. `curl -H "cookie: elvis_session=$(cat /tmp/elvis-run/cookie)" http://localhost:8091/api/traffic/aircraft?lat=52.6\&lon=8.37\&radius=40`.
- **Logs** stehen in `/tmp/elvis-run/server.log` und `/tmp/elvis-run/web.log`.

## Run (Menschenpfad)

`npm run dev` im Wurzelverzeichnis (Server :8080, Vite :5173, Daten `./data`). Für Agenten ungeeignet: Die Instanz
gehört meist dem Entwickler und enthält echte Daten.

## Tests

```bash
npm run typecheck
npm test
```

## Gotchas

- **Fremde Instanz:** Auf 8080/5173 läuft oft schon die Entwicklerinstanz des Nutzers (`tsx watch`). Nicht beenden und dort keinen Admin anlegen. Darum nutzt `start.sh` 8091/5183, `ELVIS_DATA_DIR` und `ELVIS_SCAN_PORT=off`, weil der SMTP-Port 2525 sonst kollidiert. Beenden immer nur über den Port (`stop.sh`), nie mit `pkill -f`.
- **Anmeldung:** Die erste Anmeldung ist die Ersteinrichtung `POST /api/auth/setup` (Name + PIN). Danach reicht das Cookie `elvis_session`. Ohne Admin leitet die Weboberfläche auf die Einrichtung um.
- **Kartenausschnitt und Ebenen** kommen aus `localStorage` (`elvis.map.view`, `elvis.map.layers`). Daher `view`/`layers` vor `nav`. Die simulierte Wetterstation setzt das Fahrzeug auf 51.1657, 10.4515 (Mitte Deutschlands).
- **Marker klicken:** Marker am Rand liegen unter Werkzeugleiste oder Objektliste, dort bleibt der Klick wirkungslos. Überlappende Marker (Schiffe im Hafen) lassen Playwrights `click` mit „subtree intercepts pointer events“ in den Timeout laufen. `clickcenter` klickt deshalb mit der Maus auf die Stelle des Markers nächst der Kartenmitte.
- **Schiffe testen:** Das braucht einen aisstream.io-Schlüssel (`PUT /api/system/traffic`) und einen Einsatzort an der Küste, z. B. `PATCH /api/incidents/1 {"lat":53.54,"lon":8.58}` (Bremerhaven). Die ersten Positionen kommen nach 10–40 s. Um das simulierte Fahrzeug (Mitte Deutschlands) sendet kein Schiff.
- **Leaflet-Popups** blenden ein. `wait .leaflet-popup-content` greift zu früh, der Screenshot zeigt dann nur den Tooltip. Deshalb `sleep 600` danach.
- **Live-Dienste:** Flugzeuge (adsb.fi) und Schiffe (aisstream.io) kommen live aus dem Internet. Instanzen nicht offen laufen lassen, vor allem nicht mit verfolgten Flugzeugen: Der Server fragt dann alle 10 s nach. adsb.lol erlaubt nur 500 Anfragen am Tag (Header `x-ratelimit-limit`) und lieferte nach wenigen Testläufen HTTP 429.
- **tsx-Skripte** mit `await` auf oberster Ebene müssen `.mts` heißen, sonst kommt `ERR_REQUIRE_ASYNC_MODULE`.
- **zsh** trennt `$var` nicht in Wörter. Schleifen mit `set -- $spot` funktionieren nur in bash.

## Troubleshooting

- `Port 8091 ist belegt` → `.claude/skills/run-elvis/stop.sh`
- `Playwright nicht gefunden` → `npx -y playwright@1.63.0 install chromium` oder `PLAYWRIGHT_DIR=/pfad/zu/node_modules/playwright`
- Karte zeigt „adsb.fi drosselt …“ oder „HTTP 429“ → einige Sekunden warten. Der Server pausiert selbst und zeigt so lange den letzten Stand.
