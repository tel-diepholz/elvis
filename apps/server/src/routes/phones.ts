import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PHONE_KEY_TYPE, phoneConfigSchema, phoneInputSchema, phoneKeySchema, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { PhoneService } from '../services/phones.js';
import { actorOf, operatorOf, parse } from './util.js';

interface Deps {
  phones: PhoneService;
  store: Store;
  notify: (topics: Topic[]) => void;
}

const provisioningParams = z.object({ token: z.string().max(100), file: z.string().max(40) });
const keyParams = z.object({ id: z.string().max(40), idx: z.coerce.number().int().min(0).max(999) });
const templateParams = z.object({ idx: z.coerce.number().int().min(0).max(999) });
/** Telefon (Grundbelegung, nur Admins) oder laufender Einsatz */
const scope = z.enum(['phone', 'incident']);
const keyBody = z.object({ key: phoneKeySchema, scope: scope.default('incident') });
const scopeQuery = z.object({ scope: scope.default('incident') });

/** Adresse, unter der das Telefon ELVIS erreicht hat */
const baseOf = (req: FastifyRequest) => `${req.protocol}://${req.host}`;

/**
 * Tischtelefone (Snom): Provisionierung ohne Anmeldung über das Token in der URL (/api/provisioning/…, siehe
 * auth/access.ts), Tastenbelegung für Angemeldete (/api/phones/…), Stammdaten und Vorlage nur Admins (/api/system/phones…).
 */
export function phoneRoutes(app: FastifyInstance, d: Deps): void {
  const audit = (operator: string, target: string, action: string, message: string) => {
    d.store.addAudit({ operator, target, action, params: '{}', success: true, message });
    d.notify(['audit']);
  };
  const keyText = (k: z.output<typeof phoneKeySchema> | null) =>
    !k ? 'entfernt' : k.type === 'number' ? `Nummer ${k.number}${k.label ? ` („${k.label}“)` : ''}` : k.type === 'blf' ? `Nebenstelle ${k.extension}` : k.type === 'paging' ? `Durchsage ${k.address || '(Zone wählen)'}` : k.type === 'contact' ? `Kontakt ${k.contactId}` : PHONE_KEY_TYPE.empty;

  // --- Telefon (Snom: setting_server …/snom/{mac}.xml) ---

  app.get('/api/provisioning/:token/snom/:file', async (req, reply) => {
    const p = parse(provisioningParams, req.params);
    const mac = /^(.+)\.xml$/.exec(p.file)?.[1];
    if (!mac) throw new HttpError(404, 'Nicht gefunden');
    const body = d.phones.provisioningXml(p.token, mac, baseOf(req), { ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });
    return reply.type('application/xml; charset=utf-8').header('cache-control', 'no-store').send(body);
  });

  // --- Angemeldete: Telefone und Tasten, Überschreibungen in der laufenden Lage ---

  app.get('/api/phones', async () => d.phones.list());
  // Für die Auswahl beim Belegen von Durchsage-Tasten (auch im Einsatz, ohne Admin)
  app.get('/api/phones/paging-zones', async () => d.phones.config().pagingZones);
  app.get<{ Params: { id: string } }>('/api/phones/:id/keys', async (req) => d.phones.slots(req.params.id));

  app.put('/api/phones/:id/keys/:idx', async (req) => {
    const p = parse(keyParams, req.params);
    const body = parse(keyBody, req.body);
    const phone = d.phones.get(p.id);
    const actor = actorOf(req);
    if (body.scope === 'phone' && !actor.isAdmin) throw new HttpError(403, 'Die Grundbelegung ändern nur Admins');
    const slots = body.scope === 'phone' ? d.phones.setPhoneKey(p.id, p.idx, body.key) : d.phones.setOverride(p.id, p.idx, body.key, actor.name);
    audit(actor.name, `telefon:${phone.id}`, body.scope === 'phone' ? 'key' : 'key-override', `${phone.name}, Taste ${p.idx + 1}${body.scope === 'incident' ? ' (Lage)' : ''}: ${keyText(body.key)}`);
    return slots;
  });

  app.delete('/api/phones/:id/keys/:idx', async (req) => {
    const p = parse(keyParams, req.params);
    const { scope: s } = parse(scopeQuery, req.query);
    const phone = d.phones.get(p.id);
    const actor = actorOf(req);
    if (s === 'phone' && !actor.isAdmin) throw new HttpError(403, 'Die Grundbelegung ändern nur Admins');
    const slots = s === 'phone' ? d.phones.setPhoneKey(p.id, p.idx, null) : d.phones.setOverride(p.id, p.idx, null, actor.name);
    audit(actor.name, `telefon:${phone.id}`, s === 'phone' ? 'key' : 'key-override', `${phone.name}, Taste ${p.idx + 1}${s === 'incident' ? ' (Lage)' : ''}: ${s === 'phone' ? 'Grundbelegung entfernt' : 'zurück auf Grundbelegung'}`);
    return slots;
  });

  /** Alle Überschreibungen eines Telefons zurücknehmen */
  app.delete<{ Params: { id: string } }>('/api/phones/:id/overrides', async (req) => {
    const phone = d.phones.get(req.params.id);
    const slots = d.phones.clearOverrides(phone.id);
    audit(operatorOf(req), `telefon:${phone.id}`, 'key-override', `${phone.name}: alle Tasten zurück auf Grundbelegung`);
    return slots;
  });

  // --- Admins: Einstellungen, Vorlage, Telefone ---

  app.get('/api/system/phones/config', async () => d.phones.status());
  app.put('/api/system/phones/config', async (req) => {
    const s = d.phones.setConfig(parse(phoneConfigSchema, req.body), operatorOf(req));
    audit(operatorOf(req), 'telefone', 'config', `Telefone: Einstellungen geändert (SIP-Server ${s.config.registrar || '–'})`);
    return s;
  });
  app.post('/api/system/phones/token', async (req) => {
    const s = d.phones.regenerateToken(operatorOf(req));
    audit(operatorOf(req), 'telefone', 'token', 'Provisionierungs-URL der Telefone neu erzeugt');
    return s;
  });

  app.get('/api/system/phones/template', async () => d.phones.templateSlots());
  app.put('/api/system/phones/template/:idx', async (req) => {
    const { idx } = parse(templateParams, req.params);
    const { key } = parse(z.object({ key: phoneKeySchema }), req.body);
    const slots = d.phones.setTemplateKey(idx, key, operatorOf(req));
    audit(operatorOf(req), 'telefone', 'template', `Tastenvorlage, Taste ${idx + 1}: ${keyText(key)}`);
    return slots;
  });
  app.delete('/api/system/phones/template/:idx', async (req) => {
    const { idx } = parse(templateParams, req.params);
    const slots = d.phones.setTemplateKey(idx, null, operatorOf(req));
    audit(operatorOf(req), 'telefone', 'template', `Tastenvorlage, Taste ${idx + 1}: entfernt`);
    return slots;
  });

  app.post('/api/system/phones', async (req, reply) => {
    const phone = d.phones.create(parse(phoneInputSchema, req.body));
    audit(operatorOf(req), `telefon:${phone.id}`, 'create', `Telefon „${phone.name}“ angelegt (Nebenstelle ${phone.extension}, ${phone.mac})`);
    return reply.code(201).send(phone);
  });
  app.put<{ Params: { id: string } }>('/api/system/phones/:id', async (req) => {
    const phone = d.phones.update(req.params.id, parse(phoneInputSchema, req.body));
    audit(operatorOf(req), `telefon:${phone.id}`, 'update', `Telefon „${phone.name}“ geändert`);
    return phone;
  });
  app.delete<{ Params: { id: string } }>('/api/system/phones/:id', async (req, reply) => {
    const phone = d.phones.remove(req.params.id);
    audit(operatorOf(req), `telefon:${phone.id}`, 'delete', `Telefon „${phone.name}“ entfernt`);
    return reply.code(204).send();
  });

  /** Tasten sofort erneut übertragen */
  app.post<{ Params: { id: string } }>('/api/system/phones/:id/push', async (req) => {
    d.phones.get(req.params.id);
    const push = await d.phones.push(req.params.id);
    if (!push) throw new HttpError(409, 'Adresse des Telefons unbekannt – es hat die Konfiguration noch nicht abgerufen');
    return d.phones.get(req.params.id);
  });
  app.post<{ Params: { id: string } }>('/api/system/phones/:id/reboot', async (req, reply) => {
    const phone = d.phones.get(req.params.id);
    await d.phones.reboot(phone.id);
    audit(operatorOf(req), `telefon:${phone.id}`, 'reboot', `Telefon „${phone.name}“ neu gestartet`);
    return reply.code(204).send();
  });
}
