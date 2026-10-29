# Addons und Docker-Hosts

ELVIS kann zusätzliche Dienste (z. B. einen lokalen Kartenserver) als Docker-Container auf den Fahrzeug-Servern
betreiben, ähnlich dem Addon-System von Home Assistant. Abschaltbar über `"docker": { "enabled": false }`.

## Docker-Hosts

*Verwaltung → Docker-Hosts*: ELVIS spricht direkt mit der Docker-Engine-API per TLS
(Port 2376, gegenseitige Zertifikatsprüfung). Beim Hinzufügen erzeugt ELVIS mit seiner eigenen kleinen CA ein
Server-Zertifikat und einen einmalig gültigen Befehl:

```bash
curl -fsS http://<elvis>:8080/api/docker/setup/<token>.sh | sudo sh
```

Das Skript legt die Zertifikate unter `/etc/docker/tls/` ab, ergänzt `dockerd` per systemd-Override um
`-H tcp://0.0.0.0:2376 --tlsverify …`, startet Docker neu und meldet sich bei ELVIS. Es ist wiederholbar, z. B. zur
Zertifikatserneuerung. Alternativ lassen sich vorhandene Zertifikate (CA, Client-Zertifikat, Schlüssel) eintragen.
CA und Client-Schlüssel von ELVIS liegen in `data/docker-tls/`.

## Neue IP-Adresse

Hat ein Server eine neue IP-Adresse oder einen neuen Namen bekommen, beides unter *Bearbeiten*
am Host ändern. Installierte Addons bleiben erhalten. Bei ELVIS-Zertifikaten stehen Name und Adresse im
Serverzertifikat. ELVIS zeigt deshalb nach dem Speichern einen neuen Einrichtungsbefehl, der auf dem Server ausgeführt
werden muss (`PATCH /api/docker/hosts/:id`).

## Host entfernen

Ein Host, auf dem noch Addons eingetragen sind, lässt sich nach einer zweiten Bestätigung trotzdem
entfernen (`DELETE …?force=true`), z. B. wenn der Server nicht mehr existiert. Die Addons werden dann nur aus ELVIS
ausgetragen. Container und Volumes auf dem Server bleiben unberührt.

**Port 2376 per Firewall nur aus dem Fahrzeug-LAN erreichbar machen.** Wer Zugriff auf die Docker-API hat, hat
Root-Rechte auf dem Server. Die Addon- und Host-Verwaltung ist daher Admins vorbehalten. Alle Aktionen stehen im
Bedienprotokoll.

## Docker-Host unter Windows/WSL

Zum Testen: Docker Desktop für Windows lässt sich nicht als Docker-Host anbinden, weil seine Engine in einer eigenen VM läuft und keine TLS-Konfiguration erlaubt. Stattdessen Docker Engine
direkt in einer WSL2-Distribution (z. B. Ubuntu) betreiben:

1. In der Distribution systemd aktivieren: `/etc/wsl.conf` mit `[boot]` und `systemd=true` anlegen, in Windows
   `wsl --shutdown` ausführen und die Distribution neu starten.
2. In Docker Desktop unter *Settings → Resources → WSL Integration* die Integration für diese Distribution
   abschalten (oder Docker Desktop beenden), damit sich die beiden nicht in die Quere kommen.
3. Docker Engine installieren: `curl -fsSL https://get.docker.com | sudo sh`
4. Den Einrichtungsbefehl aus ELVIS in der Distribution ausführen.
5. **Adresse:** Läuft ELVIS auf demselben Rechner, die IP der Distribution verwenden (`hostname -I`). Von anderen
   Rechnern aus ist WSL2 standardmäßig nicht erreichbar (NAT). Unter Windows 11 hilft
   `networkingMode=mirrored` im Abschnitt `[wsl2]` der Datei `%UserProfile%\.wslconfig`, dann gilt die LAN-IP des
   Windows-Rechners. Port 2376 muss zusätzlich in der Windows-Firewall freigegeben sein.

## Addons

*Verwaltung → Addons*: Repositories enthalten eine `repository.yaml` und je Addon ein Verzeichnis mit
`addon.yaml`. Die Addons liegen im eigenen Repository
[tel-diepholz/elvis-addons](https://github.com/tel-diepholz/elvis-addons):
- **Eingebaut (offline):** Das Repository ist als Git-Submodul unter `addons/` eingebunden. Nach einem Klonen ohne
  `--recurse-submodules` holt `git submodule update --init` es nach. Auch das Docker-Image enthält es.
- **Online:** Weitere Repositories (GitHub-Raw-URLs) stehen unter `"addons": { "repositories": [...] }` oder in
  `ELVIS_ADDON_REPOSITORIES` (kommagetrennt). Das Docker-Image trägt
  `https://raw.githubusercontent.com/tel-diepholz/elvis-addons/main` ein, damit neue Addon-Versionen ohne
  ELVIS-Update erscheinen. Gibt es ein Addon mehrfach, gewinnt die höhere Version, bei gleicher Version die eingebaute.
- **Addons aktualisieren:** `git submodule update --remote addons` holt den neuesten Stand ins eingebaute Repository.

Das Format der `addon.yaml` beschreibt die [Manifest-Referenz](manifest.md). Zum Testen gegen echte Docker-APIs gibt es das [Labor](../entwicklung/tests.md#labor-addons-und-docker-hosts).

## Addons mit eigener Doku

| Addon | Doku |
| --- | --- |
| NDI-Gateway | [ndi-gateway.md](ndi-gateway.md) |
| ELVIS Arbeitsplatz (PXE) | [arbeitsplaetze-pxe.md](arbeitsplaetze-pxe.md) |
| Druckserver (CUPS) | [Drucken](../funktionen/drucken.md) |
| Office (Collabora) | [Dokumente](../funktionen/dokumente.md) |
| OSM-Daten (Nominatim, Overpass, Valhalla, Kacheln) | [Karte → Ortssuche](../funktionen/karte.md) |
