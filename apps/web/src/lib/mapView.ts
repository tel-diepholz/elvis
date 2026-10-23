import { displayMapViewSchema, type DisplayMapView } from '@elvis/shared';

/** Zuletzt eingestellter Kartenausschnitt (pro Browser), z. B. damit er ein Neuladen übersteht */
export function loadMapView(key: string): DisplayMapView | null {
  try {
    const parsed = displayMapViewSchema.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // storage unavailable
  }
}

export function saveMapView(key: string, view: DisplayMapView): void {
  try {
    localStorage.setItem(key, JSON.stringify(view));
  } catch {
    /* storage unavailable */
  }
}

/** Gleicher Ausschnitt bis auf Rundung (Leaflet rechnet in ganzen Pixeln): Abweichung unter einem Kartenpixel */
export function sameMapView(a: DisplayMapView, b: DisplayMapView): boolean {
  const px = 360 / (256 * 2 ** a.zoom);
  return a.zoom === b.zoom && Math.abs(a.lat - b.lat) < px && Math.abs(a.lon - b.lon) < px;
}
