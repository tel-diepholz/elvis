import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DISPLAY_IMAGE_MAX_BYTES, DISPLAY_TILE_TYPES, displayMapViewSchema, displayThemeSchema, type DisplayDevice, type DisplaySelf, type DisplayTheme, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { DisplayImageService } from '../services/displayImages.js';
import { DISPLAY_COOKIE, DISPLAY_COOKIE_MAX_S, type DisplayService } from '../services/displays.js';
import type { LiveHub } from './live.js';
import { operatorOf, parse } from './util.js';

interface Deps {
  displays: DisplayService;
  images: DisplayImageService;
  hub: LiveHub;
  store: Store;
  notify: (topics: Topic[]) => void;
}

const name = z.string().trim().min(1, 'Name fehlt').max(60);
const mapViewBody = displayMapViewSchema.extend({ tileId: z.string().min(1).max(64) });

export function displayRoutes(app: FastifyInstance, d: Deps): void {
  const audit = (req: FastifyRequest, target: string, action: string, message: string, operator = operatorOf(req)) => {
    d.store.addAudit({ operator, target, action, params: '{}', success: true, message });
    d.notify(['audit']);
  };
  const token = (req: FastifyRequest) => req.cookies[DISPLAY_COOKIE];
  const paired = (req: FastifyRequest): DisplayDevice => {
    const display = d.displays.resolve(token(req));
    if (!display) throw new HttpError(401, 'Bildschirm nicht gekoppelt');
    return display;
  };
  const themeLabel = (t: DisplayTheme) => (t === 'light' ? 'hell' : 'dunkel');
  const themeBody = z.object({ theme: displayThemeSchema });

  // --- Bildschirm selbst (Gerätecookie) ---

  app.get('/api/display/self', async (req): Promise<DisplaySelf> => d.displays.self(token(req)));

  /** Kopplung beginnen: neues Geheimnis als Cookie, Code zum Anzeigen */
  app.post('/api/display/pair', async (req, reply): Promise<DisplaySelf> => {
    const current = d.displays.self(token(req));
    if (current.state !== 'unpaired') return current;
    const p = d.displays.startPairing();
    reply.setCookie(DISPLAY_COOKIE, p.token, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: DISPLAY_COOKIE_MAX_S });
    return { state: 'pending', code: p.code, expiresAt: p.expiresAt };
  });

  app.post('/api/display/heartbeat', async (req, reply) => {
    const display = paired(req);
    const body = parse(z.object({ width: z.number().int().min(100).max(16384), height: z.number().int().min(100).max(16384) }).partial(), req.body ?? {});
    d.displays.touch(display.id, body.width && body.height ? { width: body.width, height: body.height } : null, String(req.headers['user-agent'] ?? ''));
    return reply.code(204).send();
  });

  /** Ausschnitt einer Kartenkachel, den der Bildschirm gerade zeigt (für die Vorschau in ELVIS) */
  app.post('/api/display/map-view', async (req, reply) => {
    const display = paired(req);
    const { tileId, ...view } = parse(mapViewBody, req.body);
    d.displays.setMapView(display.id, tileId, view);
    return reply.code(204).send();
  });

  /**
   * Bedienung am Bildschirm über die Kachel „Szenenwahl“: nur wenn das aktuelle Layout eine solche Kachel enthält –
   * sonst könnte jeder gekoppelte Bildschirm ungefragt umschalten.
   */
  const touchControl = (req: FastifyRequest): DisplayDevice => {
    const display = paired(req);
    if (!display.layout.tiles.some((t) => t.type === 'scenes')) throw new HttpError(403, 'Keine Kachel „Szenenwahl“ auf diesem Bildschirm');
    return display;
  };

  app.post('/api/display/scenes/:sceneId/apply', async (req) => {
    const display = touchControl(req);
    const { sceneId } = parse(z.object({ sceneId: z.coerce.number().int().positive() }), req.params);
    const sceneName = d.displays.applyScene(display.id, sceneId);
    audit(req, `bildschirm:${display.id}`, 'scene.apply', `${display.name}: Szene „${sceneName}“ am Bildschirm aufgerufen`, `Bildschirm ${display.name}`);
    return d.displays.get(display.id);
  });

  app.put('/api/display/theme', async (req) => {
    const display = touchControl(req);
    const { theme } = parse(themeBody, req.body);
    if (theme === display.theme) return display;
    audit(req, `bildschirm:${display.id}`, 'theme', `${display.name}: Design ${themeLabel(theme)} am Bildschirm gewählt`, `Bildschirm ${display.name}`);
    return d.displays.setTheme(display.id, theme);
  });

  // --- Steuerung (Lesen öffentlich wie der Fahrzeugzustand, Ändern mit Anmeldung) ---

  app.get('/api/displays', async () => d.displays.list());

  app.put<{ Params: { id: string } }>('/api/displays/:id/layout', async (req) => {
    const before = d.displays.get(req.params.id);
    const next = d.displays.setLayout(req.params.id, (req.body as { layout?: unknown } | null)?.layout);
    const kinds = [...new Set(next.layout.tiles.map((t) => DISPLAY_TILE_TYPES[t.type].label))].join(', ');
    audit(req, `bildschirm:${before.id}`, 'layout', `${before.name}: ${next.layout.tiles.length} Kachel(n)${kinds ? ` – ${kinds}` : ''}`);
    return next;
  });

  app.put<{ Params: { id: string } }>('/api/displays/:id/theme', async (req) => {
    const display = d.displays.get(req.params.id);
    const { theme } = parse(themeBody, req.body);
    if (theme === display.theme) return display;
    audit(req, `bildschirm:${display.id}`, 'theme', `${display.name}: Design ${themeLabel(theme)}`);
    return d.displays.setTheme(display.id, theme);
  });

  app.post<{ Params: { id: string } }>('/api/displays/:id/command', async (req) => {
    const display = d.displays.get(req.params.id);
    const { action } = parse(z.object({ action: z.enum(['reload', 'identify']) }), req.body);
    if (!d.hub.sendToDisplay(display.id, { type: 'displayCommand', action })) throw new HttpError(409, `${display.name} ist nicht verbunden`);
    audit(req, `bildschirm:${display.id}`, action, `${display.name}: ${action === 'reload' ? 'neu laden' : 'erkennen'}`);
    return { ok: true };
  });

  /** Kartenkachel fernsteuern: Ausschnitt an den Bildschirm schicken (ohne Protokolleintrag, fällt bei jedem Verschieben an) */
  app.post<{ Params: { id: string } }>('/api/displays/:id/map-view', async (req) => {
    const display = d.displays.get(req.params.id);
    const { tileId, ...view } = parse(mapViewBody, req.body);
    if (!display.layout.tiles.some((t) => t.id === tileId && t.type === 'map')) throw new HttpError(404, 'Kartenkachel nicht gefunden');
    if (!d.hub.sendToDisplay(display.id, { type: 'displayMapView', tileId, view })) throw new HttpError(409, `${display.name} ist nicht verbunden`);
    d.displays.setMapView(display.id, tileId, view);
    return { ok: true };
  });

  // --- Szenen (angemeldete Benutzer) ---

  const sceneParams = z.object({ id: z.string(), sceneId: z.coerce.number().int().positive() });

  app.post<{ Params: { id: string } }>('/api/displays/:id/scenes', async (req, reply) => {
    const display = d.displays.get(req.params.id);
    const body = parse(z.object({ name }), req.body);
    const scene = d.displays.saveScene(display.id, body.name, operatorOf(req));
    audit(req, `bildschirm:${display.id}`, 'scene.save', `${display.name}: Szene „${scene.name}“ gespeichert`);
    return reply.code(201).send(scene);
  });

  app.put('/api/displays/:id/scenes/:sceneId', async (req) => {
    const p = parse(sceneParams, req.params);
    const display = d.displays.get(p.id);
    const body = parse(z.object({ name: name.optional(), overwrite: z.boolean().optional() }), req.body);
    const scene = d.displays.updateScene(display.id, p.sceneId, body, operatorOf(req));
    audit(req, `bildschirm:${display.id}`, 'scene.update', `${display.name}: Szene „${scene.name}“ ${body.overwrite ? 'mit aktueller Anordnung überschrieben' : 'umbenannt'}`);
    return scene;
  });

  app.delete('/api/displays/:id/scenes/:sceneId', async (req, reply) => {
    const p = parse(sceneParams, req.params);
    const display = d.displays.get(p.id);
    const sceneName = d.displays.removeScene(display.id, p.sceneId);
    audit(req, `bildschirm:${display.id}`, 'scene.delete', `${display.name}: Szene „${sceneName}“ gelöscht`);
    return reply.code(204).send();
  });

  /** Schutz vor Überschreiben und Löschen – nur Admins */
  app.put('/api/displays/:id/scenes/:sceneId/lock', async (req) => {
    if (!req.user?.isAdmin) throw new HttpError(403, 'Nur Admins können Szenen schützen');
    const p = parse(sceneParams, req.params);
    const display = d.displays.get(p.id);
    const { locked } = parse(z.object({ locked: z.boolean() }), req.body);
    const sceneName = d.displays.lockScene(display.id, p.sceneId, locked);
    audit(req, `bildschirm:${display.id}`, 'scene.lock', `${display.name}: Szene „${sceneName}“ ${locked ? 'geschützt' : 'freigegeben'}`);
    return d.displays.get(display.id);
  });

  app.post('/api/displays/:id/scenes/:sceneId/apply', async (req) => {
    const p = parse(sceneParams, req.params);
    const display = d.displays.get(p.id);
    const sceneName = d.displays.applyScene(display.id, p.sceneId);
    audit(req, `bildschirm:${display.id}`, 'scene.apply', `${display.name}: Szene „${sceneName}“ angezeigt`);
    return d.displays.get(display.id);
  });

  app.put('/api/displays/:id/scenes/order', async (req) => {
    const display = d.displays.get((req.params as { id: string }).id);
    const { ids } = parse(z.object({ ids: z.array(z.number().int()) }), req.body);
    d.displays.reorderScenes(display.id, ids);
    return d.displays.get(display.id);
  });

  // --- Bilder für die Kachel „Bild“ (angemeldete Benutzer; Inhalt lesen auch gekoppelte Bildschirme) ---

  const imageParams = z.object({ imageId: z.coerce.number().int().positive() });

  app.get('/api/displays/images', async () => d.images.list());

  app.post('/api/displays/images', async (req, reply) => {
    const file = await req.file({ limits: { fileSize: DISPLAY_IMAGE_MAX_BYTES } });
    if (!file) throw new HttpError(400, 'Keine Datei übermittelt');
    const img = await d.images.upload({ filename: file.filename, stream: file.file }, operatorOf(req), DISPLAY_IMAGE_MAX_BYTES);
    audit(req, `bildschirm-bild:${img.id}`, 'image.upload', `Bild „${img.name}“ für Bildschirme hochgeladen`);
    return reply.code(201).send(img);
  });

  app.get('/api/displays/images/:imageId', async (req, reply) => {
    const { imageId } = parse(imageParams, req.params);
    const img = d.images.get(imageId);
    return reply
      .header('content-type', img.mimeType)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(d.images.path(img.id)));
  });

  app.delete('/api/displays/images/:imageId', async (req, reply) => {
    const { imageId } = parse(imageParams, req.params);
    const imgName = await d.images.remove(imageId);
    audit(req, `bildschirm-bild:${imageId}`, 'image.delete', `Bild „${imgName}“ für Bildschirme gelöscht`);
    return reply.code(204).send();
  });

  // --- Verwaltung (nur Admins, /api/system/) ---

  app.post('/api/system/displays/pair', async (req, reply) => {
    const body = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Code mit 6 Ziffern'), name }), req.body);
    const display = d.displays.pair(body.code, body.name);
    audit(req, `bildschirm:${display.id}`, 'pair', `Bildschirm „${display.name}“ gekoppelt`);
    return reply.code(201).send(display);
  });

  app.put<{ Params: { id: string } }>('/api/system/displays/:id', async (req) => {
    const body = parse(z.object({ name }), req.body);
    const before = d.displays.get(req.params.id);
    const display = d.displays.rename(req.params.id, body.name);
    audit(req, `bildschirm:${display.id}`, 'rename', `Bildschirm „${before.name}“ umbenannt in „${display.name}“`);
    return display;
  });

  app.delete<{ Params: { id: string } }>('/api/system/displays/:id', async (req, reply) => {
    const display = d.displays.remove(req.params.id);
    d.hub.disconnectDisplay(display.id);
    audit(req, `bildschirm:${display.id}`, 'unpair', `Bildschirm „${display.name}“ entkoppelt`);
    return reply.code(204).send();
  });

  app.put('/api/system/displays/order', async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()) }), req.body);
    d.displays.reorder(ids);
    return d.displays.list();
  });
}
