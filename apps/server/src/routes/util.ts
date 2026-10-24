import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { fullName } from '@elvis/shared';
import { HttpError } from '../errors.js';

/** Name des angemeldeten Benutzers für Tagebuch und Bedienprotokoll. */
export function operatorOf(req: FastifyRequest): string {
  return req.user ? fullName(req.user) : 'Anonym';
}

export function parse<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.') || 'Eingabe'}: ${i.message}`).join('; ');
    throw new HttpError(400, msg);
  }
  return result.data;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

/** Angemeldeter Benutzer für Rechteprüfungen in den Diensten */
export function actorOf(req: FastifyRequest): { id: number; name: string; isAdmin: boolean } {
  if (!req.user) throw new HttpError(401, 'Bitte anmelden');
  return { id: req.user.id, name: fullName(req.user), isAdmin: req.user.isAdmin };
}

/** Adresse von ELVIS, wie der Browser sie aufgerufen hat (Origin der Anfrage oder Host-Header) */
export function originOf(req: FastifyRequest): string {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  return `${req.protocol}://${req.host}`;
}
