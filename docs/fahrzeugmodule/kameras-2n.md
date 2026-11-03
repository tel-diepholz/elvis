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

## Technik

- Modell und Firmware: `GET /api/system/info`
- Bildgrößen und zugleich Prüfung von Anmeldung und Freigabe: `GET /api/camera/caps` (auch bei jeder Abfrage alle 3 s)
- Livebild: `GET /api/camera/snapshot?width=…&height=…&fps=10` liefert MJPEG, die Vorschau 320×240 mit 2 Bildern/s.
  ELVIS reicht den Strom an den Browser weiter; die Zugangsdaten bleiben auf dem Server.
- Fehler meldet die Türstation als JSON (`success: false`); ELVIS zeigt die Beschreibung an.
