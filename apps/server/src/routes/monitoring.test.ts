import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MONITORING_DEFAULT_LIMITS, type MonitoringTargetConfig, type MonitoringTargetInput, type MonitoringTestResult } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import type { MonitoringAdapter } from '../devices/drivers/monitoring.js';
import { nodeMetrics, parsePrometheus, printerErrors, selectSample, supplyMetrics, type SnmpFactory, type SnmpVarbind } from '../services/monitoring-probes.js';
import { adminCookie } from '../test-helpers.js';

/** SNMP-Drucker im Speicher: OID → Wert; walk liefert alle OIDs unterhalb */
function fakeSnmp() {
  const supplies = '1.3.6.1.2.1.43.11.1.1';
  const dev = {
    reachable: true,
    oids: new Map<string, SnmpVarbind['value']>([
      ['1.3.6.1.2.1.1.1.0', Buffer.from('HP LaserJet M404')],
      ['1.3.6.1.2.1.1.3.0', 360000],
      ['1.3.6.1.2.1.1.5.0', Buffer.from('drucker-elw')],
      ['1.3.6.1.2.1.25.3.5.1.1.1', 3],
      ['1.3.6.1.2.1.25.3.5.1.2.1', Buffer.from([0x00])],
      [`${supplies}.6.1.1`, Buffer.from('Black Toner')],
      [`${supplies}.8.1.1`, 10000],
      [`${supplies}.9.1.1`, 4200],
      [`${supplies}.6.1.2`, Buffer.from('Trommel')],
      [`${supplies}.8.1.2`, -2],
      [`${supplies}.9.1.2`, -3],
      ['1.3.6.1.4.1.99.1.0', 412],
    ]),
  };
  const factory: SnmpFactory = (t) => ({
    get: async (oids) => {
      if (!dev.reachable || t.community !== 'public') throw new Error('Request timed out');
      return oids.map((oid) => ({ oid, value: dev.oids.get(oid) ?? null }));
    },
    walk: async (base) => {
      if (!dev.reachable) throw new Error('Request timed out');
      return [...dev.oids].filter(([oid]) => oid.startsWith(`${base}.`)).map(([oid, value]) => ({ oid, value }));
    },
    close: () => {},
  });
  return Object.assign(dev, { factory });
}

const NODE_METRICS = `# HELP node_load1 1m load average.
# TYPE node_load1 gauge
node_load1 1.5
node_cpu_seconds_total{cpu="0",mode="idle"} 100
node_cpu_seconds_total{cpu="0",mode="user"} 10
node_cpu_seconds_total{cpu="1",mode="idle"} 100
node_memory_MemTotal_bytes 8.589934592e+09
node_memory_MemAvailable_bytes 4.294967296e+09
node_filesystem_size_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"} 1e+11
node_filesystem_avail_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"} 4e+09
node_filesystem_size_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/run"} 1e+09
node_filesystem_avail_bytes{device="tmpfs",fstype="tmpfs",mountpoint="/run"} 1e+06
node_hwmon_temp_celsius{chip="platform_coretemp_0",sensor="temp1"} 55
node_uname_info{nodename="elw-server",release="6.8.0",sysname="Linux"} 1
node_boot_time_seconds 1.7e+09
node_time_seconds 1.7000936e+09
node_textfile_scrape_error{job="a \\"b\\", c"} 0
`;

let app: App;
let dataDir: string;
let admin = '';
let snmp: ReturnType<typeof fakeSnmp>;
let nodeBody = NODE_METRICS;
let nodeUp = true;

async function req<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const PRINTER: MonitoringTargetInput = {
  name: 'Drucker Heck',
  kind: 'snmp-printer',
  host: '192.168.1.20',
  port: 161,
  snmpVersion: '2c',
  community: 'public',
  alwaysOn: false,
  limits: MONITORING_DEFAULT_LIMITS,
  checks: [],
  enabled: true,
};
const SERVER: MonitoringTargetInput = { ...PRINTER, name: 'ELW-Server', kind: 'node-exporter', host: '192.168.1.5', port: 9100, community: '', alwaysOn: true };

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-monitoring-'));
  snmp = fakeSnmp();
  nodeBody = NODE_METRICS;
  nodeUp = true;
  app = await buildApp(parseConfig({ dataDir }), {
    logger: false,
    monitoringProbes: {
      snmp: (t) => snmp.factory(t),
      http: async (url) => {
        if (!nodeUp) throw new Error('connect ECONNREFUSED');
        return url === 'http://192.168.1.5:9100/metrics' ? { status: 200, body: nodeBody } : { status: 404, body: '' };
      },
    },
  });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const adapter = () => app.devices.adapter('monitoring') as MonitoringAdapter;
const monitoringAlerts = () => app.devices.getAlerts().filter((a) => a.id.startsWith('monitoring:'));

describe('Monitoring: Auswertung', () => {
  it('liest das Prometheus-Textformat samt Labels mit Anführungszeichen', () => {
    const samples = parsePrometheus(NODE_METRICS);
    expect(samples.find((s) => s.name === 'node_textfile_scrape_error')!.labels).toEqual({ job: 'a "b", c' });
    expect(selectSample(samples, 'node_filesystem_avail_bytes{mountpoint="/"}')).toBe(4e9);
    expect(selectSample(samples, 'node_load1')).toBe(1.5);
    expect(selectSample(samples, 'node_load1{x="y"}')).toBeNull();
  });

  it('bewertet Last, Speicher, Dateisysteme und Temperatur', () => {
    const { description, metrics } = nodeMetrics(parsePrometheus(NODE_METRICS), MONITORING_DEFAULT_LIMITS);
    expect(description).toBe('elw-server – Linux 6.8.0');
    const byId = Object.fromEntries(metrics.map((m) => [m.id, m]));
    expect(byId.load).toMatchObject({ value: 0.75, severity: 'ok' });
    expect(byId.memory).toMatchObject({ value: 50, severity: 'ok' });
    // 4 % frei: unter der Alarmschwelle (5 %); tmpfs unter /run zählt nicht
    expect(byId['fs:/']).toMatchObject({ value: 4, severity: 'alarm', problem: 'unter 5 % frei' });
    expect(byId['fs:/run']).toBeUndefined();
    expect(byId.temp).toMatchObject({ value: 55, severity: 'ok' });
    expect(byId.uptime).toMatchObject({ text: '1 Tag 2 Std.' });

    const hot = nodeMetrics(parsePrometheus(NODE_METRICS), { ...MONITORING_DEFAULT_LIMITS, tempWarnC: 50, loadWarn: 0.5 });
    expect(hot.metrics.find((m) => m.id === 'temp')).toMatchObject({ severity: 'warn', problem: 'über 50 °C' });
    expect(hot.metrics.find((m) => m.id === 'load')).toMatchObject({ severity: 'warn' });
  });

  it('wertet Störungsbits und Füllstände des Druckers aus', () => {
    // Bits: 1 kein Papier, 5 Papierstau; zweites Byte Bit 14 Wartung überfällig
    expect(printerErrors(Buffer.from([0b0100_0100, 0b0000_0010]))).toEqual({ severity: 'warn', problems: ['kein Papier', 'Papierstau', 'Wartung überfällig'] });
    expect(printerErrors(Buffer.from([0b1000_0000]))).toEqual({ severity: 'info', problems: ['Papier fast leer'] });
    expect(printerErrors(Buffer.from([0]))).toEqual({ severity: 'ok', problems: [] });

    const base = '1.3.6.1.2.1.43.11.1.1';
    const rows: SnmpVarbind[] = [
      { oid: `${base}.6.1.1`, value: Buffer.from('Toner') },
      { oid: `${base}.8.1.1`, value: 100 },
      { oid: `${base}.9.1.1`, value: 5 },
      { oid: `${base}.6.1.2`, value: Buffer.from('Resttoner') },
      { oid: `${base}.8.1.2`, value: 100 },
      { oid: `${base}.9.1.2`, value: 0 },
    ];
    expect(supplyMetrics(rows, MONITORING_DEFAULT_LIMITS)).toEqual([
      { id: 'supply:1.1', label: 'Toner', value: 5, text: '5 %', severity: 'warn', problem: 'unter 10 %' },
      { id: 'supply:1.2', label: 'Resttoner', value: 0, text: '0 %', severity: 'warn', problem: 'leer' },
    ]);
  });
});

describe('Monitoring: Ziele und Meldungen', () => {
  it('ist nur für Admins verwaltbar und prüft die Eingaben', async () => {
    expect((await req('GET', '/api/system/monitoring', undefined, '')).status).toBe(401);
    expect((await req('POST', '/api/system/monitoring', { ...PRINTER, community: '' })).status).toBe(400);
    const badOid = await req<{ error: string }>('POST', '/api/system/monitoring', { ...PRINTER, checks: [{ label: 'x', query: 'node_load1', scale: 1, unit: '', warnBelow: null, warnAbove: null, alarmBelow: null, alarmAbove: null }] });
    expect(badOid.status).toBe(400);
    expect(badOid.body.error).toMatch(/OID/);

    const created = await req<MonitoringTargetConfig>('POST', '/api/system/monitoring', PRINTER);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: expect.stringMatching(/^mon-/), name: 'Drucker Heck', alwaysOn: false });
    const server = (await req<MonitoringTargetConfig>('POST', '/api/system/monitoring', SERVER)).body;
    expect((await req<MonitoringTargetConfig[]>('PUT', '/api/system/monitoring/order', { ids: [server.id, created.body.id] })).body.map((t) => t.name)).toEqual(['ELW-Server', 'Drucker Heck']);
    expect((await req('PUT', `/api/system/monitoring/${server.id}`, { ...SERVER, name: 'Server' })).status).toBe(200);
    expect((await req('DELETE', `/api/system/monitoring/${server.id}`)).status).toBe(204);
    expect((await req<MonitoringTargetConfig[]>('GET', '/api/system/monitoring')).body.map((t) => t.name)).toEqual(['Drucker Heck']);
  });

  it('testet die Verbindung ohne zu speichern', async () => {
    const ok = (await req<MonitoringTestResult>('POST', '/api/system/monitoring/test', PRINTER)).body;
    expect(ok).toMatchObject({ ok: true, message: expect.stringContaining('drucker-elw – HP LaserJet M404') });
    expect(ok.metrics.map((m) => [m.label, m.text])).toEqual([
      ['Laufzeit', '1 Std. 0 Min.'],
      ['Zustand', 'bereit'],
      ['Störungen', 'keine'],
      ['Black Toner', '42 %'],
      ['Trommel', 'vorhanden'],
    ]);
    const wrong = (await req<MonitoringTestResult>('POST', '/api/system/monitoring/test', { ...PRINTER, community: 'privat' })).body;
    expect(wrong).toMatchObject({ ok: false, message: expect.stringMatching(/Keine Antwort/) });
    expect((await req<MonitoringTargetConfig[]>('GET', '/api/system/monitoring')).body).toEqual([]);
  });

  it('meldet nicht erreichbare Geräte nur, wenn sie dauerhaft eingeschaltet sind', async () => {
    const printer = (await req<MonitoringTargetConfig>('POST', '/api/system/monitoring', PRINTER)).body;
    const server = (await req<MonitoringTargetConfig>('POST', '/api/system/monitoring', SERVER)).body;
    await adapter().pollAll();
    expect(adapter().getState().targets.map((t) => [t.name, t.reachable])).toEqual([
      ['Drucker Heck', true],
      ['ELW-Server', true],
    ]);
    // Dateisystem / mit 4 % frei
    expect(monitoringAlerts()).toEqual([expect.objectContaining({ id: `monitoring:${server.id}:fs:/`, severity: 'alarm', title: 'ELW-Server: Speicher /' })]);

    snmp.reachable = false;
    nodeUp = false;
    // ein einzelner Fehlversuch ist noch kein Ausfall
    await adapter().pollAll();
    expect(adapter().getState().targets.map((t) => t.reachable)).toEqual([true, true]);
    await adapter().pollAll();
    const [p, s] = adapter().getState().targets;
    expect(p).toMatchObject({ reachable: false, error: 'Keine Antwort (SNMP-Zeitüberschreitung – Adresse und Community prüfen)' });
    // letzte Messwerte bleiben zur Anzeige, gelten aber nicht mehr für Meldungen
    expect(s!.metrics.length).toBeGreaterThan(0);
    expect(monitoringAlerts()).toEqual([expect.objectContaining({ id: `monitoring:${server.id}`, severity: 'alarm', title: 'ELW-Server nicht erreichbar', detail: 'connect ECONNREFUSED' })]);

    // Drucker wieder an, aber mit Papierstau
    snmp.reachable = true;
    snmp.oids.set('1.3.6.1.2.1.25.3.5.1.2.1', Buffer.from([0b0000_0100]));
    await adapter().pollAll();
    expect(monitoringAlerts()).toContainEqual(expect.objectContaining({ id: `monitoring:${printer.id}:errors`, severity: 'warn', title: 'Drucker Heck: Störungen', detail: 'Papierstau' }));
  });

  it('wertet eigene Prüfungen mit Faktor und Grenzen aus', async () => {
    const check = { label: 'Innentemperatur', query: '1.3.6.1.4.1.99.1.0', scale: 0.1, unit: '°C', warnBelow: null, warnAbove: 40, alarmBelow: null, alarmAbove: 60 };
    await req('POST', '/api/system/monitoring', { ...PRINTER, kind: 'snmp', alwaysOn: true, checks: [check, { ...check, label: 'Gibt es nicht', query: '1.3.6.1.4.1.99.2.0' }] });
    await req('POST', '/api/system/monitoring', { ...SERVER, checks: [{ ...check, label: 'Daten frei', query: 'node_filesystem_avail_bytes{mountpoint="/"}', scale: 1e-9, unit: 'GB', warnAbove: null, alarmAbove: null, warnBelow: 10 }] });
    await adapter().pollAll();
    const [dev, srv] = adapter().getState().targets;
    expect(dev!.metrics.find((m) => m.label === 'Innentemperatur')).toMatchObject({ value: 41.2, text: '41,2 °C', severity: 'warn', problem: 'über 40 °C' });
    expect(dev!.metrics.find((m) => m.label === 'Gibt es nicht')).toMatchObject({ severity: 'warn', problem: 'kein Wert vom Gerät' });
    // kein Drucker: keine Drucker-OIDs abgefragt
    expect(dev!.metrics.some((m) => m.id === 'errors')).toBe(false);
    expect(srv!.metrics.find((m) => m.label === 'Daten frei')).toMatchObject({ value: 4, severity: 'warn', problem: 'unter 10 GB' });
  });

  it('nimmt deaktivierte und entfernte Ziele aus der Abfrage', async () => {
    const printer = (await req<MonitoringTargetConfig>('POST', '/api/system/monitoring', PRINTER)).body;
    await adapter().pollAll();
    expect(adapter().getState().targets).toHaveLength(1);
    await req('PUT', `/api/system/monitoring/${printer.id}`, { ...PRINTER, enabled: false });
    await adapter().pollAll();
    expect(adapter().getState().targets).toEqual([]);
  });
});
