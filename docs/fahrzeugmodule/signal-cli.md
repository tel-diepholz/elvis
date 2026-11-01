# Signal (signal-cli)

ELVIS spricht Signal über [signal-cli](https://github.com/AsamK/signal-cli) im Daemon-Modus mit HTTP-Schnittstelle.
signal-cli kommt immer aus dem Addon **„Signal (signal-cli)“**. Die Nachrichten stehen unter
[Nachrichten](../funktionen/nachrichten.md).

## signal-cli bereitstellen

Unter **Addons** das Addon „Signal (signal-cli)“ auf einem Docker-Host (amd64) installieren. Es baut einmalig ein
Image mit signal-cli (JVM-Fassung mit Java 25; die native Fassung kann `register` über JSON-RPC nicht) und nginx. signal-cli lauscht nur im Container; nginx
lässt nur Anfragen mit dem Token des Addons durch, denn die Schnittstelle von signal-cli hat keine Anmeldung. Adresse
und Token meldet das Addon selbst an ELVIS (`provides.messengers`). Konto und Schlüssel liegen im Volume `data` des
Addons und bleiben bei Updates erhalten. Signal sperrt alte signal-cli-Versionen nach einigen Monaten; neue Fassungen
kommen als neue Addon-Version. Die Schritt-für-Schritt-Anleitung steht beim Addon im Store unter **Anleitung**.

ELVIS nutzt `/api/v1/rpc` (JSON-RPC, Multi-Account-Modus) und `/api/v1/events` (eingehende Nachrichten und
Bestätigungen; nach einem Abbruch liest ELVIS mit `Last-Event-ID` weiter).

## Einrichten

1. Unter **Einstellungen → Fahrzeugmodule → Signal** den Treiber „signal-cli (Addon)“ wählen.
2. Hat signal-cli noch kein Konto, zeigt die Karte **Signal-Konto** zwei Wege:
   - **Als verknüpftes Gerät koppeln:** ELVIS zeigt einen QR-Code. Am Handy in der Signal-App unter *Einstellungen →
     Verknüpfte Geräte → Gerät hinzufügen* scannen. ELVIS schreibt dann mit der Nummer dieses Handys. Das Handy
     bleibt das Hauptgerät, und Signal trennt verknüpfte Geräte, wenn das Handy länger als etwa 30 Tage offline ist.
   - **Eigene Nummer registrieren**, z. B. die SIM im GSM-Gateway: Captcha auf
     [signalcaptchas.org](https://signalcaptchas.org/registration/generate.html) lösen, den Link „Open Signal“
     (`signalcaptcha://…`) einfügen und registrieren. Den Bestätigungscode schickt Signal per SMS; steckt die SIM im
     Gateway, steht er unter Nachrichten. Danach ist die Nummer in keiner Signal-App eines Handys mehr nutzbar.
3. Hat signal-cli mehrere Konten, legt „Rufnummer des Kontos“ fest, welches ELVIS nutzt.

Codes, PIN und Captcha landen nicht im Bedienprotokoll, dort steht nur der Schritt.

## Funktionen

- Text und Bilder senden und empfangen, Zustellbestätigung und Lesebestätigung.
- Standorte: Signal kennt keine Standortnachricht. ELVIS sendet sie als Kartenlink und erkennt eingehende Kartenlinks
  (Google Maps, OpenStreetMap, `geo:`) als Standort.
- Erreichbarkeit: ELVIS prüft die Mobilnummern der Kontakte (`getUserStatus`).
- Nur Einzelchats. Gruppennachrichten werden nicht übernommen.
- Störungen (signal-cli nicht erreichbar, Ereignisstrom abgebrochen) erscheinen als Meldung, ELVIS verbindet sich
  selbst neu.
