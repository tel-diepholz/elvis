# Arbeitsplätze (PXE)

Das Addon **„ELVIS Arbeitsplatz (PXE)“** installiert Notebooks per Netzwerkstart mit einem Ubuntu-System (24.04 LTS,
KDE Plasma). Man meldet sich dort mit den Benutzern und PINs aus ELVIS an.

- **Abbild bauen** (Job beim Installieren des Addons, einmalig mit Internet): `mmdebstrap` baut das Arbeitsplatz-System
  (`rootfs.tar.zst`), den Installer (Live-System mit `live-boot`, wird per HTTP in den RAM geladen) und die
  Startdateien für den Netzwerkstart. Danach läuft die Installation ganz ohne Internet. Der Bau läuft
  mit `SYS_ADMIN` und **ohne AppArmor-Profil** (neues Manifestfeld `apparmor: unconfined`, wird vor der Installation
  angezeigt), aber nie privilegiert.
- **Netzwerkstart:** Der Container `pxe` (Netzwerk des Hosts) betreibt dnsmasq als **ProxyDHCP** und TFTP sowie nginx
  (Option „HTTP-Port“, Vorgabe 8089). Adressen vergibt weiter der Router, dnsmasq ergänzt nur die Startangaben.
  - **UEFI:** shim und GRUB, von Ubuntu signiert. Das funktioniert auch mit Secure Boot.
  - **BIOS:** lpxelinux.
  - Das Startmenü wählt nach 10 Sekunden **„Von Festplatte starten“**. Installiert wird nur, wenn man das ausdrücklich
    auswählt.
- **Installer** (Textoberfläche auf dem Notebook): Er fragt immer ab:
  - die **Zielplatte**: Liste mit Größe, Modell, Anschluss und den vorhandenen Partitionen, USB-Sticks markiert
  - das **Ziel des Bootloaders**:
    - UEFI: eine neue EFI-Partition auf der Zielplatte oder eine vorhandene EFI-Partition (Dual-Boot); außerdem, ob
      ein UEFI-Booteintrag angelegt wird und/oder der Standardpfad `EFI/BOOT/BOOTX64.EFI` genutzt wird
    - BIOS: den MBR einer gewählten Platte
  - den Rechnernamen

  Danach folgt eine Zusammenfassung, und man muss **JA** eintippen. Bis dahin wird nichts verändert. Vor dem Löschen
  registriert sich das Notebook bei ELVIS. Ist ELVIS nicht erreichbar, bleibt die Platte unberührt.
- **Installer-ISO** (ohne PXE): *Einstellungen → Arbeitsplätze → Installer-ISO* lädt eine hybride ISO (ca. 150 MB) herunter.
  Sie startet per BIOS und UEFI (auch mit Secure Boot) und funktioniert als CD oder auf einem USB-Stick
  (balenaEtcher, Rufus im DD-Modus oder `dd`). Die ISO enthält nur Kernel und initrd. Installer-System und
  Abbild lädt das Notebook per Netzwerkkabel vom Addon. Der Container `pxe` erzeugt sie bei jedem Start mit seiner
  aktuellen Adresse (`/iso/elvis-installer.iso`). Dafür braucht er einmal einen Lauf von „Installer neu bauen“
  (Addon ab 1.1.0).
- **Anmeldung:** Die Anmeldemaske (SDDM-Theme) zeigt alle Benutzer aus ELVIS mit Suche, angemeldet wird mit der PIN.
  - Die PIN prüft der Dienst `elvis-clientd` über `POST /api/clients/login` mit denselben Sperren wie in ELVIS. Dabei
    entsteht keine Web-Sitzung, der Eintrag steht im Bedienprotokoll.
  - Danach meldet SDDM ein lokales Profilkonto **je Benutzer und Einsatz** an (`e<Einsatz-ID>u<Benutzer-ID>`,
    UID 50000–59999, ohne Einsatz `e0u…`), und zwar mit einem Einmalpasswort (PAM: `pam_exec`).
  - Abmelden und wieder Anmelden im selben Einsatz führt ins selbe Profil. In einem neuen Einsatz gibt es ein neues,
    leeres Profil; alte Profile bleiben auf dem Notebook, werden aber nicht mehr genutzt.
  - Beim Start der Sitzung weist ein Dialog darauf hin, dass die Anpassungen nur für den aktuellen Einsatz gelten
    (Name und ID).
- **Offline:** Ist ELVIS nicht erreichbar, kommen nur Benutzer hinein, die sich an diesem Gerät schon einmal angemeldet
  haben.
  - Der Dienst merkt sich dafür einen scrypt-Verifier der PIN. Er wird verworfen, sobald sich die PIN in ELVIS ändert
    (`pinStamp`) oder der Benutzer gelöscht wird.
  - Offline gilt der zuletzt bekannte Einsatz.
  - Grenze: Wer Root-Zugriff auf die Platte hat, kann eine vierstellige PIN aus dem Verifier leicht erraten. Die
    Profile sind ohnehin unverschlüsselt.
- **Keine automatischen Updates:** Folgendes ist entfernt bzw. maskiert, damit das System nicht von sich aus nach
  Updates sucht oder welche lädt (Updates nur auf Auftrag, siehe unten):
  - entfernt: unattended-upgrades, update-notifier, Discover, PackageKit und snapd
  - maskiert: die apt-, fwupd- und motd-Timer
  - geleert: die Paketquellen (die alten liegen unter `/etc/apt/sources.disabled`)

  Firefox kommt als deb von Mozilla, die Update-Prüfung im Browser ist per Richtlinie aus, und die Startseite ist ELVIS.
- **Aussehen:** Fluent-Theme (vinceliuice, GPL-3.0) für Plasma, Kvantum, GTK und Symbole. Eine Taskleiste unten mit
  Start und Programmen in der Mitte, Fensterknöpfe rechts, ELVIS-Hintergrund. Das Look-and-Feel-Paket
  `de.elvis.desktop` gilt für jedes neue Profil.
- **Updates** (*Einstellungen → Arbeitsplätze*, je Gerät oder „Alle aktualisieren“): Pakete (`apt dist-upgrade`) und/oder
  Firmware (fwupd/LVFS) auf Auftrag aus ELVIS.
  - **Quelle:** Die Pakete kommen über den apt-Cache des Addons (Container `aptcache`, apt-cacher-ng, Option
    „Port des apt-Caches“, Vorgabe 3142). Nur der Docker-Host braucht Internet, jedes Paket wird einmal geladen.
    Firefox (Mozilla) und Firmware (LVFS) gehen per HTTPS ungecacht durch, nur zu diesen Zielen.
  - **Ablauf:** Das Notebook holt den Auftrag beim Abgleich (alle 30 s) und startet erst, wenn niemand angemeldet ist,
    sonst nach der nächsten Abmeldung. Während des Updates sperrt die Anmeldemaske. Danach werden die Paketquellen
    wieder verworfen, und bei Bedarf (neuer Kernel, Firmware) startet das Notebook selbst neu.
  - **Rückmeldung:** Stand, Ergebnis und Protokoll (Ende der Ausgabe) erscheinen in der Liste und im
    Bedienprotokoll. Ein wartendes Update lässt sich zurücknehmen.
  - **Automatisch** sucht das System weiterhin nichts.
  - **Technik:** `POST|DELETE /api/system/workstations/:id/update` (`:id` = `all` für alle),
    Rückmeldung `POST /api/clients/update`, Auftrag in `GET /api/clients/state`.
- **Betriebs-WLAN:** Ist unter *Einstellungen → WLAN-Accesspoints* das [Betriebs-WLAN](../fahrzeugmodule/wlan-openwrt.md) eingeschaltet, hinterlegt jeder Arbeitsplatz es
  automatisch als systemweite Verbindung „ELVIS Betrieb“ (NetworkManager, WPA2, verbindet sich selbst).
  - Änderungen an Netzname oder Passwort übernimmt das Notebook beim nächsten Abgleich (30 s). Schaltet man das
    Betriebs-WLAN in ELVIS ab, wird die Verbindung entfernt.
  - Die Zugangsdaten gehen über `GET /api/clients/state` an registrierte Arbeitsplätze (wie alles im Fahrzeug-LAN per
    HTTP).
  - Je nach polkit-Regel von Ubuntu können angemeldete Benutzer das Passwort in den Netzwerkeinstellungen sehen.
  - Das Gast-WLAN wird nicht hinterlegt.
- **Notfall-Admin:** Das Konto `elvisadmin` (Passwort aus den Addon-Optionen, `sudo`) meldet sich nur an der
  Textkonsole an (Strg+Alt+F3), nicht an der Anmeldemaske.
- **Verwaltung** (*Einstellungen → Arbeitsplätze*, nur Admins): Übersicht mit Rechnername, MAC-Adresse, zuletzt gesehen,
  angemeldetem Benutzer und Version.
  - Umbenennen ist möglich.
  - **Entfernen** sperrt das Gerätetoken. Beim nächsten Kontakt verwirft das Notebook auch seine Offline-Anmeldedaten.
  - Eine Neuinstallation mit derselben MAC-Adresse ersetzt den Eintrag.
- **Sicherheit:** Das Registrierungstoken (`{{addon.secret}}`, `provides.workstations`) liefert nginx ohne Anmeldung an
  den Installer aus. Den HTTP-Port des Addons deshalb nur im LAN der Arbeitsplätze erreichbar machen. Gerätetokens
  speichert ELVIS nur als Hash.
- **Technik:**
  - Endpunkte: `POST /api/clients/enroll` (Addon-Token), `GET /api/clients/state`, `POST /api/clients/login`,
    `POST /api/clients/heartbeat` (Gerätetoken als `Authorization: Bearer`), `GET|PUT|DELETE /api/system/workstations`.
  - Quellen des Client-Systems: `addons/arbeitsplatz/files/client/` (Dienst, PAM, SDDM-Theme, Plasma-Vorgaben).
