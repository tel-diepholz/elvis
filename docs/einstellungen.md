# Taktische Zeichen und Einstellungen

- **Generator** (*Verwaltung → Taktische Zeichen*, auch ohne Anmeldung): Zeichen nach der Empfehlung „Taktische
  Zeichen im Bevölkerungsschutz“ (DV 102) zusammenstellen und als SVG herunterladen. Häufige Zeichen gibt es als
  Vorlagen.
  - Grundzeichen: taktische Einheit, Befehlsstelle (mit Fahnenmast), Stelle/Einrichtung, Person (Führer mit
    gefüllter Spitze), Fahrzeug (gewölbte Oberkante; ohne Antrieb, Kfz, geländegängig, Kette, Anhänger)
  - Organisationsfarben nach DV 102 Tabelle 2
  - Größenordnungen Trupp bis Großverband
  - Fachaufgaben Führung, Brandbekämpfung, Rettungswesen, Technische Hilfe, IuK, Betreuung, Logistik
  - Text im Zeichen, Organisationskürzel, Bezeichnung rechts
- **Umsetzung:** Das Zeichen wird einmal als Geometrie beschrieben (`packages/shared/src/tactical.ts`). Daraus
  entstehen das SVG im Browser und auf der Karte sowie die Vektorgrafik im Druck-PDF. Weitere Fachaufgaben werden in
  `functionSymbol()` ergänzt.
- **Einstellungen** (*Verwaltung → Einstellungen*, nur Admins): aufklappbare Abschnitte in den Gruppen Fahrzeug,
  Fahrzeugmodule, Dienste und Einsatz. Links aus anderen Seiten öffnen den passenden Abschnitt direkt, z. B.
  `/einstellungen#modul-bluetooth` oder `/einstellungen#scannen`. Die alte Adresse `/system` leitet dorthin um.
  - *Fahrzeug & Einheit:* Fahrzeugname, Funkrufname, Einheit und das taktische Zeichen für den Fahrzeugstandort auf
    Karte und Druck. Ohne gespeicherte Werte gelten `vehicle` aus `config/elvis.json` und das Zeichen „ELW 2“ der
    Feuerwehr.
  - Das Farbschema stellt jeder über das Symbol oben rechts um.
- **Bedienprotokoll** (*Verwaltung → Bedienprotokoll*, nur Admins): die letzten 100 Bedienvorgänge.
