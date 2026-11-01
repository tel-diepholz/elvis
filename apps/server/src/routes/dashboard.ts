import type { FastifyInstance } from 'fastify';
import { dashboardLayoutSchema } from '@elvis/shared';
import type { DashboardService } from '../services/dashboards.js';
import { requireUser } from './auth.js';
import { parse } from './util.js';

/** Eigene Übersicht des angemeldeten Benutzers */
export function dashboardRoutes(app: FastifyInstance, deps: { dashboards: DashboardService }): void {
  const { dashboards } = deps;
  app.get('/api/me/dashboard', async (req) => dashboards.get(requireUser(req).id));
  app.put('/api/me/dashboard', async (req) => dashboards.save(requireUser(req).id, parse(dashboardLayoutSchema, req.body)));
  app.delete('/api/me/dashboard', async (req) => dashboards.reset(requireUser(req).id));
}
