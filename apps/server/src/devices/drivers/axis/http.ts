import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface AxisConnection {
  host: string;
  protocol: 'http' | 'https';
  username: string;
  password: string;
  verifyTls: boolean;
}

export class AxisError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

interface Challenge {
  scheme: 'digest' | 'basic';
  realm: string;
  nonce: string;
  opaque?: string;
  qop?: string;
  algorithm: 'MD5' | 'SHA-256';
}

/** Alle WWW-Authenticate-Angebote einzeln (Axis schickt oft Digest SHA-256, Digest MD5 und Basic). */
export function parseChallenges(raw: string[]): Challenge[] {
  const out: Challenge[] = [];
  for (const header of raw) {
    const m = /^(\w+)\s+(.*)$/s.exec(header.trim());
    if (!m) continue;
    const scheme = m[1]!.toLowerCase();
    const params: Record<string, string> = {};
    for (const p of m[2]!.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) params[p[1]!.toLowerCase()] = p[2] ?? p[3] ?? '';
    if (scheme === 'basic') out.push({ scheme: 'basic', realm: params.realm ?? '', nonce: '', algorithm: 'MD5' });
    if (scheme === 'digest') {
      const algorithm = (params.algorithm ?? 'MD5').toUpperCase();
      if (algorithm !== 'MD5' && algorithm !== 'SHA-256') continue;
      out.push({ scheme: 'digest', realm: params.realm ?? '', nonce: params.nonce ?? '', opaque: params.opaque, qop: params.qop, algorithm });
    }
  }
  // stärkstes Verfahren zuerst
  const rank = (c: Challenge) => (c.scheme === 'digest' ? (c.algorithm === 'SHA-256' ? 0 : 1) : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

const hash = (alg: Challenge['algorithm'], s: string) => createHash(alg === 'SHA-256' ? 'sha256' : 'md5').update(s).digest('hex');

export function digestHeader(c: Challenge, user: string, pass: string, method: string, uri: string, nc: number, cnonce = randomBytes(8).toString('hex')): string {
  if (c.scheme === 'basic') return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const ha1 = hash(c.algorithm, `${user}:${c.realm}:${pass}`);
  const ha2 = hash(c.algorithm, `${method}:${uri}`);
  const qop = c.qop?.split(',').map((q) => q.trim()).includes('auth') ? 'auth' : undefined;
  const ncHex = nc.toString(16).padStart(8, '0');
  const response = qop ? hash(c.algorithm, `${ha1}:${c.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : hash(c.algorithm, `${ha1}:${c.nonce}:${ha2}`);
  const parts = [`username="${user}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `algorithm=${c.algorithm}`, `response="${response}"`];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  if (c.opaque !== undefined) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export interface AxisResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/**
 * HTTP-Zugang zu einer Axis-Kamera mit Digest- bzw. Basic-Anmeldung. Die Anmeldedaten bleiben auf dem
 * ELVIS-Server; Browser bekommen Bild und Steuerung nur über ELVIS.
 */
export class AxisHttp {
  private challenge: Challenge | null = null;
  private nc = 0;

  constructor(private readonly c: AxisConnection) {}

  private open(method: string, path: string, body: Buffer | undefined, contentType: string | undefined, timeoutMs: number): Promise<IncomingMessage> {
    const url = new URL(`${this.c.protocol}://${this.c.host}${path}`);
    const headers: Record<string, string> = {};
    if (contentType) headers['content-type'] = contentType;
    if (body) headers['content-length'] = String(body.length);
    if (this.challenge) headers.authorization = digestHeader(this.challenge, this.c.username, this.c.password, method, url.pathname + url.search, ++this.nc);
    return new Promise((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers, timeout: timeoutMs, ...(url.protocol === 'https:' && { rejectUnauthorized: this.c.verifyTls }) }, resolve);
      req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /** Anfrage mit automatischer Anmeldung; liefert die Antwort als Datenstrom. */
  async stream(method: 'GET' | 'POST', path: string, body?: Buffer, contentType?: string, timeoutMs = 8_000): Promise<IncomingMessage> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.open(method, path, body, contentType, timeoutMs);
      if (res.statusCode !== 401) return res;
      res.resume();
      const offers = parseChallenges(res.rawHeaders.filter((_, i, a) => i % 2 === 1 && a[i - 1]!.toLowerCase() === 'www-authenticate'));
      if (attempt === 1 || !offers[0]) break;
      this.challenge = offers[0];
      this.nc = 0;
    }
    throw new AxisError('Anmeldung an der Kamera abgelehnt – Benutzer/Passwort prüfen', 401);
  }

  async send(method: 'GET' | 'POST', path: string, body?: Buffer, contentType?: string): Promise<AxisResponse> {
    const res = await this.stream(method, path, body, contentType);
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    return { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) };
  }

  /** GET mit Textantwort; wirft bei HTTP-Fehlern. */
  async text(path: string): Promise<string> {
    const r = await this.send('GET', path);
    if (r.status >= 300) throw new AxisError(`${path.split('?')[0]}: HTTP ${r.status}`, r.status);
    return r.body.toString('utf8');
  }

  /** JSON-API (z. B. opticscontrol.cgi): wirft bei HTTP- oder API-Fehlern. */
  async json<T>(path: string, payload: unknown): Promise<T> {
    const r = await this.send('POST', path, Buffer.from(JSON.stringify(payload)), 'application/json');
    if (r.status >= 300) throw new AxisError(`${path}: HTTP ${r.status}`, r.status);
    const data = JSON.parse(r.body.toString('utf8')) as { data?: T; error?: { code: number; message: string } };
    if (data.error) throw new AxisError(`${data.error.message} (${data.error.code})`, 400);
    return data.data as T;
  }
}

/** Antworten wie „root.Brand.ProdShortName=AXIS P3225-LVE Mk II“ bzw. „pan=12.3“ in ein Objekt wandeln. */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
