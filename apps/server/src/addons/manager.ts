import type Docker from 'dockerode';
import tar from 'tar-stream';
import {
  compareVersions,
  SCHEDULE_INTERVALS,
  defaultOptionValues,
  jobSteps,
  optionsSchema,
  renderTemplate,
  type AddonContainerState,
  type AddonJobState,
  type AddonJobStepState,
  type AddonManifest,
  type AddonOperation,
  type AddonStatus,
  type InstalledAddon,
  type OptionValues,
  type ScheduleInterval,
  type TemplateContext,
  type Topic,
} from '@elvis/shared';
import type { MapSourceConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import { describeError, type HostService } from '../docker/hosts.js';
import type { TileService } from '../services/tiles.js';
import { JobRuns, followLogs, type JobRunRow } from './jobs.js';
import type { GeocoderProvision, GeocoderService } from '../services/geocoder.js';
import type { OfficeProvision, OfficeService } from '../services/office.js';
import type { PrintServerProvision, PrintService } from '../services/printing.js';
import type { VideoProvision, VideoSourceService } from '../services/videos.js';
import { createProgressParser, nextScheduledRun, overallPercent } from './progress.js';
import type { RepoService } from './repos.js';
import {
  HELPER_IMAGE,
  LABEL_ADDON,
  LABEL_CONTAINER,
  LABEL_JOB,
  LABEL_MANAGED,
  addonBuilds,
  addonImages,
  addonVolumes,
  builtImageTag,
  containerSpec,
  demuxLogs,
  jobStepName,
  jobStepSpec,
  volumeName,
} from './spec.js';

interface AddonRow {
  id: string;
  repository_id: string;
  host_id: number;
  version: string;
  manifest: string;
  options: string;
  status: AddonStatus;
  error: string | null;
  installed_at: string;
  updated_at: string;
}

/** Laufender Job mit Fortschritt je Schritt (nur im Speicher; der Verlauf steht in addon_job_runs). */
interface LiveRun {
  runId: number;
  steps: (AddonJobStepState & { weight: number })[];
}

export type AuditFn = (e: { operator: string; target: string; action: string; params: string; success: boolean; message: string }) => void;

const RECONCILE_MS = 30_000;
const SCHEDULE_MS = 5 * 60_000;
const NOTIFY_THROTTLE_MS = 1_000;
const LOG_TAIL_MAX = 2000;

const follow = (docker: Docker, stream: NodeJS.ReadableStream) =>
  new Promise<void>((resolve, reject) => docker.modem.followProgress(stream, (err: Error | null) => (err ? reject(err) : resolve())));

/**
 * Installation und Betrieb von Addons auf den Docker-Hosts. Lange Vorgänge laufen im Hintergrund;
 * der Fortschritt steht als Schrittliste in `operation` (Installation, Konfiguration) bzw. je Job
 * mit Prozentangaben und wird per WebSocket-Invalidierung gemeldet.
 */
export class AddonManager {
  private readonly ops = new Map<string, AddonOperation>();
  private readonly live = new Map<string, LiveRun>();
  private readonly containers = new Map<string, AddonContainerState[]>();
  private readonly busy = new Set<string>();
  private readonly runs: JobRuns;
  private readonly notifyTimers = new Map<string, NodeJS.Timeout>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly db: Db,
    private readonly hosts: HostService,
    private readonly repos: RepoService,
    private readonly tiles: TileService,
    private readonly notify: (topics: Topic[]) => void,
    private readonly audit: AuditFn,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.runs = new JobRuns(db);
  }

  start(): void {
    this.runs.markInterrupted();
    void this.reconcileAll();
    this.timers = [setInterval(() => void this.reconcileAll(), RECONCILE_MS), setInterval(() => void this.runScheduledJobs(), SCHEDULE_MS)];
    setTimeout(() => void this.runScheduledJobs(), 10_000);
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.notifyTimers.forEach(clearTimeout);
  }

  // --- Lesen ---

  private rows(): AddonRow[] {
    return this.db.prepare('SELECT * FROM addons ORDER BY id').all() as AddonRow[];
  }

  private row(id: string): AddonRow {
    const r = this.db.prepare('SELECT * FROM addons WHERE id = ?').get(id) as AddonRow | undefined;
    if (!r) throw new HttpError(404, `Addon „${id}“ ist nicht installiert`);
    return r;
  }

  countOnHost(hostId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM addons WHERE host_id = ?').get(hostId) as { n: number }).n;
  }

  installedVersions(): Map<string, string> {
    return new Map(this.rows().map((r) => [r.id, r.version]));
  }

  list(): InstalledAddon[] {
    return this.rows().map((r) => this.toDto(r));
  }

  get(id: string): InstalledAddon {
    return this.toDto(this.row(id));
  }

  private liveKey = (addonId: string, jobId: string) => `${addonId}/${jobId}`;

  private jobRunning(id: string): boolean {
    return [...this.live.keys()].some((k) => k.startsWith(`${id}/`));
  }

  /** Zeitplan eines Jobs mit den aktuellen Optionswerten. */
  private schedule(r: AddonRow, manifest: AddonManifest, jobId: string): { interval: ScheduleInterval; hour: number } | null {
    const s = manifest.jobs[jobId]?.schedule;
    if (!s) return null;
    try {
      const ctx = this.ctx(manifest, JSON.parse(r.options), r.host_id);
      const interval = renderTemplate(s.interval, ctx) as ScheduleInterval;
      const hour = typeof s.hour === 'number' ? s.hour : Number(renderTemplate(s.hour, ctx));
      if (!SCHEDULE_INTERVALS.includes(interval) || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
      return { interval, hour };
    } catch {
      return null;
    }
  }

  private jobState(r: AddonRow, manifest: AddonManifest, jobId: string): AddonJobState {
    const job = manifest.jobs[jobId]!;
    const live = this.live.get(this.liveKey(r.id, jobId));
    const latest = this.runs.latest(r.id, jobId);
    const success = this.runs.lastSuccess(r.id, jobId);
    const sched = this.schedule(r, manifest, jobId);
    const next = sched ? nextScheduledRun(sched.interval, sched.hour, latest ? new Date(latest.started_at) : null, new Date(r.installed_at)) : null;
    const saved = latest ? (JSON.parse(latest.steps || '[]') as AddonJobStepState[]) : [];
    const steps: AddonJobStepState[] = live
      ? live.steps.map(({ weight: _, ...s }) => s)
      : jobSteps(job).map((s, i) => saved[i] ?? { label: s.label, state: 'pending', percent: null, message: null });
    return {
      id: jobId,
      label: job.label,
      description: job.description,
      state: live ? 'running' : (latest?.status as AddonJobState['state'] | undefined) ?? 'idle',
      startedAt: latest?.started_at ?? null,
      finishedAt: live ? null : (latest?.finished_at ?? null),
      exitCode: live ? null : (latest?.exit_code ?? null),
      triggeredBy: latest?.triggered_by ?? null,
      percent: live ? overallPercent(live.steps) : latest?.status === 'succeeded' ? 100 : null,
      steps,
      schedule: sched ? { ...sched, nextRun: next?.toISOString() ?? null } : null,
      lastSuccessAt: success?.finished_at ?? null,
    };
  }

  private toDto(r: AddonRow): InstalledAddon {
    const manifest = JSON.parse(r.manifest) as AddonManifest;
    const options = JSON.parse(r.options) as OptionValues;
    const passwords = Object.entries(manifest.options).filter(([, o]) => o.type === 'password').map(([k]) => k);
    let available: string | null = null;
    try {
      const repo = this.repos.manifest(r.id).manifest;
      if (compareVersions(repo.version, r.version) > 0) available = repo.version;
    } catch {
      /* nicht mehr im Repo */
    }
    let hostName = `#${r.host_id}`;
    try {
      hostName = this.hosts.get(r.host_id).name;
    } catch {
      /* Host entfernt */
    }
    return {
      id: r.id,
      name: manifest.name,
      repositoryId: r.repository_id,
      hostId: r.host_id,
      hostName,
      version: r.version,
      availableVersion: available,
      options: Object.fromEntries(Object.entries(options).map(([k, v]) => [k, passwords.includes(k) ? '' : v])),
      secretsSet: passwords.filter((k) => options[k]),
      status: r.status,
      error: r.error,
      containers: this.containers.get(r.id) ?? [],
      jobs: Object.keys(manifest.jobs).map((jobId) => this.jobState(r, manifest, jobId)),
      operation: this.ops.get(r.id) ?? null,
      manifest,
      installedAt: r.installed_at,
      updatedAt: r.updated_at,
    };
  }

  // --- Vorgänge ---

  private setStatus(id: string, status: AddonStatus, error: string | null = null): void {
    this.db.prepare('UPDATE addons SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, new Date().toISOString(), id);
    this.notify(['addons']);
  }

  /** Fortschrittsmeldungen bündeln: höchstens eine Invalidierung pro Sekunde und Addon. */
  private notifySoon(id: string): void {
    if (this.notifyTimers.has(id)) return;
    this.notifyTimers.set(
      id,
      setTimeout(() => {
        this.notifyTimers.delete(id);
        this.notify(['addons']);
      }, NOTIFY_THROTTLE_MS),
    );
  }

  /** Startet einen Hintergrundvorgang mit Schrittliste; ein Addon hat höchstens einen laufenden Vorgang. */
  private begin(id: string, kind: AddonOperation['kind'], label: string): AddonOperation {
    if (this.busy.has(id)) throw new HttpError(409, 'Für dieses Addon läuft bereits ein Vorgang');
    this.busy.add(id);
    const op: AddonOperation = { kind, label, steps: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
    this.ops.set(id, op);
    this.notify(['addons']);
    return op;
  }

  private async step<T>(op: AddonOperation, label: string, fn: () => Promise<T>): Promise<T> {
    const s = { label, state: 'running' as AddonOperation['steps'][number]['state'], detail: undefined as string | undefined };
    op.steps.push(s);
    this.notify(['addons']);
    try {
      const result = await fn();
      s.state = 'done';
      return result;
    } catch (err) {
      s.state = 'error';
      s.detail = describeError(err);
      throw err;
    } finally {
      this.notify(['addons']);
    }
  }

  private finish(id: string, op: AddonOperation, err: unknown, operator: string, action: string, params: object): void {
    op.finishedAt = new Date().toISOString();
    op.error = err ? describeError(err) : null;
    this.busy.delete(id);
    this.audit({ operator, target: `addon:${id}`, action, params: JSON.stringify(params), success: !err, message: op.error ?? '' });
    this.notify(['addons']);
    // Erst jetzt darf der Abgleich den Status aus den Containern ableiten (während des Vorgangs bleibt er stehen).
    if (!err) void this.reconcile(id).catch(() => undefined);
    this.refreshHostOf(id);
  }

  private validateOptions(m: AddonManifest, input: OptionValues, previous?: OptionValues): OptionValues {
    // Leere Passwortfelder bedeuten „unverändert“.
    const merged: OptionValues = { ...defaultOptionValues(m.options), ...input };
    for (const [k, o] of Object.entries(m.options)) {
      if (o.type === 'password' && merged[k] === '' && previous?.[k]) merged[k] = previous[k]!;
    }
    const parsed = optionsSchema(m.options).safeParse(merged);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${m.options[String(i.path[0])]?.label ?? i.path.join('.')}: ${i.message}`).join('; '));
    return parsed.data;
  }

  private ctx(m: AddonManifest, options: OptionValues, hostId: number): TemplateContext {
    const h = this.hosts.get(hostId);
    return { options, addon: { id: m.id, version: m.version }, host: { address: h.address, name: h.name } };
  }

  private assertNoJobRunning(id: string): void {
    if (this.jobRunning(id)) throw new HttpError(409, 'Es läuft gerade ein Job – bitte dessen Ende abwarten');
  }

  install(addonId: string, hostId: number, input: OptionValues, operator: string): InstalledAddon {
    if (this.db.prepare('SELECT 1 FROM addons WHERE id = ?').get(addonId)) throw new HttpError(409, `Addon „${addonId}“ ist bereits installiert`);
    const { manifest, repositoryId } = this.repos.manifest(addonId);
    const { host } = this.hosts.readyClient(hostId);
    if (host.arch && !manifest.arch.includes(host.arch)) throw new HttpError(409, `${manifest.name} unterstützt ${manifest.arch.join('/')}, Host „${host.name}“ ist ${host.arch}`);
    const options = this.validateOptions(manifest, input);
    // Platzhalter vorab prüfen, damit Tippfehler im Manifest nicht erst mitten in der Installation auffallen.
    const ctx = this.ctx(manifest, options, hostId);
    manifest.containers.forEach((c) => containerSpec(manifest, c, ctx));

    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO addons (id, repository_id, host_id, version, manifest, options, status, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'installing', ?, ?)")
      .run(addonId, repositoryId, hostId, manifest.version, JSON.stringify(manifest), JSON.stringify(options), now, now);
    const op = this.begin(addonId, 'install', `Installation ${manifest.name} ${manifest.version}`);
    void this.deploy(addonId, manifest, options, hostId, op, true)
      .then(() => {
        this.finish(addonId, op, null, operator, 'install', { host: hostId, version: manifest.version });
        // Erstbefüllung, z. B. Kartendaten erzeugen
        for (const [jobId, job] of Object.entries(manifest.jobs)) {
          if (job.runOnInstall) this.runJob(addonId, jobId, `${operator} (Installation)`);
        }
      })
      .catch((err) => {
        this.setStatus(addonId, 'error', describeError(err));
        this.finish(addonId, op, err, operator, 'install', { host: hostId, version: manifest.version });
      });
    return this.get(addonId);
  }

  reconfigure(id: string, input: OptionValues, operator: string): InstalledAddon {
    const r = this.row(id);
    this.assertNoJobRunning(id);
    const manifest = JSON.parse(r.manifest) as AddonManifest;
    const options = this.validateOptions(manifest, input, JSON.parse(r.options));
    this.hosts.readyClient(r.host_id);
    const op = this.begin(id, 'reconfigure', 'Konfiguration übernehmen');
    this.db.prepare('UPDATE addons SET options = ? WHERE id = ?').run(JSON.stringify(options), id);
    this.setStatus(id, 'updating');
    void this.deploy(id, manifest, options, r.host_id, op, false)
      .then(() => this.finish(id, op, null, operator, 'reconfigure', {}))
      .catch((err) => {
        this.setStatus(id, 'error', describeError(err));
        this.finish(id, op, err, operator, 'reconfigure', {});
      });
    return this.get(id);
  }

  update(id: string, operator: string): InstalledAddon {
    const r = this.row(id);
    this.assertNoJobRunning(id);
    const { manifest } = this.repos.manifest(id);
    if (manifest.version === r.version) throw new HttpError(409, 'Bereits auf dem aktuellen Stand');
    // Bestehende Werte übernehmen, neue Optionen mit Default, entfallene verwerfen.
    const previous = JSON.parse(r.options) as OptionValues;
    const carried = Object.fromEntries(Object.keys(manifest.options).filter((k) => k in previous).map((k) => [k, previous[k]!]));
    const options = this.validateOptions(manifest, carried, previous);
    this.hosts.readyClient(r.host_id);
    const op = this.begin(id, 'update', `Aktualisierung ${r.version} → ${manifest.version}`);
    this.setStatus(id, 'updating');
    void this.deploy(id, manifest, options, r.host_id, op, false)
      .then(() => {
        this.db.prepare('UPDATE addons SET version = ?, manifest = ?, options = ? WHERE id = ?').run(manifest.version, JSON.stringify(manifest), JSON.stringify(options), id);
        this.finish(id, op, null, operator, 'update', { from: r.version, to: manifest.version });
      })
      .catch((err) => {
        this.setStatus(id, 'error', describeError(err));
        this.finish(id, op, err, operator, 'update', { from: r.version, to: manifest.version });
      });
    return this.get(id);
  }

  /** Images bereitstellen, Volumes anlegen, Dateien kopieren, Container (neu) erstellen und starten. */
  private async deploy(id: string, m: AddonManifest, options: OptionValues, hostId: number, op: AddonOperation, fresh: boolean): Promise<void> {
    const { docker } = this.hosts.readyClient(hostId);
    const ctx = this.ctx(m, options, hostId);
    const created: string[] = [];
    try {
      for (const name of addonBuilds(m)) await this.step(op, `Image bauen: ${name}${m.builds[name]?.label ? ` (${m.builds[name]!.label})` : ''}`, () => this.buildImage(docker, m, name));
      for (const image of addonImages(m)) await this.step(op, `Image ${image}`, () => this.ensureImage(docker, hostId, image));
      await this.step(op, 'Volumes anlegen', async () => {
        for (const name of addonVolumes(m)) await docker.createVolume({ Name: name, Labels: { [LABEL_MANAGED]: 'true', [LABEL_ADDON]: id } });
      });
      if (m.files) await this.step(op, `Dateien kopieren (${m.files.paths.length})`, () => this.copyFiles(docker, m));
      await this.step(op, 'Alte Container entfernen', () => this.removeContainers(docker, id, false));
      for (const c of m.containers) {
        const waiting = !!c.waitForJob && !this.runs.lastSuccess(id, c.waitForJob);
        await this.step(op, waiting ? `Container ${c.name} anlegen (startet nach „${m.jobs[c.waitForJob!]!.label}“)` : `Container ${c.name} starten`, async () => {
          const container = await docker.createContainer(containerSpec(m, c, ctx));
          created.push(container.id);
          if (!waiting) await container.start();
        });
      }
    } catch (err) {
      // Zurückrollen: angelegte Container entfernen, bei Erstinstallation auch die Volumes.
      for (const cid of created) await docker.getContainer(cid).remove({ force: true }).catch(() => undefined);
      if (fresh) for (const v of addonVolumes(m)) await docker.getVolume(v).remove().catch(() => undefined);
      throw err;
    }
    await this.reconcile(id);
  }

  /** Mitgelieferte Dateien per Hilfscontainer ins Volume schreiben (Docker-API: Archiv hochladen). */
  private async copyFiles(docker: Docker, m: AddonManifest): Promise<void> {
    const spec = m.files!;
    const files = await this.repos.addonFiles(m.id);
    const pack = tar.pack();
    const base = spec.target.replace(/^\/+|\/+$/g, '');
    const dirs = new Set<string>();
    for (const f of files) {
      const parts = `${base}/${f.path}`.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    for (const d of [...dirs].sort()) pack.entry({ name: `${d}/`, type: 'directory', mode: 0o755 });
    for (const f of files) pack.entry({ name: `${base}/${f.path}`.replace(/^\/+/, ''), mode: f.path.endsWith('.sh') ? 0o755 : 0o644 }, f.data);
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of pack as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));

    const helper = await docker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ['true'],
      Labels: { [LABEL_MANAGED]: 'true', [LABEL_ADDON]: m.id, 'elvis.addon.helper': 'files' },
      HostConfig: { Binds: [`${volumeName(m.id, spec.volume)}:/volume`] },
    });
    try {
      await helper.putArchive(Buffer.concat(chunks), { path: '/volume' });
    } finally {
      await helper.remove({ force: true }).catch(() => undefined);
    }
  }

  /**
   * Image aus dem Build-Kontext des Addons auf dem Zielhost bauen (Docker-API, Kontext als tar).
   * Vorhandene Images derselben Addon-Version werden nicht neu gebaut.
   */
  private async buildImage(docker: Docker, m: AddonManifest, name: string): Promise<void> {
    const tag = builtImageTag(m, name);
    if (await docker.getImage(tag).inspect().then(() => true, () => false)) return;
    const build = m.builds[name];
    if (!build) throw new Error(`Unbekanntes Build-Image „${name}“`);
    const files = await this.repos.addonFiles(m.id, build.files.map((f) => `${build.context.replace(/\/+$/, '')}/${f}`));
    const pack = tar.pack();
    files.forEach((f, i) => pack.entry({ name: build.files[i]!, mode: f.path.endsWith('.sh') ? 0o755 : 0o644 }, f.data));
    pack.finalize();
    const stream = await docker.buildImage(pack as unknown as NodeJS.ReadableStream, { t: tag, labels: { [LABEL_MANAGED]: 'true', [LABEL_ADDON]: m.id }, rm: true, forcerm: true });
    const tail: string[] = [];
    await new Promise<void>((resolve, reject) =>
      docker.modem.followProgress(
        stream,
        (err: unknown) => (err ? reject(new Error(`Build fehlgeschlagen: ${typeof err === 'string' ? err : (err as Error).message}\n${tail.join('\n')}`)) : resolve()),
        (evt: { stream?: string; error?: string }) => {
          const line = (evt.stream ?? evt.error ?? '').trim();
          if (line) tail.push(...line.split('\n').slice(-5));
          tail.splice(0, Math.max(0, tail.length - 15));
        },
      ),
    );
  }

  /** Image auf dem Zielhost sicherstellen: vorhanden → ziehen → von einem anderen Host übertragen. */
  private async ensureImage(docker: Docker, hostId: number, image: string): Promise<void> {
    if (await docker.getImage(image).inspect().then(() => true, () => false)) return;
    let pullError: unknown;
    try {
      await new Promise<void>((resolve, reject) =>
        docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => (err ? reject(err) : follow(docker, stream).then(resolve, reject))),
      );
      return;
    } catch (err) {
      pullError = err;
    }
    for (const other of this.hosts.list()) {
      if (other.id === hostId || other.status !== 'ready') continue;
      const src = this.hosts.client(other.id);
      if (!(await src.getImage(image).inspect().then(() => true, () => false))) continue;
      const tarball = await src.getImage(image).get();
      const progress = await docker.loadImage(tarball as unknown as NodeJS.ReadableStream);
      await follow(docker, progress);
      return;
    }
    throw new Error(`Image nicht verfügbar – Download fehlgeschlagen (${describeError(pullError)}) und auf keinem anderen Host vorhanden`);
  }

  private async removeContainers(docker: Docker, id: string, includeJobs: boolean): Promise<void> {
    const list = await docker.listContainers({ all: true, filters: { label: [`${LABEL_ADDON}=${id}`] } });
    for (const c of list) {
      if (!includeJobs && (c.Labels[LABEL_JOB] || c.Labels['elvis.addon.helper'])) continue;
      await docker.getContainer(c.Id).remove({ force: true });
    }
  }

  /** Addon-Anzahl auf der Host-Seite sofort aktualisieren statt erst bei der nächsten Prüfung. */
  private refreshHostOf(id: string, hostId?: number): void {
    const h = hostId ?? (this.db.prepare('SELECT host_id FROM addons WHERE id = ?').get(id) as { host_id: number } | undefined)?.host_id;
    if (h !== undefined) void this.hosts.check(h).catch(() => undefined);
  }

  async uninstall(id: string, removeData: boolean, operator: string): Promise<void> {
    const r = this.row(id);
    const manifest = JSON.parse(r.manifest) as AddonManifest;
    const op = this.begin(id, 'uninstall', 'Deinstallation');
    this.setStatus(id, 'removing');
    try {
      const host = this.hosts.get(r.host_id);
      if (host.status === 'ready') {
        const docker = this.hosts.client(r.host_id);
        await this.step(op, 'Container entfernen', () => this.removeContainers(docker, id, true));
        if (removeData) {
          await this.step(op, 'Daten (Volumes) löschen', async () => {
            for (const v of addonVolumes(manifest)) await docker.getVolume(v).remove().catch(() => undefined);
          });
        }
      } else if (removeData) {
        throw new HttpError(409, `Host „${host.name}“ nicht erreichbar – Daten können nicht gelöscht werden`);
      }
      this.db.prepare('DELETE FROM addons WHERE id = ?').run(id);
      this.runs.deleteForAddon(id);
      for (const k of [...this.live.keys()]) if (k.startsWith(`${id}/`)) this.live.delete(k);
      this.ops.delete(id);
      this.containers.delete(id);
      this.busy.delete(id);
      this.audit({ operator, target: `addon:${id}`, action: 'uninstall', params: JSON.stringify({ removeData }), success: true, message: '' });
      this.updateMapSources();
      this.refreshHostOf(id, r.host_id);
      this.notify(['addons']);
    } catch (err) {
      this.setStatus(id, 'error', describeError(err));
      this.finish(id, op, err, operator, 'uninstall', { removeData });
      throw err;
    }
  }

  async power(id: string, action: 'start' | 'stop' | 'restart', operator: string): Promise<InstalledAddon> {
    const r = this.row(id);
    if (this.busy.has(id)) throw new HttpError(409, 'Für dieses Addon läuft bereits ein Vorgang');
    const manifest = JSON.parse(r.manifest) as AddonManifest;
    const { docker } = this.hosts.readyClient(r.host_id);
    const list = await docker.listContainers({ all: true, filters: { label: [`${LABEL_ADDON}=${id}`, LABEL_CONTAINER] } });
    const skipped: string[] = [];
    try {
      for (const c of list) {
        const def = manifest.containers.find((x) => x.name === c.Labels[LABEL_CONTAINER]);
        if (action !== 'stop' && def?.waitForJob && !this.runs.lastSuccess(id, def.waitForJob)) {
          skipped.push(def.name);
          continue;
        }
        const container = docker.getContainer(c.Id);
        if (action === 'start' && c.State !== 'running') await container.start();
        if (action === 'stop' && c.State === 'running') await container.stop();
        if (action === 'restart') await container.restart();
      }
      this.audit({ operator, target: `addon:${id}`, action, params: '{}', success: true, message: skipped.length ? `wartet auf Job: ${skipped.join(', ')}` : '' });
    } catch (err) {
      this.audit({ operator, target: `addon:${id}`, action, params: '{}', success: false, message: describeError(err) });
      throw new HttpError(502, describeError(err));
    }
    await this.reconcile(id);
    return this.get(id);
  }

  // --- Jobs ---

  /** Startet einen Job im Hintergrund; Fortschritt je Schritt kommt aus den Container-Protokollen. */
  runJob(id: string, jobId: string, triggeredBy: string): InstalledAddon {
    const r = this.row(id);
    const manifest = JSON.parse(r.manifest) as AddonManifest;
    const job = manifest.jobs[jobId];
    if (!job) throw new HttpError(404, `Unbekannter Job „${jobId}“`);
    if (this.live.has(this.liveKey(id, jobId))) throw new HttpError(409, 'Job läuft bereits');
    if (this.busy.has(id)) throw new HttpError(409, 'Für dieses Addon läuft bereits ein Vorgang');
    this.hosts.readyClient(r.host_id);
    const runId = this.runs.start(id, jobId, triggeredBy);
    const live: LiveRun = { runId, steps: jobSteps(job).map((s) => ({ label: s.label, state: 'pending', percent: null, message: null, weight: s.weight })) };
    this.live.set(this.liveKey(id, jobId), live);
    this.notify(['addons']);
    void this.executeJob(r, manifest, jobId, live, triggeredBy);
    return this.get(id);
  }

  private async executeJob(r: AddonRow, manifest: AddonManifest, jobId: string, live: LiveRun, triggeredBy: string): Promise<void> {
    const job = manifest.jobs[jobId]!;
    const steps = jobSteps(job);
    let exitCode: number | null = null;
    let error: string | null = null;
    let recorded = false;
    const record = () => {
      this.runs.finish(live.runId, error ? 'failed' : 'succeeded', exitCode, error ?? '', live.steps.map(({ weight: _, ...st }) => st));
      recorded = true;
    };
    try {
      const { docker } = this.hosts.readyClient(r.host_id);
      const ctx = this.ctx(manifest, JSON.parse(r.options), r.host_id);
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const st = live.steps[i]!;
        st.state = 'running';
        st.message = `Image ${step.image} bereitstellen`;
        this.notifySoon(r.id);
        await this.ensureImage(docker, r.host_id, step.image);
        st.message = null;
        // Voriger Lauf: Container entfernen – sein Protokoll war bis hierhin abrufbar.
        await docker.getContainer(jobStepName(r.id, jobId, i)).remove({ force: true }).catch(() => undefined);
        const container = await docker.createContainer(jobStepSpec(manifest, jobId, i, ctx));
        await container.start();
        const parser = createProgressParser(step.progress);
        const logs = followLogs(docker, container, (line) => {
          parser.feed(line);
          const p = parser.state;
          if (p.percent !== null) st.percent = p.percent;
          if (p.message) st.message = p.message;
          this.notifySoon(r.id);
        }).catch(() => undefined);
        const result = (await container.wait()) as { StatusCode: number };
        await logs;
        if (result.StatusCode !== 0) {
          st.state = 'error';
          exitCode = result.StatusCode;
          throw new Error(`Schritt „${step.label}“ mit Code ${result.StatusCode} beendet – siehe Protokoll`);
        }
        st.state = 'done';
        st.percent = 100;
      }
      exitCode = 0;
      // Erfolg zuerst speichern: Container, die auf diesen Job warten, dürfen danach starten.
      record();
      if (job.restartAfter) await this.startContainers(r.id, manifest, docker);
    } catch (err) {
      if (recorded) {
        // Job war erfolgreich, nur der (Neu-)Start der Container scheiterte
        this.setStatus(r.id, 'error', `Neustart nach „${job.label}“ fehlgeschlagen: ${describeError(err)}`);
        return;
      }
      error = describeError(err);
      const running = live.steps.find((s) => s.state === 'running' || s.state === 'error');
      if (running) {
        running.state = 'error';
        running.message = error;
      }
    } finally {
      if (!recorded) record();
      this.live.delete(this.liveKey(r.id, jobId));
      this.audit({ operator: triggeredBy, target: `addon:${r.id}`, action: `job:${jobId}`, params: '{}', success: !error, message: error ?? '' });
      this.notify(['addons']);
      await this.reconcile(r.id).catch(() => undefined);
    }
  }

  /** Nach erfolgreichem Job: Container starten bzw. neu starten (z. B. damit neue Daten geladen werden). */
  private async startContainers(id: string, manifest: AddonManifest, docker: Docker): Promise<void> {
    const list = await docker.listContainers({ all: true, filters: { label: [`${LABEL_ADDON}=${id}`, LABEL_CONTAINER] } });
    for (const c of list) {
      const def = manifest.containers.find((x) => x.name === c.Labels[LABEL_CONTAINER]);
      if (def?.waitForJob && !this.runs.lastSuccess(id, def.waitForJob)) continue;
      const container = docker.getContainer(c.Id);
      if (c.State === 'running') await container.restart();
      else await container.start();
    }
  }

  /** Zeitgesteuerte Jobs ausführen, deren Termin erreicht ist. */
  async runScheduledJobs(): Promise<string[]> {
    const started: string[] = [];
    for (const r of this.rows()) {
      if (this.busy.has(r.id) || r.status === 'installing' || r.status === 'removing') continue;
      const manifest = JSON.parse(r.manifest) as AddonManifest;
      for (const jobId of Object.keys(manifest.jobs)) {
        const sched = this.schedule(r, manifest, jobId);
        if (!sched || this.live.has(this.liveKey(r.id, jobId))) continue;
        const latest: JobRunRow | null = this.runs.latest(r.id, jobId);
        const next = nextScheduledRun(sched.interval, sched.hour, latest ? new Date(latest.started_at) : null, new Date(r.installed_at));
        if (!next || this.now() < next) continue;
        try {
          this.runJob(r.id, jobId, 'Zeitplan');
          started.push(`${r.id}/${jobId}`);
        } catch {
          /* Host nicht erreichbar o. Ä. – beim nächsten Durchlauf erneut versuchen */
        }
      }
    }
    return started;
  }

  /** Protokoll eines Containers (`name`) oder Jobs (`job:<id>`, alle Schritte nacheinander). */
  async logs(id: string, target: string, tail: number): Promise<string> {
    const r = this.row(id);
    const manifest = JSON.parse(r.manifest) as AddonManifest;
    const { docker } = this.hosts.readyClient(r.host_id);
    const read = async (name: string) => {
      try {
        const buf = (await docker.getContainer(name).logs({ stdout: true, stderr: true, timestamps: true, tail: Math.min(tail, LOG_TAIL_MAX), follow: false })) as unknown as Buffer;
        return demuxLogs(Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf)));
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 404) return null;
        throw new HttpError(502, describeError(err));
      }
    };
    if (target.startsWith('job:')) {
      const jobId = target.slice(4);
      const job = manifest.jobs[jobId];
      if (!job) throw new HttpError(404, `Unbekannter Job „${jobId}“`);
      const parts: string[] = [];
      const steps = jobSteps(job);
      for (let i = 0; i < steps.length; i++) {
        const text = await read(jobStepName(id, jobId, i));
        if (text === null) continue;
        parts.push(steps.length > 1 ? `=== Schritt ${i + 1}: ${steps[i]!.label} ===\n${text}` : text);
      }
      return parts.join('\n');
    }
    const def = manifest.containers.find((c) => c.name === target);
    if (!def) throw new HttpError(404, `Unbekannter Container „${target}“`);
    return (await read(containerSpec(manifest, def, this.ctx(manifest, JSON.parse(r.options), r.host_id)).name)) ?? '';
  }

  // --- Abgleich mit dem tatsächlichen Zustand ---

  async reconcile(id: string): Promise<void> {
    const r = this.row(id);
    const manifest = JSON.parse(r.manifest) as AddonManifest;
    let status: AddonStatus = r.status;
    let error: string | null = r.error;
    try {
      const { docker } = this.hosts.readyClient(r.host_id);
      const list = await docker.listContainers({ all: true, filters: { label: [`${LABEL_ADDON}=${id}`, LABEL_CONTAINER] } });
      const states: AddonContainerState[] = manifest.containers.map((c) => {
        const found = list.find((x) => x.Labels[LABEL_CONTAINER] === c.name);
        return { name: c.name, state: found?.State ?? 'missing', status: found?.Status ?? 'Container fehlt' };
      });
      this.containers.set(id, states);
      if (!this.busy.has(id)) {
        const waiting = manifest.containers.filter((c, i) => c.waitForJob && !this.runs.lastSuccess(id, c.waitForJob) && states[i]!.state !== 'running');
        const relevant = states.filter((_, i) => !waiting.includes(manifest.containers[i]!));
        const running = relevant.filter((s) => s.state === 'running').length;
        if (states.some((s) => s.state === 'missing')) [status, error] = ['error', 'Container fehlt – Konfiguration erneut übernehmen'];
        else if (states.some((s) => s.state === 'restarting')) [status, error] = ['error', 'Container startet wiederholt neu – Protokoll prüfen'];
        else if (waiting.length && running === relevant.length) {
          const jobs = [...new Set(waiting.map((c) => manifest.jobs[c.waitForJob!]!.label))];
          [status, error] = ['waiting', `Wartet auf erfolgreichen Lauf von „${jobs.join('“, „')}“`];
        } else if (running === relevant.length) [status, error] = ['running', null];
        else if (running === 0) [status, error] = [r.status === 'error' ? 'error' : 'stopped', r.status === 'error' ? r.error : null];
        else [status, error] = ['partial', null];
      }
    } catch (err) {
      if (!this.busy.has(id)) error = `Host nicht erreichbar: ${describeError(err)}`;
    }
    if (status !== r.status || error !== r.error) this.setStatus(id, status, error);
    this.updateMapSources();
  }

  async reconcileAll(): Promise<void> {
    await Promise.all(this.rows().map((r) => this.reconcile(r.id).catch(() => undefined)));
  }

  private videos: VideoSourceService | null = null;

  /** Videoquellen laufender Addons (provides.videoSources) an diesen Dienst melden */
  attachVideos(videos: VideoSourceService): void {
    this.videos = videos;
    this.updateMapSources();
  }

  private geocoder: GeocoderService | null = null;

  /** Ortssuche laufender Addons (provides.geocoders) an diesen Dienst melden */
  attachGeocoder(geocoder: GeocoderService): void {
    this.geocoder = geocoder;
    this.updateMapSources();
  }

  private office: OfficeService | null = null;

  /** Office-Server laufender Addons (provides.office) an diesen Dienst melden */
  attachOffice(office: OfficeService): void {
    this.office = office;
    this.updateMapSources();
  }

  private printing: PrintService | null = null;

  /** Druckserver laufender Addons (provides.printServers) an diesen Dienst melden */
  attachPrinting(printing: PrintService): void {
    this.printing = printing;
    this.updateMapSources();
  }

  private updateMapSources(): void {
    const sources: MapSourceConfig[] = [];
    const videos: VideoProvision[] = [];
    const geocoders: GeocoderProvision[] = [];
    const offices: OfficeProvision[] = [];
    const printServers: PrintServerProvision[] = [];
    for (const r of this.rows()) {
      if (r.status !== 'running') continue;
      const manifest = JSON.parse(r.manifest) as AddonManifest;
      let ctx: TemplateContext;
      try {
        ctx = this.ctx(manifest, JSON.parse(r.options), r.host_id);
      } catch {
        continue;
      }
      for (const s of manifest.provides.mapSources) {
        sources.push({
          id: `${r.id}-${s.id}`,
          name: s.name,
          url: renderTemplate(s.url, ctx),
          attribution: s.attribution,
          maxZoom: s.maxZoom,
          subdomains: 'abc',
          pixelRatio: s.pixelRatio,
          ...(s.variant && { variant: s.variant }),
          // Kartenserver im LAN: nicht zwischenspeichern, sonst bleiben nach einer Aktualisierung alte Kacheln stehen
          cache: false,
        });
      }
      for (const v of manifest.provides.videoSources ?? []) {
        videos.push({ id: `${r.id}-${v.id}`, name: v.name, status: renderTemplate(v.status, ctx), webrtc: renderTemplate(v.webrtc, ctx) });
      }
      for (const g of manifest.provides.geocoders ?? []) {
        geocoders.push({ id: `${r.id}-${g.id}`, name: g.name, type: g.type, url: renderTemplate(g.url, ctx) });
      }
      for (const o of manifest.provides.office ?? []) {
        offices.push({ id: `${r.id}-${o.id}`, name: o.name, url: renderTemplate(o.url, ctx), wopiBase: renderTemplate(o.wopiBase, ctx) });
      }
      for (const p of manifest.provides.printServers ?? []) {
        printServers.push({ id: `${r.id}-${p.id}`, name: p.name, url: renderTemplate(p.url, ctx) });
      }
    }
    if (this.tiles.setAddonSources(sources)) this.notify(['mapSources']);
    if (this.videos?.setProvisions(videos)) this.notify(['videoSources']);
    this.geocoder?.setProvisions(geocoders);
    this.office?.setProvisions(offices);
    this.printing?.setProvisions(printServers);
  }
}
