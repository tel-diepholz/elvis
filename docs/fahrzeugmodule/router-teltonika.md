# ELW-Router Teltonika RUTM59 (RutOS-Web-API)

Treiber `teltonika-rutos` für Teltonika-Router mit RutOS ab Firmware 7.x. Er arbeitet nur lesend und fragt zyklisch ab:

| Anzeige | Quelle (RutOS-API) |
| --- | --- |
| SIM 1 und SIM 2: aktiv/Reserve, Status (verbunden, PIN/PUK, keine SIM …), Betreiber, Netz/Band, Signal, ICCID | `GET /api/modems/status` |
| Failover: Reihenfolge, Zustand je Verbindung, aktive Verbindung, „Ausweichverbindung aktiv“ | `GET /api/failover/status` + Metrik aus `GET /api/interfaces/status` |
| WAN-Port: Link und Geschwindigkeit, IP-Adresse, Gateway | `GET /api/ports_settings/status`, `GET /api/interfaces/status` |
| DHCP-Leases (IPv4): Gerät, IP, MAC, Netz, fest/dynamisch, Restlaufzeit | `GET /api/dhcp/leases/ipv4/status`, feste Zuweisungen aus `GET /api/dhcp/static_leases/ipv4/config` |

- Anmeldung über `POST /api/login` mit Bearer-Token. Das Token wird vor Ablauf erneuert. Am besten im Router einen
  eigenen Benutzer mit Leserechten **ohne** Zwei-Faktor-Anmeldung anlegen.
- Ab RutOS 7.15 ist HTTPS mit selbstsigniertem Zertifikat Standard. Deshalb ist „Zertifikat prüfen“ ab Werk aus.
- Der WAN-Port bekommt in den Moduleinstellungen eine eigene Bezeichnung (z. B. „LAN Feuerwache“). Sie erscheint
  überall statt „WAN“.
- Das Modem des RUTM59 bedient immer nur eine SIM. Für die Reserve-SIM zeigt ELVIS die zuletzt bekannten Werte aus
  der Zeit, als sie aktiv war. Nach einem ELVIS-Neustart ist ihr Zustand bis zur nächsten Umschaltung unbekannt.
- Endpunkte, die eine ältere Firmware nicht kennt, werden übersprungen. Dann fehlt z. B. der Link-Status des Ports.
- Meldungen: „keine Internetverbindung“ (Alarm), SIM-Probleme wie fehlende SIM oder PIN (Warnung) und
  „Ausweichverbindung aktiv“ (Hinweis).
