import WebSocket from 'ws';
import {
  MAX_TRAFFIC_RADIUS_NM,
  isTracked,
  trafficSettingsInputSchema,
  type Aircraft,
  type AircraftSource,
  type MapObject,
  type Ship,
  type TrackedData,
  type TrafficHit,
  type TrafficResult,
  type TrafficSettings,
  type TrafficSettingsInput,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import type { IncidentService } from './incidents.js';

/**
 * Luft- und Schiffsverkehr für die Kartenebenen und verfolgte Kartenobjekte.
 * Flugzeuge: Community-API (adsb.fi, alternativ readsb-v2 wie adsb.lol) mit ADS-B und MLAT. Alle Arbeitsplätze teilen
 * sich gerundete Abfragen; Anfragen laufen gedrosselt nacheinander, nach HTTP 429 pausiert ELVIS.
 * Schiffe: eine Websocket-Verbindung zu aisstream.io, abonniert für das Gebiet um Einsatzort bzw. Fahrzeug.
 * Später können Addons (eigener Empfänger) dieselben Daten liefern.
 */

export interface TrafficOptions {
  /** Basis-URL der Flugzeug-API, null = keine Flugzeuge */
  aircraftUrl: string | null;
  /** Pfadschema: adsb.fi (/v2/lat/…/lon/…/dist/…) oder readsb-v2 wie adsb.lol (/v2/point/…) */
  aircraftApi: 'adsbfi' | 'readsb';
  /** Mindestabstand zwischen Anfragen (Vorgabe 1,1 s; Tests: 0) */
  requestGapMs?: number;
  /** aisstream.io-Websocket, null = keine Schiffe */
  aisUrl: string | null;
  userAgent: string;
}

export type TrafficFetch = (url: string, opts: { timeoutMs: number; userAgent: string }) => Promise<unknown>;

/** Minimale Websocket-Schnittstelle (ws), austauschbar für Tests */
export interface AisSocket {
  /** open, close: ohne Argument; message: Buffer | string; error: Error */
  on(event: 'open' | 'message' | 'close' | 'error', cb: (...args: never[]) => void): void;
  send(data: string): void;
  close(): void;
}
export type AisSocketFactory = (url: string) => AisSocket;

/** HTTP-Fehler mit Wartezeit (Retry-After bzw. x-ratelimit-reset) für die Drosselung */
export class TrafficHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterS: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

const defaultFetch: TrafficFetch = async (url, { timeoutMs, userAgent }) => {
  const res = await fetch(url, { headers: { 'user-agent': userAgent, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const wait = Number(res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset'));
    throw new TrafficHttpError(res.status, Number.isFinite(wait) && wait > 0 ? wait : null);
  }
  return res.json();
};

const defaultSocket: AisSocketFactory = (url) => new WebSocket(url, { perMessageDeflate: true }) as unknown as AisSocket;

const SETTINGS_KEY = 'traffic:settings';
const TIMEOUT_MS = 8_000;
/** Karten fragen alle 10 s; so lange gilt eine Abfrage für alle Arbeitsplätze */
const AREA_CACHE_MS = 8_000;
/** Abstand zwischen zwei Anfragen an den Dienst (adsb.fi: 1/s) */
const REQUEST_GAP_MS = 1_100;
/** Pause nach HTTP 429 ohne Angabe des Dienstes */
const THROTTLE_PAUSE_MS = 30_000;
/** Verfolgte Flugzeuge zuerst aus Gebietsabfragen dieses Alters übernehmen */
const TRACK_FROM_AREA_MS = 15_000;
/** Nach einem Fehler höchstens so lange den letzten Stand zeigen */
const AREA_STALE_MS = 60_000;
const AREA_CACHE_MAX = 40;
const RADIUS_STEPS = [50, 100, MAX_TRAFFIC_RADIUS_NM];
/** Rasterung des Mittelpunkts (Grad) und dafür nötiger Zuschlag zum Radius (NM) */
const GRID_DEG = 0.5;
const GRID_MARGIN_NM = 20;
/** Ältere Positionen werden nicht angezeigt */
const AIRCRAFT_MAX_AGE_S = 60;
const SHIP_MAX_AGE_MS = 20 * 60_000;
/** Abo-Gebiet um das Zentrum (Grad) */
const AIS_BOX_LAT = 1;
const AIS_BOX_LON = 1.5;
/** Neues Abo, wenn sich das Zentrum so weit verschiebt */
const AIS_MOVE_KM = 20;
const AIS_RETRY_MIN_MS = 5_000;
const AIS_RETRY_MAX_MS = 5 * 60_000;
const TRACK_INTERVAL_MS = 10_000;
const AIS_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];

interface ReadsbAircraft {
  hex?: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  squawk?: string;
  category?: string;
  type?: string;
  seen_pos?: number;
}

const text = (v: unknown) => (typeof v === 'string' && v.replace(/@+$/, '').trim() ? v.replace(/@+$/, '').trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function sourceOf(type: string | undefined): AircraftSource {
  if (type === 'mlat') return 'mlat';
  if (type?.startsWith('adsb') || type?.startsWith('adsr')) return 'adsb';
  return 'other';
}

/** readsb-Eintrag → Aircraft; ohne Position oder zu alt → null */
export function toAircraft(a: ReadsbAircraft): Aircraft | null {
  const lat = num(a.lat);
  const lon = num(a.lon);
  if (!a.hex || lat === null || lon === null) return null;
  const seenS = num(a.seen_pos) ?? 0;
  if (seenS > AIRCRAFT_MAX_AGE_S) return null;
  return {
    hex: a.hex.toLowerCase(),
    callsign: text(a.flight),
    registration: text(a.r),
    type: text(a.t),
    lat,
    lon,
    altFt: a.alt_baro === 'ground' ? 0 : num(a.alt_baro),
    onGround: a.alt_baro === 'ground',
    speedKt: num(a.gs),
    track: num(a.track),
    squawk: text(a.squawk),
    category: text(a.category),
    source: sourceOf(a.type),
    seenS,
  };
}

const list = (body: unknown): ReadsbAircraft[] => {
  const b = body as { ac?: ReadsbAircraft[]; aircraft?: ReadsbAircraft[] } | null;
  return b?.ac ?? b?.aircraft ?? [];
};

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

interface StoredSettings {
  aircraft: boolean;
  ships: boolean;
  aisKey: string | null;
}

export class TrafficService {
  private readonly areaCache = new Map<string, { at: number; result: TrafficResult<Aircraft> }>();
  private readonly inflight = new Map<string, Promise<TrafficResult<Aircraft>>>();
  /** Anfragen an die Flugzeug-API laufen nacheinander mit Mindestabstand */
  private requestChain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private pausedUntil = 0;
  private readonly ships = new Map<string, Ship>();
  private socket: AisSocket | null = null;
  /** Erst nach „open“ darf ein Abo gesendet werden; vorher gesetzte Gebiete schickt der open-Handler */
  private socketOpen = false;
  /** Gebiet des laufenden Abos */
  private aisCenter: { lat: number; lon: number } | null = null;
  private aisKey: string | null = null;
  private aisProblem: string | null = null;
  private retryMs = AIS_RETRY_MIN_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private trackTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly opts: TrafficOptions,
    private readonly deps: {
      db: Db;
      store: Store;
      incidents: IncidentService;
      /** Mittelpunkt für das AIS-Abo: Einsatzort, sonst Fahrzeugposition */
      center: () => { lat: number; lon: number } | null;
    },
    private readonly fetchJson: TrafficFetch = defaultFetch,
    private readonly socketFactory: AisSocketFactory = defaultSocket,
  ) {}

  // --- Einstellungen ---

  private stored(): StoredSettings & { updatedAt: string | null; updatedBy: string | null } {
    const r = this.deps.db.prepare('SELECT * FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
    const v = r ? (JSON.parse(r.value) as Partial<StoredSettings>) : {};
    return { aircraft: v.aircraft ?? true, ships: v.ships ?? true, aisKey: v.aisKey ?? null, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
  }

  settings(): TrafficSettings {
    const s = this.stored();
    return { aircraft: s.aircraft, ships: s.ships, aisKeySet: !!s.aisKey, aircraftUrl: this.opts.aircraftUrl, aisUrl: this.opts.aisUrl, updatedAt: s.updatedAt, updatedBy: s.updatedBy };
  }

  setSettings(input: TrafficSettingsInput, actor: string): TrafficSettings {
    const v = trafficSettingsInputSchema.parse(input);
    const before = this.stored();
    const next: StoredSettings = { aircraft: v.aircraft, ships: v.ships, aisKey: v.aisKey === undefined ? before.aisKey : v.aisKey };
    this.deps.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(SETTINGS_KEY, JSON.stringify(next), new Date().toISOString(), actor);
    this.ensureAis();
    return this.settings();
  }

  // --- Flugzeuge ---

  private aircraftProblem(): string | null {
    if (!this.opts.aircraftUrl) return 'Kein Dienst für Flugzeuge konfiguriert';
    if (!this.stored().aircraft) return 'Flugzeuge sind in den Einstellungen abgeschaltet';
    return null;
  }

  private get aircraftSource(): string {
    return this.opts.aircraftUrl ? new URL(this.opts.aircraftUrl).hostname.replace(/^(api|opendata)\./, '') : '';
  }

  private aircraftPath(kind: 'area', q: { lat: number; lon: number; r: number }): string;
  private aircraftPath(kind: 'hex' | 'callsign' | 'reg', q: string): string;
  private aircraftPath(kind: 'area' | 'hex' | 'callsign' | 'reg', q: string | { lat: number; lon: number; r: number }): string {
    const base = `${this.opts.aircraftUrl}/v2`;
    if (typeof q === 'object') return this.opts.aircraftApi === 'adsbfi' ? `${base}/lat/${q.lat}/lon/${q.lon}/dist/${q.r}` : `${base}/point/${q.lat}/${q.lon}/${q.r}`;
    const seg = kind === 'reg' && this.opts.aircraftApi === 'adsbfi' ? 'registration' : kind;
    return `${base}/${seg}/${encodeURIComponent(q)}`;
  }

  /** Gedrosselte Anfrage: nacheinander, mit Mindestabstand; nach HTTP 429 eine Pause ohne Anfragen */
  private request(url: string): Promise<unknown> {
    const job = this.requestChain.then(async () => {
      const now = Date.now();
      if (now < this.pausedUntil) throw new Error(`${this.aircraftSource} drosselt, neuer Versuch in ${Math.ceil((this.pausedUntil - now) / 1000)} s`);
      const wait = this.lastRequestAt + (this.opts.requestGapMs ?? REQUEST_GAP_MS) - now;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequestAt = Date.now();
      try {
        return await this.fetchJson(url, { timeoutMs: TIMEOUT_MS, userAgent: this.opts.userAgent });
      } catch (err) {
        if (err instanceof TrafficHttpError && err.status === 429) this.pausedUntil = Date.now() + (err.retryAfterS ? err.retryAfterS * 1000 : THROTTLE_PAUSE_MS);
        throw err;
      }
    });
    this.requestChain = job.catch(() => {});
    return job;
  }

  /** Alle Flugzeuge im Umkreis; Mittelpunkt und Radius werden gerundet, damit sich Arbeitsplätze eine Abfrage teilen */
  async aircraftNear(lat: number, lon: number, radiusNm: number): Promise<TrafficResult<Aircraft>> {
    const problem = this.aircraftProblem();
    if (problem) return { items: [], source: null, problem };
    const r = RADIUS_STEPS.find((s) => s >= radiusNm + GRID_MARGIN_NM) ?? MAX_TRAFFIC_RADIUS_NM;
    const qLat = Math.round(lat / GRID_DEG) * GRID_DEG;
    const qLon = Math.round(lon / GRID_DEG) * GRID_DEG;
    const key = `${qLat}/${qLon}/${r}`;
    const cached = this.areaCache.get(key);
    if (cached && Date.now() - cached.at < AREA_CACHE_MS) return cached.result;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const job = (async (): Promise<TrafficResult<Aircraft>> => {
      try {
        const body = await this.request(this.aircraftPath('area', { lat: qLat, lon: qLon, r }));
        const items = list(body)
          .map(toAircraft)
          .filter((a): a is Aircraft => !!a);
        const result = { items, source: this.aircraftSource, problem: null };
        this.areaCache.set(key, { at: Date.now(), result });
        if (this.areaCache.size > AREA_CACHE_MAX) this.areaCache.delete(this.areaCache.keys().next().value!);
        return result;
      } catch (err) {
        const e = err as Error;
        const msg = e.message.includes('drosselt') ? e.message : `${this.aircraftSource} nicht erreichbar (${e.message})`;
        if (cached && Date.now() - cached.at < AREA_STALE_MS) return { ...cached.result, problem: msg };
        return { items: [], source: this.aircraftSource, problem: msg };
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async aircraftBy(kind: 'hex' | 'callsign' | 'reg', q: string): Promise<Aircraft[]> {
    const body = await this.request(this.aircraftPath(kind, q));
    return list(body)
      .map(toAircraft)
      .filter((a): a is Aircraft => !!a);
  }

  /** Suche nach ICAO-Adresse, Kennzeichen oder Rufzeichen */
  async searchAircraft(q: string): Promise<Aircraft[]> {
    if (this.aircraftProblem()) return [];
    const query = q.trim();
    if (query.length < 3) return [];
    const jobs = /^~?[0-9a-f]{6}$/i.test(query)
      ? [this.aircraftBy('hex', query.toLowerCase())]
      : query.includes('-')
        ? [this.aircraftBy('reg', query.toUpperCase())]
        : [this.aircraftBy('callsign', query.toUpperCase().replace(/\s+/g, '')), this.aircraftBy('reg', query.toUpperCase())];
    const results = await Promise.allSettled(jobs);
    const seen = new Map<string, Aircraft>();
    for (const r of results) if (r.status === 'fulfilled') for (const a of r.value) seen.set(a.hex, a);
    if (!seen.size && results.every((r) => r.status === 'rejected')) throw new Error(`${this.aircraftSource} nicht erreichbar`);
    return [...seen.values()];
  }

  // --- Schiffe (AIS) ---

  private shipProblem(): string | null {
    if (!this.opts.aisUrl) return 'Kein AIS-Dienst konfiguriert';
    const s = this.stored();
    if (!s.ships) return 'Schiffe sind in den Einstellungen abgeschaltet';
    if (!s.aisKey) return 'Kein aisstream.io-Schlüssel hinterlegt (Einstellungen → Luft- und Schiffsverkehr)';
    if (!this.aisCenter) return 'Kein Einsatz- oder Fahrzeugort für den AIS-Empfang';
    return this.aisProblem;
  }

  private pruneShips(): void {
    const min = Date.now() - SHIP_MAX_AGE_MS;
    for (const [mmsi, s] of this.ships) if (Date.parse(s.seenAt) < min) this.ships.delete(mmsi);
  }

  shipsIn(box: { south: number; west: number; north: number; east: number }): TrafficResult<Ship> {
    this.ensureAis();
    const problem = this.shipProblem();
    if (problem && !this.ships.size) return { items: [], source: null, problem };
    this.pruneShips();
    const items = [...this.ships.values()].filter((s) => s.lat >= box.south && s.lat <= box.north && s.lon >= box.west && s.lon <= box.east);
    return { items, source: 'aisstream.io', problem };
  }

  searchShips(q: string): Ship[] {
    const query = q.trim().toLowerCase();
    if (query.length < 3) return [];
    this.pruneShips();
    return [...this.ships.values()].filter((s) => s.mmsi.startsWith(query) || s.name?.toLowerCase().includes(query) || s.callsign?.toLowerCase() === query).slice(0, 20);
  }

  /** Verbindung aufbauen, Gebiet nachführen oder schließen – je nach Einstellungen und Lage */
  ensureAis(): void {
    if (this.stopped) return;
    const s = this.stored();
    const center = this.deps.center();
    const wanted = !!this.opts.aisUrl && s.ships && !!s.aisKey && !!center;
    if (!wanted) {
      this.closeAis();
      this.aisCenter = center;
      return;
    }
    if (this.socket && this.aisKey === s.aisKey) {
      if (this.aisCenter && distanceKm(this.aisCenter, center!) < AIS_MOVE_KM) return;
      this.aisCenter = center;
      this.subscribe();
      return;
    }
    this.closeAis();
    this.aisKey = s.aisKey;
    this.aisCenter = center;
    this.connect();
  }

  private subscribe(): void {
    if (!this.socket || !this.socketOpen) return;
    const c = this.aisCenter!;
    const r = (v: number) => Math.round(v * 1e4) / 1e4;
    this.socket?.send(
      JSON.stringify({
        APIKey: this.aisKey,
        BoundingBoxes: [
          [
            [r(c.lat - AIS_BOX_LAT), r(c.lon - AIS_BOX_LON)],
            [r(c.lat + AIS_BOX_LAT), r(c.lon + AIS_BOX_LON)],
          ],
        ],
        FilterMessageTypes: AIS_TYPES,
      }),
    );
  }

  private connect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    let socket: AisSocket;
    try {
      socket = this.socketFactory(this.opts.aisUrl!);
    } catch (err) {
      this.aisProblem = `aisstream.io nicht erreichbar (${(err as Error).message})`;
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    this.socketOpen = false;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.socketOpen = true;
      this.subscribe();
    });
    socket.on('message', (raw: Buffer | string) => {
      if (this.socket !== socket) return;
      this.retryMs = AIS_RETRY_MIN_MS;
      this.aisProblem = null;
      this.handleAis(typeof raw === 'string' ? raw : raw.toString('utf8'));
    });
    socket.on('error', (err: Error) => {
      if (this.socket === socket) this.aisProblem = `aisstream.io: ${err.message}`;
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.aisProblem ??= 'Verbindung zu aisstream.io getrennt';
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.aisKey = null; // erzwingt neuen Aufbau
      this.ensureAis();
    }, this.retryMs);
    this.retryTimer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, AIS_RETRY_MAX_MS);
  }

  private closeAis(): void {
    const s = this.socket;
    this.socket = null;
    this.aisKey = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    s?.close();
  }

  /** Eine Nachricht von aisstream.io einarbeiten (Position und Stammdaten je MMSI zusammenführen) */
  handleAis(raw: string): void {
    let m: { error?: string; MessageType?: string; MetaData?: Record<string, unknown>; Message?: Record<string, Record<string, unknown>> };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.error) {
      this.aisProblem = `aisstream.io: ${m.error}`;
      return;
    }
    const meta = m.MetaData ?? {};
    const body = m.Message?.[m.MessageType ?? ''] ?? {};
    const mmsi = String(meta.MMSI ?? body.UserID ?? '');
    if (!/^\d{9}$/.test(mmsi)) return;
    const prev = this.ships.get(mmsi);
    const at = new Date().toISOString();
    const base: Ship = prev ?? { mmsi, name: null, callsign: null, shipType: null, lat: 0, lon: 0, sogKn: null, cog: null, heading: null, navStatus: null, destination: null, seenAt: at };
    const name = text(meta.ShipName) ?? base.name;
    switch (m.MessageType) {
      case 'PositionReport':
      case 'StandardClassBPositionReport':
      case 'ExtendedClassBPositionReport': {
        const lat = num(body.Latitude) ?? num(meta.latitude);
        const lon = num(body.Longitude) ?? num(meta.longitude);
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
        const sog = num(body.Sog);
        const cog = num(body.Cog);
        const heading = num(body.TrueHeading);
        this.ships.set(mmsi, {
          ...base,
          name,
          lat,
          lon,
          sogKn: sog !== null && sog < 102.3 ? sog : null,
          cog: cog !== null && cog < 360 ? cog : null,
          heading: heading !== null && heading < 360 ? heading : null,
          navStatus: num(body.NavigationalStatus) ?? base.navStatus,
          seenAt: at,
        });
        return;
      }
      case 'ShipStaticData': {
        if (!prev) return; // Stammdaten ohne Position zeigen wir nicht
        this.ships.set(mmsi, { ...prev, name: text(body.Name) ?? name, callsign: text(body.CallSign) ?? prev.callsign, shipType: num(body.Type) ?? prev.shipType, destination: text(body.Destination) ?? prev.destination });
        return;
      }
      case 'StaticDataReport': {
        if (!prev) return;
        const a = (body.ReportA ?? {}) as Record<string, unknown>;
        const b = (body.ReportB ?? {}) as Record<string, unknown>;
        this.ships.set(mmsi, { ...prev, name: text(a.Name) ?? name, callsign: text(b.CallSign) ?? prev.callsign, shipType: num(b.ShipType) ?? prev.shipType });
        return;
      }
    }
  }

  // --- Suche ---

  async search(q: string): Promise<TrafficResult<TrafficHit>> {
    const ships: TrafficHit[] = this.searchShips(q).map((s) => ({ kind: 'ship', ...s }));
    try {
      const aircraft: TrafficHit[] = (await this.searchAircraft(q)).map((a) => ({ kind: 'aircraft', ...a }));
      return { items: [...aircraft, ...ships], source: null, problem: null };
    } catch (err) {
      return { items: ships, source: null, problem: (err as Error).message };
    }
  }

  // --- Verfolgung ---

  /** Verfolgte Objekte des laufenden Einsatzes nachführen (alle 10 s) */
  async track(): Promise<void> {
    this.ensureAis();
    const incident = this.deps.store.activeIncident();
    if (!incident) return;
    const tracked = this.deps.store.mapObjects(incident.id).filter((o): o is Extract<MapObject, { kind: 'aircraft' | 'ship' }> => isTracked(o.kind));
    for (const o of tracked) {
      const id = (o.data as TrackedData).id;
      if (o.kind === 'ship') {
        const s = this.ships.get(id);
        this.deps.incidents.trackMapObject(o.id, s ? { lat: s.lat, lon: s.lon, at: s.seenAt, altFt: null, onGround: false, speedKt: s.sogKn, track: s.cog ?? s.heading } : null);
        continue;
      }
      if (this.aircraftProblem()) continue;
      // Erst in frischen Gebietsabfragen suchen (spart Anfragen), sonst einzeln nachfragen. Ist der Dienst nicht
      // erreichbar, bleibt der Stand; nach TRACK_LOST_MS gilt das Ziel als verloren.
      const a =
        this.fromAreaCache(id) ??
        (await this.aircraftBy('hex', id).then(
          (l) => l[0],
          () => undefined,
        ));
      if (!a) {
        this.deps.incidents.trackMapObject(o.id, null);
        continue;
      }
      const at = new Date(Date.now() - a.seenS * 1000).toISOString();
      this.deps.incidents.trackMapObject(o.id, { lat: a.lat, lon: a.lon, at, altFt: a.altFt, onGround: a.onGround, speedKt: a.speedKt, track: a.track });
    }
  }

  private fromAreaCache(hex: string): Aircraft | undefined {
    let best: { at: number; a: Aircraft } | undefined;
    for (const { at, result } of this.areaCache.values()) {
      if (Date.now() - at > TRACK_FROM_AREA_MS || (best && best.at >= at)) continue;
      const a = result.items.find((x) => x.hex === hex);
      if (a) best = { at, a: { ...a, seenS: a.seenS + (Date.now() - at) / 1000 } };
    }
    return best?.a;
  }

  start(): void {
    this.stopped = false;
    const tick = () => void this.track().catch(() => {});
    tick();
    this.trackTimer = setInterval(tick, TRACK_INTERVAL_MS);
    this.trackTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.trackTimer) clearInterval(this.trackTimer);
    this.trackTimer = null;
    this.closeAis();
  }
}
