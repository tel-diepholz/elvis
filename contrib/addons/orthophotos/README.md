# Addon „Luftbilder (Orthophotos der Länder)“

Die Vermessungsverwaltungen der Länder veröffentlichen digitale Orthophotos (DOP) als Open Data.
Dieses Addon lässt die Bundesländer auswählen, lädt die GeoTIFF/JP2-Dateien, erzeugt per GDAL
lokale XYZ-Kacheln und stellt sie über nginx bereit. ELVIS bindet sie als Kartenstil „Luftbild (lokal)“
ein (`provides.mapSources`, auch im Druck nutzbar).

- `addon.yaml` – Manifest (siehe `docs/addons/manifest.md`)
- `files/catalog.json` – Sammlung der Quellen aller 16 Länder (Behörde, Portal, Lizenz, Auflösung, Index-Adresse)
- `files/scripts/fetch.py` – Download aus dem Verzeichnis-Index (Filter, Höchstzahl, wiederaufnehmbar)
- `files/scripts/tile.sh` – `gdalbuildvrt` → `gdalwarp` (EPSG:3857) → `gdal2tiles.py --xyz`

## Stand / Einschränkungen

- Das Verzeichnis `addons/` ist ein Submodul (`elvis-addons`). Diese Vorlage liegt deshalb unter `contrib/addons/`
  und muss als `orthophotos/` in `elvis-addons` übernommen werden.
- Index-Adressen (`feed`) sind nur für NRW und Brandenburg hinterlegt; für die übrigen Länder ist das Portal
  bekannt, die Adresse lässt sich per Option „Eigene Index-Adressen“ ergänzen. Adressen und Lizenzen wurden
  **nicht gegen die Live-Dienste geprüft** (kein Netzzugriff bei der Erstellung).
- Bayern, BW, Niedersachsen u. a. liefern teils nur Atom-Feeds oder Download-Seiten ohne Direktlinks; dafür muss
  `fetch.py` ggf. erweitert werden.
- Speicherbedarf: Landesweite Daten erreichen schnell Hunderte GB bis TB – Dateifilter und Zoomstufen nutzen.
- Beim Weitergeben der Kacheln Lizenz/Namensnennung des jeweiligen Landes beachten (`license` im Katalog).
