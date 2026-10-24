import { randomBytes } from 'node:crypto';
import {
  MONITORING_DEFAULT_LIMITS,
  monitoringTargetInputSchema,
  type MonitoringCheck,
  type MonitoringKind,
  type MonitoringLimits,
  type MonitoringTargetConfig,
  type MonitoringTargetInput,
  type MonitoringTestResult,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { MonitoringSource } from '../devices/drivers/monitoring.js';
import { HttpError } from '../errors.js';
import { probe, type ProbeDeps } from './monitoring-probes.js';

interface Row {
  id: string;
  name: string;
  kind: MonitoringKind;
  host: string;
  port: number;
  snmp_version: '1' | '2c';
  community: string;
  always_on: number;
  limits: string;
  checks: string;
  enabled: number;
  sort: number;
}

const fromRow = (r: Row): MonitoringTargetConfig => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  host: r.host,
  port: r.port,
  snmpVersion: r.snmp_version,
  community: r.community,
  alwaysOn: !!r.always_on,
  // neue Schwellen späterer Versionen bekommen ihre Vorgabe
  limits: { ...MONITORING_DEFAULT_LIMITS, ...(JSON.parse(r.limits) as Partial<MonitoringLimits>) },
  checks: JSON.parse(r.checks) as MonitoringCheck[],
  enabled: !!r.enabled,
  sort: r.sort,
});

/** Abfrageziele des Monitorings (Tabelle monitoring_targets); abgefragt werden sie vom Modul „Monitoring“ */
export class MonitoringService implements MonitoringSource {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly notify: () => void,
    readonly probeDeps: ProbeDeps = {},
  ) {}

  list(): MonitoringTargetConfig[] {
    return (this.db.prepare('SELECT * FROM monitoring_targets ORDER BY sort, name').all() as Row[]).map(fromRow);
  }

  get(id: string): MonitoringTargetConfig {
    const t = this.list().find((x) => x.id === id);
    if (!t) throw new HttpError(404, `Monitoring-Ziel ${id} nicht gefunden`);
    return t;
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    this.notify();
    this.listeners.forEach((l) => l());
  }

  private validate(input: MonitoringTargetInput, current?: MonitoringTargetConfig): MonitoringTargetConfig {
    const parsed = monitoringTargetInputSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return { id: current?.id ?? `mon-${randomBytes(4).toString('hex')}`, sort: current?.sort ?? this.list().length, ...parsed.data };
  }

  create(input: MonitoringTargetInput): MonitoringTargetConfig {
    const t = this.validate(input);
    this.db
      .prepare(
        `INSERT INTO monitoring_targets (id, name, kind, host, port, snmp_version, community, always_on, limits, checks, enabled, sort, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(t.id, t.name, t.kind, t.host, t.port, t.snmpVersion, t.community, t.alwaysOn ? 1 : 0, JSON.stringify(t.limits), JSON.stringify(t.checks), t.enabled ? 1 : 0, t.sort, new Date().toISOString());
    this.changed();
    return t;
  }

  update(id: string, input: MonitoringTargetInput): MonitoringTargetConfig {
    const t = this.validate(input, this.get(id));
    this.db
      .prepare('UPDATE monitoring_targets SET name = ?, kind = ?, host = ?, port = ?, snmp_version = ?, community = ?, always_on = ?, limits = ?, checks = ?, enabled = ? WHERE id = ?')
      .run(t.name, t.kind, t.host, t.port, t.snmpVersion, t.community, t.alwaysOn ? 1 : 0, JSON.stringify(t.limits), JSON.stringify(t.checks), t.enabled ? 1 : 0, id);
    this.changed();
    return t;
  }

  remove(id: string): MonitoringTargetConfig {
    const t = this.get(id);
    this.db.prepare('DELETE FROM monitoring_targets WHERE id = ?').run(id);
    this.changed();
    return t;
  }

  reorder(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE monitoring_targets SET sort = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, id)))();
    this.changed();
  }

  /** Einmal abfragen, ohne zu speichern */
  async test(input: MonitoringTargetInput): Promise<MonitoringTestResult> {
    const t = this.validate(input);
    try {
      const r = await probe(t, this.probeDeps);
      const problems = r.metrics.filter((m) => m.severity !== 'ok').length;
      const summary = `${r.metrics.length} Messwert(e)${problems ? `, ${problems} mit Auffälligkeit` : ''}`;
      return { ok: true, message: r.description ? `Verbunden: ${r.description} – ${summary}` : `Verbunden – ${summary}`, metrics: r.metrics };
    } catch (err) {
      return { ok: false, message: (err as Error).message, metrics: [] };
    }
  }
}
