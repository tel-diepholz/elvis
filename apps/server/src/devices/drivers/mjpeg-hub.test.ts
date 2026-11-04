import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { MjpegHub, MjpegParser } from './mjpeg-hub.js';

const jpeg = (n: number) => Buffer.from([0xff, 0xd8, n, n, 0xff, 0xd9]);

describe('MjpegParser', () => {
  it('liest Bilder mit und ohne Content-Length, auch in beliebig zerteilten Stücken', () => {
    const frames: Buffer[] = [];
    const p = new MjpegParser('frame', (f) => frames.push(f));
    const data = Buffer.concat([
      Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\n'),
      jpeg(1),
      Buffer.from('\r\n--frame\r\nContent-Type: image/jpeg\r\n\r\n'),
      jpeg(2),
      Buffer.from('\r\n--frame\r\nContent-Type: image/jpeg\r\n\r\n'),
    ]);
    for (let i = 0; i < data.length; i += 3) p.push(data.subarray(i, i + 3));
    expect(frames).toEqual([jpeg(1), jpeg(2)]);
  });

  it('liest die Grenze aus dem Content-Type', () => {
    expect(MjpegParser.boundaryOf('multipart/x-mixed-replace; boundary=myboundary')).toBe('myboundary');
    expect(MjpegParser.boundaryOf('multipart/x-mixed-replace;boundary="--frame"')).toBe('--frame');
    expect(MjpegParser.boundaryOf('image/jpeg')).toBeNull();
  });
});

/** Kamera, die auf Kommando Bilder schickt */
class FakeCam {
  server!: Server;
  port = 0;
  opened = 0;
  readonly open = new Set<ServerResponse>();

  async start(): Promise<this> {
    this.server = createServer((_req, res) => {
      this.opened++;
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=b' });
      res.flushHeaders();
      this.open.add(res);
      res.on('close', () => this.open.delete(res));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  frame(n: number): void {
    for (const res of this.open) res.write(Buffer.concat([Buffer.from(`--b\r\nContent-Length: 6\r\n\r\n`), jpeg(n), Buffer.from('\r\n')]));
  }

  connect = () => new Promise<IncomingMessage>((resolve, reject) => request({ host: '127.0.0.1', port: this.port }, resolve).on('error', reject).end());

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}

let cams: FakeCam[] = [];
afterEach(async () => {
  await Promise.all(cams.map((c) => c.stop()));
  cams = [];
});
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};
const collect = (s: PassThrough) => {
  const got: Buffer[] = [];
  s.on('data', (c: Buffer) => got.push(c));
  return () => Buffer.concat(got).toString('latin1');
};
const has = (text: string, n: number) => text.includes(jpeg(n).toString('latin1'));

describe('MjpegHub', () => {
  it('teilt eine Verbindung, gibt Nachzüglern das letzte Bild und trennt nach dem Nachlauf', async () => {
    const cam = await new FakeCam().start();
    cams.push(cam);
    const hub = new MjpegHub(cam.connect, 50);
    const a = (await hub.subscribe())!;
    const gotA = collect(a);
    cam.frame(1);
    await until(() => has(gotA(), 1));
    const b = (await hub.subscribe())!;
    const gotB = collect(b);
    // Nachzügler bekommt sofort das letzte Bild, danach die folgenden
    await until(() => has(gotB(), 1));
    cam.frame(2);
    await until(() => has(gotA(), 2) && has(gotB(), 2));
    expect(gotB()).toContain('--elvisframe\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\n');
    expect(cam.opened).toBe(1);

    a.destroy();
    b.destroy();
    // innerhalb des Nachlaufs wieder da: keine neue Verbindung
    const c = (await hub.subscribe())!;
    expect(cam.opened).toBe(1);
    c.destroy();
    await until(() => cam.open.size === 0);
    expect(hub.connected).toBe(false);
  });

  it('beendet die Zuschauer, wenn die Kamera trennt, und verbindet beim nächsten neu', async () => {
    const cam = await new FakeCam().start();
    cams.push(cam);
    const hub = new MjpegHub(cam.connect, 50);
    const a = (await hub.subscribe())!;
    a.resume();
    const ended = new Promise((r) => a.on('end', r));
    for (const res of cam.open) res.end();
    await ended;
    expect(hub.viewers).toBe(0);
    (await hub.subscribe())!.destroy();
    expect(cam.opened).toBe(2);
    hub.close();
  });

  it('meldet Fehler beim Verbinden an alle Wartenden und lehnt Ströme ohne MJPEG ab', async () => {
    const fail = new MjpegHub(() => Promise.reject(new Error('Kamera nicht erreichbar')));
    await expect(Promise.all([fail.subscribe(), fail.subscribe()])).rejects.toThrow('Kamera nicht erreichbar');
    const empty = new MjpegHub(async () => null);
    expect(await empty.subscribe()).toBeNull();
  });
});
