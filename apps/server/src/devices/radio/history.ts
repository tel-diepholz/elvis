import type { DeviceSnapshot, RadioActivity } from '@elvis/shared';

/** So weit reicht die Timeline der Funk-Seite zurück */
export const HISTORY_RETENTION_MS = 12 * 60 * 60_000;
export const HISTORY_MAX = 5000;

interface DeviceSource {
  onDevice(l: (s: DeviceSnapshot) => void): () => void;
}

/**
 * Längerer Verlauf der Funkaktivität für die Timeline. Der Gerätezustand trägt nur die letzten Minuten (er geht bei
 * jeder Änderung an alle Clients); hier sammelt der Server die Einträge über Treiberwechsel hinweg, nur im Speicher.
 */
export class RadioHistory {
  private readonly entries = new Map<string, RadioActivity>();
  private readonly unsubscribe: () => void;

  constructor(devices: DeviceSource) {
    this.unsubscribe = devices.onDevice((snap) => {
      if (snap.id === 'radio') this.add((snap as DeviceSnapshot<'radio'>).state.activity);
    });
  }

  add(list: RadioActivity[]): void {
    // Map behält die Einfügereihenfolge – laufende Einträge werden nur aktualisiert
    for (const a of list) this.entries.set(a.id, a);
    if (this.entries.size > HISTORY_MAX) {
      for (const id of [...this.entries.keys()].slice(0, this.entries.size - HISTORY_MAX)) this.entries.delete(id);
    }
  }

  /** Einträge ab `since` (ISO), älteste zuerst */
  list(since?: string): RadioActivity[] {
    const limit = Math.max(Date.now() - HISTORY_RETENTION_MS, since ? new Date(since).getTime() || 0 : 0);
    for (const [id, a] of this.entries) {
      if (a.end !== null && new Date(a.end).getTime() < Date.now() - HISTORY_RETENTION_MS) this.entries.delete(id);
    }
    return [...this.entries.values()].filter((a) => a.end === null || new Date(a.end).getTime() >= limit).sort((a, b) => a.start.localeCompare(b.start));
  }

  stop(): void {
    this.unsubscribe();
  }
}
