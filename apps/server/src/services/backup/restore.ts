import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { parseRecoveryKey, type BackupSummary, type RestoreStartInput, type RestoreStatus } from '@elvis/shared';
import { SCHEMA_VERSION } from '../../db/index.js';
import { HttpError } from '../../errors.js';
import { BACKUP_DATA_ITEMS, CONFIG_ENTRY, DB_FILE, extractArchive } from './archive.js';
import { decryptStream, deriveKeys } from './crypto.js';
import type { BackupDriver } from './driver.js';
import { summaries, type DriverFactory } from './service.js';

/**
 * Wiederherstellen bei der Ersteinrichtung (solange es keine Benutzer gibt). Das Backup wird heruntergeladen,
 * entschlüsselt, geprüft und nach <dataDir>/.restore-staging entpackt; ausgetauscht werden die Daten erst beim
 * Neustart (applyPendingRestore), bevor die Datenbank geöffnet ist.
 */

const STAGING = '.restore-staging';
const MARKER = '.restore-pending.json';

const IDLE: RestoreStatus = { state: 'idle', step: null, progress: null, error: null };

export class RestoreService {
  private current: RestoreStatus = IDLE;

  constructor(
    private readonly opts: {
      dataDir: string;
      drivers: DriverFactory;
      hasUsers: () => boolean;
      /** ELVIS neu starten, damit applyPendingRestore greift */
      restart: () => void;
    },
  ) {}

  private guard(): void {
    if (this.opts.hasUsers()) throw new HttpError(409, 'ELVIS ist bereits eingerichtet – Wiederherstellen geht nur bei einer frischen Installation');
  }

  private open(input: Pick<RestoreStartInput, 'driver' | 'recoveryKey'>): { driver: BackupDriver; key: Buffer } {
    const secret = parseRecoveryKey(input.recoveryKey);
    if (!secret) throw new HttpError(400, 'Wiederherstellungsschlüssel ungültig – bitte auf Tippfehler prüfen');
    const keys = deriveKeys(secret);
    return { driver: this.opts.drivers(input.driver, keys), key: keys.encKey };
  }

  status(): RestoreStatus {
    return this.current;
  }

  async list(input: Pick<RestoreStartInput, 'driver' | 'recoveryKey'>): Promise<BackupSummary[]> {
    this.guard();
    const { driver, key } = this.open(input);
    try {
      return summaries(await driver.info(), key);
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 404) throw new HttpError(404, 'Zu diesem Schlüssel gibt es keine Backups');
      throw e;
    }
  }

  async start(input: RestoreStartInput): Promise<RestoreStatus> {
    this.guard();
    if (this.current.state === 'running' || this.current.state === 'restarting') throw new HttpError(409, 'Wiederherstellung läuft bereits');
    const { driver, key } = this.open(input);
    const info = await driver.info();
    const backup = info.backups.find((b) => b.id === input.backupId);
    if (!backup) throw new HttpError(404, 'Backup nicht gefunden');
    const meta = summaries({ ...info, backups: [backup] }, key)[0]!;
    if (meta.schemaVersion !== null && meta.schemaVersion > SCHEMA_VERSION) throw new HttpError(409, 'Das Backup stammt von einer neueren ELVIS-Version – bitte zuerst ELVIS aktualisieren');

    this.current = { state: 'running', step: 'Backup wird heruntergeladen', progress: 0, error: null };
    void (async () => {
      const staging = join(this.opts.dataDir, STAGING);
      try {
        let loaded = 0;
        const self = this;
        const source = Readable.from(
          (async function* () {
            for await (const part of driver.download(backup)) {
              loaded += part.length;
              self.current = { ...self.current, progress: backup.size ? Math.min(1, loaded / backup.size) : null };
              yield part;
            }
          })(),
        );
        const decrypted = decryptStream(key);
        source.on('error', (e) => decrypted.destroy(e));
        const manifest = await extractArchive(source.pipe(decrypted), staging);
        if (manifest.schemaVersion > SCHEMA_VERSION) throw new Error('Das Backup stammt von einer neueren ELVIS-Version – bitte zuerst ELVIS aktualisieren');
        writeFileSync(join(this.opts.dataDir, MARKER), JSON.stringify({ backupId: backup.id, createdAt: manifest.createdAt, vehicle: manifest.vehicle }));
        this.current = { state: 'restarting', step: 'ELVIS startet neu', progress: 1, error: null };
        this.opts.restart();
      } catch (e) {
        rmSync(staging, { recursive: true, force: true });
        this.current = { state: 'error', step: null, progress: null, error: e instanceof Error ? e.message : String(e) };
      }
    })();
    return this.current;
  }
}

/**
 * Beim Start, vor dem Öffnen der Datenbank: vorbereitete Wiederherstellung übernehmen. Die bisherigen Daten
 * wandern nach <dataDir>/.pre-restore-<Zeit> (Caches bleiben, wo sie sind). Liefert true, wenn wiederhergestellt
 * wurde – dann ist auch config/elvis.json neu zu laden.
 */
export function applyPendingRestore(dataDir: string, configFile: string | null, log: (msg: string) => void = console.log): boolean {
  const marker = join(dataDir, MARKER);
  const staging = join(dataDir, STAGING);
  if (!existsSync(marker)) return false;
  if (!existsSync(join(staging, 'data', DB_FILE))) {
    rmSync(marker, { force: true });
    rmSync(staging, { recursive: true, force: true });
    return false;
  }
  const keep = join(dataDir, `.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(keep, { recursive: true });
  for (const item of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, ...BACKUP_DATA_ITEMS]) {
    const p = join(dataDir, item);
    if (existsSync(p)) renameSync(p, join(keep, item));
  }
  for (const item of readdirSync(join(staging, 'data'))) renameSync(join(staging, 'data', item), join(dataDir, item));

  const config = join(staging, CONFIG_ENTRY);
  if (configFile && existsSync(config)) {
    try {
      if (existsSync(configFile)) copyFileSync(configFile, join(keep, 'elvis.json'));
      mkdirSync(dirname(configFile), { recursive: true });
      copyFileSync(config, configFile);
    } catch (e) {
      log(`Wiederherstellung: config/elvis.json nicht übernommen (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  rmSync(staging, { recursive: true, force: true });
  rmSync(marker, { force: true });
  log(`Backup wiederhergestellt, bisherige Daten in ${keep}`);
  return true;
}
