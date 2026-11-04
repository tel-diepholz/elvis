# Nachrichten

Unter **Nachrichten** (Navigation unter „Fahrzeug“) lesen und schreiben alle Angemeldeten SMS und Messenger-Nachrichten
in einer gemeinsamen Ansicht. Die Seite ist wie die [E-Mail](email.md) aufgebaut. Ein kleines Symbol an jeder Nachricht
zeigt den Kanal. Der Eintrag erscheint, sobald mindestens ein Kanal aktiv ist. Ein Zähler zeigt ungelesene Nachrichten.

## Kanäle

| Kanal | Modul | Hinweis |
|---|---|---|
| SMS | [Telefonie](../fahrzeugmodule/telefonie-yeastar-tg.md) | über das GSM-Gateway, erreicht jede Mobilnummer |
| Signal | Signal | [signal-cli](../fahrzeugmodule/signal-cli.md) |
| Threema | Threema | [Gateway (E2E)](../fahrzeugmodule/threema-gateway.md) |
| WhatsApp | WhatsApp | [Cloud API](../fahrzeugmodule/whatsapp-cloud-api.md) |
| Telegram | Telegram | [Telegram-Konto](../fahrzeugmodule/telegram.md) |
| Fahrzeug-Chat | – (Cloud Messaging) | an andere ELVIS-Installationen, siehe [Cloud Messaging](cloud-messaging.md) |

Die Messenger sind eigene Fahrzeugmodule unter **Einstellungen → Fahrzeugmodule**, jeweils mit echtem Treiber und
dem Treiber **Simulation**. Die Simulation sendet nach einer Sekunde und meldet danach „zugestellt“ und „gelesen“.
Eine Nachricht mit „#fehler“ schlägt fehl. WhatsApp und Threema empfangen über das Cloud-Relay, Signal und Telegram
brauchen es nicht.

## Bedienung

- **Eingang und Gesendet:** Die Liste zeigt Kanal, Absender bzw. Empfänger, Text und Zeitpunkt. Ist die Rufnummer in
  den [Kontakten](kontakte.md), steht dort der Name, sonst der Name aus dem Messenger. Gesendete Nachrichten zeigen ihren
  Zustand: wird gesendet, gesendet, zugestellt, gelesen oder fehlgeschlagen (mit Grund).
- **Lesen:** Eine geöffnete Nachricht gilt als gelesen. Darunter steht der Verlauf mit dieser Rufnummer über alle
  Kanäle. Bilder erscheinen als Vorschau. Ein Standort öffnet mit **In Karte zeigen** die Karte an dieser Stelle; von
  dort lässt er sich als Objekt oder Einsatzort übernehmen. Im Lesefenster gibt es diese Aktionen: Antworten (über
  denselben Kanal), als ungelesen markieren, löschen und bei unbekannter Nummer **Als Kontakt anlegen**.
- **Senden:** Ins Feld „An“ kommen Rufnummern, Namen aus den Kontakten oder Kennungen wie eine Threema-ID. Mehrere
  Empfänger werden durch Komma getrennt. Je Empfänger ist der erste Kanal vorgewählt, über den er erreichbar ist (✓ in
  der Auswahl). Die Reihenfolge stellt ein Admin unter **Einstellungen → Nachrichten** ein; Vorgabe ist Signal,
  Threema, WhatsApp, Telegram, SMS. Dazu lassen sich ein Bild sowie der Einsatzort oder der Fahrzeugstandort anhängen.
  Per SMS gehen keine Bilder, ein Standort geht dort als Kartenlink. Bei SMS zeigt ein Zähler Zeichen und Teile:
  160 Zeichen je SMS, mit Sonderzeichen außerhalb des GSM-Zeichensatzes (z. B. Emoji) nur 70, höchstens 640 Zeichen.
  Bei zwei Trunks lässt sich der Absende-Trunk wählen. Jede gesendete Nachricht steht im Bedienprotokoll.
- **Erreichbarkeit im Adressbuch:** An jeder Rufnummer in den [Kontakten](kontakte.md) stehen die Symbole der Kanäle,
  über die sie erreichbar ist. Ein Klick öffnet eine neue Nachricht über diesen Kanal. Signal, Threema und Telegram
  prüft ELVIS für die Mobilnummern der Kontakte (nach Änderungen sofort, sonst wöchentlich). WhatsApp lässt sich nicht
  prüfen und gilt nach der ersten Nachricht als erreichbar. SMS erreichen jede Mobilnummer.
- **Meldungen per Nachricht:** In der laufenden Lage erfassen Fernmelder eine eingegangene Nachricht mit **Meldung
  erstellen** als Eingangsmeldung. Wählen sie als Absender eine Kraft der Lage oder eine Systemeinheit, merkt sich
  diese die Rufnummer (änderbar an der Einheit). Beim nächsten Mal ist sie vorausgewählt. Bei Ausgangsmeldungen bietet
  der Meldungsdialog **Per Nachricht senden** an. Ist die Rufnummer des Empfängers bekannt, ist sie vorbelegt. Nach dem
  Senden gilt die Meldung als erledigt.
