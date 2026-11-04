import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';

/** Grenze der Teile im Strom an die Browser */
export const HUB_BOUNDARY = 'elvisframe';
export const HUB_CONTENT_TYPE = `multipart/x-mixed-replace; boundary=${HUB_BOUNDARY}`;

/** Ein Teil darf höchstens so groß werden (Schutz vor Strömen ohne erkennbare Grenze) */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Hängt ein Browser so weit hinterher, bekommt er Bilder erst wieder, wenn er aufgeholt hat */
const MAX_BACKLOG_BYTES = 2 * 1024 * 1024;

const CRLF2 = Buffer.from('\r\n\r\n');

/**
 * Zerlegt einen multipart/x-mixed-replace-Strom (MJPEG) in einzelne Bilder. Mit Content-Length im Teilkopf
 * kommt jedes Bild sofort, sonst, sobald die nächste Grenze da ist.
 */
export class MjpegParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly marker: Buffer;

  constructor(
    boundary: string,
    private readonly onFrame: (jpeg: Buffer) => void,
  ) {
    this.marker = Buffer.from(`--${boundary.replace(/^--/, '')}`);
  }

  /** Grenze aus dem Content-Type, z. B. „multipart/x-mixed-replace; boundary=myboundary“ */
  static boundaryOf(contentType: string | undefined): string | null {
    const m = /boundary="?([^";]+)"?/i.exec(contentType ?? '');
    return m ? m[1]!.trim() : null;
  }

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const start = this.buf.indexOf(this.marker);
      if (start < 0) break;
      const headerEnd = this.buf.indexOf(CRLF2, start);
      if (headerEnd < 0) break;
      const headers = this.buf.subarray(start, headerEnd).toString('latin1');
      const bodyStart = headerEnd + 4;
      const len = /content-length:\s*(\d+)/i.exec(headers);
      let bodyEnd: number;
      let next: number;
      if (len) {
        bodyEnd = bodyStart + Number(len[1]);
        if (this.buf.length < bodyEnd) break;
        next = bodyEnd;
      } else {
        const following = this.buf.indexOf(this.marker, bodyStart);
        if (following < 0) break;
        next = following;
        bodyEnd = following;
        // Zeilenumbruch vor der nächsten Grenze gehört nicht zum Bild
        while (bodyEnd > bodyStart && (this.buf[bodyEnd - 1] === 0x0a || this.buf[bodyEnd - 1] === 0x0d)) bodyEnd--;
      }
      const jpeg = Buffer.from(this.buf.subarray(bodyStart, bodyEnd));
      this.buf = this.buf.subarray(next);
      if (jpeg.length) this.onFrame(jpeg);
    }
    if (this.buf.length > MAX_FRAME_BYTES) this.buf = Buffer.alloc(0);
  }
}

const part = (jpeg: Buffer) => Buffer.concat([Buffer.from(`--${HUB_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from('\r\n')]);

/**
 * Ein Livebild für beliebig viele Zuschauer: höchstens eine Verbindung zur Kamera, jedes Bild geht an alle.
 * Wer dazukommt, bekommt sofort das letzte Bild. Nach dem letzten Zuschauer bleibt die Verbindung noch
 * lingerMs offen (kurzes Umschalten baut nicht jedes Mal neu auf).
 */
export class MjpegHub {
  private upstream: IncomingMessage | null = null;
  private connecting: Promise<void> | null = null;
  private readonly clients = new Set<PassThrough>();
  private last: Buffer | null = null;
  private linger: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly open: () => Promise<IncomingMessage | null>,
    private readonly lingerMs = 5_000,
  ) {}

  /** Anzahl der Zuschauer (für Tests und Diagnose) */
  get viewers(): number {
    return this.clients.size;
  }

  get connected(): boolean {
    return this.upstream !== null;
  }

  /** Neuer Zuschauer; null = Kamera liefert kein Bild. Fehler beim Verbinden gehen an den Aufrufer. */
  async subscribe(): Promise<PassThrough | null> {
    if (this.closed) throw new Error('Livebild beendet');
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    if (!this.upstream) {
      this.connecting ??= this.connect().finally(() => (this.connecting = null));
      await this.connecting;
      if (!this.upstream) return null;
    }
    const client = new PassThrough();
    this.clients.add(client);
    client.on('close', () => this.leave(client));
    if (this.last) client.write(part(this.last));
    return client;
  }

  /** Alles schließen (Kamera entfernt, Modul gestoppt) */
  close(): void {
    this.closed = true;
    this.disconnect();
  }

  private async connect(): Promise<void> {
    const res = await this.open();
    if (!res) return;
    if (this.closed) return void res.destroy();
    const boundary = MjpegParser.boundaryOf(res.headers['content-type']);
    if (!boundary) {
      res.destroy();
      throw new Error(`Kamera liefert kein MJPEG (${res.headers['content-type'] ?? 'ohne Content-Type'})`);
    }
    this.upstream = res;
    this.last = null;
    const parser = new MjpegParser(boundary, (jpeg) => this.broadcast(jpeg));
    res.on('data', (c: Buffer) => parser.push(c));
    // Strom der Kamera endet oder bricht ab: Zuschauer trennen, die Browser verbinden selbst neu
    const ended = () => {
      if (this.upstream !== res) return;
      this.disconnect();
    };
    res.on('end', ended);
    res.on('close', ended);
    res.on('error', ended);
  }

  private broadcast(jpeg: Buffer): void {
    this.last = jpeg;
    const data = part(jpeg);
    // Wer hinterherhängt, überspringt Bilder statt alle anderen aufzuhalten
    for (const c of this.clients) if (c.writableLength < MAX_BACKLOG_BYTES) c.write(data);
  }

  private leave(client: PassThrough): void {
    this.clients.delete(client);
    if (this.clients.size || this.closed || this.linger) return;
    this.linger = setTimeout(() => {
      this.linger = null;
      if (!this.clients.size) this.disconnect();
    }, this.lingerMs);
  }

  private disconnect(): void {
    if (this.linger) clearTimeout(this.linger);
    this.linger = null;
    const up = this.upstream;
    this.upstream = null;
    this.last = null;
    up?.destroy();
    for (const c of [...this.clients]) c.end();
    this.clients.clear();
  }
}
