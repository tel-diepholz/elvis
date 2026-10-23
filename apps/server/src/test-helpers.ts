import type { App } from './app.js';

/** Legt beim ersten Aufruf den ersten Admin an und liefert dessen Sitzungs-Cookie. */
export async function adminCookie(app: App, name = { firstName: 'Max', lastName: 'Müller' }, pin = '4711'): Promise<string> {
  const res = await app.server.inject({ method: 'POST', url: '/api/auth/setup', payload: { ...name, pin } });
  if (res.statusCode !== 201) throw new Error(`Ersteinrichtung fehlgeschlagen: ${res.body}`);
  return sessionCookie(res.headers['set-cookie']);
}

export function sessionCookie(header: string | string[] | undefined): string {
  const raw = (Array.isArray(header) ? header : [header ?? '']).find((c) => c.startsWith('elvis_session='));
  if (!raw) throw new Error('Kein Sitzungs-Cookie');
  return raw.split(';')[0]!;
}
