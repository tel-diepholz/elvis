import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CameraConfigInput, CameraPreset, CameraTestResult, Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import { defaultFactory, type CamerasAdapter } from '../devices/drivers/cameras.js';
import type { DeviceManager } from '../devices/manager.js';
import { HttpError } from '../errors.js';
import { publicCamera, type CameraConfigStore, type CameraPresetStore } from '../services/cameras.js';
import type { IncidentService } from '../services/incidents.js';
import { idParam, operatorOf, parse } from './util.js';

interface Deps {
  cameras: CameraConfigStore;
  presets: CameraPresetStore;
  devices: DeviceManager;
  incidents: IncidentService;
  store: Store;
  notify: (topics: Topic[]) => void;
}

const presetBody = z.object({ cameraId: z.string().min(1), name: z.string().trim().min(1, 'Name fehlt').max(60) });

export function cameraRoutes(app: FastifyInstance, d: Deps): void {
  const audit = (req: Parameters<typeof operatorOf>[0], target: string, action: string, message: string, params: unknown = {}) => {
    d.store.addAudit({ operator: operatorOf(req), target, action, params: JSON.stringify(params), success: true, message });
    d.notify(['audit']);
  };
  const adapter = () => d.devices.adapter('cameras') as CamerasAdapter | null;

  // --- Verwaltung (nur Admins, siehe auth/access.ts) ---

  app.get('/api/system/cameras', async () => d.cameras.list().map(publicCamera));

  app.post('/api/system/cameras', async (req, reply) => {
    const c = d.cameras.create(req.body as CameraConfigInput);
    audit(req, `kamera:${c.id}`, 'create', `Kamera „${c.name}“ angelegt (${c.type === 'demo' ? 'Demo' : c.host})`);
    d.notify(['cameras']);
    return reply.code(201).send(publicCamera(c));
  });

  app.put<{ Params: { id: string } }>('/api/system/cameras/:id', async (req) => {
    const c = d.cameras.update(req.params.id, req.body as CameraConfigInput);
    audit(req, `kamera:${c.id}`, 'update', `Kamera „${c.name}“ geändert`);
    d.notify(['cameras']);
    return publicCamera(c);
  });

  app.delete<{ Params: { id: string } }>('/api/system/cameras/:id', async (req, reply) => {
    const c = d.cameras.remove(req.params.id);
    audit(req, `kamera:${c.id}`, 'delete', `Kamera „${c.name}“ entfernt`);
    d.notify(['cameras']);
    return reply.code(204).send();
  });

  app.put('/api/system/cameras/order', async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()) }), req.body);
    d.cameras.reorder(ids);
    d.notify(['cameras']);
    return d.cameras.list().map(publicCamera);
  });

  /** Verbindung prüfen, ohne zu speichern (bei bestehenden Kameras gilt ein leeres Passwort als unverändert) */
  app.post('/api/system/cameras/test', async (req): Promise<CameraTestResult> => {
    const { id, camera } = parse(z.object({ id: z.string().optional(), camera: z.record(z.unknown()) }), req.body);
    const config = d.cameras.preview(camera as unknown as CameraConfigInput, id);
    try {
      const probe = await defaultFactory(config).probe();
      const can = [probe.caps.panTilt && 'Schwenken/Neigen', probe.caps.zoom && 'Zoom', probe.caps.focus && 'Fokus', probe.caps.dayNight && 'Tag/Nacht'].filter(Boolean);
      const notes = probe.notes?.length ? ` (${probe.notes.join('; ')})` : '';
      return { ok: true, model: probe.model, caps: probe.caps, message: `Verbunden${probe.model ? ` mit ${probe.model}` : ''}${can.length ? ` – ${can.join(', ')}` : ' – keine fernsteuerbaren Funktionen'}${notes}` };
    } catch (err) {
      return { ok: false, model: null, caps: null, message: (err as Error).message };
    }
  });

  // --- Livebild (wie der Fahrzeugzustand auch für anonyme Arbeitsplätze sichtbar) ---

  app.get<{ Params: { id: string }; Querystring: { kind?: string } }>('/api/cameras/:id/stream', async (req, reply) => {
    const a = adapter();
    if (!a) throw new HttpError(404, 'Modul Kameras ist nicht aktiviert');
    let upstream;
    try {
      upstream = await a.openStream(req.params.id, req.query.kind === 'thumb' ? 'thumb' : 'live');
    } catch (err) {
      if (err instanceof HttpError) throw err;
      // Fehler der Kamera (Ablehnung, nicht erreichbar) – kein interner Fehler von ELVIS
      req.log.warn({ camera: req.params.id }, (err as Error).message);
      throw new HttpError(502, (err as Error).message);
    }
    if (!upstream) throw new HttpError(404, 'Diese Kamera liefert kein Videobild');
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': upstream.headers['content-type'] ?? 'multipart/x-mixed-replace',
      'cache-control': 'no-store',
      connection: 'close',
    });
    upstream.pipe(reply.raw);
    const close = () => upstream.destroy();
    req.raw.on('close', close);
    upstream.on('error', () => reply.raw.destroy());
    upstream.on('end', () => reply.raw.end());
  });

  // --- Gespeicherte Positionen: gehören zum laufenden Einsatz ---

  app.get('/api/cameras/presets', async (): Promise<CameraPreset[]> => {
    const incident = d.incidents.active();
    return incident ? d.presets.list(incident.id) : [];
  });

  app.post('/api/cameras/presets', async (req, reply) => {
    const incident = d.incidents.active();
    if (!incident) throw new HttpError(409, 'Positionen gehören zum Einsatz – bitte zuerst einen Einsatz eröffnen');
    const { cameraId, name } = parse(presetBody, req.body);
    // aktuelle Position frisch von der Kamera lesen
    await d.devices.execute('cameras', 'refresh', { cameraId });
    const cam = d.devices.snapshot('cameras').state.cameras.find((c) => c.id === cameraId);
    if (!cam?.position) throw new HttpError(409, 'Position der Kamera ist nicht bekannt');
    const preset = d.presets.add(incident.id, cameraId, name, cam.position, operatorOf(req));
    audit(req, `kamera:${cameraId}`, 'preset.save', `${cam.name}: Position „${name}“ gespeichert`, cam.position);
    d.notify(['cameraPresets']);
    return reply.code(201).send(preset);
  });

  app.post('/api/cameras/presets/:id/goto', async (req) => {
    const { id } = parse(idParam, req.params);
    const p = d.presets.get(id);
    if (p.incidentId !== d.incidents.active()?.id) throw new HttpError(409, 'Position gehört nicht zum laufenden Einsatz');
    const params = { cameraId: p.cameraId, position: p.position, label: p.name };
    const auditBase = { operator: operatorOf(req), target: 'cameras', action: 'goto', params: JSON.stringify(params) };
    try {
      const message = (await d.devices.execute('cameras', 'goto', params)) ?? '';
      d.store.addAudit({ ...auditBase, success: true, message });
      return { ok: true, message };
    } catch (err) {
      d.store.addAudit({ ...auditBase, success: false, message: (err as Error).message });
      throw err;
    } finally {
      d.notify(['audit']);
    }
  });

  app.delete('/api/cameras/presets/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const p = d.presets.get(id);
    if (p.incidentId !== d.incidents.active()?.id) throw new HttpError(409, 'Position gehört nicht zum laufenden Einsatz');
    d.presets.remove(id);
    audit(req, `kamera:${p.cameraId}`, 'preset.delete', `Position „${p.name}“ gelöscht`);
    d.notify(['cameraPresets']);
    return reply.code(204).send();
  });
}
