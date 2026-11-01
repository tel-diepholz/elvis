# Telegram

ELVIS nutzt ein eigenes **Telegram-Konto** des Fahrzeugs (MTProto über [gramjs](https://gram.js.org), kein Bot). Ein
Bot dürfte niemanden zuerst anschreiben und keine Rufnummern prüfen. Die Nachrichten stehen unter
[Nachrichten](../funktionen/nachrichten.md).

## Einrichten

1. Eine Rufnummer für das Fahrzeugkonto bei Telegram anmelden, z. B. mit der Telegram-App auf einem Handy.
2. Auf [my.telegram.org](https://my.telegram.org) mit dieser Nummer anmelden und unter *API development tools* eine
   Anwendung anlegen. Das liefert **API-ID** und **API-Hash**.
3. Unter **Einstellungen → Fahrzeugmodule → Telegram** den Treiber „Telegram-Konto (MTProto)“ wählen, API-ID,
   API-Hash und Rufnummer eintragen und übernehmen.
4. In der Karte **Telegram-Konto** auf **Anmelden** drücken. Telegram schickt einen Code an die Telegram-App (sonst
   per SMS). Code eingeben und bei zweistufiger Bestätigung das Passwort.

Die Sitzung bleibt in der Datenbank (gehört zum Backup). **Abmelden** löscht sie. Codes und Passwort landen nicht im
Bedienprotokoll.

## Funktionen

- Text, Bilder und Standorte senden und empfangen. Telegram meldet „gelesen“, aber kein „zugestellt“.
- Erreichbarkeit: ELVIS übernimmt die Mobilnummern der Kontakte als Kontakte des Telegram-Kontos. So erfährt ELVIS, wer
  Telegram nutzt; diese Kontakte erscheinen auch in der Telegram-App des Kontos (Nachname „(ELVIS)“). Telegram
  begrenzt solche Abfragen, ELVIS prüft deshalb höchstens 50 neue Nummern alle fünf Minuten.
- Antworten von Personen, die ihre Rufnummer nicht teilen, ordnet ELVIS über die Telegram-ID zu. Empfänger lassen sich
  auch als Benutzername (`@name`) eingeben.
- Nur Einzelchats. Gruppen und Kanäle werden nicht übernommen.
