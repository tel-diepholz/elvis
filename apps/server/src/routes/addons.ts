import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AddonStoreEntry } from '@elvis/shared';
import type { AddonManager } from '../addons/manager.js';
import type { RepoService } from '../addons/repos.js';
import type { HostService } from '../docker/hosts.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import { idParam, operatorOf, parse } from './util.js';

const hostname = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:-]+$/, 'Hostname oder IP-Adresse');
const pem = z.string().includes('-----BEGIN', { message: 'PEM-Format erwartet' }).max(20_000);

const newHost = z.discriminatedUnion('certMode', [
  z.object({ certMode: z.literal('elvis'), name: z.string().trim().min(1).max(60), address: hostname, port: z.number().int().min(1).max(65535).optional() }),
  z.object({
    certMode: z.literal('custom'),
    name: z.string().trim().min(1).max(60),
    address: hostname,
    port: z.number().int().min(1).max(65535).optional(),
    caPem: pem,
    certPem: pem,
    keyPem: pem,
  }),
]);

const optionValues = z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));
const addonParam = z.object({ id: z.string().regex(/^[a-z0-9-]+$/) });

/** Basis-URL, unter der der Host ELVIS erreicht (für Setup-Befehl und Rückmeldung). */
const baseUrl = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`;

export function addonRoutes(
  app: FastifyInstance,
  deps: { hosts: HostService; repos: RepoService; addons: AddonManager; store: Store; notifyAudit: () => void },
): void {
  const { hosts, repos, addons, store } = deps;
  const audit = (req: FastifyRequest, target: string, action: string, params: object, message = '') => {
    store.addAudit({ operator: operatorOf(req), target, action, params: JSON.stringify(params), success: true, message });
    deps.notifyAudit();
  };

  // --- Docker-Hosts ---

  app.get('/api/docker/hosts', async () => hosts.list());

  app.post('/api/docker/hosts', async (req, reply) => {
    const body = parse(newHost, req.body);
    if (body.certMode === 'custom') {
      const host = await hosts.createCustom(body);
      audit(req, `host:${host.id}`, 'create', { name: host.name, address: host.address, certMode: 'custom' });
      return reply.code(201).send({ host, command: null, expiresAt: null });
    }
    const setup = hosts.create(body, baseUrl(req));
    audit(req, `host:${setup.host.id}`, 'create', { name: setup.host.name, address: setup.host.address, certMode: 'elvis' });
    return reply.code(201).send(setup);
  });

  app.post('/api/docker/hosts/:id/setup', async (req) => {
    const { id } = parse(idParam, req.params);
    const setup = hosts.renewSetup(id, baseUrl(req));
    audit(req, `host:${id}`, 'renew-setup', {});
    return setup;
  });

  app.post('/api/docker/hosts/:id/test', async (req) => hosts.check(parse(idParam, req.params).id));

  app.delete('/api/docker/hosts/:id', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    hosts.remove(id, addons.countOnHost(id));
    audit(req, `host:${id}`, 'remove', {});
    return reply.code(204).send();
  });

  // Vom Host per curl abgerufen – daher ohne Bedienername.
  app.get('/api/docker/setup/:file', async (req, reply) => {
    const { file } = req.params as { file: string };
    const token = file.replace(/\.sh$/, '');
    return reply.header('content-type', 'text/x-shellscript; charset=utf-8').header('cache-control', 'no-store').send(hosts.setupScript(token));
  });

  app.post('/api/docker/setup/:token/done', async (req) => {
    await hosts.setupDone((req.params as { token: string }).token);
    return { ok: true };
  });

  // --- Store ---

  app.get('/api/addons/store', async (): Promise<AddonStoreEntry[]> => {
    const installed = addons.installedVersions();
    return repos.list().map(({ location: _, ...e }) => ({ ...e, installedVersion: e.manifest ? (installed.get(e.manifest.id) ?? null) : null }));
  });

  app.post('/api/addons/store/refresh', async () => {
    await repos.refresh();
    return { ok: true };
  });

  // --- Installierte Addons ---

  app.get('/api/addons', async () => addons.list());
  app.get('/api/addons/:id', async (req) => addons.get(parse(addonParam, req.params).id));

  app.post('/api/addons', async (req, reply) => {
    const body = parse(z.object({ addonId: z.string(), hostId: z.number().int(), options: optionValues.default({}) }), req.body);
    return reply.code(202).send(addons.install(body.addonId, body.hostId, body.options, operatorOf(req)));
  });

  app.patch('/api/addons/:id', async (req, reply) => {
    const { id } = parse(addonParam, req.params);
    const body = parse(z.object({ options: optionValues }), req.body);
    return reply.code(202).send(addons.reconfigure(id, body.options, operatorOf(req)));
  });

  app.post('/api/addons/:id/update', async (req, reply) => reply.code(202).send(addons.update(parse(addonParam, req.params).id, operatorOf(req))));

  app.post('/api/addons/:id/:action', async (req) => {
    const { id } = parse(addonParam, req.params);
    const { action } = req.params as { action: string };
    if (action !== 'start' && action !== 'stop' && action !== 'restart') throw new HttpError(404, 'Unbekannte Aktion');
    return addons.power(id, action, operatorOf(req));
  });

  app.post('/api/addons/:id/jobs/:job', async (req, reply) => {
    const { id } = parse(addonParam, req.params);
    return reply.code(202).send(await addons.runJob(id, (req.params as { job: string }).job, operatorOf(req)));
  });

  app.get('/api/addons/:id/logs', async (req, reply) => {
    const { id } = parse(addonParam, req.params);
    const q = parse(z.object({ target: z.string().min(1), tail: z.coerce.number().int().min(1).max(2000).default(200) }), req.query);
    return reply.header('content-type', 'text/plain; charset=utf-8').send(await addons.logs(id, q.target, q.tail));
  });

  app.delete('/api/addons/:id', async (req, reply) => {
    const { id } = parse(addonParam, req.params);
    const { data } = req.query as { data?: string };
    await addons.uninstall(id, data === '1', operatorOf(req));
    return reply.code(204).send();
  });
}
