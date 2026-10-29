# Wetter

Die Seite „Wetter“ zeigt für den Fahrzeugstandort (GPS der Wetterstation, ohne GPS der Einsatzort) die
**amtlichen Warnungen des DWD** (Gemeinde-Warngebiet, über [Bright Sky](https://brightsky.dev)) und eine
**Prognose** von [Open-Meteo](https://open-meteo.com): aktuelle Lage, die nächsten 24 Stunden und 7 Tage.
Böen ab 70 % bzw. 100 % von `alerts.stormWarnMs` werden hervorgehoben. Darunter stehen die Live-Werte der
Wetterstation, sofern das Modul aktiv ist.

Das Backend fragt beide Dienste ab (Standort auf ca. 1 km gerundet) und hält die Antworten vor – Prognose
15 Minuten, Warnungen 5 Minuten. Ist ein Dienst nicht erreichbar, bleibt der letzte Stand bis zu 12 Stunden sichtbar.
Unwetterwarnungen (Stufe 3, Stufe 4 als Alarm) erscheinen zusätzlich unter „Meldungen“; Bildschirme zeigen
Warnungen und Prognose in den Kacheln „Wetter“ und „Wettervorhersage“.

```json
"weather": { "forecastUrl": "https://api.open-meteo.com", "warningsUrl": "https://api.brightsky.dev" }
```

`null` schaltet den jeweiligen Dienst ab.
