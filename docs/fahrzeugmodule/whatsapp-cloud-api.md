# WhatsApp (Cloud API)

ELVIS nutzt die offizielle **WhatsApp Cloud API** von Meta mit einer eigenen Rufnummer (WhatsApp Business). Gesendet
wird direkt über die Graph API. Eingehende Nachrichten und Zustellbestätigungen schickt Meta als Webhook an das
[Cloud-Relay](https://github.com/tel-diepholz/elvis-relay), ELVIS holt sie dort ab. Der ELW braucht also keine
öffentliche Adresse. Die Nachrichten stehen unter [Nachrichten](../funktionen/nachrichten.md).

Die Einrichtung dauert beim ersten Mal etwa eine Stunde, dazu kommt die Wartezeit auf Prüfungen durch Meta
(Anzeigename, ggf. Unternehmensverifizierung). Bezeichnungen und Menüs bei Meta ändern sich gelegentlich; die Schritte
unten beschreiben den Stand Ende 2026.

## Überblick

| Was | Wo bei Meta | Wohin in ELVIS |
|---|---|---|
| Phone-Number-ID | Entwicklerportal → App → WhatsApp → API-Setup | Moduleinstellung „Phone-Number-ID“ |
| Dauerhaftes Zugriffstoken | Meta Business Suite → Unternehmenseinstellungen → Systembenutzer | Moduleinstellung „Zugriffstoken“ |
| App-Geheimnis | Entwicklerportal → App → App-Einstellungen → Allgemein | Moduleinstellung „App-Geheimnis“ |
| Rückruf-URL und Prüf-Token | – | stehen in ELVIS in der Karte **WhatsApp-Konto**, kommen ins Entwicklerportal |
| Vorlage (optional) | WhatsApp Manager → Nachrichtenvorlagen | Moduleinstellung „Vorlage außerhalb des 24-h-Fensters“ |

## Vorbereitung

- **Rufnummer:** Eine Nummer nur für WhatsApp in ELVIS, z. B. die SIM im GSM-Gateway. Sie muss eine SMS oder einen
  Anruf empfangen können (Bestätigungscode). **Ist die Nummer bereits in der WhatsApp-App (privat oder Business-App)
  registriert, dort zuerst das Konto löschen** – eine Nummer kann normalerweise nur an einer Stelle aktiv sein. Steckt
  die SIM im GSM-Gateway, kommt der Code unter **Nachrichten** in ELVIS an.
- **Facebook-Konto** einer verantwortlichen Person, mit dem die Organisation bei Meta verwaltet wird.
- **Meta-Unternehmensportfolio** (Business-Konto) für die Organisation, z. B. „Feuerwehr Musterstadt“. Wird beim
  Anlegen der App sonst neu erstellt.
- **Zahlungsmethode** (Kreditkarte) – nur nötig, wenn ELVIS Vorlagen außerhalb des 24-h-Fensters senden soll
  (siehe [Kosten](#kosten)).
- **Datenschutzerklärung** unter einer öffentlichen Adresse (z. B. auf der Website der Organisation). Meta verlangt
  sie, um die App in den Livebetrieb zu schalten.
- In ELVIS: Das **Cloud-Relay** muss eingeschaltet sein (Vorgabe, `app.relayUrl`), sonst kommen keine Nachrichten an.

## 1. App im Meta-Entwicklerportal anlegen

1. [developers.facebook.com](https://developers.facebook.com) öffnen, mit dem Facebook-Konto anmelden und ggf. als
   Entwickler registrieren.
2. **Meine Apps → App erstellen**. Als Anwendungsfall „Andere“ bzw. „Mit Kunden über WhatsApp in Kontakt treten“
   wählen, als App-Typ **Business**.
3. Name der App, z. B. „ELVIS ELW 2“, Kontakt-E-Mail und das **Unternehmensportfolio** der Organisation wählen.
4. In der App beim Produkt **WhatsApp** auf **Einrichten** klicken. Meta legt dabei ein **WhatsApp-Business-Konto**
   (WABA) an oder verknüpft ein vorhandenes.

## 2. Rufnummer hinzufügen

1. In der App **WhatsApp → API-Setup** öffnen. Dort steht zuerst eine **Testnummer** von Meta – damit lässt sich die
   Verbindung ausprobieren (siehe [Ausprobieren mit der Testnummer](#ausprobieren-mit-der-testnummer)).
2. Für den Betrieb **Telefonnummer hinzufügen**:
   - **Anzeigename** eingeben, z. B. „ELW 2 Feuerwehr Musterstadt“. So erscheint der Absender bei den Empfängern. Meta
     prüft den Namen; er muss zur Organisation passen.
   - **Kategorie** wählen (z. B. „Öffentliche Dienste“) und optional eine Beschreibung.
   - Rufnummer mit Ländervorwahl eintragen und den **Bestätigungscode** per SMS oder Anruf anfordern und eingeben.
3. Danach steht die Nummer in der Auswahl im API-Setup. Darunter stehen die **Phone-Number-ID** (eine lange Zahl, nicht
   die Rufnummer) und die ID des WhatsApp-Business-Kontos. Die **Phone-Number-ID** notieren.
4. Meta verlangt für die Cloud API eine **zweistufige Verifizierung** (6-stellige PIN) der Nummer. Wird sie beim
   Hinzufügen abgefragt, PIN festlegen und gut aufbewahren. Sonst siehe
   [Fehler beheben → Nummer nicht registriert](#fehler-beheben).

## 3. Dauerhaftes Zugriffstoken (Systembenutzer)

Das Token im API-Setup gilt nur 24 Stunden. Für ELVIS ein Token eines **Systembenutzers** anlegen, das nicht abläuft:

1. [business.facebook.com](https://business.facebook.com) → **Einstellungen** (Unternehmenseinstellungen) des
   Unternehmensportfolios öffnen.
2. **Nutzer → Systembenutzer → Hinzufügen**: Name z. B. „ELVIS“, Rolle **Admin**.
3. Beim Systembenutzer **Assets zuweisen**:
   - **Apps** → die App aus Schritt 1 → **Vollständige Kontrolle**,
   - **WhatsApp-Konten** → das WhatsApp-Business-Konto → **Vollständige Kontrolle**.
4. **Neuen Token generieren**: die App wählen, Ablauf **Nie**, Berechtigungen **`whatsapp_business_messaging`** und
   **`whatsapp_business_management`** ankreuzen, generieren.
5. Das Token **sofort kopieren** – Meta zeigt es nur einmal. Es ist ein Zugang zum WhatsApp-Konto: nur in ELVIS
   eintragen, nicht per Mail oder Chat weitergeben.

## 4. App-Geheimnis

Im Entwicklerportal in der App **App-Einstellungen → Allgemein** öffnen und beim **App-Geheimnis** auf **Anzeigen**
klicken (Facebook-Passwort erforderlich). Mit diesem Geheimnis prüft ELVIS, dass eingehende Webhooks wirklich von Meta
kommen.

## 5. Modul WhatsApp in ELVIS einschalten

1. **Einstellungen → Fahrzeugmodule → WhatsApp** aufklappen und **Modul aktiv** einschalten.
2. Treiber **„WhatsApp Cloud API (Meta)“** wählen.
3. Eintragen:
   - **Phone-Number-ID** aus Schritt 2,
   - **Zugriffstoken** aus Schritt 3,
   - **App-Geheimnis** aus Schritt 4.
   - Die übrigen Felder (Vorlage, Graph-API) zunächst so lassen.
4. **Übernehmen**. In der Karte **WhatsApp-Konto** steht nach wenigen Sekunden „verbunden“ und die Rufnummer. Darunter
   stehen **Rückruf-URL** und **Prüf-Token** – beide für den nächsten Schritt kopieren (Kopierknopf).

Steht dort „gestört“, zeigt die Karte den Grund – siehe [Fehler beheben](#fehler-beheben).

## 6. Webhook eintragen (eingehende Nachrichten)

1. Im Entwicklerportal in der App **WhatsApp → Konfiguration** öffnen.
2. Beim **Webhook** auf **Bearbeiten**:
   - **Rückruf-URL**: die Adresse aus ELVIS (`https://relay.einsatzleitwagen.app/h/…`),
   - **Prüf-Token**: das Prüf-Token aus ELVIS.
3. **Bestätigen und speichern**. Meta ruft die Adresse dabei auf; das Relay beantwortet die Prüfung. Schlägt das fehl,
   sind Adresse oder Token falsch kopiert.
4. Unter **Webhook-Felder** beim Feld **`messages`** auf **Abonnieren** klicken. Ohne dieses Abo kommen weder
   Nachrichten noch Zustellbestätigungen an.

## 7. Livebetrieb

Solange die App im **Entwicklungsmodus** ist, schickt Meta Webhooks nur eingeschränkt, und mit der Testnummer lassen
sich nur hinterlegte Empfänger anschreiben. Für den Betrieb:

1. In den **App-Einstellungen → Allgemein** die **Datenschutzerklärung** (URL) und ggf. Kategorie und Symbol eintragen.
2. Oben in der App den Schalter **App-Modus** von „Entwicklung“ auf **Live** stellen.
3. Warten, bis Meta den **Anzeigenamen** der Nummer freigegeben hat (Status im WhatsApp Manager unter
   *Telefonnummern*). Vorher erscheint beim Empfänger nur die Rufnummer.
4. Empfohlen: im Unternehmensportfolio die **Unternehmensverifizierung** abschließen (Sicherheitscenter). Ohne sie gilt
   eine niedrige Grenze, wie viele verschiedene Empfänger am Tag neu angeschrieben werden dürfen (anfangs rund 250);
   Antworten auf eingegangene Nachrichten sind davon nicht betroffen.

## 8. Vorlage für Nachrichten außerhalb des 24-h-Fensters (optional)

WhatsApp erlaubt **freie Nachrichten nur bis 24 Stunden nach der letzten Nachricht der Gegenstelle**. Wer ELVIS zuerst
anschreibt (oder innerhalb von 24 h antwortet), bekommt ganz normale Nachrichten. Soll ELVIS jemanden **von sich aus**
anschreiben, geht das nur mit einer bei Meta freigegebenen **Vorlage**.

1. Im **WhatsApp Manager** (business.facebook.com → WhatsApp-Konten → WhatsApp Manager) → **Nachrichtenvorlagen →
   Vorlage erstellen**.
2. Kategorie **Utility** (Service), Name z. B. `elvis_nachricht` (nur Kleinbuchstaben, Ziffern, `_`), Sprache
   **Deutsch** (`de`).
3. Text mit einem Platzhalter `{{1}}` für den Nachrichtentext, z. B.:

   > Nachricht vom Einsatzleitwagen ELW 2: {{1}} – Antworten Sie einfach auf diese Nachricht.

   Meta verlangt für den Platzhalter ein Beispiel, z. B. „Bitte Lage melden“.
4. Einreichen. Die Freigabe dauert meist Minuten bis einige Stunden.
5. In ELVIS in den Moduleinstellungen **„Vorlage außerhalb des 24-h-Fensters“** = `elvis_nachricht`, **Sprache** = `de`,
   **„Vorlage hat einen Textbaustein {{1}}“** eingeschaltet lassen, übernehmen.

ELVIS setzt den Nachrichtentext dann einzeilig in `{{1}}` ein (Zeilenumbrüche werden zu „·“). Im Antwortfeld steht bei
solchen Nummern „über 24 h ohne Nachricht: geht als Vorlage“. Ohne eingetragene Vorlage sendet ELVIS außerhalb des
Fensters nicht und meldet das.

## Ausprobieren mit der Testnummer

Vor dem Hinzufügen der eigenen Nummer lässt sich alles mit der Testnummer von Meta prüfen:

1. Im **API-Setup** die Testnummer auswählen; deren **Phone-Number-ID** in ELVIS eintragen (Schritte 3–6 wie oben).
2. Unter **An** bis zu fünf eigene Handynummern als Empfänger hinzufügen und per Code bestätigen.
3. Von einem dieser Handys der Testnummer schreiben – die Nachricht erscheint in ELVIS unter **Nachrichten**. Darauf in
   ELVIS antworten.

Danach die Phone-Number-ID in ELVIS auf die eigene Nummer umstellen.

## Kosten

Meta berechnet seit Juli 2025 **je zugestellter Vorlagen-Nachricht**, abhängig von Kategorie und Land des Empfängers.

- **Antworten innerhalb des 24-h-Fensters** (freie Nachrichten) sind kostenlos – das ist der Normalfall, wenn jemand
  ELVIS zuerst schreibt.
- **Vorlagen** der Kategorie *Utility* kosten je Nachricht einige Cent (innerhalb eines offenen Fensters ebenfalls
  kostenlos). Dafür braucht das WhatsApp-Konto eine Zahlungsmethode (WhatsApp Manager → Abrechnung).
- Aktuelle Preise: [developers.facebook.com/docs/whatsapp/pricing](https://developers.facebook.com/docs/whatsapp/pricing).

## Funktionen

- Text, Bilder und Standorte senden und empfangen, „zugestellt“ und „gelesen“.
- Erreichbarkeit: Die Cloud API verrät nicht, ob eine Nummer WhatsApp nutzt. Eine Nummer gilt als erreichbar, sobald es
  einmal eine Nachricht mit ihr gab.
- ELVIS prüft die Signatur jedes Webhooks mit dem App-Geheimnis. Aufrufe mit falscher Signatur oder für eine andere
  Phone-Number-ID verwirft es.
- Ohne Cloud-Relay (`app.relayUrl` ist `off`) geht nur das Senden.
- Meldet sich ELVIS neu beim Cloud-Relay an (z. B. nach einer Neuinstallation ohne Backup), ändern sich Rückruf-URL
  und Prüf-Token. Dann Schritt 6 wiederholen.

## Fehler beheben

| Meldung in ELVIS | Ursache und Abhilfe |
|---|---|
| „Zugriffstoken ungültig oder abgelaufen“ | Das 24-h-Testtoken wurde eingetragen oder das Token wurde widerrufen. Token des Systembenutzers neu erzeugen (Schritt 3). |
| „gestört“ beim Verbinden, Phone-Number-ID unbekannt | Rufnummer statt Phone-Number-ID eingetragen oder der Systembenutzer hat keinen Zugriff auf das WhatsApp-Konto (Schritt 3, Assets zuweisen). |
| „Nummer ist für die Cloud API nicht registriert“ (Fehler 133010) | Die Nummer ist noch nicht für die Cloud API registriert. Einmal mit der PIN der zweistufigen Verifizierung registrieren, z. B. per `curl -X POST "https://graph.facebook.com/v21.0/<Phone-Number-ID>/register" -H "Authorization: Bearer <Token>" -H "Content-Type: application/json" -d '{"messaging_product":"whatsapp","pin":"<6-stellige PIN>"}'` |
| „mehr als 24 h seit der letzten Nachricht – nur mit Vorlage“ | Freie Nachrichten sind außerhalb des Fensters gesperrt. Vorlage einrichten (Schritt 8) oder warten, bis die Gegenstelle schreibt. |
| „Empfänger nutzt kein WhatsApp oder kann die Nachricht nicht empfangen“ | Die Nummer hat kein WhatsApp, oder die App ist noch im Entwicklungsmodus und der Empfänger ist nicht als Testempfänger hinterlegt (Schritt 7). |
| Gesendet geht, Eingang kommt nicht an | Webhook nicht eingetragen oder Feld `messages` nicht abonniert (Schritt 6); App noch im Entwicklungsmodus (Schritt 7); Cloud-Relay in ELVIS abgeschaltet. |
| Webhook speichern schlägt bei Meta fehl | Rückruf-URL oder Prüf-Token nicht vollständig kopiert. Mit dem Kopierknopf in der Karte **WhatsApp-Konto** erneut kopieren. |
| Empfänger sehen nur die Rufnummer statt des Namens | Anzeigename noch nicht freigegeben (WhatsApp Manager → Telefonnummern) oder der Empfänger hat ELVIS nicht als Kontakt gespeichert. |
