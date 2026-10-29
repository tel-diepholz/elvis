# Dokumente, Vorlagen und Collabora

- **Ordner je Einsatz:** Beim Eröffnen erhält jeder Einsatz eine Ordnerstruktur, die Admins unter *Einstellungen →
  Ordnervorgabe für Dokumente* festlegen. Die Struktur ist virtuell: Ordner gibt es nur in der Datenbank, die Dateien
  liegen flach unter `data/documents/<uuid>`. Benutzer können Ordner ergänzen, aber keine löschen. Admins dürfen nur
  leere, selbst angelegte Ordner entfernen, etwa zur Korrektur eines Tippfehlers. Spätere Änderungen an der Vorgabe
  gelten nur für neue Einsätze.
- **Vorlagen** (*Verwaltung → Vorlagen*, nur Admins): Vorlagen liegen in einem eigenen Ordnerbaum. Jede Vorlage legt
  fest:
  - einen **Ablageort** im Einsatz, etwa `Lagemeldungen/{{datum.iso}}`; fehlende Ordner werden angelegt
  - einen **Dateinamen**, etwa `Lagemeldung {{ordner.laufnummer}}`
  - ob Platzhalter auch **im Dokument** ersetzt werden (docx, xlsx, pptx, odt, ods, odp). Word zerlegt Platzhalter
    oft in mehrere Textläufe; das wird berücksichtigt. Unbekannte Platzhalter bleiben im Text stehen.

  Verfügbare Platzhalter: `einsatz.*`, `datum.*`, `benutzer.name`, `fahrzeug.*` und `ordner.laufnummer`. Die
  vollständige Liste steht in `packages/shared/src/documents.ts` und im Formular.
- **Arbeiten im Einsatz** (*Einsatz → Dokumente*):
  - **Aus Vorlage:** Vorlage suchen (Name, Beschreibung, Ordner) und öffnen. ELVIS legt eine Kopie am Ablageort an
    und öffnet sie in Collabora.
  - **Neues Dokument:** Text, Tabelle, Präsentation oder Zeichnung, mit frei gewähltem Ordner.
  - **Hochladen:** in den gewählten Ordner, wie bisher.
  - Neu erstellte Dokumente sind **Entwürfe**: Nur der Ersteller sieht sie, bis Collabora sie zum ersten Mal speichert.
    Ab dann sehen alle das Dokument und können es gleichzeitig bearbeiten. Nie gespeicherte Entwürfe verfallen nach
    24 h.
- **Collabora (Addon „Office (Collabora)“, siehe [Addons](../addons/README.md)):**
  - ELVIS ist der WOPI-Host (`/api/wopi/files/…`). Collabora holt und speichert die Dateien dort mit einem
    Zugriffstoken. Das Token gilt für eine Datei und einen Benutzer, 10 h lang.
  - Bei abgeschlossenen Einsätzen ist nur Lesen möglich.
  - Die Option **Adresse von ELVIS** muss vom Docker-Host aus erreichbar sein. Der Browser lädt den Editor direkt vom
    Docker-Host (Port 9980). Läuft ELVIS künftig über HTTPS, braucht auch Collabora TLS, sonst blockiert der Browser
    den gemischten Inhalt.
  - Ohne laufendes Addon bleiben Hochladen, Anzeigen und Herunterladen möglich; „Neues Dokument“ und die Bearbeitung
    im Browser sind dann gesperrt.
