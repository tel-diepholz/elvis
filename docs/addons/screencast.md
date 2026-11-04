# Bildschirmübertragung (Addon)

Empfänger für AirPlay (iPhone, iPad, Mac) und für die Bildschirmfreigabe im Browser (Windows, macOS, Linux). Die Bilder
erscheinen als Kachel „Video“. Die Anleitung für Admins steht im Addon selbst (`addons/screencast/README.md`, in ELVIS
unter **Anleitung**).

```
iPhone ──AirPlay──▶ UxPlay (-vrtp: H.264 entschlüsselt, nicht dekodiert) ─RTP─▶ Brücke (GStreamer) ─RTSP─┐
Laptop ──HTTPS-Seite, getDisplayMedia──WHIP──▶ receiver.py (Proxy) ──────────────────────────────────────┴▶ MediaMTX ─WHEP─▶ Kachel
```

- **Ohne Umkodieren:** UxPlay (ab 1.73, im Image aus dem Quellcode gebaut) gibt das H.264 des Apple-Geräts per RTP an
  eine kleine GStreamer-Brücke weiter, die es nur umverpackt (`rtph264depay ! h264parse ! rtspclientsink`). Auch die
  Browser-Freigabe gelangt unverändert zu MediaMTX. Nur der Ton wird umgerechnet: AirPlay liefert PCM, Browser brauchen
  Opus. Für ältere Bildschirm-Browser lässt sich optional umkodieren (x264 oder VA-API, Constrained Baseline wie beim
  NDI-Gateway).
- **Ton:** Die Brücke legt Stille unter den AirPlay-Ton. So steht das Tonformat sofort fest, auch wenn das Gerät noch
  keinen Ton schickt (sonst wartet `rtspclientsink` vor dem ANNOUNCE auf alle Spuren).
- **Brücke nur während einer Verbindung:** `receiver.py` liest die Ausgabe von UxPlay („connection request from …“,
  „Open connections: 0“), startet die Brücke beim Verbinden und beendet sie danach. Dadurch ist der Pfad in MediaMTX
  ohne Sender leer.
- **Wer sendet:** MediaMTX setzt `overridePublisher`, der neueste Sender löst den alten ab. Den Zustand je Empfänger
  liefert die MediaMTX-API (nur localhost): `rtspSession` bedeutet AirPlay, `webRTCSession` bedeutet Browser. Hat ein
  Browser den Empfänger übernommen, startet die AirPlay-Brücke erst wieder, wenn er fertig ist.
- **HTTPS:** Browser erlauben `getDisplayMedia` nur in einem sicheren Kontext. ELVIS selbst läuft über HTTP. Deshalb
  liefert `receiver.py` die Freigabeseite über HTTPS aus.
  - Das Zertifikat kommt aus der ELVIS-CA (Manifest `tls`, Dateien in `/data/elvis-tls`). Siehe
    [Manifest](manifest.md).
  - Ändert sich `key.pem`, lädt `receiver.py` das Zertifikat bei der nächsten Verbindung neu, ohne Neustart.
  - Liefert ELVIS kein Zertifikat (ältere Version), erzeugt `receiver.py` ein selbstsigniertes in `/data/tls`.
  - Abgebrochene TLS-Handshakes (Client vertraut der CA nicht) erscheinen nicht im Log.
  - WHIP läuft über denselben Ursprung an MediaMTX auf localhost. Daher darf MediaMTX weiterhin nur von localhost
    Ströme annehmen. Die Medien laufen per ICE direkt zu MediaMTX.
- **AirPlay-Identität:** Jeder Empfänger hat eine feste Geräte-ID (aus dem Pfad abgeleitet) und einen eigenen Schlüssel
  in `/data/keys`. Apple-Geräte erkennen ihn so nach einem Neustart wieder. Mehrere Empfänger belegen je drei Ports ab
  „Erster AirPlay-Port“.
- **Einbindung in ELVIS:** über `provides.videoSources` wie beim NDI-Gateway. Der Status kennt zusätzlich den Zustand
  `idle` (Empfänger bereit, niemand sendet), dazu `sender`, `via` und `connect` (AirPlay-Name, Adresse der
  Freigabeseite). Daraus zeigt die Kachel „Video“ eine Anleitung mit QR-Code. Bei „Erste verfügbare Quelle“ nimmt die
  Kachel bevorzugt einen Strom, der gerade sendet.
- **Player:** Der WebRTC-Player der Kachel setzt `jitterBufferTarget = 0`, ältere Chrome-Versionen
  `playoutDelayHint = 0`. Das gilt auch für NDI.
- **MoQ aus:** MediaMTX 1.21 startet sonst zusätzlich einen MoQ-Server auf 8892/8893. Läuft daneben das NDI-Gateway
  (MoQ dort an), käme es zu einem Portkonflikt.
- **Grenzen:** Android ohne App ist nicht möglich (Google Cast verlangt zertifizierte Empfänger). Miracast ist nicht
  eingebaut: Es braucht Wi-Fi Direct und damit einen WLAN-Adapter im Docker-Host. Kopiergeschützte Inhalte bleiben bei
  AirPlay schwarz.
- **Erprobt (lokal, ohne Docker):**
  - MediaMTX 1.21.2 mit `receiver.py`: Freigabeseite in Chromium (Canvas statt echtem Bildschirm) → WHIP → MediaMTX →
    WHEP-Zuschauer mit 1280×720 H.264 und Opus. Status `running/browser` → `idle`.
  - Brücke mit simuliertem UxPlay-RTP (H.264 + L16) → MediaMTX (H264 + Opus).
  - Ablauf der AirPlay-Verbindung mit nachgebildeter UxPlay-Ausgabe.
  - Noch nicht getestet: echtes iPhone und Mac, der Bau des Images auf einem Docker-Host sowie VA-API.
