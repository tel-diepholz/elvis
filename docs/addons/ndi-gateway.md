# NDI-Gateway (Addon)

Macht NDI-Quellen im Browser sichtbar, z. B. als Kachel „Video (NDI)“ auf den Bildschirmen.

```
NDI-Quellen ─▶ Gateway (GStreamer, ndisrc → H.264) ─RTSP─▶ MediaMTX ─WebRTC─▶ Browser/Bildschirm
```

- **Gateway-Image:** Es wird beim Installieren auf dem Docker-Host gebaut (`builds` im Manifest, einmalig einige
  Minuten). Das NDI-Plugin für GStreamer wird dabei aus dem offiziellen Quellcode kompiliert
  (gst-plugins-rs 0.14.5, MPL-2.0).
- **NDI-Laufzeit (libndi):** Sie ist proprietär und deshalb nicht im Image. Der Job „NDI-Laufzeit laden“ holt sie erst,
  wenn in den Einstellungen „NDI-Lizenzbedingungen akzeptiert“ gesetzt ist, und legt nur die Bibliothek für die
  Rechnerarchitektur ins Volume. Die Lizenzbedingungen (NDI SDK License Agreement) prüft ihr als Lizenznehmer selbst.
- **Encoder wählbar:**
  - CPU (x264)
  - Intel/AMD-Grafik per VA-API: ELVIS reicht `/dev/dri` durch.
  - NVIDIA per NVENC: ELVIS fordert die GPU an, dafür braucht der Host NVIDIA-Treiber und das NVIDIA Container
    Toolkit.
  - Ausgabe immer als H.264 „Constrained Baseline“, 4:2:0, ohne B-Frames, Schlüsselbild alle 2 s, damit jeder
    Browser per WebRTC abspielt.
- **Weitere Optionen:** Auflösung 720p oder 1080p, Bitrate, Bildrate, Ton (Opus), Filter auf Quellnamen, Höchstzahl der
  Ströme, optional NDI Discovery Server statt mDNS sowie die Ports.
- **Übertragung:** Vorgabe ist TCP. Beim NDI-Standard „Reliable UDP“ schickt die Quelle UDP-Pakete zurück an den
  Empfänger. Hinter NAT, Firewalls oder in Docker Desktop gehen sie verloren, es erscheint „Keine Bilddaten von der
  Quelle“ (GStreamer: „Could not demultiplex stream“). Mit TCP laufen die Daten über die Verbindung, die das Gateway
  selbst aufbaut. Im Labor: bei blockiertem UDP 0 Bilder über Reliable UDP, 300 Bilder in 12 s über TCP.
- **Suche:** per mDNS über Avahi im Container. Beide Container laufen im Netzwerk des Hosts. MediaMTX nimmt Ströme nur
  von localhost an, Ansehen geht für alle im LAN.
- **Ton:** NDI-Ton mit beliebig vielen Kanälen und Abtastraten wird auf Stereo mit 48 kHz als Opus umgerechnet, das
  einzige Format, das alle Browser per WebRTC zuverlässig abspielen.
- **Player in der Kachel:** ein eigener WebRTC-Player (WHEP), der immer stumm startet, denn Browser verweigern den
  automatischen Start mit Ton. Ist „Ton“ eingeschaltet, schaltet er ihn danach ein. Blockiert der Browser das (z. B.
  Safari/iPad), läuft das Bild stumm weiter, und der Knopf „Ton einschalten“ erscheint. Kiosk-Browser mit
  `--autoplay-policy=no-user-gesture-required` spielen Ton immer sofort.
- **Einbindung in ELVIS:** ELVIS fragt den Status des Gateways ab (`provides.videoSources`, nur lesend, Port
  „Status“). Die Ströme erscheinen unter `/api/video/sources` und in der Kachel „Video (NDI)“. Bildschirme müssen den
  Docker-Host direkt erreichen (WebRTC, Ports „WebRTC“ und „WebRTC-Medien“).
- **Erprobt:** im Labor mit einer NDI-Testquelle bis zur Wiedergabe im Browser (720p, x264). VA-API und NVENC sind
  eingebaut, mangels Hardware hier aber nicht getestet.

Die dafür eingeführten Manifest-Funktionen (`builds`, `devices`/`gpus` mit `when`, `provides.videoSources`) stehen in der [Manifest-Referenz](manifest.md#weitere-manifest-funktionen).
