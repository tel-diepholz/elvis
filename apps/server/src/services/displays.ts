import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  EMPTY_DISPLAY_LAYOUT,
  displayLayoutSchema,
  type DisplayDevice,
  type DisplayLayout,
  type DisplayMapView,
  type DisplayScene,
  type DisplayScreen,
  type DisplaySelf,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';

/** Gerätecookie eines Bildschirms; enthält ein zufälliges Geheimnis, gespeichert wird nur dessen Hash. */
export const DISPLAY_COOKIE = 'elvis_display';
export const DISPLAY_COOKIE_MAX_S = 10 * 365 * 24 * 3600;
const PAIRING_MS = 10 * 60_000;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

interface Row {
  id: string;
  name: string;
  layout: string;
  screen: string | null;
  user_agent: string;
  sort: number;
  paired_at: string;
  last_seen_at: string | null;
}

interface SceneRow {
  id: number;
  display_id: string;
  name: string;
  layout: string;
  sort: number;
  updated_at: string;
  updated_by: string;
}

/** Vergleich unabhängig von Reihenfolge der Kacheln und Schlüssel */
const layoutKey = (l: DisplayLayout) =>
  JSON.stringify({ cols: l.cols, rows: l.rows, tiles: [...l.tiles].sort((a, b) => a.y - b.y || a.x - b.x).map((t) => [t.type, t.x, t.y, t.w, t.h, Object.entries(t.config).sort(([a], [b]) => a.localeCompare(b))]) });

interface Pending {
  code: string;
  expiresAt: number;
}

/**
 * Gekoppelte Bildschirme. Kopplung: Bildschirm fordert einen 6-stelligen Code an (Cookie mit Geheimnis),
 * ein Admin trägt den Code in ELVIS ein – danach ist das Geheimnis dem Bildschirm zugeordnet (widerrufbar).
 */
export class DisplayService {
  private readonly pending = new Map<string, Pending>(); // Hash des Geheimnisses → Code
  private readonly online = new Set<string>();
  private readonly mapViews = new Map<string, Map<string, DisplayMapView>>(); // Bildschirm → Kachel → Ausschnitt
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private sceneRows(displayId: string): SceneRow[] {
    return this.db.prepare('SELECT * FROM display_scenes WHERE display_id = ? ORDER BY sort, id').all(displayId) as SceneRow[];
  }

  private toDisplay(r: Row): DisplayDevice {
    const layout = JSON.parse(r.layout) as DisplayLayout;
    const scenes = this.sceneRows(r.id);
    const current = layoutKey(layout);
    return {
      scenes: scenes.map((s): DisplayScene => ({ id: s.id, name: s.name, tiles: (JSON.parse(s.layout) as DisplayLayout).tiles.length, updatedAt: s.updated_at, updatedBy: s.updated_by })),
      activeSceneId: scenes.find((s) => layoutKey(JSON.parse(s.layout) as DisplayLayout) === current)?.id ?? null,
      mapViews: Object.fromEntries([...(this.mapViews.get(r.id) ?? [])].filter(([tileId]) => layout.tiles.some((t) => t.id === tileId))),
      id: r.id,
      name: r.name,
      layout,
      online: this.online.has(r.id),
      screen: r.screen ? (JSON.parse(r.screen) as DisplayScreen) : null,
      userAgent: r.user_agent,
      pairedAt: r.paired_at,
      lastSeenAt: r.last_seen_at,
      sort: r.sort,
    };
  }

  list(): DisplayDevice[] {
    return (this.db.prepare('SELECT * FROM displays ORDER BY sort, name').all() as Row[]).map((r) => this.toDisplay(r));
  }

  get(id: string): DisplayDevice {
    const r = this.db.prepare('SELECT * FROM displays WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, 'Bildschirm nicht gefunden');
    return this.toDisplay(r);
  }

  /** Gekoppelter Bildschirm zum Gerätecookie */
  resolve(token: string | undefined): DisplayDevice | null {
    if (!token) return null;
    const r = this.db.prepare('SELECT * FROM displays WHERE token_hash = ?').get(hash(token)) as Row | undefined;
    return r ? this.toDisplay(r) : null;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(k);
  }

  /** Sicht des Bildschirms auf sich selbst */
  self(token: string | undefined): DisplaySelf {
    const d = this.resolve(token);
    if (d) return { state: 'paired', display: d };
    this.sweep();
    const p = token ? this.pending.get(hash(token)) : undefined;
    return p ? { state: 'pending', code: p.code, expiresAt: new Date(p.expiresAt).toISOString() } : { state: 'unpaired' };
  }

  /** Kopplung beginnen: liefert neues Geheimnis (für das Cookie) und den anzuzeigenden Code */
  startPairing(): { token: string; code: string; expiresAt: string } {
    this.sweep();
    if (this.pending.size > 50) throw new HttpError(429, 'Zu viele offene Kopplungen – bitte später erneut versuchen');
    const used = new Set([...this.pending.values()].map((p) => p.code));
    let code: string;
    do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    while (used.has(code));
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + PAIRING_MS;
    this.pending.set(hash(token), { code, expiresAt });
    return { token, code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Admin koppelt den Bildschirm, der diesen Code anzeigt */
  pair(code: string, name: string): DisplayDevice {
    this.sweep();
    const entry = [...this.pending.entries()].find(([, p]) => p.code === code.trim());
    if (!entry) throw new HttpError(404, 'Code unbekannt oder abgelaufen – auf dem Bildschirm wird ein neuer angezeigt');
    const [tokenHash] = entry;
    const id = `dsp-${randomBytes(4).toString('hex')}`;
    const sort = (this.db.prepare('SELECT COUNT(*) AS n FROM displays').get() as { n: number }).n;
    this.db
      .prepare('INSERT INTO displays (id, name, token_hash, layout, sort, paired_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name.trim(), tokenHash, JSON.stringify(EMPTY_DISPLAY_LAYOUT), sort, new Date(this.now()).toISOString());
    this.pending.delete(tokenHash);
    this.changed();
    return this.get(id);
  }

  rename(id: string, name: string): DisplayDevice {
    this.get(id);
    this.db.prepare('UPDATE displays SET name = ? WHERE id = ?').run(name.trim(), id);
    this.changed();
    return this.get(id);
  }

  setLayout(id: string, input: unknown): DisplayDevice {
    this.get(id);
    const parsed = displayLayoutSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join('; '));
    this.db.prepare('UPDATE displays SET layout = ? WHERE id = ?').run(JSON.stringify(parsed.data), id);
    this.changed();
    return this.get(id);
  }

  // --- Szenen ---

  private scene(displayId: string, sceneId: number): SceneRow {
    const s = this.sceneRows(displayId).find((x) => x.id === sceneId);
    if (!s) throw new HttpError(404, 'Szene nicht gefunden');
    return s;
  }

  /** Aktuelle Anordnung als neue Szene speichern */
  saveScene(displayId: string, name: string, actor: string): DisplayScene {
    const d = this.get(displayId);
    if (d.scenes.some((s) => s.name.toLowerCase() === name.trim().toLowerCase())) throw new HttpError(409, `Szene „${name.trim()}“ gibt es schon – überschreiben oder anderen Namen wählen`);
    const info = this.db
      .prepare('INSERT INTO display_scenes (display_id, name, layout, sort, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(displayId, name.trim(), JSON.stringify(d.layout), d.scenes.length, new Date(this.now()).toISOString(), actor);
    this.changed();
    return this.get(displayId).scenes.find((s) => s.id === Number(info.lastInsertRowid))!;
  }

  /** Szene umbenennen und/oder mit der aktuellen Anordnung überschreiben */
  updateScene(displayId: string, sceneId: number, patch: { name?: string; overwrite?: boolean }, actor: string): DisplayScene {
    const d = this.get(displayId);
    const row = this.scene(displayId, sceneId);
    const name = patch.name?.trim() ?? row.name;
    if (d.scenes.some((s) => s.id !== sceneId && s.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `Szene „${name}“ gibt es schon`);
    this.db
      .prepare('UPDATE display_scenes SET name = ?, layout = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(name, patch.overwrite ? JSON.stringify(d.layout) : row.layout, new Date(this.now()).toISOString(), actor, sceneId);
    this.changed();
    return this.get(displayId).scenes.find((s) => s.id === sceneId)!;
  }

  removeScene(displayId: string, sceneId: number): string {
    const row = this.scene(displayId, sceneId);
    this.db.prepare('DELETE FROM display_scenes WHERE id = ?').run(sceneId);
    this.changed();
    return row.name;
  }

  /** Szene auf den Bildschirm bringen; liefert ihren Namen */
  applyScene(displayId: string, sceneId: number): string {
    const row = this.scene(displayId, sceneId);
    this.setLayout(displayId, JSON.parse(row.layout));
    return row.name;
  }

  reorderScenes(displayId: string, ids: number[]): void {
    const stmt = this.db.prepare('UPDATE display_scenes SET sort = ? WHERE id = ? AND display_id = ?');
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, id, displayId)))();
    this.changed();
  }

  remove(id: string): DisplayDevice {
    const d = this.get(id);
    this.db.prepare('DELETE FROM display_scenes WHERE display_id = ?').run(id);
    this.db.prepare('DELETE FROM displays WHERE id = ?').run(id);
    this.online.delete(id);
    this.mapViews.delete(id);
    this.changed();
    return d;
  }

  reorder(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE displays SET sort = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, id)))();
    this.changed();
  }

  /** Lebenszeichen mit Fenstergröße und Browserkennung */
  touch(id: string, screen: DisplayScreen | null, userAgent: string): void {
    const before = this.get(id);
    this.db
      .prepare('UPDATE displays SET last_seen_at = ?, screen = COALESCE(?, screen), user_agent = ? WHERE id = ?')
      .run(new Date(this.now()).toISOString(), screen ? JSON.stringify(screen) : null, userAgent.slice(0, 300), id);
    if (screen && JSON.stringify(screen) !== JSON.stringify(before.screen)) this.changed();
  }

  setOnline(id: string, online: boolean): void {
    if (online === this.online.has(id)) return;
    if (online) this.online.add(id);
    else this.online.delete(id);
    this.changed();
  }

  /** Ausschnitt einer Kartenkachel merken (vom Bildschirm gemeldet oder aus ELVIS ferngesteuert) */
  setMapView(id: string, tileId: string, view: DisplayMapView): void {
    const tile = this.get(id).layout.tiles.find((t) => t.id === tileId);
    if (tile?.type !== 'map') throw new HttpError(404, 'Kartenkachel nicht gefunden');
    const views = this.mapViews.get(id) ?? new Map<string, DisplayMapView>();
    this.mapViews.set(id, views);
    if (JSON.stringify(views.get(tileId)) === JSON.stringify(view)) return;
    views.set(tileId, view);
    this.changed();
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    this.listeners.forEach((l) => l());
  }
}
