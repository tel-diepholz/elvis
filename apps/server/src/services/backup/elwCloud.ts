import { HttpError } from '../../errors.js';
import type { BackupDriver, StoredBackup, VaultInfo } from './driver.js';

/** fetch für die Backup-Endpunkte des Relays (Tests ersetzen ihn) */
export type BackupFetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;
const PART_TIMEOUT_MS = 5 * 60_000;
const ATTEMPTS = 3;

/**
 * Treiber „einsatzleitwagen.app – Cloud“: Backups über das Cloud-Relay (/v1/backups, siehe elvis-relay) in
 * Cloudflare R2. Angelegt wird der Tresor mit der Anmeldung des ELW beim Relay, danach reicht der Zugang aus dem
 * Wiederherstellungsschlüssel – auch für eine frische Installation.
 */
export class ElwCloudDriver implements BackupDriver {
  private readonly base: string;

  constructor(
    relayUrl: string | null,
    private readonly vaultId: string,
    private readonly vaultToken: string,
    private readonly elwToken: () => Promise<string>,
    private readonly fetchFn: BackupFetch = fetch,
  ) {
    if (!relayUrl) throw new HttpError(503, 'Cloud-Anbindung ist nicht eingerichtet (app.relayUrl in config/elvis.json)');
    this.base = `${relayUrl.replace(/\/$/, '')}/v1/backups/${vaultId}`;
  }

  private async request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.vaultToken}`, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (e) {
      throw new HttpError(502, `Cloud nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 400) {
      const msg = await res
        .json()
        .then((b: { error?: string }) => b.error)
        .catch(() => null);
      throw new HttpError(res.status === 404 ? 404 : res.status === 413 ? 413 : 502, `Cloud: ${msg ?? `HTTP ${res.status}`}`);
    }
    return res;
  }

  private json = async <T>(path: string, init: RequestInit = {}) => (await (await this.request(path, init)).json()) as T;

  async open(create: boolean): Promise<VaultInfo> {
    return this.json<VaultInfo>('', { method: 'PUT', headers: create ? { 'x-elvis-elw': await this.elwToken() } : {} });
  }

  info(): Promise<VaultInfo> {
    return this.json<VaultInfo>('');
  }

  async upload(id: string, meta: string, parts: AsyncIterable<Buffer>): Promise<number> {
    await this.request(`/backups/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ meta }) });
    let n = 0;
    let size = 0;
    try {
      for await (const part of parts) {
        for (let attempt = 1; ; attempt++) {
          try {
            await this.request(`/backups/${id}/parts/${n}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(part), timeoutMs: PART_TIMEOUT_MS });
            break;
          } catch (e) {
            if (attempt >= ATTEMPTS || (e instanceof HttpError && e.statusCode === 413)) throw e;
          }
        }
        n++;
        size += part.length;
      }
      await this.request(`/backups/${id}/complete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parts: n, size }) });
    } catch (e) {
      await this.remove(id).catch(() => undefined);
      throw e;
    }
    return size;
  }

  async *download(backup: StoredBackup): AsyncIterable<Buffer> {
    for (let n = 0; n < backup.parts; n++) {
      const res = await this.request(`/backups/${backup.id}/parts/${n}`, { timeoutMs: PART_TIMEOUT_MS });
      yield Buffer.from(await res.arrayBuffer());
    }
  }

  async remove(id: string): Promise<void> {
    await this.request(`/backups/${id}`, { method: 'DELETE' });
  }
}
