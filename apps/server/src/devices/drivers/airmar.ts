import { z } from 'zod';
import type { GnssInfo, WeatherState } from '@elvis/shared';
import { BaseAdapter, type AdapterContext } from '../adapter.js';
import { ActisenseDecoder, SET_RX_ALL_FRAME, type N2kMessage } from '../n2k/actisense.js';
import { HUMIDITY_SOURCE_OUTSIDE, TEMP_SOURCE_OUTSIDE, decodePgn } from '../n2k/pgns.js';
import { WindStatistics } from '../n2k/wind.js';

export const airmarOptionsSchema = z.object({
  /** Serielle Schnittstelle des Actisense-Gateways, am besten stabil über /dev/serial/by-id/… */
  port: z.string().default('/dev/ttyUSB0'),
  baudRate: z.number().int().default(115200),
  /** Nur Nachrichten dieser NMEA-2000-Adresse auswerten (bei mehreren Sensoren am Bus). */
  sourceAddress: z.number().int().min(0).max(253).nullable().default(null),
  /** Gateway beim Verbinden in „Rx All“ versetzen (alle PGNs weiterleiten). */
  setRxAll: z.boolean().default(true),
});

export type AirmarOptions = z.infer<typeof airmarOptionsSchema>;

/** Minimale Schnittstelle der seriellen Verbindung – in Tests ersetzbar. */
export interface SerialLink {
  on(event: 'data', l: (chunk: Buffer) => void): void;
  on(event: 'close' | 'error', l: (err?: Error) => void): void;
  write(data: Buffer): void;
  close(): void;
}

export type SerialOpener = (path: string, baudRate: number) => Promise<SerialLink>;

export const openSerialPort: SerialOpener = async (path, baudRate) => {
  const { SerialPort } = await import('serialport');
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  await new Promise<void>((resolve, reject) => port.open((err) => (err ? reject(err) : resolve())));
  return port as unknown as SerialLink;
};

const RECONNECT_MS = 5_000;
const STALE_MS = 15_000;
const PUBLISH_MS = 1_000;
/** Wahrer Wind (Nord) hat Vorrang, solange er in diesem Zeitraum gemeldet wurde. */
const TRUE_WIND_VALID_MS = 10_000;
const round = (v: number | null, d = 1) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Airmar-Wetterstation (z. B. 150WX) über NMEA 2000 und ein Actisense-Gateway (NGT-1/NGX-1) per USB.
 * Liefert Wind (Mittel, Böe, Richtung), Temperatur, Luftdruck, ggf. Luftfeuchte sowie GPS-Position und Kurs.
 */
export class AirmarAdapter extends BaseAdapter<'weather'> {
  protected readonly commands = {};
  private readonly options: AirmarOptions;
  private link: SerialLink | null = null;
  private decoder = new ActisenseDecoder((m) => this.handle(m));
  private readonly wind = new WindStatistics();
  private lastData = 0;
  private lastTrueWind = 0;
  private headingTrueDeg: number | null = null;
  private gnss: GnssInfo | null = null;
  private dirty = false;
  private timers: NodeJS.Timeout[] = [];
  private reconnect: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Zuletzt dekodierte PGNs mit Quelle – für die Diagnose in der Oberfläche. */
  readonly seen = new Map<number, { source: number; at: number }>();

  constructor(
    options: Record<string, unknown>,
    private readonly opener: SerialOpener = openSerialPort,
    private readonly now: () => number = Date.now,
  ) {
    super('weather', 'actisense-airmar', {
      position: null,
      windSpeedMs: null,
      windGustMs: null,
      windDirectionDeg: null,
      temperatureC: null,
      humidityPercent: null,
      pressureHpa: null,
      precipitationMmH: null,
      gnss: null,
    } satisfies WeatherState);
    this.options = airmarOptionsSchema.parse(options);
    this.online = false;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    void this.connect();
    this.timers = [
      setInterval(() => this.publish(), PUBLISH_MS),
      setInterval(() => this.watchdog(), 2_000),
    ];
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.link?.close();
    this.link = null;
  }

  private lastRxAll = 0;

  /** Online-Status pflegen; bei längerer Funkstille das Gateway erneut auf „Rx All“ stellen (z. B. nach dessen Neustart). */
  private watchdog(): void {
    const t = this.now();
    const fresh = t - this.lastData < STALE_MS;
    this.setOnline(!!this.link && fresh);
    if (this.link && !fresh && this.options.setRxAll && t - this.lastRxAll >= STALE_MS) {
      this.link.write(SET_RX_ALL_FRAME);
      this.lastRxAll = t;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const link = await this.opener(this.options.port, this.options.baudRate);
      this.link = link;
      this.decoder = new ActisenseDecoder((m) => this.handle(m));
      link.on('data', (chunk) => this.decoder.push(chunk));
      const lost = (err?: Error) => {
        if (this.link !== link) return;
        this.link = null;
        this.setOnline(false);
        this.ctx.log.warn(`Wetterstation: Verbindung zu ${this.options.port} verloren${err ? ` (${err.message})` : ''}`);
        this.scheduleReconnect();
      };
      link.on('close', lost);
      link.on('error', lost);
      if (this.options.setRxAll) {
        link.write(SET_RX_ALL_FRAME);
        this.lastRxAll = this.now();
      }
      this.ctx.log.info(`Wetterstation: ${this.options.port} geöffnet (${this.options.baudRate} Baud)`);
    } catch (err) {
      this.ctx.log.warn(`Wetterstation: ${this.options.port} nicht verfügbar (${(err as Error).message})`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      void this.connect();
    }, RECONNECT_MS);
  }

  /** Eine NMEA-2000-Nachricht auswerten (öffentlich für Tests und Diagnose). */
  handle(m: N2kMessage): void {
    if (this.options.sourceAddress !== null && m.source !== this.options.sourceAddress) return;
    const v = decodePgn(m.pgn, m.data);
    if (!v) return;
    const t = this.now();
    this.lastData = t;
    this.seen.set(m.pgn, { source: m.source, at: t });
    const s = this.state;

    switch (v.pgn) {
      case 130306: {
        if (v.speedMs === null) return;
        if (v.reference === 'true-north') {
          this.lastTrueWind = t;
          this.wind.add(t, v.speedMs, v.angleDeg);
        } else if (v.reference === 'apparent' && t - this.lastTrueWind > TRUE_WIND_VALID_MS) {
          // Scheinbarer Wind ist relativ zur Ausrichtung des Sensors; mit Kurs auf Nord umrechnen
          const dir = v.angleDeg !== null && this.headingTrueDeg !== null ? (this.headingTrueDeg + v.angleDeg) % 360 : null;
          this.wind.add(t, v.speedMs, dir);
        }
        break;
      }
      case 130310:
        this.patch({ temperatureC: v.airTempC ?? s.temperatureC, pressureHpa: v.pressureHpa ?? s.pressureHpa });
        break;
      case 130311:
        this.patch({
          ...(v.tempSource === TEMP_SOURCE_OUTSIDE && v.tempC !== null && { temperatureC: v.tempC }),
          ...(v.humidityPercent !== null && { humidityPercent: v.humidityPercent }),
          ...(v.pressureHpa !== null && { pressureHpa: v.pressureHpa }),
        });
        break;
      case 130312:
        if (v.source === TEMP_SOURCE_OUTSIDE && v.tempC !== null) this.patch({ temperatureC: v.tempC });
        break;
      case 130313:
        if (v.source === HUMIDITY_SOURCE_OUTSIDE && v.humidityPercent !== null) this.patch({ humidityPercent: v.humidityPercent });
        break;
      case 130314:
        if (v.pressureHpa !== null) this.patch({ pressureHpa: v.pressureHpa });
        break;
      case 129025:
        this.patch({ position: { lat: v.lat, lon: v.lon, headingDeg: this.headingTrueDeg, fix: s.position?.fix ?? true } });
        break;
      case 129029: {
        if (v.lat !== null && v.lon !== null) this.patch({ position: { lat: v.lat, lon: v.lon, headingDeg: this.headingTrueDeg, fix: v.fix } });
        else if (s.position) this.patch({ position: { ...s.position, fix: false } });
        const g = this.gnssInfo();
        g.method = v.method;
        g.satellites = v.satellites;
        g.hdop = v.hdop;
        g.altitudeM = v.altitudeM === null ? null : v.altitudeM - (v.geoidSeparationM ?? 0);
        g.time = v.time?.toISOString() ?? null;
        g.clockOffsetS = v.time ? (v.time.getTime() - t) / 1000 : null;
        break;
      }
      case 129026: {
        const g = this.gnssInfo();
        g.speedMs = v.speedMs;
        // magnetischer Kurs nur mit bekannter Missweisung umrechenbar; die Airmar meldet ihn rechtweisend
        g.courseDeg = v.reference === 'true' ? v.courseDeg : null;
        break;
      }
      case 127257: {
        const g = this.gnssInfo();
        g.pitchDeg = v.pitchDeg;
        g.rollDeg = v.rollDeg;
        break;
      }
      case 127250: {
        if (v.headingDeg === null) break;
        const trueHeading = v.reference === 'magnetic' ? (v.headingDeg + (v.variationDeg ?? 0) + 360) % 360 : v.headingDeg;
        this.headingTrueDeg = trueHeading;
        if (s.position) this.patch({ position: { ...s.position, headingDeg: Math.round(trueHeading) } });
        break;
      }
    }
    this.dirty = true;
  }

  private gnssInfo(): GnssInfo {
    this.gnss ??= { method: null, satellites: null, hdop: null, altitudeM: null, speedMs: null, courseDeg: null, pitchDeg: null, rollDeg: null, time: null, clockOffsetS: null };
    return this.gnss;
  }

  private pending: Partial<WeatherState> = {};

  private patch(p: Partial<WeatherState>): void {
    Object.assign(this.pending, p);
  }

  /** Höchstens einmal pro Sekunde veröffentlichen – der Bus liefert Werte mehrmals pro Sekunde. */
  publish(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const w = this.wind.values(this.now());
    const p = this.pending;
    this.pending = {};
    this.update((s) => {
      Object.assign(s, p);
      s.windSpeedMs = round(w.meanMs);
      s.windGustMs = round(w.gustMs);
      s.windDirectionDeg = w.directionDeg === null ? null : Math.round(w.directionDeg) % 360;
      s.temperatureC = round(s.temperatureC);
      s.humidityPercent = s.humidityPercent === null ? null : Math.round(s.humidityPercent);
      s.pressureHpa = round(s.pressureHpa);
      const g = this.gnss;
      s.gnss = g && {
        ...g,
        hdop: round(g.hdop),
        altitudeM: round(g.altitudeM, 0),
        speedMs: round(g.speedMs),
        courseDeg: g.courseDeg === null ? null : Math.round(g.courseDeg) % 360,
        pitchDeg: round(g.pitchDeg),
        rollDeg: round(g.rollDeg),
        clockOffsetS: round(g.clockOffsetS),
      };
      if (s.position) {
        s.position = {
          ...s.position,
          lat: Math.round(s.position.lat * 1e6) / 1e6,
          lon: Math.round(s.position.lon * 1e6) / 1e6,
          headingDeg: s.position.headingDeg === null ? null : Math.round(s.position.headingDeg) % 360,
        };
      }
    });
  }
}
