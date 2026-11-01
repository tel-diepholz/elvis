import { formatPhone, phoneKey, type CallRecord, type PhoneMatch, type Topic } from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import type { EndedCall, TelephonyBus } from '../devices/telephony/bus.js';

export interface CallLogDeps {
  store: Store;
  bus: TelephonyBus;
  /** Rufnummern der Kontakte (Schlüssel: phoneKey) */
  numbers: () => Map<string, PhoneMatch>;
  /** Name des Trunks laut Telefonie-Modul */
  trunkName: (port: number | null) => string | null;
  /** Eigene Seite im Tagebuch (Fahrzeugname) */
  self: () => string;
  notify: (topics: Topic[]) => void;
}

interface CallRow {
  id: number;
  direction: 'in' | 'out';
  port: number | null;
  number: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string;
  incident_id: number | null;
}

/** „2:05 min“ */
export function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${ss} h` : `${m}:${ss} min`;
}

const durationOf = (answeredAt: string | null, endedAt: string) =>
  answeredAt ? Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(answeredAt).getTime()) / 1000)) : 0;

/** Gegenstelle als Text: „Muster, Max (Mobil) +49 171 1234567“ bzw. nur die Nummer */
export function partyText(number: string, match: PhoneMatch | null): string {
  const n = /^[+\d]/.test(number) ? formatPhone(number) : 'unbekannte Nummer';
  return match ? `${match.name}${match.label ? ` (${match.label})` : ''}, ${n}` : n;
}

/** Tagebuchtext eines Gesprächs */
export function callJournalText(c: EndedCall, party: string, trunk: string | null): string {
  const via = trunk ? ` über ${trunk}` : '';
  const dur = durationOf(c.answeredAt, c.endedAt);
  if (c.direction === 'in') return c.answeredAt ? `Anruf von ${party}${via}, Dauer ${fmtDuration(dur)}` : `Verpasster Anruf von ${party}${via}`;
  return c.answeredAt ? `Anruf an ${party}${via}, Dauer ${fmtDuration(dur)}` : `Anruf an ${party}${via} – nicht erreicht`;
}

/**
 * Anrufliste des GSM-Gateways. Jedes beendete Gespräch wird gespeichert und – solange ein Einsatz läuft – als
 * Eintrag der Kategorie „Telefon“ ins Einsatztagebuch geschrieben (Zeitpunkt = Beginn des Gesprächs).
 */
export class CallLogService {
  constructor(
    private readonly db: Db,
    private readonly deps: CallLogDeps,
  ) {
    deps.bus.onCall((c) => {
      try {
        this.record(c);
      } catch {
        /* ein kaputter Eintrag darf den Treiber nicht stören */
      }
    });
  }

  record(c: EndedCall): CallRecord {
    const incident = this.deps.store.activeIncident();
    const openIncident = incident && !incident.closedAt ? incident : null;
    const info = this.db
      .prepare('INSERT INTO calls (direction, port, number, started_at, answered_at, ended_at, incident_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.direction, c.port, c.number, c.startedAt, c.answeredAt, c.endedAt, openIncident?.id ?? null);
    const topics: Topic[] = ['calls'];
    if (openIncident) {
      const match = this.deps.numbers().get(phoneKey(c.number)) ?? null;
      const party = partyText(c.number, match);
      this.deps.store.addJournal(
        openIncident.id,
        {
          category: 'telefon',
          text: callJournalText(c, party, this.deps.trunkName(c.port)),
          sender: c.direction === 'in' ? party : this.deps.self(),
          recipient: c.direction === 'out' ? party : this.deps.self(),
          timestamp: c.startedAt,
        },
        'Telefonie',
      );
      topics.push('journal');
    }
    this.deps.notify(topics);
    return this.toRecord(this.db.prepare('SELECT * FROM calls WHERE id = ?').get(Number(info.lastInsertRowid)) as CallRow, this.deps.numbers());
  }

  /** Gespräche der letzten Stunden, neueste zuerst */
  list(hours = 24, limit = 300): CallRecord[] {
    const since = new Date(Date.now() - hours * 3600_000).toISOString();
    const rows = this.db.prepare('SELECT * FROM calls WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?').all(since, limit) as CallRow[];
    const numbers = this.deps.numbers();
    return rows.map((r) => this.toRecord(r, numbers));
  }

  /** Anrufliste nicht unbegrenzt aufheben */
  cleanup(days = 90): void {
    this.db.prepare('DELETE FROM calls WHERE started_at < ?').run(new Date(Date.now() - days * 86400_000).toISOString());
  }

  private toRecord(r: CallRow, numbers: Map<string, PhoneMatch>): CallRecord {
    const match = numbers.get(phoneKey(r.number));
    return {
      id: r.id,
      direction: r.direction,
      port: r.port,
      trunk: this.deps.trunkName(r.port),
      number: r.number,
      name: match?.name ?? null,
      startedAt: r.started_at,
      answeredAt: r.answered_at,
      endedAt: r.ended_at,
      durationS: durationOf(r.answered_at, r.ended_at),
      incidentId: r.incident_id,
    };
  }
}
