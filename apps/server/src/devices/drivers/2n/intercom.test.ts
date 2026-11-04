import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CameraSecretConfig } from '../../../services/cameras.js';
import { TINY_JPEG } from '../axis/fake-axis.js';
import { CamerasAdapter, defaultFactory } from '../cameras.js';
import { TwoNIntercom, nearestResolution } from './intercom.js';

const REALM = 'HTTP API (5/00000004)';
const NONCE = '647e9f15e914ef19cd122c624db5939b';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** Nachgebaute 2N IP Base: system/info ohne Anmeldung, Kamera-API mit Digest (wie FW 2.48 am echten Gerät) */
class Fake2N {
  server!: Server;
  port = 0;
  readonly calls: string[] = [];
  /** Wartende log/pull-Anfragen und noch nicht abgeholte Ereignisse */
  private waiting: ((events: unknown[]) => void)[] = [];
  private queue: unknown[] = [];
  subscription = 1000;
  /** Nächsten Abruf ohne Antwort abbrechen (wie ein Netzwerkfehler) */
  dropNextPull = false;

  /** Taste an der Türstation drücken (KeyPressed wie am echten Gerät) */
  press(key: string): void {
    const e = { id: 1, event: 'KeyPressed', params: { key } };
    const w = this.waiting.shift();
    if (w) w([e]);
    else this.queue.push(e);
  }

  private authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    const p: Record<string, string> = {};
    for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1]!] = m[2] ?? m[3] ?? '';
    const ha1 = md5(`elvis:${REALM}:geheim`);
    return h.startsWith('Digest ') && p.response === md5(`${ha1}:${NONCE}:${p.nc}:${p.cnonce}:${p.qop}:${md5(`${req.method}:${p.uri}`)}`);
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => (res.writeHead(status, { 'content-type': 'application/json', ...headers }), res.end(JSON.stringify(body)));
      if (url.pathname === '/api/system/info') return json({ success: true, result: { variant: '2N IP Base', swVersion: '2.48.1.72.5' } });
      if (!this.authorized(req)) return json({ success: false, error: { code: 9, description: 'authorization required' } }, 401, { 'www-authenticate': `Digest realm="${REALM}", nonce="${NONCE}", qop="auth"` });
      this.calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/api/camera/caps')
        return json({ success: true, result: { jpegResolution: [{ width: 160, height: 120 }, { width: 320, height: 240 }, { width: 640, height: 480 }, { width: 1280, height: 960 }], sources: [{ source: 'internal' }] } });
      if (url.pathname === '/api/log/subscribe') return json({ success: true, result: { id: ++this.subscription } });
      if (url.pathname === '/api/log/unsubscribe') return json({ success: true });
      if (url.pathname === '/api/log/pull') {
        if (this.dropNextPull) return ((this.dropNextPull = false), req.socket.destroy());
        if (Number(url.searchParams.get('id')) !== this.subscription) return json({ success: false, error: { code: 12, param: 'id', description: 'invalid subscription id' } });
        const reply = (events: unknown[]) => json({ success: true, result: { events } });
        if (this.queue.length) return reply(this.queue.splice(0));
        const t = setTimeout(() => ((this.waiting = this.waiting.filter((w) => w !== done)), reply([])), Number(url.searchParams.get('timeout') ?? 0) * 1000);
        const done = (events: unknown[]) => (clearTimeout(t), reply(events));
        this.waiting.push(done);
        return;
      }
      if (url.pathname === '/api/camera/snapshot') {
        if (url.searchParams.get('width') === '999') return json({ success: false, error: { code: 12, param: 'width', description: 'invalid parameter value' } });
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' });
        res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${TINY_JPEG.length}\r\n\r\n`);
        return res.write(TINY_JPEG);
      }
      json({ success: false, error: { code: 1, description: 'api function not found' } }, 404);
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }
}

let fakes: Fake2N[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.stop()));
  fakes = [];
});
const fake = async () => {
  const f = await new Fake2N().start();
  fakes.push(f);
  return f;
};
const config = (f: Fake2N, p: Partial<CameraSecretConfig> = {}): CameraSecretConfig => ({
  id: 'cam-tuer',
  name: 'Tür',
  type: '2n',
  host: `127.0.0.1:${f.port}`,
  protocol: 'http',
  username: 'elvis',
  password: 'geheim',
  verifyTls: false,
  resolution: '640x480',
  enabled: true,
  bells: [],
  sort: 0,
  ...p,
});

describe('2N-Türstation', () => {
  it('wählt die nächstliegende Bildgröße der Türstation', () => {
    const list = [
      { width: 320, height: 240 },
      { width: 640, height: 480 },
      { width: 1280, height: 960 },
    ];
    expect(nearestResolution({ width: 1280, height: 720 }, list)).toEqual({ width: 1280, height: 960 });
    expect(nearestResolution({ width: 640, height: 360 }, list)).toEqual({ width: 640, height: 480 });
    expect(nearestResolution({ width: 1280, height: 720 }, [])).toEqual({ width: 640, height: 480 });
  });

  it('erkennt Modell und Bildgrößen, meldet keine Bedienfunktionen', async () => {
    const f = await fake();
    const probe = await defaultFactory(config(f)).probe();
    expect(probe.model).toBe('2N IP Base');
    expect(Object.values(probe.caps).every((v) => !v)).toBe(true);
    expect(probe.notes).toEqual(['Firmware 2.48.1.72.5', 'Bildgrößen: 160x120, 320x240, 640x480, 1280x960']);
  });

  it('meldet falsche Zugangsdaten verständlich', async () => {
    const f = await fake();
    await expect(defaultFactory(config(f, { password: 'falsch' })).probe()).rejects.toThrow(/Benutzer\/Passwort/);
  });

  it('holt das Livebild als MJPEG in passender Größe und Bildrate', async () => {
    const f = await fake();
    const a = new CamerasAdapter({ list: () => [config(f, { resolution: '1280x720' })], onChange: () => () => {} });
    await a.start({ log: { info: () => {}, warn: () => {}, error: () => {} }, getState: () => undefined });
    for (let i = 0; i < 100 && !a.getState().cameras[0]?.online; i++) await new Promise((r) => setTimeout(r, 20));
    expect(a.getState().cameras[0]).toMatchObject({ type: '2n', online: true, model: '2N IP Base' });
    await expect(a.execute('zoom', { cameraId: 'cam-tuer', direction: 1 })).rejects.toThrow(/unterstützt das nicht/);

    const live = (await a.openStream('cam-tuer', 'live'))!;
    expect(live.contentType).toBe('multipart/x-mixed-replace; boundary=elvisframe');
    expect((await new Promise<Buffer>((r) => live.stream.once('data', r))).toString('latin1')).toContain('Content-Type: image/jpeg');
    live.stream.destroy();
    (await a.openStream('cam-tuer', 'thumb'))!.stream.destroy();
    expect(f.calls.filter((c) => c.startsWith('/api/camera/snapshot'))).toEqual(['/api/camera/snapshot?width=1280&height=960&fps=10', '/api/camera/snapshot?width=320&height=240&fps=2']);
    await a.stop();
  });

  it('gibt den Fehlergrund der Türstation weiter', async () => {
    const f = await fake();
    const cam = new TwoNIntercom({ host: `127.0.0.1:${f.port}`, protocol: 'http', username: 'elvis', password: 'geheim', verifyTls: false });
    // Größe, die die Türstation ablehnt
    (cam as unknown as { resolutions: { width: number; height: number }[] }).resolutions = [{ width: 999, height: 999 }];
    await expect(cam.openStream('live', '999x999')).rejects.toThrow('Videobild abgelehnt (invalid parameter value (width); Anfrage: 999x999)');
  });
});

describe('Klingeln', () => {
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };
  const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} }, getState: () => undefined };

  it('meldet Kurzwahltasten, abonniert nach Ablauf neu und ignoriert den Ziffernblock', async () => {
    const f = await fake();
    const cam = new TwoNIntercom({ host: `127.0.0.1:${f.port}`, protocol: 'http', username: 'elvis', password: 'geheim', verifyTls: false });
    cam.pullSeconds = 1;
    const keys: string[] = [];
    const stop = cam.watchRings((k) => keys.push(k), () => {});
    await until(() => f.calls.some((c) => c.startsWith('/api/log/pull')));
    f.press('%1');
    f.press('5');
    await until(() => keys.length === 1);
    // Türstation neu gestartet: altes Abo ungültig
    f.subscription += 10;
    await until(() => f.calls.filter((c) => c.startsWith('/api/log/subscribe')).length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    f.press('%2');
    await until(() => keys.length === 2);
    expect(keys).toEqual(['1', '2']);
    expect(f.calls.find((c) => c.startsWith('/api/log/subscribe'))).toBe('/api/log/subscribe?include=new&filter=KeyPressed&duration=4');
    stop();
  });

  it('behält das Abo bei Netzwerkfehlern, damit kein Klingeln in der Lücke verloren geht', async () => {
    const f = await fake();
    const cam = new TwoNIntercom({ host: `127.0.0.1:${f.port}`, protocol: 'http', username: 'elvis', password: 'geheim', verifyTls: false });
    Object.assign(cam, { pullSeconds: 1, pullRetryMs: 50 });
    const keys: string[] = [];
    const errors: string[] = [];
    const stop = cam.watchRings((k) => keys.push(k), (m) => errors.push(m));
    await until(() => f.calls.some((c) => c.startsWith('/api/log/pull')));
    f.dropNextPull = true;
    await until(() => errors.length === 1);
    // in der Lücke gedrückt: die Türstation hält das Ereignis vor
    f.press('%1');
    await until(() => keys.length === 1);
    expect(f.calls.filter((c) => c.startsWith('/api/log/subscribe'))).toHaveLength(1);
    stop();
  });

  it('zeigt das Klingeln für die eingestellten Bildschirme und fasst mehrfaches Drücken zusammen', async () => {
    const f = await fake();
    const bells = [
      { key: '1', label: 'Haupteingang', displays: ['disp-lage'] },
      { key: '*', label: 'Nebeneingang', displays: ['disp-lage', 'disp-fuehrung'] },
    ];
    const a = new CamerasAdapter({ list: () => [config(f, { bells })], onChange: () => () => {} });
    await a.start(ctx);
    await until(() => f.calls.some((c) => c.startsWith('/api/log/pull')));
    f.press('%1');
    await until(() => a.getState().rings.length === 1);
    expect(a.getState().rings[0]).toMatchObject({ cameraId: 'cam-tuer', cameraName: 'Tür', key: '1', label: 'Haupteingang', displays: ['disp-lage'] });
    const first = a.getState().rings[0]!.id;
    f.press('%1');
    f.press('%3');
    await until(() => a.getState().rings.length === 2);
    expect(a.getState().rings[0]!.id).toBe(first);
    expect(a.getState().rings[1]).toMatchObject({ key: '3', label: 'Nebeneingang', displays: ['disp-lage', 'disp-fuehrung'] });
    await a.stop();
  });
});
