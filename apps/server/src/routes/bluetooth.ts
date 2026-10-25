import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BLUETOOTH_KIND_LABELS, type BluetoothDeviceInput, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { BluetoothService } from '../services/bluetooth.js';
import { operatorOf, parse } from './util.js';

interface Deps {
  bluetooth: BluetoothService;
  store: Store;
  notify: (topics: Topic[]) => void;
}

/** Bluetooth-Geräte – nur Admins (/api/system/, siehe auth/access.ts). Die Messwerte kommen live über das Modul. */
export function bluetoothRoutes(app: FastifyInstance, d: Deps): void {
  const audit = (req: Parameters<typeof operatorOf>[0], target: string, action: string, message: string) => {
    d.store.addAudit({ operator: operatorOf(req), target, action, params: '{}', success: true, message });
    d.notify(['audit']);
  };

  app.get('/api/system/bluetooth', async () => d.bluetooth.list());

  app.post('/api/system/bluetooth', async (req, reply) => {
    const b = d.bluetooth.create(req.body as BluetoothDeviceInput);
    audit(req, `bluetooth:${b.id}`, 'create', `Bluetooth-Gerät „${b.name}“ eingetragen (${BLUETOOTH_KIND_LABELS[b.kind]}, ${b.address})`);
    return reply.code(201).send(b);
  });

  app.put('/api/system/bluetooth/order', async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()) }), req.body);
    d.bluetooth.reorder(ids);
    return d.bluetooth.list();
  });

  app.put<{ Params: { id: string } }>('/api/system/bluetooth/:id', async (req) => {
    const b = d.bluetooth.update(req.params.id, req.body as BluetoothDeviceInput);
    audit(req, `bluetooth:${b.id}`, 'update', `Bluetooth-Gerät „${b.name}“ geändert`);
    return b;
  });

  app.delete<{ Params: { id: string } }>('/api/system/bluetooth/:id', async (req, reply) => {
    const b = d.bluetooth.remove(req.params.id);
    audit(req, `bluetooth:${b.id}`, 'delete', `Bluetooth-Gerät „${b.name}“ entfernt`);
    return reply.code(204).send();
  });
}
