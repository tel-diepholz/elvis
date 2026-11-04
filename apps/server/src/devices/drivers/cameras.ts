import { randomBytes } from 'node:crypto';
import type { PassThrough } from 'node:stream';
import { z } from 'zod';
import { DOORBELL_RING_SECONDS, type CameraCaps, type CameraStatus, type CamerasState, type DoorbellRing } from '@elvis/shared';
import type { CameraSecretConfig } from '../../services/cameras.js';
import { HttpError } from '../../errors.js';
import { BaseAdapter, CommandError, command, type AdapterContext } from '../adapter.js';
import { AxisCamera, DemoCamera, NO_CAPS, type CameraClient } from './axis/camera.js';
import { TwoNIntercom } from './2n/intercom.js';
import { HUB_CONTENT_TYPE, MjpegHub } from './mjpeg-hub.js';

/** Quelle der Kameraliste (Einstellungen) */
export interface CameraSource {
  list(): CameraSecretConfig[];
  onChange(listener: () => void): () => void;
}

export type CameraFactory = (c: CameraSecretConfig) => CameraClient;

export const defaultFactory: CameraFactory = (c) => {
  if (c.type === 'demo') return new DemoCamera();
  const connection = { host: c.host, protocol: c.protocol, username: c.username, password: c.password, verifyTls: c.verifyTls };
  return c.type === '2n' ? new TwoNIntercom(connection) : new AxisCamera(connection);
};

interface Entry {
  config: CameraSecretConfig;
  client: CameraClient;
  status: CameraStatus;
  probed: boolean;
  nextProbe: number;
  moveTimer: NodeJS.Timeout | null;
  busy: boolean;
  /** Beobachtung der Klingeltasten beenden (nur Türstationen) */
  unwatch: (() => void) | null;
}

const POLL_MS = 3_000;
const RETRY_PROBE_MS = 15_000;
/** Ohne erneuten Bewegungsbefehl hält die Kamera nach dieser Zeit an (Bedienung per Gedrückthalten). */
const MOVE_WATCHDOG_MS = 1_200;
/** Mehrfaches Drücken derselben Taste zählt in dieser Zeit als ein Klingeln */
const RING_DEBOUNCE_MS = 10_000;

const speed = z.number().min(-100).max(100);
const cameraId = z.string().min(1);
const step = z.object({ cameraId, direction: z.union([z.literal(1), z.literal(-1)]), big: z.boolean().default(false) });
const positionSchema = z.object({ pan: z.number().nullable(), tilt: z.number().nullable(), zoom: z.number().nullable(), focus: z.number().nullable() });

/** Verbindungsrelevante Einstellungen; ändern sie sich, wird die Kamera neu verbunden. */
const connectionKey = (c: CameraSecretConfig) => JSON.stringify([c.type, c.host, c.protocol, c.username, c.password, c.verifyTls]);

/**
 * Alle Kameras aus den Einstellungen: Status, Fähigkeiten und Bedienung. Der Typ (Axis, Demo) ist je Kamera
 * eingestellt (2N-Türstationen nur mit Bild); weitere Hersteller kommen als weiterer CameraClient dazu.
 */
export class CamerasAdapter extends BaseAdapter<'cameras'> {
  private readonly entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  /** Livebilder je Kamera und Bildart („cam-1:live“): eine Verbindung zur Kamera für alle Zuschauer */
  private readonly hubs = new Map<string, MjpegHub>();
  /** So lange bleibt ein Livebild nach dem letzten Zuschauer verbunden */
  streamLingerMs = 5_000;
  private readonly ringTimers = new Set<NodeJS.Timeout>();

  protected readonly commands = {
    move: command(z.object({ cameraId, pan: speed.default(0), tilt: speed.default(0), zoom: speed.default(0) }), async (p) => {
      const [pan, tilt, zoom] = [p.pan ?? 0, p.tilt ?? 0, p.zoom ?? 0];
      const e = this.require(p.cameraId, pan || tilt ? 'panTilt' : 'continuousZoom');
      await e.client.move(pan, tilt, zoom);
      if (e.moveTimer) clearTimeout(e.moveTimer);
      e.moveTimer = setTimeout(() => void this.halt(e), MOVE_WATCHDOG_MS);
    }),
    stop: command(z.object({ cameraId }), async ({ cameraId }) => {
      await this.halt(this.require(cameraId));
    }),
    zoom: command(step, async ({ cameraId, direction, big }) => {
      const e = this.require(cameraId, 'zoom');
      await e.client.zoomStep(direction, big ?? false);
      this.refreshSoon(e);
    }),
    focus: command(step, async ({ cameraId, direction, big }) => {
      const e = this.require(cameraId, 'focus');
      await e.client.focusStep(direction, big ?? false);
      this.refreshSoon(e);
    }),
    autofocus: command(z.object({ cameraId }), async ({ cameraId }) => {
      const e = this.require(cameraId, 'autofocus');
      await e.client.autofocus();
      this.refreshSoon(e);
      return `${e.config.name}: Autofokus`;
    }),
    daynight: command(z.object({ cameraId, mode: z.enum(['auto', 'day', 'night']) }), async ({ cameraId, mode }) => {
      const e = this.require(cameraId, 'dayNight');
      await e.client.setDayNight(mode);
      this.refreshSoon(e);
      return `${e.config.name}: ${{ auto: 'Tag/Nacht automatisch', day: 'Tagmodus', night: 'Nachtmodus' }[mode]}`;
    }),
    home: command(z.object({ cameraId }), async ({ cameraId }) => {
      const e = this.require(cameraId, 'home');
      await e.client.home();
      this.refreshSoon(e);
      return `${e.config.name}: Grundstellung`;
    }),
    goto: command(z.object({ cameraId, position: positionSchema, label: z.string().max(80).optional() }), async ({ cameraId, position, label }) => {
      const e = this.require(cameraId);
      await e.client.goto(position);
      this.refreshSoon(e);
      return `${e.config.name}: Position ${label ? `„${label}“ ` : ''}angefahren`;
    }),
    refresh: command(z.object({ cameraId }), async ({ cameraId }) => {
      await this.poll(this.require(cameraId));
    }),
  };

  constructor(
    private readonly source: CameraSource,
    private readonly factory: CameraFactory = defaultFactory,
  ) {
    super('cameras', 'cameras', { cameras: [], rings: [] } satisfies CamerasState);
  }

  /** Ablehnungen und Störungen der Kamera als Bedienfehler melden, nicht als internen Fehler */
  override async execute(action: string, params: unknown): Promise<string | void> {
    try {
      return await super.execute(action, params);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new CommandError((err as Error).message, 502);
    }
  }

  /** Häufige Befehle (Bewegung per Gedrückthalten) nicht ins Bedienprotokoll schreiben */
  isQuiet(action: string): boolean {
    return action === 'move' || action === 'stop' || action === 'refresh';
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    this.sync();
    this.unsubscribe = this.source.onChange(() => this.sync());
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), POLL_MS);
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    for (const e of this.entries.values()) this.close(e);
    for (const t of this.ringTimers) clearTimeout(t);
    this.ringTimers.clear();
    for (const h of this.hubs.values()) h.close();
    this.hubs.clear();
  }

  /**
   * MJPEG-Livebild einer Kamera für einen Zuschauer (null = Kamera liefert kein Bild). Alle Zuschauer teilen sich
   * eine Verbindung zur Kamera; der Strom endet, wenn die Kamera trennt – der Browser verbindet dann neu.
   */
  async openStream(cameraId: string, kind: 'live' | 'thumb'): Promise<{ contentType: string; stream: PassThrough } | null> {
    const e = this.entries.get(cameraId);
    if (!e) throw new CommandError(`Kamera ${cameraId} unbekannt oder deaktiviert`, 404);
    const key = `${cameraId}:${kind}`;
    let hub = this.hubs.get(key);
    if (!hub) {
      hub = new MjpegHub(() => e.client.openStream(kind, e.config.resolution), this.streamLingerMs);
      this.hubs.set(key, hub);
    }
    const stream = await hub.subscribe();
    return stream && { contentType: HUB_CONTENT_TYPE, stream };
  }

  /** Livebilder einer Kamera schließen (entfernt, neu verbunden oder Auflösung geändert) */
  private closeStreams(cameraId: string): void {
    for (const [key, hub] of this.hubs) {
      if (!key.startsWith(`${cameraId}:`)) continue;
      hub.close();
      this.hubs.delete(key);
    }
  }

  private require(id: string, cap?: keyof CameraCaps): Entry {
    const e = this.entries.get(id);
    if (!e) throw new CommandError(`Kamera ${id} unbekannt oder deaktiviert`, 404);
    if (!e.status.online) throw new CommandError(`${e.config.name} ist nicht erreichbar`, 503);
    if (cap && !e.status.caps[cap]) throw new CommandError(`${e.config.name} unterstützt das nicht`, 409);
    return e;
  }

  private async halt(e: Entry): Promise<void> {
    if (e.moveTimer) clearTimeout(e.moveTimer);
    e.moveTimer = null;
    await e.client.stop().catch((err: Error) => this.ctx.log.warn(`Kamera ${e.config.name}: Stopp fehlgeschlagen (${err.message})`));
    this.refreshSoon(e);
  }

  /** Nach Befehlen Position zeitnah nachlesen (Motoren brauchen etwas) */
  private refreshSoon(e: Entry): void {
    setTimeout(() => void this.poll(e), 400);
    setTimeout(() => void this.poll(e), 1_500);
  }

  /** Kameraliste abgleichen: neue verbinden, geänderte neu verbinden, entfernte schließen */
  private sync(): void {
    const configs = this.source.list().filter((c) => c.enabled);
    for (const [id, e] of this.entries) {
      const c = configs.find((x) => x.id === id);
      if (!c || connectionKey(c) !== connectionKey(e.config)) {
        this.close(e);
        this.closeStreams(id);
        this.entries.delete(id);
      } else {
        if (c.resolution !== e.config.resolution) this.closeStreams(id);
        e.config = c;
        e.status = { ...e.status, name: c.name };
      }
    }
    for (const c of configs) {
      if (this.entries.has(c.id)) continue;
      this.entries.set(c.id, {
        config: c,
        client: this.factory(c),
        status: { id: c.id, name: c.name, type: c.type, online: false, error: null, model: null, caps: NO_CAPS, position: null, dayNight: null },
        probed: false,
        nextProbe: 0,
        moveTimer: null,
        busy: false,
        unwatch: null,
      });
      const e = this.entries.get(c.id)!;
      this.watch(e);
      void this.poll(e);
    }
    this.publish();
  }

  private close(e: Entry): void {
    if (e.moveTimer) clearTimeout(e.moveTimer);
    e.unwatch?.();
    e.unwatch = null;
  }

  /** Klingeltasten einer Türstation beobachten */
  private watch(e: Entry): void {
    if (!e.client.watchRings || this.stopped) return;
    let lastError: string | null = null;
    e.unwatch = e.client.watchRings(
      (key) => {
        lastError = null;
        if (this.entries.get(e.config.id) === e) this.ring(e, key);
      },
      (msg) => {
        if (msg !== lastError) this.ctx.log.warn(`Türstation ${e.config.name}: Klingel nicht erreichbar (${msg})`);
        lastError = msg;
      },
    );
  }

  /** Taste gedrückt: passende Klingel suchen und für die zugeordneten Bildschirme melden */
  private ring(e: Entry, key: string): void {
    const bell = e.config.bells.find((b) => b.key === key) ?? e.config.bells.find((b) => b.key === '*');
    if (!bell) {
      this.ctx.log.info(`Türstation ${e.config.name}: Taste ${key} gedrückt, keine Klingel eingestellt`);
      return;
    }
    const now = Date.now();
    const recent = this.state.rings.find((r) => r.cameraId === e.config.id && r.key === key && now - Date.parse(r.at) < RING_DEBOUNCE_MS);
    if (recent) return;
    const ring: DoorbellRing = {
      id: randomBytes(6).toString('hex'),
      cameraId: e.config.id,
      cameraName: e.config.name,
      key,
      label: bell.label,
      displays: bell.displays,
      at: new Date(now).toISOString(),
    };
    this.ctx.log.info(`Türstation ${e.config.name}: es klingelt (${bell.label})`);
    // erneutes Klingeln an derselben Taste ersetzt das ältere
    this.update((s) => void (s.rings = [...s.rings.filter((r) => !(r.cameraId === ring.cameraId && r.key === key)), ring]));
    const t = setTimeout(() => {
      this.ringTimers.delete(t);
      if (this.state.rings.some((r) => r.id === ring.id)) this.update((s) => void (s.rings = s.rings.filter((r) => r.id !== ring.id)));
    }, DOORBELL_RING_SECONDS * 1000);
    this.ringTimers.add(t);
  }

  private async pollAll(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => this.poll(e)));
  }

  private async poll(e: Entry): Promise<void> {
    if (this.stopped || e.busy || this.entries.get(e.config.id) !== e) return;
    e.busy = true;
    try {
      if (!e.probed) {
        if (Date.now() < e.nextProbe) return;
        const probe = await e.client.probe();
        e.probed = true;
        e.status = { ...e.status, model: probe.model, caps: probe.caps };
        this.ctx.log.info(`Kamera ${e.config.name} verbunden (${probe.model ?? 'unbekanntes Modell'})`);
      }
      const r = await e.client.read();
      e.status = { ...e.status, online: true, error: null, position: r.position, dayNight: r.dayNight };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== e.status.error) this.ctx.log.warn(`Kamera ${e.config.name}: ${msg}`);
      e.status = { ...e.status, online: false, error: msg };
      e.probed = false;
      e.nextProbe = Date.now() + RETRY_PROBE_MS;
    } finally {
      e.busy = false;
      if (!this.stopped && this.entries.get(e.config.id) === e) this.publish();
    }
  }

  private publish(): void {
    const order = this.source.list().map((c) => c.id);
    const cameras = [...this.entries.values()].map((e) => e.status).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    // Ohne Kameras gilt das Modul als bereit; sonst, solange mindestens eine Kamera antwortet
    const online = cameras.length === 0 || cameras.some((c) => c.online);
    if (JSON.stringify(cameras) !== JSON.stringify(this.state.cameras)) this.update((s) => void (s.cameras = cameras));
    this.setOnline(online);
  }
}
