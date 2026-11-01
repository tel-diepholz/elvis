# WhatsApp (Cloud API)

ELVIS nutzt die offizielle **WhatsApp Cloud API** von Meta mit einer eigenen Rufnummer (WhatsApp Business). Gesendet
wird direkt über die Graph API. Eingehende Nachrichten und Zustellbestätigungen schickt Meta als Webhook an das
[Cloud-Relay](https://github.com/tel-diepholz/elvis-relay), ELVIS holt sie dort ab. Der ELW braucht also keine
öffentliche Adresse. Die Nachrichten stehen unter [Nachrichten](../funktionen/nachrichten.md).

## Einrichten

1. Im [Meta-Entwicklerportal](https://developers.facebook.com) eine App vom Typ *Business* anlegen und das Produkt
   *WhatsApp* hinzufügen. Eine eigene Rufnummer registrieren. Sie ist danach nicht mehr in der WhatsApp-App nutzbar.
2. In den Business-Einstellungen einen **Systembenutzer** anlegen und ihm ein dauerhaftes Zugriffstoken mit den Rechten
   `whatsapp_business_messaging` und `whatsapp_business_management` geben. Das Testtoken des API-Setups läuft nach
   24 h ab.
3. Unter **Einstellungen → Fahrzeugmodule → WhatsApp** den Treiber „WhatsApp Cloud API (Meta)“ wählen und Folgendes
   eintragen: die **Phone-Number-ID** (WhatsApp → API-Setup), das Zugriffstoken und das **App-Geheimnis**
   (App-Einstellungen → Allgemein).
4. Die Karte **WhatsApp-Konto** zeigt **Rückruf-URL** und **Prüf-Token**. Beide im Entwicklerportal unter *WhatsApp →
   Konfiguration → Webhook* eintragen und das Feld **messages** abonnieren.

## 24-Stunden-Fenster und Vorlagen

Freie Nachrichten erlaubt WhatsApp nur bis 24 h nach der letzten Nachricht der Gegenstelle. Danach geht nur eine bei
Meta **freigegebene Vorlage**, z. B. „Nachricht von {{1}}“ in der Kategorie *Utility*. Ihren Namen und ihre Sprache
in den Moduleinstellungen eintragen. Hat die Vorlage einen Textbaustein `{{1}}`, setzt ELVIS den Nachrichtentext dort
ein (einzeilig). Ohne Vorlage sendet ELVIS außerhalb des Fensters nicht. Im Feld „An“ steht dann bei der Nummer „über
24 h ohne Nachricht: nur als Vorlage“. Meta berechnet Gespräche nach Kategorie; Antworten im Fenster sind kostenlos.

## Funktionen

- Text, Bilder und Standorte senden und empfangen, „zugestellt“ und „gelesen“.
- Erreichbarkeit: Die Cloud API verrät nicht, ob eine Nummer WhatsApp nutzt. Eine Nummer gilt als erreichbar, sobald es
  einmal eine Nachricht mit ihr gab.
- ELVIS prüft die Signatur jedes Webhooks mit dem App-Geheimnis. Aufrufe mit falscher Signatur oder für eine andere
  Phone-Number-ID verwirft es.
- Ohne Cloud-Relay (`app.relayUrl` ist `off`) geht nur das Senden.
