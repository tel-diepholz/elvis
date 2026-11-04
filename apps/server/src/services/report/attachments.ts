import { readFile } from 'node:fs/promises';
import { extensionOf } from '@elvis/shared';
import { PDFDocument } from 'pdf-lib';
import type { ReportDocument } from './collect.js';

/** Office-Formate, die Collabora in PDF umwandeln kann */
const OFFICE_EXT = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp', 'odg', 'vsd', 'vsdx']);
const TEXT_EXT = new Set(['txt', 'log', 'md', 'json', 'xml', 'gpx', 'kml']);
/** Textdateien werden bis zu dieser Größe in den Bericht gesetzt */
const MAX_TEXT_BYTES = 200 * 1024;

/** Wandelt eine Office-Datei in PDF; null = kein Office-Server oder fehlgeschlagen */
export type OfficeConverter = (content: Buffer, filename: string) => Promise<Buffer | null>;

export type AttachmentMode = 'image' | 'pdf' | 'office' | 'text' | 'none';

export interface PreparedAttachment {
  doc: ReportDocument;
  /** „A1“, „A2“ … */
  label: string;
  /** Originaldatei (für den Dateianhang); null = nicht lesbar */
  content: Buffer | null;
  mode: AttachmentMode;
  /** Bild (JPEG/PNG) für pdfkit */
  image?: Buffer;
  /** Text (Textdatei) */
  text?: string;
  /** PDF (Original oder umgewandelt), geprüft ladbar */
  pdf?: Uint8Array;
  pdfPages?: number;
  /** Hinweis im Bericht, z. B. warum nicht eingebettet */
  note: string;
}

const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Buffer) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

async function loadPdf(bytes: Uint8Array): Promise<{ pdf: Uint8Array; pages: number } | null> {
  try {
    const d = await PDFDocument.load(bytes, { updateMetadata: false });
    return { pdf: bytes, pages: d.getPageCount() };
  } catch {
    return null;
  }
}

/** Dokumente lesen und je nach Art zum Einbetten vorbereiten (Office über Collabora umwandeln) */
export async function prepareAttachments(docs: ReportDocument[], convert: OfficeConverter | null): Promise<PreparedAttachment[]> {
  const out: PreparedAttachment[] = [];
  for (const [i, doc] of docs.entries()) {
    const base = { doc, label: `A${i + 1}` };
    let content: Buffer;
    try {
      content = await readFile(doc.path);
    } catch {
      out.push({ ...base, content: null, mode: 'none', note: 'Datei nicht lesbar – nicht eingebettet.' });
      continue;
    }
    const ext = extensionOf(doc.filename);
    const mime = doc.mimeType.toLowerCase();
    if (isJpeg(content) || isPng(content)) {
      out.push({ ...base, content, mode: 'image', image: content, note: '' });
      continue;
    }
    if (mime === 'application/pdf' || ext === 'pdf') {
      const p = await loadPdf(content);
      out.push(p ? { ...base, content, mode: 'pdf', pdf: p.pdf, pdfPages: p.pages, note: '' } : { ...base, content, mode: 'none', note: 'PDF ist verschlüsselt oder beschädigt – nur als Dateianhang enthalten.' });
      continue;
    }
    if (OFFICE_EXT.has(ext)) {
      const converted = convert ? await convert(content, doc.filename).catch(() => null) : null;
      const p = converted ? await loadPdf(converted) : null;
      if (p) out.push({ ...base, content, mode: 'office', pdf: p.pdf, pdfPages: p.pages, note: 'In PDF umgewandelt (Collabora).' });
      else out.push({ ...base, content, mode: 'none', note: convert ? 'Umwandlung in PDF fehlgeschlagen – nur als Dateianhang enthalten.' : 'Kein Office-Server aktiv – nur als Dateianhang enthalten.' });
      continue;
    }
    if ((mime.startsWith('text/') || TEXT_EXT.has(ext)) && content.length <= MAX_TEXT_BYTES) {
      out.push({ ...base, content, mode: 'text', text: content.toString('utf8'), note: '' });
      continue;
    }
    const what = mime.startsWith('image/') ? 'Bildformat' : 'Dateiformat';
    out.push({ ...base, content, mode: 'none', note: `${what} lässt sich nicht einbetten – nur als Dateianhang enthalten.` });
  }
  return out;
}

/** Collabora Online: POST /cool/convert-to/pdf (multipart, Feld „data“) */
export function collaboraConverter(baseUrl: string, fetchFn: typeof fetch = fetch): OfficeConverter {
  return async (content, filename) => {
    const form = new FormData();
    form.append('data', new Blob([new Uint8Array(content)]), filename);
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/cool/convert-to/pdf`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  };
}
