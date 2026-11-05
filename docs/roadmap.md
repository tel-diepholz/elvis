# Offene Punkte / nächste Schritte

- **TLS für die Weboberfläche:** Die Sitzungs-Cookies laufen im Fahrzeug-LAN derzeit über HTTP.
- Echte Treiber für die verbauten Systeme.
- Druckansicht/PDF für Einsatztagebuch und Kräfteübersicht.
- **Höhendaten offline für die Wasserversorgung:** Der Höhenschnitt nutzt bisher die Online-API von Open-Meteo.
  Künftig sollen die Höhen lokal vorliegen, entweder als SRTM-Kacheln im Addon OSM-Daten (Valhalla `/height`) oder als
  DGM des Landes (z. B. LGLN-DGM1 Niedersachsen).
- **Hinweise an die Datenpflege beim Beenden einer Lage:** Daten, die während der Lage an Einsatzkopien
  erfasst wurden und für spätere Lagen nützlich sein können, gesammelt auflisten, damit sie gezielt in den Katalog
  übernommen werden können. Bewusst keine automatische Übernahme, Lagen bleiben Kopien. Beispiele:
  - E-Mail-Adressen, die Kräfte der Lage aus eingegangenen Mails gelernt haben (bei Einheiten aus dem Katalog)
  - In der Lage neu erfasste Einheiten, die noch keine Systemeinheit sind
  - Geänderte Stammdaten übernommener Einheiten (Funkrufname, Organisation, Stärke, taktisches Zeichen)
  - In der Lage verwendete Freitext-Gegenstellen in Meldungen, die keiner Kraft zugeordnet sind
