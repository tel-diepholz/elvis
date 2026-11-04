import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnergyFlowConfig, EnergyFlowSettings } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';

async function req<T = unknown>(method: 'GET' | 'PUT', url: string, payload?: unknown, cookie = admin) {
  const res = await app.server.inject({ method, url, payload: payload as object, headers: cookie ? { cookie } : {} });
  return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
}

const config: EnergyFlowConfig = {
  hubLabel: 'ELW',
  nodes: [
    { slot: 'left-1', kind: 'shore', label: 'Landstrom', source: { type: 'inverter', channel: 'ac-in' }, extra: null },
    { slot: 'bottom', kind: 'battery', label: 'Batterie', source: { type: 'inverter', channel: 'dc' }, extra: { type: 'bluetooth', deviceId: 'shunt' } },
  ],
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-energyflow-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Energiefluss-Einstellung', () => {
  it('ist ohne Anmeldung lesbar, zunächst automatisch', async () => {
    const res = await req<EnergyFlowSettings>('GET', '/api/energy-flow', undefined, '');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ config: null, updatedAt: null, updatedBy: null });
  });

  it('speichern dürfen nur Admins; zurück auf automatisch', async () => {
    expect((await req('PUT', '/api/system/energy-flow', { config }, '')).status).toBe(401);
    const saved = await req<EnergyFlowSettings>('PUT', '/api/system/energy-flow', { config });
    expect(saved.status).toBe(200);
    expect(saved.body.config).toEqual(config);
    expect((await req<EnergyFlowSettings>('GET', '/api/energy-flow', undefined, '')).body.config).toEqual(config);
    const reset = await req<EnergyFlowSettings>('PUT', '/api/system/energy-flow', { config: null });
    expect(reset.body.config).toBeNull();
    expect(reset.body.updatedBy).toBeTruthy();
  });

  it('weist doppelt belegte Plätze und mehrere Bilanzen ab', async () => {
    const twice = { ...config, nodes: [config.nodes[0], { ...config.nodes[1]!, slot: 'left-1' }] };
    expect((await req('PUT', '/api/system/energy-flow', { config: twice })).status).toBe(400);
    const balances = {
      ...config,
      nodes: [
        { slot: 'top', kind: 'dc-loads', label: '', source: { type: 'balance' }, extra: null },
        { slot: 'right-2', kind: 'dc-loads', label: '', source: { type: 'balance' }, extra: null },
      ],
    };
    expect((await req('PUT', '/api/system/energy-flow', { config: balances })).status).toBe(400);
  });
});
