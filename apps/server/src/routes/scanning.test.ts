import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentListing, Incident, JournalEntry, ScanInbox, ScanItem, ScanSettings, ScanSettingsInput } from '@elvis/shared';
import { buildApp, type App } from '../app.js';
import { parseConfig } from '../config.js';
import { adminCookie } from '../test-helpers.js';

let app: App;
let dataDir: string;
let admin = '';
let port = 0;

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/** MIME-Mail wie vom Scanner: Text plus Anhänge */
function mail(attachments: { name: string; type: string; content: Buffer }[], subject = 'Scan vom HP'): string {
  const b = 'ELVIS-BOUNDARY';
  const parts = [
    `--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGescannt.\r\n`,
    ...attachments.map(
      (a) =>
        `--${b}\r\nContent-Type: ${a.type}; name="${a.name}"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.name}"\r\n\r\n${a.content.toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n`,
    ),
  ];
  return `From: scanner@hp.local\r\nTo: scan@elvis\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n${parts.join('')}--${b}--\r\n`;
}

/** Minimaler SMTP-Client; liefert den Code der letzten Antwort (beim ersten Fehler wird abgebrochen) */
async function send(body: string, opts: { auth?: [string, string] } = {}): Promise<{ code: number; text: string }> {
  const socket: Socket = connect(port, '127.0.0.1');
  let buffer = '';
  const waiting: ((r: { code: number; text: string }) => void)[] = [];
  const replies: { code: number; text: string }[] = [];
  socket.setEncoding('utf8');
  socket.on('data', (d: string) => {
    buffer += d;
    // Mehrzeilige Antworten („250-…“) enden mit „250 …“
    let m: RegExpExecArray | null;
    while ((m = /^(?:\d{3}-.*\r\n)*(\d{3}) (.*)\r\n/.exec(buffer))) {
      buffer = buffer.slice(m[0].length);
      const r = { code: Number(m[1]), text: m[0] };
      const w = waiting.shift();
      if (w) w(r);
      else replies.push(r);
    }
  });
  const reply = () => new Promise<{ code: number; text: string }>((resolve) => (replies.length ? resolve(replies.shift()!) : waiting.push(resolve)));
  const cmd = async (line: string) => (socket.write(`${line}\r\n`), reply());
  try {
    let r = await reply();
    if (r.code !== 220) return r;
    r = await cmd('EHLO hp-mfp');
    if (opts.auth) {
      r = await cmd(`AUTH PLAIN ${Buffer.from(`\0${opts.auth[0]}\0${opts.auth[1]}`).toString('base64')}`);
      if (r.code !== 235) return r;
    }
    for (const line of ['MAIL FROM:<scanner@hp.local>', 'RCPT TO:<scan@elvis>', 'DATA']) {
      r = await cmd(line);
      if (r.code >= 400) return r;
    }
    return await cmd(`${body.replace(/^\./gm, '..')}\r\n.`);
  } finally {
    socket.end();
  }
}

const inject = async <T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, cookie = admin) => {
  const res = await app.server.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined && { payload: payload as object }) });
  return { status: res.statusCode, body: (String(res.headers['content-type'] ?? '').includes('json') ? res.json() : null) as T, raw: res };
};

const settings = (patch: Partial<ScanSettingsInput>) =>
  inject<ScanSettings>('PUT', '/api/system/scanning', { enabled: true, archive: true, folderPath: 'Scans/{{datum.iso}}', allowedHosts: [], username: '', retentionDays: 14, ...patch });

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'elvis-scan-'));
  app = await buildApp(parseConfig({ dataDir }), { logger: false });
  admin = await adminCookie(app);
  await app.scanning.start(0);
  port = app.scanning.status().port!;
});

afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Scan-Eingang', () => {
  it('nimmt PDFs per SMTP an und legt sie ohne Einsatz nur im Eingang ab', async () => {
    const r = await send(mail([{ name: 'Scan_0001.pdf', type: 'application/pdf', content: PDF }]));
    expect(r.code).toBe(250);
    const { body } = await inject<ScanInbox>('GET', '/api/scans');
    expect(body.status).toMatchObject({ listening: true, enabled: true, port });
    expect(body.scans).toHaveLength(1);
    expect(body.scans[0]).toMatchObject({ filename: 'Scan_0001.pdf', sender: 'scanner@hp.local', subject: 'Scan vom HP', sourceIp: '127.0.0.1', incidentId: null, documentId: null });
    const file = await inject('GET', `/api/scans/${body.scans[0]!.id}/file`);
    expect(file.raw.headers['content-type']).toBe('application/pdf');
    expect(file.raw.rawPayload.equals(PDF)).toBe(true);
  });

  it('legt Scans im laufenden Einsatz ab', async () => {
    const incident = (await inject<Incident>('POST', '/api/incidents', { title: 'Brand', keyword: 'B3' })).body;
    expect((await send(mail([{ name: 'a.pdf', type: 'application/pdf', content: PDF }, { name: 'b.pdf', type: 'application/octet-stream', content: PDF }]))).code).toBe(250);
    const scans = (await inject<ScanInbox>('GET', '/api/scans')).body.scans;
    expect(scans).toHaveLength(2);
    expect(scans.every((s) => s.incidentId === incident.id && s.incidentTitle === 'Brand')).toBe(true);
    expect(scans.map((s) => s.archivedPath).sort()).toEqual([`Scans/${today()}/a.pdf`, `Scans/${today()}/b.pdf`]);
    const listing = (await inject<DocumentListing>('GET', `/api/incidents/${incident.id}/documents`)).body;
    expect(listing.documents.map((d) => d.filename).sort()).toEqual(['a.pdf', 'b.pdf']);
    expect(listing.documents[0]).toMatchObject({ uploadedBy: 'Eingang', mimeType: 'application/pdf', description: 'Scan: Scan vom HP' });
    const journal = (await inject<JournalEntry[]>('GET', `/api/incidents/${incident.id}/journal`)).body;
    expect(journal.some((j) => j.text.includes(`Scans/${today()}/a.pdf`))).toBe(true);
  });

  it('ordnet Scans nachträglich einem Einsatz zu', async () => {
    await send(mail([{ name: 'Lageplan.pdf', type: 'application/pdf', content: PDF }]));
    const scan = (await inject<ScanInbox>('GET', '/api/scans')).body.scans[0]!;
    const incident = (await inject<Incident>('POST', '/api/incidents', { title: 'THL' })).body;
    const res = await inject<ScanItem>('POST', `/api/scans/${scan.id}/assign`, { incidentId: incident.id, folderPath: 'Pläne' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ incidentId: incident.id, archivedPath: 'Pläne/Lageplan.pdf', assignedBy: 'Max Müller' });
    expect((await inject('POST', `/api/scans/${scan.id}/assign`, { incidentId: incident.id })).status).toBe(409);
    // Löschen aus dem Eingang lässt das Dokument im Einsatz
    expect((await inject('DELETE', `/api/scans/${scan.id}`)).status).toBe(204);
    expect((await inject<ScanInbox>('GET', '/api/scans')).body.scans).toHaveLength(0);
    expect((await inject<DocumentListing>('GET', `/api/incidents/${incident.id}/documents`)).body.documents).toHaveLength(1);
  });

  it('lehnt Mails ohne PDF ab', async () => {
    const r = await send(mail([{ name: 'scan.jpg', type: 'image/jpeg', content: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) }]));
    expect(r.code).toBe(554);
    expect(r.text).toContain('Kein PDF');
    expect((await inject<ScanInbox>('GET', '/api/scans')).body.scans).toHaveLength(0);
  });

  it('prüft Absenderadresse, Anmeldung und Abschaltung', async () => {
    await settings({ allowedHosts: ['10.9.9.9'] });
    expect((await send(mail([{ name: 'a.pdf', type: 'application/pdf', content: PDF }]))).code).toBe(554);

    await settings({ allowedHosts: ['127.0.0.1'], username: 'hp', password: 'geheim' });
    const s = (await inject<ScanSettings>('GET', '/api/system/scanning')).body;
    expect(s).toMatchObject({ username: 'hp', passwordSet: true });
    expect(s).not.toHaveProperty('password');
    expect((await send(mail([{ name: 'a.pdf', type: 'application/pdf', content: PDF }]))).code).toBe(530);
    expect((await send(mail([{ name: 'a.pdf', type: 'application/pdf', content: PDF }]), { auth: ['hp', 'falsch'] })).code).toBe(535);
    expect((await send(mail([{ name: 'a.pdf', type: 'application/pdf', content: PDF }]), { auth: ['hp', 'geheim'] })).code).toBe(250);

    // Passwort bleibt beim Speichern ohne Passwortfeld erhalten
    await settings({ allowedHosts: [], username: 'hp', enabled: false });
    expect((await inject<ScanSettings>('GET', '/api/system/scanning')).body.passwordSet).toBe(true);
    expect((await send(mail([{ name: 'a.pdf', type: 'application/pdf', content: PDF }]))).code).toBe(421);
  });

  it('räumt alte Scans auf', async () => {
    await send(mail([{ name: 'a.pdf', type: 'application/pdf', content: PDF }]));
    expect(await app.scanning.cleanup(Date.now() + 13 * 24 * 3600_000)).toBe(0);
    expect(await app.scanning.cleanup(Date.now() + 15 * 24 * 3600_000)).toBe(1);
    expect((await inject<ScanInbox>('GET', '/api/scans')).body.scans).toHaveLength(0);
  });

  it('verlangt Anmeldung, Einstellungen nur für Admins', async () => {
    expect((await inject('GET', '/api/scans', undefined, '')).status).toBe(401);
    expect((await inject('GET', '/api/system/scanning', undefined, '')).status).toBe(401);
    expect((await settings({ folderPath: '{{gibt.esnicht}}' })).status).toBe(400);
  });
});
