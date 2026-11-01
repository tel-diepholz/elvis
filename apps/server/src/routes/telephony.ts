import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CallLogService } from '../services/telephony.js';
import { parse } from './util.js';

const callsQuery = z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24) });

/** Anrufliste des GSM-Gateways (alle Angemeldeten) */
export function telephonyRoutes(app: FastifyInstance, deps: { calls: CallLogService }): void {
  app.get('/api/telephony/calls', async (req) => deps.calls.list(parse(callsQuery, req.query).hours));
}
