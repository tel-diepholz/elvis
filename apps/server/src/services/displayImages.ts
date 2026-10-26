import { mkdirSync } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { DisplayImage, DisplayLayout } from '@elvis/shared';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import { writeStream } from './files.js';

interface Row {
  id: number;
  name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  created_by: string;
}

/** Bildformate, die jeder Kiosk-Browser anzeigt – erkannt am Dateiinhalt, nicht an der Angabe des Browsers */
function sniff(head: Buffer): string | null {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Bilder für die Kachel „Bild“. Eine Datei je Bild unter display-images/<id>; der Inhalt ändert sich nie
 * (neues Bild = neue ID), Bildschirme dürfen es daher dauerhaft zwischenspeichern.
 */
export class DisplayImageService {
  readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
    private readonly notify: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    this.dir = join(dataDir, 'display-images');
    if (dataDir !== ':memory:') mkdirSync(this.dir, { recursive: true });
  }

  /** Anzahl Bildkacheln je Bild-ID in allen Layouts und Szenen */
  private uses(): Map<number, number> {
    const layouts = [
      ...(this.db.prepare('SELECT layout FROM displays').all() as { layout: string }[]),
      ...(this.db.prepare('SELECT layout FROM display_scenes').all() as { layout: string }[]),
    ];
    const count = new Map<number, number>();
    for (const { layout } of layouts) {
      for (const t of (JSON.parse(layout) as DisplayLayout).tiles) {
        if (t.type === 'image' && typeof t.config.imageId === 'number') count.set(t.config.imageId, (count.get(t.config.imageId) ?? 0) + 1);
      }
    }
    return count;
  }

  list(): DisplayImage[] {
    const uses = this.uses();
    return (this.db.prepare('SELECT * FROM display_images ORDER BY created_at DESC, id DESC').all() as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
      createdBy: r.created_by,
      uses: uses.get(r.id) ?? 0,
    }));
  }

  get(id: number): DisplayImage {
    const img = this.list().find((i) => i.id === id);
    if (!img) throw new HttpError(404, 'Bild nicht gefunden');
    return img;
  }

  path(id: number): string {
    return join(this.dir, String(id));
  }

  async upload(file: { filename: string; stream: Readable }, actor: string, maxBytes: number): Promise<DisplayImage> {
    const tmp = join(this.dir, `upload-${process.pid}-${this.now()}-${Math.random().toString(36).slice(2)}`);
    const size = await writeStream(tmp, file.stream, maxBytes);
    try {
      const head = Buffer.alloc(12);
      const fh = await open(tmp, 'r');
      await fh.read(head, 0, 12, 0).finally(() => fh.close());
      const mime = sniff(head);
      if (!mime) throw new HttpError(415, 'Kein Bild – erlaubt sind PNG, JPEG, GIF und WebP');
      const name = file.filename.replace(/[\u0000-\u001f\\/]/g, '').trim().slice(0, 120) || 'Bild';
      const info = this.db
        .prepare('INSERT INTO display_images (name, mime_type, size_bytes, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(name, mime, size, new Date(this.now()).toISOString(), actor);
      const id = Number(info.lastInsertRowid);
      await rename(tmp, this.path(id));
      this.notify();
      return this.get(id);
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /** Löschen nur, wenn keine Kachel (auch in keiner Szene) das Bild mehr zeigt; liefert den Namen */
  async remove(id: number): Promise<string> {
    const img = this.get(id);
    if (img.uses) throw new HttpError(409, `„${img.name}“ wird noch in ${img.uses} Kachel(n) angezeigt`);
    this.db.prepare('DELETE FROM display_images WHERE id = ?').run(id);
    await unlink(this.path(id)).catch(() => {});
    this.notify();
    return img.name;
  }
}
