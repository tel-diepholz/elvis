# Energiefluss

Die Seite **Energie** zeigt oben, wie die Energie im Fahrzeug fließt: Quellen und Verbraucher stehen um das Fahrzeug,
Linien führen zur Mitte. Laufende Punkte zeigen die Richtung, und je mehr Leistung fließt, desto schneller laufen sie.
Plätze ohne Fluss oder ohne aktuelle Werte sind blass. Die Batterie ist nach ihrem Ladezustand gefüllt. Die Mitte
zeigt, was gerade von außen eingespeist wird. Unter der Grafik stehen alle Werte auch als Tabelle.

## Plätze und Datenquellen

Es gibt sechs Plätze: oben, links oben und unten, rechts oben und unten, unten. Admins belegen sie unter
*Einstellungen → Energiefluss* (oder auf der Seite Energie über „Anpassen“). Die Vorschau zeigt dabei die Live-Werte.
Je Platz:

- **Art:** Landstrom, Generator, Solar, Lichtmaschine, Ladegerät, AC-Verbraucher, DC-Verbraucher oder Batterie. Die Art
  bestimmt Symbol, Farbe und Richtung. Quellen speisen ein, Verbraucher nehmen ab, die Batterie macht beides.
- **Bezeichnung**, z. B. „Landstrom 16 A“ oder „Aufbaubatterie“.
- **Werte von:**

  | Quelle | liefert |
  | --- | --- |
  | Wechselrichter: Landstrom-Eingang | Spannung, Strom, Leistung (alle Phasen), Zustand |
  | Wechselrichter: AC-Ausgang | Spannung, Strom, Leistung |
  | Wechselrichter: Batterieseite (DC) | Spannung, Strom, Leistung – nur der Anteil des Wechselrichters |
  | SmartShunt/BMV (Bluetooth) | Spannung, Strom, Leistung, Ladezustand |
  | Solarladeregler (Bluetooth) | PV-Leistung, Spannung, Ladestrom, Zustand |
  | Ladegerät Blue Smart/Phoenix (Bluetooth) | Spannung, Strom, Leistung, Zustand |
  | Orion DC/DC (Bluetooth) | Ausgangsspannung, Zustand – Instant Readout sendet keinen Strom |
  | Lithium Battery Smart (Bluetooth) | Spannung |
  | Bilanz | was nach allen anderen Plätzen übrig bleibt |

- **Zusätzlich:** Eine zweite Quelle füllt Werte, die der ersten fehlen. Ein Beispiel ist die Batterie, die ihren Strom
  vom Wechselrichter und den Ladezustand vom SmartShunt bekommt.

Die **Bilanz** taugt für Verbraucher ohne eigenen Messpunkt, typischerweise die DC-Verbraucher. Das funktioniert nur,
wenn ein Shunt die Batterie misst: Was eingespeist wird und weder in die Batterie noch an den AC-Ausgang geht, nehmen
die DC-Verbraucher (samt Wandlungsverlusten). Der Batteriestrom des Wechselrichters zählt nur dessen eigenen Anteil, und
mit ihm ergäbe die Bilanz nur die Verluste.

## Automatische Belegung

Solange nichts gespeichert ist, stellt ELVIS die Plätze aus den vorhandenen Geräten zusammen:

- Wechselrichter: Landstrom links oben, AC-Ausgang rechts oben
- Batterie unten, vom SmartShunt, sonst vom Wechselrichter (eine Lithium-Batterie ergänzt dann die Spannung)
- Solarladeregler oben
- Orion als Lichtmaschine links unten
- Ladegeräte auf freien Plätzen links
- Mit Shunt: DC-Verbraucher als Bilanz rechts unten

„Automatische Belegung übernehmen“ lädt diesen Vorschlag zum Bearbeiten. „Zurück auf automatisch“ verwirft die
gespeicherte Belegung. Jede Änderung landet im Bedienprotokoll.

## Farben

Landstrom, Generator und Ladegerät haben dieselbe Farbe für „Einspeisung von außen“ und unterscheiden sich am Symbol.
Die Farben sind für den hellen und den dunklen Hintergrund und für Farbsehschwächen geprüft. Werte und Beschriftungen
stehen immer als Text daneben.
