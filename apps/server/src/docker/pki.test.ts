import { mkdtempSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DockerPki } from './pki.js';
import { renderSetupScript } from './setup-script.js';

let dir: string;
let pki: DockerPki;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'elvis-pki-'));
  pki = new DockerPki(dir);
  pki.init();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Baut eine mTLS-Verbindung wie zwischen ELVIS und dockerd --tlsverify auf. */
function handshake(server: { certPem: string; keyPem: string }, client: { certPem: string; keyPem: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = tls.createServer({ cert: server.certPem, key: server.keyPem, ca: pki.caPem, requestCert: true, rejectUnauthorized: true }, (s) => {
      s.end('ok');
    });
    srv.on('tlsClientError', () => undefined);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      const sock = tls.connect({ host: '127.0.0.1', port, ca: pki.caPem, cert: client.certPem, key: client.keyPem });
      let ok = false;
      sock.on('data', () => (ok = true));
      sock.on('error', () => undefined);
      sock.on('close', () => srv.close(() => resolve(ok && sock.authorized)));
    });
  });
}

describe('Docker-PKI', () => {
  it('legt CA und Client-Zertifikat an und lädt sie beim nächsten Start wieder', () => {
    const again = new DockerPki(dir);
    again.init();
    expect(again.caPem).toBe(pki.caPem);
    expect(again.clientBundle.certPem).toBe(pki.clientBundle.certPem);
    expect(statSync(join(dir, 'ca-key.pem')).mode & 0o777).toBe(0o600);
  });

  it('stellt Server-Zertifikate mit IP und Name als SAN aus, signiert von der CA', () => {
    const b = pki.issueServerCert('server2', ['10.0.0.2', 'server2']);
    const cert = forge.pki.certificateFromPem(b.certPem);
    const ca = forge.pki.certificateFromPem(pki.caPem);
    expect(ca.verify(cert)).toBe(true);
    const san = cert.getExtension('subjectAltName') as { altNames: { type: number; ip?: string; value?: string }[] };
    expect(san.altNames).toEqual(expect.arrayContaining([expect.objectContaining({ ip: '10.0.0.2' }), expect.objectContaining({ value: 'server2' })]));
    expect((cert.getExtension('extKeyUsage') as { serverAuth: boolean }).serverAuth).toBe(true);
    expect(b.expiresAt.getTime()).toBeGreaterThan(Date.now() + 2 * 365 * 86_400_000);
  });

  it('erlaubt mTLS mit dem ELVIS-Client-Zertifikat', async () => {
    expect(await handshake(pki.issueServerCert('localhost', ['127.0.0.1']), pki.clientBundle)).toBe(true);
  });

  it('weist ein Client-Zertifikat einer fremden CA ab', async () => {
    const foreignDir = mkdtempSync(join(tmpdir(), 'elvis-pki-foreign-'));
    const foreign = new DockerPki(foreignDir);
    foreign.init();
    expect(await handshake(pki.issueServerCert('localhost', ['127.0.0.1']), foreign.clientBundle)).toBe(false);
    rmSync(foreignDir, { recursive: true, force: true });
  });
});

describe('Setup-Skript', () => {
  it('enthält Zertifikate, TLS-Optionen und die Rückmeldung', () => {
    const b = pki.issueServerCert('server2', ['10.0.0.2']);
    const script = renderSetupScript({ caPem: pki.caPem, certPem: b.certPem, keyPem: b.keyPem, port: 2376, callbackUrl: 'http://elvis:8080/api/docker/setup/abc/done', hostName: 'server2' });
    expect(script.startsWith('#!/bin/sh')).toBe(true);
    expect(script).toContain('-H tcp://0.0.0.0:$PORT --tlsverify');
    expect(script).toContain(b.certPem.trim());
    expect(script).toContain("CALLBACK='http://elvis:8080/api/docker/setup/abc/done'");
  });
});
