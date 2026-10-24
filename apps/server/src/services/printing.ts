import { randomBytes } from 'node:crypto';
import {
  DEFAULT_PRINT_SETTINGS,
  PRINT_JOB_DONE,
  parsePageRanges,
  printSettingsInputSchema,
  sortMedia,
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
  private cache = new Map<string, { at: number; printers: ServerPrinter[]; error: string | null }>();

  constructor(
    private readonly store: Store,
    private readonly deps: {
      documents: DocumentService;
      notify: (topics: Topic[]) => void;
      transport?: IppTransport;
    },
  ) {}

  private get transport(): IppTransport {
    return this.deps.transport ?? defaultTransport;
  }

  /** Laufende Addons melden ihre Druckserver */
  setProvisions(list: PrintServerProvision[]): void {
    if (JSON.stringify(list) === JSON.stringify(this.servers)) return;
    this.servers = list;
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
    if (file.content.subarray(0, 1024).indexOf('%PDF-') < 0) throw new HttpError(415, 'Nur PDF-Dateien können gedruckt werden');
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
}
