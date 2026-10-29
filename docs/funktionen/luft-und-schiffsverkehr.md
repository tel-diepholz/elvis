# Flugzeuge und Schiffe

Oben rechts auf der Karte (Ebenen) lassen sich **Flugzeuge** und **Schiffe** einblenden, ähnlich wie bei Flightradar24. Die
Auswahl merkt sich jeder Browser. Ein Klick auf ein Ziel zeigt Rufzeichen, Kennzeichen, Typ, Höhe, Geschwindigkeit
und die Ortungsart. **MLAT** heißt: Das Ziel sendet kein ADS-B und wurde per Laufzeitmessung mehrerer Empfänger geortet.
„Zur Objektliste“ übernimmt genau dieses Ziel in den Einsatz. Dasselbe geht über **Objekte → Flugzeug oder Schiff suchen …**
mit Rufzeichen, Kennzeichen, ICAO-Adresse, Schiffsname oder MMSI.

Übernommene Ziele folgen live ihrer Position, mit Spur der letzten rund 20 Minuten. Sie erscheinen auf allen
Arbeitsplätzen, auf den Bildschirmen und im Druck. Ins Einsatztagebuch kommen die Übernahme, „kein Signal mehr“ (nach 3
Minuten ohne Position) und „Signal wieder da“, nicht jede Bewegung. Von Hand verschieben lassen sie sich nicht.

- **Flugzeuge:** [adsb.fi](https://adsb.fi) (Open-Data-API der Empfänger-Community, ADS-B und MLAT, ohne Schlüssel)
  - Frei für nicht kommerzielle Nutzung mit Quellenangabe, höchstens eine Anfrage pro Sekunde.
  - Der Server teilt gerundete Abfragen zwischen allen Arbeitsplätzen und aktualisiert alle 10 s.
  - Nach HTTP 429 pausiert ELVIS und zeigt so lange den letzten Stand.
  - Konfiguration: `"traffic": { "aircraftUrl": "…", "aircraftApi": "adsbfi" | "readsb" }`, `null` = aus.
  - `readsb` passt zu adsb.lol und ähnlichen Diensten. adsb.lol erlaubt aber nur 500 Anfragen am Tag und ist für den Dauerbetrieb ungeeignet.
- **Schiffe:** [aisstream.io](https://aisstream.io) (kostenlos, ohne Verfügbarkeitsgarantie)
  - Den Schlüssel gibt es nach Anmeldung mit einem GitHub-Konto. Er wird unter **Einstellungen → Luft- und Schiffsverkehr** eingetragen und bleibt auf dem Server.
  - ELVIS abonniert das Gebiet von rund ±100 km um den Einsatzort, ohne Einsatz um das Fahrzeug.
  - Auf Binnengewässern hängt die Abdeckung von den Empfangsstationen der Community ab.
  - Konfiguration: `"traffic": { "aisUrl": "…" }`, `null` = aus.

Beides braucht Internet. Später soll ein eigener Empfänger im Fahrzeug (SDR-Stick mit readsb bzw. AIS-catcher als Addon)
die Daten auch offline liefern.
