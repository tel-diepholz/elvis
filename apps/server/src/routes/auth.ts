import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fullName, PIN_PATTERN, type AuthStatus, type Topic, type User } from '@elvis/shared';
import type { LoginLimiter } from '../auth/limiter.js';
import { SESSION_COOKIE, SESSION_MAX_MS, type SessionStore } from '../auth/sessions.js';
import type { UserService } from '../auth/users.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import { idParam, parse } from './util.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

const name = z.string().trim().min(1, 'Pflichtfeld').max(60);
const pin = z.string().regex(PIN_PATTERN, 'Die PIN muss aus genau 4 Ziffern bestehen');

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, 'Bitte anmelden');
  return req.user;
}

export function authRoutes(
  app: FastifyInstance,
  deps: { users: UserService; sessions: SessionStore; limiter: LoginLimiter; store: Store; notify: (t: Topic[]) => void },
): void {
  const { users, sessions, limiter, store } = deps;
  const audit = (operator: string, action: string, target: string, success = true, message = '') => {
    store.addAudit({ operator, target, action, params: '', success, message });
    deps.notify(['audit']);
  };
  const startSession = (req: FastifyRequest, reply: FastifyReply, user: User) => {
    const token = sessions.create(user.id, req.headers['user-agent'] ?? '');
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', maxAge: SESSION_MAX_MS / 1000 });
  };

  app.get('/api/auth/status', async (req): Promise<AuthStatus> => ({ hasUsers: users.hasUsers(), user: req.user }));

  // Namensauswahl für die Anmeldung – absichtlich ohne Anmeldung abrufbar.
  app.get('/api/auth/candidates', async () => users.candidates());

  app.post('/api/auth/setup', async (req, reply) => {
    const body = parse(z.object({ firstName: name, lastName: name, pin }), req.body);
    const user = await users.setupFirstAdmin(body);
    startSession(req, reply, user);
    audit(fullName(user), 'setup', `user:${user.id}`);
    deps.notify(['users']);
    return reply.code(201).send(user);
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ userId: z.number().int().positive(), pin: z.string().max(10) }), req.body);
    limiter.assertAllowed(body.userId, req.ip);
    const user = await users.checkPin(body.userId, body.pin);
    if (!user) {
      const left = limiter.failure(body.userId, req.ip);
      audit('Anonym', 'login', `user:${body.userId}`, false, 'PIN falsch');
      throw new HttpError(401, left > 0 ? `PIN falsch – noch ${left} Versuch${left === 1 ? '' : 'e'}` : 'PIN falsch – Anmeldung vorübergehend gesperrt');
    }
    limiter.success(user.id);
    startSession(req, reply, user);
    audit(fullName(user), 'login', `user:${user.id}`);
    return user;
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) sessions.revoke(token);
    if (req.user) audit(fullName(req.user), 'logout', `user:${req.user.id}`);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.post('/api/auth/pin', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(z.object({ currentPin: z.string().max(10), newPin: pin }), req.body);
    await users.changeOwnPin(user.id, body.currentPin, body.newPin);
    // Andere Sitzungen dieses Benutzers beenden, die aktuelle bleibt bestehen.
    sessions.revokeUser(user.id, req.cookies[SESSION_COOKIE]);
    audit(fullName(user), 'change-pin', `user:${user.id}`);
    return reply.code(204).send();
  });

  // --- Benutzerverwaltung ---

  app.get('/api/users', async () => users.list());

  app.post('/api/users', async (req, reply) => {
    const actor = requireUser(req);
    const body = parse(z.object({ firstName: name, lastName: name, pin, isAdmin: z.boolean().optional() }), req.body);
    const user = await users.create(body, actor);
    audit(fullName(actor), 'create', `user:${user.id}`, true, `${fullName(user)}${user.isAdmin ? ' (Admin)' : ''}`);
    deps.notify(['users']);
    return reply.code(201).send(user);
  });

  app.patch('/api/users/:id', async (req) => {
    const actor = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ firstName: name.optional(), lastName: name.optional(), isAdmin: z.boolean().optional(), pin: pin.optional() }), req.body);
    const before = users.get(id);
    const user = await users.update(id, body, actor);
    if (body.pin !== undefined || (body.isAdmin === false && before.isAdmin)) sessions.revokeUser(id);
    const changes = [
      body.pin !== undefined && 'PIN zurückgesetzt',
      before.isAdmin !== user.isAdmin && (user.isAdmin ? 'Admin-Rechte erteilt' : 'Admin-Rechte entzogen'),
      fullName(before) !== fullName(user) && `Name: ${fullName(user)}`,
    ].filter(Boolean);
    audit(fullName(actor), 'update', `user:${id}`, true, changes.join(', '));
    deps.notify(['users']);
    return user;
  });

  app.delete('/api/users/:id', async (req, reply) => {
    const actor = requireUser(req);
    const { id } = parse(idParam, req.params);
    const user = users.remove(id, actor);
    audit(fullName(actor), 'delete', `user:${id}`, true, fullName(user));
    deps.notify(['users']);
    return reply.code(204).send();
  });
}
