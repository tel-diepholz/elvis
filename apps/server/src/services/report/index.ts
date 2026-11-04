import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { formatDtg, sanitizeName, type Incident, type TacticalSign, type VehicleInfo } from '@elvis/shared';
import { HttpError } from '../../errors.js';
import type { OfficeService } from '../office.js';
import { renderMapPdf, type OverlayTileLoader } from '../print.js';
import type { TileService } from '../tiles.js';
import { assembleReport, type EmbeddedFile } from './assemble.js';
import { collaboraConverter, prepareAttachments, type OfficeConverter } from './attachments.js';
import { REPORT_KIND, collectReport, type CollectDeps } from './collect.js';
import { reportMapRequest, reportSource } from './map.js';
import { renderReport } from './render.js';

/** Ablageort des automatisch erzeugten Berichts */
const REPORT_FOLDER = 'Protokolle';

export interface ReportDeps extends CollectDeps {
  tiles: TileService;
  office: OfficeService;
  settings: () => { vehicle: VehicleInfo; mapSign: TacticalSign };
  overlayTile?: OverlayTileLoader;
  /** Für Tests: Office-Umwandlung ersetzen */
  convert?: OfficeConverter | null;
  log: { warn: (obj: unknown, msg: string) => void; info: (obj: unknown, msg: string) => void };
}

/**
 * Einsatzbericht als PDF: alle erfassten Daten, Lagekarte, Dokumente (Bilder und PDFs als Seiten, Office über Collabora
 * umgewandelt) und alle Originale als Dateianhänge.
 */
export class ReportService {
  /** Laufende Erzeugung je Einsatz, damit Abschluss und Tests darauf warten können */
  private readonly pending = new Map<number, Promise<void>>();

  constructor(private readonly deps: ReportDeps) {}

  filename(incident: Incident, at: Date): string {
    const name = sanitizeName(`Einsatzbericht_${incident.keyword || `Lage-${incident.id}`}_${formatDtg(at)}.pdf`.replace(/\s+/g, '_'));
    return name || `Einsatzbericht_${incident.id}.pdf`;
  }

  async generate(incidentId: number, operator: string, now = new Date()): Promise<{ pdf: Buffer; filename: string }> {
    const incident = this.deps.store.incident(incidentId);
    if (!incident) throw new HttpError(404, `Lage ${incidentId} nicht gefunden`);
    const data = collectReport(this.deps, incident);
    const { vehicle, mapSign } = this.deps.settings();

    const officeUrl = this.deps.office.url();
    const convert = this.deps.convert !== undefined ? this.deps.convert : officeUrl ? collaboraConverter(officeUrl) : null;
    const attachments = await prepareAttachments(data.documents, convert);

    // Lagekarte vorab, damit die Seitenzahlen feststehen
    let map: Buffer | null = null;
    let mapNote = '';
    const source = reportSource(this.deps.tiles.list());
    const req = source ? reportMapRequest(data, source) : null;
    if (!source) mapNote = 'Keine Kartenquelle eingerichtet.';
    if (req) {
      try {
        const r = await renderMapPdf(req, this.deps.tiles, { vehicle, vehicleSign: mapSign, operator, now, overlayTile: this.deps.overlayTile });
        map = r.pdf;
        if (r.missingTiles) mapNote = `${r.missingTiles} Kartenkachel(n) waren nicht verfügbar (offline?).`;
      } catch (err) {
        this.deps.log.warn({ err }, 'Lagekarte für den Einsatzbericht fehlgeschlagen');
        mapNote = `Lagekarte konnte nicht erzeugt werden: ${(err as Error).message}`;
      }
    }

    // Dateianhänge: Dokumente, Chat-Dateien, E-Mails (Original) und deren Anhänge
    const files: EmbeddedFile[] = [];
    for (const a of attachments) {
      if (a.content) files.push({ name: `${a.label}_${a.doc.filename}`, content: a.content, mimeType: a.doc.mimeType, description: `${a.doc.folder ? `${a.doc.folder}/` : ''}${a.doc.filename}`, date: new Date(a.doc.updatedAt) });
    }
    let messageAttachments = 0;
    for (const m of data.chat) {
      if (!m.attachment) continue;
      try {
        const f = this.deps.chat.file(m.attachment.id);
        files.push({ name: `Chat_${m.id}_${m.attachment.name}`, content: await readFile(f.path), mimeType: m.attachment.mimeType, description: `Chat ${m.name ?? m.peer}`, date: new Date(m.date) });
        messageAttachments++;
      } catch {
        /* Datei inzwischen aufgeräumt */
      }
    }
    for (const m of data.mails) {
      try {
        files.push({ name: `Mail_${m.id}.eml`, content: this.deps.mail.raw(m.id), mimeType: 'message/rfc822', description: m.subject, date: new Date(m.date) });
        for (const att of m.attachments) {
          const a = this.deps.mail.attachment(att.id);
          files.push({ name: `Mail_${m.id}_${a.filename}`, content: a.content, mimeType: a.contentType, description: `Anhang der E-Mail „${m.subject}“`, date: new Date(m.date) });
          messageAttachments++;
        }
      } catch (err) {
        this.deps.log.warn({ err, mail: m.id }, 'E-Mail für den Einsatzbericht nicht lesbar');
      }
    }

    const mapPages = map ? (await PDFDocument.load(map)).getPageCount() : 0;
    const main = await renderReport(data, attachments, { vehicle, operator, now, mapPages, mapNote, messageAttachments });
    const pdf = await assembleReport(main, map, files);
    return { pdf, filename: this.filename(incident, now) };
  }

  /** Nach dem Beenden: Bericht erzeugen und unter „Protokolle“ ablegen (Fehler landen im Tagebuch) */
  archive(incident: Incident, operator = 'System'): Promise<void> {
    const run = (async () => {
      try {
        const { pdf, filename } = await this.generate(incident.id, operator);
        await this.deps.documents.storeFile(
          incident.id,
          REPORT_FOLDER,
          { filename, mimeType: 'application/pdf', content: pdf, description: 'Einsatzbericht (automatisch beim Beenden erzeugt)' },
          { id: null, name: operator },
          { allowClosed: true, generated: REPORT_KIND },
        );
        this.deps.log.info({ incident: incident.id, bytes: pdf.length }, 'Einsatzbericht abgelegt');
      } catch (err) {
        this.deps.log.warn({ err, incident: incident.id }, 'Einsatzbericht fehlgeschlagen');
        this.deps.store.addJournal(incident.id, { category: 'system', text: `Einsatzbericht konnte nicht erzeugt werden: ${(err as Error).message}` }, 'System');
      }
    })();
    this.pending.set(incident.id, run);
    void run.finally(() => {
      if (this.pending.get(incident.id) === run) this.pending.delete(incident.id);
    });
    return run;
  }

  /** Auf eine laufende Ablage warten (Tests, geordnetes Herunterfahren) */
  async idle(): Promise<void> {
    await Promise.all(this.pending.values());
  }
}
