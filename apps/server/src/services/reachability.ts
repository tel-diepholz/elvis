import { MESSENGER_IDS, isMobileNumber, phoneKey, type ChatChannel, type ChatReachability, type MessengerId, type Topic } from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { DeviceManager } from '../devices/manager.js';
import { isMessengerAdapter } from '../devices/messaging/bus.js';

export interface ReachabilityDeps {
  devices: Pick<DeviceManager, 'adapter'>;
  /** Rufnummern der Kontakte (phoneKey) */
  contactNumbers: () => string[];
  /** Kanalreihenfolge und verfügbare Kanäle aus den Nachrichten */
  channels: () => { order: ChatChannel[]; available: Set<ChatChannel> };
  notify: (topics: Topic[]) => void;
}

/** Erneut prüfen nach … */
const RECHECK_MS = 7 * 86_400_000;
/** Je Lauf und Messenger höchstens so viele Rufnummern (die Dienste drosseln Massenabfragen) */
const BATCH = 50;
const INTERVAL_MS = 5 * 60_000;

/** Prüfbare Rufnummer: international und lang genug, in Deutschland nur Mobilnummern (Festnetz nutzt kaum Messenger) */
const checkable = (n: string) => /^\+\d{8,}$/.test(n) && (!n.startsWith('+49') || isMobileNumber(n));

/**
 * Welche Rufnummer ist über welchen Messenger erreichbar? Prüft die Rufnummern der Kontakte bei den Messengern, die
 * das können (Signal, Threema, Telegram), und merkt sich das Ergebnis. Dazu zählt, wer schon über einen Messenger
 * geschrieben hat bzw. angeschrieben wurde. SMS: alle Mobilnummern.
 */
export class ReachabilityService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private kickTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly deps: ReachabilityDeps,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.refresh(), INTERVAL_MS);
    setTimeout(() => void this.refresh(), 10_000).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
    this.timer = null;
    this.kickTimer = null;
  }

  /** Nach Änderungen an den Kontakten: in Kürze prüfen (mehrere Änderungen auf einmal) */
  kick(): void {
    if (!this.timer || this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.refresh();
    }, 3000);
  }

  /** Rufnummer → erreichbare Kanäle (nur verfügbare, in der eingestellten Reihenfolge) */
  map(extra: string[] = []): ChatReachability {
    const { order, available } = this.deps.channels();
    const sets = new Map<string, Set<ChatChannel>>();
    const add = (number: string, channel: ChatChannel) => {
      if (!available.has(channel)) return;
      let s = sets.get(number);
      if (!s) sets.set(number, (s = new Set()));
      s.add(channel);
    };
    const numbers = new Set([...this.deps.contactNumbers(), ...extra.map(phoneKey)]);
    for (const n of numbers) if (isMobileNumber(n)) add(n, 'sms');
    for (const r of this.db.prepare('SELECT channel, number FROM chat_reachability WHERE reachable = 1').all() as { channel: ChatChannel; number: string }[]) add(r.number, r.channel);
    // Bekannt aus dem Verlauf (z. B. WhatsApp, das sich nicht prüfen lässt)
    for (const r of this.db.prepare("SELECT DISTINCT channel, number FROM chat_messages WHERE number IS NOT NULL AND channel <> 'sms' AND (folder = 'inbox' OR status IN ('sent', 'delivered', 'read'))").all() as { channel: ChatChannel; number: string }[]) {
      add(r.number, r.channel);
    }
    const out: ChatReachability = {};
    for (const [n, s] of sets) out[n] = order.filter((c) => s.has(c));
    return out;
  }

  /** Rufnummern prüfen, die noch nie oder vor über einer Woche geprüft wurden; `numbers` zusätzlich zu den Kontakten */
  refresh(numbers?: string[]): Promise<void> {
    if (this.running) return this.running.then(() => (numbers ? this.refresh(numbers) : undefined));
    this.running = this.run(numbers).finally(() => (this.running = null));
    return this.running;
  }

  private async run(extra?: string[]): Promise<void> {
    const candidates = extra ? extra.map(phoneKey) : this.deps.contactNumbers();
    const numbers = [...new Set(candidates.filter(checkable))];
    if (!numbers.length) return;
    const since = new Date(Date.now() - RECHECK_MS).toISOString();
    const fresh = this.db.prepare('SELECT 1 FROM chat_reachability WHERE channel = ? AND number = ? AND checked_at > ?');
    const upsert = this.db.prepare(
      'INSERT INTO chat_reachability (channel, number, reachable, peer, checked_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel, number) DO UPDATE SET reachable = excluded.reachable, peer = excluded.peer, checked_at = excluded.checked_at',
    );
    // Frühere Nachrichten, die nur mit der Kennung kamen (z. B. Signal mit verborgener Rufnummer), bekommen die Nummer
    const adopt = this.db.prepare('UPDATE chat_messages SET number = ? WHERE channel = ? AND peer = ? AND number IS NULL');
    let changed = false;
    for (const channel of MESSENGER_IDS) {
      const adapter = this.deps.devices.adapter(channel as MessengerId);
      if (!isMessengerAdapter(adapter) || !adapter.checkReachable) continue;
      const state = adapter.getState();
      if (!state.capabilities.reachability || state.status !== 'connected') continue;
      const todo = numbers.filter((n) => !fresh.get(channel, n, since)).slice(0, BATCH);
      if (!todo.length) continue;
      try {
        const result = await adapter.checkReachable(todo);
        const now = new Date().toISOString();
        this.db.transaction(() => {
          for (const [n, r] of result) {
            upsert.run(channel, phoneKey(n), r.reachable ? 1 : 0, r.peer, now);
            if (r.reachable && r.peer && r.peer !== phoneKey(n)) adopt.run(phoneKey(n), channel, r.peer);
          }
        })();
        changed = true;
      } catch {
        // Beim nächsten Lauf erneut
      }
    }
    if (changed) this.deps.notify(['chat']);
  }
}
