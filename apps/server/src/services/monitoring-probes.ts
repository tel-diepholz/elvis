import snmp from 'net-snmp';
import {
  rateValue,
  type MonitoringCheck,
  type MonitoringLimits,
  type MonitoringMetric,
  type MonitoringSeverity,
  type MonitoringTargetConfig,
} from '@elvis/shared';

// --- SNMP ---

export interface SnmpVarbind {
  oid: string;
  /** Zahl, Text (OCTET STRING als Buffer) oder null, wenn das Gerät die OID nicht kennt */
  value: number | Buffer | string | null;
}

export interface SnmpClient {
  get(oids: string[]): Promise<SnmpVarbind[]>;
  walk(oid: string): Promise<SnmpVarbind[]>;
  close(): void;
}

export type SnmpFactory = (t: Pick<MonitoringTargetConfig, 'host' | 'port' | 'snmpVersion' | 'community'>) => SnmpClient;

const toValue = (vb: { type?: number; value?: unknown }): SnmpVarbind['value'] => {
  const v = vb.value;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v)) {
    // Counter64 liefert net-snmp als Buffer (big-endian)
    if (vb.type === snmp.ObjectType.Counter64) return v.length ? Number(BigInt(`0x${v.toString('hex')}`)) : 0;
    return v;
  }
  return null;
};

/** SNMP v1/v2c über net-snmp; je Abfrage eine eigene Sitzung */
export const netSnmp: SnmpFactory = (t) => {
  const session = snmp.createSession(t.host, t.community, {
    port: t.port,
    version: t.snmpVersion === '1' ? snmp.Version1 : snmp.Version2c,
    timeout: 2000,
    retries: 1,
  });
  // Fehler des UDP-Sockets (z. B. Host unbekannt) kommen sonst als unbehandeltes Ereignis
  session.on('error', () => {});
  return {
    get: (oids) =>
      new Promise((resolve, reject) => {
        session.get(oids, (err, varbinds) => {
          if (err) return reject(err);
          resolve((varbinds ?? []).map((vb) => ({ oid: vb.oid, value: snmp.isVarbindError(vb) ? null : toValue(vb) })));
        });
      }),
    walk: (oid) =>
      new Promise((resolve, reject) => {
        const out: SnmpVarbind[] = [];
        const seen = new Set<string>();
        session.subtree(
          oid,
          20,
          (varbinds) => {
            for (const vb of varbinds) {
              // Fehler oder eine OID, die nicht weiterkommt, beenden den Lauf (manche Agenten antworten so statt mit endOfMibView)
              if (snmp.isVarbindError(vb) || seen.has(vb.oid)) return true;
              seen.add(vb.oid);
              out.push({ oid: vb.oid, value: toValue(vb) });
            }
            return false;
          },
          (err) => (err ? reject(err) : resolve(out)),
        );
      }),
    close: () => {
      try {
        session.close();
      } catch {
        // bereits geschlossen
      }
    },
  };
};

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  hrPrinterStatus: '1.3.6.1.2.1.25.3.5.1.1',
  hrPrinterDetectedErrorState: '1.3.6.1.2.1.25.3.5.1.2',
  prtMarkerSuppliesEntry: '1.3.6.1.2.1.43.11.1.1',
};

const text = (v: SnmpVarbind['value']): string => (v === null ? '' : Buffer.isBuffer(v) ? v.toString('utf8').replace(/\0/g, '').trim() : String(v).trim());

const numeric = (v: SnmpVarbind['value']): number | null => {
  if (typeof v === 'number') return v;
  const n = Number.parseFloat(text(v));
  return Number.isFinite(n) ? n : null;
};

const PRINTER_STATUS: Record<number, string> = { 1: 'sonstiger Zustand', 2: 'unbekannt', 3: 'bereit', 4: 'druckt', 5: 'wärmt auf' };

/** hrPrinterDetectedErrorState (RFC 3805), Bits von links nach rechts */
const PRINTER_ERRORS: [string, MonitoringSeverity][] = [
  ['Papier fast leer', 'info'],
  ['kein Papier', 'warn'],
  ['Toner fast leer', 'info'],
  ['kein Toner', 'warn'],
  ['Klappe offen', 'warn'],
  ['Papierstau', 'warn'],
  ['offline', 'warn'],
  ['Wartung erforderlich', 'warn'],
  ['Papierfach fehlt', 'warn'],
  ['Ausgabefach fehlt', 'warn'],
  ['Verbrauchsmaterial fehlt', 'warn'],
  ['Ausgabefach fast voll', 'info'],
  ['Ausgabefach voll', 'warn'],
  ['Papierfach leer', 'warn'],
  ['Wartung überfällig', 'info'],
];

const SEVERITY_RANK: Record<MonitoringSeverity, number> = { ok: 0, info: 1, warn: 2, alarm: 3 };
const worst = (list: MonitoringSeverity[]): MonitoringSeverity => list.reduce<MonitoringSeverity>((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a), 'ok');

export function printerErrors(raw: SnmpVarbind['value']): { severity: MonitoringSeverity; problems: string[] } {
  if (!Buffer.isBuffer(raw)) return { severity: 'ok', problems: [] };
  const found = PRINTER_ERRORS.filter((_, bit) => ((raw[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
  return { severity: worst(found.map(([, s]) => s)), problems: found.map(([p]) => p) };
}

const fmtNum = (v: number, digits = 1) => v.toLocaleString('de-DE', { maximumFractionDigits: digits });

export function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} ${d === 1 ? 'Tag' : 'Tage'} ${h} Std.`;
  if (h > 0) return `${h} Std. ${m} Min.`;
  return `${m} Min.`;
}

const ok = (id: string, label: string, value: number | null, txt: string): MonitoringMetric => ({ id, label, value, text: txt, severity: 'ok', problem: null });

/** Eigene Prüfung bewerten; null = keine Antwort */
function customMetric(c: MonitoringCheck, i: number, raw: number | string | null): MonitoringMetric {
  const id = `check:${i}`;
  if (raw === null) return { id, label: c.label, value: null, text: 'kein Wert', severity: 'warn', problem: 'kein Wert vom Gerät' };
  if (typeof raw === 'string') return ok(id, c.label, null, raw);
  const value = raw * c.scale;
  return { id, label: c.label, value, text: `${fmtNum(value, 2)}${c.unit ? ` ${c.unit}` : ''}`, ...rateValue(value, c) };
}

export interface ProbeResult {
  description: string | null;
  metrics: MonitoringMetric[];
}

async function probeSnmp(t: MonitoringTargetConfig, client: SnmpClient): Promise<ProbeResult> {
  // Erreichbarkeit: die Systemgruppe kennt jedes SNMP-Gerät
  const [descr, uptime, name] = await client.get([OID.sysDescr, OID.sysUpTime, OID.sysName]);
  const description = [text(name?.value ?? null), text(descr?.value ?? null)].filter(Boolean).join(' – ').slice(0, 160) || null;
  const metrics: MonitoringMetric[] = [];
  const ticks = numeric(uptime?.value ?? null);
  if (ticks !== null) metrics.push(ok('uptime', 'Laufzeit', ticks / 100, fmtUptime(ticks / 100)));

  if (t.kind === 'snmp-printer') {
    const [status, errors, supplies] = await Promise.all([client.walk(OID.hrPrinterStatus), client.walk(OID.hrPrinterDetectedErrorState), client.walk(OID.prtMarkerSuppliesEntry)]);
    const st = numeric(status[0]?.value ?? null);
    if (st !== null) metrics.push(ok('status', 'Zustand', st, PRINTER_STATUS[st] ?? `Zustand ${st}`));
    if (errors[0]) {
      const e = printerErrors(errors[0].value);
      metrics.push({ id: 'errors', label: 'Störungen', value: null, text: e.problems.join(', ') || 'keine', severity: e.severity, problem: e.problems.length ? e.problems.join(', ') : null });
    }
    metrics.push(...supplyMetrics(supplies, t.limits));
  }

  for (const [i, c] of t.checks.entries()) {
    // einzeln abfragen: bei SNMPv1 scheitert sonst die ganze Anfrage an einer unbekannten OID
    const vb = await client.get([c.query.replace(/^\./, '')]).catch(() => [] as SnmpVarbind[]);
    const v = vb[0]?.value ?? null;
    metrics.push(customMetric(c, i, v === null ? null : (numeric(v) ?? text(v))));
  }
  return { description, metrics };
}

/** Füllstände aus prtMarkerSuppliesTable (Spalten: 6 Bezeichnung, 8 Kapazität, 9 Füllstand) */
export function supplyMetrics(walked: SnmpVarbind[], limits: MonitoringLimits): MonitoringMetric[] {
  const rows = new Map<string, Record<number, SnmpVarbind['value']>>();
  for (const vb of walked) {
    const rest = vb.oid.replace(/^\./, '').slice(OID.prtMarkerSuppliesEntry.length + 1).split('.');
    const col = Number(rest[0]);
    const index = rest.slice(1).join('.');
    if (!index) continue;
    rows.set(index, { ...rows.get(index), [col]: vb.value });
  }
  return [...rows.entries()].map(([index, r]) => {
    const id = `supply:${index}`;
    const label = text(r[6] ?? null) || `Verbrauchsmaterial ${index}`;
    const max = numeric(r[8] ?? null);
    const level = numeric(r[9] ?? null);
    // -3: „noch etwas vorhanden“, -1/-2: unbekannt
    if (level === -3) return ok(id, label, null, 'vorhanden');
    if (level === null || max === null || level < 0 || max <= 0) return ok(id, label, null, 'unbekannt');
    const pct = Math.max(0, Math.min(100, Math.round((level / max) * 100)));
    if (pct === 0) return { id, label, value: 0, text: '0 %', severity: 'warn', problem: 'leer' };
    if (pct < limits.suppliesWarnPct) return { id, label, value: pct, text: `${pct} %`, severity: 'warn', problem: `unter ${limits.suppliesWarnPct} %` };
    return ok(id, label, pct, `${pct} %`);
  });
}

// --- Prometheus Node Exporter ---

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const LABEL_RE = /([a-zA-Z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c));

function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(LABEL_RE)) out[m[1]!] = unescape(m[2]!);
  return out;
}

/** Textformat von Prometheus (nur Name, Labels, Wert) */
export function parsePrometheus(body: string): PromSample[] {
  const out: PromSample[] = [];
  for (const line of body.split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(\{(?:[^"}]|"(?:[^"\\]|\\.)*")*\})?\s+(\S+)/.exec(l);
    if (!m) continue;
    const value = m[3] === '+Inf' ? Infinity : m[3] === '-Inf' ? -Infinity : Number(m[3]);
    out.push({ name: m[1]!, labels: m[2] ? parseLabels(m[2]) : {}, value });
  }
  return out;
}

/** Selektor wie name{label="wert"}: erster passender Wert */
export function selectSample(samples: PromSample[], selector: string): number | null {
  const m = /^([a-zA-Z_:][\w:]*)(\{.*\})?$/.exec(selector.trim());
  if (!m) return null;
  const want = m[2] ? parseLabels(m[2]) : {};
  const hit = samples.find((s) => s.name === m[1] && Object.entries(want).every(([k, v]) => s.labels[k] === v));
  return hit && Number.isFinite(hit.value) ? hit.value : null;
}

const IGNORED_FS = new Set(['tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'ramfs', 'autofs', 'nsfs', 'proc', 'sysfs', 'efivarfs', 'fuse.lxcfs']);
const IGNORED_MOUNT = /^\/(run|snap|var\/lib\/docker|var\/lib\/containers|sys|proc|dev)(\/|$)/;
const GB = 1024 ** 3;

export function nodeMetrics(samples: PromSample[], limits: MonitoringLimits): ProbeResult {
  const metrics: MonitoringMetric[] = [];
  const first = (name: string) => samples.find((s) => s.name === name)?.value;

  const uname = samples.find((s) => s.name === 'node_uname_info')?.labels;
  const description = uname ? [uname.nodename, uname.sysname && `${uname.sysname} ${uname.release ?? ''}`.trim()].filter(Boolean).join(' – ') : null;

  const load = first('node_load1');
  if (load !== undefined) {
    const cpus = new Set(samples.filter((s) => s.name === 'node_cpu_seconds_total').map((s) => s.labels.cpu)).size || 1;
    const perCore = load / cpus;
    const bad = perCore > limits.loadWarn;
    metrics.push({
      id: 'load',
      label: 'Last je Kern',
      value: perCore,
      text: `${fmtNum(perCore, 2)} (${fmtNum(load, 2)} bei ${cpus} ${cpus === 1 ? 'Kern' : 'Kernen'})`,
      severity: bad ? 'warn' : 'ok',
      problem: bad ? `über ${fmtNum(limits.loadWarn)}` : null,
    });
  }

  const memTotal = first('node_memory_MemTotal_bytes');
  const memAvail = first('node_memory_MemAvailable_bytes');
  if (memTotal && memAvail !== undefined) {
    const pct = (memAvail / memTotal) * 100;
    const bad = pct < limits.memWarnPct;
    metrics.push({
      id: 'memory',
      label: 'Arbeitsspeicher frei',
      value: pct,
      text: `${Math.round(pct)} % (${fmtNum(memAvail / GB)} von ${fmtNum(memTotal / GB)} GB)`,
      severity: bad ? 'warn' : 'ok',
      problem: bad ? `unter ${limits.memWarnPct} %` : null,
    });
  }

  const seen = new Set<string>();
  for (const s of samples.filter((x) => x.name === 'node_filesystem_size_bytes')) {
    const mount = s.labels.mountpoint ?? '';
    if (!mount || seen.has(mount) || IGNORED_FS.has(s.labels.fstype ?? '') || IGNORED_MOUNT.test(mount) || s.value <= 0) continue;
    const avail = samples.find((x) => x.name === 'node_filesystem_avail_bytes' && x.labels.mountpoint === mount && x.labels.device === s.labels.device)?.value;
    if (avail === undefined) continue;
    seen.add(mount);
    const pct = (avail / s.value) * 100;
    const severity: MonitoringSeverity = pct < limits.diskAlarmPct ? 'alarm' : pct < limits.diskWarnPct ? 'warn' : 'ok';
    metrics.push({
      id: `fs:${mount}`,
      label: `Speicher ${mount}`,
      value: pct,
      text: `${Math.round(pct)} % frei (${fmtNum(avail / GB)} von ${fmtNum(s.value / GB)} GB)`,
      severity,
      problem: severity === 'ok' ? null : `unter ${severity === 'alarm' ? limits.diskAlarmPct : limits.diskWarnPct} % frei`,
    });
  }

  const temps = samples.filter((s) => (s.name === 'node_hwmon_temp_celsius' || s.name === 'node_thermal_zone_temp') && Number.isFinite(s.value) && s.value > -50);
  if (temps.length) {
    const max = Math.max(...temps.map((s) => s.value));
    const severity: MonitoringSeverity = max > limits.tempAlarmC ? 'alarm' : max > limits.tempWarnC ? 'warn' : 'ok';
    metrics.push({
      id: 'temp',
      label: 'Höchste Temperatur',
      value: max,
      text: `${fmtNum(max)} °C`,
      severity,
      problem: severity === 'ok' ? null : `über ${severity === 'alarm' ? limits.tempAlarmC : limits.tempWarnC} °C`,
    });
  }

  const boot = first('node_boot_time_seconds');
  const now = first('node_time_seconds');
  if (boot && now) metrics.push(ok('uptime', 'Laufzeit', now - boot, fmtUptime(now - boot)));

  return { description, metrics };
}

export type MonitoringFetch = (url: string) => Promise<{ status: number; body: string }>;

const nodeFetch: MonitoringFetch = async (url) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    // fetch meldet nur „fetch failed“, der eigentliche Grund (z. B. ECONNREFUSED) steckt in cause
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if ((err as Error).name === 'TimeoutError') throw new Error('Keine Antwort (Zeitüberschreitung)');
    throw new Error(cause?.code ? `Keine Verbindung (${cause.code})` : (cause?.message ?? (err as Error).message));
  }
};

async function probeNode(t: MonitoringTargetConfig, http: MonitoringFetch): Promise<ProbeResult> {
  const host = t.host.includes(':') && !t.host.startsWith('[') ? `[${t.host}]` : t.host;
  const res = await http(`http://${host}:${t.port}/metrics`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status} von /metrics`);
  const samples = parsePrometheus(res.body);
  if (!samples.length) throw new Error('Keine Metriken – ist das ein Node Exporter?');
  const result = nodeMetrics(samples, t.limits);
  t.checks.forEach((c, i) => result.metrics.push(customMetric(c, i, selectSample(samples, c.query))));
  return result;
}

export interface ProbeDeps {
  snmp?: SnmpFactory;
  http?: MonitoringFetch;
}

/** Ziel einmal abfragen; wirft, wenn das Gerät nicht antwortet */
export async function probe(t: MonitoringTargetConfig, deps: ProbeDeps = {}): Promise<ProbeResult> {
  if (t.kind === 'node-exporter') return probeNode(t, deps.http ?? nodeFetch);
  const client = (deps.snmp ?? netSnmp)(t);
  try {
    return await probeSnmp(t, client);
  } catch (err) {
    const msg = (err as Error).message;
    throw new Error(/timed? ?out/i.test(msg) ? 'Keine Antwort (SNMP-Zeitüberschreitung – Adresse und Community prüfen)' : msg);
  } finally {
    client.close();
  }
}
