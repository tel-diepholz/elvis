import type { HookKind, RelayHook, RelayHookBatch, RelayHookEvent } from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../devices/adapter.js';
import type { HookSource } from '../devices/messaging/bus.js';
import type { RelayClient } from './relay.js';

const CURSOR_KEY = 'app:hooks';
const POLL_MS = 10_000;

/**
 * Webhooks der Messenger über das Cloud-Relay: Meta und Threema rufen das Relay auf, ELVIS holt die Aufrufe hier
 * ausgehend ab (alle 10 s, solange ein Treiber zuhört) und gibt sie an den Treiber. Der Cursor gilt je Zugang zum
 * Relay – meldet sich der ELW neu an, ändern sich auch die Webhook-Adressen.
 */
export class HookService implements HookSource {
  private readonly listeners = new Map<HookKind, Set<(e: RelayHookEvent) => Promise<void>>>();
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly relay: RelayClient,
    private readonly log: Logger,
    private readonly pollMs = POLL_MS,
  ) {}

  get enabled(): boolean {
    return this.relay.enabled;
  }

  async register(kind: HookKind): Promise<RelayHook> {
    return (await this.relay.call('POST', '/v1/elws/me/hooks', { kind })) as RelayHook;
  }

  subscribe(kind: HookKind, fn: (e: RelayHookEvent) => Promise<void>): () => void {
    let set = this.listeners.get(kind);
    if (!set) this.listeners.set(kind, (set = new Set()));
    set.add(fn);
    this.schedule();
    return () => {
      set.delete(fn);
    };
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private active(): boolean {
    return [...this.listeners.values()].some((s) => s.size > 0);
  }

  private schedule(delay = 0): void {
    if (this.timer || !this.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.active()) return;
      this.poll()
        .catch((e) => this.log.warn(`Webhooks: Abruf beim Relay fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => this.schedule(this.pollMs));
    }, delay);
    this.timer.unref?.();
  }

  private cursor(): { elwId: string; after: number } | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(CURSOR_KEY) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as { elwId: string; after: number }) : null;
  }

  private saveCursor(c: { elwId: string; after: number }): void {
    this.db
      .prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'system') ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(CURSOR_KEY, JSON.stringify(c), new Date().toISOString());
  }

  /** Einmal abholen und verteilen (auch für Tests); bis zu fünf Seiten am Stück */
  poll(): Promise<void> {
    this.polling ??= this.run().finally(() => (this.polling = null));
    return this.polling;
  }

  private async run(): Promise<void> {
    const creds = await this.relay.ensureCredentials();
    const saved = this.cursor();
    let after = saved?.elwId === creds.elwId ? saved.after : 0;
    for (let page = 0; page < 5; page++) {
      const batch = (await this.relay.call('GET', `/v1/elws/me/hooks/events?after=${after}`)) as RelayHookBatch;
      for (const e of batch.items) {
        for (const fn of this.listeners.get(e.kind) ?? []) {
          await fn(e).catch((err) => this.log.warn(`Webhooks: Aufruf ${e.kind} #${e.seq} nicht verarbeitet: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
      if (batch.next === after) break;
      after = batch.next;
      this.saveCursor({ elwId: creds.elwId, after });
      if (batch.items.length < 100) break;
    }
    // Bestätigen: beim nächsten Abruf löscht das Relay alles bis zum Cursor
  }
}
