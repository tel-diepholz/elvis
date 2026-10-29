# Benutzer und Anmeldung

- **Anmeldung:** Den eigenen Namen in der durchsuchbaren Liste wählen und die 4-stellige PIN eingeben, per
  Ziffernblock (Touch) oder Tastatur. Benutzernamen und Passwörter gibt es nicht. „Benutzer wechseln“ im
  Kontomenü ist für gemeinsam genutzte Arbeitsplätze gedacht.
- **Rollen:** Nach der Anmeldung wählt man seine [Rollen im Einsatz](rollen.md), vorausgewählt sind die zuletzt
  gewählten. Rollen steuern Aufgaben, Meldungen und Anforderungen, nicht die Rechte.
- **Ersteinrichtung:** Beim allerersten Start legt man den ersten Benutzer an, er ist Admin. `deploy/install.sh` fragt
  ihn im Terminal ab.
- **Rechte:**
  - **Jeder Benutzer** darf alles Operative: Einsatz, Tagebuch, Kräfte, Dokumente, Fahrzeugbedienung, Druck. Er darf
    auch neue Benutzer anlegen, aber ohne Admin-Rechte.
  - **Nur Admins** dürfen das Admin-Flag vergeben, andere Benutzer bearbeiten oder löschen, deren PIN zurücksetzen
    und Addons sowie Docker-Hosts verwalten. Der letzte Admin kann weder herabgestuft noch gelöscht werden.
  - **Anonyme Arbeitsplätze** sehen den Fahrzeugbereich (Übersicht, Karte, Wetter, Netzwerk)
    nur lesend. Einsatzdaten, Archiv, Benutzer und System erfordern eine Anmeldung. Der Server setzt das
    durch (`apps/server/src/auth/access.ts`). Unbekannte Endpunkte verlangen standardmäßig eine Anmeldung.
- **Sicherheit:**
  - Die PINs werden mit scrypt gehasht gespeichert.
  - Nach 3 Fehlversuchen wird der Benutzer gesperrt: zuerst 30 s, danach jeweils doppelt so lang, höchstens 15 min.
    Ein Gerät, das 10 Fehlversuche in 10 min erreicht, wird für 10 min gesperrt.
  - Sitzungen laufen über ein HttpOnly-Cookie und enden nach 12 h Inaktivität, spätestens nach 7 Tagen. Das Ändern
    oder Zurücksetzen der PIN beendet andere Sitzungen.
  - Eine 4-stellige PIN ist bewusst einfach gehalten. Sie schützt vor versehentlicher und unbefugter Bedienung im
    Fahrzeug, nicht vor einem gezielten Angriff aus einem offenen Netz.
- Einträge im Einsatztagebuch und im Bedienprotokoll tragen den Namen des angemeldeten Benutzers.
