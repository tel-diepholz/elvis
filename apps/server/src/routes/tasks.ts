import type { FastifyInstance, FastifyRequest } from 'fastify';
import { idOrderSchema, roleInputSchema, snoozeSchema, taskDoneSchema, taskInputSchema, taskTemplateInputSchema, type Topic } from '@elvis/shared';
import type { Store } from '../db/store.js';
import type { RoleService } from '../services/roles.js';
import type { TaskService, TaskViewer } from '../services/tasks.js';
import { actorOf, idParam, operatorOf, parse } from './util.js';

const viewerOf = (req: FastifyRequest): TaskViewer => ({ userId: actorOf(req).id, roleId: req.roleId });

export function taskRoutes(app: FastifyInstance, deps: { tasks: TaskService; roles: RoleService; store: Store; notify: (t: Topic[]) => void }): void {
  const { tasks, roles } = deps;
  const audit = (req: FastifyRequest, target: string, action: string, message: string) => {
    deps.store.addAudit({ operator: operatorOf(req), target, action, params: '', success: true, message });
    deps.notify(['audit']);
  };

  // --- Rollen: lesen alle, pflegen Admins (/api/system/) ---

  app.get('/api/roles', async () => roles.infos());

  app.post('/api/system/roles', async (req, reply) => {
    const role = roles.create(parse(roleInputSchema, req.body));
    audit(req, 'rollen', 'create', role.name);
    deps.notify(['roles']);
    return reply.code(201).send(role);
  });

  app.put('/api/system/roles/order', async (req) => {
    const list = roles.reorder(parse(idOrderSchema, req.body).ids);
    deps.notify(['roles']);
    return list;
  });

  app.put('/api/system/roles/:id', async (req) => {
    const role = roles.update(parse(idParam, req.params).id, parse(roleInputSchema, req.body));
    audit(req, 'rollen', 'update', role.name);
    deps.notify(['roles', 'tasks', 'taskTemplates', 'users']);
    return role;
  });

  app.delete('/api/system/roles/:id', async (req, reply) => {
    const role = roles.remove(parse(idParam, req.params).id);
    audit(req, 'rollen', 'delete', role.name);
    // Sitzungen verlieren die Rolle (Anmeldestatus), Aufgaben gehen an alle
    deps.notify(['roles', 'tasks', 'taskTemplates', 'users']);
    return reply.code(204).send();
  });

  // --- Aufgabenvorlagen (nur Admins) ---

  app.get('/api/system/task-templates', async () => tasks.templates());

  app.post('/api/system/task-templates', async (req, reply) => {
    const t = tasks.createTemplate(parse(taskTemplateInputSchema, req.body));
    audit(req, 'aufgabenvorlagen', 'create', t.summary);
    return reply.code(201).send(t);
  });

  app.put('/api/system/task-templates/order', async (req) => tasks.reorderTemplates(parse(idOrderSchema, req.body).ids));

  app.put('/api/system/task-templates/:id', async (req) => {
    const t = tasks.updateTemplate(parse(idParam, req.params).id, parse(taskTemplateInputSchema, req.body));
    audit(req, 'aufgabenvorlagen', 'update', t.summary);
    return t;
  });

  app.delete('/api/system/task-templates/:id', async (req, reply) => {
    const t = tasks.removeTemplate(parse(idParam, req.params).id);
    audit(req, 'aufgabenvorlagen', 'delete', t.summary);
    return reply.code(204).send();
  });

  // --- Aufgaben im Einsatz ---

  // Gekoppelte Bildschirme lesen ohne Anmeldung (Kachel „Aufgaben“) – dann ohne Sicht eines Benutzers
  app.get('/api/incidents/:id/tasks', async (req) => tasks.list(parse(idParam, req.params).id, req.user ? viewerOf(req) : null));

  app.post('/api/incidents/:id/tasks', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    return reply.code(201).send(tasks.create(id, parse(taskInputSchema, req.body), actorOf(req), viewerOf(req)));
  });

  app.put('/api/tasks/:id', async (req) => tasks.update(parse(idParam, req.params).id, parse(taskInputSchema, req.body), actorOf(req), viewerOf(req)));

  app.post('/api/tasks/:id/done', async (req) => tasks.done(parse(idParam, req.params).id, parse(taskDoneSchema, req.body ?? {}).final, actorOf(req), viewerOf(req)));

  app.post('/api/tasks/:id/reopen', async (req) => tasks.reopen(parse(idParam, req.params).id, actorOf(req), viewerOf(req)));

  app.post('/api/tasks/:id/snooze', async (req) => tasks.snooze(parse(idParam, req.params).id, parse(snoozeSchema, req.body), viewerOf(req)));

  app.delete('/api/tasks/:id', async (req, reply) => {
    tasks.remove(parse(idParam, req.params).id, actorOf(req));
    return reply.code(204).send();
  });
}
