import { pdfText } from '../print.js';

const PT_PER_MM = 72 / 25.4;
export const mm = (v: number) => v * PT_PER_MM;

export const PAGE_MARGINS = { top: mm(18), bottom: mm(18), left: mm(16), right: mm(16) };
const FONT = 'Helvetica';
const BOLD = 'Helvetica-Bold';
const ITALIC = 'Helvetica-Oblique';
const ACCENT = '#b71c1c';
const MUTED = '#555555';
const RULE = '#bbbbbb';
const ZEBRA = '#f3f3f3';

export interface Column {
  header: string;
  /** Anteil an der Seitenbreite */
  width: number;
}

/** Zelle: Text oder Text mit Hervorhebung */
export type Cell = string | { text: string; bold?: boolean; strike?: boolean; color?: string };

const cellText = (c: Cell) => (typeof c === 'string' ? c : c.text);

/** Dünne Schicht über pdfkit für Fließtext, Überschriften, Wertepaare und Tabellen mit Seitenumbruch */
export class Writer {
  constructor(readonly doc: PDFKit.PDFDocument) {}

  get left(): number {
    return PAGE_MARGINS.left;
  }

  get width(): number {
    return this.doc.page.width - PAGE_MARGINS.left - PAGE_MARGINS.right;
  }

  get bottom(): number {
    return this.doc.page.height - PAGE_MARGINS.bottom;
  }

  /** Seitenzahl (0-basiert) der aktuellen Seite im Puffer */
  get pageIndex(): number {
    const r = this.doc.bufferedPageRange();
    return r.start + r.count - 1;
  }

  newPage(): void {
    this.doc.addPage();
  }

  /** Platz für h pt, sonst neue Seite */
  ensure(h: number): void {
    if (this.doc.y + h > this.bottom) this.newPage();
  }

  /** Abschnitt auf neuer Seite mit Lesezeichen; liefert die Seite (0-basiert) */
  section(title: string): number {
    this.newPage();
    this.doc.outline.addItem(pdfText(title));
    this.doc.font(BOLD).fontSize(16).fillColor(ACCENT).text(pdfText(title), this.left, this.doc.y, { width: this.width });
    const y = this.doc.y + 2;
    this.doc.moveTo(this.left, y).lineTo(this.left + this.width, y).lineWidth(0.8).strokeColor(ACCENT).stroke();
    this.doc.y = y + 8;
    this.doc.fillColor('black');
    return this.pageIndex;
  }

  heading(title: string, size = 11.5): void {
    this.ensure(size * 3);
    this.doc.moveDown(0.4);
    this.doc.font(BOLD).fontSize(size).fillColor('black').text(pdfText(title), this.left, this.doc.y, { width: this.width });
    this.doc.moveDown(0.2);
  }

  paragraph(text: string, opts: { size?: number; color?: string; italic?: boolean; bold?: boolean } = {}): void {
    if (!text) return;
    this.doc
      .font(opts.bold ? BOLD : opts.italic ? ITALIC : FONT)
      .fontSize(opts.size ?? 9.5)
      .fillColor(opts.color ?? 'black')
      .text(pdfText(text), this.left, this.doc.y, { width: this.width });
    this.doc.fillColor('black');
  }

  muted(text: string): void {
    this.paragraph(text, { size: 8.5, color: MUTED, italic: true });
  }

  gap(lines = 0.5): void {
    this.doc.moveDown(lines);
  }

  /** Wertepaare in zwei Spalten (Bezeichnung | Wert); leere Werte entfallen */
  keyValues(rows: [string, string | null | undefined][], labelWidth = 0.28): void {
    const lw = this.width * labelWidth;
    const vw = this.width - lw;
    this.doc.fontSize(9.5);
    for (const [k, v] of rows) {
      if (v === null || v === undefined || v === '') continue;
      const value = pdfText(v);
      const h = Math.max(this.doc.font(FONT).heightOfString(value, { width: vw }), this.doc.font(BOLD).heightOfString(pdfText(k), { width: lw - 6 }));
      this.ensure(h + 3);
      const y = this.doc.y;
      this.doc.font(BOLD).fillColor(MUTED).text(pdfText(k), this.left, y, { width: lw - 6 });
      this.doc.font(FONT).fillColor('black').text(value, this.left + lw, y, { width: vw });
      this.doc.y = y + h + 3;
    }
    this.doc.x = this.left;
  }

  /**
   * Tabelle mit wiederholtem Kopf nach Seitenumbruch. Zeilen, die höher als eine ganze Seite wären, werden als
   * Fließtext gesetzt, damit nichts abgeschnitten wird.
   */
  table(columns: Column[], rows: Cell[][], size = 8.5): void {
    if (rows.length === 0) {
      this.muted('Keine Einträge.');
      return;
    }
    const doc = this.doc;
    const pad = 2.5;
    const widths = columns.map((c) => c.width * this.width);
    const xs = widths.map((_, i) => this.left + widths.slice(0, i).reduce((s, w) => s + w, 0));
    const measure = (cells: string[], font: string) => {
      doc.font(font).fontSize(size);
      return Math.max(...cells.map((t, i) => doc.heightOfString(t || ' ', { width: widths[i]! - 2 * pad }))) + 2 * pad;
    };
    const header = columns.map((c) => pdfText(c.header));
    const headerH = measure(header, BOLD);
    const drawHeader = () => {
      const y = doc.y;
      doc.rect(this.left, y, this.width, headerH).fill('#e4e4e4');
      doc.font(BOLD).fontSize(size).fillColor('black');
      header.forEach((t, i) => doc.text(t, xs[i]! + pad, y + pad, { width: widths[i]! - 2 * pad }));
      doc.y = y + headerH;
    };
    this.ensure(headerH + size * 3);
    drawHeader();
    const usable = this.bottom - PAGE_MARGINS.top - headerH - 4;
    rows.forEach((row, r) => {
      const texts = row.map((c) => pdfText(cellText(c)));
      const h = measure(texts, FONT);
      if (h > usable) {
        // Überlange Zeile: als Block unter der Tabelle fortsetzen
        this.ensure(size * 4);
        const y0 = doc.y;
        doc.moveTo(this.left, y0).lineTo(this.left + this.width, y0).lineWidth(0.3).strokeColor(RULE).stroke();
        doc.y = y0 + pad;
        texts.forEach((t, i) => {
          if (!t) return;
          doc.font(BOLD).fontSize(size).fillColor(MUTED).text(header[i]!, this.left, doc.y, { width: this.width, continued: false });
          doc.font(FONT).fillColor('black').text(t, this.left, doc.y, { width: this.width });
        });
        doc.y += pad;
        this.ensure(headerH + size * 3);
        if (r < rows.length - 1) drawHeader();
        return;
      }
      if (doc.y + h > this.bottom) {
        this.newPage();
        drawHeader();
      }
      const y = doc.y;
      if (r % 2 === 1) doc.rect(this.left, y, this.width, h).fill(ZEBRA);
      row.forEach((c, i) => {
        const style: Exclude<Cell, string> = typeof c === 'string' ? { text: c } : c;
        doc
          .font(style.bold ? BOLD : FONT)
          .fontSize(size)
          .fillColor(style.color ?? 'black')
          .text(texts[i]!, xs[i]! + pad, y + pad, { width: widths[i]! - 2 * pad, strike: style.strike });
      });
      doc.moveTo(this.left, y + h).lineTo(this.left + this.width, y + h).lineWidth(0.3).strokeColor(RULE).stroke();
      doc.y = y + h;
    });
    doc.fillColor('black');
    doc.x = this.left;
    doc.moveDown(0.6);
  }
}
