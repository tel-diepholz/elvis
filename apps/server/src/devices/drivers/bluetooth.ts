import { randomBytes } from 'node:crypto';
import { VICTRON_READOUT_LABELS, type BluetoothDeviceConfig, type BluetoothDeviceLive, type BluetoothNearby, type BluetoothState } from '@elvis/shared';
import { BaseAdapter, command, noParams, type AdapterContext } from '../adapter.js';
import type { BleAdvertisement, BleScanner } from '../bluetooth/bluez.js';
import { VICTRON_COMPANY_ID, VictronKeyError, victronDecrypt, victronEncode, victronPacket, victronParse, victronReadoutType } from '../bluetooth/victron.js';

/** Geräte aus den Systemeinstellungen (Tabelle bluetooth_devices) */
export interface BluetoothSource {
  list(): BluetoothDeviceConfig[];
  onChange(listener: () => void): () => void;
}

export interface BluetoothOptions {
  /** Ohne Empfang so lange gilt ein Gerät als „kein Empfang“ */
  staleMs: number;
  /** Nach einem Fehler des Adapters erneut versuchen nach … */
  retryMs?: number;
  /** Änderungen höchstens so oft an die Oberfläche (Victron sendet etwa jede Sekunde) */
  publishMs?: number;
  now?: () => number;
}

/** Geräte in der Nähe so lange anbieten */
const NEARBY_MS = 5 * 60_000;

interface Live {
  seenAt: number | null;
  rssi: number | null;
  advertisedName: string | null;
  readout: BluetoothDeviceLive['readout'];
  error: string | null;
}

/**
 * Modul „Bluetooth“: liest die Werbepakete der eingetragenen Geräte mit (derzeit Victron Instant Readout) und
 * zeigt die Messwerte. Geräte, die auswertbar senden, aber noch nicht eingetragen sind, erscheinen unter „in der Nähe“.
 * Fällt der Adapter aus, gilt das Modul als nicht erreichbar und versucht es regelmäßig erneut.
 */
export class BluetoothAdapter extends BaseAdapter<'bluetooth'> {
  private readonly live = new Map<string, Live>();
  private readonly nearby = new Map<string, Omit<BluetoothNearby, 'configured' | 'seenAt'> & { seenAt: number }>();
  private configs: BluetoothDeviceConfig[] = [];
  private unsubscribe: (() => void) | null = null;
  private tick: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private dirty = false;
  private stopped = true;
  private startedAt = 0;
  private readonly now: () => number;

  protected readonly commands = {
    /** Liste „in der Nähe“ leeren, z. B. nach dem Eintragen */
    clearNearby: command(noParams, () => {
      this.nearby.clear();
      this.publish();
    }),
  };

  constructor(
    driver: string,
    private readonly source: BluetoothSource,
    private readonly scanner: BleScanner,
    private readonly opts: BluetoothOptions,
  ) {
    super('bluetooth', driver, { adapter: { name: scanner.label, scanning: false, error: null }, devices: [], nearby: [] } satisfies BluetoothState);
    this.now = opts.now ?? Date.now;
    this.online = false;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    this.startedAt = this.now();
    this.configs = this.source.list();
    this.unsubscribe = this.source.onChange(() => {
      this.configs = this.source.list();
      // Geänderte Geräte neu bewerten: alte Werte passen evtl. nicht mehr zu Adresse oder Schlüssel
      for (const id of this.live.keys()) if (!this.configs.some((c) => c.id === id)) this.live.delete(id);
      this.publish();
    });
    this.tick = setInterval(() => (this.dirty ? this.publish() : this.checkStale()), this.opts.publishMs ?? 2_000);
    this.tick.unref();
    this.publish();
    await this.connect();
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    if (this.tick) clearInterval(this.tick);
    if (this.retry) clearTimeout(this.retry);
    this.tick = this.retry = null;
    await this.scanner.stop();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.scanner.start(
        (a) => this.onAdvertisement(a),
        (err) => this.fail(err),
      );
      this.update((s) => void (s.adapter = { name: this.scanner.label, scanning: true, error: null }));
      this.setOnline(true);
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private fail(err: Error): void {
    if (this.stopped) return;
    this.ctx.log.warn(`Bluetooth: ${err.message}`);
    this.update((s) => void (s.adapter = { name: this.scanner.label, scanning: false, error: err.message }));
    this.setOnline(false);
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.scanner.stop().then(() => this.connect());
    }, this.opts.retryMs ?? 15_000);
    this.retry.unref();
  }

  /** Ein Werbepaket auswerten (öffentlich für Tests) */
  onAdvertisement(a: BleAdvertisement): void {
    const data = a.manufacturerData.get(VICTRON_COMPANY_ID);
    const packet = data && victronPacket(data);
    if (!packet) return;
    const now = this.now();
    const configs = this.configs.filter((c) => c.enabled && c.kind === 'victron' && c.address === a.address);
    this.nearby.set(a.address, { address: a.address, kind: 'victron', name: a.name, type: VICTRON_READOUT_LABELS[victronReadoutType(packet.readoutType)], rssi: a.rssi, seenAt: now });
    for (const c of configs) {
      const before = this.live.get(c.id);
      const base = { seenAt: now, rssi: a.rssi, advertisedName: a.name ?? before?.advertisedName ?? null };
      try {
        this.live.set(c.id, { ...base, readout: victronParse(packet.readoutType, victronDecrypt(packet, c.key)), error: null });
      } catch (err) {
        // Werte bleiben stehen, bis der Schlüssel stimmt; „gesehen“ zählt trotzdem
        this.live.set(c.id, { ...base, readout: before?.readout ?? null, error: err instanceof VictronKeyError ? err.message : (err as Error).message });
      }
    }
    this.dirty = true;
  }

  /** Nur veröffentlichen, wenn ein Gerät veraltet bzw. aus „in der Nähe“ herausfällt */
  private checkStale(): void {
    const now = this.now();
    const changed =
      this.state.devices.some((d) => !d.stale && now - (d.seenAt ? Date.parse(d.seenAt) : this.startedAt) > this.opts.staleMs) ||
      this.state.nearby.some((n) => now - Date.parse(n.seenAt) > NEARBY_MS);
    if (changed) this.publish();
  }

  private publish(): void {
    this.dirty = false;
    const now = this.now();
    for (const [address, n] of this.nearby) if (now - n.seenAt > NEARBY_MS) this.nearby.delete(address);
    const configured = new Set(this.configs.map((c) => c.address));
    const devices = this.configs
      .filter((c) => c.enabled)
      .map((c): BluetoothDeviceLive => {
        const l = this.live.get(c.id);
        return {
          id: c.id,
          name: c.name,
          kind: c.kind,
          address: c.address,
          warnBelowV: c.warnBelowV,
          seenAt: l?.seenAt ? new Date(l.seenAt).toISOString() : null,
          // Nie gesehen: erst nach der Wartezeit ab Start, sonst gäbe es bei jedem Start kurz Meldungen
          stale: now - (l?.seenAt ?? this.startedAt) > this.opts.staleMs,
          rssi: l?.rssi ?? null,
          advertisedName: l?.advertisedName ?? null,
          readout: l?.readout ?? null,
          error: l?.error ?? null,
        };
      });
    const nearby = [...this.nearby.values()]
      .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
      .map((n): BluetoothNearby => ({ ...n, seenAt: new Date(n.seenAt).toISOString(), configured: configured.has(n.address) }));
    this.update((s) => {
      s.devices = devices;
      s.nearby = nearby;
    });
  }
}

// --- Simulation ---

/** Zwei Lithium-Batterien und ein SmartShunt, die nicht eingetragen sind, plus Werte für alle eingetragenen Geräte */
export class SimScanner implements BleScanner {
  readonly label = 'Simulation';
  private timer: NodeJS.Timeout | null = null;
  private iv = 0;
  private readonly strangers = [
    { address: 'D8:3B:DA:10:00:01', name: 'Lithium Battery Smart 1', key: randomBytes(16).toString('hex'), type: 'lithium' as const },
    { address: 'D8:3B:DA:10:00:02', name: 'Lithium Battery Smart 2', key: randomBytes(16).toString('hex'), type: 'lithium' as const },
    { address: 'E4:1C:7A:20:00:03', name: 'SmartShunt HQ2231', key: randomBytes(16).toString('hex'), type: 'battery-monitor' as const },
  ];

  constructor(
    private readonly source: BluetoothSource,
    private readonly intervalMs = 2_000,
  ) {}

  async start(onAdvertisement: (a: BleAdvertisement) => void): Promise<void> {
    const send = () => {
      this.iv = (this.iv + 1) % 0x10000;
      const t = Date.now() / 60_000;
      const configured = this.source.list().filter((c) => c.enabled && c.kind === 'victron' && c.key);
      const sims = [
        // Übernommene Geräte senden ab dann mit dem eingetragenen Schlüssel
        ...this.strangers.filter((s) => !configured.some((c) => c.address === s.address)),
        ...configured
          // Simuliert als Lithium-Batterie, mit „Shunt“ oder „BMV“ im Namen als Batteriemonitor
          .map((c) => ({ address: c.address, name: c.name, key: c.key, type: /shunt|bmv/i.test(c.name) ? ('battery-monitor' as const) : ('lithium' as const) })),
      ];
      sims.forEach((s, i) => {
        // Leicht schwankende, plausible Werte
        const cell = 3.3 + 0.02 * Math.sin(t + i);
        const data =
          s.type === 'lithium'
            ? victronEncode({ type: 'lithium', bmsFlags: 0, errorFlags: 0, cells: [cell, cell + 0.01, cell, cell - 0.01], voltageV: Math.round(cell * 400) / 100, balancer: 'balanced', temperatureC: 18 + (i % 3) }, s.key, { iv: this.iv })
            : victronEncode({ type: 'battery-monitor', remainingMin: 900, voltageV: 13.18, currentA: -6.4 + Math.sin(t), consumedAh: -38.5, socPct: 81.3, temperatureC: null, starterVoltageV: null, midpointVoltageV: null, alarms: [] }, s.key, { iv: this.iv });
        onAdvertisement({ address: s.address, name: s.name, rssi: -55 - 6 * i, manufacturerData: new Map([[VICTRON_COMPANY_ID, data]]) });
      });
    };
    send();
    this.timer = setInterval(send, this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
