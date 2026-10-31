# Kontakte

**Kontakte** (Navigation unter „Fahrzeug“) ist das Adressbuch des ELW für Personen und Einrichtungen, unabhängig vom
Einsatz und nur in diesem ELW gespeichert. Ein Kontakt hat Name bzw. Einrichtung, Funktion, beliebig viele
Telefonnummern mit Bezeichnung, E-Mail, Anschrift und Notizen. **Kategorien** bilden einen Baum (z. B. *Unternehmen →
Getränkelieferanten*), ein Kontakt kann in mehreren stehen. Eine gewählte Kategorie zeigt auch die Kontakte ihrer
Unterkategorien. Löschen lässt sich eine Kategorie nur ohne Unterkategorien, die Kontakte bleiben erhalten. Pflegen
dürfen alle Angemeldeten, jede Änderung steht im Bedienprotokoll. Eine E-Mail-Adresse öffnet direkt eine neue [Mail](email.md).

## Telefonbuch für die DECT-Basis

Die DECT-Basis (Yealink W70B) übernimmt die Kontakte als **Remote-Telefonbuch**. Die Abruf-URLs stehen unter
*Einstellungen → Dienste → Telefonbuch (DECT)*: eine für alle Kontakte und eine je Kategorie (samt Unterkategorien).
An der Basis unter *Directory → Remote Phone Book* die URL und einen Namen eintragen und ein Aktualisierungsintervall
setzen. Mobilteile zeigen das Telefonbuch dann unter *Directory → Remote Phone Book*.

- Format: `YealinkIPPhoneDirectory` (XML), je Telefonnummer ein Eintrag. Die Bezeichnung der Nummer steht hinter dem
  Namen (*Meyer, Hans - Mobil*). Kontakte ohne Telefonnummer fehlen.
- Nummern werden wählbar gemacht: Leerzeichen, Striche, Schrägstriche und Klammern fallen weg, `+49 (0)5441` wird zu
  `+495441`, `0049…` zu `+49…`.
- Die Basis ruft ohne Anmeldung ab. Berechtigt ist sie über einen geheimen Schlüssel in der URL. *Neue URL erzeugen*
  macht die alte URL ungültig, danach muss die neue an der Basis eingetragen werden.
- Die Basis muss den Fahrzeugserver unter der Adresse in der URL erreichen. Kann sie den Hostnamen nicht auflösen,
  die IP-Adresse eintragen.
