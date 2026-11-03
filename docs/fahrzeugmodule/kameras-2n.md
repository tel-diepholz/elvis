# Türstation 2N (z. B. 2N IP Base)

2N-IP-Türsprechstellen (IP Base, Verso, Force …) lassen sich im Modul „Kameras“ als Kamera eintragen. ELVIS zeigt
das Bild der eingebauten Kamera unter **Kameras** und in den Kacheln, wie bei jeder anderen Kamera. Bedienen lässt
sich nichts: Schwenken, Zoom, Fokus und Tag/Nacht hat die Türstation nicht.

## In der Türstation einrichten

1. Weboberfläche der Türstation öffnen → **Dienste → HTTP API**.
2. Unter **Dienste** die **Kamera-API** einschalten. Verbindungsart z. B. „Sicher (TLS)“ oder „Unsicher (TCP)“,
   Anmeldung **Digest**.
3. Unter **Konto** ein Konto anlegen, z. B. `elvis`, mit dem Recht **Kamera (Überwachung)**.

## In ELVIS eintragen

**Einstellungen → Kameras → Kamera hinzufügen**, Typ „2N-Türstation“:

- **Adresse:** IP-Adresse der Türstation (z. B. `192.168.128.236`).
- **Protokoll:** passend zur Verbindungsart der Kamera-API (HTTPS bei „Sicher (TLS)“; „Zertifikat prüfen“ aus,
  ab Werk ist es selbstsigniert).
- **Benutzer/Passwort:** das Konto der HTTP API, nicht der Admin der Weboberfläche.
- **Auflösung:** 2N liefert nur feste Bildgrößen (meist 4:3). ELVIS nimmt die nächstliegende Größe, die die
  Türstation meldet. „Verbindung testen“ zeigt Modell, Firmware und die verfügbaren Bildgrößen.

## Klingeln auf Bildschirmen

Drückt jemand an der Türstation eine Klingeltaste (Kurzwahltaste), öffnet sich auf den eingestellten
[Bildschirmen](../funktionen/bildschirme.md) ein Dialog über allen Kacheln:

- Bezeichnung der Klingel (z. B. „Haupteingang“), Türstation und Uhrzeit, darunter das Livebild der Türstation
- ein leiser Zweiklang „Ding-Dong“, der alle 15 s wiederholt wird, bis man **Klingelton aus** drückt oder den Dialog
  **schließt**
- Nach 90 s schließt der Dialog von selbst. Wer mehrmals drückt, löst innerhalb von 10 s nur ein Klingeln aus.

**Einstellen:** im Dialog der Türstation unter **Klingeln** je Taste eine Bezeichnung und die Bildschirme wählen.
„jede Taste“ gilt für alle Tasten ohne eigenen Eintrag. Tasten ohne Eintrag zeigen nichts an.

**Ton am Bildschirm:** Browser spielen Ton erst nach einer Bedienung. Den Kiosk-Browser deshalb mit
`--autoplay-policy=no-user-gesture-required` starten, sonst bleibt der Dialog stumm.

**Ton von der Tür (Sprechen/Hören):** Die HTTP API liefert nur Bilder. Ton von der Türstation käme über RTSP,
das bei der IP Base eine Lizenz braucht (`rtspServer: inactive,licensed`), und über ein WebRTC-Gateway. Das ist noch
nicht umgesetzt.

**Rechte des API-Kontos:** Neben der Kamera braucht das Konto Zugriff auf das Ereignisprotokoll (Logging-API) mit
Tastendrücken (`KeyPressed`).

## Technik

- Modell und Firmware: `GET /api/system/info`
- Bildgrößen und zugleich Prüfung von Anmeldung und Freigabe: `GET /api/camera/caps` (auch bei jeder Abfrage alle 3 s)
- Livebild: `GET /api/camera/snapshot?width=…&height=…&fps=10` liefert MJPEG, die Vorschau 320×240 mit 2 Bildern/s.
  ELVIS reicht den Strom an den Browser weiter; die Zugangsdaten bleiben auf dem Server.
- Klingeln: `GET /api/log/subscribe?include=new&filter=KeyPressed`, dann `GET /api/log/pull?id=…&timeout=25`
  (Long-Polling). `KeyPressed` mit `key: "%1"` = Kurzwahltaste 1. Verfällt das Abo (Code 12), abonniert ELVIS neu.
- Fehler meldet die Türstation als JSON (`success: false`); ELVIS zeigt die Beschreibung an.
