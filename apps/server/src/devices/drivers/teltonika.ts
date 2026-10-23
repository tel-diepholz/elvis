import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { z } from 'zod';
import type { DhcpLease, FailoverMember, RouterSim, RouterState, SimStatus, UplinkStatus } from '@elvis/shared';
import { BaseAdapter, type AdapterContext } from '../adapter.js';

export const teltonikaOptionsSchema = z.object({
  host: z.string().min(1),
  protocol: z.enum(['https', 'http']).default('https'),
  username: z.string().default('admin'),
  password: z.string().default(''),
  /** RutOS nutzt ab Werk ein selbstsigniertes Zertifikat. */
  verifyTls: z.boolean().default(false),
  wanName: z.string().default('WAN'),
  /** Name der WAN-Schnittstelle im Router */
  wanInterface: z.string().default('wan'),
  pollSeconds: z.number().int().min(2).max(300).default(5),
});

export type TeltonikaOptions = z.infer<typeof teltonikaOptionsSchema>;

// --- Antworten der RutOS-API (nur die genutzten Felder, alle optional – je nach Firmware unterschiedlich) ---

type Num = number | string | null | undefined;

export interface RutModem {
  id?: string;
  model?: string;
  builtin?: boolean;
  primary?: number | boolean;
  offline?: string;
  sim_count?: number;
  active_sim?: Num;
  simstate?: string;
  pinstate?: string;
  netstate?: string;
  operator_state?: string;
  state?: string;
  data_conn_state?: string;
  operator?: string;
  oper?: string;
  provider?: string;
  conntype?: string;
  ntype?: string;
  band?: string;
  signal_quality?: Num;
  rssi?: Num;
  signal?: Num;
  rsrp?: Num;
  rsrq?: Num;
  sinr?: Num;
  iccid?: string;
}

export interface RutInterface {
  id?: string;
  name?: string;
  interface?: string;
  up?: boolean;
  is_up?: boolean;
  metric?: Num;
  network_type?: string;
  mwan_enabled?: Num;
  'ipv4-address'?: { address: string; mask: number }[];
  route?: { target: string; mask: number; nexthop: string }[];
  gwaddr?: string;
}

export interface RutFailoverEntry {
  enabled?: boolean;
  up?: boolean;
  status?: string;
}

export interface RutPort {
  name?: string;
  description?: string;
  state?: string;
  link?: string;
  speed?: Num;
}

export interface RutLease {
  ipaddr?: string;
  macaddr?: string;
  hostname?: string;
  interface?: string;
  expires?: Num;
}

export interface RutStaticLease {
  name?: string;
  mac?: string;
  ip?: string;
}

export interface RutosSnapshot {
  modems: RutModem[];
  interfaces: RutInterface[] | null;
  failover: Record<string, RutFailoverEntry> | null;
  ports: RutPort[] | null;
  leases?: RutLease[] | null;
  /** je nach Firmware Liste oder Objekt mit Einträgen */
  staticLeases?: RutStaticLease[] | Record<string, RutStaticLease> | null;
}

const ipKey = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + (Number(o) || 0), 0);

/** DHCP-Leases aufbereiten: feste Zuweisungen markieren, nach IP sortieren, Ablauf auf die Minute runden (sonst änderte sich der Zustand jede Abfrage). */
export function mapLeases(leases: RutLease[] | null | undefined, statics: RutosSnapshot['staticLeases'], now: Date): DhcpLease[] | null {
  if (!leases) return null;
  const staticList = !statics ? [] : Array.isArray(statics) ? statics : Object.values(statics);
  const byMac = new Map(staticList.filter((s) => s.mac).map((s) => [s.mac!.toLowerCase(), s]));
  return leases
    .filter((l) => l.ipaddr && l.macaddr)
    .map((l) => {
      const mac = l.macaddr!.toLowerCase();
      const fixed = byMac.get(mac);
      const expires = num(l.expires);
      return {
        ip: l.ipaddr!,
        mac,
        hostname: l.hostname && l.hostname !== '*' ? l.hostname : null,
        interface: text(l.interface),
        expiresAt: expires === null || expires <= 0 ? null : new Date(Math.ceil((now.getTime() + expires * 1000) / 60_000) * 60_000).toISOString(),
        static: !!fixed,
        name: text(fixed?.name),
      };
    })
    .sort((a, b) => ipKey(a.ip) - ipKey(b.ip));
}

const num = (v: Num): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: string | undefined | null): string | null => (v && v.trim() && v !== 'N/A' ? v.trim() : null);

const MOBILE_IFACE = /^mob(\d+)s(\d+)a(\d+)$/;
/** IPv6-Zwillinge (wan6, mob1s1a1_6) nicht doppelt anzeigen */
const IPV6_IFACE = /^(wan6|.+_6)$/;

const ifaceName = (i: RutInterface) => i.id ?? i.interface ?? i.name ?? '';

export function simStatus(m: RutModem): { status: SimStatus; detail: string | null } {
  const pin = m.pinstate ?? '';
  const net = m.netstate ?? m.operator_state ?? '';
  const data = m.data_conn_state ?? m.state ?? '';
  if (m.simstate === 'Not inserted' || pin === 'Not inserted') return { status: 'no-sim', detail: 'Keine SIM-Karte eingelegt' };
  if (pin.startsWith('Required PIN')) return { status: 'pin-required', detail: pin };
  if (pin.startsWith('Required PUK') || pin === 'PUK') return { status: 'puk-required', detail: pin };
  if (pin === 'SIM failure') return { status: 'error', detail: 'SIM-Fehler' };
  if (data === 'Connected') return { status: 'connected', detail: text(net) };
  if (net === 'Registered, home' || net === 'Roaming') return { status: 'registered', detail: net };
  if (net === 'Searching') return { status: 'searching', detail: net };
  if (net === 'Denied') return { status: 'denied', detail: 'Netz verweigert die Anmeldung' };
  return { status: 'unknown', detail: text(net) ?? text(pin) };
}

function mapFailoverStatus(e: RutFailoverEntry | undefined, up: boolean): UplinkStatus {
  if (!e) return up ? 'online' : 'offline';
  if (e.enabled === false) return 'disabled';
  switch (e.status) {
    case 'online':
      return 'online';
    case 'offline':
      return 'offline';
    case 'disabled':
      return 'disabled';
    case 'notracking':
      return e.up ?? up ? 'online' : 'offline';
    default:
      return 'unknown';
  }
}

/** Rohdaten des Routers → Zustand für ELVIS. `previous` liefert die zuletzt bekannten Werte der inaktiven SIM. */
export function mapRouterState(snap: RutosSnapshot, opts: Pick<TeltonikaOptions, 'wanName' | 'wanInterface'>, previous: RouterState | null, now = new Date()): RouterState {
  const modem = snap.modems.find((m) => m.builtin && m.offline !== '1') ?? snap.modems.find((m) => m.offline !== '1') ?? snap.modems[0];
  const slotCount = Math.max(2, modem?.sim_count ?? 2);
  const activeSlot = modem ? num(modem.active_sim) : null;

  const sims: RouterSim[] = [];
  for (let slot = 1; slot <= slotCount; slot++) {
    if (modem && slot === activeSlot) {
      const { status, detail } = simStatus(modem);
      const live = status !== 'no-sim';
      sims.push({
        slot,
        active: true,
        status,
        detail,
        operator: live ? text(modem.operator) ?? text(modem.oper) ?? text(modem.provider) : null,
        networkType: live ? text(modem.conntype) ?? text(modem.ntype) : null,
        band: live ? text(modem.band) : null,
        signalPercent: live ? num(modem.signal_quality) : null,
        rssiDbm: live ? num(modem.rssi) ?? num(modem.signal) : null,
        rsrpDbm: live ? num(modem.rsrp) : null,
        rsrqDb: live ? num(modem.rsrq) : null,
        sinrDb: live ? num(modem.sinr) : null,
        roaming: (modem.netstate ?? modem.operator_state) === 'Roaming',
        iccid: live ? text(modem.iccid) : null,
        seenAt: now.toISOString(),
      });
      continue;
    }
    // Reserve-SIM: das Modem kann sie nicht gleichzeitig abfragen – letzte bekannte Werte behalten.
    const prev = previous?.sims.find((s) => s.slot === slot);
    const wasUsable = prev && (prev.status === 'connected' || prev.status === 'registered' || prev.status === 'searching' || prev.status === 'standby');
    sims.push({
      slot,
      active: false,
      status: !prev || prev.seenAt === null ? 'standby' : wasUsable ? 'standby' : prev.status,
      detail: prev?.seenAt ? 'Reserve – Werte von der letzten aktiven Phase' : 'Reserve – Zustand wird erst nach einer Umschaltung bekannt',
      operator: prev?.operator ?? null,
      networkType: null,
      band: null,
      signalPercent: null,
      rssiDbm: null,
      rsrpDbm: null,
      rsrqDb: null,
      sinrDb: null,
      roaming: false,
      iccid: prev?.iccid ?? null,
      seenAt: prev?.seenAt ?? null,
    });
  }

  const interfaces = (snap.interfaces ?? []).filter((i) => !IPV6_IFACE.test(ifaceName(i)));
  const wanIface = interfaces.find((i) => ifaceName(i) === opts.wanInterface);
  const port = snap.ports?.find((p) => /wan/i.test(p.name ?? '') || /wan/i.test(p.description ?? ''));
  const wanUp = !!(wanIface?.is_up ?? wanIface?.up);
  const wan = {
    name: opts.wanName || 'WAN',
    link: port ? (port.state ?? port.link) === 'up' : null,
    speedMbps: port && (port.state ?? port.link) === 'up' ? num(port.speed) : null,
    up: wanUp,
    ip: wanIface?.['ipv4-address']?.[0]?.address ?? null,
    gateway: wanIface?.route?.find((r) => r.target === '0.0.0.0' && r.mask === 0)?.nexthop ?? text(wanIface?.gwaddr) ?? null,
  };

  // Failover-Teilnehmer: WAN und die Mobilfunk-Schnittstellen, sortiert nach Metrik (kleiner = bevorzugt)
  const failoverEnabled = !!snap.failover && Object.keys(snap.failover).length > 0;
  const names = new Set<string>([...(failoverEnabled ? Object.keys(snap.failover!) : []), ...interfaces.map(ifaceName).filter((n) => n === opts.wanInterface || MOBILE_IFACE.test(n))]);
  const candidates = [...names]
    .filter((n) => !IPV6_IFACE.test(n))
    .map((id) => {
      const iface = interfaces.find((i) => ifaceName(i) === id);
      const mobile = MOBILE_IFACE.exec(id);
      const slot = mobile ? Number(mobile[2]) : null;
      const up = !!(iface?.is_up ?? iface?.up);
      let status = mapFailoverStatus(snap.failover?.[id], up);
      if (slot !== null && slot !== activeSlot && status !== 'disabled') status = 'standby';
      const sim = sims.find((s) => s.slot === slot);
      const label = id === opts.wanInterface ? wan.name : slot !== null ? `SIM ${slot}${sim?.operator ? ` (${sim.operator})` : ''}` : id;
      return { id, label, kind: (slot !== null ? 'sim' : 'wan') as FailoverMember['kind'], slot, status, metric: num(iface?.metric) ?? 9999 };
    })
    .sort((a, b) => a.metric - b.metric || a.id.localeCompare(b.id));
  const active = candidates.find((c) => c.status === 'online') ?? null;
  const members: FailoverMember[] = candidates.map(({ metric: _m, ...c }, i) => ({ ...c, priority: i + 1, active: c.id === active?.id }));
  const preferred = members.find((m) => m.status !== 'disabled');

  return {
    model: text(modem?.model) ?? null,
    internet: active !== null,
    wan,
    sims,
    failover: { enabled: failoverEnabled, activeId: active?.id ?? null, onBackup: !!active && !!preferred && active.id !== preferred.id, members },
    leases: mapLeases(snap.leases, snap.staticLeases, now),
  };
}

// --- HTTP-Client ---

export class RutosError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface HttpResult {
  status: number;
  body: unknown;
}

export type HttpFn = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, body: unknown, verifyTls: boolean) => Promise<HttpResult>;

const nodeHttp: HttpFn = (method, url, headers, body, verifyTls) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method,
        headers: { accept: 'application/json', ...(payload && { 'content-type': 'application/json' }), ...headers },
        timeout: 8_000,
        ...(u.protocol === 'https:' && { rejectUnauthorized: verifyTls }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const apiError = (body: unknown): string | null => {
  const errors = (body as { errors?: { error?: string; code?: number }[] } | null)?.errors;
  return errors?.length ? errors.map((e) => e.error ?? `Fehler ${e.code}`).join('; ') : null;
};

/** Zugriff auf die RutOS-Web-API (ab Firmware 7.x): Anmeldung mit Bearer-Token, Erneuerung bei Ablauf. */
export class RutosClient {
  private token: string | null = null;
  private tokenUntil = 0;
  /** Gleichzeitige Anfragen teilen sich eine Anmeldung. */
  private pendingLogin: Promise<string> | null = null;

  constructor(
    private readonly o: TeltonikaOptions,
    private readonly http: HttpFn = nodeHttp,
    private readonly now: () => number = Date.now,
  ) {}

  private get base() {
    return `${this.o.protocol}://${this.o.host}/api`;
  }

  private login(): Promise<string> {
    this.pendingLogin ??= this.doLogin().finally(() => (this.pendingLogin = null));
    return this.pendingLogin;
  }

  private async doLogin(): Promise<string> {
    const res = await this.http('POST', `${this.base}/login`, {}, { username: this.o.username, password: this.o.password }, this.o.verifyTls);
    const data = (res.body as { success?: boolean; data?: { token?: string; expires?: number; '2fa_login'?: boolean } } | null)?.data;
    if (res.status === 401 || res.status === 403) throw new RutosError('Anmeldung am Router abgelehnt – Benutzer/Passwort prüfen', res.status);
    if (data?.['2fa_login']) throw new RutosError('Benutzer verlangt Zwei-Faktor-Anmeldung – eigenen Benutzer ohne 2FA anlegen', 403);
    if (res.status !== 200 || !data?.token) throw new RutosError(apiError(res.body) ?? `Anmeldung fehlgeschlagen (HTTP ${res.status})`, res.status);
    this.token = data.token;
    // etwas vor Ablauf erneuern
    this.tokenUntil = this.now() + Math.max(30, (data.expires ?? 299) - 20) * 1000;
    return data.token;
  }

  async get<T>(path: string): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.token && this.now() < this.tokenUntil ? this.token : await this.login();
      const res = await this.http('GET', `${this.base}${path}`, { authorization: `Bearer ${token}` }, undefined, this.o.verifyTls);
      if (res.status === 401 && attempt === 0) {
        this.token = null;
        continue;
      }
      const body = res.body as { success?: boolean; data?: T } | null;
      if (res.status !== 200 || body?.success === false) throw new RutosError(apiError(res.body) ?? `${path}: HTTP ${res.status}`, res.status);
      return body?.data as T;
    }
    throw new RutosError('Anmeldung am Router abgelehnt', 401);
  }
}

// --- Treiber ---

/**
 * Teltonika-Router mit RutOS 7 (z. B. RUTM59) über die Web-API: SIM-Status beider Steckplätze,
 * Failover (mwan3) und WAN-Port. Fragt zyklisch ab; nur lesend.
 */
export class TeltonikaAdapter extends BaseAdapter<'router'> {
  protected readonly commands = {};
  private readonly options: TeltonikaOptions;
  private readonly client: RutosClient;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastError: string | null = null;
  /** Optionale Endpunkte, die diese Firmware nicht kennt, nicht ständig erneut abfragen. */
  private readonly unsupported = new Set<string>();

  constructor(options: Record<string, unknown>, http?: HttpFn) {
    const o = teltonikaOptionsSchema.parse(options);
    super('router', 'teltonika-rutos', {
      model: null,
      internet: false,
      wan: { name: o.wanName || 'WAN', link: null, speedMbps: null, up: false, ip: null, gateway: null },
      sims: [1, 2].map((slot) => ({ slot, active: false, status: 'unknown', detail: null, operator: null, networkType: null, band: null, signalPercent: null, rssiDbm: null, rsrpDbm: null, rsrqDb: null, sinrDb: null, roaming: false, iccid: null, seenAt: null })),
      failover: { enabled: false, activeId: null, onBackup: false, members: [] },
      leases: null,
    } satisfies RouterState);
    this.options = o;
    this.client = new RutosClient(o, http);
    this.online = false;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    this.stopped = false;
    void this.loop();
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.poll();
    if (!this.stopped) this.timer = setTimeout(() => void this.loop(), this.options.pollSeconds * 1000);
  }

  private async optional<T>(path: string): Promise<T | null> {
    if (this.unsupported.has(path)) return null;
    try {
      return await this.client.get<T>(path);
    } catch (err) {
      if (err instanceof RutosError && (err.status === 404 || err.status === 501 || /not implemented/i.test(err.message))) {
        this.unsupported.add(path);
        this.ctx.log.info(`Router: ${path} wird von dieser Firmware nicht unterstützt`);
      }
      return null;
    }
  }

  private polling: Promise<void> | null = null;

  /** Eine Abfrage aller Endpunkte (öffentlich für Tests); läuft nie parallel. */
  poll(): Promise<void> {
    this.polling ??= this.doPoll().finally(() => (this.polling = null));
    return this.polling;
  }

  private async doPoll(): Promise<void> {
    try {
      const modems = await this.client.get<RutModem[]>('/modems/status');
      const [interfaces, failover, ports, leases, staticLeases] = await Promise.all([
        this.optional<RutInterface[]>('/interfaces/status'),
        this.optional<Record<string, RutFailoverEntry>>('/failover/status'),
        this.optional<RutPort[]>('/ports_settings/status'),
        this.optional<RutLease[]>('/dhcp/leases/ipv4/status'),
        this.optional<RutosSnapshot['staticLeases']>('/dhcp/static_leases/ipv4/config'),
      ]);
      const next = mapRouterState({ modems: modems ?? [], interfaces, failover, ports, leases, staticLeases }, this.options, this.state);
      // Zeitstempel der aktiven SIM nicht als Änderung werten, sonst gäbe es jede Abfrage ein Update
      const comparable = (s: RouterState) => JSON.stringify({ ...s, sims: s.sims.map((x) => ({ ...x, seenAt: x.active ? null : x.seenAt })) });
      if (comparable(next) !== comparable(this.state) || !this.online) this.update((s) => Object.assign(s, next));
      if (this.lastError) this.ctx.log.info(`Router ${this.options.host}: wieder erreichbar`);
      this.lastError = null;
      this.setOnline(true);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== this.lastError) this.ctx.log.warn(`Router ${this.options.host}: ${msg}`);
      this.lastError = msg;
      this.setOnline(false);
    }
  }
}
