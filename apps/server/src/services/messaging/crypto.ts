import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { envelopeSchema, type Envelope } from '@elvis/shared';
import type { MailCrypto } from '../mailcrypto.js';

/**
 * Verschlüsselung des Cloud Messagings mit dem Schlüssel des ELVIS-Postfachs: Jeder Umschlag ist mit OpenPGP signiert
 * und für die Gegenseite und uns selbst verschlüsselt. Anhänge verschlüsselt ELVIS vorher mit einem Einmalschlüssel
 * (AES-256-GCM); Schlüssel und Prüfsumme reisen im signierten Umschlag, beim Relay liegt nur der Geheimtext.
 */

export async function sealEnvelope(crypto: MailCrypto, envelope: Envelope, peerPublicKey: string): Promise<string> {
  return crypto.encryptAndSign(JSON.stringify(envelope), [peerPublicKey]);
}

export type OpenedEnvelope = { ok: true; envelope: Envelope } | { ok: false; reason: 'signature' | 'unknown-kind' | 'invalid'; kind?: string };

/** Entschlüsseln und prüfen: gültige Signatur der Gegenseite, bekannte Art, gültiger Inhalt */
export async function openEnvelope(crypto: MailCrypto, armored: string, peerPublicKey: string): Promise<OpenedEnvelope> {
  const { data, signature } = await crypto.decryptMessage(armored, peerPublicKey);
  if (signature !== 'valid') return { ok: false, reason: 'signature' };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(data, 'latin1').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  const kind = (raw as { kind?: unknown } | null)?.kind;
  const known = envelopeSchema.options.some((o) => o.shape.kind.value === kind);
  return typeof kind === 'string' && !known ? { ok: false, reason: 'unknown-kind', kind } : { ok: false, reason: 'invalid' };
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Anhang verschlüsseln: blob = IV (12) ‖ Geheimtext ‖ Tag (16) */
export function encryptFile(data: Buffer): { blob: Buffer; key: string; sha256: string } {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const blob = Buffer.concat([iv, cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  return { blob, key: key.toString('base64'), sha256: sha256(data) };
}

export function decryptFile(blob: Buffer, key: string, expectedSha256: string): Buffer {
  if (blob.length < 28) throw new Error('Anhang beschädigt');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  const data = Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
  if (sha256(data) !== expectedSha256) throw new Error('Prüfsumme des Anhangs stimmt nicht');
  return data;
}
