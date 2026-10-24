import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_PRINT_SETTINGS,
  GUEST_PRINT_RETENTION_HOURS,
  PRINT_JOB_DONE,
  extensionOf,
  parsePageRanges,
  printSettingsInputSchema,
  sanitizeName,
  sortMedia,
  type GuestPrintJob,
  type PrintJob,
  type PrintJobState,
  type PrintOptions,
  type PrintSettings,
  type PrintSettingsInput,
  type PrintStatus,
  type PrinterInfo,
  type Topic,
} from '@elvis/shared';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { DocumentService } from './documents.js';
import { OP, TAG, attr, decodeResponse, encodeRequest, ippOk, ippStatusText, type IppAttribute, type IppGroup, type IppResponse } from './ipp.js';

/** Druckserver eines Addons (provides.printServers) */
export interface PrintServerProvision {
  id: string;
  name: string;
  /** http://host:port des CUPS-Servers */
  url: string;
}

/** Gastdrucker eines Addons (provides.guestPrinters): schickt Aufträge aus dem Gastnetz mit diesem Token */
export interface GuestPrinterProvision {
  id: string;
  name: string;
  token: string;
}

/** Auftrag vom Gastdrucker; die Angaben stammen vom Gerät des Gastes */
export interface GuestSubmission {
  jobName: string;
  user: string;
  copies: number;
  sourceIp: string;
}

/** IPP-Anfrage per HTTP-POST; liefert den Antwortkörper */
export type IppTransport = (url: string, body: Buffer, timeoutMs: number) => Promise<Buffer>;

const defaultTransport: IppTransport = async (url, body, timeoutMs) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/ipp' }, body: new Uint8Array(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

const SETTINGS_KEY = 'print:settings';
const PRINTERS_TTL_MS = 3000;
const QUERY_TIMEOUT_MS = 5000;
const PRINT_TIMEOUT_MS = 120_000;

const PRINTER_ATTRIBUTES = [
  'printer-name',
  'printer-info',
  'printer-location',
  'printer-state',
  'printer-state-message',
  'printer-is-accepting-jobs',
  'color-supported',
  'sides-supported',
  'media-supported',
  'media-default',
  'number-up-supported',
  'print-color-mode-supported',
  'print-scaling-supported',
];

const JOB_STATES: Record<number, PrintJobState> = { 3: 'pending', 4: 'held', 5: 'processing', 6: 'stopped', 7: 'canceled', 8: 'aborted', 9: 'completed' };

interface ServerPrinter extends PrinterInfo {
  colorModes: string[];
  scaling: string[];
}

interface JobRow {
  ref: string;
  server_id: string;
  printer: string;
  printer_name: string;
  ipp_job_id: number | null;
  filename: string;
  copies: number;
  options: string;
  state: PrintJobState;
  state_message: string;
  submitted_by: string;
  user_id: number | null;
  document_id: number | null;
  archived_path: string | null;
  created_at: string;
}

interface GuestRow {
  id: number;
  storage_name: string;
  filename: string;
  size_bytes: number;
  copies: number;
  submitted_by: string;
  source_ip: string;
  received_at: string;
}

const toGuestJob = (r: GuestRow): GuestPrintJob => ({
  id: r.id,
  filename: r.filename,
  sizeBytes: r.size_bytes,
  copies: r.copies,
  submittedBy: r.submitted_by,
  sourceIp: r.source_ip,
  receivedAt: r.received_at,
});

const sameSecret = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const isPdf = (content: Buffer) => content.subarray(0, 1024).indexOf('%PDF-') >= 0;

const str = (g: IppGroup, k: string) => (g[k]?.[0] !== undefined ? String(g[k]![0]) : '');
const strings = (g: IppGroup, k: string) => (g[k] ?? []).map(String);

/** http://host:631 → ipp://host:631 (CUPS erwartet das ipp-Schema in printer-uri) */
const ippUri = (url: string, path: string) => `${url.replace(/\/$/, '').replace(/^http(s?):/, 'ipp$1:')}${path}`;

function toJob(r: JobRow): PrintJob {
  return {
    ref: r.ref,
    printerId: `${r.server_id}/${r.printer}`,
    printerName: r.printer_name,
    filename: r.filename,
    copies: r.copies,
    state: r.state,
    stateMessage: r.state_message,
    submittedBy: r.submitted_by,
    createdAt: r.created_at,
    archivedPath: r.archived_path,
    documentId: r.document_id,
  };
}

/**
 * Druckaufträge über die Druckserver-Addons (CUPS per IPP). ELVIS prüft die Einstellungen gegen die Fähigkeiten des
 * Druckers, reicht das PDF weiter, merkt sich den Auftrag und legt den Druck auf Wunsch im laufenden Einsatz ab.
 */
export class PrintService {
  private servers: PrintServerProvision[] = [];
  private guests: GuestPrinterProvision[] = [];
  private cache = new Map<string, { at: number; printers: ServerPrinter[]; error: string | null }>();
  /** Ablage der Gastaufträge, die auf Freigabe warten */
  readonly guestDir: string;

  constructor(
    private readonly store: Store,
    dataDir: string,
    private readonly deps: {
      documents: DocumentService;
      notify: (topics: Topic[]) => void;
      transport?: IppTransport;
      /** Läuft das Gast-WLAN gerade? */
      guestWifiActive?: () => boolean;
    },
  ) {
    this.guestDir = join(dataDir, 'guest-print');
    if (dataDir !== ':memory:') mkdirSync(this.guestDir, { recursive: true });
  }

  private get transport(): IppTransport {
    return this.deps.transport ?? defaultTransport;
  }

  /** Laufende Addons melden ihre Druckserver und Gastdrucker */
  setProvisions(list: PrintServerProvision[], guests: GuestPrinterProvision[] = []): void {
    if (JSON.stringify([list, guests]) === JSON.stringify([this.servers, this.guests])) return;
    this.servers = list;
    this.guests = guests;
    this.cache.clear();
    this.deps.notify(['printing']);
  }

  private async call(server: PrintServerProvision, path: string, req: Parameters<typeof encodeRequest>[0], timeoutMs = QUERY_TIMEOUT_MS): Promise<IppResponse> {
    const body = await this.transport(`${server.url.replace(/\/$/, '')}${path}`, encodeRequest(req), timeoutMs);
    return decodeResponse(body);
  }

  // --- Einstellungen ---

  settings(): PrintSettings {
    const r = this.store.db.prepare('SELECT * FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
    const parsed = r ? printSettingsInputSchema.safeParse(JSON.parse(r.value)) : null;
    return { ...(parsed?.success ? parsed.data : DEFAULT_PRINT_SETTINGS), updatedAt: r?.updated_at ?? null, updatedBy: r?.updated_by ?? null };
  }

  setSettings(input: PrintSettingsInput, actor: string): PrintSettings {
    this.store.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(SETTINGS_KEY, JSON.stringify(printSettingsInputSchema.parse(input)), new Date().toISOString(), actor);
    this.deps.notify(['printing']);
    return this.settings();
  }

  // --- Drucker ---

  private async serverPrinters(server: PrintServerProvision, fresh = false): Promise<{ printers: ServerPrinter[]; error: string | null }> {
    const hit = this.cache.get(server.id);
    if (hit && !fresh && Date.now() - hit.at < PRINTERS_TTL_MS) return hit;
    let entry: { at: number; printers: ServerPrinter[]; error: string | null };
    try {
      const res = await this.call(server, '/', {
        operation: OP.cupsGetPrinters,
        operationAttributes: [attr(TAG.keyword, 'requested-attributes', ...PRINTER_ATTRIBUTES)],
      });
      // „not-found“ = keine Drucker eingerichtet
      if (!ippOk(res.status) && res.status !== 0x0406) throw new Error(ippStatusText(res.status, res.operation['status-message']));
      const printers = res.printers.filter((g) => str(g, 'printer-name')).map((g) => this.toPrinter(server, g));
      entry = { at: Date.now(), printers: printers.sort((a, b) => a.info.localeCompare(b.info, 'de')), error: null };
    } catch (err) {
      entry = { at: Date.now(), printers: [], error: `${server.name}: nicht erreichbar (${(err as Error).message})` };
    }
    this.cache.set(server.id, entry);
    return entry;
  }

  private toPrinter(server: PrintServerProvision, g: IppGroup): ServerPrinter {
    const name = str(g, 'printer-name');
    const state = Number(g['printer-state']?.[0]);
    const colorModes = strings(g, 'print-color-mode-supported');
    return {
      id: `${server.id}/${name}`,
      serverName: server.name,
      name,
      info: str(g, 'printer-info') || name,
      location: str(g, 'printer-location'),
      state: state === 4 ? 'processing' : state === 5 ? 'stopped' : 'idle',
      accepting: g['printer-is-accepting-jobs']?.[0] !== false,
      stateMessage: str(g, 'printer-state-message'),
      color: g['color-supported']?.[0] === true || colorModes.includes('color'),
      duplex: strings(g, 'sides-supported').some((s) => s.startsWith('two-sided')),
      media: sortMedia(strings(g, 'media-supported')),
      mediaDefault: str(g, 'media-default') || null,
      numberUp: (g['number-up-supported'] ?? []).filter((v): v is number => typeof v === 'number'),
      colorModes,
      scaling: strings(g, 'print-scaling-supported'),
    };
  }

  private async allPrinters(fresh = false): Promise<{ printers: ServerPrinter[]; errors: string[] }> {
    const results = await Promise.all(this.servers.map((s) => this.serverPrinters(s, fresh)));
    return { printers: results.flatMap((r) => r.printers), errors: results.flatMap((r) => (r.error ? [r.error] : [])) };
  }

  async status(): Promise<PrintStatus> {
    const { printers, errors } = await this.allPrinters();
    const settings = this.settings();
    const incident = this.store.activeIncident();
    return {
      available: this.servers.length > 0,
      printers: printers.map(({ colorModes: _c, scaling: _s, ...p }) => p),
      errors,
      defaultPrinter: settings.defaultPrinter && printers.some((p) => p.id === settings.defaultPrinter) ? settings.defaultPrinter : null,
      archive: { enabled: settings.archive, incident: incident ? { id: incident.id, title: incident.title } : null, path: settings.folderPath },
      guest: { available: this.guests.length > 0, mode: settings.guest.mode, waiting: this.guestCount() },
    };
  }

  // --- Druckaufträge ---

  /** Job-Attribute aus den Druckeinstellungen; nur, was der Drucker kennt */
  private jobAttributes(p: ServerPrinter, o: PrintOptions): IppAttribute[] {
    const out: IppAttribute[] = [attr(TAG.integer, 'copies', o.copies)];
    if (o.sides !== 'one-sided' && !p.duplex) throw new HttpError(400, `${p.info} kann nicht beidseitig drucken`);
    out.push(attr(TAG.keyword, 'sides', o.sides));
    if (o.color === 'color' && !p.color) throw new HttpError(400, `${p.info} druckt nur schwarzweiß`);
    if (p.colorModes.includes(o.color)) out.push(attr(TAG.keyword, 'print-color-mode', o.color));
    if (o.media) {
      if (p.media.length && !p.media.includes(o.media)) throw new HttpError(400, `Papierformat wird von ${p.info} nicht unterstützt`);
      out.push(attr(TAG.keyword, 'media', o.media));
    }
    if (o.orientation !== 'auto') out.push(attr(TAG.enum, 'orientation-requested', o.orientation === 'portrait' ? 3 : 4));
    const ranges = parsePageRanges(o.pageRanges);
    if (ranges === null) throw new HttpError(400, 'Ungültiger Seitenbereich');
    if (ranges.length) out.push(attr(TAG.rangeOfInteger, 'page-ranges', ...ranges));
    if (o.numberUp !== 1) {
      if (p.numberUp.length && !p.numberUp.includes(o.numberUp)) throw new HttpError(400, `${o.numberUp} Seiten je Blatt werden nicht unterstützt`);
      out.push(attr(TAG.integer, 'number-up', o.numberUp));
    }
    // CUPS ab 2.3 kennt print-scaling, ältere Filter die Option fit-to-page
    if (p.scaling.length) out.push(attr(TAG.keyword, 'print-scaling', o.fitToPage ? 'fit' : 'none'));
    else if (o.fitToPage) out.push(attr(TAG.boolean, 'fit-to-page', true));
    return out;
  }

  async print(file: { filename: string; content: Buffer }, o: PrintOptions, by: { userId: number | null; name: string }): Promise<PrintJob> {
    if (!isPdf(file.content)) throw new HttpError(415, 'Nur PDF-Dateien können gedruckt werden');
    const slash = o.printerId.indexOf('/');
    const server = this.servers.find((s) => s.id === o.printerId.slice(0, slash));
    if (!server) throw new HttpError(404, 'Drucker nicht gefunden');
    const { printers, error } = await this.serverPrinters(server, true);
    if (error) throw new HttpError(503, error);
    const printer = printers.find((p) => p.id === o.printerId);
    if (!printer) throw new HttpError(404, 'Drucker nicht gefunden');
    if (!printer.accepting) throw new HttpError(409, `${printer.info} nimmt derzeit keine Aufträge an${printer.stateMessage ? ` (${printer.stateMessage})` : ''}`);

    const path = `/printers/${encodeURIComponent(printer.name)}`;
    const res = await this.call(
      server,
      path,
      {
        operation: OP.printJob,
        operationAttributes: [
          attr(TAG.uri, 'printer-uri', ippUri(server.url, path)),
          attr(TAG.name, 'requesting-user-name', by.name.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 60) || 'ELVIS'),
          attr(TAG.name, 'job-name', file.filename.slice(0, 200)),
          attr(TAG.mimeType, 'document-format', 'application/pdf'),
        ],
        jobAttributes: this.jobAttributes(printer, o),
        document: file.content,
      },
      PRINT_TIMEOUT_MS,
    ).catch((err: Error) => {
      throw new HttpError(502, `Druckserver nicht erreichbar: ${err.message}`);
    });
    if (!ippOk(res.status)) throw new HttpError(502, `Druck abgelehnt: ${ippStatusText(res.status, res.operation['status-message'])}`);
    const jobAttrs = res.jobs[0] ?? {};
    const ippJobId = Number(jobAttrs['job-id']?.[0]) || null;

    // Ablage im laufenden Einsatz; ein Fehler dabei macht den Druck nicht ungeschehen
    let archived: { documentId: number; path: string } | null = null;
    let archiveError = '';
    const settings = this.settings();
    const incident = this.store.activeIncident();
    if (settings.archive && incident) {
      try {
        archived = await this.deps.documents.storeFile(
          incident.id,
          settings.folderPath,
          { filename: file.filename, mimeType: 'application/pdf', content: file.content, description: `Gedruckt auf ${printer.info}` },
          { id: by.userId, name: by.name },
        );
      } catch (err) {
        archiveError = `Ablage fehlgeschlagen: ${(err as Error).message}`;
      }
    }

    const row: JobRow = {
      ref: randomBytes(12).toString('base64url'),
      server_id: server.id,
      printer: printer.name,
      printer_name: printer.info,
      ipp_job_id: ippJobId,
      filename: file.filename,
      copies: o.copies,
      options: JSON.stringify(o),
      state: JOB_STATES[Number(jobAttrs['job-state']?.[0])] ?? 'pending',
      state_message: archiveError || str(jobAttrs, 'job-state-message'),
      submitted_by: by.name,
      user_id: by.userId,
      document_id: archived?.documentId ?? null,
      archived_path: archived?.path ?? null,
      created_at: new Date().toISOString(),
    };
    this.store.db
      .prepare(
        `INSERT INTO print_jobs (ref, server_id, printer, printer_name, ipp_job_id, filename, copies, options, state, state_message, submitted_by, user_id, document_id, archived_path, created_at)
         VALUES (@ref, @server_id, @printer, @printer_name, @ipp_job_id, @filename, @copies, @options, @state, @state_message, @submitted_by, @user_id, @document_id, @archived_path, @created_at)`,
      )
      .run(row);
    this.store.addAudit({
      operator: by.name,
      target: 'druck',
      action: 'pdf',
      params: JSON.stringify({ drucker: printer.info, kopien: o.copies, seiten: o.pageRanges || 'alle', beidseitig: o.sides !== 'one-sided' }),
      success: true,
      message: `${file.filename}${archived ? ` → ${archived.path}` : ''}${archiveError ? ` (${archiveError})` : ''}`,
    });
    this.deps.notify(['printing', 'audit']);
    return toJob(row);
  }

  private row(ref: string): JobRow {
    const r = this.store.db.prepare('SELECT * FROM print_jobs WHERE ref = ?').get(ref) as JobRow | undefined;
    if (!r) throw new HttpError(404, 'Druckauftrag nicht gefunden');
    return r;
  }

  /** Status eines Auftrags; offene Aufträge fragt ELVIS beim Druckserver nach */
  async job(ref: string): Promise<PrintJob> {
    const r = this.row(ref);
    const server = this.servers.find((s) => s.id === r.server_id);
    if (PRINT_JOB_DONE.includes(r.state) || r.state === 'unknown' || !server || !r.ipp_job_id) return toJob(r);
    try {
      const res = await this.call(server, '/jobs/', {
        operation: OP.getJobAttributes,
        operationAttributes: [
          attr(TAG.uri, 'printer-uri', ippUri(server.url, `/printers/${encodeURIComponent(r.printer)}`)),
          attr(TAG.integer, 'job-id', r.ipp_job_id),
          attr(TAG.keyword, 'requested-attributes', 'job-state', 'job-state-message', 'job-state-reasons'),
        ],
      });
      if (ippOk(res.status) && res.jobs[0]) {
        const state = JOB_STATES[Number(res.jobs[0]['job-state']?.[0])] ?? r.state;
        // Hinweis zur Ablage nicht durch Meldungen des Druckers verdrängen
        const message = r.state_message.startsWith('Ablage') ? r.state_message : str(res.jobs[0], 'job-state-message');
        if (state !== r.state || message !== r.state_message) {
          this.store.db.prepare('UPDATE print_jobs SET state = ?, state_message = ? WHERE ref = ?').run(state, message, ref);
          r.state = state;
          r.state_message = message;
        }
      } else if (res.status === 0x0406) {
        // CUPS vergisst abgeschlossene Aufträge irgendwann
        this.store.db.prepare("UPDATE print_jobs SET state = 'unknown' WHERE ref = ?").run(ref);
        r.state = 'unknown';
      }
    } catch {
      /* Druckserver gerade nicht erreichbar: letzten bekannten Stand liefern */
    }
    return toJob(r);
  }

  recent(limit = 50): PrintJob[] {
    return (this.store.db.prepare('SELECT * FROM print_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as JobRow[]).map(toJob);
  }

  // --- Gastdrucker ---

  private guestCount(): number {
    return (this.store.db.prepare('SELECT COUNT(*) AS n FROM guest_print_jobs').get() as { n: number }).n;
  }

  /**
   * Auftrag vom Gastdrucker des Addons: je nach Einstellung sofort drucken oder bis zur Freigabe zurückhalten.
   * Fehler gehen an das Addon zurück, das Gerät des Gastes zeigt den Druck dann als fehlgeschlagen an.
   */
  async acceptGuest(token: string, content: Buffer, meta: GuestSubmission): Promise<{ queued: GuestPrintJob | null; job: PrintJob | null }> {
    const provision = this.guests.find((g) => sameSecret(token, g.token));
    if (!token || !provision) throw new HttpError(401, 'Unbekannter Gastdrucker');
    const g = this.settings().guest;
    if (g.mode === 'off') throw new HttpError(409, 'Der Gastdrucker ist abgeschaltet');
    if (g.onlyWithGuestWifi && !(this.deps.guestWifiActive?.() ?? false)) throw new HttpError(409, 'Der Gastdrucker nimmt nur während eines Einsatzes Aufträge an');
    if (!isPdf(content)) throw new HttpError(415, 'Der Gastdrucker liefert kein PDF');

    const user = meta.user.replace(/[^\p{L}\p{N} ._@-]/gu, '').trim().slice(0, 60);
    const by = `Gast ${user || meta.sourceIp || 'unbekannt'}`;
    const base = sanitizeName(meta.jobName.replace(/^.*[\\/]/, '')).slice(0, 150) || 'Gastdruck';
    const filename = extensionOf(base) === 'pdf' ? base : `${base}.pdf`;
    const copies = Math.min(Math.max(1, Math.trunc(meta.copies) || 1), g.maxCopies);
    const audit = (message: string) =>
      this.store.addAudit({ operator: by, target: 'druck', action: 'gast', params: JSON.stringify({ von: meta.sourceIp, kopien: copies, modus: g.mode }), success: true, message });

    if (g.mode === 'direct') {
      const job = await this.print({ filename, content }, await this.guestOptions(g.printer!, copies), { userId: null, name: by });
      return { queued: null, job };
    }

    const storageName = randomUUID();
    await writeFile(join(this.guestDir, storageName), content);
    const id = Number(
      this.store.db
        .prepare('INSERT INTO guest_print_jobs (storage_name, filename, size_bytes, copies, submitted_by, source_ip, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(storageName, filename, content.length, copies, user, meta.sourceIp.slice(0, 64), new Date().toISOString()).lastInsertRowid,
    );
    audit(`${filename} wartet auf Freigabe`);
    this.deps.notify(['printing', 'audit']);
    return { queued: this.guestJob(id), job: null };
  }

  /** Druckeinstellungen für Gastaufträge; was der Drucker nicht kann (Farbe, beidseitig), fällt weg */
  private async guestOptions(printerId: string, copies: number): Promise<PrintOptions> {
    const g = this.settings().guest;
    const server = this.servers.find((s) => s.id === printerId.slice(0, printerId.indexOf('/')));
    const printer = server ? (await this.serverPrinters(server)).printers.find((p) => p.id === printerId) : undefined;
    return {
      printerId,
      copies,
      sides: printer && !printer.duplex ? 'one-sided' : g.sides,
      color: printer && !printer.color ? 'monochrome' : g.color,
      media: '',
      orientation: 'auto',
      pageRanges: '',
      numberUp: 1,
      fitToPage: true,
    };
  }

  private guestRow(id: number): GuestRow {
    const r = this.store.db.prepare('SELECT * FROM guest_print_jobs WHERE id = ?').get(id) as GuestRow | undefined;
    if (!r) throw new HttpError(404, 'Gastauftrag nicht gefunden (schon freigegeben oder verworfen?)');
    return r;
  }

  guestJob(id: number): GuestPrintJob {
    return toGuestJob(this.guestRow(id));
  }

  guestJobs(): GuestPrintJob[] {
    return (this.store.db.prepare('SELECT * FROM guest_print_jobs ORDER BY received_at DESC, id DESC').all() as GuestRow[]).map(toGuestJob);
  }

  async guestFile(id: number): Promise<{ filename: string; content: Buffer }> {
    const r = this.guestRow(id);
    return { filename: r.filename, content: await readFile(join(this.guestDir, r.storage_name)) };
  }

  /** Freigeben: drucken und aus der Warteschlange nehmen */
  async releaseGuest(id: number, o: PrintOptions, by: { userId: number | null; name: string }): Promise<PrintJob> {
    const r = this.guestRow(id);
    const { content } = await this.guestFile(id);
    const job = await this.print({ filename: r.filename, content }, o, { userId: by.userId, name: `${by.name} (Freigabe für Gast ${r.submitted_by || r.source_ip})` });
    await this.dropGuest(r);
    return job;
  }

  async discardGuest(id: number, actor: string): Promise<void> {
    const r = this.guestRow(id);
    await this.dropGuest(r);
    this.store.addAudit({ operator: actor, target: 'druck', action: 'gast-verworfen', params: JSON.stringify({ von: r.source_ip }), success: true, message: r.filename });
    this.deps.notify(['printing', 'audit']);
  }

  private async dropGuest(r: GuestRow): Promise<void> {
    this.store.db.prepare('DELETE FROM guest_print_jobs WHERE id = ?').run(r.id);
    await unlink(join(this.guestDir, r.storage_name)).catch(() => {});
    this.deps.notify(['printing']);
  }

  /** Nicht freigegebene Gastaufträge nach Ablauf der Frist verwerfen (beim Start und stündlich) */
  async cleanupGuest(now = Date.now()): Promise<number> {
    const before = new Date(now - GUEST_PRINT_RETENTION_HOURS * 3600_000).toISOString();
    const stale = this.store.db.prepare('SELECT * FROM guest_print_jobs WHERE received_at < ?').all(before) as GuestRow[];
    for (const r of stale) await this.dropGuest(r);
    return stale.length;
  }
}
