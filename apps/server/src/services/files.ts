import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError } from '../errors.js';

/**
 * Datei aus einem Stream schreiben, höchstens `maxBytes`. Erst in eine temporäre Datei, dann umbenennen –
 * eine bestehende Datei bleibt bei Abbruch unverändert. Liefert die Größe in Byte.
 */
export async function writeStream(path: string, stream: Readable, maxBytes: number): Promise<number> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new HttpError(413, `Datei größer als ${Math.round(maxBytes / 1024 / 1024)} MB`));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, counter, createWriteStream(tmp));
    // @fastify/multipart kürzt bei fileSize-Limit still – dann ebenfalls abbrechen
    if ((stream as Readable & { truncated?: boolean }).truncated) throw new HttpError(413, 'Datei zu groß');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return size;
}
