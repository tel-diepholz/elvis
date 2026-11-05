import PDFDocument from 'pdfkit';
import { HOSE_TYPES, belowBar, PRINT_MM_PER_PX, computeSupply, formatDistance, formatDtg, hoseCount, pressureLossPer100m, project, type SupplyResult, type VehicleInfo, type WaterSupplyPrintRequest } from '@elvis/shared';
import { drawTiles, pdfText } from './print.js';
import { REF_ZOOM, drawPath, drawStop, fitZoom } from './route-print.js';
import type { TileService } from './tiles.js';

const PT_PER_MM = 72 / 25.4;
const mm = (v: number) => v * PT_PER_MM;
const K = mm(PRINT_MM_PER_PX);
const WATER_COLOR = '#0277bd';
const PUMP_COLOR = '#2e7d32';
const BAD_COLOR = '#c62828';

const num = (v: number, digits = 1) => v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const bar = (p: number) => `${num(p)} bar`;
const km = (d: number) => `km ${num(d / 1000, 2)}`;

export interface WaterPrintContext {
  vehicle: VehicleInfo;
  operator: string;
  now?: Date;
}

/** Verstärkerpumpe auf der Karte: abgerundetes Schild „P2“ */
function drawPump(doc: PDFKit.PDFDocument, x: number, y: number, label: string, bad: boolean) {
  const w = mm(7.5);
  const h = mm(4.6);
  doc.save();
  doc.roundedRect(x - w / 2, y - h / 2, w, h, 2).lineWidth(1.2).fillAndStroke(bad ? BAD_COLOR : PUMP_COLOR, '#ffffff');
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff').text(label, x - w / 2, y - 3.2, { width: w, align: 'center', lineBreak: false });
  doc.restore();
}

/** Höhenschnitt mit Druckverlauf als Vektorgrafik (wie in der Weboberfläche) */
function drawChart(doc: PDFKit.PDFDocument, req: WaterSupplyPrintRequest, r: SupplyResult, x0: number, y0: number, width: number, height: number) {
  const m = { l: mm(14), r: mm(14), t: mm(4), b: mm(7) };
  const w = width - m.l - m.r;
  const h = height - m.t - m.b;
  const total = Math.max(1, r.lengthM);
  const hs = req.profile.map((p) => p.h);
  let hMin = Math.min(...hs);
  let hMax = Math.max(...hs);
  if (hMax - hMin < 10) {
    const mid = (hMax + hMin) / 2;
    hMin = mid - 5;
    hMax = mid + 5;
  }
  const pad = (hMax - hMin) * 0.1;
  hMin = Math.floor(hMin - pad);
  hMax = Math.ceil(hMax + pad);
  const ps = r.points.map((p) => p.p);
  const pMin = Math.min(0, ...ps);
  const pMax = Math.max(req.hydraulics.pumpOutBar, ...ps) * 1.05;
  const x = (d: number) => x0 + m.l + (d / total) * w;
  const yh = (v: number) => y0 + m.t + h - ((v - hMin) / (hMax - hMin)) * h;
  const yp = (v: number) => y0 + m.t + h - ((v - pMin) / (pMax - pMin)) * h;
  const base = y0 + m.t + h;

  doc.save();
  // Gelände
  if (req.elevationSource) {
    doc.moveTo(x(0), base);
    for (const p of req.profile) doc.lineTo(x(p.d), yh(p.h));
    doc.lineTo(x(total), base).closePath().fillOpacity(0.35).fill('#a1887f');
    doc.fillOpacity(1);
    req.profile.forEach((p, i) => (i ? doc.lineTo(x(p.d), yh(p.h)) : doc.moveTo(x(p.d), yh(p.h))));
    doc.lineWidth(0.8).stroke('#8d6e63');
  }
  // Mindesteingangsdruck und 0 bar
  doc.moveTo(x(0), yp(req.hydraulics.minInBar)).lineTo(x(total), yp(req.hydraulics.minInBar)).lineWidth(0.8).dash(4, { space: 3 }).stroke(BAD_COLOR);
  doc.undash();
  if (pMin < 0) doc.moveTo(x(0), yp(0)).lineTo(x(total), yp(0)).lineWidth(0.4).stroke('#888888');
  // Pumpen
  r.pumps.forEach((p, i) => {
    doc.moveTo(x(p.d), y0 + m.t).lineTo(x(p.d), base).lineWidth(0.7).dash(2, { space: 2 }).stroke(PUMP_COLOR);
    doc.undash();
    doc.font('Helvetica-Bold').fontSize(7).fillColor(PUMP_COLOR).text(`P${i + 1}`, x(p.d) + 2, y0 + m.t, { lineBreak: false });
  });
  // Druck
  r.points.forEach((p, i) => (i ? doc.lineTo(x(p.d), yp(p.p)) : doc.moveTo(x(p.d), yp(p.p))));
  doc.lineWidth(1.6).lineJoin('round').stroke(WATER_COLOR);
  // Achsen
  doc.moveTo(x(0), base).lineTo(x(total), base).lineWidth(0.6).stroke('#555555');
  doc.font('Helvetica').fontSize(7).fillColor('#555555');
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const d = t * total;
    const label = num(d / 1000, 2);
    const tw = doc.widthOfString(label);
    doc.text(label, x(d) - (t === 0 ? 0 : t === 1 ? tw : tw / 2), base + 3, { lineBreak: false });
  }
  doc.text('km', x(total) + 4, base + 3, { lineBreak: false });
  if (req.elevationSource) {
    doc.text(`${hMax} m`, x0, y0 + m.t - 2, { width: m.l - 4, align: 'right', lineBreak: false });
    doc.text(`${hMin} m`, x0, base - 6, { width: m.l - 4, align: 'right', lineBreak: false });
  }
  doc.fillColor(WATER_COLOR).text(`${num(req.hydraulics.pumpOutBar, 0)} bar`, x(total) + 4, yp(req.hydraulics.pumpOutBar) - 3, { lineBreak: false });
  doc.fillColor(BAD_COLOR).text(bar(req.hydraulics.minInBar), x(total) + 4, yp(req.hydraulics.minInBar) - 3, { lineBreak: false });
  doc.restore();
}

/**
 * Ausdruck der Wasserversorgung auf A4 quer: Seite 1 Karte mit Schlauchweg, Entnahmestelle, Einsatzort und
 * Verstärkerpumpen; Seite 2 Kennzahlen, Pumpentabelle und Höhenschnitt mit Druckverlauf.
 */
export async function renderWaterSupplyPdf(req: WaterSupplyPrintRequest, tiles: TileService, ctx: WaterPrintContext): Promise<{ pdf: Buffer; missingTiles: number }> {
  const source = tiles.source(req.sourceId);
  const now = ctx.now ?? new Date();
  const hyd = req.hydraulics;
  const r = computeSupply(req.profile, req.pumpDs, hyd);
  const warnings = r.warnings;

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: mm(12), bottom: mm(12), left: mm(12), right: mm(12) },
    info: { Title: pdfText(req.title), Author: pdfText(`${ctx.vehicle.callsign} – ${ctx.operator}`), Creator: 'ELVIS' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const text = (s: string, opts: PDFKit.Mixins.TextOptions = {}) => doc.text(pdfText(s), opts);
  /** Fußzeile im unteren Rand (Rand kurz aufheben, sonst beginnt PDFKit eine neue Seite) */
  const footer = () => {
    const y = bottom() + mm(3);
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor('#555555');
    doc.text(pdfText(`${ctx.vehicle.callsign} · ${ctx.vehicle.organization} · Erstellt ${now.toLocaleString('de-DE')} von ${ctx.operator}`), left, y, { width, lineBreak: false });
    doc.page.margins.bottom = margin;
  };
  let missingTiles = 0;

  // --- Seite 1: Kopf und Karte ---
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111');
  text(req.title, { width });
  doc.font('Helvetica').fontSize(9.5).fillColor('#333333');
  text(
    `DTG ${formatDtg(now)}  ·  ${req.water.name} → ${req.incident.name}  ·  ${formatDistance(r.lengthM)} ${HOSE_TYPES[hyd.hose].label}  ·  ${hyd.flowLpm} l/min  ·  ${r.pumps.length} Pumpen  ·  am Einsatzort ${bar(r.endBar)}`,
    { width },
  );
  doc.moveDown(0.4);
  {
    const mapH = bottom() - doc.y - mm(10);
    const wPx = width / K;
    const hPx = mapH / K;
    const pts: [number, number][] = [...req.path, [req.incident.lon, req.incident.lat], [req.water.lon, req.water.lat]];
    const { zoom, center } = fitZoom(pts, wPx, hPx, Math.min(source.maxZoom, 17));
    const origin = { x: center.x - wPx / 2, y: center.y - hPx / 2 };
    const y0 = doc.y;
    const at = (lat: number, lon: number) => {
      const p = project(lat, lon, zoom);
      return { x: left + (p.x - origin.x) * K, y: y0 + (p.y - origin.y) * K };
    };
    doc.save();
    doc.rect(left, y0, width, mapH).clip();
    missingTiles += await drawTiles(doc, tiles, source.id, zoom, origin, wPx, hPx, left, y0, K);
    const world = req.path.map(([lon, lat]) => project(lat, lon, REF_ZOOM));
    drawPath(doc, world, zoom, origin, wPx, hPx, left, y0, 5, WATER_COLOR);
    const w = at(req.water.lat, req.water.lon);
    drawStop(doc, w.x, w.y, 'W', WATER_COLOR, 8);
    const e = at(req.incident.lat, req.incident.lon);
    drawStop(doc, e.x, e.y, '!', BAD_COLOR, 8);
    r.pumps.slice(1).forEach((p, i) => {
      const q = at(p.lat, p.lon);
      drawPump(doc, q.x, q.y, `P${i + 2}`, p.inBar !== null && belowBar(p.inBar, hyd.minInBar));
    });
    doc.restore();
    doc.rect(left, y0, width, mapH).lineWidth(0.75).stroke('#000000');
    doc.y = y0 + mapH + 3;
    doc.x = left;
    doc.font('Helvetica').fontSize(6.5).fillColor('#555555');
    text(`Kartengrundlage: ${source.attribution} · Weg (zu Fuß): ${req.routeSource} · W = Entnahmestelle, ! = Einsatzort, P = Verstärkerpumpe`, { width });
    if (missingTiles) {
      doc.font('Helvetica-Bold').fillColor(BAD_COLOR);
      text(`Hinweis: ${missingTiles} Kartenkachel(n) nicht verfügbar (offline?)`, { width });
    }
  }
  footer();

  // --- Seite 2: Kennzahlen, Pumpen, Höhenschnitt ---
  doc.addPage();
  const colW = (width - mm(8)) / 2;
  const top = doc.y;
  doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111');
  text(req.water.name, { width: colW });
  doc.font('Helvetica').fontSize(9.5).fillColor('#333333');
  if (req.water.info) text(req.water.info, { width: colW });
  if (req.water.address) text(req.water.address, { width: colW });
  doc.moveDown(0.5);
  const facts: [string, string][] = [
    ['Einsatzort', req.incident.name],
    ['Schlauchweg', `${formatDistance(r.lengthM)} · ${hoseCount(r.lengthM, hyd.hose)} × ${HOSE_TYPES[hyd.hose].lengthM} m ${hyd.hose}-Schlauch (inkl. 10 % Reserve)`],
    ['Schlauch', HOSE_TYPES[hyd.hose].label],
    ['Fördermenge', `${hyd.flowLpm} l/min · Reibung ${bar(pressureLossPer100m(hyd.hose, hyd.flowLpm))} je 100 m`],
    ['Drücke', `Pumpe Ausgang ${bar(hyd.pumpOutBar)} · mind. Eingang ${bar(hyd.minInBar)} · Einsatzort mind. ${bar(hyd.endBar)}`],
    ['Höhe', req.elevationSource ? `${r.climbM >= 0 ? '+' : '−'}${Math.abs(Math.round(r.climbM))} m bis Einsatzort · höchster Punkt +${Math.round(r.maxRiseM)} m` : 'ohne Höhendaten (nur Reibung gerechnet)'],
    ['Pumpen', `${r.pumps.length} (${r.pumps.length - 1} Verstärker) · am Einsatzort ${bar(r.endBar)}`],
  ];
  for (const [k, v] of facts) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor('#555555').text(pdfText(k), left, y, { width: mm(26) });
    doc.fillColor('#111111').text(pdfText(v), left + mm(27), y, { width: colW - mm(27) });
    doc.x = left;
  }
  if (warnings.length) {
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BAD_COLOR);
    for (const w of warnings) text(`• ${w}`, { width: colW });
  }
  const leftBottom = doc.y;

  // Pumpentabelle rechts
  {
    const x0 = left + colW + mm(8);
    const cols = [mm(22), mm(24), mm(20), mm(24), mm(24)];
    const head = ['Pumpe', 'Strecke', 'Höhe', 'Eingang', 'Ausgang'];
    let y = top;
    const row = (cells: string[], bold: boolean, colors: (string | null)[] = []) => {
      let x = x0;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      cells.forEach((c, i) => {
        doc.fillColor(colors[i] ?? '#111111').text(pdfText(c), x, y, { width: cols[i]! - 4, align: i === 0 ? 'left' : 'right', lineBreak: false });
        x += cols[i]!;
      });
      y += 13;
      doc.moveTo(x0, y - 2).lineTo(x0 + cols.reduce((a, b) => a + b, 0), y - 2).lineWidth(0.4).stroke('#bbbbbb');
    };
    row(head, true);
    r.pumps.forEach((p, i) => {
      const bad = p.inBar !== null && belowBar(p.inBar, hyd.minInBar);
      row([`P${i + 1}`, i === 0 ? 'Entnahme' : km(p.d), req.elevationSource ? `${Math.round(p.h)} m` : '–', p.inBar === null ? '–' : bar(p.inBar), bar(p.outBar)], false, [null, null, null, bad ? BAD_COLOR : null]);
    });
    const endH = req.profile[req.profile.length - 1]!.h;
    row(['Einsatzort', km(r.lengthM), req.elevationSource ? `${Math.round(endH)} m` : '–', bar(r.endBar), ''], true, [null, null, null, belowBar(r.endBar, hyd.endBar) ? BAD_COLOR : null]);
    doc.y = Math.max(leftBottom, y) + mm(6);
    doc.x = left;
  }

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111');
  text('Höhenschnitt und Druckverlauf', { width });
  const chartTop = doc.y + 2;
  const chartH = Math.max(mm(50), bottom() - chartTop - mm(12));
  drawChart(doc, req, r, left, chartTop, width, chartH);
  doc.y = chartTop + chartH + 2;
  doc.x = left;
  doc.font('Helvetica').fontSize(7).fillColor('#555555');
  text(
    `Höhen: ${req.elevationSource ?? 'nicht verfügbar'} · Reibung nach Tabellenwerten (Δp = k·Q²), 1 bar je 10 m Höhe · blau: Druck im Schlauch, rot gestrichelt: Mindesteingangsdruck, grün: Pumpen`,
    { width },
  );
  footer();

  doc.end();
  return { pdf: await done, missingTiles };
}
