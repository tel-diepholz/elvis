# Tests

```bash
npm test             # Backend-Tests
npm run typecheck    # Typprüfung aller Pakete
npm run test:lab     # Labor (siehe unten)
```

## Labor (Addons und Docker-Hosts)

`npm run test:lab` startet ELVIS und zwei Docker-Daemons (dind) und prüft den kompletten Ablauf gegen
echte Docker-APIs: TLS, Installation, Neukonfiguration, Job, Protokolle, Image-Übertragung, Deinstallation.
Voraussetzung: Docker und Node auf dem Entwicklungsrechner.

## Diagnose der Wetterstation

Den NMEA-2000-Monitor beschreibt [Wetterstation Airmar](../fahrzeugmodule/wetterstation-airmar.md).
