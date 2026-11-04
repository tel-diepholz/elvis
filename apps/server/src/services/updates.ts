import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import nacl from 'tweetnacl';
import { compareVersions, UPDATE_INSTALLER_PATTERN, type Edition, type UpdateRelease, type UpdateResult, type UpdateStatus } from '@elvis/shared';
import { HttpError } from '../errors.js';
import { ELVIS_VERSION } from '../version.js';

/**
 * Öffentlicher Schlüssel, mit dem der Release-Workflow die Installer signiert (Ed25519, Base64). Der private Schlüssel
 * liegt als Secret ELVIS_UPDATE_SIGNING_KEY im GitHub-Repo; apps/windows/scripts/sign.mjs signiert damit.
 */
export const UPDATE_PUBLIC_KEY = 'br/3BhYMQvYH3A36TWFAgj9ycivdZc5OT2v/xFfg+zM=';

/** Name der einmaligen Aufgabe in der Windows-Aufgabenplanung, die den Installer startet (der Installer löscht sie) */
export const UPDATE_TASK = 'ELVIS lite Update';

export type UpdateFetch = (url: string, init?: RequestInit) => Promise<Response>;

interface GithubAsset {
  name: string;
  size: number;
  browser_download_url: string;
  /** „sha256:<hex>“, von GitHub berechnet */
  digest?: string | null;
}
interface GithubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubAsset[];
}

interface Found {
  release: UpdateRelease;
  installer: GithubAsset;
  signature: GithubAsset;
}

export interface UpdateOptions {
  edition: Edition;
  dataDir: string;
  repo: string | null;
  apiUrl: string;
  current?: string;
  fetch?: UpdateFetch;
  platform?: NodeJS.Platform;
  /** Läuft als Windows-Dienst aus dem Installer (setzt die Dienstkonfiguration) */
  service?: boolean;
  publicKey?: string;
  /** Startet den heruntergeladenen Installer unabhängig vom Dienst (Standard: Windows-Aufgabenplanung) */
  launch?: (installer: string) => Promise<void>;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Einstellungen → Update (ELVIS lite unter Windows): sucht auf GitHub das neueste Release mit Windows-Installer, lädt
 * es, prüft Prüfsumme und Signatur und übergibt es an den Installer. Der Installer hält den Dienst an, ersetzt die
 * Programmdateien, startet neu und stellt bei einem Fehlstart die alte Version samt Datenbank wieder her; sein
 * Ergebnis legt er in updates/result.json ab.
 */
export class UpdateService {
  private readonly current: string;
  private readonly fetch: UpdateFetch;
  private readonly updatesDir: string;
  private checkedAt: string | null = null;
  private checkError: string | null = null;
  private found: Found | null = null;
  private phase: UpdateStatus['phase'] = 'idle';
  private progress: number | null = null;
  private message: string | null = null;

  constructor(private readonly opts: UpdateOptions) {
    this.current = opts.current ?? ELVIS_VERSION;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    // Neben dem Datenverzeichnis, damit Installer nicht ins Backup geraten (Windows: %ProgramData%\ELVIS lite\updates)
    this.updatesDir = resolve(opts.dataDir, '..', 'updates');
  }

  private notInstallable(): string | null {
    if (this.opts.edition !== 'lite') return 'Updates gibt es hier nur für ELVIS lite.';
    if (!this.opts.repo) return 'Updates sind in der Konfiguration abgeschaltet (updates.repo).';
    if ((this.opts.platform ?? process.platform) !== 'win32' || !(this.opts.service ?? process.env.ELVIS_SERVICE === '1'))
      return 'Installieren geht nur in der Windows-Installation von ELVIS lite.';
    return null;
  }

  status(): UpdateStatus {
    const reason = this.notInstallable();
    return {
      current: this.current,
      installable: reason === null,
      reason,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      latest: this.found?.release ?? null,
      available: !!this.found && compareVersions(this.found.release.version, this.current) > 0,
      phase: this.phase,
      progress: this.progress,
      message: this.message,
      lastResult: this.lastResult(),
    };
  }

  /** Neuestes Release mit Windows-Installer und Signatur suchen */
  async check(): Promise<UpdateStatus> {
    if (this.opts.edition !== 'lite' || !this.opts.repo) throw new HttpError(409, this.notInstallable() ?? 'Updates sind aus');
    try {
      const res = await this.fetch(`${this.opts.apiUrl}/repos/${this.opts.repo}/releases?per_page=20`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `ELVIS-lite/${this.current}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub begrenzt gerade die Anfragen – bitte später erneut versuchen' : `GitHub antwortet mit HTTP ${res.status}`);
      const releases = (await res.json()) as GithubRelease[];
      this.found = null;
      for (const r of releases) {
        if (r.draft || r.prerelease) continue;
        const installer = r.assets.find((a) => UPDATE_INSTALLER_PATTERN.test(a.name));
        const signature = installer && r.assets.find((a) => a.name === `${installer.name}.sig`);
        if (!installer || !signature) continue;
        const version = UPDATE_INSTALLER_PATTERN.exec(installer.name)![1]!;
        if (this.found && compareVersions(version, this.found.release.version) <= 0) continue;
        this.found = {
          release: { version, tag: r.tag_name, name: r.name || r.tag_name, notes: r.body ?? '', publishedAt: r.published_at, url: r.html_url, size: installer.size },
          installer,
          signature,
        };
      }
      this.checkError = null;
    } catch (err) {
      this.checkError = err instanceof Error && err.name === 'TimeoutError' ? 'Keine Verbindung zu GitHub' : `Keine Verbindung zu GitHub (${(err as Error).message})`;
    }
    this.checkedAt = new Date().toISOString();
    return this.status();
  }

  /** Update starten; läuft im Hintergrund weiter, Fortschritt über status() */
  install(): UpdateStatus {
    const reason = this.notInstallable();
    if (reason) throw new HttpError(409, reason);
    if (this.phase === 'downloading' || this.phase === 'verifying' || this.phase === 'installing') throw new HttpError(409, 'Ein Update läuft bereits');
    const found = this.found;
    if (!found || compareVersions(found.release.version, this.current) <= 0) throw new HttpError(409, 'Kein neueres Update gefunden – bitte zuerst nach Updates suchen');
    this.phase = 'downloading';
    this.progress = 0;
    this.message = `Lade ELVIS lite ${found.release.version} …`;
    void this.run(found).catch((err: Error) => {
      this.phase = 'failed';
      this.progress = null;
      this.message = err.message;
      this.opts.log?.warn(`Update auf ${found.release.version} fehlgeschlagen: ${err.message}`);
    });
    return this.status();
  }

  private async run(found: Found): Promise<void> {
    const bytes = await this.download(found.installer);
    this.phase = 'verifying';
    this.progress = null;
    this.message = 'Prüfe Prüfsumme und Signatur …';
    const hex = createHash('sha256').update(bytes).digest('hex');
    if (found.installer.digest && found.installer.digest !== `sha256:${hex}`) throw new Error('Prüfsumme des Installers stimmt nicht – Download beschädigt');
    const sigRes = await this.fetch(found.signature.browser_download_url, { signal: AbortSignal.timeout(30_000) });
    if (!sigRes.ok) throw new Error(`Signatur nicht ladbar (HTTP ${sigRes.status})`);
    const signature = Buffer.from((await sigRes.text()).trim(), 'base64');
    const key = Buffer.from(this.opts.publicKey ?? UPDATE_PUBLIC_KEY, 'base64');
    if (signature.length !== nacl.sign.signatureLength || !nacl.sign.detached.verify(bytes, signature, key)) {
      throw new Error('Signatur des Installers ist ungültig – Update wird nicht installiert');
    }
    mkdirSync(this.updatesDir, { recursive: true });
    const installer = join(this.updatesDir, 'ELVIS-lite-setup.exe');
    writeFileSync(installer, bytes);
    this.phase = 'installing';
    this.message = `Installiere ELVIS lite ${found.release.version} – ELVIS ist gleich kurz nicht erreichbar und startet neu.`;
    this.opts.log?.info(`Update: übergebe ELVIS lite ${found.release.version} an den Installer`);
    await (this.opts.launch ?? launchWithTaskScheduler)(installer);
  }

  private async download(asset: GithubAsset): Promise<Buffer> {
    const res = await this.fetch(asset.browser_download_url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size;
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
      received += chunk.length;
      if (total) this.progress = Math.min(1, received / total);
    }
    return Buffer.concat(chunks);
  }

  /** Ergebnis, das der Installer nach dem letzten Update hinterlegt hat */
  private lastResult(): UpdateResult | null {
    const file = join(this.updatesDir, 'result.json');
    if (!existsSync(file)) return null;
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as Omit<UpdateResult, 'at'>;
      return { from: String(r.from), to: String(r.to), ok: !!r.ok, rolledBack: !!r.rolledBack, at: statSync(file).mtime.toISOString() };
    } catch {
      return null;
    }
  }
}

const run = promisify(execFile);

/**
 * Installer über eine einmalige Aufgabe der Windows-Aufgabenplanung als SYSTEM starten: Ein direkt vom Dienst
 * gestarteter Prozess würde mit dem Dienst beendet, sobald der Installer ihn anhält.
 */
async function launchWithTaskScheduler(installer: string): Promise<void> {
  await run('schtasks', ['/Create', '/F', '/TN', UPDATE_TASK, '/TR', `"${installer}" /S /UPDATE`, '/SC', 'ONCE', '/ST', '00:00', '/RU', 'SYSTEM', '/RL', 'HIGHEST'], { windowsHide: true });
  await run('schtasks', ['/Run', '/TN', UPDATE_TASK], { windowsHide: true });
}
