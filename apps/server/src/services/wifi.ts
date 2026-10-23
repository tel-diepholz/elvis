import { randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import {
  guestSsid,
  wifiSettingsInputSchema,
  type AuditEntry,
  type Incident,
  type WifiAp,
  type WifiClient,
  type WifiApConfig,
  type WifiApConfigInput,
  type WifiApStatus,
  type WifiGuestInfo,
  type WifiOverview,
  type WifiSettings,
  type WifiSettingsInput,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import type { ApPollResult, WifiSource } from '../devices/drivers/openwrt.js';
import { applyWifiPlan, probeAp, UbusClient, type ApWifiPlan, type UbusHttp } from './openwrt.js';

/** AP samt Passwort – nur serverseitig. */
export interface WifiApSecretConfig extends Omit<WifiApConfig, 'passwordSet'> {
  password: string;
}

const ifaceName = z
  .string()
  .trim()
  .max(32)
  .regex(/^[A-Za-z0-9_.-]*$/, 'Name einer OpenWrt-Schnittstelle oder Bridge (z. B. lan, br-guests)');

export const wifiApInputSchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt').max(60),
  host: z
    .string()
    .trim()
    .min(1, 'Adresse fehlt')
    .max(200)
    .regex(/^[\w.\-:[\]]*$/, 'Nur Hostname oder IP-Adresse, ggf. mit :Port'),
  protocol: z.enum(['http', 'https']),
  username: z.string().trim().min(1, 'Benutzer fehlt').max(100),
  password: z.string().max(200),
  verifyTls: z.boolean(),
  opsNetwork: ifaceName.min(1, 'Schnittstelle fehlt'),
  guestNetwork: ifaceName,
  enabled: z.boolean(),
});

interface Row {
  id: string;
  name: string;
  host: string;
  protocol: 'http' | 'https';
  username: string;
  password: string;
  verify_tls: number;
  ops_network: string;
  guest_network: string;
  enabled: number;
  sort: number;
}

const fromRow = (r: Row): WifiApSecretConfig => ({
  id: r.id,
  name: r.name,
  host: r.host,
  protocol: r.protocol,
  username: r.username,
  password: r.password,
  verifyTls: !!r.verify_tls,
  opsNetwork: r.ops_network,
  guestNetwork: r.guest_network,
  enabled: !!r.enabled,
  sort: r.sort,
});

export const publicAp = ({ password, ...a }: WifiApSecretConfig): WifiApConfig => ({ ...a, passwordSet: password !== '' });

interface ClientRow {
  ap_id: string;
  mac: string;
  network: 'ops' | 'guest';
  ssid: string;
  band: string | null;
  name: string | null;
  ip: string | null;
  signal_dbm: number | null;
  rx_rate_kbps: number | null;
  tx_rate_kbps: number | null;
  connected_sec: number | null;
  last_seen: string;
}

interface StoredSettings {
  ops: { enabled: boolean; ssid: string; password: string };
  guest: { enabled: boolean; ssid: string };
}

const DEFAULT_SETTINGS: StoredSettings = { ops: { enabled: false, ssid: '', password: '' }, guest: { enabled: false, ssid: 'Gast' } };

/** Leicht abzutippen: ohne 0/O, 1/l/I */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const guestPassword = () => Array.from({ length: 12 }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');

/** Regelmäßiger Abgleich: holt zurückgesetzte oder neu gestartete APs wieder auf den Sollstand */
const RESYNC_MS = 60_000;

export interface WifiDeps {
  activeIncident: () => Incident | null;
  /** Änderungen an Einstellungen, APs oder Status (Topic wifi) */
  notify: () => void;
  /** Geräte gekommen oder gegangen (Topic wifiClients) */
  notifyClients: () => void;
  audit: (e: Omit<AuditEntry, 'id' | 'timestamp'>) => void;
  http?: UbusHttp;
}

/**
 * WLAN über OpenWrt-Accesspoints: Betriebs-WLAN dauerhaft, Gastnetz nur solange ein Einsatz läuft. Das Passwort des
 * Gastnetzes entsteht je Einsatz neu, der Netzname bekommt die Einsatznummer angehängt.
 */
export class WifiService implements WifiSource {
  private readonly status = new Map<string, WifiApStatus>();
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private lastIncidentId: number | null | undefined;
  /** AP-Liste geändert (für das Modul „WLAN-Accesspoints“) */
  private readonly apListeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly deps: WifiDeps,
  ) {}

  // --- Einstellungen (Tabelle settings, Schlüssel wifi:*) ---

  private read<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  private write(key: string, value: unknown, actor: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(key, JSON.stringify(value), new Date().toISOString(), actor);
  }

  private stored(): StoredSettings {
    const s = this.read<Partial<StoredSettings>>('wifi:settings');
    return { ops: { ...DEFAULT_SETTINGS.ops, ...s?.ops }, guest: { ...DEFAULT_SETTINGS.guest, ...s?.guest } };
  }

  settings(): WifiSettings {
    const s = this.stored();
    return { ops: { enabled: s.ops.enabled, ssid: s.ops.ssid, passwordSet: s.ops.password !== '' }, guest: s.guest };
  }

  updateSettings(input: WifiSettingsInput, actor: string): WifiSettings {
    const parsed = wifiSettingsInputSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const v = parsed.data;
    const current = this.stored();
    const password = v.ops.password || current.ops.password;
    if (v.ops.enabled && !password) throw new HttpError(400, 'ops.password: Passwort fehlt');
    this.write('wifi:settings', { ops: { ...v.ops, password }, guest: v.guest }, actor);
    this.changed();
    return this.settings();
  }

  /** Einstellungen oder AP-Liste geändert */
  private apsChanged(): void {
    this.deps.notify();
    this.apListeners.forEach((l) => l());
  }

  /** Gastnetz des laufenden Einsatzes; das Passwort entsteht beim ersten Abruf im Einsatz */
  guest(): WifiGuestInfo {
    const s = this.stored().guest;
    if (!s.enabled) return { active: false, reason: 'Gastnetz ist ausgeschaltet' };
    const incident = this.deps.activeIncident();
    if (!incident) return { active: false, reason: 'Gastnetz startet mit dem nächsten Einsatz' };
    let session = this.read<{ incidentId: number; password: string }>('wifi:guest');
    if (session?.incidentId !== incident.id) {
      session = { incidentId: incident.id, password: guestPassword() };
      this.write('wifi:guest', session, 'System');
    }
    return { active: true, ssid: guestSsid(s.ssid, incident.id), password: session.password, incidentId: incident.id };
  }

  overview(): WifiOverview {
    return { settings: this.settings(), guest: this.guest(), aps: this.list().map((a) => this.withStatus(a)) };
  }

  // --- Accesspoints (Tabelle wifi_aps) ---

  list(): WifiApSecretConfig[] {
    return (this.db.prepare('SELECT * FROM wifi_aps ORDER BY sort, name').all() as Row[]).map(fromRow);
  }

  get(id: string): WifiApSecretConfig {
    const a = this.list().find((x) => x.id === id);
    if (!a) throw new HttpError(404, `Accesspoint ${id} nicht gefunden`);
    return a;
  }

  withStatus(a: WifiApSecretConfig): WifiAp {
    const status = this.status.get(a.id) ?? { state: 'pending', message: null, radios: [], syncedAt: null };
    return { ...publicAp(a), status: a.enabled ? status : { ...status, state: 'disabled' } };
  }

  private validate(input: WifiApConfigInput, current?: WifiApSecretConfig): WifiApSecretConfig {
    const parsed = wifiApInputSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const v = parsed.data;
    const password = v.password === '' && current ? current.password : v.password;
    if (!password) throw new HttpError(400, 'password: Passwort fehlt');
    return { id: current?.id ?? `ap-${randomBytes(4).toString('hex')}`, sort: current?.sort ?? this.list().length, ...v, password };
  }

  create(input: WifiApConfigInput): WifiApSecretConfig {
    const a = this.validate(input);
    this.db
      .prepare(
        'INSERT INTO wifi_aps (id, name, host, protocol, username, password, verify_tls, ops_network, guest_network, enabled, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(a.id, a.name, a.host, a.protocol, a.username, a.password, a.verifyTls ? 1 : 0, a.opsNetwork, a.guestNetwork, a.enabled ? 1 : 0, a.sort, new Date().toISOString());
    this.changed();
    return a;
  }

  update(id: string, input: WifiApConfigInput): WifiApSecretConfig {
    const a = this.validate(input, this.get(id));
    this.db
      .prepare('UPDATE wifi_aps SET name = ?, host = ?, protocol = ?, username = ?, password = ?, verify_tls = ?, ops_network = ?, guest_network = ?, enabled = ? WHERE id = ?')
      .run(a.name, a.host, a.protocol, a.username, a.password, a.verifyTls ? 1 : 0, a.opsNetwork, a.guestNetwork, a.enabled ? 1 : 0, id);
    this.status.delete(id);
    this.changed();
    return a;
  }

  /** Entfernt den AP aus ELVIS; die auf ihm eingerichteten WLANs bleiben bestehen */
  remove(id: string): WifiApSecretConfig {
    const a = this.get(id);
    // Geräte des APs verschwinden mit (ON DELETE CASCADE)
    this.db.prepare('DELETE FROM wifi_aps WHERE id = ?').run(id);
    this.status.delete(id);
    this.apsChanged();
    this.deps.notifyClients();
    return a;
  }

  reorder(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE wifi_aps SET sort = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, id)))();
    this.deps.notify();
  }

  /** Verbindung prüfen, ohne zu speichern (bei bestehenden APs gilt ein leeres Passwort als unverändert) */
  async test(input: WifiApConfigInput, id?: string): Promise<string> {
    const a = this.validate(input, id ? this.get(id) : undefined);
    return probeAp(new UbusClient(a, this.deps.http), { ops: a.opsNetwork, guest: a.guestNetwork });
  }

  // --- Angemeldete Geräte (Tabelle wifi_clients, gepflegt vom Modul „WLAN-Accesspoints“) ---

  get http(): UbusHttp | undefined {
    return this.deps.http;
  }

  onChange(l: () => void): () => void {
    this.apListeners.add(l);
    return () => this.apListeners.delete(l);
  }

  clients(): WifiClient[] {
    const names = new Map(this.list().map((a) => [a.id, a.name]));
    const rows = this.db.prepare('SELECT * FROM wifi_clients ORDER BY name IS NULL, name, mac').all() as ClientRow[];
    return rows.map((r) => ({
      mac: r.mac,
      name: r.name,
      ip: r.ip,
      network: r.network,
      ssid: r.ssid,
      apId: r.ap_id,
      apName: names.get(r.ap_id) ?? r.ap_id,
      band: r.band,
      signalDbm: r.signal_dbm,
      rxRateKbps: r.rx_rate_kbps,
      txRateKbps: r.tx_rate_kbps,
      connectedSec: r.connected_sec,
      lastSeen: r.last_seen,
    }));
  }

  /**
   * Ergebnis einer Abfrage übernehmen. Antwortet ein AP nicht, bleiben seine Geräte mit dem letzten Stand stehen;
   * Geräte nicht mehr abgefragter APs verschwinden. Benachrichtigt nur, wenn Geräte kommen oder gehen.
   */
  storeClients(results: ApPollResult[]): void {
    const now = new Date().toISOString();
    const key = () => (this.db.prepare('SELECT ap_id, mac, network FROM wifi_clients ORDER BY 1, 2, 3').all() as object[]).map((r) => Object.values(r).join('|')).join(',');
    const before = key();
    const upsert = this.db.prepare(
      `INSERT INTO wifi_clients (ap_id, mac, network, ssid, band, name, ip, signal_dbm, rx_rate_kbps, tx_rate_kbps, connected_sec, first_seen, last_seen)
       VALUES (@apId, @mac, @role, @ssid, @band, @name, @ip, @signalDbm, @rxRateKbps, @txRateKbps, @connectedSec, @now, @now)
       ON CONFLICT (ap_id, mac, network) DO UPDATE SET ssid = excluded.ssid, band = excluded.band, name = excluded.name, ip = excluded.ip,
         signal_dbm = excluded.signal_dbm, rx_rate_kbps = excluded.rx_rate_kbps, tx_rate_kbps = excluded.tx_rate_kbps,
         connected_sec = excluded.connected_sec, last_seen = excluded.last_seen`,
    );
    const polled = results.map((r) => r.ap.id);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM wifi_clients WHERE ap_id NOT IN (${polled.map(() => '?').join(',') || "''"})`).run(...polled);
      for (const r of results) {
        if (!r.stations) continue;
        for (const st of r.stations) upsert.run({ ...st, apId: r.ap.id, now });
        // nicht mehr verbunden
        this.db.prepare('DELETE FROM wifi_clients WHERE ap_id = ? AND last_seen < ?').run(r.ap.id, now);
      }
    })();
    if (key() !== before) this.deps.notifyClients();
  }

  /** Modul gestoppt oder deaktiviert: keine veralteten Geräte anzeigen */
  clearClients(): void {
    if (!this.db.open) return; // beim Beenden von ELVIS ist die Datenbank womöglich schon zu
    if (this.db.prepare('DELETE FROM wifi_clients').run().changes > 0) this.deps.notifyClients();
  }

  // --- Abgleich ---

  start(): void {
    this.lastIncidentId = this.deps.activeIncident()?.id ?? null;
    this.timer = setInterval(() => void this.syncAll(), RESYNC_MS);
    this.timer.unref();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.timer = this.debounce = null;
  }

  /** Einsatz eröffnet oder beendet: Gastnetz zu- bzw. abschalten */
  incidentChanged(): void {
    const id = this.deps.activeIncident()?.id ?? null;
    if (id === this.lastIncidentId) return;
    this.lastIncidentId = id;
    this.deps.notify();
    this.schedule();
  }

  private changed(): void {
    this.apsChanged();
    this.schedule();
  }

  /** Abgleich anstoßen (gebündelt, damit mehrere Änderungen kurz hintereinander nur einmal übertragen werden) */
  schedule(delayMs = 300): void {
    if (!this.timer) return; // nicht gestartet (Tests ohne start())
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncAll(), delayMs);
    this.debounce.unref();
  }

  /** Alle aktiven APs auf den Sollstand bringen; läuft bereits ein Abgleich, folgt direkt danach ein weiterer */
  async syncAll(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const plan = this.plan();
        await Promise.all(this.list().filter((a) => a.enabled).map((a) => this.syncAp(a, plan)));
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private plan(): (ap: WifiApSecretConfig) => ApWifiPlan {
    const s = this.stored();
    const guest = this.guest();
    return (ap) => ({
      ops: s.ops.enabled && s.ops.ssid && s.ops.password ? { ssid: s.ops.ssid, key: s.ops.password, network: ap.opsNetwork } : null,
      guest: guest.active && ap.guestNetwork ? { ssid: guest.ssid, key: guest.password, network: ap.guestNetwork } : null,
    });
  }

  private async syncAp(ap: WifiApSecretConfig, plan: (ap: WifiApSecretConfig) => ApWifiPlan): Promise<void> {
    const before = this.status.get(ap.id);
    const audit = (success: boolean, message: string) =>
      this.deps.audit({ operator: 'System', target: `wlan:${ap.id}`, action: 'sync', params: '', success, message: `${ap.name}: ${message}` });
    let next: WifiApStatus;
    try {
      const p = plan(ap);
      const res = await applyWifiPlan(new UbusClient(ap, this.deps.http), p);
      const summary = [p.ops && `Betriebs-WLAN „${p.ops.ssid}“`, p.guest && `Gastnetz „${p.guest.ssid}“`].filter(Boolean).join(', ') || 'keine WLANs von ELVIS';
      next = { state: res.warnings.length ? 'error' : 'ok', message: res.warnings.join('; ') || summary, radios: res.radios, syncedAt: new Date().toISOString() };
      if (res.changed) audit(!res.warnings.length, `WLAN übertragen (${[summary, ...res.warnings].join('; ')})`);
      else if (res.warnings.length && before?.message !== next.message) audit(false, res.warnings.join('; '));
    } catch (err) {
      next = { state: 'error', message: (err as Error).message, radios: before?.radios ?? [], syncedAt: before?.syncedAt ?? null };
      if (before?.state !== 'error' || before.message !== next.message) audit(false, next.message!);
    }
    // AP in der Zwischenzeit entfernt?
    if (!this.list().some((a) => a.id === ap.id)) return;
    this.status.set(ap.id, next);
    // Nur bei geändertem Ergebnis benachrichtigen, nicht bei jedem regelmäßigen Abgleich
    const key = (st: WifiApStatus | undefined) => JSON.stringify(st && [st.state, st.message, st.radios]);
    if (key(before) !== key(next)) this.deps.notify();
  }
}
