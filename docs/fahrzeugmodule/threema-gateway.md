# Threema (Gateway)

ELVIS nutzt das **Threema Gateway** im **Ende-zu-Ende-Modus**. ELVIS ver- und entschlüsselt selbst, und der private
Schlüssel bleibt im Fahrzeug. Gesendet wird direkt an `msgapi.threema.ch`. Eingehende Nachrichten schickt Threema an
eine Rückruf-URL beim [Cloud-Relay](https://github.com/tel-diepholz/elvis-relay); das Relay sieht nur verschlüsselte
Daten. Die Nachrichten stehen unter [Nachrichten](../funktionen/nachrichten.md).

## Einrichten

1. Unter [gateway.threema.ch](https://gateway.threema.ch) ein Konto anlegen und Credits kaufen. Jede gesendete
   Nachricht und jede Suche nach einer Rufnummer kostet Credits.
2. Ein Schlüsselpaar erzeugen, z. B. mit dem Threema-Werkzeug `threema-msgapi-tool -g privat.txt öffentlich.txt`.
   Dann eine **E2E-Gateway-ID** (z. B. `*ELVIS01`) mit dem öffentlichen Schlüssel beantragen.
3. Unter **Einstellungen → Fahrzeugmodule → Threema** den Treiber „Threema Gateway (E2E)“ wählen und Folgendes
   eintragen: Gateway-ID, **API-Secret** und **privaten Schlüssel** (64 Hex-Zeichen, auch mit `private:` davor).
4. Die Karte **Threema-Konto** zeigt die **Rückruf-URL**. Sie im Gateway bei der ID als Callback-URL eintragen.

## Funktionen

- Text, Bilder (als Datei-Nachricht, verschlüsselter Blob) und Standorte senden und empfangen. Dazu kommen
  Empfangsbestätigungen: „zugestellt“ und „gelesen“, wenn der Empfänger sie nicht abgeschaltet hat.
- Erreichbarkeit: ELVIS sucht die Mobilnummern der Kontakte über den Hash der Rufnummer. Gefunden wird nur, wer seine
  Nummer in Threema verknüpft hat. Antworten kommen mit der Threema-ID; ELVIS ordnet sie über diese Suche dem
  Kontakt zu.
- Im Feld „An“ geht auch eine Threema-ID direkt (8 Zeichen).
- ELVIS prüft den MAC jedes Rückrufs mit dem API-Secret. Gruppen, Umfragen und andere Nachrichtentypen übernimmt ELVIS
  nicht.
- Die Kopfzeile des Moduls zeigt das Guthaben (Credits) beim Verbinden.
