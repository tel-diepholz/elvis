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

## Technik

- Tabellen `object_types`, `library_objects`, `library_files`, Dateien unter `<dataDir>/library` (im
  [Backup](../backup.md) enthalten).
- Jeder Datensatz hat eine `uid` und eine Revision, Gelöschtes bleibt als Eintrag mit `deleted_at` stehen. Das bereitet
  den Abgleich mit der geplanten Cloud-Datenpflege vor.
- API: `GET /api/library/types`, `GET /api/library/objects?bbox=s,w,n,e&types=1,2&q=…`, `GET/PUT/DELETE
  /api/library/objects/:id`, `POST /api/library/objects/:id/files`, `GET /api/library/files/:id/content`,
  `POST /api/library/import/osm-water`; Typen unter `/api/system/library/types` (Admins). Lesen geht ohne Anmeldung,
  wie die Karte.
