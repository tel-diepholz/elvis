# Addon-Manifest (`addon.yaml`)

Aus den `options` des Manifests erzeugt ELVIS das Konfigurationsformular.
Client und Server prüfen mit demselben Schema (`packages/shared/src/addons.ts`).

```yaml
id: hello
name: Hallo ELVIS
version: 1.0.0
arch: [amd64, arm64]
options:
  port: { type: int, label: Port auf dem Host, default: 8099, min: 1024, max: 65535 }
containers:
  - name: web
    image: traefik/whoami:v1.10          # besser per Digest festlegen
    env: { WHOAMI_PORT_NUMBER: "8080" }
    ports: [{ container: 8080, host: "{{options.port}}" }]
jobs:                                     # einmalige Container, z. B. Daten erzeugen
  stamp: { label: Zeitstempel, image: alpine:3.20, command: [...], volumes: [{ name: data, target: /data }] }
provides:                                 # Integration in ELVIS
  mapSources: [{ id: basic, name: Lokale Karte, url: "http://{{host.address}}:{{options.port}}/{z}/{x}/{y}.png" }]
```

- Optionstypen: `string`, `password`, `int`, `bool`, `select`, `ip`. Platzhalter: `{{options.*}}`,
  `{{addon.id}}`, `{{addon.version}}`, `{{addon.secret}}` (je Addon festes Geheimnis, z. B. für Rückrufe an ELVIS),
  `{{host.address}}`, `{{host.name}}`.
- Daten liegen in benannten Volumes (`elvis-addon-<id>-<name>`) und bleiben bei Updates und Neukonfiguration
  erhalten. Privilegierte Container gibt es nicht. Host-Netzwerk, Capabilities und Ports werden vor der Installation
  angezeigt.
- Fehlt dem Zielhost das Internet, überträgt ELVIS das Image von einem anderen Host (`docker save` → `docker load`).
  Eine Registry ist nicht nötig.
- Laufende Addons mit `provides.mapSources` erscheinen automatisch als Kartenstil auf der Karte und im Druck.
  `provides.geocoders` (`{ id, name, type: photon|nominatim, url }`) ersetzt den öffentlichen Suchdienst der
  Ortssuche; bei Nominatim auch für Umrisse. `provides.routers` (`{ id, name, type: valhalla, url }`) und
  `provides.overpass` (`{ id, name, url }`) melden Routing (noch ohne Nutzung in der Oberfläche) und Overpass (ersetzt
  den öffentlichen Overpass-Server der Karte).
  `provides.office` (`{ id, name, url, wopiBase }`) meldet einen
  Office-Server mit WOPI (Collabora) für die Dokumentbearbeitung. `shmSize` (z. B. `"1g"`) vergrößert `/dev/shm`, etwa für PostgreSQL.
- Ein Job-Schritt mit `stopContainers: [<name>]` hält diese Container des Addons für die Dauer des Schritts an, etwa
  wenn Job und Dienst dieselbe Datenbank nutzen. Danach (auch nach einem Fehler) laufen sie wieder.

## Weitere Manifest-Funktionen

- `builds`: Images aus einem Dockerfile im Addon bauen, Verweis per `image: "build:<name>"`.
- `devices` und `gpus` mit Bedingung `when: { option, equals }`, z. B. nur bei passender Encoder-Wahl.
- `provides.videoSources`: Gateways mit Status-Adresse und WebRTC-Basisadresse.

Bei den jeweiligen Addons beschrieben:

- `provides.printServers` und `provides.guestPrinters`: [Drucken](../funktionen/drucken.md)
- `provides.workstations` und `apparmor: unconfined`: [Arbeitsplätze (PXE)](arbeitsplaetze-pxe.md)
- `provides.videoSources`: [NDI-Gateway](ndi-gateway.md)
