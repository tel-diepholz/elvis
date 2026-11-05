# Objektbibliothek

Die Objektbibliothek hält Objekte fest, die über eine Lage hinaus gelten: Wasserentnahmestellen, Einsatzobjekte und
beliebige eigene Typen, z. B. Sammelplätze oder Gefahrstofflager. Sie steht unter **Verwaltung → Objektbibliothek**
und lässt sich auf der Karte einblenden.

## Typen

*Einstellungen → Objekttypen* (Admins). Jeder Typ hat Name, Symbol, Farbe und eigene **Felder**: Text, mehrzeiliger
Text, Zahl (mit Einheit), Auswahl, Ja/Nein, Link oder Telefon. Ein Feld kann als **Schild** am Kartensymbol erscheinen,
z. B. „DN 100“.

| Typ | Felder (Vorgabe) | Schild |
| --- | --- | --- |
| **Wasserentnahmestelle** | Art (Hydrant Unter-/Überflur/Wand, Löschwasserbrunnen, Löschteich, Löschwasserbehälter, Saugstelle, offenes Gewässer), Nennweite, Leistung l/min, Volumen m³, Druck bar | DN |
| **Einsatzobjekt** | Objektnummer, Brandmeldeanlage, FSD/FBF-Standort, Ansprechpartner, Telefon, Gefahren, Zufahrt | Objektnummer |

Die beiden vorgegebenen Typen lassen sich nicht löschen, ihre Felder bleiben, weitere lassen sich ergänzen. Eigene Typen
lassen sich löschen, sobald sie keine Objekte mehr haben.

## Objekte pflegen

Alle Angemeldeten pflegen Objekte. Die Liste filtert nach Typ und sucht in Name, Adresse, Bemerkung und Feldwerten.

- **Neues Objekt:** Typ, Name, Adresse und Position. Die Position setzt man per Klick in die Karte, durch Ziehen der
  Markierung oder über die Adresssuche (übernimmt auch die Adresse, wenn sie noch leer ist).
- **Dateien:** Nach dem Speichern lassen sich Dateien anhängen, z. B. Feuerwehrpläne oder Objektinformationen (höchstens
  50 MB je Datei). Sie öffnen sich im Browser oder lassen sich herunterladen.
- **Aus OpenStreetMap:** übernimmt Hydranten, Saugstellen, Löschteiche, Löschwasserbehälter und Brunnen im gezeigten
  Ausschnitt als Wasserentnahmestellen (über das Addon OSM-Daten oder overpass-api.de, siehe [Karte](karte.md)). Art,
  DN, Leistung, Volumen und Druck kommen aus den OSM-Tags. Ein zweiter Import überspringt schon übernommene Objekte
  (gleiche OSM-ID). Die OSM-Daten sind oft unvollständig, bitte mit den Plänen des Wasserversorgers abgleichen.

Jede Änderung steht im Bedienprotokoll (Ziel `objektbibliothek`).

## Auf der Karte

*Karte → Ebenen → Objektbibliothek* blendet die Objekte ein. Darunter lässt sich jeder Typ einzeln ein- und ausblenden.
Die Auswahl merkt sich der Browser. Ab Zoomstufe 11 lädt die Karte die Objekte des Ausschnitts, ab Zoomstufe 15
erscheinen sie mit Symbol und Schild, darunter als Punkte. Flächen und Linien aus OSM (z. B. Löschteiche) zeigt sie ab
Zoomstufe 13.

Ein Klick zeigt Felder, Bemerkung, Dateien und UTMREF. **In Lage übernehmen** legt das Objekt als Punkt mit Symbol und
Schild in die Objektliste der laufenden Lage. Das ist eine Kopie, spätere Änderungen in der Bibliothek ändern die Lage
nicht.

## In der Cloud

Ist die Installation mit dem [Cloud-Zugang](cloud-zugang.md) verknüpft und der Stammdaten-Abgleich gestartet, gleicht
ELVIS die Objektbibliothek mit ab. Das umfasst Typen, Objekte und angehängte Dateien.

- **Sichtbarkeit je Typ:** Der Typ legt fest, wer seine Objekte sieht, und zwar *Bereiche darüber und darunter*
  (Vorgabe), *nur darunter*, *nur darüber* oder *nur der eigene Bereich*. Ein Kreis-Typ „darunter“ zeigt seine
  Objekte jeder Gemeinde im Kreis. Einstellbar ist das in ELVIS im Typ-Editor und im Portal.
- **Vordefinierte Typen** (Wasserentnahmestelle, Einsatzobjekt) haben in jeder Installation und in der Cloud dieselbe
  ID. Gepflegt werden sie zentral, in ELVIS sind sie dann nur lesbar.
- **Objekte anderer Bereiche** sind hier nur lesbar, mit Schloss und dem Namen des Bereichs. In die Lage übernehmen
  geht trotzdem.
- **Dateien** gehen mit, höchstens 50 MB je Datei. ELVIS lädt eigene Dateien vor dem Datensatz hoch und holt fremde
  danach ab. Die Prüfsumme muss stimmen.
- **Erster Abgleich:** Objekte aus demselben OSM-Import (gleiche OSM-ID) oder mit gleichem Typ, Namen und Ort werden
  zusammengeführt statt doppelt angelegt.
- **Im Portal** hat jeder Bereich eine Kartenansicht seiner Objekte, ein Formular mit Dateien und einen **CSV-Import**,
  z. B. für Hydrantenlisten des Wasserversorgers. Die Kopfzeile lautet `name;lat;lon` und kann `address;notes` und die
  Feldschlüssel enthalten, etwa `dn` oder `art`.

## Technik

- Tabellen `object_types`, `library_objects`, `library_files`, Dateien unter `<dataDir>/library` (im
  [Backup](../backup.md) enthalten).
- Jeder Datensatz hat eine `uid` und eine Revision, Gelöschtes bleibt als Eintrag mit `deleted_at` stehen. Daraus
  erkennt der Cloud-Abgleich Löschungen.
- API: `GET /api/library/types`, `GET /api/library/objects?bbox=s,w,n,e&types=1,2&q=…`, `GET/PUT/DELETE
  /api/library/objects/:id`, `POST /api/library/objects/:id/files`, `GET /api/library/files/:id/content`,
  `POST /api/library/import/osm-water`; Typen unter `/api/system/library/types` (Admins). Lesen geht ohne Anmeldung,
  wie die Karte.
