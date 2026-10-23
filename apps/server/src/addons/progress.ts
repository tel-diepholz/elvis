import type { AddonProgressSpec, ScheduleInterval } from '@elvis/shared';

const MARKER = /ELVIS_PROGRESS\s+(\d+(?:\.\d+)?)(?:\s+(.*))?/;
const INLINE = /(\d+(?:\.\d+)?)\s?%/;

export interface ProgressState {
  percent: number | null;
  message: string | null;
}

/**
 * Leitet den Fortschritt eines Job-Schritts aus seinen Logzeilen ab:
 * - eigene Skripte: „ELVIS_PROGRESS 42 Lade thueringen …“
 * - fremde Programme: Phasen per Suchmuster (z. B. „\[osm_pass2“ → ab 35 %), optional verfeinert
 *   durch Prozentangaben in der Zeile.
 * Der Fortschritt steigt nur, Rücksprünge in den Logs werden ignoriert.
 */
export function createProgressParser(spec?: AddonProgressSpec) {
  const phases = (spec?.phases ?? []).map((p) => ({ ...p, re: new RegExp(p.match) })).sort((a, b) => a.percent - b.percent);
  const state: ProgressState = { percent: null, message: null };
  let phase = -1;
  const raise = (p: number) => {
    const v = Math.max(0, Math.min(100, p));
    state.percent = state.percent === null ? v : Math.max(state.percent, v);
  };

  return {
    feed(line: string): void {
      const m = MARKER.exec(line);
      if (m) {
        raise(Number(m[1]));
        if (m[2]?.trim()) state.message = m[2].trim();
        return;
      }
      if (!phases.length) return;
      let matched = -1;
      phases.forEach((p, i) => {
        if (p.re.test(line)) matched = i;
      });
      if (matched >= phase && matched >= 0) {
        phase = matched;
        raise(phases[matched]!.percent);
        if (phases[matched]!.label) state.message = phases[matched]!.label!;
      }
      if (spec?.inlinePercent && phase >= 0 && matched === phase) {
        const pm = INLINE.exec(line);
        if (pm) {
          const start = phases[phase]!.percent;
          const end = phases[phase + 1]?.percent ?? 100;
          raise(start + ((end - start) * Math.min(100, Number(pm[1]))) / 100);
        }
      }
    },
    get state(): ProgressState {
      return { ...state };
    },
  };
}

/** Gewichteter Gesamtfortschritt; laufende Schritte ohne Angabe zählen halb. */
export function overallPercent(steps: { state: string; percent: number | null; weight: number }[]): number | null {
  const total = steps.reduce((a, s) => a + s.weight, 0);
  if (!total) return null;
  let done = 0;
  let known = true;
  for (const s of steps) {
    if (s.state === 'done') done += s.weight;
    else if (s.state === 'running') {
      if (s.percent === null) known = false;
      done += (s.weight * (s.percent ?? 50)) / 100;
    }
  }
  const any = steps.some((s) => s.state !== 'pending');
  return any || known ? Math.round((done / total) * 1000) / 10 : null;
}

const DAYS: Record<Exclude<ScheduleInterval, 'never'>, number> = { daily: 1, weekly: 7, monthly: 30 };

/**
 * Nächster Termin eines Zeitplans: `days` Tage nach dem Tag des letzten Starts zur vollen Stunde `hour`
 * (lokale Zeit). Ohne bisherigen Lauf: nächstes Erreichen der Stunde ab `reference`.
 */
export function nextScheduledRun(interval: ScheduleInterval, hour: number, lastStartedAt: Date | null, reference: Date): Date | null {
  if (interval === 'never') return null;
  const at = (d: Date, addDays: number) => {
    const n = new Date(d);
    n.setHours(hour, 0, 0, 0);
    n.setDate(n.getDate() + addDays);
    return n;
  };
  if (!lastStartedAt) {
    const today = at(reference, 0);
    return today > reference ? today : at(reference, 1);
  }
  return at(lastStartedAt, DAYS[interval]);
}
