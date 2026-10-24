import { createHash, randomBytes } from 'node:crypto';
import { extensionOf, type OfficeSession, type OfficeStatus } from '@elvis/shared';
import type { Db } from '../db/index.js';

/** Office-Server eines Addons (provides.office) */
export interface OfficeProvision {
  id: string;
  name: string;
  /** Adresse für den Browser */
  url: string;
  /** Adresse von ELVIS aus Sicht des Office-Servers; leer = wie vom Browser aufgerufen */
  wopiBase: string;
}

/** Aktion je Dateiendung aus /hosting/discovery */
interface Discovery {
  edit: Map<string, string>;
  view: Map<string, string>;
  loadedAt: number;
}

export interface WopiAccess {
  fileRef: string;
  userId: number;
  userName: string;
  canWrite: boolean;
  origin: string;
  expiresAt: number;
}

export type DiscoveryFetch = (url: string) => Promise<string>;

const defaultFetch: DiscoveryFetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

const TOKEN_TTL_MS = 10 * 3600_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_RETRY_MS = 15_000;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/** Liest die Aktionen aus dem Discovery-XML von Collabora (WOPI) */
export function parseDiscovery(xml: string): Pick<Discovery, 'edit' | 'view'> {
  const edit = new Map<string, string>();
  const view = new Map<string, string>();
  for (const m of xml.matchAll(/<action\b([^>]*)\/?>/g)) {
    const attr = (n: string) => new RegExp(`\\b${n}="([^"]*)"`).exec(m[1]!)?.[1];
    const name = attr('name');
    const ext = attr('ext');
    const src = attr('urlsrc');
    if (!ext || !src) continue;
    const url = src.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (name === 'edit') edit.set(ext, url);
    else if (name === 'view' && !view.has(ext)) view.set(ext, url);
  }
  return { edit, view };
}

/**
 * Anbindung an Collabora Online über WOPI: Discovery (welche Formate, welche Editor-Adresse) und Zugriffstokens
 * für die Rückrufe des Office-Servers, der kein Sitzungscookie mitbringt.
 */
export class OfficeService {
  private provision: OfficeProvision | null = null;
  private discovery: Discovery | null = null;
  private failedAt = 0;
  private loading: Promise<Discovery | null> | null = null;

  constructor(
    private readonly db: Db,
    private readonly onChange: () => void = () => {},
    private readonly fetchText: DiscoveryFetch = defaultFetch,
  ) {}

  /** Laufende Addons melden ihren Office-Server; es zählt der erste. */
  setProvisions(list: OfficeProvision[]): void {
    const next = list[0] ?? null;
    if (JSON.stringify(next) === JSON.stringify(this.provision)) return;
    this.provision = next;
    this.discovery = null;
    this.failedAt = 0;
    this.onChange();
  }

  /** Adresse des Office-Servers (wie für den Browser), null = keiner läuft */
  url(): string | null {
    return this.provision?.url ?? null;
  }

  private async load(): Promise<Discovery | null> {
    const p = this.provision;
    if (!p) return null;
    if (this.discovery && Date.now() - this.discovery.loadedAt < DISCOVERY_TTL_MS) return this.discovery;
    if (!this.discovery && Date.now() - this.failedAt < DISCOVERY_RETRY_MS) return null;
    this.loading ??= (async () => {
      try {
        const parsed = parseDiscovery(await this.fetchText(`${p.url.replace(/\/$/, '')}/hosting/discovery`));
        if (this.provision !== p) return null;
        this.discovery = { ...parsed, loadedAt: Date.now() };
      } catch {
        // Office-Server (noch) nicht erreichbar: alte Discovery weiterverwenden, sonst später erneut versuchen
        this.failedAt = Date.now();
      }
      return this.discovery;
    })().finally(() => (this.loading = null));
    return this.loading;
  }

  async status(): Promise<OfficeStatus> {
    const d = await this.load();
    return { available: !!d, editable: d ? [...d.edit.keys()].sort() : [], viewable: d ? [...d.view.keys()].sort() : [] };
  }

  /**
   * Editor-Sitzung für eine Datei: Token ausstellen und Formularziel fürs iframe bilden.
   * `origin` ist die Adresse von ELVIS aus Sicht des Browsers.
   */
  async session(fileRef: string, filename: string, user: { id: number; name: string }, canWrite: boolean, origin: string): Promise<OfficeSession | null> {
    const ext = extensionOf(filename);
    const d = await this.load();
    const src = d && ((canWrite && d.edit.get(ext)) || d.view.get(ext) || d.edit.get(ext));
    if (!src || !this.provision) return null;
    const base = (this.provision.wopiBase || origin).replace(/\/$/, '');
    const wopiSrc = `${base}/api/wopi/files/${fileRef}`;
    // urlsrc enthält optionale Parameter in <…>, z. B. „<ui=UI_LLCC&>“ – weglassen
    const action = src.replace(/<[^>]*>/g, '');
    const sep = action.endsWith('?') || action.endsWith('&') ? '' : action.includes('?') ? '&' : '?';
    const { token, expiresAt } = this.issue(fileRef, user, canWrite && d.edit.has(ext), origin);
    return {
      // closebutton: „Schließen“ im Editor meldet sich per postMessage (UI_Close)
      actionUrl: `${action}${sep}WOPISrc=${encodeURIComponent(wopiSrc)}&lang=de&closebutton=1`,
      accessToken: token,
      accessTokenTtl: expiresAt,
      readOnly: !(canWrite && d.edit.has(ext)),
      filename,
    };
  }

  issue(fileRef: string, user: { id: number; name: string }, canWrite: boolean, origin: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.db.prepare('DELETE FROM wopi_tokens WHERE expires_at < ?').run(Date.now());
    this.db
      .prepare('INSERT INTO wopi_tokens (token_hash, file_ref, user_id, user_name, can_write, origin, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hash(token), fileRef, user.id, user.name, canWrite ? 1 : 0, origin, expiresAt);
    return { token, expiresAt };
  }

  /** Token prüfen; gilt nur für die Datei, für die es ausgestellt wurde. */
  resolve(token: string | undefined, fileRef: string): WopiAccess | null {
    if (!token) return null;
    const r = this.db.prepare('SELECT * FROM wopi_tokens WHERE token_hash = ?').get(hash(token)) as
      | { file_ref: string; user_id: number; user_name: string; can_write: number; origin: string; expires_at: number }
      | undefined;
    if (!r || r.file_ref !== fileRef || r.expires_at < Date.now()) return null;
    return { fileRef: r.file_ref, userId: r.user_id, userName: r.user_name, canWrite: r.can_write === 1, origin: r.origin, expiresAt: r.expires_at };
  }

  /** Alle Tokens einer Datei verwerfen (z. B. beim Löschen) */
  revoke(fileRef: string): void {
    this.db.prepare('DELETE FROM wopi_tokens WHERE file_ref = ?').run(fileRef);
  }
}
