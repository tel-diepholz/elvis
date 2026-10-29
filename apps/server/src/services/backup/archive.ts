import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import tar from 'tar-stream';
import type { Db } from '../../db/index.js';

/**
 * Inhalt eines Backups als tar.gz: Snapshot der Datenbank, die Dateien aus dem Datenverzeichnis, ohne die sich
 * die Datenbank nicht nutzen lässt, und config/elvis.json. Caches (Kacheln, Umrisse, Addon-Repos, Wetter) und
 * temporäre Dateien (Gastdruck) bleiben draußen. Das Manifest steht am Ende, mit Prüfsummen aller Dateien.
 */

/** Einträge im Datenverzeichnis neben elvis.sqlite (Dateien oder Ordner) */
export const BACKUP_DATA_ITEMS = ['mail.secret', 'documents', 'templates', 'display-images', 'scans', 'docker-tls', 'overlays'];
export const DB_FILE = 'elvis.sqlite';
export const MANIFEST_FILE = 'manifest.json';
export const CONFIG_ENTRY = 'config/elvis.json';
export const BACKUP_FORMAT = 1;

export interface BackupManifest {
  format: number;
  schemaVersion: number;
  elvisVersion: string | null;
  createdAt: string;
  vehicle: string;
  /** Pfad im Archiv → SHA-256 (hex) */
  files: Record<string, string>;
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/**
 * Archiv als Stream (tar.gz). Die Datenbank wird über die SQLite-Backup-API kopiert, damit der Stand
 * konsistent ist, auch wenn ELVIS währenddessen schreibt.
 */
export async function createArchive(opts: { db: Db; dataDir: string; configFile: string | null; meta: Omit<BackupManifest, 'files' | 'format'> }): Promise<Readable> {
  const tmpDir = join(opts.dataDir, '.backup-tmp');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const snapshot = join(tmpDir, DB_FILE);
  await opts.db.backup(snapshot);

  const pack = tar.pack();
  const gzip = createGzip();
  pack.on('error', (e) => gzip.destroy(e));
  const files: Record<string, string> = {};
  const add = (name: string, content: Buffer, mode = 0o600) =>
    new Promise<void>((resolve, reject) => {
      files[name] = sha256(content);
      pack.entry({ name, size: content.length, mode }, content, (err) => (err ? reject(err) : resolve()));
    });

  // Nacheinander einpacken, der Stream liefert dabei schon aus
  void (async () => {
    try {
      await add(`data/${DB_FILE}`, readFileSync(snapshot));
      rmSync(tmpDir, { recursive: true, force: true });
      for (const item of BACKUP_DATA_ITEMS) {
        const p = join(opts.dataDir, item);
        if (!existsSync(p)) continue;
        if (statSync(p).isDirectory()) {
          for (const f of walk(p)) await add(`data/${relative(opts.dataDir, f).split(sep).join('/')}`, readFileSync(f));
        } else await add(`data/${item}`, readFileSync(p));
      }
      if (opts.configFile && existsSync(opts.configFile)) await add(CONFIG_ENTRY, readFileSync(opts.configFile), 0o644);
      const manifest: BackupManifest = { format: BACKUP_FORMAT, ...opts.meta, files: { ...files } };
      await add(MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2)), 0o644);
      pack.finalize();
    } catch (e) {
      rmSync(tmpDir, { recursive: true, force: true });
      pack.destroy(e as Error);
    }
  })();
  return pack.pipe(gzip);
}

/** Darf der Archivpfad entpackt werden? Nur data/…, config/elvis.json und das Manifest, ohne „..“ */
function safePath(name: string): string | null {
  const n = normalize(name).split(sep).join('/');
  if (n.startsWith('/') || n.split('/').includes('..')) return null;
  if (n === MANIFEST_FILE || n === CONFIG_ENTRY) return n;
  if (n.startsWith('data/') && n.length > 'data/'.length) return n;
  return null;
}

/** Entpackt ein Archiv (tar.gz) nach targetDir und prüft es gegen das Manifest */
export async function extractArchive(source: Readable, targetDir: string): Promise<BackupManifest> {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  const extract = tar.extract();
  const hashes: Record<string, string> = {};
  let manifest: BackupManifest | null = null;

  extract.on('entry', (header, stream, next) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(c as Buffer));
    stream.on('error', next);
    stream.on('end', () => {
      void (async () => {
        if (header.type !== 'file') return;
        const path = safePath(header.name);
        if (!path) throw new Error(`Unerlaubter Pfad im Backup: ${header.name}`);
        const content = Buffer.concat(chunks);
        if (path === MANIFEST_FILE) {
          manifest = JSON.parse(content.toString('utf8')) as BackupManifest;
          return;
        }
        hashes[path] = sha256(content);
        const out = join(targetDir, path);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, content, { mode: header.mode ?? 0o600 });
      })().then(() => next(), next);
    });
  });

  await pipeline(source, createGunzip(), extract);
  const m = manifest as BackupManifest | null;
  if (!m || m.format !== BACKUP_FORMAT) throw new Error('Backup ohne gültiges Manifest');
  const expected = Object.keys(m.files).sort();
  if (expected.join('\n') !== Object.keys(hashes).sort().join('\n') || expected.some((f) => m.files[f] !== hashes[f])) throw new Error('Backup ist beschädigt (Prüfsummen stimmen nicht)');
  if (!m.files[`data/${DB_FILE}`]) throw new Error('Backup enthält keine Datenbank');
  return m;
}
