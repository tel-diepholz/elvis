import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Kleinstes gültiges JPEG (1×1 Pixel) für MJPEG-Tests */
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

export interface FakeAxisOptions {
  kind: 'optics' | 'ptz';
  user?: string;
  password?: string;
  model?: string;
  /** Eigenes Bild für das MJPEG-Livebild (Standard: 1×1 Pixel) */
  jpeg?: Buffer;
  /** Feste Kamera, deren ptz.cgi Objektivgrenzen meldet, Zoom-/Fokusbefehle aber ablehnt (wie P3225-LVE Mk II) */
  ptzLens?: boolean;
  /** Objektiv nur über opticssetup.cgi (keine Optics Control API) – wie P3225-LVE Mk II laut API-Liste */
  setupLens?: boolean;
  /** Optics Control ohne getSupportedVersions (ältere Firmware) */
  noVersionQuery?: boolean;
  /** Diese Parameter des Livebilds mit HTTP 400 ablehnen (wie eine Kamera, der ein Wert nicht passt); '*' = alles */
  rejectStreamParams?: string[];
}

/**
 * Nachgebaute Axis-Kamera für Tests: Digest-Anmeldung (MD5), param.cgi, ptz.cgi bzw. opticscontrol.cgi und MJPEG.
 * `kind: 'optics'` entspricht einer festen Kamera mit Motorobjektiv (z. B. P3225-LVE Mk II).
 */
export class FakeAxis {
  server!: Server;
  port = 0;
  readonly calls: string[] = [];
  state = { pan: 0, tilt: 0, zoom: 1, focus: 0.5, ir: 'auto', ptzZoom: 1, ptzFocus: 5000 };
  streams = 0;
  private readonly nonce = 'abc123';

  constructor(private readonly o: FakeAxisOptions) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  get host() {
    return `127.0.0.1:${this.port}`;
  }

  private authorized(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Digest ')) return false;
    const p: Record<string, string> = {};
    for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) p[m[1]!] = m[2] ?? m[3] ?? '';
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const ha1 = md5(`${this.o.user ?? 'root'}:AXIS_TEST:${this.o.password ?? 'pass'}`);
    const ha2 = md5(`${req.method}:${p.uri}`);
    return p.response === md5(`${ha1}:${this.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) && p.uri === req.url;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!this.authorized(req)) {
        res.writeHead(401, [
          ['WWW-Authenticate', `Digest realm="AXIS_TEST", nonce="${this.nonce}", algorithm=MD5, qop="auth"`],
          ['WWW-Authenticate', 'Basic realm="AXIS_TEST"'],
        ]);
        return res.end();
      }
      const url = new URL(req.url!, 'http://x');
      this.calls.push(`${req.method} ${url.pathname}${url.search}${raw ? ` ${raw}` : ''}`);
      const text = (s: string, status = 200) => (res.writeHead(status, { 'content-type': 'text/plain' }), res.end(s));
      const json = (data: unknown) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ apiVersion: '1.2', data })));

      if (url.pathname === '/axis-cgi/param.cgi') {
        const q = url.searchParams;
        if (q.get('action') === 'update' && q.has('ImageSource.I0.DayNight.IrCutFilter')) {
          this.state.ir = q.get('ImageSource.I0.DayNight.IrCutFilter')!;
          return text('OK\n');
        }
        if (q.get('group')?.startsWith('ImageSource.I0.DayNight')) return text(this.o.setupLens ? `root.ImageSource.I0.DayNight.IrCutFilter=${this.state.ir}\n` : '# Error: Error -1 getting param in group');
        return text(`root.Brand.ProdShortName=${this.o.model ?? 'AXIS Test'}\nroot.Brand.Brand=AXIS\n`);
      }
      if (url.pathname === '/axis-cgi/com/ptz.cgi') {
        const q = url.searchParams;
        if (this.o.kind !== 'ptz') {
          if (!this.o.ptzLens) return text('Not found', 404);
          // wie P3225-LVE Mk II: Standardgrenzen (sogar Schwenken), leere Position, Befehlsliste abgeschaltet
          if (q.get('query') === 'limits') return text('MinPan=-165\nMaxPan=165\nMinTilt=-165\nMaxTilt=165\nMinZoom=1\nMaxZoom=9999\nMinFocus=1\nMaxFocus=9999\n');
          if (q.get('query') === 'position') return text('');
          if (q.get('info') === '1') return text('Error:\r\nPTZ disabled\r\n');
          const cmd = [...q.keys()].find((k) => k !== 'camera');
          return text(`Error:\r\n${cmd}: unsupported\r\n`);
        }
        if (q.get('info') === '1')
          return text(
            'Available commands (camera 1):\n{camera=[n]}\ncenter=x,y\npan=[abs]\ntilt=[abs]\nzoom=[n]\nfocus=[n]\nrzoom=[n]\nrfocus=[n]\nautofocus=on|off\ncontinuouspantiltmove=x,y\ncontinuouszoommove=n\nircutfilter=on|off|auto\nmove=home\nquery=limits|position\n',
          );
        if (q.get('query') === 'limits') return text('MinPan=-180\nMaxPan=180\nMinTilt=-90\nMaxTilt=20\nMinZoom=1\nMaxZoom=9999\nMinFocus=1\nMaxFocus=9999\n');
        if (q.get('query') === 'position') return text(`pan=${this.state.pan}\ntilt=${this.state.tilt}\nzoom=${this.state.ptzZoom}\nfocus=${this.state.ptzFocus}\nautofocus=on\nircutfilter=${this.state.ir}\n`);
        if (q.has('pan')) this.state.pan = Number(q.get('pan'));
        if (q.has('tilt')) this.state.tilt = Number(q.get('tilt'));
        if (q.has('zoom')) this.state.ptzZoom = Number(q.get('zoom'));
        if (q.has('ircutfilter')) this.state.ir = q.get('ircutfilter')!;
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/axis-cgi/opticssetup.cgi') {
        if (!this.o.setupLens) return text('Not found', 404);
        const q = url.searchParams;
        const bad = () => text('The request had bad syntax or was inherently impossible to satisfy', 400);
        if (q.get('monitor') === 'poll')
          return text(
            `<?xml version="1.0" encoding="iso-8859-1"?>\n<devInfo xmlns="http://www.axis.com/OpticsSetupSchema" version="1">\n<opticsSetupState focusMeasure="1.0" focusOperationInProgress="0" focusPosition="${this.state.focus.toFixed(6)}" isDay="1" zoomOperationInProgress="0" zoomPosition="${this.state.zoom.toFixed(6)}" />\n</devInfo>\n`,
          );
        const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1e6) / 1e6;
        if (q.has('rzoom')) {
          const d = Number(q.get('rzoom'));
          if (Number.isNaN(d)) return bad();
          this.state.zoom = clamp(this.state.zoom + d);
          return text('ok\n');
        }
        if (q.has('rfocus')) {
          const d = Number(q.get('rfocus'));
          if (Number.isNaN(d)) return bad();
          this.state.focus = clamp(this.state.focus + d);
          return text('ok\n');
        }
        if (q.get('autofocus') === 'perform') {
          this.state.focus = 0.42;
          return text('ok\n');
        }
        return bad(); // u. a. absolute zoom=/focus= kennt die Kamera nicht
      }
      if (url.pathname === '/axis-cgi/opticscontrol.cgi') {
        if (this.o.kind !== 'optics' || this.o.setupLens) return text('Not found', 404);
        const body = JSON.parse(raw) as { apiVersion?: string; method: string; params?: { optics: Record<string, unknown>[] } };
        const p = body.params?.optics[0] ?? {};
        const fail = (code: number, message: string) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ error: { code, message } })));
        if (body.method === 'getSupportedVersions') return this.o.noVersionQuery ? fail(2102, 'Method not supported') : json({ apiVersions: ['1.0', '1.1', '1.2'] });
        // wie echte Kameras: Version als „<Major>.<Minor>“
        if (!/^1\.\d+$/.test(body.apiVersion ?? '')) return fail(2100, 'The requested API version is not supported');
        switch (body.method) {
          case 'getCapabilities':
            return json({ numberOfOptics: 1, optics: [{ opticsId: '0', capabilities: ['zoom', 'focus', 'irCutFilter'], maxMagnification: 3.1 }] });
          case 'getOptics':
            return json({ numberOfOptics: 1, optics: [{ opticsId: '0', magnification: this.state.zoom, focusPosition: this.state.focus, irCutFilterState: this.state.ir, zoomMoving: false, focusMoving: false }] });
          case 'setRelativeMagnification':
            this.state.zoom = Math.max(1, Math.min(3.1, this.state.zoom + (String(p.type).startsWith('+') ? 0.1 : -0.1) * (String(p.type).includes('big') ? 5 : 1)));
            return json({});
          case 'setMagnification':
            this.state.zoom = Number(p.magnification);
            return json({});
          case 'setFocus':
            this.state.focus = Number(p.position);
            return json({});
          case 'setRelativeFocus':
          case 'performAutofocus':
            return json({});
          case 'setIrCutFilterState':
            this.state.ir = String(p.irCutFilterState);
            return json({});
          default:
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: { code: 2102, message: 'Method not supported' } }));
        }
      }
      if (url.pathname === '/axis-cgi/mjpg/video.cgi') {
        const bad = (this.o.rejectStreamParams ?? []).find((k) => k === '*' || url.searchParams.has(k));
        if (bad) return text(`<HTML><BODY><H1>400 Bad Request</H1>Error: Invalid parameter '${bad}'</BODY></HTML>`, 400);
        this.streams++;
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=myboundary' });
        const jpeg = this.o.jpeg ?? TINY_JPEG;
        const frame = () => res.write(Buffer.concat([Buffer.from(`--myboundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`), jpeg, Buffer.from('\r\n')]));
        frame();
        const t = setInterval(frame, 100);
        res.on('close', () => {
          clearInterval(t);
          this.streams--;
        });
        return;
      }
      text('Not found', 404);
    });
  }
}
