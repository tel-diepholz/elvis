import PDFDocument from 'pdfkit';
import { PRINT_MM_PER_PX, ROUTE_PROFILE_LABELS, formatDistance, formatDtg, formatDuration, project, type RoutePrintRequest, type VehicleInfo } from '@elvis/shared';
import { drawTiles, pdfText } from './print.js';
import type { TileService } from './tiles.js';

const PT_PER_MM = 72 / 25.4;
const mm = (v: number) => v * PT_PER_MM;

/** pt je Kartenpixel – wie die Lagekarte, damit die Kachelschrift lesbar bleibt */
const K = mm(PRINT_MM_PER_PX);
const ROUTE_COLOR = '#1e6fd9';
const OVERVIEW_H_MM = 120;
/** Kartenausschnitt je Fahrhinweis */
const DETAIL_MM = 34;
const DETAIL_ZOOM = 16;
/** Bezugszoomstufe der vorab projizierten Strecke */
const REF_ZOOM = 20;

export interface RoutePrintContext {
  vehicle: VehicleInfo;
  operator: string;
  now?: Date;
}

type Pt = { x: number; y: number };

/** Halte: Start grün, Ziel rot, Zwischenziele blau */
const stopColor = (i: number, n: number) => (i === 0 ? '#2e7d32' : i === n - 1 ? '#c62828' : ROUTE_COLOR);

/** Größte Zoomstufe, bei der die Strecke mit etwas Rand in w × h Kartenpixel passt */
function fitZoom(path: [number, number][], widthPx: number, heightPx: number, maxZoom: number): { zoom: number; center: Pt } {
  const lats = path.map((p) => p[1]);
  const lons = path.map((p) => p[0]);
  const north = Math.max(...lats);
  const south = Math.min(...lats);
  const west = Math.min(...lons);
  const east = Math.max(...lons);
  for (let z = maxZoom; z > 2; z--) {
    const nw = project(north, west, z);
    const se = project(south, east, z);
    if (se.x - nw.x <= widthPx * 0.88 && se.y - nw.y <= heightPx * 0.88) return { zoom: z, center: { x: (nw.x + se.x) / 2, y: (nw.y + se.y) / 2 } };
  }
  const nw = project(north, west, 2);
  const se = project(south, east, 2);
  return { zoom: 2, center: { x: (nw.x + se.x) / 2, y: (nw.y + se.y) / 2 } };
}

/**
 * Strecke in den Ausschnitt zeichnen. `world` sind Weltpixel bei REF_ZOOM; nur Abschnitte in der Nähe des Ausschnitts
 * werden übernommen, damit die vielen kleinen Karten das PDF nicht aufblähen.
 */
function drawPath(doc: PDFKit.PDFDocument, world: Pt[], zoom: number, origin: Pt, widthPx: number, heightPx: number, x0: number, y0: number, width: number) {
  const s = 2 ** (zoom - REF_ZOOM);
  const pad = 40;
  const inside = (p: Pt) => p.x >= -pad && p.y >= -pad && p.x <= widthPx + pad && p.y <= heightPx + pad;
  const local = world.map((p) => ({ x: p.x * s - origin.x, y: p.y * s - origin.y }));
  const stroke = (color: string, w: number) => {
    let open = false;
    for (let i = 0; i < local.length; i++) {
      const p = local[i]!;
      const near = inside(p) || (i > 0 && inside(local[i - 1]!)) || (i < local.length - 1 && inside(local[i + 1]!));
      if (!near) {
        open = false;
        continue;
      }
      if (open) doc.lineTo(x0 + p.x * K, y0 + p.y * K);
      else doc.moveTo(x0 + p.x * K, y0 + p.y * K);
      open = true;
    }
    doc.lineWidth(w).lineJoin('round').lineCap('round').strokeOpacity(0.9).stroke(color);
  };
  doc.save();
  stroke('#ffffff', width + 2.5);
  stroke(ROUTE_COLOR, width);
  doc.restore();
}

function drawStop(doc: PDFKit.PDFDocument, x: number, y: number, label: string, color: string, r = 7) {
  doc.save();
  doc.circle(x, y, r).lineWidth(1.5).fillAndStroke(color, '#ffffff');
  doc.font('Helvetica-Bold').fontSize(r * 1.15).fillColor('#ffffff').text(label, x - r, y - r * 0.42, { width: 2 * r, align: 'center', lineBreak: false });
  doc.restore();
}

/** Richtungspfeil (0° = Norden) mittig im Ausschnitt */
function drawArrow(doc: PDFKit.PDFDocument, x: number, y: number, bearing: number | null) {
  doc.save();
  if (bearing !== null) {
    const a = (bearing * Math.PI) / 180;
    const dx = Math.sin(a);
    const dy = -Math.cos(a);
    const len = mm(9);
    const tip = { x: x + dx * len, y: y + dy * len };
    const head = mm(3.2);
    const nx = -dy;
    const ny = dx;
    const base = { x: tip.x - dx * head, y: tip.y - dy * head };
    doc.moveTo(x, y).lineTo(base.x, base.y).lineWidth(4.5).lineCap('round').stroke('#ffffff');
    doc.polygon([tip.x, tip.y], [base.x + nx * head * 0.75, base.y + ny * head * 0.75], [base.x - nx * head * 0.75, base.y - ny * head * 0.75]).lineWidth(1.5).fillAndStroke('#e65100', '#ffffff');
    doc.moveTo(x, y).lineTo(base.x, base.y).lineWidth(2.5).lineCap('round').stroke('#e65100');
  }
  doc.circle(x, y, 3.2).lineWidth(1.2).fillAndStroke('#e65100', '#ffffff');
  doc.restore();
}

/**
 * Routenausdruck auf A4 hoch: Kopf mit Halten, Strecke und Fahrzeit, Übersichtskarte, danach die Fahrhinweise mit je
 * einem kleinen Kartenausschnitt um die Stelle und einem Pfeil in die neue Fahrtrichtung.
 */
export async function renderRoutePdf(req: RoutePrintRequest, tiles: TileService, ctx: RoutePrintContext): Promise<{ pdf: Buffer; missingTiles: number }> {
  const source = tiles.source(req.sourceId);
  const now = ctx.now ?? new Date();
  const { route, stops } = req;
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: mm(15), bottom: mm(15), left: mm(15), right: mm(15) },
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
  const world = route.path.map(([lon, lat]) => project(lat, lon, REF_ZOOM));
  let missingTiles = 0;

  // --- Kopf ---
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111');
  text(req.title, { width });
  doc.font('Helvetica').fontSize(9.5).fillColor('#333333');
  text(`DTG ${formatDtg(now)}  ·  ${ROUTE_PROFILE_LABELS[route.profile]}  ·  ${formatDistance(route.distanceM)}  ·  ca. ${formatDuration(route.durationS)}`, { width });
  doc.moveDown(0.4);
  stops.forEach((s, i) => {
    const y = doc.y;
    drawStop(doc, left + 6, y + 5, String(i + 1), stopColor(i, stops.length), 6);
    const leg = i > 0 ? route.legs[i - 1] : undefined;
    doc.font('Helvetica').fontSize(9.5).fillColor('#111111');
    doc.text(pdfText(`${s.name || `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`}${leg ? `  (${formatDistance(leg.distanceM)}, ${formatDuration(leg.durationS)})` : ''}`), left + 16, y + 1, { width: width - 16 });
    doc.x = left;
    doc.y = Math.max(doc.y, y + 13);
  });
  doc.moveDown(0.6);

  // --- Übersichtskarte ---
  {
    const mapH = Math.min(mm(OVERVIEW_H_MM), bottom() - doc.y - mm(10));
    const wPx = width / K;
    const hPx = mapH / K;
    const { zoom, center } = fitZoom(route.path, wPx, hPx, Math.min(source.maxZoom, 17));
    const origin = { x: center.x - wPx / 2, y: center.y - hPx / 2 };
    const y0 = doc.y;
    doc.save();
    doc.rect(left, y0, width, mapH).clip();
    missingTiles += await drawTiles(doc, tiles, source.id, zoom, origin, wPx, hPx, left, y0, K);
    drawPath(doc, world, zoom, origin, wPx, hPx, left, y0, 4);
    stops.forEach((s, i) => {
      const p = project(s.lat, s.lon, zoom);
      drawStop(doc, left + (p.x - origin.x) * K, y0 + (p.y - origin.y) * K, String(i + 1), stopColor(i, stops.length));
    });
    doc.restore();
    doc.rect(left, y0, width, mapH).lineWidth(0.75).stroke('#000000');
    doc.y = y0 + mapH + 3;
    doc.x = left;
    doc.font('Helvetica').fontSize(6.5).fillColor('#555555');
    text(`Kartengrundlage: ${source.attribution} · Routing: ${route.source}`, { width });
  }

  // --- Fahrhinweise ---
  doc.moveDown(0.8);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#111111');
  text('Fahrhinweise', { width });
  doc.moveTo(left, doc.y + 1).lineTo(left + width, doc.y + 1).lineWidth(0.5).strokeColor('#999999').stroke();
  doc.moveDown(0.5);

  const box = mm(DETAIL_MM);
  const boxPx = box / K;
  const rowH = box + mm(3);
  const textX = left + box + mm(5);
  const textW = width - box - mm(5);
  const detailZoom = Math.min(DETAIL_ZOOM, source.maxZoom);
  let stop = 1;
  for (const [i, m] of route.maneuvers.entries()) {
    if (doc.y + rowH > bottom()) doc.addPage();
    const y0 = doc.y;
    const c = project(m.lat, m.lon, detailZoom);
    const origin = { x: c.x - boxPx / 2, y: c.y - boxPx / 2 };
    doc.save();
    doc.rect(left, y0, box, box).clip();
    missingTiles += await drawTiles(doc, tiles, source.id, detailZoom, origin, boxPx, boxPx, left, y0, K);
    drawPath(doc, world, detailZoom, origin, boxPx, boxPx, left, y0, 3.5);
    drawArrow(doc, left + box / 2, y0 + box / 2, m.bearingAfter ?? m.bearingBefore);
    doc.restore();
    doc.rect(left, y0, box, box).lineWidth(0.5).stroke('#555555');

    // Ziel und Zwischenziele (Valhalla-Typen 4–6) tragen die Nummer des Halts
    const arrive = m.type >= 4 && m.type <= 6;
    if (arrive) stop++;
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111');
    doc.text(`${i + 1}.`, textX, y0 + 2, { width: mm(10), lineBreak: false });
    const name = arrive ? stops[stop - 1]?.name : undefined;
    doc.text(pdfText(m.instruction + (name ? ` – ${name}` : '')), textX + mm(10), y0 + 2, { width: textW - mm(10) });
    doc.font('Helvetica').fontSize(9).fillColor('#555555');
    const detail = [m.street, m.distanceM > 0 ? `danach ${formatDistance(m.distanceM)} (${formatDuration(m.durationS)})` : null].filter(Boolean).join(' · ');
    if (detail) doc.text(pdfText(detail), textX + mm(10), doc.y + 2, { width: textW - mm(10) });
    doc.x = left;
    doc.y = y0 + rowH;
  }

  // --- Fußzeile ---
  if (doc.y + mm(14) > bottom()) doc.addPage();
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(7).fillColor('#555555');
  text(`${ctx.vehicle.callsign} · ${ctx.vehicle.organization} · Erstellt ${now.toLocaleString('de-DE')} von ${ctx.operator}`, { width });
  if (missingTiles) {
    doc.font('Helvetica-Bold').fillColor('#c62828');
    text(`Hinweis: ${missingTiles} Kartenkachel(n) nicht verfügbar (offline?)`, { width });
  }

  doc.end();
  return { pdf: await done, missingTiles };
}
