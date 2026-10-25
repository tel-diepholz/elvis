export type AccessLevel = 'public' | 'user' | 'admin';

/**
 * Zugriffsregeln je Endpunkt. Anonyme Arbeitsplätze dürfen den Fahrzeugzustand lesen,
 * aber nichts ändern; Einsatzdaten erfordern eine Anmeldung, die Docker-/Addon-Verwaltung Admin-Rechte.
 * Unbekannte /api-Pfade verlangen standardmäßig eine Anmeldung.
 */
export function accessLevel(method: string, rawUrl: string): AccessLevel {
  const url = rawUrl.split('?')[0]!;
  if (!url.startsWith('/api/')) return 'public'; // Web-Oberfläche
  const read = method === 'GET' || method === 'HEAD';

  // Anmeldung selbst und Ersteinrichtung
  if (url.startsWith('/api/auth/')) return url === '/api/auth/pin' || url === '/api/auth/role' ? 'user' : 'public';

  // Vom Docker-Host per curl abgerufen, über den Einmal-Token geschützt
  if (url.startsWith('/api/docker/setup/')) return 'public';
  if (url.startsWith('/api/docker/') || url.startsWith('/api/addons') || url.startsWith('/api/system/')) return 'admin';

  // Office-Server (Collabora) ruft ohne Sitzung zurück und weist sich mit dem WOPI-Zugriffstoken aus
  if (url.startsWith('/api/wopi/')) return 'public';
  // Vorlagen nutzen alle, pflegen nur Admins (Bearbeiten im Office-Server ändert die Vorlage selbst)
  if (url.startsWith('/api/templates') || url.startsWith('/api/template-folders')) return read ? 'user' : 'admin';

  // Bildschirme: Gerätesicht (/api/display/…) prüft das Gerätecookie selbst; die Liste ist lesbar wie der Fahrzeugzustand
  if (url.startsWith('/api/display/')) return 'public';
  // Arbeitsplätze (Addon „ELVIS Arbeitsplatz“): Installer und Client-Dienst weisen sich per Bearer-Token aus
  if (url.startsWith('/api/clients/')) return 'public';
  if (read && (url === '/api/displays' || url === '/api/video/sources')) return 'public';

  // Druckserver: PDFs drucken dürfen auch anonyme Arbeitsplätze (Einstellungen unter /api/system/)
  if (url === '/api/printing' || url === '/api/printing/jobs' || url.startsWith('/api/printing/jobs/')) return 'public';
  // Gastdrucker des Addons: meldet sich mit eigenem Token (prüft der Druckdienst)
  if (url === '/api/printing/guest/submit') return 'public';

  // Fahrzeugname und Kartenzeichen braucht auch die anonyme Ansicht; ändern dürfen nur Admins.
  if (url === '/api/settings') return read ? 'public' : 'admin';

  if (read) {
    if (url === '/api/health' || url === '/api/info' || url === '/api/live' || url === '/api/alerts') return 'public';
    if (url.startsWith('/api/devices') || url.startsWith('/api/map/') || url === '/api/weather' || url.startsWith('/api/weather/')) return 'public';
    // Livebild wie der Fahrzeugzustand; gespeicherte Positionen sind Einsatzdaten (Anmeldung)
    if (/^\/api\/cameras\/[^/]+\/stream$/.test(url)) return 'public';
  }
  return 'user';
}

/** Endpunkte, die gekoppelte Bildschirme ohne Benutzeranmeldung lesen dürfen (Einsatzort, Kartenobjekte, Kräfte, Aufgaben, Gastnetz, Bilder) */
export function displayReadable(method: string, rawUrl: string): boolean {
  const url = rawUrl.split('?')[0]!;
  return (method === 'GET' || method === 'HEAD') && (url === '/api/incidents/active' || url === '/api/wifi/guest' || /^\/api\/incidents\/\d+\/(objects|units|tasks)$/.test(url) || /^\/api\/displays\/images\/\d+$/.test(url));
}
