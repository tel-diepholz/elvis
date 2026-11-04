# Architektur

```
packages/shared   Gemeinsame Typen: Gerätezustände, Einsatzdaten, WebSocket-Protokoll
apps/server       Fastify-Backend
  devices/        Adapter-Schicht: ein Treiber je Gerät (aktuell Simulatoren in devices/sim)
  alerts.ts       Alarmregeln (Sturm, GPS, Funk, Internet …)
  services/       Einsatzführung inkl. automatischer Tagebucheinträge
  db/             SQLite (better-sqlite3), Migrationen, revisionssicheres Tagebuch
apps/web          React + Vite, React Query, Leaflet
apps/windows      ELVIS lite: Windows-Installer (Dienst um node.exe mit apps/server und apps/web)
```

- **Live-Daten:** Der Server schickt Gerätezustände und Meldungen per WebSocket (`/api/live`). REST-Daten
  (Tagebuch, Kräfte, Dokumente) werden über `invalidate`-Nachrichten auf allen Clients aktualisiert.
- **Befehle:** `POST /api/devices/:id/commands` mit `{ action, params }`. Jeder Befehl landet im
  Bedienprotokoll, auch abgelehnte (z. B. Rufgruppe eines Handfunkgeräts umschalten).
- **Einsatztagebuch:** Einträge sind per Datenbank-Trigger unveränderlich. Korrekturen werden als neue
  Einträge mit Verweis erfasst. Kräfte-Statuswechsel, Abschnittszuordnung, Dokumente sowie das Eröffnen
  und Beenden einer Lage werden automatisch als Systemeintrag protokolliert. CSV-Export ist möglich.

## Ausbaustufen (Edition)

`edition` in der Konfiguration (bzw. `ELVIS_EDITION`) ist `full` (Fahrzeugserver, Vorgabe) oder `lite`
(Windows-Dienst, siehe [Installation](../installation.md#elvis-lite-windows-elw-1)). Es gibt **eine** Codebasis:

- `packages/shared/src/edition.ts`: `Edition`, die in lite erlaubten Module (`LITE_DEVICE_IDS`).
- Server (`config.ts` → `applyEdition`): lite schaltet Docker/Addons ab, Scan-Empfang per SMTP aus und heißt
  „ELW 1“. `DeviceConfigStore` lässt in lite nur die erlaubten Module zu – alle anderen bleiben aus, auch wenn
  Konfiguration oder Datenbank etwas anderes sagen. `/api/info` meldet `edition`.
- Web: Nav-Einträge mit `requiresVehicle` (`components/nav.ts`) und Übersichtskacheln mit `requiresVehicle`
  (`packages/shared/src/dashboard.ts`) entfallen in lite; die Übersicht hat dort eine eigene Grundeinstellung.
- `apps/windows`: bündelt den Server mit tsup zu einem ESM-Bündel (nur `better-sqlite3`, `pdfkit`, `dockerode`
  bleiben extern), legt ihn mit `node.exe`, der Weboberfläche und WinSW in einen Programmordner und baut daraus einen
  NSIS-Installer. Der Dienst setzt `ELVIS_EDITION=lite`; die Weboberfläche läuft unverändert im Browser.

Neue Funktionen, die Fahrzeugtechnik voraussetzen, bekommen `requiresVehicle`; alles andere ist automatisch auch
in ELVIS lite verfügbar.
