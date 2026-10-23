import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import forge from 'node-forge';

export interface CertBundle {
  certPem: string;
  keyPem: string;
  expiresAt: Date;
}

const YEAR_MS = 365 * 86_400_000;

function newKeyPair(): { publicKey: forge.pki.PublicKey; privateKey: forge.pki.rsa.PrivateKey; keyPem: string } {
  // Schlüssel nativ erzeugen (schnell), Zertifikate mit node-forge bauen.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const priv = forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey;
  const pub = forge.pki.setRsaPublicKey(priv.n, priv.e);
  return { publicKey: pub, privateKey: priv, keyPem: privateKey };
}

function baseCert(publicKey: forge.pki.PublicKey, cn: string, validMs: number): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = '01' + randomBytes(15).toString('hex'); // positiv, 16 Byte
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 5 * 60_000); // Uhrabweichung tolerieren
  cert.validity.notAfter = new Date(now.getTime() + validMs);
  cert.setSubject([{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'ELVIS' }]);
  return cert;
}

/**
 * Kleine CA für die Docker-TLS-Verbindungen: ELVIS stellt die Server-Zertifikate der Hosts und
 * sein eigenes Client-Zertifikat aus. dockerd prüft mit --tlsverify das Client-Zertifikat gegen diese CA.
 */
export class DockerPki {
  private ca!: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey; certPem: string };
  private client!: CertBundle;

  constructor(private readonly dir: string) {}

  /** Lädt CA und Client-Zertifikat oder legt sie beim ersten Start an. */
  init(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const caCert = join(this.dir, 'ca.pem');
    const caKey = join(this.dir, 'ca-key.pem');
    if (!existsSync(caCert) || !existsSync(caKey)) {
      const kp = newKeyPair();
      const cert = baseCert(kp.publicKey, 'ELVIS Docker CA', 10 * YEAR_MS);
      cert.setIssuer(cert.subject.attributes);
      cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' },
      ]);
      cert.sign(kp.privateKey, forge.md.sha256.create());
      this.write(caCert, forge.pki.certificateToPem(cert));
      this.write(caKey, kp.keyPem, true);
    }
    const certPem = readFileSync(caCert, 'utf8');
    this.ca = { cert: forge.pki.certificateFromPem(certPem), key: forge.pki.privateKeyFromPem(readFileSync(caKey, 'utf8')) as forge.pki.rsa.PrivateKey, certPem };

    const clientCert = join(this.dir, 'client.pem');
    const clientKey = join(this.dir, 'client-key.pem');
    if (!existsSync(clientCert) || !existsSync(clientKey)) {
      const b = this.issue('elvis', 5 * YEAR_MS, 'client', []);
      this.write(clientCert, b.certPem);
      this.write(clientKey, b.keyPem, true);
    }
    const cPem = readFileSync(clientCert, 'utf8');
    this.client = { certPem: cPem, keyPem: readFileSync(clientKey, 'utf8'), expiresAt: forge.pki.certificateFromPem(cPem).validity.notAfter };
  }

  get caPem(): string {
    return this.ca.certPem;
  }

  get clientBundle(): CertBundle {
    return this.client;
  }

  /** Server-Zertifikat für einen Docker-Host; IP-Adressen und Namen landen als SAN im Zertifikat. */
  issueServerCert(name: string, addresses: string[]): CertBundle {
    return this.issue(name, 3 * YEAR_MS, 'server', addresses);
  }

  private issue(cn: string, validMs: number, usage: 'server' | 'client', addresses: string[]): CertBundle {
    const kp = newKeyPair();
    const cert = baseCert(kp.publicKey, cn, validMs);
    cert.setIssuer(this.ca.cert.subject.attributes);
    const altNames = [...new Set(addresses)].map((a) => (isIP(a) ? { type: 7, ip: a } : { type: 2, value: a }));
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: usage === 'server', clientAuth: usage === 'client' },
      ...(altNames.length ? [{ name: 'subjectAltName', altNames }] : []),
    ]);
    cert.sign(this.ca.key, forge.md.sha256.create());
    return { certPem: forge.pki.certificateToPem(cert), keyPem: kp.keyPem, expiresAt: cert.validity.notAfter };
  }

  private write(path: string, content: string, secret = false): void {
    writeFileSync(path, content, { mode: secret ? 0o600 : 0o644 });
    if (secret) chmodSync(path, 0o600);
  }
}
