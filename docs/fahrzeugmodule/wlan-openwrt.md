# WLAN (OpenWrt-Accesspoints)

Unter **Einstellungen → WLAN-Accesspoints** (nur Admins) beliebig viele OpenWrt-Geräte anlegen: Adresse, Konto (meist
`root`), das Netz für das Betriebs-WLAN (meist `lan`) und die **Gastnetz-Bridge** (z. B. `br-guests`). Angegeben
werden kann jeweils eine OpenWrt-Schnittstelle (`lan`), eine Bridge (`br-lan`) oder ein Bridge-Port (`eth0`). Die Bridge
muss auf dem AP bereits eingerichtet sein; hat sie noch keine Schnittstelle (nur unter *Netzwerk → Geräte* angelegt),
legt ELVIS dafür die Schnittstelle `elvis_guest` (ohne IP) an und entfernt sie mit dem Gastnetz wieder. Leer = auf
diesem AP kein Gastnetz.

- **Zugriff:** wie LuCI über ubus/JSON-RPC (`/ubus`, Paket `uhttpd-mod-ubus`, bei LuCI dabei); Änderungen werden mit
  `uci apply` übernommen (das root-Konto von LuCI darf kein `uci commit`). ELVIS legt je Funkmodul
  eigene WLANs an (`elvis_ops_<radio>`, `elvis_guest_<radio>`, WPA2), schaltet ausgeschaltete Funkmodule ein und lässt
  alle anderen WLANs unverändert. Geschrieben und neu geladen wird nur bei Abweichungen; der Abgleich läuft bei jeder
  Änderung und jede Minute (holt zurückgesetzte APs wieder auf den Sollstand). „Jetzt übertragen“ stößt ihn sofort an.
- **Betriebs-WLAN** (Einstellungen → WLAN-Accesspoints): Netzname und Passwort, dauerhaft auf allen aktiven APs.
- **Gastnetz:** einschaltbar mit eigenem Netznamen. Sobald ein Einsatz eröffnet ist, richtet ELVIS es auf allen APs
  mit Gastnetz-Bridge ein – Netzname mit angehängter Einsatznummer (`Gast-12`), Passwort je Einsatz neu erzeugt, Clients
  untereinander abgeschottet. Mit Ende des Einsatzes verschwindet es wieder.
- **Fahrzeugmodul „WLAN-Accesspoints“** (Treiber *OpenWrt*, unter *Einstellungen → Fahrzeugmodule*): fragt alle aktiven APs
  im Hintergrund ab (Vorgabe alle 10 s, `iwinfo assoclist`, Zuordnung der WLANs über `luci-rpc`) und schreibt die
  angemeldeten Geräte in die Tabelle `wifi_clients` – nur der aktuelle Stand, abgemeldete Geräte verschwinden. Unter
  *Netzwerk* zeigen zwei Tabellen (nur angemeldet) daraus die Geräte im Betriebs-WLAN und im Gastnetz mit AP, Band,
  Signal, Datenrate und Verbindungsdauer. Namen und IPs kommen aus den Host-Hinweisen des APs und, falls das Modul
  [ELW-Router](router-teltonika.md) läuft, aus dessen DHCP-Leases.
- **Alarm:** Antwortet ein AP nicht, meldet das Modul „Accesspoint … nicht erreichbar“ (Alarm); seine Geräte bleiben
  bis zur nächsten erfolgreichen Abfrage mit dem letzten Stand stehen.
- Entfernte oder deaktivierte APs fasst ELVIS nicht mehr an; dort bereits eingerichtete WLANs bleiben bestehen.
- Ergebnis und Fehler je AP (nicht erreichbar, Anmeldung abgelehnt, Gastnetz-Bridge fehlt) stehen in der Liste;
  Übertragungen und neue Fehler im Bedienprotokoll.
