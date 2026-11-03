import type { IncomingMessage } from 'node:http';
import { AxisError, AxisHttp, type AxisConnection } from '../axis/http.js';
import { NO_CAPS, type CameraClient, type CameraProbe, type CameraReading } from '../axis/camera.js';

interface Resolution {
  width: number;
  height: number;
}

interface ApiReply<T> {
  success: boolean;
  result?: T;
  error?: { code: number; param?: string; description?: string };
}

/** Bildgrößen, die 2N-Geräte ohne Liste der Kamera sicher kennen */
const FALLBACK_RESOLUTIONS: Resolution[] = [
  { width: 320, height: 240 },
  { width: 640, height: 480 },
];
const LIVE_FPS = 10;
const THUMB_FPS = 2;
const THUMB: Resolution = { width: 320, height: 240 };

const parseResolution = (s: string): Resolution | null => {
  const m = /^(\d+)x(\d+)$/.exec(s);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
};

/** Nächstliegende Bildgröße aus der Liste der Kamera (2N nimmt nur exakt passende Werte an). */
export function nearestResolution(wanted: Resolution, available: Resolution[]): Resolution {
  const list = available.length ? available : FALLBACK_RESOLUTIONS;
  return list.reduce((best, r) => (Math.abs(r.width - wanted.width) + Math.abs(r.height - wanted.height) < Math.abs(best.width - wanted.width) + Math.abs(best.height - wanted.height) ? r : best));
}

const describe = (e: ApiReply<unknown>['error']) =>
  e?.code === 9 || e?.code === 10 ? 'Anmeldung an der Türstation abgelehnt – Benutzer/Passwort und Rechte des HTTP-API-Kontos prüfen' : `${e?.description ?? 'unbekannter Fehler'}${e?.param ? ` (${e.param})` : ''}`;

/**
 * 2N-IP-Türsprechstelle (z. B. 2N IP Base, Verso, Force) über die 2N HTTP API. Nur Bild: das Livebild kommt als
 * MJPEG über /api/camera/snapshot mit fps-Parameter. Schwenken, Zoom usw. gibt es nicht.
 * In der Türstation muss unter „Dienste → HTTP API“ die Kamera-API freigegeben und ein Konto mit dem Recht
 * „Kamera“ angelegt sein.
 */
export class TwoNIntercom implements CameraClient {
  readonly http: AxisHttp;
  private resolutions: Resolution[] = [];

  constructor(connection: AxisConnection, http?: AxisHttp) {
    this.http = http ?? new AxisHttp(connection);
  }

  private async api<T>(path: string): Promise<T> {
    const r = await this.http.send('GET', path);
    let data: ApiReply<T>;
    try {
      data = JSON.parse(r.body.toString('utf8')) as ApiReply<T>;
    } catch {
      throw new AxisError(`${path}: HTTP ${r.status}`, r.status >= 300 ? r.status : 502);
    }
    if (!data.success) throw new AxisError(`Türstation lehnt ab: ${describe(data.error)}`, r.status >= 300 ? r.status : 400);
    if (r.status >= 300) throw new AxisError(`${path}: HTTP ${r.status}`, r.status);
    return data.result as T;
  }

  private async readCaps(): Promise<Resolution[]> {
    const caps = await this.api<{ jpegResolution?: Resolution[] }>('/api/camera/caps');
    return (caps.jpegResolution ?? []).filter((r) => r.width > 0 && r.height > 0);
  }

  async probe(): Promise<CameraProbe> {
    const info = await this.api<{ variant?: string; deviceName?: string; swVersion?: string }>('/api/system/info');
    // Kamera-API zugleich als Test von Anmeldung und Freigabe
    this.resolutions = await this.readCaps();
    const sizes = this.resolutions.map((r) => `${r.width}x${r.height}`).join(', ');
    return {
      model: info.variant ?? '2N IP',
      caps: NO_CAPS,
      notes: [info.swVersion && `Firmware ${info.swVersion}`, sizes && `Bildgrößen: ${sizes}`].filter((x): x is string => !!x),
    };
  }

  async read(): Promise<CameraReading> {
    this.resolutions = await this.readCaps();
    return { position: { pan: null, tilt: null, zoom: null, focus: null }, dayNight: null };
  }

  // Türstationen haben keine Objektiv- oder Schwenksteuerung (Fähigkeiten = NO_CAPS, das Modul lehnt Befehle vorher ab)
  async move(): Promise<void> {}
  async stop(): Promise<void> {}
  async zoomStep(): Promise<void> {}
  async focusStep(): Promise<void> {}
  async autofocus(): Promise<void> {}
  async setDayNight(): Promise<void> {}
  async home(): Promise<void> {}
  async goto(): Promise<void> {}

  async openStream(kind: 'live' | 'thumb', resolution: string): Promise<IncomingMessage> {
    const wanted = kind === 'thumb' ? THUMB : (parseResolution(resolution) ?? { width: 640, height: 480 });
    const { width, height } = nearestResolution(wanted, this.resolutions);
    const path = `/api/camera/snapshot?width=${width}&height=${height}&fps=${kind === 'thumb' ? THUMB_FPS : LIVE_FPS}`;
    // Livebild läuft unbegrenzt; Zeitüberschreitung gilt nur, wenn keine Daten mehr kommen
    const res = await this.http.stream('GET', path, undefined, undefined, 15_000);
    const type = String(res.headers['content-type'] ?? '');
    if ((res.statusCode ?? 0) < 300 && !type.includes('json')) return res;
    // Fehler meldet 2N als JSON
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    let reason = `HTTP ${res.statusCode}`;
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ApiReply<unknown>;
      if (data.error) reason = describe(data.error);
    } catch {
      /* kein JSON */
    }
    throw new AxisError(`Videobild abgelehnt (${reason}; Anfrage: ${width}x${height})`, 502);
  }
}
