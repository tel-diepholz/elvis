import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  BACKUP_INTERVAL_MS,
  DEFAULT_BACKUP_KEEP,
  normalizeRecoveryKey,
  parseRecoveryKey,
  recoveryKeyCheck,
  type BackupConfirmInput,
  type BackupDriverId,
  type BackupInterval,
  type BackupSettingsInput,
  type BackupSetup,
  type BackupStatus,
  type BackupSummary,
  type Topic,
} from '@elvis/shared';
import { SCHEMA_VERSION, type Db } from '../../db/index.js';
import { HttpError } from '../../errors.js';
import { createArchive } from './archive.js';
import { deriveKeys, encryptStream, generateRecoveryKey, seal, unseal, type BackupKeys } from './crypto.js';
import type { BackupDriver, StoredBackup, VaultInfo } from './driver.js';

export type DriverFactory = (driver: BackupDriverId, keys: BackupKeys) => BackupDriver;

/** Größe der hochgeladenen Teile */
export const PART_BYTES = 8 * 1024 * 1024;
/** Nach einem Fehler spätestens so bald erneut versuchen */
const RETRY_MS = 15 * 60_000;
const TICK_MS = 60_000;
const INFO_MAX_AGE_MS = 60_000;
/** So lange gilt ein angezeigter, noch nicht bestätigter Schlüssel */
const SETUP_TTL_MS = 30 * 60_000;

const CONFIG_KEY = 'backup:config';
const STATE_KEY = 'backup:state';

/** settings backup:config – der Schlüssel selbst wird nicht gespeichert, nur was daraus abgeleitet ist */
interface StoredConfig {
  driver: BackupDriverId;
  vaultId: string;
  vaultToken: string;
  encKey: string;
  interval: BackupInterval;
  keep: number;
}

interface StoredState {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

/** Was in den Metadaten eines Backups steht (verschlüsselt beim Treiber) */
interface BackupMeta {
  vehicle: string;
  elvisVersion: string | null;
  schemaVersion: number;
}

export const elvisVersion = (): string | null => process.env.ELVIS_VERSION ?? null;

/** Stream in gleich große Teile zerlegen (der letzte ist kürzer) */
export async function* inParts(stream: Readable, size = PART_BYTES): AsyncIterable<Buffer> {
  let buf: Buffer[] = [];
  let len = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    buf.push(chunk);
    len += chunk.length;
    while (len >= size) {
      const all = Buffer.concat(buf);
      yield all.subarray(0, size);
      buf = [all.subarray(size)];
      len = all.length - size;
    }
  }
  if (len > 0) yield Buffer.concat(buf);
}

/** Backup-Liste des Treibers mit entschlüsselten Metadaten */
export function summaries(info: VaultInfo, key: Buffer): BackupSummary[] {
  return info.backups.map((b) => {
    const raw = unseal(key, b.meta);
    const meta = raw ? (JSON.parse(raw) as BackupMeta) : null;
    return { id: b.id, createdAt: b.createdAt, size: b.size, vehicle: meta?.vehicle ?? null, elvisVersion: meta?.elvisVersion ?? null, schemaVersion: meta?.schemaVersion ?? null };
  });
}

/**
 * Regelmäßiges Backup (Einstellungen → Backup). Läuft im eingestellten Intervall, höchstens ein Lauf zur Zeit;
 * nach jedem Backup bleiben die neuesten „keep“ Backups beim Treiber.
 */
export class BackupService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private pending: { driver: BackupDriverId; key: string; at: number } | null = null;
  private info: { at: number; value: VaultInfo } | null = null;

  constructor(
    private readonly db: Db,
    private readonly opts: {
      dataDir: string;
      configFile: string | null;
      drivers: DriverFactory;
      vehicle: () => string;
      notify: (topics: Topic[]) => void;
      audit: (message: string, operator: string) => void;
    },
  ) {}

  private read<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private write(key: string, value: unknown, actor = 'system'): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(key, JSON.stringify(value), new Date().toISOString(), actor);
  }

  private config(): StoredConfig | null {
    return this.read<StoredConfig>(CONFIG_KEY);
  }

  private state(): StoredState {
    return this.read<StoredState>(STATE_KEY) ?? { lastRunAt: null, lastSuccessAt: null, lastError: null };
  }

  private driver(c: StoredConfig): BackupDriver {
    return this.opts.drivers(c.driver, { vaultId: c.vaultId, vaultToken: c.vaultToken, encKey: Buffer.from(c.encKey, 'base64') });
  }

  private nextRunAt(c: StoredConfig, s: StoredState): number {
    if (!s.lastRunAt) return Date.now();
    const last = new Date(s.lastRunAt).getTime();
    return last + (s.lastError ? Math.min(RETRY_MS, BACKUP_INTERVAL_MS[c.interval]) : BACKUP_INTERVAL_MS[c.interval]);
  }

  async status(): Promise<BackupStatus> {
    const c = this.config();
    const s = this.state();
    if (c && (!this.info || Date.now() - this.info.at > INFO_MAX_AGE_MS)) {
      try {
        this.info = { at: Date.now(), value: await this.driver(c).info() };
      } catch {
        /* Stand bleibt beim letzten Abruf, der Fehler zeigt sich beim nächsten Backup */
      }
    }
    const info = c ? this.info?.value : undefined;
    return {
      state: c ? 'active' : 'off',
      driver: c?.driver ?? null,
      interval: c?.interval ?? '1h',
      keep: c?.keep ?? DEFAULT_BACKUP_KEEP,
      running: this.running !== null,
      lastRunAt: s.lastRunAt,
      lastSuccessAt: s.lastSuccessAt,
      lastError: s.lastError,
      nextRunAt: c ? new Date(this.nextRunAt(c, s)).toISOString() : null,
      quota: info?.quota ?? null,
      usedBytes: info?.usedBytes ?? null,
      backups: info && c ? summaries(info, Buffer.from(c.encKey, 'base64')) : [],
    };
  }

  /** Schritt 1 der Einrichtung: Schlüssel erzeugen und einmal anzeigen */
  beginSetup(driver: BackupDriverId): BackupSetup {
    if (this.config()) throw new HttpError(409, 'Backup ist bereits eingerichtet');
    const key = generateRecoveryKey();
    this.pending = { driver, key, at: Date.now() };
    return { recoveryKey: key };
  }

  /** Schritt 2: Der Admin hat den Schlüssel notiert und tippt die letzten Gruppen ab */
  async confirmSetup(input: BackupConfirmInput, operator: string): Promise<BackupStatus> {
    const p = this.pending;
    if (!p || Date.now() - p.at > SETUP_TTL_MS) throw new HttpError(409, 'Einrichtung abgelaufen, bitte neu beginnen');
    if (normalizeRecoveryKey(input.check) !== normalizeRecoveryKey(recoveryKeyCheck(p.key))) throw new HttpError(400, 'Die Gruppen stimmen nicht mit dem Schlüssel überein');
    const keys = deriveKeys(parseRecoveryKey(p.key)!);
    const config: StoredConfig = { driver: p.driver, vaultId: keys.vaultId, vaultToken: keys.vaultToken, encKey: keys.encKey.toString('base64'), interval: input.interval, keep: input.keep };
    this.info = { at: Date.now(), value: await this.driver(config).open(true) };
    this.write(CONFIG_KEY, config, operator);
    this.write(STATE_KEY, { lastRunAt: null, lastSuccessAt: null, lastError: null } satisfies StoredState);
    this.pending = null;
    this.opts.audit('Backup eingerichtet', operator);
    this.opts.notify(['backup']);
    void this.run();
    return this.status();
  }

  async update(input: BackupSettingsInput, operator: string): Promise<BackupStatus> {
    const c = this.config();
    if (!c) throw new HttpError(409, 'Backup ist nicht eingerichtet');
    const keep = this.info ? Math.min(input.keep, this.info.value.quota.maxBackups) : input.keep;
    this.write(CONFIG_KEY, { ...c, interval: input.interval, keep }, operator);
    this.opts.audit(`Backup: alle ${input.interval}, ${keep} aufbewahren`, operator);
    this.opts.notify(['backup']);
    return this.status();
  }

  /** Backup abschalten; die Backups beim Treiber bleiben mit dem alten Schlüssel lesbar */
  disable(operator: string): void {
    if (!this.config()) return;
    this.db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(CONFIG_KEY, STATE_KEY);
    this.info = null;
    this.opts.audit('Backup abgeschaltet', operator);
    this.opts.notify(['backup']);
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const c = this.config();
    if (c && !this.running && Date.now() >= this.nextRunAt(c, this.state())) await this.run();
  }

  /** „Jetzt sichern“: im Hintergrund starten (Fehler landen im Status) */
  trigger(): void {
    if (!this.config()) throw new HttpError(409, 'Backup ist nicht eingerichtet');
    void this.run();
  }

  /** Backup jetzt (läuft schon eins, wird darauf gewartet) */
  run(): Promise<void> {
    if (!this.config()) return Promise.reject(new HttpError(409, 'Backup ist nicht eingerichtet'));
    this.running ??= this.backup().finally(() => {
      this.running = null;
      this.opts.notify(['backup']);
    });
    this.opts.notify(['backup']);
    return this.running;
  }

  private async backup(): Promise<void> {
    const c = this.config()!;
    const startedAt = new Date().toISOString();
    const prev = this.state();
    try {
      const driver = this.driver(c);
      const key = Buffer.from(c.encKey, 'base64');
      const meta: BackupMeta = { vehicle: this.opts.vehicle(), elvisVersion: elvisVersion(), schemaVersion: SCHEMA_VERSION };
      const archive = await createArchive({ db: this.db, dataDir: this.opts.dataDir, configFile: this.opts.configFile, meta: { ...meta, createdAt: startedAt } });
      const encrypted = encryptStream(key);
      archive.on('error', (e) => encrypted.destroy(e));
      await driver.upload(randomUUID(), seal(key, JSON.stringify(meta)), inParts(archive.pipe(encrypted)));
      // Aufbewahrung: die neuesten keep behalten
      const info = await driver.info();
      for (const old of info.backups.slice(c.keep) as StoredBackup[]) await driver.remove(old.id);
      this.info = { at: Date.now(), value: info.backups.length > c.keep ? await driver.info() : info };
      this.write(STATE_KEY, { lastRunAt: startedAt, lastSuccessAt: new Date().toISOString(), lastError: null } satisfies StoredState);
    } catch (e) {
      this.write(STATE_KEY, { ...prev, lastRunAt: startedAt, lastError: e instanceof Error ? e.message : String(e) } satisfies StoredState);
    }
  }
}
