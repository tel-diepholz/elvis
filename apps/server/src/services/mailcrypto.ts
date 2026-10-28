import { createCipheriv, createDecipheriv, createHash, randomBytes, webcrypto } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as openpgp from 'openpgp';
import type { MailSignature } from '@elvis/shared';

/**
 * OpenPGP für das Postfach des ELW. Der private Schlüssel liegt passphrasegeschützt in der Datenbank; die
 * Passphrase steht in einer eigenen Datei im Datenverzeichnis (mail.secret, nur für den Dienst lesbar). Eine Kopie
 * der Datenbank allein gibt den Schlüssel also nicht preis.
 */

const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** Geheimnis der Installation für den Mailschlüssel; ohne Datenverzeichnis (Tests) nur im Speicher */
export class MailVault {
  private cached: Buffer | null = null;

  constructor(private readonly dataDir: string | ':memory:') {}

  private secret(): Buffer {
    if (this.cached) return this.cached;
    if (this.dataDir === ':memory:') return (this.cached = randomBytes(32));
    const file = join(this.dataDir, 'mail.secret');
    if (!existsSync(file)) {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    }
    try {
      chmodSync(file, 0o600);
    } catch {
      /* z. B. Windows-Dateisystem */
    }
    return (this.cached = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64'));
  }

  passphrase(): string {
    return this.secret().toString('hex');
  }

  seal(plain: Buffer): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.secret(), iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  open(sealed: string): Buffer {
    const buf = Buffer.from(sealed, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.secret(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
  }
}

/** Was ELVIS dauerhaft speichert (settings mail:keys) */
export interface StoredMailKeys {
  address: string;
  publicKey: string;
  /** armored, mit der Passphrase aus mail.secret geschützt */
  privateKey: string;
  fingerprint: string;
  /** Ed25519 für signierte Abrufe beim Relay: öffentlich (raw, base64url) und privat (PKCS#8, versiegelt) */
  sigPublicKey: string;
  sigPrivateKey: string;
}

export async function generateMailKeys(address: string, name: string, vault: MailVault): Promise<{ keys: StoredMailKeys; revocationCert: string }> {
  const { privateKey, publicKey, revocationCertificate } = await openpgp.generateKey({
    type: 'curve25519',
    userIDs: [{ name, email: address }],
    passphrase: vault.passphrase(),
    format: 'armored',
  });
  const sig = (await webcrypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const sigPublicKey = b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', sig.publicKey)));
  const sigPrivateKey = vault.seal(Buffer.from(await webcrypto.subtle.exportKey('pkcs8', sig.privateKey)));
  const fingerprint = (await openpgp.readKey({ armoredKey: publicKey })).getFingerprint().toUpperCase();
  return { keys: { address, publicKey, privateKey, fingerprint, sigPublicKey, sigPrivateKey }, revocationCert: revocationCertificate };
}

/** Öffentlichen Schlüssel prüfen: lesbar, nicht privat, kann verschlüsseln, (optional) gehört zur Adresse */
export async function checkPublicKey(input: { armored?: string; binary?: Uint8Array }, address?: string): Promise<{ armored: string; fingerprint: string }> {
  let key: openpgp.Key;
  try {
    key = input.binary ? await openpgp.readKey({ binaryKey: input.binary }) : await openpgp.readKey({ armoredKey: input.armored ?? '' });
  } catch {
    throw new Error('Schlüssel nicht lesbar');
  }
  if (key.isPrivate()) throw new Error('Das ist ein privater Schlüssel – nur den öffentlichen importieren');
  if (address && !key.users.some((u) => u.userID?.email.toLowerCase() === address.toLowerCase())) throw new Error(`Schlüssel gehört nicht zu ${address}`);
  try {
    await key.getEncryptionKey();
  } catch {
    throw new Error('Schlüssel abgelaufen, widerrufen oder ohne Verschlüsselung');
  }
  return { armored: key.armor(), fingerprint: key.getFingerprint().toUpperCase() };
}

/** Schlüsselmaterial des ELW im Betrieb (entschlüsselt bei Bedarf und hält den Schlüssel im Speicher) */
export class MailCrypto {
  private unlocked: Promise<openpgp.PrivateKey> | null = null;
  private sigKey: Promise<webcrypto.CryptoKey> | null = null;

  constructor(
    readonly keys: StoredMailKeys,
    private readonly vault: MailVault,
  ) {}

  private privateKey(): Promise<openpgp.PrivateKey> {
    this.unlocked ??= (async () =>
      openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: this.keys.privateKey }), passphrase: this.vault.passphrase() }))();
    return this.unlocked;
  }

  /** Signatur für einen Abruf beim Relay (base64url) */
  async signRequest(payload: string): Promise<string> {
    this.sigKey ??= webcrypto.subtle.importKey('pkcs8', this.vault.open(this.keys.sigPrivateKey), { name: 'Ed25519' }, false, ['sign']);
    return b64url(new Uint8Array(await webcrypto.subtle.sign({ name: 'Ed25519' }, await this.sigKey, new TextEncoder().encode(payload))));
  }

  /** Vom Relay verschlüsselte Rohmail */
  async decryptBlob(blob: Uint8Array): Promise<Buffer> {
    const { data } = await openpgp.decrypt({ message: await openpgp.readMessage({ binaryMessage: blob }), decryptionKeys: await this.privateKey(), format: 'binary' });
    return Buffer.from(data as Uint8Array);
  }

  /** PGP/MIME-Inhalt entschlüsseln und (falls signiert) die Signatur prüfen */
  async decryptMessage(armored: string, senderKey: string | null): Promise<{ data: string; signature: MailSignature }> {
    const message = await openpgp.readMessage({ armoredMessage: armored });
    const verificationKeys = senderKey ? await openpgp.readKey({ armoredKey: senderKey }) : undefined;
    const result = await openpgp.decrypt({ message, decryptionKeys: await this.privateKey(), verificationKeys, format: 'binary' });
    return { data: Buffer.from(result.data as Uint8Array).toString('latin1'), signature: await signatureStatus(result.signatures, !!verificationKeys) };
  }

  /** Signieren und an Empfänger (und an sich selbst, für „Gesendet“) verschlüsseln */
  async encryptAndSign(entity: string, recipientKeys: string[]): Promise<string> {
    const encryptionKeys = await Promise.all([this.keys.publicKey, ...recipientKeys].map((k) => openpgp.readKey({ armoredKey: k })));
    return (await openpgp.encrypt({ message: await openpgp.createMessage({ text: entity }), encryptionKeys, signingKeys: await this.privateKey() })) as string;
  }

  /** Abgelöste Signatur für multipart/signed; micalg passend zum Hash der Signatur */
  async signDetached(entity: string): Promise<{ signature: string; micalg: string }> {
    const signature = (await openpgp.sign({ message: await openpgp.createMessage({ text: entity }), signingKeys: await this.privateKey(), detached: true })) as string;
    const packet = (await openpgp.readSignature({ armoredSignature: signature })).packets[0] as unknown as { hashAlgorithm: number };
    return { signature, micalg: `pgp-${openpgp.enums.read(openpgp.enums.hash, packet.hashAlgorithm).toLowerCase()}` };
  }

  /** Autocrypt-Kopfzeile (Level 1): Gegenstellen lernen den Schlüssel aus jeder Mail */
  async autocryptHeader(): Promise<string> {
    const key = await openpgp.readKey({ armoredKey: this.keys.publicKey });
    return `addr=${this.keys.address}; prefer-encrypt=mutual; keydata=${Buffer.from(key.write()).toString('base64')}`;
  }
}

/** Ergebnis der Signaturprüfung aus openpgp.decrypt/verify */
async function signatureStatus(signatures: openpgp.VerifyMessageResult['signatures'], haveKey: boolean): Promise<MailSignature> {
  if (!signatures.length) return 'none';
  if (!haveKey) return 'unknown-key';
  try {
    await signatures[0]!.verified;
    return 'valid';
  } catch (e) {
    return /Could not find signing key/i.test(String(e)) ? 'unknown-key' : 'invalid';
  }
}

/** multipart/signed prüfen: Teil 1 (unverändert) gegen die abgelöste Signatur aus Teil 2 */
export async function verifyDetached(entity: string, armoredSignature: string, senderKey: string | null): Promise<MailSignature> {
  if (!senderKey) return 'unknown-key';
  try {
    const result = await openpgp.verify({
      message: await openpgp.createMessage({ text: entity }),
      signature: await openpgp.readSignature({ armoredSignature }),
      verificationKeys: await openpgp.readKey({ armoredKey: senderKey }),
    });
    return signatureStatus(result.signatures, true);
  } catch {
    return 'invalid';
  }
}

/** Autocrypt-Kopfzeile lesen: Adresse und Schlüssel (nur wenn Adresse = Absender) */
export async function keyFromAutocrypt(header: string, from: string): Promise<{ armored: string; fingerprint: string } | null> {
  const attrs = Object.fromEntries(
    header
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
      }),
  );
  if (!attrs.addr || attrs.addr.toLowerCase() !== from.toLowerCase() || !attrs.keydata) return null;
  try {
    return await checkPublicKey({ binary: new Uint8Array(Buffer.from(attrs.keydata.replace(/\s+/g, ''), 'base64')) }, from);
  } catch {
    return null;
  }
}

const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';
export function wkdHash(localpart: string): string {
  const bytes = createHash('sha1').update(localpart.toLowerCase()).digest();
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ZBASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ZBASE32[(buffer << (5 - bits)) & 31];
  return out;
}

export type WkdFetch = (url: string) => Promise<{ status: number; body: Uint8Array }>;

const defaultWkdFetch: WkdFetch = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
  return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
};

/** Schlüssel einer Adresse im Web Key Directory ihrer Domain suchen (erst advanced, dann direct method) */
export async function wkdLookup(address: string, wkdFetch: WkdFetch = defaultWkdFetch): Promise<{ armored: string; fingerprint: string } | null> {
  const [local, domain] = address.toLowerCase().split('@') as [string, string];
  if (!local || !domain || !/^[a-z0-9.-]+$/.test(domain)) return null;
  const hu = wkdHash(local);
  const query = `?l=${encodeURIComponent(local)}`;
  const urls = [`https://openpgpkey.${domain}/.well-known/openpgpkey/${domain}/hu/${hu}${query}`, `https://${domain}/.well-known/openpgpkey/hu/${hu}${query}`];
  for (const url of urls) {
    try {
      const res = await wkdFetch(url);
      if (res.status !== 200 || !res.body.length) continue;
      return await checkPublicKey({ binary: res.body }, address);
    } catch {
      /* nächste Methode */
    }
  }
  return null;
}
