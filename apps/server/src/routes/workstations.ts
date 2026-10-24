import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fullName, workstationEnrollSchema, workstationHeartbeatSchema, workstationLoginSchema, type Topic, type WorkstationLoginResult, type WorkstationState } from '@elvis/shared';
import type { LoginLimiter } from '../auth/limiter.js';
import type { UserService } from '../auth/users.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { WorkstationService } from '../services/workstations.js';
import { operatorOf, parse } from './util.js';

interface Deps {
  workstations: WorkstationService;
  users: UserService;
  limiter: LoginLimiter;
  store: Store;
  notify: (topics: Topic[]) => void;
}

const bearer = (req: FastifyRequest) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || undefined;

export function workstationRoutes(app: FastifyInstance, d: Deps): void {
  const audit = (operator: string, target: string, action: string, message: string, success = true) => {
    d.store.addAudit({ operator, target, action, params: '{}', success, message });
    d.notify(['audit']);
  };

  // --- Gerätesicht (/api/clients/…, Bearer-Token; siehe auth/access.ts) ---

  /** Installer registriert das frisch installierte Notebook mit dem Token des Addons */
  app.post('/api/clients/enroll', async (req, reply) => {
    const body = parse(workstationEnrollSchema, req.body);
    const { workstation, token } = d.workstations.enroll(bearer(req) ?? '', body);
    audit('Installer', `arbeitsplatz:${workstation.id}`, 'enroll', `Arbeitsplatz „${workstation.name}“ installiert (${workstation.mac})`);
    return reply.code(201).send({ workstation, token });
  });

  app.get('/api/clients/state', async (req): Promise<WorkstationState> => d.workstations.state(d.workstations.require(bearer(req)).id));

  /** PIN prüfen für die Anmeldemaske – ohne Web-Sitzung; gleiche Sperren wie die Anmeldung in ELVIS */
  app.post('/api/clients/login', async (req): Promise<WorkstationLoginResult> => {
    const ws = d.workstations.require(bearer(req));
    const body = parse(workstationLoginSchema, req.body);
    const client = `arbeitsplatz:${ws.id}`;
    d.limiter.assertAllowed(body.userId, client);
    const user = await d.users.checkPin(body.userId, body.pin);
    if (!user) {
      const left = d.limiter.failure(body.userId, client);
      audit('Anonym', `user:${body.userId}`, 'login', `Arbeitsplatz „${ws.name}“: PIN falsch`, false);
      throw new HttpError(401, left > 0 ? `PIN falsch – noch ${left} Versuch${left === 1 ? '' : 'e'}` : 'PIN falsch – Anmeldung vorübergehend gesperrt');
    }
    d.limiter.success(user.id);
    const result = d.workstations.loggedIn(ws.id, user);
    audit(fullName(user), `arbeitsplatz:${ws.id}`, 'login', `Anmeldung am Arbeitsplatz „${ws.name}“`);
    return result;
  });

  app.post('/api/clients/heartbeat', async (req, reply) => {
    const ws = d.workstations.require(bearer(req));
    d.workstations.touch(ws.id, parse(workstationHeartbeatSchema, req.body ?? {}));
    return reply.code(204).send();
  });

  // --- Verwaltung (nur Admins) ---

  app.get('/api/system/workstations', async () => d.workstations.list());
  app.get('/api/system/workstations/installers', async () => d.workstations.installers());

  app.put<{ Params: { id: string } }>('/api/system/workstations/:id', async (req) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1, 'Name fehlt').max(60) }), req.body);
    const before = d.workstations.get(req.params.id);
    const ws = d.workstations.rename(before.id, name);
    audit(operatorOf(req), `arbeitsplatz:${ws.id}`, 'rename', `Arbeitsplatz „${before.name}“ umbenannt in „${ws.name}“`);
    return ws;
  });

  app.delete<{ Params: { id: string } }>('/api/system/workstations/:id', async (req, reply) => {
    const ws = d.workstations.remove(req.params.id);
    audit(operatorOf(req), `arbeitsplatz:${ws.id}`, 'delete', `Arbeitsplatz „${ws.name}“ entfernt und gesperrt`);
    return reply.code(204).send();
  });
}
