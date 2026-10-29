# Kameras (Axis über VAPIX)

Modul „Kameras“: beliebig viele Kameras, angelegt unter **Einstellungen → Kameras** (nur Admins). Je Kamera gibt es Name,
Typ (Axis oder Demo ohne Hardware), Adresse, Benutzer, Passwort und die Auflösung des Livebilds. „Verbindung testen“
zeigt Modell und Funktionen der Kamera.

- **Livebild:** ELVIS holt das MJPEG-Bild von der Kamera (Digest-Anmeldung, MD5 oder SHA-256) und reicht es an den
  Browser weiter (`/api/cameras/<id>/stream`). Zugangsdaten verlassen den Server nicht. Wie der Fahrzeugbereich ist das
  Bild auch für anonyme Arbeitsplätze sichtbar, bedienen können nur angemeldete Benutzer.
- **Bedienung je nach Kamera:** ELVIS erkennt beim Verbinden, welche Funktionen eine Kamera hat, und zeigt nur die passenden Bedienelemente. „Verbindung testen“ zeigt, welche Schnittstelle was übernimmt.
  - Neuere Kameras mit Motorobjektiv: Optics Control API (`opticscontrol.cgi`, Version wird ausgehandelt) für Zoom,
    Fokus, Autofokus und IR-Sperrfilter.
  - Ältere feste Kameras wie die **P3225-LVE Mk II** (an der echten Kamera geprüft): Zoom und Fokus über
    `opticssetup.cgi`. Der Zustand kommt über `monitor=poll` (XML, Werte 0…1), die Befehle `rzoom`/`rfocus` sind nur
    relativ, dazu `autofocus=perform`. Tag/Nacht läuft über den Parameter `ImageSource.I0.DayNight.IrCutFilter`
    (`yes`/`no`/`auto`). `ptz.cgi` meldet dort Standardgrenzen, ist aber abgeschaltet („PTZ disabled“) und wird
    ignoriert.
  - PTZ-Kameras über `ptz.cgi`: nur Befehle aus der Befehlsliste der Kamera (`info=1`). Schwenken/Neigen und Zoom
    per Gedrückthalten, Grundstellung.
  - Bewegungen stoppen spätestens 1,2 s nach dem letzten Befehl von selbst, auch wenn die Verbindung zum Tablet abreißt.
    Bewegungen per Gedrückthalten stehen nicht im Bedienprotokoll, alle anderen Befehle schon.
- **Gespeicherte Positionen** gehören zum laufenden Einsatz. ELVIS speichert die absolute Position (Schwenk, Neigung,
  Zoom, Fokus), nicht die Presets der Kamera. Bei Kameras mit nur relativen Befehlen fährt ELVIS die Differenz an:
  erst den Zoom, dann den Fokus, mit Nachkorrektur wegen des Getriebespiels. Wird der Einsatz beendet oder ein neuer eröffnet, ist die Liste leer.
  Die Einträge bleiben dem alten Einsatz zugeordnet.
- Für Zoom und Fokus über die Optics Control API und für Tag/Nacht über `param.cgi` braucht ELVIS ein Kamerakonto mit
  Administratorrechten. Für das Livebild reicht ein Konto mit geringeren Rechten.
