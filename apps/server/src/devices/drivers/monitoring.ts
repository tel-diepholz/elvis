import type { MonitoringState, MonitoringTargetConfig, MonitoringTargetLive } from '@elvis/shared';
import { probe, type ProbeDeps } from '../../services/monitoring-probes.js';
import { BaseAdapter, command, noParams, type AdapterContext } from '../adapter.js';

/** Ziele aus den Systemeinstellungen (Tabelle monitoring_targets) */
export interface MonitoringSource {
  list(): MonitoringTargetConfig[];
  onChange(listener: () => void): () => void;
  /** Für Tests: SNMP- und HTTP-Zugriff ersetzen */
  readonly probeDeps?: ProbeDeps;
}

/** Erst nach so vielen Fehlversuchen in Folge gilt ein Ziel als nicht erreichbar (ein verlorenes UDP-Paket ist kein Ausfall) */
const FAILURES_UNTIL_DOWN = 2;

/**
 * Monitoring: fragt reihum alle aktiven Ziele ab (SNMP, Node Exporter). Im Zustand stehen je Ziel Erreichbarkeit und
 * bewertete Messwerte; die Meldungen daraus entstehen in alerts.ts. Ist ein Ziel nicht erreichbar, bleiben die letzten
 * Messwerte zur Anzeige stehen.
 */
export class MonitoringAdapter extends BaseAdapter<'monitoring'> {
  private timer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private polling = false;
  private again = false;
  private stopped = false;
  private readonly failures = new Map<string, number>();

  protected readonly commands = {
    refresh: command(noParams, async () => {
      await this.pollAll();
    }),
  };

  constructor(
    private readonly source: MonitoringSource,
    private readonly pollMs: number,
  ) {
    super('monitoring', 'standard', { targets: [] } satisfies MonitoringState);
  }

  isQuiet(action: string): boolean {
    return action === 'refresh';
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    // Ziel angelegt, geändert oder entfernt: sofort neu abfragen
    this.unsubscribe = this.source.onChange(() => void this.pollAll());
    this.timer = setInterval(() => void this.pollAll(), this.pollMs);
    this.timer.unref();
    await this.pollAll();
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
  }

  /** Alle aktiven Ziele abfragen; kommt während eines Laufs eine Änderung, folgt direkt danach ein weiterer */
  async pollAll(): Promise<void> {
    if (this.stopped) return;
    if (this.polling) {
      this.again = true;
      return;
    }
    this.polling = true;
    try {
      do {
        this.again = false;
        await this.pollOnce();
      } while (this.again && !this.stopped);
    } finally {
      this.polling = false;
    }
  }

  private async pollOnce(): Promise<void> {
    const targets = this.source.list().filter((t) => t.enabled);
    const previous = new Map(this.state.targets.map((t) => [t.id, t]));
    const next = await Promise.all(
      targets.map(async (t): Promise<MonitoringTargetLive> => {
        const before = previous.get(t.id);
        const now = new Date().toISOString();
        const base = { id: t.id, name: t.name, kind: t.kind, alwaysOn: t.alwaysOn, checkedAt: now };
        try {
          const r = await probe(t, this.source.probeDeps);
          this.failures.set(t.id, 0);
          return { ...base, reachable: true, error: null, seenAt: now, description: r.description, metrics: r.metrics };
        } catch (err) {
          const failures = (this.failures.get(t.id) ?? 0) + 1;
          this.failures.set(t.id, failures);
          return {
            ...base,
            reachable: failures >= FAILURES_UNTIL_DOWN ? false : (before?.reachable ?? null),
            error: (err as Error).message,
            seenAt: before?.seenAt ?? null,
            description: before?.description ?? null,
            metrics: before?.metrics ?? [],
          };
        }
      }),
    );
    if (this.stopped) return;
    // In der Zwischenzeit entfernte Ziele nicht wieder aufnehmen
    const current = new Set(this.source.list().map((t) => t.id));
    const targetsNext = next.filter((t) => current.has(t.id));
    for (const id of this.failures.keys()) if (!current.has(id)) this.failures.delete(id);
    // checkedAt allein ist keine Änderung, sonst ginge bei jeder Abfrage ein Update an alle Clients
    const key = (list: MonitoringTargetLive[]) => JSON.stringify(list.map(({ checkedAt: _c, ...rest }) => rest));
    if (key(targetsNext) !== key(this.state.targets)) this.update((s) => void (s.targets = targetsNext));
    else this.state = { targets: targetsNext };
  }
}
