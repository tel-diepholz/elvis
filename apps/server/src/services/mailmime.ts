import { randomBytes } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

/**
 * MIME für das Postfach: Mails mit nodemailer zusammensetzen und für PGP/MIME (RFC 3156) in äußeren Kopf und
 * inneren Teil zerlegen; eingehende multipart/encrypted bzw. multipart/signed wieder auseinandernehmen.
 * Rohmails werden als latin1-String behandelt, damit jedes Byte erhalten bleibt.
 */

export interface ComposeInput {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  headers: Record<string, string>;
  date: Date;
}

export async function compose(input: ComposeInput): Promise<string> {
  const mail = new MailComposer({
    from: input.from,
    to: input.to,
    cc: input.cc.length ? input.cc : undefined,
    subject: input.subject,
    text: input.text,
    attachments: input.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, content: a.content })),
    messageId: input.messageId,
    inReplyTo: input.inReplyTo ?? undefined,
    references: input.references ?? undefined,
    headers: input.headers,
    date: input.date,
    // PGP/MIME verlangt 7 Bit im signierten Teil
    textEncoding: 'quoted-printable',
  });
  const buf = await new Promise<Buffer>((resolve, reject) => mail.compile().build((err, msg) => (err ? reject(err) : resolve(msg))));
  return buf.toString('latin1');
}

/** Kopf und Körper an der ersten Leerzeile trennen */
export function splitMessage(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: '' };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/** Kopfzeilen (gefaltete Zeilen bleiben zusammen, Reihenfolge bleibt erhalten) */
export function headerLines(head: string): string[] {
  return head.split(/\r?\n(?![ \t])/).filter((l) => l.length > 0);
}

const nameOf = (line: string) => line.slice(0, line.indexOf(':')).trim().toLowerCase();
const isContentHeader = (line: string) => nameOf(line).startsWith('content-') || nameOf(line) === 'mime-version';

export function headerValue(head: string, name: string): string | null {
  const line = headerLines(head).find((l) => nameOf(l) === name.toLowerCase());
  return line ? line.slice(line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim() : null;
}

/** Parameter einer Kopfzeile, z. B. boundary aus Content-Type */
export function headerParam(value: string, param: string): string | null {
  const m = new RegExp(`;\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Für PGP/MIME: äußere Kopfzeilen (Absender, Betreff …) und innerer Teil (Content-*-Kopf + Körper) */
export function splitEntity(raw: string): { outer: string[]; entity: string } {
  const { head, body } = splitMessage(raw);
  const lines = headerLines(head);
  const outer = lines.filter((l) => !isContentHeader(l));
  const inner = lines.filter((l) => isContentHeader(l) && nameOf(l) !== 'mime-version');
  return { outer, entity: `${inner.join('\r\n')}\r\n\r\n${body}` };
}

const boundary = () => `----elvis-${randomBytes(12).toString('hex')}`;

export function wrapEncrypted(outer: string[], armored: string): string {
  const b = boundary();
  return [
    ...outer,
    'MIME-Version: 1.0',
    `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${b}"`,
    '',
    'This is an OpenPGP/MIME encrypted message (RFC 4880 and 3156)',
    `--${b}`,
    'Content-Type: application/pgp-encrypted',
    'Content-Description: PGP/MIME version identification',
    '',
    'Version: 1',
    '',
    `--${b}`,
    'Content-Type: application/octet-stream; name="encrypted.asc"',
    'Content-Description: OpenPGP encrypted message',
    'Content-Disposition: inline; filename="encrypted.asc"',
    '',
    armored.replace(/\r?\n/g, '\r\n').trimEnd(),
    '',
    `--${b}--`,
    '',
  ].join('\r\n');
}

export function wrapSigned(outer: string[], entity: string, signature: string, micalg: string): string {
  const b = boundary();
  return [
    ...outer,
    'MIME-Version: 1.0',
    `Content-Type: multipart/signed; micalg=${micalg}; protocol="application/pgp-signature"; boundary="${b}"`,
    '',
    'This is an OpenPGP/MIME signed message (RFC 4880 and 3156)',
    `--${b}`,
    entity,
    `--${b}`,
    'Content-Type: application/pgp-signature; name="signature.asc"',
    'Content-Description: OpenPGP digital signature',
    'Content-Disposition: attachment; filename="signature.asc"',
    '',
    signature.replace(/\r?\n/g, '\r\n').trimEnd(),
    '',
    `--${b}--`,
    '',
  ].join('\r\n');
}

/** Teile eines multipart-Körpers, jeweils genau die Bytes zwischen den Trennzeilen */
export function multipartParts(body: string, b: string): string[] {
  const delim = `--${b}`;
  const parts: string[] = [];
  let pos = body.startsWith(delim) ? 0 : body.indexOf(`\n${delim}`);
  while (pos >= 0) {
    const lineStart = body[pos] === '\n' ? pos + 1 : pos;
    const after = lineStart + delim.length;
    if (body.startsWith('--', after)) break;
    const contentStart = body.indexOf('\n', after);
    if (contentStart < 0) break;
    const next = body.indexOf(`\n${delim}`, contentStart);
    if (next < 0) break;
    // Der Zeilenumbruch vor der nächsten Trennzeile gehört zur Trennzeile
    const end = body[next - 1] === '\r' ? next - 1 : next;
    parts.push(body.slice(contentStart + 1, end));
    pos = next;
  }
  return parts;
}

export type PgpMime = { kind: 'encrypted'; armored: string } | { kind: 'signed'; entity: string; signature: string } | null;

/** Erkennt PGP/MIME am obersten Content-Type */
export function detectPgpMime(raw: string): PgpMime {
  const { head, body } = splitMessage(raw);
  const ct = headerValue(head, 'content-type') ?? '';
  const b = headerParam(ct, 'boundary');
  if (!b) return null;
  if (/^multipart\/encrypted/i.test(ct) && /application\/pgp-encrypted/i.test(headerParam(ct, 'protocol') ?? '')) {
    const armored = /-----BEGIN PGP MESSAGE-----[\s\S]*?-----END PGP MESSAGE-----/.exec(multipartParts(body, b)[1] ?? '')?.[0];
    return armored ? { kind: 'encrypted', armored } : null;
  }
  if (/^multipart\/signed/i.test(ct) && /application\/pgp-signature/i.test(headerParam(ct, 'protocol') ?? '')) {
    const [entity, sigPart] = multipartParts(body, b);
    const signature = /-----BEGIN PGP SIGNATURE-----[\s\S]*?-----END PGP SIGNATURE-----/.exec(sigPart ?? '')?.[0];
    return entity !== undefined && signature ? { kind: 'signed', entity, signature } : null;
  }
  return null;
}

/**
 * Nach dem Entschlüsseln: äußerer Kopf ohne Content-* plus innerer Teil. Kopfzeilen, die der innere Teil selbst
 * mitbringt (geschützte Kopfzeilen, z. B. Subject), ersetzen die äußeren.
 */
export function mergeDecrypted(outerRaw: string, inner: string): string {
  const outer = headerLines(splitMessage(outerRaw).head).filter((l) => !isContentHeader(l));
  const { head, body } = splitMessage(inner);
  const innerLines = headerLines(head);
  const innerNames = new Set(innerLines.map(nameOf));
  return [...outer.filter((l) => !innerNames.has(nameOf(l))), 'MIME-Version: 1.0', ...innerLines, '', body].join('\r\n');
}

/** Adresse aus „Name <a@b>“ */
export const addressOf = (value: string) => (/<([^>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
