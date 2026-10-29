# Kräfte und Personal

## Personal der Einheiten (Personalbögen)

Ein Klick auf eine Einheit in der Kräfteübersicht öffnet ihre **Detailseite** (`/einsatz/kraefte/:id`) mit Stammdaten,
Untereinheiten und dem **Personal**. Über *Personalbogen ausfüllen* werden eine oder mehrere Personen erfasst: Name,
Geburtsdatum, Einordnung (Führer / Unterführer / Mannschaft), Funktion, Qualifikationen, Organisation, Telefon,
E-Mail, Anschrift, Arbeitgeber, Notfallkontakt und Bemerkung. Weicht die daraus gezählte Stärke von der Einheit ab, lässt sie
sich mit einem Klick übernehmen. *An andere Einheit übergeben* verschiebt ausgewählte Personen zu einer anderen Einheit
des Einsatzes (z. B. bei falsch zugeordnetem Bogen). Ins Einsatztagebuch kommen nur Anzahlen, keine Namen.
Das Symbol *In Kontakte übernehmen* legt eine Person als [Kontakt](kontakte.md) an (auch aus abgeschlossenen Einsätzen). Das
Online-Formular fragt die E-Mail-Adresse noch nicht ab.

**Cloud-Personalabfrage:** Im *Posteingang* erzeugt ELVIS einen Link (6–72 Stunden gültig, längstens bis zum
Einsatzende; QR-Code und Kopieren). Einheitsführer tragen dort zuerst *Einheit / Fahrzeug* (Freitext) und dann ihr
Personal ein. Der Browser verschlüsselt den Bogen mit dem öffentlichen Schlüssel dieses ELW (RSA-OAEP-256 +
AES-256-GCM); das Relay speichert nur Unlesbares und löscht es mit der Abholung, spätestens nach 7 Tagen. ELVIS holt
alle 15 s ab, solange ein Link gilt. Neue Bögen markiert ein Zähler am Menüpunkt *Posteingang*; dort werden sie einer
Einheit zugeordnet oder als neue Einheit angelegt (Stärke aus dem Personal); danach verschwinden sie aus dem Eingang
und stehen beim Personal der Einheit. Nicht zugeordnete Bögen bleiben 30 Tage im Posteingang. Mit dem Ende des Links verwirft
ELVIS den privaten Schlüssel.

## App-Anbindung (Positionen von Einsatzkräften)

Einsatzkräfte können ihre Position mit der Android-App [ELVIS Ortung](https://github.com/tel-diepholz/elvis-app)
an den ELW senden. Die Positionen laufen über ein kleines **Cloud-Relay** ([ELVIS Relay](https://github.com/tel-diepholz/elvis-relay),
Cloudflare Worker mit D1).
ELVIS holt sie dort ausgehend ab, der ELW braucht also keine öffentliche Adresse.

```
App ──HTTPS──▶ Relay (Cloudflare) ◀──Abruf alle 15 s── ELVIS ──▶ Kräfteübersicht / Karte
```

- **Koppeln:** Die App zeigt nach dem Start eine App-ID (z. B. `K7M2-QX9P`) und einen 6-stelligen Code. In der
  Kräfteübersicht bei der Einheit auf das Smartphone-Symbol tippen und beides eintragen. Der Code gilt einmal;
  nach 5 Fehlversuchen zeigt die App einen neuen. Eine Einheit hat höchstens eine App, eine App gehört zu einem ELW.
- **Ortung:** Die App meldet die erste Position sofort, danach ab 10 m Bewegung, spätestens alle 10 Minuten (Regel
  `shouldSendPosition` in `packages/shared/src/applink.ts`). ELVIS setzt die Einheit auf der Karte. Ins Tagebuch
  kommen nur „App gekoppelt/entkoppelt“ und der Wechsel auf „Position per App“, nicht jede Meldung. Die Karte zeigt
  Alter und Genauigkeit im Tooltip und blasst Einheiten ohne Meldung seit 20 Minuten ab. Verschiebt man eine
  Einheit von Hand, gilt das bis zur nächsten App-Meldung.
- **Ende:** Die Kopplung endet beim Entkoppeln (Smartphone-Symbol), beim Entlassen der Einheit und mit dem Einsatz.
  Die App erfährt es mit ihrer nächsten Meldung und hört auf zu orten. Ist das Relay gerade nicht erreichbar,
  holt ELVIS das Entkoppeln nach. Die Einsatzkraft kann die Ortung in der App jederzeit stoppen.
- **Datenschutz:** Das Relay kennt nur zufällige IDs, keine Namen. Positionen löscht es mit der Abholung,
  spätestens nach 24 Stunden; unbenutzte App-IDs nach 90 Tagen. Hinweise für Nutzer: `<relay>/datenschutz`.
- **Zustand:** *Einstellungen → Dienste → App-Anbindung* zeigt Relay, Anmeldung, gekoppelte Apps und den letzten Abruf.

Das Relay läuft unter **`https://relay.einsatzleitwagen.app`** (Cloudflare Worker). Einrichtung und Betrieb beschreibt das Repo
[elvis-relay](https://github.com/tel-diepholz/elvis-relay). ELVIS und die App nutzen diese Adresse als Vorgabe; der ELW
meldet sich beim ersten Koppeln selbst beim Relay an. Ein anderes Relay oder `null` (aus) lässt sich in ELVIS
eintragen:

```json
"app": { "relayUrl": "https://relay.einsatzleitwagen.app" }
```

oder per Umgebungsvariable `ELVIS_APP_RELAY_URL` (`off` = aus). In der App ist die Adresse unter „Relay-Adresse“
änderbar. Zum Ausprobieren das Relay lokal starten (siehe elvis-relay, Port 8787) und ELVIS mit
`ELVIS_APP_RELAY_URL=http://localhost:8787` starten.
