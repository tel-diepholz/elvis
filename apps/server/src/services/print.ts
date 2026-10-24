import PDFDocument from 'pdfkit';
import {
  PAPER_MM,
  PRINT_MARGIN_MM,
  PRINT_MM_PER_PX,
  TILE_SIZE,
  formatDtg,
  niceScale,
  buildTacticalSign,
  printFrame,
  project,
  type MapPrintRequest,
  type TacticalGeometry,
  type TacticalSign,
  type VehicleInfo,
} from '@elvis/shared';
import type { TileService } from './tiles.js';

const PT_PER_MM = 72 / 25.4;
const mm = (v: number) => v * PT_PER_MM;

const SUPERSCRIPT: Record<string, string> = { '⁻': '-', '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

/** Die PDF-Standardschriften kennen nur WinAnsi – Sonderzeichen in lesbare Ersatzformen wandeln. */
export function pdfText(s: string): string {
  return s
    .replace(/[⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, (m) => (m === '³' || m === '²' ? m : `^${[...m].map((c) => SUPERSCRIPT[c]).join('')}`))
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/→/g, '->')
    .replace(/[^\u0000-ÿ–—‘’“”„•…€]/g, '?');
}

const fmtInt = (n: number) => Math.round(n).toLocaleString('de-DE');

/** Maßstabsleiste: runde Länge, die etwa `maxM` nicht überschreitet. */
function scaleBarLength(maxM: number): number {
  const mag = 10 ** Math.floor(Math.log10(maxM));
  return [5, 2, 1].map((s) => s * mag).find((v) => v <= maxM) ?? mag;
}

export interface PrintContext {
  vehicle: VehicleInfo;
  /** Taktisches Zeichen für den Fahrzeugstandort (Systemeinstellungen). */
  vehicleSign: TacticalSign;
  operator: string;
  now?: Date;
}

/** Zeichnet ein taktisches Zeichen als Vektorgrafik; (x, y) ist der Bezugspunkt (Mitte des Zeichenkörpers). */
export function drawTacticalSign(doc: PDFKit.PDFDocument, g: TacticalGeometry, x: number, y: number, scale: number): void {
  doc.save();
  doc.translate(x - g.anchor.x * scale, y - g.anchor.y * scale).scale(scale);
  doc.lineJoin('round').lineCap('round');
  for (const p of g.primitives) {
    if (p.kind === 'text') {
      const text = pdfText(p.text);
      doc.font(p.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(p.size).fillColor(p.fill);
      const w = doc.widthOfString(text);
      const left = p.anchor === 'middle' ? p.x - w / 2 : p.anchor === 'end' ? p.x - w : p.x;
      // SVG-y ist die Grundlinie, pdfkit erwartet die Oberkante.
      doc.text(text, left, p.y - p.size * 0.76, { lineBreak: false });
      continue;
    }
    if (p.kind === 'path') doc.path(p.d);
    else doc.circle(p.cx, p.cy, p.r);
    if (p.stroke) doc.lineWidth(p.width ?? 2.5);
    if (p.fill && p.stroke) doc.fillAndStroke(p.fill, p.stroke);
    else if (p.fill) doc.fill(p.fill);
    else if (p.stroke) doc.stroke(p.stroke);
  }
  doc.restore();
}

/**
 * Erzeugt die Lagekarte als PDF: Rasterkacheln werden direkt als Bilder platziert,
 * Markierungen und Ausbreitung als Vektorgrafik (gestochen scharf in jedem Format).
 */
export async function renderMapPdf(req: MapPrintRequest, tiles: TileService, ctx: PrintContext): Promise<{ pdf: Buffer; missingTiles: number }> {
  const source = tiles.source(req.sourceId);
  const frame = printFrame(req.center, req.zoom, req.paper, req.orientation);
  const paper = PAPER_MM[req.paper];
  const [pageW, pageH] = req.orientation === 'portrait' ? [paper.width, paper.height] : [paper.height, paper.width];
  // Markierungen und Schrift wachsen mit dem Format (A3 = 1); A4 nicht kleiner als A3, sonst unleserlich.
  const f = Math.max(1, Math.sqrt((pageW * pageH) / (PAPER_MM.A3.width * PAPER_MM.A3.height)));
  const k = mm(PRINT_MM_PER_PX); // pt je Kartenpixel
  const fx = mm(PRINT_MARGIN_MM);
  const fy = mm(PRINT_MARGIN_MM);
  const fw = frame.widthPx * k;
  const fh = frame.heightPx * k;
  const toPt = (lat: number, lon: number) => {
    const p = project(lat, lon, req.zoom);
    return [fx + (p.x - frame.origin.x) * k, fy + (p.y - frame.origin.y) * k] as [number, number];
  };

  // Kacheln parallel laden (TileService begrenzt die Parallelität nach außen).
  const tx0 = Math.floor(frame.origin.x / TILE_SIZE);
  const ty0 = Math.floor(frame.origin.y / TILE_SIZE);
  const tx1 = Math.floor((frame.origin.x + frame.widthPx - 1) / TILE_SIZE);
  const ty1 = Math.floor((frame.origin.y + frame.heightPx - 1) / TILE_SIZE);
  const jobs: Promise<{ tx: number; ty: number; tile: Awaited<ReturnType<TileService['get']>> }>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) jobs.push(tiles.get(source.id, req.zoom, tx, ty).then((tile) => ({ tx, ty, tile })));
  }
  const loaded = await Promise.all(jobs);

  const now = ctx.now ?? new Date();
  const doc = new PDFDocument({
    size: [mm(pageW), mm(pageH)],
    // Die Karte ist exakt positioniert. Ein unerreichbarer unterer Rand verhindert, dass pdfkit bei Text nahe
    // der Seitenkante automatisch Folgeseiten anlegt.
    margins: { top: 0, left: 0, right: 0, bottom: -1e6 },
    info: { Title: pdfText(req.title), Author: pdfText(`${ctx.vehicle.callsign} – ${ctx.operator}`), Creator: 'ELVIS' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // --- Karte ---
  let missingTiles = 0;
  doc.save();
  doc.rect(fx, fy, fw, fh).clip();
  doc.rect(fx, fy, fw, fh).fill('#eeeeee');
  for (const { tx, ty, tile } of loaded) {
    const x = fx + (tx * TILE_SIZE - frame.origin.x) * k;
    const y = fy + (ty * TILE_SIZE - frame.origin.y) * k;
    const size = TILE_SIZE * k;
    const supported = tile && /image\/(png|jpe?g)/.test(tile.contentType);
    if (supported) {
      try {
        doc.image(tile.data, x, y, { width: size, height: size });
        continue;
      } catch {
        /* defekte Kachel → wie fehlend behandeln */
      }
    }
    missingTiles++;
    doc.rect(x, y, size, size).fill('#e0e0e0');
  }

  for (const poly of req.polygons) {
    if (poly.points.length < 3) continue;
    const pts = poly.points.map(([lat, lon]) => toPt(lat, lon));
    doc.save();
    if (poly.dashed) doc.dash(6 * f, { space: 4 * f });
    doc.polygon(...pts).lineWidth(1.5 * f).fillOpacity(poly.fillOpacity).strokeOpacity(0.9).fillAndStroke(poly.fill, poly.stroke);
    doc.restore();
  }

  const vehicleSign = buildTacticalSign(ctx.vehicleSign);
  const signScale = (36 * f) / 100; // Zeichenkörper 36 pt breit (A3)
  const outside: string[] = [];
  for (const m of req.markers) {
    const [x, y] = toPt(m.lat, m.lon);
    if (x < fx || x > fx + fw || y < fy || y > fy + fh) {
      outside.push(m.label || (m.kind === 'vehicle' ? 'Fahrzeug' : m.kind === 'incident' ? 'Einsatzort' : m.kind === 'unit' ? 'Einheit' : 'Punkt'));
      continue;
    }
    doc.save();
    const sign = m.kind === 'vehicle' ? vehicleSign : m.kind === 'unit' ? buildTacticalSign(m.sign ?? {}) : null;
    if (sign) {
      drawTacticalSign(doc, sign, x, y, signScale);
    } else if (m.kind === 'point') {
      doc.circle(x, y, 5 * f).lineWidth(1.5 * f).fillAndStroke(m.color ?? '#1e6fd9', '#ffffff');
    } else {
      doc.circle(x, y, 10 * f).lineWidth(1.5 * f).fillAndStroke('#e53935', '#ffffff');
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12 * f).text('!', x - 10 * f, y - 6 * f, { width: 20 * f, align: 'center', lineBreak: false });
    }
    if (m.label) {
      const label = pdfText(m.label);
      doc.font('Helvetica-Bold').fontSize(8 * f);
      const lw = doc.widthOfString(label) + 6 * f;
      const ly = sign ? y + (sign.box.y + sign.box.height - sign.anchor.y) * signScale + 2 * f : y + (m.kind === 'point' ? 7 : 12) * f;
      doc.rect(x - lw / 2, ly, lw, 11 * f).fillOpacity(0.85).fill('#ffffff');
      doc.fillOpacity(1).fillColor('#111111').text(label, x - lw / 2, ly + 2 * f, { width: lw, align: 'center', lineBreak: false });
    }
    doc.restore();
  }
  doc.restore();
  doc.rect(fx, fy, fw, fh).lineWidth(1).stroke('#000000');

  // --- Nordpfeil (Web-Mercator: Norden oben) ---
  {
    const cx = fx + fw - 18 * f;
    const cy = fy + 22 * f;
    doc.save();
    doc.circle(cx, cy, 13 * f).fillOpacity(0.85).fill('#ffffff');
    doc.fillOpacity(1).polygon([cx, cy - 10 * f], [cx + 5 * f, cy + 6 * f], [cx, cy + 3 * f], [cx - 5 * f, cy + 6 * f]).fill('#111111');
    doc.font('Helvetica-Bold').fontSize(7 * f).fillColor('#111111').text('N', cx - 5 * f, cy - 21 * f, { width: 10 * f, align: 'center', lineBreak: false });
    doc.restore();
  }

  // --- Infokasten unten rechts ---
  const pad = 4 * f;
  const boxW = mm(80) * f;
  const innerW = boxW - 2 * pad;
  const scale = niceScale(frame.scale);
  const barM = scaleBarLength((innerW / PT_PER_MM / 1000) * frame.scale * 0.7);
  const barW = (barM / frame.scale) * 1000 * PT_PER_MM;

  type Line = { text: string; font: string; size: number; color?: string; gap?: number };
  const lines: Line[] = [
    { text: req.title, font: 'Helvetica-Bold', size: 14 * f },
    ...(req.subtitle ? [{ text: req.subtitle, font: 'Helvetica', size: 9 * f, color: '#333333' }] : []),
    { text: `DTG ${formatDtg(now)}  ·  Maßstab ca. 1:${fmtInt(scale)}  ·  Zoom ${req.zoom}`, font: 'Helvetica', size: 8.5 * f, gap: 4 * f },
  ];
  const noteLines: Line[] = req.notes.map((n, i) => ({ text: n, font: 'Helvetica', size: 7.5 * f, color: '#333333', gap: i === 0 ? 4 * f : 0 }));
  const footer: Line[] = [
    { text: `${ctx.vehicle.callsign} · ${ctx.vehicle.organization}`, font: 'Helvetica', size: 6.5 * f, color: '#555555', gap: 4 * f },
    { text: `Erstellt ${now.toLocaleString('de-DE')} von ${ctx.operator} · Kartengrundlage: ${source.attribution}`, font: 'Helvetica', size: 6.5 * f, color: '#555555' },
    ...(missingTiles ? [{ text: `Hinweis: ${missingTiles} Kartenkachel(n) nicht verfügbar (offline?)`, font: 'Helvetica-Bold', size: 6.5 * f, color: '#c62828' }] : []),
    ...(outside.length ? [{ text: `Nicht im Kartenausschnitt: ${outside.join(', ')}`, font: 'Helvetica-Bold', size: 6.5 * f, color: '#c62828' }] : []),
  ];

  const measure = (l: Line) => doc.font(l.font).fontSize(l.size).heightOfString(pdfText(l.text), { width: innerW }) + (l.gap ?? 0) + 1.5 * f;
  const legendRowH = 10 * f;
  const barBlockH = 18 * f;
  const boxH =
    pad * 2 +
    lines.reduce((a, l) => a + measure(l), 0) +
    barBlockH +
    (req.legend.length ? req.legend.length * legendRowH + 4 * f : 0) +
    noteLines.reduce((a, l) => a + measure(l), 0) +
    footer.reduce((a, l) => a + measure(l), 0);
  const bx = fx + fw - boxW - 6 * f;
  const by = fy + fh - boxH - 6 * f;

  doc.rect(bx, by, boxW, boxH).fillOpacity(0.93).fill('#ffffff');
  doc.fillOpacity(1).rect(bx, by, boxW, boxH).lineWidth(0.75).stroke('#000000');
  let cy = by + pad;
  const writeLine = (l: Line) => {
    cy += l.gap ?? 0;
    doc.font(l.font).fontSize(l.size).fillColor(l.color ?? '#111111');
    const text = pdfText(l.text);
    doc.text(text, bx + pad, cy, { width: innerW });
    cy += doc.heightOfString(text, { width: innerW }) + 1.5 * f;
  };
  lines.forEach(writeLine);

  // Maßstabsleiste (4 Segmente, abwechselnd schwarz/weiß)
  cy += 3 * f;
  const segW = barW / 4;
  for (let i = 0; i < 4; i++) {
    doc.rect(bx + pad + i * segW, cy, segW, 4 * f).lineWidth(0.5).fillAndStroke(i % 2 ? '#ffffff' : '#111111', '#111111');
  }
  doc.font('Helvetica').fontSize(6.5 * f).fillColor('#111111');
  doc.text('0', bx + pad - 2 * f, cy + 5.5 * f, { lineBreak: false });
  const barLabel = barM >= 1000 ? `${barM / 1000} km` : `${barM} m`;
  doc.text(barLabel, bx + pad + barW - doc.widthOfString(barLabel) / 2, cy + 5.5 * f, { lineBreak: false });
  cy += barBlockH - 3 * f;

  if (req.legend.length) {
    cy += 4 * f;
    for (const item of req.legend) {
      doc.rect(bx + pad, cy + 1 * f, 8 * f, 6 * f).fillOpacity(0.6).fill(item.color);
      doc.fillOpacity(1).rect(bx + pad, cy + 1 * f, 8 * f, 6 * f).lineWidth(0.5).stroke(item.color);
      doc.font('Helvetica').fontSize(7.5 * f).fillColor('#111111').text(pdfText(item.label), bx + pad + 12 * f, cy + 1 * f, { width: innerW - 12 * f, lineBreak: false });
      cy += legendRowH;
    }
  }
  noteLines.forEach(writeLine);
  footer.forEach(writeLine);

  doc.end();
  return { pdf: await done, missingTiles };
}
