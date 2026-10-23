import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_VEHICLE_SIGN, type Settings, type User } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie, sessionCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-settings-'));
  app = await buildApp(parseConfig({ dataDir, vehicle: { name: 'ELW 2', callsign: 'Florian Musterstadt 12/11-1', organization: 'FF Musterstadt' } }), { logger: false });
});
afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const call = async <T = unknown>(method: 'GET' | 'PUT' | 'POST', url: string, cookie?: string, payload?: unknown) => {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: res.json() as T, setCookie: res.headers['set-cookie'] };
};

const input = {
  vehicle: { name: 'ELW 2 Nord', callsign: 'Florian Nordstadt 12/11-2', organization: 'FF Nordstadt' },
  mapSign: { ...DEFAULT_VEHICLE_SIGN, text: 'ELW 2', orgLabel: 'FW' },
};

describe('Systemeinstellungen', () => {
  it('liefert ohne Anmeldung die Vorgaben aus der Konfiguration und das Standard-Kartenzeichen', async () => {
    const res = await call<Settings>('GET', '/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.vehicle.callsign).toBe('Florian Musterstadt 12/11-1');
    expect(res.body.mapSign).toEqual(DEFAULT_VEHICLE_SIGN);
    expect(res.body.updatedBy).toBeNull();
  });

  it('dürfen nur Admins ändern', async () => {
    const admin = await adminCookie(app);
    expect((await call('PUT', '/api/settings', undefined, input)).status).toBe(401);
    const anna = (await call<User>('POST', '/api/users', admin, { firstName: 'Anna', lastName: 'Test', pin: '1111' })).body;
    const user = sessionCookie((await call('POST', '/api/auth/login', undefined, { userId: anna.id, pin: '1111' })).setCookie);
    expect((await call('PUT', '/api/settings', user, input)).status).toBe(403);

    const saved = await call<Settings>('PUT', '/api/settings', admin, input);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ vehicle: input.vehicle, updatedBy: 'Max Müller' });
    expect(saved.body.mapSign.orgLabel).toBe('FW');
  });

  it('wirken sich auf Info, Live-Verbindung und Bedienprotokoll aus', async () => {
    const admin = await adminCookie(app);
    await call('PUT', '/api/settings', admin, input);
    expect((await call<{ vehicle: { name: string } }>('GET', '/api/info')).body.vehicle.name).toBe('ELW 2 Nord');
    const audit = (await call<{ target: string; message: string }[]>('GET', '/api/audit', admin)).body;
    expect(audit[0]).toMatchObject({ target: 'einstellungen', message: 'Fahrzeug: ELW 2 Nord / Florian Nordstadt 12/11-2, Kartenzeichen geändert' });
  });

  it('weist ungültige Werte ab', async () => {
    const admin = await adminCookie(app);
    expect((await call('PUT', '/api/settings', admin, { ...input, vehicle: { ...input.vehicle, name: '' } })).status).toBe(400);
    expect((await call('PUT', '/api/settings', admin, { ...input, mapSign: { ...input.mapSign, org: 'marine' } })).status).toBe(400);
  });
});
