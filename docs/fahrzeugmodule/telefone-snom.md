# Tischtelefone (Snom D385)

ELVIS richtet die Tischtelefone im ELW selbst ein und hält ihre Tasten aktuell:

- **SIP-Konto** an der Telefonanlage (Nebenstelle, Anmeldename, Passwort, SIP-Server)
- **Telefonbuch** aus den [Kontakten](../funktionen/kontakte.md) auf der Taste *Verzeichnis*, immer auf dem aktuellen Stand
- **Funktionstasten** (Schnellwahl, Besetztlampen), 48 Tasten auf 4 Seiten bei der D385

## Tastenbelegung

Jede Taste kann eine dieser Belegungen haben:

| Art | Am Telefon |
| --- | --- |
| Kontakt | Schnellwahl auf eine Nummer aus den Kontakten. Ändert sich der Kontakt, ändert sich die Taste mit. Ist der Kontakt gelöscht, bleibt die Taste frei. |
| Nummer | Schnellwahl auf eine frei eingegebene Nummer |
| Nebenstelle (BLF) | Leuchtet, solange die Nebenstelle telefoniert. Drücken ruft an. Mit der Kennziffer *Heranholen* übernimmt die Taste einen dort klingelnden Anruf. |
| leer | Taste ausdrücklich frei. Das überdeckt Vorlage und Grundbelegung. |

Die Belegung kommt aus drei Ebenen. Für jede Taste gilt die oberste Ebene, die die Taste belegt:

1. **Einsatz:** Im laufenden Einsatz darf jeder Angemeldete unter *Fahrzeug → Telefone* Tasten ändern. **Mit dem
   Einsatzende fallen diese Änderungen weg**, und die Telefone bekommen wieder ihre Grundbelegung.
2. **Grundbelegung des Telefons:** pflegen Admins unter *Fahrzeug → Telefone* mit dem Umschalter *Grundbelegung*.
3. **Vorlage:** gilt für alle Telefone. Admins pflegen sie unter *Einstellungen → Dienste → Telefone (Snom)*.

Das Tastenraster zeigt an jeder Taste, aus welcher Ebene sie kommt. Jede Änderung steht im Bedienprotokoll.

## Einrichten

1. *Einstellungen → Dienste → Telefone (Snom)*: SIP-Server der Telefonanlage eintragen, bei Bedarf die Kennziffer zum
   Heranholen (z. B. `*8`) und einen Zeitserver.
2. Je Telefon unter *Telefone → Telefon hinzufügen* Name, MAC-Adresse (Typenschild), Nebenstelle und SIP-Passwort
   eintragen.
3. Die **Provisionierungs-URL** `http://<elvis>/api/provisioning/<schlüssel>/snom/{mac}.xml` bekannt machen:
   - **DHCP:** am Router als Option 66 eintragen. Neue Telefone holen sich die Konfiguration dann beim ersten Start.
   - **Von Hand:** an der Weboberfläche des Telefons unter *Erweitert → Aktualisieren → Einstellungs-URL* eintragen
     und das Telefon neu starten.

   `{mac}` setzt das Telefon selbst ein, die geschweiften Klammern bleiben stehen.
4. Nach dem ersten Abruf zeigt die Liste Adresse und Firmware des Telefons.

ELVIS setzt bei der Provisionierung den Zugang zur Weboberfläche der Telefone: Benutzer `admin`, Passwort wie in der
Karte angezeigt. Danach ist die Oberfläche nur noch mit diesem Passwort erreichbar.

## Wie Änderungen ans Telefon kommen

- **Sofort:** Nach jeder Änderung schickt ELVIS die Tasten über die Weboberfläche an das Telefon
  (`dummy.htm?settings=save`). Dafür nutzt ELVIS die Adresse, von der das Telefon zuletzt seine Konfiguration geholt
  hat. Die Liste zeigt, ob die Übertragung geklappt hat. *Tasten jetzt übertragen* wiederholt sie.
- **Stündlich:** Jedes Telefon holt die komplette Konfiguration zusätzlich jede Stunde und bei jedem Neustart. Eine
  verpasste Übertragung holt es so spätestens nach einer Stunde nach.
- **Neu starten** (Knopf in der Liste) lädt alles neu, auch SIP-Konto und Einstellungen.

## Technik und Grenzen

- Die Provisionierungs-URL ist ohne Anmeldung erreichbar und durch einen geheimen Schlüssel geschützt. Sie liefert
  SIP-Passwörter aus, darf also nicht weitergegeben werden. *Neue URL erzeugen* macht die alte ungültig. Danach muss die
  neue URL im DHCP bzw. an den Telefonen eingetragen werden.
- Das Telefon muss ELVIS unter der Adresse in der URL erreichen. Die Adressen in der Konfiguration, z. B. für das
  Telefonbuch, setzt ELVIS aus der Adresse zusammen, unter der das Telefon angefragt hat.
- Format: Snom-XML (`<settings>`, `<phone-settings>`, `<functionKeys>`). Schnellwahl ist `speed <nummer>`, Besetztlampe
  ist `blf <sip:nebenstelle@sip-server>|<kennziffer>`.
- **Noch am Gerät zu prüfen** (erste Inbetriebnahme): die sofortige Übertragung über `dummy.htm` einschließlich der
  Beschriftung `fkey_label`, die Zählung der Tasten ab 0 und die Schreibschutzangabe `perm="R"`. All das steckt in
  `apps/server/src/services/phones.ts`.
