import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Docker from 'dockerode';
import type { DockerHost, DockerHostStatus, HostSetup, Topic } from '@elvis/shared';
import type { ElvisConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import type { DockerPki } from './pki.js';
import { renderSetupScript } from './setup-script.js';

export interface DockerConnection {
  host: string;
  port: number;
  ca: string;
  cert: string;
  key: string;
}

export type DockerFactory = (c: DockerConnection) => Docker;

export const defaultDockerFactory: DockerFactory = (c) => new Docker({ protocol: 'https', host: c.host, port: c.port, ca: c.ca, cert: c.cert, key: c.key });

const SETUP_TTL_MS = 15 * 60_000;
const CHECK_TIMEOUT_MS = 8_000;
const POLL_MS = 30_000;
const CERT_WARN_DAYS = 30;

interface HostRow {
  id: number;
  name: string;
  address: string;
  port: number;
  cert_mode: 'elvis' | 'custom';
  cert_expires_at: string | null;
  status: DockerHostStatus;
}

interface RuntimeStatus {
  status: DockerHostStatus;
  error: string | null;
  dockerVersion: string | null;
  arch: 'amd64' | 'arm64' | null;
  os: string | null;
  addonCount: number;
  checkedAt: string | null;
}

interface SetupToken {
  hostId: number;
  certPem: string;
  keyPem: string;
  callbackUrl: string;
  expiresAt: number;
  fetched: boolean;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Zeitüberschreitung nach ${ms / 1000} s`)), ms))]);

export function normalizeArch(a: string | undefined): 'amd64' | 'arm64' | null {
  if (!a) return null;
  if (a === 'x86_64' || a === 'amd64') return 'amd64';
  if (a === 'aarch64' || a === 'arm64') return 'arm64';
  return null;
}

/** Hinterlegte Docker-Hosts, erreichbar über die Engine-API per TLS. */
export class HostService {
  private readonly runtime = new Map<number, RuntimeStatus>();
  private readonly clients = new Map<number, Docker>();
  private readonly tokens = new Map<string, SetupToken>();
  /** Ablaufdatum neu ausgestellter Zertifikate, gültig sobald der Host damit erreichbar ist. */
  private readonly pendingExpiry = new Map<number, string>();
  private timer: NodeJS.Timeout | null = null;
  private readonly customDir: string;

  constructor(
    private readonly db: Db,
    private readonly pki: DockerPki,
    tlsDir: string,
    private readonly config: ElvisConfig['docker'],
    private readonly notify: (topics: Topic[]) => void,
    private readonly factory: DockerFactory = defaultDockerFactory,
  ) {
    this.customDir = join(tlsDir, 'hosts');
  }

  start(): void {
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private rows(): HostRow[] {
    return this.db.prepare('SELECT * FROM docker_hosts ORDER BY name').all() as HostRow[];
  }

  private row(id: number): HostRow {
    const r = this.db.prepare('SELECT * FROM docker_hosts WHERE id = ?').get(id) as HostRow | undefined;
    if (!r) throw new HttpError(404, `Docker-Host ${id} nicht gefunden`);
    return r;
  }

  private toDto(r: HostRow): DockerHost {
    const rt = this.runtime.get(r.id);
    return {
      id: r.id,
      name: r.name,
      address: r.address,
      port: r.port,
      certMode: r.cert_mode,
      status: rt?.status ?? r.status,
      error: rt?.error ?? null,
      dockerVersion: rt?.dockerVersion ?? null,
      arch: rt?.arch ?? null,
      os: rt?.os ?? null,
      addonCount: rt?.addonCount ?? 0,
      certExpiresAt: r.cert_expires_at,
      checkedAt: rt?.checkedAt ?? null,
    };
  }

  list(): DockerHost[] {
    return this.rows().map((r) => this.toDto(r));
  }

  get(id: number): DockerHost {
    return this.toDto(this.row(id));
  }

  /** Neuer Host mit ELVIS-Zertifikat: liefert den Befehl für das Setup-Skript. */
  create(input: { name: string; address: string; port?: number }, baseUrl: string): HostSetup {
    if (this.db.prepare('SELECT 1 FROM docker_hosts WHERE name = ?').get(input.name)) throw new HttpError(409, `Host „${input.name}“ existiert bereits`);
    const info = this.db
      .prepare("INSERT INTO docker_hosts (name, address, port, cert_mode, status, created_at) VALUES (?, ?, ?, 'elvis', 'pending', ?)")
      .run(input.name, input.address, input.port ?? this.config.port, new Date().toISOString());
    const setup = this.renewSetup(Number(info.lastInsertRowid), baseUrl);
    this.notify(['dockerHosts']);
    return setup;
  }

  /** Neues Server-Zertifikat und Einmal-Token (auch zur Zertifikatserneuerung). */
  renewSetup(id: number, baseUrl: string): HostSetup {
    const r = this.row(id);
    if (r.cert_mode !== 'elvis') throw new HttpError(409, 'Host verwendet eigene Zertifikate');
    const bundle = this.pki.issueServerCert(r.name, [r.address, r.name]);
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + SETUP_TTL_MS;
    this.tokens.set(token, {
      hostId: id,
      certPem: bundle.certPem,
      keyPem: bundle.keyPem,
      callbackUrl: `${baseUrl}/api/docker/setup/${token}/done`,
      expiresAt,
      fetched: false,
    });
    // Das neue Ablaufdatum gilt erst, wenn der Host das Zertifikat übernommen hat (siehe setupDone/check).
    this.pendingExpiry.set(id, bundle.expiresAt.toISOString());
    return {
      host: this.get(id),
      command: `curl -fsS ${baseUrl}/api/docker/setup/${token}.sh | sudo sh`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Das Skript kann genau einmal abgerufen werden. */
  setupScript(token: string): string {
    const t = this.tokens.get(token);
    if (!t || t.expiresAt < Date.now()) throw new HttpError(404, 'Einrichtungslink ungültig oder abgelaufen');
    if (t.fetched) throw new HttpError(410, 'Einrichtungslink wurde bereits verwendet');
    t.fetched = true;
    const r = this.row(t.hostId);
    return renderSetupScript({ caPem: this.pki.caPem, certPem: t.certPem, keyPem: t.keyPem, port: r.port, callbackUrl: t.callbackUrl, hostName: r.name });
  }

  async setupDone(token: string): Promise<void> {
    const t = this.tokens.get(token);
    if (!t || !t.fetched) throw new HttpError(404, 'Unbekannter Einrichtungsvorgang');
    this.tokens.delete(token);
    await this.check(t.hostId);
  }

  /** Host mit bereits vorhandener TLS-Konfiguration (eigene CA und Client-Zertifikat). */
  async createCustom(input: { name: string; address: string; port?: number; caPem: string; certPem: string; keyPem: string }): Promise<DockerHost> {
    if (this.db.prepare('SELECT 1 FROM docker_hosts WHERE name = ?').get(input.name)) throw new HttpError(409, `Host „${input.name}“ existiert bereits`);
    const info = this.db
      .prepare("INSERT INTO docker_hosts (name, address, port, cert_mode, status, created_at) VALUES (?, ?, ?, 'custom', 'pending', ?)")
      .run(input.name, input.address, input.port ?? this.config.port, new Date().toISOString());
    const id = Number(info.lastInsertRowid);
    const dir = join(this.customDir, String(id));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'ca.pem'), input.caPem);
    writeFileSync(join(dir, 'cert.pem'), input.certPem);
    writeFileSync(join(dir, 'key.pem'), input.keyPem, { mode: 0o600 });
    await this.check(id);
    this.notify(['dockerHosts']);
    return this.get(id);
  }

  /**
   * Name, Adresse oder Port ändern (z. B. neue IP des Servers). Bei ELVIS-Zertifikaten stehen Adresse und Name im
   * Serverzertifikat – dann muss der Host neu eingerichtet werden (needsSetup).
   */
  update(id: number, patch: { name?: string; address?: string; port?: number }): { host: DockerHost; needsSetup: boolean } {
    const r = this.row(id);
    const name = patch.name ?? r.name;
    const address = patch.address ?? r.address;
    const port = patch.port ?? r.port;
    if (name !== r.name && this.db.prepare('SELECT 1 FROM docker_hosts WHERE name = ? AND id != ?').get(name, id)) throw new HttpError(409, `Host „${name}“ existiert bereits`);
    this.db.prepare('UPDATE docker_hosts SET name = ?, address = ?, port = ? WHERE id = ?').run(name, address, port, id);
    this.clients.delete(id);
    this.notify(['dockerHosts']);
    return { host: this.get(id), needsSetup: r.cert_mode === 'elvis' && (name !== r.name || address !== r.address) };
  }

  remove(id: number, addonsOnHost: number): void {
    this.row(id);
    if (addonsOnHost > 0) throw new HttpError(409, `Auf dem Host ${addonsOnHost === 1 ? 'ist noch 1 Addon' : `sind noch ${addonsOnHost} Addons`} installiert`);
    this.db.prepare('DELETE FROM docker_hosts WHERE id = ?').run(id);
    this.runtime.delete(id);
    this.clients.delete(id);
    rmSync(join(this.customDir, String(id)), { recursive: true, force: true });
    this.notify(['dockerHosts']);
  }

  private connection(r: HostRow): DockerConnection {
    if (r.cert_mode === 'custom') {
      const dir = join(this.customDir, String(r.id));
      return { host: r.address, port: r.port, ca: readFileSync(join(dir, 'ca.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') };
    }
    const c = this.pki.clientBundle;
    return { host: r.address, port: r.port, ca: this.pki.caPem, cert: c.certPem, key: c.keyPem };
  }

  /** Docker-Client für einen Host (ohne Erreichbarkeitsprüfung). */
  client(id: number): Docker {
    let c = this.clients.get(id);
    if (!c) {
      c = this.factory(this.connection(this.row(id)));
      this.clients.set(id, c);
    }
    return c;
  }

  /** Client nur für einen verbundenen Host – für Installationen. */
  readyClient(id: number): { docker: Docker; host: DockerHost } {
    const host = this.get(id);
    if (host.status !== 'ready') throw new HttpError(409, `Docker-Host „${host.name}“ ist nicht verbunden${host.error ? `: ${host.error}` : ''}`);
    return { docker: this.client(id), host };
  }

  async check(id: number): Promise<DockerHost> {
    const r = this.row(id);
    const before = this.runtime.get(id)?.status ?? r.status;
    let rt: RuntimeStatus;
    try {
      const docker = this.client(id);
      const [version, info, containers] = await withTimeout(
        Promise.all([docker.version(), docker.info(), docker.listContainers({ all: true, filters: { label: ['elvis.addon'] } })]),
        CHECK_TIMEOUT_MS,
      );
      const addons = new Set(containers.map((c) => c.Labels['elvis.addon']));
      rt = {
        status: 'ready',
        error: null,
        dockerVersion: version.Version,
        arch: normalizeArch(info.Architecture),
        os: info.OperatingSystem ?? null,
        addonCount: addons.size,
        checkedAt: new Date().toISOString(),
      };
      const expiry = this.pendingExpiry.get(id);
      if (expiry) {
        this.db.prepare('UPDATE docker_hosts SET cert_expires_at = ? WHERE id = ?').run(expiry, id);
        this.pendingExpiry.delete(id);
      }
    } catch (err) {
      // Noch nie verbunden → bleibt „wartet auf Einrichtung“.
      const status: DockerHostStatus = r.status === 'pending' && before === 'pending' ? 'pending' : 'unreachable';
      rt = { ...(this.runtime.get(id) ?? { dockerVersion: null, arch: null, os: null, addonCount: 0 }), status, error: describeError(err), checkedAt: new Date().toISOString() };
      this.clients.delete(id); // bei neuem Zertifikat frisch verbinden
    }
    this.runtime.set(id, rt);
    if (rt.status !== r.status && rt.status !== 'pending') this.db.prepare('UPDATE docker_hosts SET status = ? WHERE id = ?').run(rt.status, id);
    if (rt.status !== before) this.notify(['dockerHosts']);
    return this.get(id);
  }

  async checkAll(): Promise<void> {
    await Promise.all(this.rows().map((r) => this.check(r.id).catch(() => undefined)));
  }

  /** Hosts, deren Zertifikat bald abläuft. */
  expiringCertificates(): DockerHost[] {
    const limit = Date.now() + CERT_WARN_DAYS * 86_400_000;
    return this.list().filter((h) => h.certExpiresAt && new Date(h.certExpiresAt).getTime() < limit);
  }
}

export function describeError(err: unknown): string {
  const e = err as { code?: string; message?: string; reason?: string; json?: { message?: string } };
  if (e?.code === 'ECONNREFUSED') return 'Verbindung abgelehnt (Docker-TLS-Port nicht offen?)';
  if (e?.code === 'EHOSTUNREACH' || e?.code === 'ENETUNREACH') return 'Host nicht erreichbar';
  if (e?.code === 'ETIMEDOUT') return 'Zeitüberschreitung';
  if (e?.code && /CERT|SSL|TLS|SELF_SIGNED|ERR_TLS/.test(e.code)) return `TLS-Fehler (${e.code})`;
  return e?.json?.message ?? e?.message ?? String(err);
}
