import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { formatRecoveryKey, RECOVERY_KEY_BYTES } from '@elvis/shared';

/**
 * Schlüssel und Verschlüsselung der Backups. Aus dem Zufallsanteil des Wiederherstellungsschlüssels leitet HKDF
 * Tresor-ID, Zugang beim Treiber und AES-Schlüssel ab – eine frische Installation findet ihre Backups also nur mit
 * dem Schlüssel. Backups werden in Blöcken verschlüsselt (AES-256-GCM, Nonce = Präfix | Zähler | Letzter-Block),
 * damit auch abgeschnittene oder umsortierte Dateien auffallen.
 */

export interface BackupKeys {
  /** 32 Hex-Zeichen */
  vaultId: string;
  /** Bearer-Token beim Treiber */
  vaultToken: string;
  encKey: Buffer;
}

export function generateRecoveryKey(): string {
  return formatRecoveryKey(randomBytes(RECOVERY_KEY_BYTES));
}

export function deriveKeys(secret: Uint8Array): BackupKeys {
  const derive = (info: string, len: number) => Buffer.from(hkdfSync('sha256', secret, 'elvis-backup', info, len));
  return {
    vaultId: derive('vault-id', 16).toString('hex'),
    vaultToken: derive('vault-token', 32).toString('base64url'),
    encKey: derive('encryption', 32),
  };
}

const MAGIC = Buffer.from('ELVBAK1\n');
const VERSION = 1;
const HEADER_BYTES = MAGIC.length + 1 + 7;
export const CHUNK_BYTES = 4 * 1024 * 1024;
const TAG_BYTES = 16;

function nonce(prefix: Buffer, counter: number, last: boolean): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, 7);
  n[11] = last ? 1 : 0;
  return n;
}

/** Klartext → Kopf + verschlüsselte Blöcke */
export function encryptStream(key: Buffer, chunkBytes = CHUNK_BYTES): Transform {
  const prefix = randomBytes(7);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), prefix]);
  let counter = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;

  const seal = (plain: Buffer, last: boolean) => {
    const c = createCipheriv('aes-256-gcm', key, nonce(prefix, counter++, last));
    c.setAAD(header);
    return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  };

  return new Transform({
    construct(cb) {
      this.push(header);
      cb();
    },
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      // Ein voller Block wird erst geschrieben, wenn danach noch etwas kommt (der letzte trägt die Markierung)
      while (pendingBytes > chunkBytes) {
        const all = Buffer.concat(pending);
        this.push(seal(all.subarray(0, chunkBytes), false));
        pending = [all.subarray(chunkBytes)];
        pendingBytes = all.length - chunkBytes;
      }
      cb();
    },
    flush(cb) {
      this.push(seal(Buffer.concat(pending), true));
      cb();
    },
  });
}

/** Gegenstück zu encryptStream; wirft bei falschem Schlüssel, Manipulation oder abgeschnittener Datei */
export function decryptStream(key: Buffer, chunkBytes = CHUNK_BYTES): Transform {
  let header: Buffer | null = null;
  let prefix: Buffer;
  let counter = 0;
  let buf = Buffer.alloc(0);
  const record = chunkBytes + TAG_BYTES;

  const open = (sealed: Buffer, last: boolean) => {
    const d = createDecipheriv('aes-256-gcm', key, nonce(prefix, counter++, last));
    d.setAAD(header!);
    d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    try {
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_BYTES)), d.final()]);
    } catch {
      throw new Error('Backup lässt sich nicht entschlüsseln (falscher Schlüssel oder beschädigt)');
    }
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buf = Buffer.concat([buf, chunk]);
        if (!header) {
          if (buf.length < HEADER_BYTES) return cb();
          header = buf.subarray(0, HEADER_BYTES);
          if (!header.subarray(0, MAGIC.length).equals(MAGIC) || header[MAGIC.length] !== VERSION) throw new Error('Keine Backup-Datei von ELVIS');
          prefix = header.subarray(MAGIC.length + 1);
          buf = buf.subarray(HEADER_BYTES);
        }
        while (buf.length > record) {
          this.push(open(buf.subarray(0, record), false));
          buf = buf.subarray(record);
        }
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb) {
      try {
        if (!header || buf.length < TAG_BYTES) throw new Error('Backup ist unvollständig');
        this.push(open(buf, true));
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
  });
}

/** Kleine Werte (Metadaten) verschlüsseln: iv(12) | tag(16) | Chiffrat, base64 */
export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('meta'));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function unseal(key: Buffer, sealed: string): string | null {
  try {
    const buf = Buffer.from(sealed, 'base64');
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAAD(Buffer.from('meta'));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
