# Telefonie (Simulation, Yeastar NeoGate TG)

Das Modul **Telefonie** bindet ein GSM-Gateway an, z. B. das Yeastar NeoGate TG200 mit zwei GSM-Ports. Das Gateway
meldet sich per SIP an der Telefonanlage des Fahrzeugs an. ELVIS zeigt unter **Fahrzeug → Telefonie**:

- **GSM-Trunks**: je Port Netz, Netzregistrierung (Roaming), Signal (Prozent und dBm), Bitfehlerrate, Modem und SMS-Zentrale.
  Ein Trunk ohne Netz oder ohne SIM löst eine Warnung aus.
- **SIP**: ob der SIP-Dienst des Gateways antwortet (SIP OPTIONS an UDP 5060). Antwortet er nicht, kommt eine Warnung.
- **Laufende Gespräche** mit Richtung, Trunk und Dauer. Ist die Nummer in den Kontakten, steht dort der Name.
- **Anrufliste** der letzten 24 Stunden. Sie wird 90 Tage aufbewahrt.

**Einsatztagebuch:** Solange ein Einsatz läuft, wird jedes beendete Gespräch als Eintrag der Kategorie
„Telefon“ geschrieben. Als Zeitpunkt gilt der Beginn des Gesprächs, als Verfasser „Telefonie“. Das gilt für
ein- und ausgehende Gespräche, auch für verpasste und nicht erreichte, z. B.
„Anruf von Muster, Max (Mobil), +49 170 1234567 über GSM 1, Dauer 2:11 min“.

**SMS** stehen unter [Nachrichten](../funktionen/nachrichten.md). Sie laufen über dasselbe Gateway.

## Gateway einrichten (TG200)

1. In der Weboberfläche des Gateways unter *System → API* (je nach Firmware *Other Settings → API Settings*) die
   API einschalten und einen API-Benutzer mit Passwort anlegen. Das ist nicht der Login der Weboberfläche.
   Ab Werk heißt der Benutzer meist `apiuser` mit dem Passwort `apipass`. Bitte ändern.
2. Den Zugriff auf die IP-Adresse des ELVIS-Servers beschränken (erlaubte IP in den API-Einstellungen).
3. NTP einstellen: Ohne Zeitserver steht die Uhr des Gateways auf 1970. ELVIS nutzt für Anrufe und SMS zwar seine
   eigene Uhr, die Protokolle des Gateways sind sonst aber nicht zu gebrauchen.

## Einstellungen

*Einstellungen → Fahrzeugmodule → Telefonie*, Treiber **Yeastar NeoGate TG**:

| Einstellung | Bedeutung |
| --- | --- |
| Adresse, API-Port | IP des Gateways, Port der TG-API (Standard 5038) |
| API-Benutzer, API-Passwort | aus Schritt 1 |
| Bezeichnung der Trunks | je Port „Nummer:Name“, z. B. `1:Telekom D1; 2:Vodafone` |
| Port für ausgehende SMS | Standard in der SMS-Maske; 0 = erster verbundener Trunk |
| SIP-Dienst prüfen, SIP-Port | SIP-OPTIONS-Abfrage an das Gateway |
| Abfrageintervall | Zustand der Trunks (Standard 30 s) |

## Technik und Grenzen

- **TG-API:** TCP, Text im Stil des Asterisk Manager Interface. ELVIS meldet sich mit `Events: on` an und fragt
  `gsm show spans` und `gsm show span N` ab. Span 2 entspricht Port 1, Span 3 Port 2.
- **Rechte des API-Benutzers:** Am TG200 sind nur `SMSCommand`, `Events`, `Ping`, `Login`/`Logoff`, `ListCommands`
  und `WaitEvent` erlaubt. `Command`, `SIPpeers` und `Status` lehnt das Gateway ab.
- **SIP:** Die Registrierung an der Telefonanlage meldet die API nicht. ELVIS prüft deshalb nur, ob der SIP-Dienst
  antwortet. Schickt das Gateway `Registry`-Ereignisse, erscheint die Registrierung zusätzlich.
- **Gespräche** erkennt ELVIS an den Kanal-Ereignissen (`Newchannel`, `Newstate`, `Dial`, `Hangup`) auf GSM-Kanälen.
  Ein Kanal, der klingelnd entsteht, ist eingehend, einer per Dial ausgehend. Ereignisse, die ELVIS nicht auswertet,
  stehen einmalig im Server-Log („noch nicht ausgewertetes Ereignis“). Damit lässt sich die Zuordnung an einer neuen
  Firmware prüfen.
- **SMS** gehen mit `gsm send sms <span> <nummer> "<text>" <id>` hinaus. Erst die Bestätigung (`UpdateSMS`) gilt als
  gesendet. Eingehende SMS kommen als Ereignis `ReceivedSMS`, mit URL-kodiertem Text. Mehrteilige SMS setzt ELVIS
  wieder zusammen.
- Ohne Gateway liefert der Treiber **Simulation** zwei Trunks, gelegentliche Anrufe und SMS. Eine SMS mit
  „#fehler“ im Text schlägt fehl.
