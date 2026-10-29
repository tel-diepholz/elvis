# Karten, Offline-Cache und Druck

Kartenkacheln laufen über den Fahrzeugserver (`/api/map/tiles/…`). Jede geladene Kachel wird unter
`data/tiles/` gespeichert und steht danach auch ohne Internet zur Verfügung. Nach `cacheMaxAgeDays` wird
sie neu geladen, offline bleibt der alte Stand nutzbar. Kartenquellen werden in `config/elvis.json`
festgelegt:

```json
"map": {
  "sources": [
    { "id": "osm", "name": "OpenStreetMap", "url": "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      "attribution": "© OpenStreetMap-Mitwirkende", "maxZoom": 19 },
    { "id": "lokal", "name": "Lokaler Kartenserver", "url": "http://elw-server:8081/tiles/{z}/{x}/{y}.png",
      "attribution": "© OpenStreetMap-Mitwirkende", "maxZoom": 18 }
  ]
}
```

Platzhalter: `{z}`, `{x}`, `{y}`, optional `{s}` (Subdomain aus `subdomains`) und `{r}` (`@2x` bei
`"pixelRatio": 2`). WMS-Dienste werden mit `{bbox}` (Ausschnitt der Kachel in EPSG:3857), `{width}` und `{height}`
(256 bzw. 512 px) eingebunden. Sind mehrere Quellen konfiguriert, erscheint auf der Karte und im Druckdialog eine Auswahl.

**Kartenquellen in den Einstellungen:** Admins können unter **Einstellungen → Kartenquellen** weitere Quellen
anlegen, ohne `elvis.json` zu ändern (`/api/system/map-sources`). Quellen aus `elvis.json` und von Addons erscheinen dort
nur zur Ansicht. „Testen“ lädt eine Kachel am Einsatzort (sonst in Niedersachsen) und zeigt die Fehlermeldung des Dienstes.
Ändert sich die URL einer Quelle, verwirft ELVIS ihre zwischengespeicherten Kacheln. Die Vorlage **Luftbild Niedersachsen**
bindet das Digitale Orthophoto (DOP20, 20 cm) des LGLN als WMS ein:

```
https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ni_dop20&STYLES=&CRS=EPSG:3857&BBOX={bbox}&WIDTH={width}&HEIGHT={height}&FORMAT=image/jpeg
```

Die Daten stehen unter CC BY 4.0, die Quellenangabe lautet „© GeoBasis-DE/LGLN <Jahr>“
([OpenGeoData Niedersachsen](https://ni-lgln-opengeodata.hub.arcgis.com/pages/geodatendienste)).

Über „Vorlage einfügen …“ stehen außerdem die freien DOP20-Dienste von Baden-Württemberg, Bayern, Berlin/Brandenburg,
Bremen, Hamburg, Hessen, Mecklenburg-Vorpommern, Nordrhein-Westfalen, Rheinland-Pfalz, dem Saarland, Sachsen,
Schleswig-Holstein und Thüringen bereit (Sachsen-Anhalt hat derzeit keinen erreichbaren Open-Data-WMS). Die
Quellenangaben folgen den Dienstbeschreibungen. Vor dem Einsatz die Lizenz des Landes prüfen. Weitere WMS-Dienste lassen
sich genauso eintragen, sofern sie EPSG:3857 unterstützen.

**Bedienung:** Oben links stehen Suche, das Menü „Objekte“ (Einsatzort setzen, Gauß-Fahne oder Sektor 60°
einfügen ([Ausbreitung](ausbreitung.md)), Flugzeug oder Schiff suchen ([Luft- und Schiffsverkehr](luft-und-schiffsverkehr.md)), Route planen, OpenStreetMap abfragen) und „Drucken“, oben rechts die Wahl des Kartenstils, unten links der Wind. Rechts liegt die einklappbare
**Objektliste** des laufenden Einsatzes: an erster Stelle das eigene Fahrzeug (nur ausblendbar), dann Einsatzort,
Ausbreitungen und übernommene Such- und Overpass-Treffer (Punkte, Flächen, Linien). Ein Klick fliegt
hin; Objekte lassen sich ein- und ausblenden, einstellen, einfärben (Flächen, Linien, Punkte, Sektoren – Gauß-Fahnen
behalten ihre Stufenfarben) und entfernen. Punkte bekommen über denselben Knopf auf Wunsch ein Symbol aus allen
rund 1.500 [Lucide](https://lucide.dev)-Icons (Suche mit englischen Namen, häufige Einsatzbegriffe wie „Feuer“,
„Hydrant“ oder „Krankenhaus“ auch deutsch). Es erscheint auf Karte, Bildschirmen und im Druck. Die Objekte gehören zum Einsatz
(`/api/incidents/:id/objects`): Alle Arbeitsplätze und die Kartenkacheln der Bildschirme sehen sie, sie erscheinen
im Druck, Hinzufügen und Entfernen stehen im Einsatztagebuch, und nach dem Einsatz bleiben sie im Archiv lesbar.

**Ortssuche:** Das Suchfeld oben links in der Karte findet Straßen, Orte und Adressen. Treffer in der Nähe der
Kartenmitte stehen vorn. Ein Treffer fliegt die Karte an, setzt eine Markierung mit UTMREF und lässt sich per
„Zur Objektliste“ (mit Umriss als Fläche, sonst als Punkt) oder „Als Einsatzort setzen“ übernehmen. Bei Orten, Ortsteilen und Landkreisen zeigt die Karte zusätzlich den Umriss,
sofern er in OpenStreetMap als Grenze erfasst ist (manche Ortsteile sind dort nur ein Punkt). Koordinaten erkennt ELVIS selbst, auch ohne Internet: Dezimalgrad
(`52.70986, 8.50425`), Grad/Minuten/Sekunden (`N 52° 42.591' E 8° 30.255'`), UTM (`32U 466507 5840110`) und
UTMREF/MGRS (`32U MD 66507 40110`). Gesucht wird über den Server (`GET /api/map/search`):

1. Läuft das Addon **OSM-Daten** (eigenes Nominatim mit den OSM-Daten der gewählten Regionen), fragt ELVIS zuerst dort –
   Suche und Umrisse funktionieren dann komplett offline. Dasselbe Addon liefert aus denselben Daten auch die lokale
   Karte, Routing (Valhalla) und eine Overpass-API. Es aktualisiert sich nicht selbst: Regionen in der Konfiguration
   ergänzen und den Job „Kartendaten bauen“ starten – geladen und in die Suche nachimportiert wird nur, was neu ist.
2. Findet es nichts (Nominatim erkennt halb getippte Wörter oft nicht) oder läuft kein Addon, fragt ELVIS den
   öffentlichen Dienst [photon.komoot.io](https://photon.komoot.io), einstellbar über `"map": { "geocoderUrl": "…" }`
   (`null` = nur lokal). Treffer bleiben einen Tag im Speicher und helfen auch bei kurzen Ausfällen.
3. Umrisse ohne Addon kommen vom öffentlichen Nominatim (`"map": { "outlineUrl": "…" }`, höchstens eine Anfrage je
   Sekunde). Jeder geladene Umriss bleibt in `data/outlines/` und steht danach auch offline zur Verfügung.

**Overpass-Abfragen:** Admins legen unter *Einstellungen → Overpass-Vorlagen* Abfragen an, etwa Hydranten oder
Feuerwehrhäuser. Jede Vorlage steht in der Karte direkt im Menü **Objekte** und fragt mit einem Klick OpenStreetMap im
aktuellen Kartenausschnitt ab. ELVIS bringt keine eigenen Vorlagen mit. **Objekte → OpenStreetMap abfragen …** öffnet
einen Bereich für eigene Abfragen: als einfacher Tag-Filter (z. B. `amenity` = `fire_station`, alle Filter müssen
zutreffen) oder direkt in [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL). Dort steht
`{{bbox}}` für den Ausschnitt, und `out geom;` liefert auch Linien und Flächen. Abfragen lassen sich im laufenden
Einsatz speichern (`/api/incidents/:id/overpass-queries`).

Eine Abfrage kann ein Symbol (Lucide-Icon) und ein Schild mit Tag-Werten festlegen, z. B. `DN {fire_hydrant:diameter}`.
Fehlen alle verwendeten Tags, entfällt das Schild. Die Treffer erscheinen wie Suchtreffer: Punkte als Kreis oder mit
dem Symbol samt Schild, Wege als Linie, geschlossene Wege und Multipolygone als Fläche. Ein Klick zeigt Tags und
UTMREF, „Zur Objektliste“ übernimmt das Element als Punkt (mit Symbol und Schild), Linie oder Fläche.

Gefragt wird über den Server (`POST /api/map/overpass`, höchstens 2000 Treffer, Ausschnitt bis 3°): Ist die
Overpass-API des Addons **OSM-Daten** bereit, geht die Abfrage dorthin (offline). Solange das nicht der Fall ist,
etwa weil der Job „Kartendaten bauen“ noch läuft, oder wenn sie ausfällt, fragt ELVIS den öffentlichen Server
`overpass-api.de` (einstellbar über `"map": { "overpassUrl": "…" }`, `null` = nur lokal). Der ist oft ausgelastet:
Er braucht dann 30–60 s oder lehnt mit HTTP 502 ab. ELVIS versucht es dann nach 2 und 5 s erneut.

**Route planen:** *Objekte → Route planen …* öffnet unter der Werkzeugleiste eine Box für die Halte. Start ist
das eigene Fahrzeug, sofern sein Standort bekannt ist. Weitere Halte kommen auf drei Wegen dazu:
- über das Suchfeld der Box,
- über die Auswahl „Objekt als Ziel …“ (eigenes Fahrzeug, Einsatzort, Kartenobjekte, gesetzte Kräfte),
- über „Als Ziel“ am Popup eines Suchtreffers oder an einer Zeile der Objektliste.

Neue Halte werden hinten angehängt; das bisherige Ziel wird dann Zwischenziel. Mit ↑/↓ lässt sich die Reihenfolge
ändern. Das Fahrprofil ist PKW oder LKW; LKW nutzt Valhallas Profil `truck`, das Gewichts- und Höhenbeschränkungen
beachtet.

Ab zwei Halten berechnet ELVIS die Route und zeigt sie als Linie auf der Karte, mit nummerierten Halten (Start grün,
Ziel rot), dazu Strecke und Fahrzeit.
- **In Objektliste übernehmen** legt die Route als Linie im Einsatz ab, z. B. „3,1 km · 11 min · LKW“. Sie erscheint
  damit auch auf Bildschirmen und in der Lagekarte.
- **Route drucken** erzeugt ein A4-PDF (`POST /api/print/route`) mit Übersichtskarte und Halten. Danach folgen die
  Fahrhinweise als Text, jeder mit einem kleinen Kartenausschnitt um die Stelle und einem Pfeil in die neue
  Fahrtrichtung.

Gerechnet wird ausschließlich lokal mit Valhalla aus dem Addon **OSM-Daten** (`POST /api/map/route`, Status unter
`GET /api/map/router`). Ohne dieses Addon ist der Menüpunkt gesperrt; einen öffentlichen Rückfall gibt es bewusst
nicht.

**Regenradar:** Unter *Ebenen → Regenradar* liegt das Niederschlagsradar des Deutschen Wetterdienstes über der Karte
(Open Data, 1-km-Raster, alle 5 Minuten neu). Die Leiste unten zeigt die letzten 2 Stunden und die Vorhersage für bis
zu 2 Stunden. Man kann sie abspielen oder mit dem Regler einen Zeitpunkt wählen. „Jetzt“ springt zur letzten Messung
zurück, ⓘ zeigt die Legende in mm/h. Die Bilder holt der Server (`/api/map/radar`) und hält sie im Speicher: Messungen
einen Tag, Vorhersagen bis zum nächsten Lauf. Ohne Internet bleibt der letzte Stand sichtbar. Quelle ist der
GeoServer-WMS `https://maps.dwd.de/geoserver/dwd/wms`, Ebene `Niederschlagsradar`. Abschalten lässt sich das Radar mit
`"map": { "radar": { "wmsUrl": null } }`.

**Lagekarte drucken:** Auf der Karte öffnet „Drucken“ einen Dialog mit Format (A4/A3/A2/A1), Ausrichtung,
Zoomstufe (mit Maßstabsangabe) und Kartenstil. In der Vorschau wird der Ausschnitt gewählt, indem man die Karte
unter dem Druckrahmen verschiebt. Fahrzeugstandort, Einsatzort und die sichtbaren Kartenobjekte lassen sich
einzeln zuschalten.
Das PDF entsteht auf dem Server (`POST /api/print/map`): Die Kacheln werden direkt eingebettet, Markierungen und
Ausbreitung als Vektorgrafik. Dazu kommen ein Infokasten mit Titel, DTG, Maßstab, Maßstabsleiste, Legende, Wind
und Quellenangabe sowie ein Nordpfeil. Jeder Druck wird im Bedienprotokoll vermerkt.

Hinweis zu OpenStreetMap: Die öffentlichen Kachelserver sind nicht für Massenabrufe gedacht
([Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)). Ein A1-Druck braucht rund 150 Kacheln.
Für regelmäßigen Betrieb einen eigenen oder kommerziellen Kacheldienst eintragen.

**Refill-Stil:** Die Refill-Stile von Mapzen sind Tangram-Vektorstile ohne öffentlichen Rasterdienst. Um sie zu
nutzen, die Vektorkacheln mit dem Refill-Stil selbst zu Rasterkacheln rendern (z. B. auf einem lokalen
Kartenserver) und dessen XYZ-URL als weitere Quelle eintragen. Ein ähnlicher, druckfreundlicher
Schwarz-Weiß-Stil ist Stamen Toner (Refills Vorgänger), z. B. über einen Kacheldienst mit API-Schlüssel.
