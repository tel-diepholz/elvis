import {
  DEVICE_IDS,
  type Alert,
  type DeviceId,
  type DeviceModule,
  type DeviceModuleConfig,
  type DeviceSnapshot,
  type DeviceStateMap,
} from '@elvis/shared';
import type { ElvisConfig } from '../config.js';
import { evaluateAlerts } from '../alerts.js';
import { CommandError, type AdapterContext, type DeviceAdapter, type Logger } from './adapter.js';
import { DeviceConfigStore } from './config-store.js';
import { DEVICE_DEFINITIONS, type DriverDefinition, type DriverDeps } from './drivers.js';

type Listener<T> = (value: T) => void;

interface Running {
  adapter: DeviceAdapter;
  unsubscribe: () => void;
}

/**
 * Hält je aktiviertem Fahrzeugmodul einen Treiber. Änderungen aus den Systemeinstellungen werden
 * zur Laufzeit übernommen: alter Treiber stoppen, neuer starten – ohne ELVIS neu zu starten.
 */
export class DeviceManager {
  private readonly running = new Map<DeviceId, Running>();
  private readonly errors = new Map<DeviceId, string>();
  private readonly updatedAt = new Map<DeviceId, string>();
  private alerts: Alert[] = [];
  private alertKey = '';
  private started = false;
  /** Änderungen nacheinander abarbeiten, damit sich Starts und Stopps nicht überholen. */
  private queue: Promise<void> = Promise.resolve();
  private readonly deviceListeners = new Set<Listener<DeviceSnapshot>>();
  private readonly removedListeners = new Set<Listener<DeviceId>>();
  private readonly alertListeners = new Set<Listener<Alert[]>>();
  private readonly ctx: AdapterContext;

  constructor(
    private readonly config: ElvisConfig,
    private readonly log: Logger,
    private readonly configs: DeviceConfigStore = new DeviceConfigStore(null, config.devices),
    private readonly deps: DriverDeps = {
      cameras: { list: () => [], onChange: () => () => {} },
      wifi: { list: () => [], onChange: () => () => {}, storeClients: () => {}, clearClients: () => {} },
      monitoring: { list: () => [], onChange: () => () => {} },
      bluetooth: { list: () => [], onChange: () => () => {} },
    },
  ) {
    this.ctx = {
      log: this.log,
      getState: <K extends DeviceId>(id: K) => this.running.get(id)?.adapter.getState() as DeviceStateMap[K] | undefined,
    };
    for (const id of DEVICE_IDS) this.create(id);
  }

  async start(): Promise<void> {
    this.started = true;
    for (const [id, r] of this.running) await this.startAdapter(id, r.adapter);
    this.recomputeAlerts();
  }

  async stop(): Promise<void> {
    this.started = false;
    await this.queue;
    for (const r of this.running.values()) await r.adapter.stop();
  }

  /** Modul neu konfigurieren (aktivieren, deaktivieren, Treiber oder Einstellungen ändern). */
  configure(id: DeviceId, input: DeviceModuleConfig, actor: string): Promise<DeviceModule> {
    const config = this.configs.set(id, input, actor);
    const job = this.queue.then(async () => {
      const old = this.running.get(id);
      if (old) {
        old.unsubscribe();
        this.running.delete(id);
        await old.adapter.stop().catch((err: Error) => this.log.warn(`Gerät ${id}: Fehler beim Stoppen (${err.message})`));
      }
      this.create(id);
      const next = this.running.get(id);
      if (next && this.started) await this.startAdapter(id, next.adapter);
      if (!next) {
        this.log.info(`Gerät ${id} deaktiviert`);
        for (const l of this.removedListeners) l(id);
      } else {
        this.emit(id);
      }
      this.recomputeAlerts();
    });
    this.queue = job.catch(() => {});
    return job.then(() => this.module(id, config));
  }

  /** Alle Module mit Konfiguration und verfügbaren Treibern (für die Systemeinstellungen). */
  modules(): DeviceModule[] {
    return DEVICE_IDS.map((id) => this.module(id));
  }

  module(id: DeviceId, known?: DeviceModuleConfig): DeviceModule {
    const def = DEVICE_DEFINITIONS[id];
    const { config, source } = known ? { config: known, source: 'settings' as const } : this.configs.get(id);
    const r = this.running.get(id);
    const drivers = def.drivers as Record<string, DriverDefinition<DeviceId>>;
    const passwords = Object.entries(drivers[config.driver]?.options ?? {})
      .filter(([, o]) => o.type === 'password')
      .map(([k]) => k);
    return {
      id,
      name: def.name,
      system: def.system,
      config: { ...config, options: { ...config.options, ...Object.fromEntries(passwords.map((k) => [k, ''])) } },
      secretsSet: passwords.filter((k) => !!config.options[k]),
      source,
      drivers: Object.entries(drivers).map(([driverId, d]) => ({
        id: driverId,
        label: d.label,
        description: d.description,
        options: d.options,
      })),
      online: r ? r.adapter.isOnline() : null,
      error: this.errors.get(id) ?? null,
    };
  }

  snapshot<K extends DeviceId>(id: K): DeviceSnapshot<K> {
    const adapter = this.running.get(id)?.adapter;
    if (!adapter) throw new CommandError(`${DEVICE_DEFINITIONS[id]?.name ?? `Gerät ${id}`} ist nicht aktiviert`, 404);
    const def = DEVICE_DEFINITIONS[id];
    return {
      id,
      name: def.name,
      system: def.system,
      driver: adapter.driver,
      online: adapter.isOnline(),
      updatedAt: this.updatedAt.get(id) ?? new Date().toISOString(),
      state: adapter.getState() as DeviceStateMap[K],
    };
  }

  /** Schnappschüsse der aktivierten Module. */
  snapshots(): DeviceSnapshot[] {
    return DEVICE_IDS.filter((id) => this.running.has(id)).map((id) => this.snapshot(id));
  }

  getAlerts(): Alert[] {
    return this.alerts;
  }

  has(id: string): id is DeviceId {
    return this.running.has(id as DeviceId);
  }

  /** Laufender Treiber eines Moduls (für Sonderzugriffe wie Videoströme); null = deaktiviert */
  adapter<K extends DeviceId>(id: K): DeviceAdapter<K> | null {
    return (this.running.get(id)?.adapter as DeviceAdapter<K> | undefined) ?? null;
  }

  /** Befehl ohne Eintrag im Bedienprotokoll? */
  isQuiet(id: DeviceId, action: string): boolean {
    return this.running.get(id)?.adapter.isQuiet?.(action) ?? false;
  }

  isKnown(id: string): id is DeviceId {
    return (DEVICE_IDS as readonly string[]).includes(id);
  }

  async execute(id: DeviceId, action: string, params: unknown): Promise<string | void> {
    const adapter = this.running.get(id)?.adapter;
    if (!adapter) throw new CommandError(`Unbekanntes Gerät ${id}`, 404);
    if (!adapter.isOnline()) throw new CommandError(`${DEVICE_DEFINITIONS[id].name} ist nicht erreichbar`, 503);
    return adapter.execute(action, params);
  }

  onDevice(l: Listener<DeviceSnapshot>): () => void {
    this.deviceListeners.add(l);
    return () => this.deviceListeners.delete(l);
  }

  /** Modul wurde deaktiviert. */
  onRemoved(l: Listener<DeviceId>): () => void {
    this.removedListeners.add(l);
    return () => this.removedListeners.delete(l);
  }

  onAlerts(l: Listener<Alert[]>): () => void {
    this.alertListeners.add(l);
    return () => this.alertListeners.delete(l);
  }

  /** Treiber gemäß Konfiguration anlegen (noch nicht starten). Fehler werden gemerkt statt geworfen. */
  private create(id: DeviceId): void {
    this.errors.delete(id);
    const { config } = this.configs.get(id);
    if (!config.enabled) return;
    const driver = (DEVICE_DEFINITIONS[id].drivers as Record<string, DriverDefinition<DeviceId>>)[config.driver];
    if (!driver) {
      this.errors.set(id, `Unbekannter Treiber „${config.driver}“`);
      return;
    }
    try {
      const adapter = driver.create(config.options, this.deps);
      this.running.set(id, { adapter, unsubscribe: adapter.onChange(() => this.handleChange(id)) });
    } catch (err) {
      this.errors.set(id, (err as Error).message);
      this.log.error(`Gerät ${id}: Treiber ${config.driver} konnte nicht angelegt werden (${(err as Error).message})`);
    }
  }

  private async startAdapter(id: DeviceId, adapter: DeviceAdapter): Promise<void> {
    try {
      await adapter.start(this.ctx);
      this.updatedAt.set(id, new Date().toISOString());
      this.log.info(`Gerät ${id} gestartet (Treiber: ${adapter.driver})`);
    } catch (err) {
      this.errors.set(id, (err as Error).message);
      this.log.error(`Gerät ${id}: Start fehlgeschlagen (${(err as Error).message})`);
    }
  }

  private emit(id: DeviceId): void {
    const snap = this.snapshot(id);
    for (const l of this.deviceListeners) l(snap);
  }

  private handleChange(id: DeviceId): void {
    if (!this.running.has(id)) return;
    this.updatedAt.set(id, new Date().toISOString());
    this.emit(id);
    this.recomputeAlerts();
  }

  private recomputeAlerts(): void {
    const get = <K extends DeviceId>(id: K) => this.running.get(id)?.adapter.getState() as DeviceStateMap[K] | undefined;
    // Deaktivierte Module melden keinen Ausfall
    const offline = DEVICE_IDS.filter((id) => this.running.has(id) && !this.running.get(id)!.adapter.isOnline());
    const now = new Date().toISOString();
    const previous = new Map(this.alerts.map((a) => [a.id, a]));
    const next = evaluateAlerts(get, offline, this.config.alerts).map((a) => ({
      ...a,
      since: previous.get(a.id)?.since ?? now,
    }));

    const key = JSON.stringify(next.map((a) => [a.id, a.severity, a.title, a.detail]));
    this.alerts = next;
    if (key === this.alertKey) return;
    this.alertKey = key;
    for (const l of this.alertListeners) l(next);
  }
}
