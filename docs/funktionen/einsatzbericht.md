# Einsatzbericht

ELVIS fasst alles, was zu einer Lage erfasst wurde, in einem PDF zusammen. Dazu gehören auch die Dokumente.

- **Automatisch beim Beenden:** Nach *Lage → Lage beenden* erstellt ELVIS den Bericht im Hintergrund. Er
  landet im Dokumentenordner **Protokolle** der Lage, z. B. `Protokolle/Einsatzbericht_B3_031755nov26.pdf` (ohne Einsatzstichwort
  `Einsatzbericht_Lage-<ID>_…`).
  Das Tagebuch erhält dazu „Dokument hinzugefügt …“. Schlägt die Erstellung fehl, steht der Grund als System-Eintrag
  im Tagebuch.
- **Auf Abruf:** *Archiv → Lage → Einsatzbericht (PDF)* erstellt den Bericht jederzeit neu. Während der Lage
  gibt es *Lage → Zwischenbericht (PDF)*. Dafür ist eine Anmeldung nötig, jeder Abruf steht im Audit-Log.
- **Inhalt** (jeder Abschnitt beginnt auf einer neuen Seite und hat ein PDF-Lesezeichen):
  - Deckblatt mit Einsatzdaten und Inhaltsverzeichnis
  - Übersicht mit Kennzahlen und Personenschäden gesamt
  - **Lagekarte (Endstand)**, A4 quer: Einsatzort, Kräfte mit Position und sichtbare Kartenobjekte, auch Overlays.
    Gauß-Fahnen und Sektoren hängen vom damaligen Wind ab. Sie stehen deshalb nur in der Objekttabelle.
  - Einsatztagebuch: Korrekturen sind durchgestrichen, wichtige Einträge fett, Nachträge sind gekennzeichnet
  - Einsatzabschnitte/Schadenkonten als T-Konto mit dem Buchungsverlauf der Personenschäden
  - Kräfte als Baum mit Status, Zeiten, Abschnitt und ISSI
  - **Personal mit allen erfassten Feldern**, also auch Geburtsdatum, Anschrift, Arbeitgeber und Notfallkontakt. Der
    Bericht enthält damit personenbezogene Daten und ist entsprechend zu behandeln.
  - Aufgaben, Anforderungen, Meldungen (mit Antworten, Kopien und Quittungen) und Telefonate
  - Chat/SMS und E-Mail im Einsatzzeitraum. Beides ist keiner Lage fest zugeordnet; aufgenommen wird der gesamte
    Verkehr zwischen Beginn und Ende.
  - Kartenobjekte und das Dokumentenverzeichnis mit Anlagennummern (A1, A2 …)
- **Dokumente im Anhang:**
  - JPEG und PNG erscheinen als Bild, Textdateien als Text, PDFs mit allen Seiten.
  - Office-Dateien (docx, xlsx, odt, pptx …) wandelt Collabora in PDF um, wenn das Addon läuft. Sonst stehen sie nur
    im Verzeichnis.
  - Verschlüsselte oder beschädigte PDFs und andere Formate kommen ohne eigene Seite in den Bericht.
  - **Jede Originaldatei** ist zusätzlich als Dateianhang ins PDF eingebettet. Das gilt auch für Chat-Dateien, E-Mails
    (als `.eml`) und deren Anhänge. PDF-Programme zeigen sie unter „Anhänge“.
  - Frühere Einsatzberichte und Entwürfe kommen nicht in den Bericht.
- **Technik:**
  - Endpunkt: `GET /api/incidents/:id/report.pdf`
  - Code in `apps/server/src/services/report/`: `collect.ts` sammelt die Daten, `render.ts` setzt den Hauptteil mit
    pdfkit, `attachments.ts` bereitet die Dokumente vor, `assemble.ts` fügt Karte und Dokument-PDFs ein und bettet
    die Dateien mit pdf-lib ein.
  - Die Office-Umwandlung nutzt `POST <Collabora>/cool/convert-to/pdf`. Collabora erlaubt das standardmäßig nur aus
    privaten Netzen (`net.post_allow`), ELVIS muss den Office-Server also im LAN oder Docker-Netz erreichen.
  - Automatisch erzeugte Berichte sind in der Datenbank als `documents.generated = 'report'` gekennzeichnet.
