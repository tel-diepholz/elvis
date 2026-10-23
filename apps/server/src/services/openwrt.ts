import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/** Zugangsdaten eines OpenWrt-Geräts */
export interface OpenWrtTarget {
  host: string;
  protocol: 'http' | 'https';
  username: string;
  password: string;
  verifyTls: boolean;
}

export type UbusHttp = (url: string, body: unknown, verifyTls: boolean) => Promise<{ status: number; body: unknown }>;

const nodeHttp: UbusHttp = (url, body, verifyTls) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        timeout: 8_000,
        ...(u.protocol === 'https:' && { rejectUnauthorized: verifyTls }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            // kein JSON – z. B. Fehlerseite des Webservers
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', reject);
    req.end(payload);
  });

/** Statuscodes von ubus (libubus) */
const UBUS_ERRORS: Record<number, string> = {
  1: 'ungültiger Befehl',
  2: 'ungültiges Argument',
  3: 'Methode nicht gefunden',
  4: 'nicht gefunden',
  5: 'keine Daten',
  6: 'keine Berechtigung',
  7: 'Zeitüberschreitung',
  8: 'nicht unterstützt',
  9: 'unbekannter Fehler',
  10: 'Verbindung fehlgeschlagen',
};

export class UbusError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

const NO_SESSION = '00000000000000000000000000000000';

/**
 * Zugriff auf ubus über JSON-RPC (/ubus von uhttpd-mod-ubus, wie LuCI ihn nutzt). Anmeldung über rpcd mit einem
 * Systemkonto, das Schreibrechte auf uci hat (root).
 */
export class UbusClient {
  private session: string | null = null;
  private seq = 0;

  constructor(
    private readonly t: OpenWrtTarget,
    private readonly http: UbusHttp = nodeHttp,
  ) {}

  private async rpc(sid: string, object: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `${this.t.protocol}://${this.t.host}/ubus`;
    let res;
    try {
      res = await this.http(url, { jsonrpc: '2.0', id: ++this.seq, method: 'call', params: [sid, object, method, params] }, this.t.verifyTls);
    } catch (err) {
      throw new UbusError(`${this.t.host} nicht erreichbar: ${(err as Error).message}`);
    }
    if (res.status === 404) throw new UbusError('Kein ubus-Zugang unter /ubus – Paket uhttpd-mod-ubus (LuCI) installieren');
    const body = res.body as { result?: unknown[]; error?: { code: number; message: string } } | null;
    if (body?.error) throw new UbusError(body.error.code === -32002 ? 'Zugriff verweigert' : body.error.message, body.error.code);
    if (res.status !== 200 || !Array.isArray(body?.result)) throw new UbusError(`Unerwartete Antwort (HTTP ${res.status})`);
    const [code, data] = body.result as [number, unknown];
    if (code !== 0) throw new UbusError(`${object}.${method}: ${UBUS_ERRORS[code] ?? `Fehler ${code}`}`, code);
    return data ?? null;
  }

  async login(): Promise<void> {
    try {
      const data = (await this.rpc(NO_SESSION, 'session', 'login', { username: this.t.username, password: this.t.password })) as { ubus_rpc_session?: string } | null;
      if (!data?.ubus_rpc_session) throw new UbusError('Anmeldung fehlgeschlagen');
      this.session = data.ubus_rpc_session;
    } catch (err) {
      if (err instanceof UbusError && (err.code === 6 || err.code === -32002)) throw new UbusError('Anmeldung abgelehnt – Benutzer oder Passwort falsch');
      throw err;
    }
  }

  async call<T = unknown>(object: string, method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.session) await this.login();
    return (await this.rpc(this.session!, object, method, params)) as T;
  }

  /** Alle Abschnitte einer uci-Konfiguration */
  async uciGet(config: string): Promise<Record<string, UciSection>> {
    const data = await this.call<{ values?: Record<string, UciSection> }>('uci', 'get', { config });
    return data?.values ?? {};
  }
}

export type UciSection = { '.type': string; '.name': string; '.anonymous'?: boolean } & Record<string, unknown>;

/** Gewünschte Werte eines WLANs (wifi-iface) */
export interface WifiIfaceSpec {
  ssid: string;
  key: string;
  network: string;
}

/** Was ELVIS auf einem AP einrichten soll; im Gastnetz sind die Clients untereinander abgeschottet */
export interface ApWifiPlan {
  ops: WifiIfaceSpec | null;
  guest: WifiIfaceSpec | null;
}

export interface ApSyncResult {
  radios: string[];
  /** Konfiguration geändert (und neu geladen) */
  changed: boolean;
  /** Teilweise nicht umsetzbar, z. B. fehlende Gastnetz-Schnittstelle */
  warnings: string[];
}

/** Von ELVIS verwaltete WLANs heißen elvis_<rolle>_<funkmodul>, verwaltete Schnittstellen elvis_<rolle> */
const MANAGED = /^elvis_(ops|guest)_/;
const MANAGED_NET = /^elvis_(ops|guest)$/;
const sectionName = (role: 'ops' | 'guest', radio: string) => `elvis_${role}_${radio.replace(/[^A-Za-z0-9_]/g, '_')}`;

export const BANDS: Record<string, string> = { '2g': '2,4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };

export function radioLabel(s: UciSection): string {
  const band = typeof s.band === 'string' ? BANDS[s.band] : s.hwmode === '11a' ? '5 GHz' : s.hwmode ? '2,4 GHz' : null;
  return band ? `${s['.name']} (${band})` : s['.name'];
}

const str = (v: unknown) => (Array.isArray(v) ? v.join(' ') : v == null ? '' : String(v));
const list = (v: unknown) => str(v).split(/\s+/).filter(Boolean);

type Network = Record<string, UciSection>;

/** Bridges aus /etc/config/network: neue Schreibweise (config device) und alte (interface mit type bridge) */
function bridges(network: Network): { name: string; ports: string[] }[] {
  const all = Object.values(network);
  return [
    ...all.filter((s) => s['.type'] === 'device' && s.type === 'bridge' && s.name).map((s) => ({ name: str(s.name), ports: list(s.ports) })),
    ...all.filter((s) => s['.type'] === 'interface' && s.type === 'bridge').map((s) => ({ name: `br-${s['.name']}`, ports: list(s.ifname) })),
  ];
}

/** Ziel eines WLANs: vorhandene OpenWrt-Schnittstelle oder Bridge ohne Schnittstelle (dann legt ELVIS eine an) */
export type NetworkTarget = { iface: string } | { bridge: string };

/**
 * Eingabe auflösen: Name einer Schnittstelle (lan), ihres Geräts (br-lan) oder eines Bridge-Ports (eth0). Eine Bridge
 * ohne Schnittstelle (z. B. br-guests, nur unter „Geräte“ angelegt) wird ebenfalls angenommen.
 */
export function resolveNetwork(network: Network, name: string): NetworkTarget | null {
  const ifaces = Object.values(network).filter((s) => s['.type'] === 'interface' && s['.name'] !== 'loopback');
  if (ifaces.some((s) => s['.name'] === name)) return { iface: name };
  const br = bridges(network).find((b) => b.name === name || b.ports.includes(name));
  const device = br?.name ?? name;
  const iface = ifaces.find((s) => str(s.device) === device || (s.type === 'bridge' && `br-${s['.name']}` === device) || list(s.ifname).includes(device));
  if (iface) return { iface: iface['.name'] };
  return br ? { bridge: br.name } : null;
}

function notFound(network: Network, name: string, what: string): string {
  const ifaces = Object.values(network)
    .filter((s) => s['.type'] === 'interface' && s['.name'] !== 'loopback' && !MANAGED_NET.test(s['.name']))
    .map((s) => s['.name']);
  const brs = bridges(network).map((b) => b.name);
  return `${what} „${name}“ nicht gefunden – vorhanden: ${[ifaces.length && `Schnittstellen ${ifaces.join(', ')}`, brs.length && `Bridges ${brs.join(', ')}`].filter(Boolean).join('; ') || 'nichts'}`;
}

/** Abschnitte eines Typs auf den Sollstand bringen; nur die von ELVIS verwalteten werden gelöscht */
async function reconcile(c: UbusClient, config: string, current: Network, type: string, managed: RegExp, desired: Map<string, Record<string, string>>): Promise<boolean> {
  let changed = false;
  for (const s of Object.values(current)) {
    if (s['.type'] === type && managed.test(s['.name']) && !desired.has(s['.name'])) {
      await c.call('uci', 'delete', { config, section: s['.name'] });
      changed = true;
    }
  }
  for (const [name, values] of desired) {
    const cur = current[name];
    if (!cur) {
      await c.call('uci', 'add', { config, type, name, values });
      changed = true;
    } else if (Object.entries(values).some(([k, v]) => str(cur[k]) !== v)) {
      await c.call('uci', 'set', { config, section: name, values });
      changed = true;
    }
  }
  return changed;
}

/**
 * Änderungen übernehmen. LuCI-Konten dürfen oft nur „apply“ (ohne Rollback = sofort festschreiben und neu laden), nicht
 * „commit“; ältere rpcd-Versionen umgekehrt.
 */
async function applyChanges(c: UbusClient, configs: string[]): Promise<void> {
  try {
    await c.call('uci', 'apply', { rollback: false });
  } catch (err) {
    if (!(err instanceof UbusError) || (err.code !== 3 && err.code !== 6)) throw err;
    for (const config of configs) await c.call('uci', 'commit', { config });
    await c.call('network', 'reload').catch(() => {});
  }
}

/**
 * Wendet den Plan auf einen AP an: je Funkmodul ein Abschnitt für Betriebs-WLAN und Gastnetz. Fremde Abschnitte
 * bleiben unangetastet; geändert und neu geladen wird nur, wenn sich etwas unterscheidet (sonst brächen alle
 * WLAN-Verbindungen bei jedem Abgleich kurz ab).
 */
export async function applyWifiPlan(c: UbusClient, plan: ApWifiPlan): Promise<ApSyncResult> {
  const wireless = await c.uciGet('wireless');
  const network = await c.uciGet('network');
  const radios = Object.values(wireless).filter((s) => s['.type'] === 'wifi-device');
  if (radios.length === 0) throw new UbusError('Keine Funkmodule gefunden (/etc/config/wireless)');
  const warnings: string[] = [];
  const ifaces = new Map<string, Record<string, string>>();

  /** Schnittstelle, an die das WLAN gehängt wird; null = nicht vorhanden */
  const target = (role: 'ops' | 'guest', spec: WifiIfaceSpec | null): string | null => {
    if (!spec) return null;
    const t = resolveNetwork(network, spec.network);
    if (!t) {
      warnings.push(notFound(network, spec.network, role === 'ops' ? 'Schnittstelle für das Betriebs-WLAN' : 'Gastnetz-Bridge'));
      return null;
    }
    if ('iface' in t) return t.iface;
    ifaces.set(`elvis_${role}`, { proto: 'none', device: t.bridge });
    return `elvis_${role}`;
  };
  const opsNet = target('ops', plan.ops);
  const guestNet = target('guest', plan.guest);

  const desired = new Map<string, Record<string, string>>();
  for (const r of radios) {
    const base = { device: r['.name'], mode: 'ap', encryption: 'psk2', disabled: '0' };
    if (plan.ops && opsNet) desired.set(sectionName('ops', r['.name']), { ...base, network: opsNet, ssid: plan.ops.ssid, key: plan.ops.key, isolate: '0' });
    if (plan.guest && guestNet) desired.set(sectionName('guest', r['.name']), { ...base, network: guestNet, ssid: plan.guest.ssid, key: plan.guest.key, isolate: '1' });
  }

  const netChanged = await reconcile(c, 'network', network, 'interface', MANAGED_NET, ifaces);
  let wifiChanged = await reconcile(c, 'wireless', wireless, 'wifi-iface', MANAGED, desired);
  // Ab Werk sind die Funkmodule unter OpenWrt ausgeschaltet
  if (desired.size > 0) {
    for (const r of radios) {
      if (str(r.disabled) === '1') {
        await c.call('uci', 'set', { config: 'wireless', section: r['.name'], values: { disabled: '0' } });
        wifiChanged = true;
      }
    }
  }
  if (netChanged || wifiChanged) await applyChanges(c, [...(netChanged ? ['network'] : []), ...(wifiChanged ? ['wireless'] : [])]);
  return { radios: radios.map(radioLabel), changed: netChanged || wifiChanged, warnings };
}

/** Verbindung prüfen: Anmeldung, Funkmodule und Schnittstellen */
export async function probeAp(c: UbusClient, networks: { ops: string; guest: string }): Promise<string> {
  const wireless = await c.uciGet('wireless');
  const network = await c.uciGet('network');
  const radios = Object.values(wireless).filter((s) => s['.type'] === 'wifi-device');
  if (radios.length === 0) throw new UbusError('Verbunden, aber keine Funkmodule gefunden');
  const parts = [`${radios.length} Funkmodul${radios.length === 1 ? '' : 'e'} (${radios.map(radioLabel).join(', ')})`];
  const describe = (name: string, what: string, missing: string) => {
    const t = resolveNetwork(network, name);
    if (!t) throw new UbusError(`Verbunden, aber ${notFound(network, name, missing)}`);
    if ('bridge' in t) return `${what} → Bridge ${t.bridge} (ELVIS legt dafür eine Schnittstelle an)`;
    return `${what} → ${t.iface}`;
  };
  parts.push(describe(networks.ops, 'Betriebs-WLAN', 'Schnittstelle für das Betriebs-WLAN'));
  if (networks.guest) parts.push(describe(networks.guest, 'Gastnetz', 'Gastnetz-Bridge'));
  return `Verbunden – ${parts.join(', ')}`;
}

/** Angemeldetes Gerät, wie der AP es meldet */
export interface ApStation {
  mac: string;
  name: string | null;
  ip: string | null;
  role: 'ops' | 'guest';
  ssid: string;
  band: string | null;
  signalDbm: number | null;
  rxRateKbps: number | null;
  txRateKbps: number | null;
  connectedSec: number | null;
}

interface LuciWirelessDevice {
  config?: { band?: string; hwmode?: string };
  interfaces?: { section?: string; ifname?: string; config?: { ssid?: string } }[];
}

interface IwinfoStation {
  mac?: string;
  signal?: number;
  connected_time?: number;
  rx?: { rate?: number };
  tx?: { rate?: number };
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Geräte in den von ELVIS eingerichteten WLANs. Die Zuordnung WLAN → Netzwerkgerät (wlan0, wlan0-1 …) liefert LuCI
 * (luci-rpc), die Geräte iwinfo; Namen und IPs stammen aus den Host-Hinweisen des APs (im Gastnetz meist leer, weil der AP
 * dort keine IP hat).
 */
export async function fetchStations(c: UbusClient): Promise<ApStation[]> {
  const devices = await c.call<Record<string, LuciWirelessDevice>>('luci-rpc', 'getWirelessDevices');
  const hints = await c.call<Record<string, { name?: string; ipaddrs?: string[] }>>('luci-rpc', 'getHostHints').catch(() => ({}) as Record<string, { name?: string; ipaddrs?: string[] }>);
  const byMac = new Map(Object.entries(hints ?? {}).map(([mac, h]) => [mac.toUpperCase(), h]));
  const ifaces = Object.values(devices ?? {}).flatMap((d) =>
    (d.interfaces ?? []).flatMap((i) => {
      const role = i.section?.match(MANAGED)?.[1] as 'ops' | 'guest' | undefined;
      if (!role || !i.ifname) return [];
      const band = d.config?.band ? (BANDS[d.config.band] ?? null) : d.config?.hwmode === '11a' ? '5 GHz' : d.config?.hwmode ? '2,4 GHz' : null;
      return [{ role, ifname: i.ifname, ssid: i.config?.ssid ?? '', band }];
    }),
  );
  const lists = await Promise.all(
    ifaces.map(async (i) => {
      // Funkmodul gerade nicht aktiv → keine Geräte
      const res = await c.call<{ results?: IwinfoStation[] }>('iwinfo', 'assoclist', { device: i.ifname }).catch(() => null);
      return (res?.results ?? [])
        .filter((st) => st.mac)
        .map((st): ApStation => {
          const mac = st.mac!.toUpperCase();
          const h = byMac.get(mac);
          return {
            mac,
            name: h?.name ?? null,
            ip: h?.ipaddrs?.[0] ?? null,
            role: i.role,
            ssid: i.ssid,
            band: i.band,
            signalDbm: num(st.signal),
            rxRateKbps: num(st.rx?.rate),
            txRateKbps: num(st.tx?.rate),
            connectedSec: num(st.connected_time),
          };
        });
    }),
  );
  return lists.flat();
}
