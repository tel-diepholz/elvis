import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEVICE_IDS, type CommandResponse, type DeviceId, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { DeviceManager } from '../devices/manager.js';
import { listSerialPorts } from '../devices/serialports.js';
import { HttpError } from '../errors.js';
import { operatorOf, parse } from './util.js';

const commandBody = z.object({
  action: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

const moduleBody = z.object({
  enabled: z.boolean(),
  driver: z.string().min(1),
  options: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).default({}),
});

export function deviceRoutes(app: FastifyInstance, devices: DeviceManager, store: Store, notify: (topics: Topic[]) => void): void {
  app.get('/api/devices', async () => devices.snapshots());

  app.get<{ Params: { id: string } }>('/api/devices/:id', async (req) => {
    if (!devices.has(req.params.id)) throw new HttpError(404, `Unbekanntes Gerät ${req.params.id}`);
    return devices.snapshot(req.params.id);
  });

  app.post<{ Params: { id: string } }>('/api/devices/:id/commands', async (req): Promise<CommandResponse> => {
    const { id } = req.params;
    if (!devices.has(id)) throw new HttpError(404, `Unbekanntes Gerät ${id}`);
    const { action, params } = parse(commandBody, req.body);
    const audit = { operator: operatorOf(req), target: id, action, params: JSON.stringify(params ?? {}) };
    if (devices.isQuiet(id, action)) return { ok: true, message: (await devices.execute(id, action, params)) ?? undefined };
    try {
      const message = (await devices.execute(id, action, params)) ?? undefined;
      store.addAudit({ ...audit, success: true, message: message ?? '' });
      return { ok: true, message };
    } catch (err) {
      store.addAudit({ ...audit, success: false, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      notify(['audit']);
    }
  });

  app.get('/api/alerts', async () => devices.getAlerts());

  // Modulkonfiguration in den Einstellungen (nur Admins, siehe auth/access.ts)
  app.get('/api/system/devices', async () => devices.modules());

  app.put<{ Params: { id: string } }>('/api/system/devices/:id', async (req) => {
    const { id } = req.params;
    if (!(DEVICE_IDS as readonly string[]).includes(id)) throw new HttpError(404, `Unbekanntes Modul ${id}`);
    const body = parse(moduleBody, req.body);
    const current = devices.module(id as DeviceId);
    const before = current.config;
    // Passwörter nicht ins Bedienprotokoll schreiben
    const secret = Object.entries(current.drivers.find((d) => d.id === body.driver)?.options ?? {}).filter(([, o]) => o.type === 'password');
    const logged = { ...body, options: { ...body.options, ...Object.fromEntries(secret.filter(([k]) => body.options[k]).map(([k]) => [k, '***'])) } };
    const audit = { operator: operatorOf(req), target: `modul:${id}`, action: 'configure', params: JSON.stringify(logged) };
    try {
      const result = await devices.configure(id as DeviceId, body, operatorOf(req));
      const message = [
        before.enabled !== body.enabled && (body.enabled ? 'aktiviert' : 'deaktiviert'),
        before.driver !== body.driver && `Treiber: ${result.drivers.find((d) => d.id === body.driver)?.label ?? body.driver}`,
        (JSON.stringify(before.options) !== JSON.stringify(result.config.options) || secret.some(([k]) => body.options[k])) && 'Einstellungen geändert',
      ].filter(Boolean);
      store.addAudit({ ...audit, success: true, message: message.join(', ') || 'unverändert gespeichert' });
      return result;
    } catch (err) {
      store.addAudit({ ...audit, success: false, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      notify(['devices', 'audit']);
    }
  });

  app.get('/api/system/serialports', async () => listSerialPorts());
}
