# Cloud Messaging (Fahrzeug-Chat)

ELVIS-Installationen schreiben sich über das Cloud-Relay gegenseitig: Text, Dokumente, Bilder und Standorte, Ende zu
Ende verschlüsselt. Der Chat ist ein eigener Kanal **Fahrzeug-Chat** unter **Nachrichten**, neben SMS und den Messengern.

```
ELVIS A ──signiert, verschlüsselt──▶ Relay ──WebSocket-Anstoß──▶ ELVIS B (holt ab, entschlüsselt, prüft Signatur)
```

## Voraussetzungen und Einrichtung

- Ein aktives [ELVIS-Postfach](email.md): Dessen OpenPGP-Schlüssel verschlüsselt und signiert alle Nachrichten. Der
  Ed25519-Schlüssel signiert jeden Aufruf beim Relay.
- *Einstellungen → Fahrzeug & Einheit*: Name, Funkrufname, Organisation und **Kontaktdaten**. Das sind beliebig viele
  E-Mail-Adressen und Rufnummern, jeweils mit freier Beschriftung (z. B. „Primär-SIM“, „Sekundär-SIM“,
  „Satellitentelefon“). Die Kontaktdaten gibt es auch als Platzhalter `{{fahrzeug.kontakte}}` in Dokumentvorlagen.
- *Einstellungen → Cloud Messaging* (Admins): die **Gebietskörperschaft** wählen, als Baum Deutschland › Land › Kreis ›
  (Samtgemeinde, Amt, Verbandsgemeinde …) › Gemeinde oder über die Suche. Jede Ebene ist gültig. Danach
  **Registrieren**. Der Schalter „Im Verzeichnis sichtbar“ bestimmt, ob andere die Installation finden. Ohne ihn kann
  sie trotzdem selbst anfragen. Änderungen unter „Fahrzeug & Einheit“ gehen automatisch ins Verzeichnis.
- Die Karte zeigt den Verbindungsstatus. ELVIS hält eine ausgehende WebSocket-Verbindung zum Relay (kein offener Port
  im Fahrzeug nötig) und bekommt neue Nachrichten sofort. Ist sie dauerhaft gestört (z. B. ein Proxy ohne WebSocket),
  ruft ELVIS jede Minute ab.

## Ablauf

1. **Anfragen:** *Nachrichten → Fahrzeug anschreiben*. Gesucht wird nach Fahrzeug, Funkrufname oder Organisation, mit
   „Eingrenzen“ auf ein Gebiet (ein Kreis umfasst alle Gemeinden darin). Treffer zeigen die Kontaktdaten. **Chat
   anfragen** schickt der Gegenseite, wer fragt (Name und Rolle) und von welchem Fahrzeug.
2. **Annehmen:** In der angefragten Installation erscheint bei allen Angemeldeten unten links „… möchte einen Chat
   aufbauen“ mit Ton. Jeder Angemeldete kann annehmen oder ablehnen.
3. **Chatten:** Nach dem Annehmen sehen beide im Gesprächskopf, wer im anderen Fahrzeug angemeldet ist, mit Rollen. Die
   Liste folgt An- und Abmeldungen. Unten schreibt man wie in jedem Kanal, Dokumente aus der Lage lassen sich anhängen.
   An jeder eingegangenen Nachricht steht, wer sie geschrieben hat.
4. **Beenden** kann jede Seite. Danach lässt sich der Chat erneut anfragen.

Anfragen, Annahme, Ablehnung, Ende und Schlüsselwechsel der Gegenseite stehen im Bedienprotokoll (Ziel `messaging`).

## Sicherheit

- Jede Nachricht ist ein JSON-Umschlag. Er ist mit OpenPGP signiert und für die Gegenseite und für einen selbst
  verschlüsselt. Anhänge verschlüsselt ELVIS vorher mit einem Einmalschlüssel (AES-256-GCM). Schlüssel und Prüfsumme
  reisen im signierten Umschlag.
- Eingehende Nachrichten müssen mit dem Schlüssel signiert sein, den das Verzeichnis für die Gegenseite nennt. Sonst
  werden sie verworfen und ins Bedienprotokoll geschrieben.
- Das Relay sieht nur, welche Installation wann einer anderen schreibt. Es löscht alles mit der Abholung, spätestens
  nach 14 Tagen.

## Erweiterbar

Der Umschlag hat ein Feld `kind` (`request`, `crew`, `text`, `file`, `location`, siehe
`packages/shared/src/messaging.ts`). Weitere Arten, z. B. eine synchrone Lagekarte, kommen als neues `kind` dazu. Ältere
Installationen schreiben unbekannte Arten ins Bedienprotokoll und verwerfen sie ohne Fehler.
