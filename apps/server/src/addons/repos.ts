import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { addonManifestSchema, compareVersions, repositorySchema, type AddonManifest, type AddonRepository } from '@elvis/shared';
import type { ElvisConfig } from '../config.js';
import { HttpError } from '../errors.js';

export interface RepoAddon {
  repository: { id: string; name: string; url: string | null };
  addonDir: string;
  manifest: AddonManifest | null;
  error: string | null;
  /** Herkunft für mitgelieferte Dateien (nicht an Clients ausliefern). */
  location: { kind: 'local'; dir: string } | { kind: 'remote'; base: string };
}

const FETCH_TIMEOUT_MS = 10_000;

function formatZodError(err: unknown): string {
  const issues = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (!issues) return err instanceof Error ? err.message : String(err);
  return issues.map((i) => `${i.path.join('.') || 'Manifest'}: ${i.message}`).join('; ');
}

function parseManifest(text: string, dir: string): { manifest: AddonManifest | null; error: string | null } {
  try {
    const manifest = addonManifestSchema.parse(parseYaml(text));
    if (manifest.id !== dir) return { manifest: null, error: `id „${manifest.id}“ passt nicht zum Verzeichnis „${dir}“` };
    return { manifest, error: null };
  } catch (err) {
    return { manifest: null, error: formatZodError(err) };
  }
}

export function findBuiltinDir(configured: string | null): string | null {
  const candidates = configured ? [configured] : ['addons', '../../addons', '/app/addons'];
  return candidates.map((c) => resolve(c)).find((c) => existsSync(join(c, 'repository.yaml'))) ?? null;
}

/**
 * Addon-Repositories: das eingebaute Repo im Projektverzeichnis (immer offline verfügbar) und
 * konfigurierte Remote-Repos. Remote-Inhalte werden im Datenverzeichnis zwischengespeichert,
 * damit der Store auch ohne Internet funktioniert.
 */
export class RepoService {
  private entries: RepoAddon[] = [];
  private readonly cacheDir: string | null;

  constructor(
    private readonly config: ElvisConfig['addons'],
    dataDir: string,
  ) {
    this.cacheDir = dataDir === ':memory:' ? null : join(dataDir, 'addon-repos');
  }

  list(): RepoAddon[] {
    return this.entries;
  }

  manifest(id: string): { manifest: AddonManifest; repositoryId: string } {
    const e = this.entries.find((x) => x.manifest?.id === id);
    if (!e?.manifest) throw new HttpError(404, `Addon „${id}“ in keinem Repository gefunden`);
    return { manifest: e.manifest, repositoryId: e.repository.id };
  }

  /** Mitgelieferte Dateien eines Addons (manifest.files.paths) aus dem Repository lesen. */
  /** Dateien aus files/ des Addons – standardmäßig die für das Volume (files.paths), sonst die angegebenen */
  async addonFiles(id: string, only?: string[]): Promise<{ path: string; data: Buffer }[]> {
    const e = this.entries.find((x) => x.manifest?.id === id);
    if (!e?.manifest) throw new HttpError(404, `Addon „${id}“ in keinem Repository gefunden`);
    const paths = only ?? e.manifest.files?.paths ?? [];
    const loc = e.location;
    return Promise.all(
      paths.map(async (path) => {
        // Mitgelieferte Dateien liegen im Unterordner files/ des Addons
        if (loc.kind === 'local') return { path, data: readFileSync(join(loc.dir, 'files', path)) };
        const res = await fetch(`${loc.base}/files/${path}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return { path, data: Buffer.from(await res.arrayBuffer()) };
      }),
    );
  }

  async refresh(): Promise<void> {
    const next: RepoAddon[] = [];
    const builtin = findBuiltinDir(this.config.builtinDir);
    if (builtin) next.push(...this.loadLocal(builtin));
    for (const url of this.config.repositories) next.push(...(await this.loadRemote(url)));
    // Doppelte IDs (z. B. eingebautes Repo als Submodul und dasselbe Repo online): die höhere Version gewinnt,
    // bei gleicher Version die zuerst geladene – das eingebaute Repo, das auch ohne Internet funktioniert.
    const best = new Map<string, RepoAddon>();
    for (const e of next) {
      if (!e.manifest) continue;
      const current = best.get(e.manifest.id);
      if (!current || compareVersions(e.manifest.version, current.manifest!.version) > 0) best.set(e.manifest.id, e);
    }
    this.entries = next.filter((e) => !e.manifest || best.get(e.manifest.id) === e);
  }

  private loadLocal(dir: string): RepoAddon[] {
    const repo = repositorySchema.parse(parseYaml(readFileSync(join(dir, 'repository.yaml'), 'utf8')));
    const repository = { id: 'builtin', name: repo.name, url: null };
    return repo.addons.map((addonDir) => {
      const file = join(dir, addonDir, 'addon.yaml');
      const location = { kind: 'local' as const, dir: join(dir, addonDir) };
      if (!existsSync(file)) return { repository, addonDir, location, manifest: null, error: 'addon.yaml fehlt' };
      return { repository, addonDir, location, ...parseManifest(readFileSync(file, 'utf8'), addonDir) };
    });
  }

  private async loadRemote(baseUrl: string): Promise<RepoAddon[]> {
    const id = createHash('sha256').update(baseUrl).digest('hex').slice(0, 12);
    const base = baseUrl.replace(/\/+$/, '');
    const cacheFile = this.cacheDir ? join(this.cacheDir, `${id}.json`) : null;
    try {
      const repoText = await this.fetchText(`${base}/repository.yaml`);
      const repo: AddonRepository = repositorySchema.parse(parseYaml(repoText));
      const files = await Promise.all(
        repo.addons.map(async (dir) => ({ dir, text: await this.fetchText(`${base}/${dir}/addon.yaml`).catch((e: Error) => ({ error: e.message })) })),
      );
      const snapshot = { repo, files };
      if (cacheFile) {
        mkdirSync(this.cacheDir!, { recursive: true });
        writeFileSync(cacheFile, JSON.stringify(snapshot));
      }
      return this.fromSnapshot(id, base, snapshot);
    } catch (err) {
      if (cacheFile && existsSync(cacheFile)) return this.fromSnapshot(id, base, JSON.parse(readFileSync(cacheFile, 'utf8')));
      return [{ repository: { id, name: base, url: base }, addonDir: '', location: { kind: 'remote', base }, manifest: null, error: `Repository nicht erreichbar: ${(err as Error).message}` }];
    }
  }

  private fromSnapshot(id: string, url: string, s: { repo: AddonRepository; files: { dir: string; text: string | { error: string } }[] }): RepoAddon[] {
    const repository = { id, name: s.repo.name, url };
    return s.files.map(({ dir, text }) => {
      const location = { kind: 'remote' as const, base: `${url}/${dir}` };
      return typeof text === 'string' ? { repository, addonDir: dir, location, ...parseManifest(text, dir) } : { repository, addonDir: dir, location, manifest: null, error: text.error };
    });
  }

  private async fetchText(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.text();
  }
}
