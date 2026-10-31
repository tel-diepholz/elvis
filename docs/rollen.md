# Rollen im Einsatz

Rollen bilden die Funktionen im Einsatz ab, z. B. Einsatzleiter, Führungsassistent, Fernmelder, S2 oder S4. Sie sind
unabhängig von den [Rechten](benutzer-und-rechte.md): Eine Rolle legt fest, welche Aufgaben, Meldungen und
Anforderungen ein Benutzer bearbeitet, nicht was er darf.

## Rollen pflegen

- **Nur Admins** legen Rollen unter *Einstellungen → Einsatz → Rollen im Einsatz* an, benennen sie um, beschreiben
  sie und legen die Reihenfolge fest. Namen sind eindeutig, Groß-/Kleinschreibung zählt nicht.
- Die Liste zeigt zu jeder Rolle, wer sie gerade übernommen hat.
- **Löschen** entfernt die Rolle auch aus den Einstellungen für Meldungen und Anforderungen und aus der gemerkten
  Rollenwahl der Benutzer. Aufgaben und Aufgabenvorlagen dieser Rolle gehen danach an alle. Bestehende Meldungen
  behalten den Namen der Rolle als Text.

## Rollen übernehmen

- **Nach der Anmeldung** fragt ELVIS: „Welche Rollen übernehmen Sie?“ Man kann beliebig viele Rollen wählen, auch
  keine („Ohne Rolle fortfahren“). Die Frage erscheint nur, wenn Rollen angelegt sind.
- **Vorauswahl:** ELVIS merkt sich je Benutzer die zuletzt gewählten Rollen. Bei der nächsten Anmeldung sind sie im
  Dialog bereits angehakt, ein Klick übernimmt sie. Gelöschte Rollen fallen aus der Vorauswahl heraus.
- **Wechseln** geht jederzeit über das Kontomenü → *Rollen wählen*.
- **Mehrfachbesetzung:** Eine Rolle können mehrere Benutzer gleichzeitig übernehmen, z. B. zwei Fernmelder.
- **Besetzt** ist eine Rolle, solange eine gültige Sitzung sie hält. Mit dem Abmelden oder dem Ablauf der Sitzung
  (12 h Inaktivität, höchstens 7 Tage) wird sie wieder frei.
- **Einsatztagebuch:** Läuft ein Einsatz, steht jeder Wechsel im Tagebuch („Rollen übernommen: …“, „Rollen
  abgegeben: …“, beim Abmelden mit dem Zusatz „(Abmeldung)“). Jede Wahl steht außerdem im Bedienprotokoll.

Grundsatz: **Ist eine Rolle von niemandem besetzt, übernehmen alle ihre Arbeit.** So bleibt bei dünner Besetzung
nichts liegen.

## Aufgaben

- Eine Aufgabe geht an **alle**, an **einen Benutzer** (nur an sich selbst) oder an **eine Rolle**.
- Unter **Meine Aufgaben** stehen Aufgaben für alle, eigene Aufgaben und Aufgaben für die eigenen Rollen. Aufgaben
  einer unbesetzten Rolle sehen alle, sie sind mit „unbesetzt, für alle“ gekennzeichnet.
- **Aufgabenvorlagen** (*Einstellungen → Einsatz → Aufgabenvorlagen*, nur Admins) können eine Rolle vorgeben. Beim
  Eröffnen eines Einsatzes entstehen daraus Aufgaben für diese Rolle.

## Meldungen

Unter *Einstellungen → Einsatz → Meldungen* (nur Admins) ordnen Admins den Rollen ihre Aufgaben im Meldungsweg zu:

- **Fernmelder** übermitteln Ausgangsmeldungen und erfassen Eingangsmeldungen (Funk, E-Mail). Aus der Timeline auf der Seite Funk geht das mit „Meldung erstellen“. Die gewählte Kraft merkt sich dabei die ISSI für den Einsatz (siehe [Funk](fahrzeugmodule/funk-reichert-zbe.md)).
- **Dispatcher** (optional) verteilen Eingangsmeldungen an die Zielrolle. Eine Rolle kann nicht zugleich Fernmelder
  und Dispatcher sein.
- **Alle Eingangs-/Ausgangsmeldungen in Kopie**, z. B. für die S2 und ihr vollständiges Lagebild. Liest die
  Kopierolle die Meldung, gilt sie für die Zielrolle trotzdem als ungelesen. Die Absenderrolle bekommt keine Kopie
  ihrer eigenen Meldung.

Der Weg einer Meldung:

- **Ausgang:** Ein Benutzer schreibt im Namen einer **eigenen** Rolle an eine Kraft, eine Systemeinheit oder als
  Freitext. Fernmelder schreiben selbst keine Ausgangsmeldungen. Ein Fernmelder übernimmt die Meldung, übermittelt sie
  und trägt die Antwort ein. Die Absenderrolle sieht die Antwort.
- **Eingang:** Ein Fernmelder erfasst die Meldung. Ist ein Dispatcher angemeldet, verteilt dieser sie an die
  Zielrolle. Sonst wählt der Fernmelder die Zielrolle selbst. Die Zielrolle nimmt die Meldung zur Kenntnis.
- **Übernahme:** Hat ein Fernmelder bzw. Dispatcher eine Meldung übernommen, ist sie für die anderen Inhaber seiner
  Rolle erledigt, solange er die Rolle hält. Gibt er sie ab, ist die Meldung wieder für alle offen.
- Zur eigenen Liste gehören alle Meldungen, bei denen eine eigene Rolle Absender, Ziel oder Kopie ist, und solche, die
  man selbst erfasst oder bearbeitet hat.

## Anforderungen

- Unter *Einstellungen → Einsatz → Anforderungen* legen Admins die **Beschaffungsrolle** fest, z. B. S4.
- Sie plant, genehmigt und bestellt Material. Die Wiedervorlage jeder offenen Anforderung erscheint als Aufgabe für
  diese Rolle.
- Ist keine Beschaffungsrolle eingestellt oder ist sie unbesetzt, dürfen alle angemeldeten Benutzer Anforderungen
  führen.
