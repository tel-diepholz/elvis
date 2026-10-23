import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CameraSecretConfig } from '../../../services/cameras.js';
import { CamerasAdapter } from '../cameras.js';
import { AxisCamera } from './camera.js';
import { FakeAxis } from './fake-axis.js';
import { digestHeader, parseChallenges } from './http.js';

const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} }, getState: () => undefined };
let fakes: FakeAxis[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fakes.map((f) => f.stop()));
  fakes = [];
});
const fake = async (o: ConstructorParameters<typeof FakeAxis>[0]) => {
  const f = await new FakeAxis(o).start();
  fakes.push(f);
  return f;
};
const connect = (f: FakeAxis, password = 'pass') => new AxisCamera({ host: f.host, protocol: 'http', username: 'root', password, verifyTls: false });

describe('Digest-Anmeldung', () => {
  it('wählt das stärkste Verfahren und rechnet nach RFC 7616', () => {
    const offers = parseChallenges(['Basic realm="x"', 'Digest realm="AXIS", nonce="n1", algorithm=MD5, qop="auth"', 'Digest realm="AXIS", nonce="n2", algorithm=SHA-256, qop="auth"']);
    expect(offers.map((o) => [o.scheme, o.algorithm])).toEqual([
      ['digest', 'SHA-256'],
      ['digest', 'MD5'],
      ['basic', 'MD5'],
    ]);
    // Beispiel aus RFC 2617 (MD5, qop=auth)
    const h = digestHeader({ scheme: 'digest', realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', opaque: '5ccc069c403ebaf9f0171e9517f40e41', qop: 'auth', algorithm: 'MD5' }, 'Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', 1, '0a4f113b');
    expect(h).toContain('response="6629fae49393a05397450978507c4ef1"');
  });

  it('meldet falsche Zugangsdaten verständlich', async () => {
    const f = await fake({ kind: 'optics' });
    await expect(connect(f, 'falsch').probe()).rejects.toThrow(/Benutzer\/Passwort/);
  });
});

describe('Axis-Kamera', () => {
  it('feste Kamera mit Motorobjektiv (P3225-LVE Mk II): Zoom/Fokus/IR-Filter über Optics Control', async () => {
    const f = await fake({ kind: 'optics', model: 'AXIS P3225-LVE Mk II' });
    const cam = connect(f);
    const probe = await cam.probe();
    expect(probe).toMatchObject({ model: 'AXIS P3225-LVE Mk II', caps: { panTilt: false, zoom: true, continuousZoom: false, focus: true, autofocus: true, dayNight: true, home: false, zoomUnit: 'factor' } });
    expect(await cam.read()).toEqual({ position: { pan: null, tilt: null, zoom: 1, focus: 0.5 }, dayNight: 'auto' });

    await cam.zoomStep(1, false);
    await cam.setDayNight('night');
    await cam.autofocus();
    expect(f.calls.filter((c) => c.includes('opticscontrol')).map((c) => JSON.parse(c.split(' ').slice(2).join(' ')).method)).toEqual(
      expect.arrayContaining(['setRelativeMagnification', 'setIrCutFilterState', 'performAutofocus']),
    );
    expect(await cam.read()).toMatchObject({ position: { zoom: 1.1 }, dayNight: 'night' });
    await cam.goto({ pan: null, tilt: null, zoom: 2.5, focus: 0.3 });
    expect(f.state).toMatchObject({ zoom: 2.5, focus: 0.3 });
  });

  it('nimmt Optics Control, auch wenn ptz.cgi Grenzen meldet, aber abgeschaltet ist', async () => {
    for (const noVersionQuery of [false, true]) {
      const f = await fake({ kind: 'optics', ptzLens: true, noVersionQuery, model: 'AXIS P3225-LVE Mk II' });
      const cam = connect(f);
      const probe = await cam.probe();
      expect(probe.caps).toMatchObject({ zoom: true, focus: true, panTilt: false, continuousZoom: false });
      // ohne getSupportedVersions wird 1.2 probiert und angenommen
      expect(probe.notes).toEqual(['Zoom über Optics Control 1.2', 'Fokus über Optics Control 1.2', 'Tag/Nacht über Optics Control 1.2', 'ptz.cgi: PTZ disabled']);
      await cam.focusStep(1, false);
      await cam.zoomStep(1, false);
      expect(f.calls.some((c) => c.includes('rfocus') || c.includes('rzoom'))).toBe(false);
      expect((await cam.read()).position.zoom).toBe(1.1);
    }
  });

  it('P3225-LVE Mk II (wie gemessen): Objektiv über opticssetup.cgi, Tag/Nacht über param.cgi, ptz.cgi ignoriert', async () => {
    const f = await fake({ kind: 'optics', ptzLens: true, setupLens: true, model: 'AXIS P3225-LVE Mk II' });
    f.state.zoom = 1;
    f.state.focus = 0.745455;
    f.state.ir = 'yes';
    const cam = connect(f);
    cam.settleMs = 1;
    const probe = await cam.probe();
    // ptz.cgi meldet Schwenkgrenzen, ist aber abgeschaltet → kein Steuerkreuz
    expect(probe.caps).toEqual({ panTilt: false, zoom: true, continuousZoom: false, focus: true, autofocus: true, dayNight: true, home: false, zoomUnit: 'fraction' });
    expect(probe.notes).toEqual(['Zoom über opticssetup.cgi', 'Fokus über opticssetup.cgi', 'Tag/Nacht über param.cgi', 'ptz.cgi: PTZ disabled']);
    expect(await cam.read()).toEqual({ position: { pan: null, tilt: null, zoom: 1, focus: 0.7455 }, dayNight: 'day' });

    await cam.zoomStep(-1, false);
    await cam.focusStep(1, true);
    expect((await cam.read()).position).toMatchObject({ zoom: 0.98, focus: 0.7955 });
    await cam.setDayNight('night');
    expect(f.state.ir).toBe('no');
    await cam.autofocus();
    expect(f.calls.at(-1)).toBe('GET /axis-cgi/opticssetup.cgi?autofocus=perform');

    // Position anfahren: nur relative Befehle, Zoom vor Fokus
    f.calls.length = 0;
    await cam.goto({ pan: null, tilt: null, zoom: 0.3, focus: 0.474 });
    expect(f.state).toMatchObject({ zoom: 0.3, focus: 0.474 });
    const moves = f.calls.filter((c) => /r(zoom|focus)=/.test(c));
    expect(moves).toEqual(['GET /axis-cgi/opticssetup.cgi?rzoom=-0.68', 'GET /axis-cgi/opticssetup.cgi?rfocus=0.054']);
    expect(f.calls.some((c) => /[?&](zoom|focus)=/.test(c))).toBe(false);
  });

  it('nennt in der Diagnose, was fehlt', async () => {
    const f = await fake({ kind: 'ptz' });
    (f as unknown as { o: { kind: string; ptzLens: boolean } }).o = { kind: 'none', ptzLens: true } as never;
    const probe = await connect(f).probe();
    expect(probe.caps).toMatchObject({ zoom: false, focus: false, panTilt: false });
    expect(probe.notes).toEqual(expect.arrayContaining(['ptz.cgi: PTZ disabled', 'opticssetup.cgi: nicht vorhanden']));
  });

  it('meldet Ablehnungen von ptz.cgi verständlich', async () => {
    const f = await fake({ kind: 'optics', ptzLens: true });
    const cam = connect(f);
    await expect((cam as unknown as { ptz(q: string): Promise<void> }).ptz('rfocus=250')).rejects.toThrow('Kamera lehnt ab: rfocus: unsupported');
  });

  it('PTZ-Kamera: Schwenken/Neigen, Position und Grundstellung über ptz.cgi', async () => {
    const f = await fake({ kind: 'ptz' });
    const cam = connect(f);
    expect((await cam.probe()).caps).toEqual({ panTilt: true, zoom: true, continuousZoom: true, focus: true, autofocus: true, dayNight: true, home: true, zoomUnit: 'steps' });
    await cam.move(50, -20, 0);
    await cam.stop();
    await cam.goto({ pan: 45, tilt: -10, zoom: 2000, focus: null });
    await cam.home();
    expect(f.calls.filter((c) => c.includes('ptz.cgi') && !c.includes('query') && !c.includes('info=1'))).toEqual([
      'GET /axis-cgi/com/ptz.cgi?camera=1&continuouspantiltmove=50,-20&continuouszoommove=0',
      'GET /axis-cgi/com/ptz.cgi?camera=1&continuouspantiltmove=0,0&continuouszoommove=0',
      'GET /axis-cgi/com/ptz.cgi?camera=1&pan=45&tilt=-10&zoom=2000',
      'GET /axis-cgi/com/ptz.cgi?camera=1&move=home',
    ]);
    expect((await cam.read()).position).toEqual({ pan: 45, tilt: -10, zoom: 2000, focus: 5000 });
  });
});

describe('Livebild', () => {
  it('weicht auf einfachere Parameter aus, wenn die Kamera ablehnt, und merkt sich die Variante', async () => {
    const f = await fake({ kind: 'optics', rejectStreamParams: ['compression', 'fps'] });
    const cam = connect(f);
    const s1 = await cam.openStream('thumb', '1280x720');
    s1.destroy();
    expect(f.calls.filter((c) => c.includes('video.cgi'))).toEqual([
      'GET /axis-cgi/mjpg/video.cgi?resolution=1280x720&fps=2&compression=60',
      'GET /axis-cgi/mjpg/video.cgi?resolution=1280x720&fps=2',
      'GET /axis-cgi/mjpg/video.cgi?resolution=1280x720',
    ]);
    // zweiter Aufruf beginnt gleich mit der funktionierenden Variante
    f.calls.length = 0;
    (await cam.openStream('thumb', '1280x720')).destroy();
    expect(f.calls).toEqual(['GET /axis-cgi/mjpg/video.cgi?resolution=1280x720']);
  });

  it('nennt den Grund der Kamera, wenn nichts geht', async () => {
    const f = await fake({ kind: 'optics', rejectStreamParams: ['*'] });
    const err = (await connect(f).openStream('live', '1280x720').catch((e: Error) => e)) as Error;
    expect(err.message).toBe("Videobild abgelehnt (HTTP 400: 400 Bad Request Error: Invalid parameter '*'; Anfrage: ohne Parameter)");
    expect(f.calls.filter((c) => c.includes('video.cgi'))).toHaveLength(3);
  });
});

describe('Kameramodul', () => {
  const config = (f: FakeAxis, p: Partial<CameraSecretConfig> = {}): CameraSecretConfig => ({
    id: 'cam-1',
    name: 'Mast',
    type: 'axis',
    host: f.host,
    protocol: 'http',
    username: 'root',
    password: 'pass',
    verifyTls: false,
    resolution: '1280x720',
    enabled: true,
    sort: 0,
    ...p,
  });
  const source = (list: CameraSecretConfig[]) => {
    const listeners = new Set<() => void>();
    return { list: () => list, onChange: (l: () => void) => (listeners.add(l), () => listeners.delete(l)), set: (next: CameraSecretConfig[]) => ((list = next), listeners.forEach((l) => l())) };
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  };

  it('verbindet, meldet Fähigkeiten, prüft Befehle und hält Bewegungen ohne Nachricht an', async () => {
    const f = await fake({ kind: 'ptz', model: 'AXIS Q6075' });
    const src = source([config(f)]);
    const a = new CamerasAdapter(src);
    await a.start(ctx);
    await until(() => a.getState().cameras[0]?.online === true);
    expect(a.getState().cameras[0]).toMatchObject({ name: 'Mast', model: 'AXIS Q6075', caps: { panTilt: true } });
    expect(a.isQuiet('move')).toBe(true);
    expect(a.isQuiet('daynight')).toBe(false);

    await a.execute('move', { cameraId: 'cam-1', pan: 30 });
    // Kein weiterer Bewegungsbefehl → Kamera stoppt selbst
    await until(() => f.calls.some((c) => c.includes('continuouspantiltmove=0,0')));

    await expect(a.execute('daynight', { cameraId: 'cam-1', mode: 'tag' })).rejects.toThrow(/Ungültige Parameter/);
    expect(await a.execute('daynight', { cameraId: 'cam-1', mode: 'night' })).toBe('Mast: Nachtmodus');
    await expect(a.execute('zoom', { cameraId: 'gibtsnicht', direction: 1 })).rejects.toThrow(/unbekannt/);

    // Livebild kommt als MJPEG durch
    const stream = await a.openStream('cam-1', 'live');
    const first = await new Promise<Buffer>((r) => stream!.once('data', r));
    expect(first.toString('latin1')).toContain('--myboundary');
    stream!.destroy();

    // Kamera wird deaktiviert → verschwindet
    src.set([config(f, { enabled: false })]);
    expect(a.getState().cameras).toEqual([]);
    await a.stop();
  });

  it('meldet nicht erreichbare Kameras, ohne die anderen zu stören', async () => {
    const f = await fake({ kind: 'optics' });
    const a = new CamerasAdapter(source([config(f), config(f, { id: 'cam-2', name: 'Heck', host: '127.0.0.1:1' })]));
    await a.start(ctx);
    await until(() => a.getState().cameras.find((c) => c.id === 'cam-2')?.error !== null && a.getState().cameras[0]!.online);
    expect(a.getState().cameras.map((c) => [c.id, c.online])).toEqual([
      ['cam-1', true],
      ['cam-2', false],
    ]);
    expect(a.isOnline()).toBe(true);
    await expect(a.execute('zoom', { cameraId: 'cam-2', direction: 1 })).rejects.toThrow(/nicht erreichbar/);
    await expect(a.execute('home', { cameraId: 'cam-1' })).rejects.toThrow(/unterstützt das nicht/);
    await a.stop();
  });
});
