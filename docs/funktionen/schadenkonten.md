# Schadenkonten

Ein Schadenkonto beschreibt eine Schadenstelle bzw. einen Einsatzabschnitt als **T-Konto**. Links stehen Schäden und
Gefahren, rechts die Kräfte und Maßnahmen. Darunter stehen die Personenschäden. Die Seite *Einsatz → Schadenkonten*
(`/einsatz/schadenkonten`) ersetzt damit den Vordruck am Rand der Lagekarte.

## Lehrbezug

Der Begriff steht in keiner Dienstvorschrift, auch nicht in FwDV 100 oder DV 102. Er ist aber feste Ausbildungspraxis an
Landesfeuerwehrschulen, beim THW und beim DRK. ELVIS folgt diesen Quellen:

- **HLFS Hessen, Lernunterlage „Führungsmittel“ (Kap. 4.2):** Das Schadenkonto zeigt den Ist-Zustand der
  Gefahrenlage und der abwehrenden Maßnahmen.
  - Im Kopf stehen laufende Nummer und eine funktaugliche Bezeichnung.
  - Eingetragen werden nur bekannte Tatsachen. Vermutetes bekommt ein „?“.
  - Erledigtes wird so gestrichen, dass es lesbar bleibt.
  - Das Schadenkonto gehört zur Lagekarte des **S2**. Die Kräfteübersicht führt der S1 getrennt davon.
  - Eintreffende Einheiten werden in das Konto „umgehängt“.
- **THW-Vordruck „Schadenkonto“:** Der Kopf enthält Schadenstelle (roter Kreis mit Nummer), Einsatzleiter und
  Fm-Verbindung. Darunter folgen die Spalten *Schäden | Kräfte*.
- **DRK Rheinland-Pfalz (Führungshilfspersonal, Stabsarbeit):** Die Lagedarstellung besteht aus Kräfteübersicht,
  Karte und Schadenkonten, je Schadenstelle ein Konto.
- **Lagemeldung Sachsen (KatS, 2023), NRW-Muster-Lagebericht:** Die Personenschäden werden gegliedert in Betroffene,
  Tote, Verletzte SK I–IV, Vermisste, Evakuierte und Unverletzte, jeweils mit „davon Einsatzkräfte“.
  - Schätzwerte werden gekennzeichnet.
  - Doppelzählungen sind möglich.

## Konto und Einsatzabschnitt

Jedes Konto ist zugleich ein **Einsatzabschnitt**.

- **Zuordnen:** In der Kräfteübersicht wählt das Feld *Einsatzabschnitt* ein offenes Konto. Mit *+ neues
  Schadenkonto …* legt man direkt dort eines an. Untereinheiten folgen wie bisher.
- **Kräfte:** Die rechte Spalte zeigt alle nicht entlassenen Einheiten des Abschnitts mit Status und Stärke.
- **Nummer:** Konten werden je Einsatz fortlaufend nummeriert. Zwei offene Konten mit gleicher Bezeichnung gibt es
  nicht.
- **Kopfdaten:** Abschnittsleiter (eine Einheit des Einsatzes oder Freitext) und Fm-Verbindung.
- **Auflösen:** Das geht erst, wenn keine aktive Einheit mehr im Abschnitt ist. Aufgelöste Konten bleiben lesbar
  und zählen weiter zur Summe der Personenschäden.

Bei der Umstellung werden die bisherigen Freitext-Abschnitte automatisch zu Konten. Die Nummern folgen der
Reihenfolge, in der die Abschnitte zuerst vorkamen.

## Einträge

*Schaden*, *Gefahr* und *Maßnahme* haben eine Beschreibung und/oder ein Zeichen nach DV 102, dazu optional eine
Anzahl.

- **Unbestätigt:** Das Fragezeichen-Symbol markiert einen Eintrag als unbestätigt. Er wird dann mit vorangestelltem
  „?“ angezeigt.
- **Erledigt:** Das Häkchen streicht einen Eintrag durch, gelöscht wird nichts. *n erledigt* blendet die erledigten
  Einträge ein und aus.

## Personenschäden

Ein Klick auf die Zeile unter dem T-Konto öffnet die Personenschäden des Kontos.

- **Buchen:** Man bucht je Kategorie den **neuen Stand** (keine Zu- und Abgänge), dazu „davon Einsatzkräfte“,
  *Schätzwert* und eine Bemerkung, z. B. die Quelle der Meldung.
- **Verlauf:** Jede Buchung bleibt im Verlauf. Die Tabelle `damage_counts` lässt sich nicht ändern.
- **Summe:** Oben auf der Seite stehen die Summen über alle Konten mit Uhrzeit des Stands. Ein „~“ bedeutet, dass
  ein Schätzwert dabei ist.

## Karte, Übersicht, Bildschirme

- **Karte:** Konten mit Position erscheinen als roter Kreis mit Nummer.
  - Das Popup zeigt offene Schäden und Gefahren, die Personenschäden und einen Link zur Seite.
  - Das Kartensymbol am Konto öffnet die Karte (`/karte?konto=<id>`): Ohne Position setzt man das Konto per Tippen,
    mit Position fliegt die Karte hin und das Konto lässt sich verschieben.
  - Im Zeitstrahl der Karte erscheinen die Konten nicht.
- **Kachel „Schadenkonten“** (Übersicht und Bildschirme): Sie zeigt je offenem Konto Nummer, Name, einen Hinweis
  auf offene Gefahren, die Stärke der Kräfte sowie Verletzte, Tote und Vermisste. Darunter steht die Summe.

## Einsatztagebuch

Jede Änderung steht unter der Kategorie *Lage* im Einsatztagebuch, zum Beispiel:
„Schadenkonto 1 Bahnhof: Verletzte SK II 3 → ~5 (davon 1 EK) (geschätzt)“.

## Schnittstelle

| Methode | Pfad | Zweck |
|---|---|---|
| GET/POST | `/api/incidents/:id/damage-accounts` | Konten mit Einträgen und aktuellem Stand, Konto einrichten |
| GET/PATCH | `/api/damage-accounts/:id` | Konto lesen, Kopfdaten und Position ändern |
| POST | `/api/damage-accounts/:id/close` | Konto auflösen |
| POST | `/api/damage-accounts/:id/entries` | Eintrag anlegen |
| PATCH | `/api/damage-entries/:id` | Eintrag ändern, „?“, erledigt |
| GET/POST | `/api/damage-accounts/:id/counts` | Verlauf der Personenschäden, neuen Stand buchen |

Bildschirme dürfen die Liste der Konten ohne Anmeldung lesen.
