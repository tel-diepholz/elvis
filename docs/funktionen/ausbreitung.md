# Ausbreitungsberechnung (Karte)

Über „Objekte“ in der Karte lassen sich beliebig viele **Gauß-Fahnen** und schematische **60°-Sektoren** in
Windrichtung einfügen – per Tipp in die Karte oder direkt am Einsatzort. Ihre Einstellungen stehen in der
Objektliste. Wind und Richtung kommen live von der Wetterstation. Liefert sie keine Winddaten (keine Station
eingerichtet oder Sensor ausgefallen), zeigt die Gauß-Fahne in der Objektliste zwei Regler: Windrichtung in Grad (woher, in 5°-Schritten)
und Windgeschwindigkeit (0–20 m/s). Vorgabe ist Westwind mit 3 m/s. Der Wind von Hand wird an der Fahne gespeichert und
gilt damit auf allen Arbeitsplätzen, auf Bildschirmen und im Druck. Kommen wieder Winddaten von der Station, gelten diese.

- **Modell** (`packages/shared/src/dispersion.ts`): stationäre Gauß-Fahne mit Bodenreflexion und Windprofil,
  angelehnt an den Ansatz von VDI 3783 Blatt 1. Die Ausbreitungsklasse nach Klug/Manier (I–V) wird automatisch
  aus Wind, Sonnenhöhe und Bedeckungsgrad (manuell) bestimmt oder von Hand gewählt.
- **Parameter:** σy/σz nach Briggs (offenes Gelände bzw. Bebauung). Sie sind in `SIGMA_PARAMETERS` gekapselt und
  sollten durch die Koeffizienten aus VDI 3783 Blatt 1 ersetzt werden, sobald die Norm vorliegt.
- **Darstellung:** drei Stufen c/Q ≥ 10⁻³ / 10⁻⁴ / 10⁻⁵ s/m³. Mit einer Freisetzungsrate in kg/s erscheinen
  die Stufen in mg/m³.
- **Grenzen:** kein Gelände, keine Bebauung im Detail, kein Schwergas, kein thermischer Auftrieb, kein
  Inversionsdeckel. Bei Wind unter 1 m/s ist das Modell nicht belastbar, dann erscheint ein Warnhinweis.
  Das Ergebnis ist **nur eine Orientierung**, keine Grundlage für Grenzwertentscheidungen.
