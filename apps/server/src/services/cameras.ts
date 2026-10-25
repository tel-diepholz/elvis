import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { CameraConfig, CameraConfigInput, CameraPosition, CameraPreset, CameraType } from '@elvis/shared';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';

/** Kamera samt Passwort – nur serverseitig. */
export interface CameraSecretConfig extends Omit<CameraConfig, 'passwordSet'> {
  password: string;
}

export const cameraInputSchema = z.object({
  name: z.string().trim().min(1, 'Name fehlt').max(60),
  type: z.enum(['axis', 'demo']),
  host: z.string().trim().max(200).regex(/^[\w.\-:[\]]*$/, 'Nur Hostname oder IP-Adresse, ggf. mit :Port'),
  protocol: z.enum(['http', 'https']),
  username: z.string().max(100),
  password: z.string().max(200),
  verifyTls: z.boolean(),
  resolution: z.string().regex(/^\d{2,4}x\d{2,4}$/, 'Auflösung im Format 1280x720'),
  enabled: z.boolean(),
});

interface Row {
  id: string;
  name: string;
  type: CameraType;
  host: string;
  protocol: 'http' | 'https';
  username: string;
  password: string;
  verify_tls: number;
  resolution: string;
  enabled: number;
  sort: number;
}

const fromRow = (r: Row): CameraSecretConfig => ({
  id: r.id,
  name: r.name,
  type: r.type,
  host: r.host,
  protocol: r.protocol,
  username: r.username,
  password: r.password,
  verifyTls: !!r.verify_tls,
  resolution: r.resolution,
  enabled: !!r.enabled,
  sort: r.sort,
});

export const publicCamera = ({ password, ...c }: CameraSecretConfig): CameraConfig => ({ ...c, passwordSet: password !== '' });

/** Kameras aus den Einstellungen (Tabelle cameras). */
export class CameraConfigStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly db: Db | null) {}

  list(): CameraSecretConfig[] {
    if (!this.db) return [];
    return (this.db.prepare('SELECT * FROM cameras ORDER BY sort, name').all() as Row[]).map(fromRow);
  }

  get(id: string): CameraSecretConfig {
    const c = this.list().find((x) => x.id === id);
    if (!c) throw new HttpError(404, `Kamera ${id} nicht gefunden`);
    return c;
  }

  private validate(input: CameraConfigInput, current?: CameraSecretConfig): CameraSecretConfig {
    const parsed = cameraInputSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const v = parsed.data;
    if (v.type === 'axis' && !v.host) throw new HttpError(400, 'host: Adresse der Kamera fehlt');
    return {
      id: current?.id ?? `cam-${randomBytes(4).toString('hex')}`,
      sort: current?.sort ?? this.list().length,
      ...v,
      // leeres Passwort = unverändert
      password: v.password === '' && current ? current.password : v.password,
    };
  }

  /** Eingabe prüfen, ohne zu speichern (für „Verbindung testen“). */
  preview(input: CameraConfigInput, id?: string): CameraSecretConfig {
    return this.validate(input, id ? this.get(id) : undefined);
  }

  create(input: CameraConfigInput): CameraSecretConfig {
    const c = this.validate(input);
    this.db!.prepare(
      'INSERT INTO cameras (id, name, type, host, protocol, username, password, verify_tls, resolution, enabled, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(c.id, c.name, c.type, c.host, c.protocol, c.username, c.password, c.verifyTls ? 1 : 0, c.resolution, c.enabled ? 1 : 0, c.sort, new Date().toISOString());
    this.changed();
    return c;
  }

  update(id: string, input: CameraConfigInput): CameraSecretConfig {
    const c = this.validate(input, this.get(id));
    this.db!.prepare('UPDATE cameras SET name = ?, type = ?, host = ?, protocol = ?, username = ?, password = ?, verify_tls = ?, resolution = ?, enabled = ? WHERE id = ?').run(
      c.name,
      c.type,
      c.host,
      c.protocol,
      c.username,
      c.password,
      c.verifyTls ? 1 : 0,
      c.resolution,
      c.enabled ? 1 : 0,
      id,
    );
    this.changed();
    return c;
  }

  remove(id: string): CameraSecretConfig {
    const c = this.get(id);
    this.db!.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    this.changed();
    return c;
  }

  /** Reihenfolge der Anzeige */
  reorder(ids: string[]): void {
    const stmt = this.db!.prepare('UPDATE cameras SET sort = ? WHERE id = ?');
    this.db!.transaction(() => ids.forEach((id, i) => stmt.run(i, id)))();
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

interface PresetRow {
  id: number;
  incident_id: number;
  camera_id: string;
  name: string;
  position: string;
  created_at: string;
  created_by: string;
}

/** Gespeicherte Kamerapositionen; sie gehören zu einem Einsatz und erscheinen nur, solange er läuft. */
export class CameraPresetStore {
  constructor(private readonly db: Db) {}

  list(incidentId: number): CameraPreset[] {
    return (this.db.prepare('SELECT * FROM camera_presets WHERE incident_id = ? ORDER BY camera_id, id').all(incidentId) as PresetRow[]).map((r) => ({
      id: r.id,
      incidentId: r.incident_id,
      cameraId: r.camera_id,
      name: r.name,
      position: JSON.parse(r.position) as CameraPosition,
      createdAt: r.created_at,
      createdBy: r.created_by,
    }));
  }

  get(id: number): CameraPreset {
    const r = this.db.prepare('SELECT incident_id FROM camera_presets WHERE id = ?').get(id) as { incident_id: number } | undefined;
    const p = r && this.list(r.incident_id).find((x) => x.id === id);
    if (!p) throw new HttpError(404, 'Position nicht gefunden');
    return p;
  }

  add(incidentId: number, cameraId: string, name: string, position: CameraPosition, actor: string): CameraPreset {
    const info = this.db
      .prepare('INSERT INTO camera_presets (incident_id, camera_id, name, position, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(incidentId, cameraId, name, JSON.stringify(position), new Date().toISOString(), actor);
    return this.get(Number(info.lastInsertRowid));
  }

  remove(id: number): CameraPreset {
    const p = this.get(id);
    this.db.prepare('DELETE FROM camera_presets WHERE id = ?').run(id);
    return p;
  }
}
