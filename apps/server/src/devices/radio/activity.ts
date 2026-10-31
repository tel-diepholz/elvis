import type { RadioActivity, RadioActivityKind } from '@elvis/shared';

/**
 * Nur die letzten Minuten stehen im Gerätezustand (geht bei jeder Änderung an alle Clients) – den längeren Verlauf
 * führt RadioHistory (GET /api/devices/radio/activity).
 */
export const ACTIVITY_RETENTION_MS = 3 * 60_000;
export const ACTIVITY_MAX = 80;

let seq = 0;

/**
 * Pflegt die Aktivitätsliste eines Funk-Zustands. Arbeitet direkt auf dem Entwurf aus `update()`,
 * damit Treiber Aktivität und Gerätezustand in einem Schritt ändern.
 */
export const activity = {
  /**
   * Beginnt eine Zeitspanne (tx/rx). Läuft auf dem Gerät schon eine gleicher Art mit derselben Gegenstelle, bleibt sie
   * bestehen; mit anderer Gegenstelle (nächster Sprecher) wird sie beendet und eine neue begonnen.
   */
  begin(
    list: RadioActivity[],
    deviceId: string,
    kind: RadioActivityKind,
    at: Date,
    peer: string | null = null,
    text: string | null = null,
    talkgroup: string | null = null,
  ): void {
    const open = list.find((a) => a.deviceId === deviceId && a.kind === kind && a.end === null);
    if (open && open.peer === peer) return;
    if (open) open.end = at.toISOString();
    list.push({
      talkgroup,
      id: `a${Date.now().toString(36)}${(seq++).toString(36)}`,
      deviceId,
      kind,
      start: at.toISOString(),
      end: null,
      peer,
      text,
    });
  },

  /** Beendet offene Zeitspannen eines Geräts (eine Art oder alle). */
  end(list: RadioActivity[], deviceId: string, at: Date, kind?: RadioActivityKind): void {
    for (const a of list) if (a.deviceId === deviceId && a.end === null && (!kind || a.kind === kind)) a.end = at.toISOString();
  },

  /** Zeitpunkt-Ereignis (SDS, Status, Position …) */
  point(list: RadioActivity[], deviceId: string, kind: RadioActivityKind, at: Date, peer: string | null = null, text: string | null = null): void {
    const iso = at.toISOString();
    list.push({
      id: `a${Date.now().toString(36)}${(seq++).toString(36)}`,
      deviceId,
      kind,
      start: iso,
      end: iso,
      peer,
      text,
    });
  },

  /** Alte Einträge entfernen; offene Spannen bleiben, solange sie laufen. */
  prune(list: RadioActivity[], now: Date): RadioActivity[] {
    const limit = now.getTime() - ACTIVITY_RETENTION_MS;
    let kept = list.filter((a) => a.end === null || new Date(a.end).getTime() >= limit);
    if (kept.length > ACTIVITY_MAX) kept = kept.slice(kept.length - ACTIVITY_MAX);
    return kept;
  },
};
