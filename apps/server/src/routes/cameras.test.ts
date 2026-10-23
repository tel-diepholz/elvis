import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CameraConfig, CameraPreset, CameraTestResult, DeviceSnapshot, Incident } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { FakeAxis } from '../devices/drivers/axis/fake-axis.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let cam: FakeAxis;
let cookie = '';

async function req<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, auth = true) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: auth ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const until = async (cond: () => Promise<boolean> | boolean) => {
  for (let i = 0; i < 100 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 20));
  expect(await cond()).toBe(true);
};

const input = (p: Record<string, unknown> = {}) => ({
  name: 'Lichtmast',
  type: 'axis',
  host: cam.host,
  protocol: 'http',
  username: 'root',
  password: 'pass',
  verifyTls: false,
  resolution: '1280x720',
  enabled: true,
  ...p,
});

const cameraState = async () => (await req<DeviceSnapshot<'cameras'>>('GET', '/api/devices/cameras')).body.state.cameras;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-test-'));
  cam = await new FakeAxis({ kind: 'optics', model: 'AXIS P3225-LVE Mk II' }).start();
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  await app.devices.start();
  cookie = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  await cam.stop();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Kameraverwaltung', () => {
  it('legt Kameras an, testet die Verbindung und liefert das Passwort nie aus', async () => {
    const test = await req<CameraTestResult>('POST', '/api/system/cameras/test', { camera: input() });
    expect(test.body).toMatchObject({ ok: true, model: 'AXIS P3225-LVE Mk II', message: 'Verbunden mit AXIS P3225-LVE Mk II – Zoom, Fokus, Tag/Nacht (Zoom über Optics Control 1.2; Fokus über Optics Control 1.2; Tag/Nacht über Optics Control 1.2)' });
    expect((await req<CameraTestResult>('POST', '/api/system/cameras/test', { camera: input({ password: 'falsch' }) })).body).toMatchObject({ ok: false, message: expect.stringMatching(/Passwort/) });

    const created = await req<CameraConfig>('POST', '/api/system/cameras', input());
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Lichtmast', passwordSet: true });
    expect(JSON.stringify(created.body)).not.toContain('pass"');

    // Ändern ohne Passwort: bleibt gespeichert, Kamera bleibt erreichbar
    await req('PUT', `/api/system/cameras/${created.body.id}`, input({ name: 'Lichtmast vorn', password: '' }));
    await until(async () => (await cameraState())[0]?.online === true);
    expect((await cameraState())[0]).toMatchObject({ name: 'Lichtmast vorn', caps: { zoom: true, panTilt: false } });

    expect((await req('POST', '/api/system/cameras', input({ resolution: 'gross' }))).status).toBe(400);
    expect((await req('GET', '/api/system/cameras', undefined, false)).status).toBe(401);

    const audit = (await req<{ target: string; message: string }[]>('GET', '/api/audit')).body.filter((a) => a.target.startsWith('kamera:'));
    expect(audit.map((a) => a.message)).toEqual(expect.arrayContaining(['Kamera „Lichtmast“ angelegt (' + cam.host + ')', 'Kamera „Lichtmast vorn“ geändert']));
    expect(JSON.stringify(audit)).not.toContain('pass');
  });

  it('reicht das Livebild durch ELVIS, ohne Zugangsdaten preiszugeben – auch für anonyme Arbeitsplätze', async () => {
    const { body: c } = await req<CameraConfig>('POST', '/api/system/cameras', input());
    await app.server.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/cameras/${c.id}/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('multipart/x-mixed-replace; boundary=myboundary');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(Buffer.from(value!).toString('latin1')).toContain('Content-Type: image/jpeg');
    await reader.cancel();
    // Browser trennt → ELVIS schließt den Strom zur Kamera
    await until(() => cam.streams === 0);
    app.server.server.closeAllConnections(); // Keep-alive des Test-Clients
  });
});

describe('Kamerapositionen', () => {
  it('gehören zum laufenden Einsatz und sind nach Ende oder neuem Einsatz leer', async () => {
    const { body: c } = await req<CameraConfig>('POST', '/api/system/cameras', input());
    await until(async () => (await cameraState())[0]?.online === true);

    // ohne Einsatz kein Speichern
    expect((await req<{ error: string }>('POST', '/api/cameras/presets', { cameraId: c.id, name: 'Einfahrt' })).body.error).toMatch(/Einsatz/);

    const { body: first } = await req<Incident>('POST', '/api/incidents', { title: 'Brand Lagerhalle', keyword: 'B3' });
    await req('POST', '/api/devices/cameras/commands', { action: 'zoom', params: { cameraId: c.id, direction: 1, big: true } });
    const saved = await req<CameraPreset>('POST', '/api/cameras/presets', { cameraId: c.id, name: 'Rauchsäule' });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ incidentId: first.id, name: 'Rauchsäule', position: { zoom: 1.5, focus: 0.5, pan: null }, createdBy: 'Max Müller' });

    // Kamera verstellen und gespeicherte Position anfahren
    await req('POST', '/api/devices/cameras/commands', { action: 'zoom', params: { cameraId: c.id, direction: -1, big: true } });
    expect(cam.state.zoom).toBe(1);
    expect((await req<{ message: string }>('POST', `/api/cameras/presets/${saved.body.id}/goto`)).body.message).toBe('Lichtmast: Position „Rauchsäule“ angefahren');
    expect(cam.state.zoom).toBe(1.5);
    expect((await req<CameraPreset[]>('GET', '/api/cameras/presets')).body).toHaveLength(1);
    expect((await req('GET', '/api/cameras/presets', undefined, false)).status).toBe(401);

    // Einsatz beenden → Liste leer, alte Position lässt sich nicht mehr anfahren
    await req('POST', `/api/incidents/${first.id}/close`);
    expect((await req<CameraPreset[]>('GET', '/api/cameras/presets')).body).toEqual([]);
    expect((await req('POST', `/api/cameras/presets/${saved.body.id}/goto`)).status).toBe(409);

    // Neuer Einsatz startet ebenfalls leer
    await req('POST', '/api/incidents', { title: 'TH Verkehrsunfall' });
    expect((await req<CameraPreset[]>('GET', '/api/cameras/presets')).body).toEqual([]);

    const audit = (await req<{ action: string; message: string }[]>('GET', '/api/audit')).body;
    expect(audit.map((a) => a.message)).toEqual(expect.arrayContaining(['Lichtmast: Position „Rauchsäule“ gespeichert', 'Lichtmast: Position „Rauchsäule“ angefahren']));
  });

  it('schreibt Bewegungen per Gedrückthalten nicht ins Bedienprotokoll', async () => {
    const ptz = await new FakeAxis({ kind: 'ptz' }).start();
    try {
      const { body: c } = await req<CameraConfig>('POST', '/api/system/cameras', input({ host: ptz.host }));
      await until(async () => (await cameraState())[0]?.online === true);
      for (let i = 0; i < 5; i++) expect((await req('POST', '/api/devices/cameras/commands', { action: 'move', params: { cameraId: c.id, pan: 40 } })).status).toBe(200);
      await req('POST', '/api/devices/cameras/commands', { action: 'stop', params: { cameraId: c.id } });
      await req('POST', '/api/devices/cameras/commands', { action: 'home', params: { cameraId: c.id } });
      const actions = (await req<{ target: string; action: string }[]>('GET', '/api/audit')).body.filter((a) => a.target === 'cameras').map((a) => a.action);
      expect(actions).toEqual(['home']);
    } finally {
      await ptz.stop();
    }
  });
});
