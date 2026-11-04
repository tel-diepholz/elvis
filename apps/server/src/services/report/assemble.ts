import { PDFDocument } from 'pdf-lib';
import type { RenderedReport } from './render.js';

export interface EmbeddedFile {
  name: string;
  content: Buffer;
  mimeType: string;
  description: string;
  date?: Date;
}

/**
 * Hauptteil (pdfkit), Lagekarte und Dokument-PDFs zu einem PDF zusammensetzen und alle Originaldateien als
 * Dateianhänge einbetten.
 */
export async function assembleReport(main: RenderedReport, map: Buffer | null, files: EmbeddedFile[]): Promise<Buffer> {
  const out = await PDFDocument.load(main.pdf, { updateMetadata: false });

  // Von hinten nach vorn einfügen, damit die Seitenzahlen der Einfügestellen stimmen
  const inserts = [...main.inserts].sort((a, b) => b.afterPage - a.afterPage);
  for (const ins of inserts) {
    const src = await PDFDocument.load(ins.attachment.pdf!, { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p, i) => out.insertPage(ins.afterPage + 1 + i, p));
  }
  if (map && main.mapPage !== null) {
    const src = await PDFDocument.load(map, { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    out.removePage(main.mapPage);
    pages.forEach((p, i) => out.insertPage(main.mapPage! + i, p));
  }

  const used = new Set<string>();
  for (const f of files) {
    const base = f.name.replace(/[\\/:*?"<>|]+/g, '_') || 'Datei';
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = base.replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`);
    used.add(name.toLowerCase());
    await out.attach(new Uint8Array(f.content), name, { mimeType: f.mimeType || 'application/octet-stream', description: f.description, creationDate: f.date, modificationDate: f.date });
  }
  return Buffer.from(await out.save());
}
