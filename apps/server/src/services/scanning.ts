import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import { SMTPServer, type SMTPServerSession } from 'smtp-server';
import {
  DEFAULT_SCAN_SETTINGS,
  extensionOf,
  sanitizeName,
  scanSettingsInputSchema,
  type ScanAssign,
  type ScanItem,
  type ScanSettings,
  type ScanSettingsInput,
  type ScanStatus,
  type Topic,
} from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { DocumentService } from './documents.js';

const SETTINGS_KEY = 'scan:settings';
/** Größte angenommene E-Mail (Base64 macht Anhänge um ein Drittel größer) */
export const MAX_SCAN_MAIL_BYTES = 70 * 1024 * 1024;
const ARCHIVE_BY = 'Scan-Eingang';

interface StoredSettings {
  enabled: boolean;
  archive: boolean;
  folderPath: string;
  allowedHosts: string[];
  username: string;
  password: string;
  retentionDays: number;
}

interface ScanRow {
  id: number;
  storage_name: string;
  filename: string;
  size_bytes: number;
  sender: string;
  subject: string;
  source_ip: string;
  received_at: string;
  incident_id: number | null;
  incident_title: string | null;
  document_id: number | null;
  archived_path: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  message: string;
}

const SELECT = 'SELECT s.*, i.title AS incident_title FROM scans s LEFT JOIN incidents i ON i.id = s.incident_id';

function toItem(r: ScanRow): ScanItem {
  return {
    id: r.id,
    filename: r.filename,
    sizeBytes: r.size_bytes,
    sender: r.sender,
    subject: r.subject,
    sourceIp: r.source_ip,
    receivedAt: r.received_at,
    incidentId: r.incident_id,
    incidentTitle: r.incident_title,
    documentId: r.document_id,
    archivedPath: r.archived_path,
    assignedBy: r.assigned_by,
    assignedAt: r.assigned_at,
    message: r.message,
  };
}

/** „::ffff:192.168.1.5“ → „192.168.1.5“ */
const plainIp = (ip: string) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

const sameSecret = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

/** Fehler mit SMTP-Antwortcode, den das Gerät anzeigt */
const smtpError = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });

const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * Scan-Eingang: Ein kleiner SMTP-Empfänger nimmt „Scan an E-Mail“ von Multifunktionsgeräten an. Jeder PDF-Anhang wird
 * ein Scan im Eingang; läuft ein Einsatz, legt ELVIS ihn zusätzlich in dessen Dokumentverwaltung ab.
 */
export class ScanService {
  readonly dir: string;
  private smtp: SMTPServer | null = null;
  private port: number | null = null;
  private error: string | null = null;

  constructor(
    private readonly store: Store,
    dataDir: string,
    private readonly deps: { documents: DocumentService; notify: (topics: Topic[]) => void },
  ) {
    this.dir = join(dataDir, 'scans');
    if (dataDir !== ':memory:') mkdirSync(this.dir, { recursive: true });
  }

  // --- Einstellungen ---

  private stored(): StoredSettings & { updatedAt: string | null; updatedBy: string | null } {
    const r = this.store.db.prepare('SELECT * FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
    const value = r ? (JSON.parse(r.value) as Partial<StoredSettings>) : {};
    return { ...DEFAULT_SCAN_SETTINGS, password: '', ...value, updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
  }

  settings(): ScanSettings {
    const { password, ...rest } = this.stored();
    return { ...rest, passwordSet: password !== '' };
  }

  setSettings(input: ScanSettingsInput, actor: string): ScanSettings {
    const parsed = scanSettingsInputSchema.parse(input);
    const before = this.stored();
    const password = parsed.username ? (parsed.password ?? before.password) : '';
    if (parsed.username && !password) throw new HttpError(400, 'Passwort fehlt');
    const next: StoredSettings = {
      enabled: parsed.enabled,
      archive: parsed.archive,
      folderPath: parsed.folderPath,
      allowedHosts: [...new Set(parsed.allowedHosts.map(plainIp))],
      username: parsed.username,
      password,
      retentionDays: parsed.retentionDays,
    };
    this.store.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(SETTINGS_KEY, JSON.stringify(next), new Date().toISOString(), actor);
    this.deps.notify(['scans']);
    return this.settings();
  }

  // --- SMTP-Empfänger ---

  /** Empfänger starten; Fehler (z. B. Port belegt) erscheinen im Status, ELVIS läuft weiter */
  async start(port: number | null): Promise<void> {
    if (port === null) return;
    const smtp = new SMTPServer({
      name: 'elvis',
      banner: 'ELVIS Scan-Eingang',
      logger: false,
      disabledCommands: ['STARTTLS'],
      // Anmeldung ohne TLS: Geräte im Fahrzeugnetz sprechen meist kein STARTTLS mit selbst signiertem Zertifikat
      allowInsecureAuth: true,
      authOptional: true,
      authMethods: ['PLAIN', 'LOGIN'],
      size: MAX_SCAN_MAIL_BYTES,
      onConnect: (session, cb) => cb(this.checkHost(session)),
      onAuth: (auth, _session, cb) => {
        const s = this.stored();
        if (s.username && auth.username === s.username && sameSecret(auth.password ?? '', s.password)) return cb(null, { user: auth.username });
        cb(smtpError(535, 'Anmeldung fehlgeschlagen'));
      },
      onMailFrom: (_address, session, cb) => {
        if (this.stored().username && !session.user) return cb(smtpError(530, 'Anmeldung erforderlich'));
        cb();
      },
      onData: (stream, session, cb) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('error', (err) => cb(err));
        stream.on('end', () => {
          if (stream.sizeExceeded) return cb(smtpError(552, 'Scan zu groß'));
          const sender = session.envelope.mailFrom ? session.envelope.mailFrom.address : '';
          this.ingest(Buffer.concat(chunks), { sender, sourceIp: plainIp(session.remoteAddress) }).then(
            (scans) => cb(scans.length ? null : smtpError(554, 'Kein PDF-Anhang gefunden – am Gerät Dateityp PDF wählen')),
            (err: Error) => cb(smtpError(451, `Scan konnte nicht gespeichert werden: ${err.message}`)),
          );
        });
      },
    });
    smtp.on('error', (err) => {
      this.error = err.message;
      this.deps.notify(['scans']);
    });
    await new Promise<void>((resolve) => {
      const onError = (err: Error) => {
        this.error = `Port ${port}: ${err.message}`;
        resolve();
      };
      smtp.server.once('error', onError);
      smtp.listen(port, () => {
        smtp.server.off('error', onError);
        this.smtp = smtp;
        this.port = (smtp.server.address() as AddressInfo).port;
        this.error = null;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const smtp = this.smtp;
    this.smtp = null;
    if (smtp) await new Promise<void>((resolve) => smtp.close(() => resolve()));
  }

  private checkHost(session: SMTPServerSession): Error | null | undefined {
    const s = this.stored();
    if (!s.enabled) return smtpError(421, 'Scan-Eingang ist abgeschaltet');
    const ip = plainIp(session.remoteAddress);
    if (s.allowedHosts.length && !s.allowedHosts.includes(ip)) return smtpError(554, `Absender ${ip} nicht zugelassen`);
    return null;
  }

  status(): ScanStatus {
    const s = this.stored();
    const last = this.store.db.prepare('SELECT MAX(received_at) AS at FROM scans').get() as { at: string | null };
    const incident = this.store.activeIncident();
    return {
      listening: this.smtp !== null,
      enabled: s.enabled,
      port: this.port,
      error: this.error,
      lastReceivedAt: last.at,
      archive: { enabled: s.archive, incident: incident ? { id: incident.id, title: incident.title } : null, path: s.folderPath },
    };
  }

  // --- Scans ---

  /** E-Mail auswerten: jeder PDF-Anhang wird ein Scan */
  async ingest(raw: Buffer, meta: { sender: string; sourceIp: string }): Promise<ScanItem[]> {
    const mail = await simpleParser(raw);
    const now = new Date();
    const subject = (mail.subject ?? '').trim().slice(0, 300);
    const sender = meta.sender || mail.from?.value[0]?.address || '';
    const pdfs = mail.attachments.filter((a) => a.content.subarray(0, 1024).indexOf('%PDF-') >= 0);
    const skipped = mail.attachments.length - pdfs.length;
    const settings = this.stored();
    const incident = settings.archive ? this.store.activeIncident() : null;
    const out: ScanItem[] = [];

    for (const [i, a] of pdfs.entries()) {
      const fallback = `Scan ${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}${p2(now.getMinutes())}${pdfs.length > 1 ? ` (${i + 1})` : ''}`;
      let filename = sanitizeName(a.filename ?? '') || fallback;
      if (extensionOf(filename) !== 'pdf') filename = `${filename}.pdf`;
      const storageName = randomUUID();
      await writeFile(join(this.dir, storageName), a.content);
      const id = Number(
        this.store.db
          .prepare('INSERT INTO scans (storage_name, filename, size_bytes, sender, subject, source_ip, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(storageName, filename, a.content.length, sender.slice(0, 200), subject, meta.sourceIp, now.toISOString()).lastInsertRowid,
      );
      if (incident) await this.archive(id, incident.id, settings.folderPath, a.content, ARCHIVE_BY, false);
      out.push(this.item(id));
    }

    this.store.addAudit({
      operator: sender || meta.sourceIp,
      target: 'scan',
      action: 'empfang',
      params: JSON.stringify({ von: meta.sourceIp, betreff: subject }),
      success: out.length > 0,
      message: [
        out.length ? out.map((s) => (s.archivedPath ? `${s.filename} → ${s.archivedPath}` : s.filename)).join(', ') : 'Kein PDF-Anhang',
        skipped > 0 && `${skipped} andere Anhänge ignoriert`,
      ]
        .filter(Boolean)
        .join('; '),
    });
    this.deps.notify(['scans', 'audit']);
    return out;
  }

  /** In der Dokumentverwaltung ablegen; schlägt das fehl, bleibt der Scan im Eingang (Hinweis) – außer `strict` */
  private async archive(id: number, incidentId: number, folderPath: string, content: Buffer, by: string, strict: boolean): Promise<void> {
    const r = this.row(id);
    try {
      const stored = await this.deps.documents.storeFile(
        incidentId,
        folderPath,
        { filename: r.filename, mimeType: 'application/pdf', content, description: r.subject ? `Scan: ${r.subject}` : 'Scan' },
        { id: null, name: by },
      );
      this.store.db
        .prepare("UPDATE scans SET incident_id = ?, document_id = ?, archived_path = ?, assigned_by = ?, assigned_at = ?, message = '' WHERE id = ?")
        .run(incidentId, stored.documentId, stored.path, by, new Date().toISOString(), id);
    } catch (err) {
      if (strict) throw err;
      this.store.db.prepare('UPDATE scans SET message = ? WHERE id = ?').run(`Ablage fehlgeschlagen: ${(err as Error).message}`, id);
    }
  }

  private row(id: number): ScanRow {
    const r = this.store.db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as ScanRow | undefined;
    if (!r) throw new HttpError(404, `Scan ${id} nicht gefunden`);
    return r;
  }

  item(id: number): ScanItem {
    return toItem(this.row(id));
  }

  list(limit = 200): ScanItem[] {
    return (this.store.db.prepare(`${SELECT} ORDER BY s.received_at DESC, s.id DESC LIMIT ?`).all(limit) as ScanRow[]).map(toItem);
  }

  async file(id: number): Promise<{ filename: string; content: Buffer }> {
    const r = this.row(id);
    return { filename: r.filename, content: await readFile(join(this.dir, r.storage_name)) };
  }

  /** Nachträglich einem (offenen) Einsatz zuordnen */
  async assign(id: number, input: ScanAssign, actor: string): Promise<ScanItem> {
    const r = this.row(id);
    if (r.incident_id === input.incidentId && r.document_id !== null) throw new HttpError(409, `Scan ist in diesem Einsatz schon abgelegt (${r.archived_path})`);
    const { content } = await this.file(id);
    await this.archive(id, input.incidentId, input.folderPath ?? this.stored().folderPath, content, actor, true);
    this.deps.notify(['scans']);
    return this.item(id);
  }

  /** Aus dem Eingang löschen; eine Ablage im Einsatz bleibt erhalten */
  async remove(id: number, actor: string): Promise<void> {
    const r = this.row(id);
    this.store.db.prepare('DELETE FROM scans WHERE id = ?').run(id);
    await unlink(join(this.dir, r.storage_name)).catch(() => {});
    this.store.addAudit({ operator: actor, target: 'scan', action: 'loeschen', params: '', success: true, message: r.filename });
    this.deps.notify(['scans', 'audit']);
  }

  /** Scans älter als die Aufbewahrungsfrist entfernen (beim Start und stündlich) */
  async cleanup(now = Date.now()): Promise<number> {
    const before = new Date(now - this.stored().retentionDays * 24 * 3600_000).toISOString();
    const stale = this.store.db.prepare('SELECT id, storage_name FROM scans WHERE received_at < ?').all(before) as { id: number; storage_name: string }[];
    for (const s of stale) {
      this.store.db.prepare('DELETE FROM scans WHERE id = ?').run(s.id);
      await unlink(join(this.dir, s.storage_name)).catch(() => {});
    }
    if (stale.length) this.deps.notify(['scans']);
    return stale.length;
  }
}
