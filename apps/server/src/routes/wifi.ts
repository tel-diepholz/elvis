import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Topic, WifiApConfigInput, WifiApTestResult, WifiSettingsInput } from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { WifiService } from '../services/wifi.js';
import { operatorOf, parse } from './util.js';

interface Deps {
  wifi: WifiService;
  store: Store;
  notify: (topics: Topic[]) => void;
}

export function wifiRoutes(app: FastifyInstance, d: Deps): void {
  const audit = (req: Parameters<typeof operatorOf>[0], target: string, action: string, message: string) => {
    d.store.addAudit({ operator: operatorOf(req), target, action, params: '{}', success: true, message });
    d.notify(['audit']);
  };

  // Gastnetz des laufenden Einsatzes (auch für gekoppelte Bildschirme, Kachel „Gast-WLAN“)
  app.get('/api/wifi/guest', async () => d.wifi.guest());

  // Angemeldete WLAN-Geräte (Netzwerk-Seite, nur angemeldet)
  app.get('/api/wifi/clients', async () => d.wifi.clients());

  // --- Verwaltung (nur Admins, siehe auth/access.ts) ---

  app.get('/api/system/wifi', async () => d.wifi.overview());

  app.put('/api/system/wifi/settings', async (req) => {
    const s = d.wifi.updateSettings(req.body as WifiSettingsInput, operatorOf(req));
    const parts = [s.ops.enabled ? `Betriebs-WLAN „${s.ops.ssid}“` : 'Betriebs-WLAN aus', s.guest.enabled ? `Gastnetz „${s.guest.ssid}“` : 'Gastnetz aus'];
    audit(req, 'wlan', 'settings', `WLAN-Einstellungen geändert: ${parts.join(', ')}`);
    return s;
  });

  app.post('/api/system/wifi/aps', async (req, reply) => {
    const a = d.wifi.create(req.body as WifiApConfigInput);
    audit(req, `wlan:${a.id}`, 'create', `Accesspoint „${a.name}“ angelegt (${a.host})`);
    return reply.code(201).send(d.wifi.withStatus(a));
  });

  app.put('/api/system/wifi/aps/order', async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()) }), req.body);
    d.wifi.reorder(ids);
    return d.wifi.overview().aps;
  });

  app.put<{ Params: { id: string } }>('/api/system/wifi/aps/:id', async (req) => {
    const a = d.wifi.update(req.params.id, req.body as WifiApConfigInput);
    audit(req, `wlan:${a.id}`, 'update', `Accesspoint „${a.name}“ geändert`);
    return d.wifi.withStatus(a);
  });

  app.delete<{ Params: { id: string } }>('/api/system/wifi/aps/:id', async (req, reply) => {
    const a = d.wifi.remove(req.params.id);
    audit(req, `wlan:${a.id}`, 'delete', `Accesspoint „${a.name}“ entfernt`);
    return reply.code(204).send();
  });

  app.post('/api/system/wifi/aps/test', async (req): Promise<WifiApTestResult> => {
    const { id, ap } = parse(z.object({ id: z.string().optional(), ap: z.record(z.unknown()) }), req.body);
    try {
      return { ok: true, message: await d.wifi.test(ap as unknown as WifiApConfigInput, id) };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      return { ok: false, message: (err as Error).message };
    }
  });

  /** Sofort auf alle APs übertragen (sonst regelmäßig und bei jeder Änderung) */
  app.post('/api/system/wifi/sync', async () => {
    await d.wifi.syncAll();
    return d.wifi.overview();
  });
}
