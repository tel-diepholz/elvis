import PDFDocument from 'pdfkit';
import { WARNING_LEVEL, formatDtg, weatherCodeText, type VehicleInfo, type WeatherReport, type WeatherState } from '@elvis/shared';
import { pdfText } from './print.js';

const PT_PER_MM = 72 / 25.4;
const mm = (v: number) => v * PT_PER_MM;

const TZ = 'Europe/Berlin';
const fmtDateTime = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtHour = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit' });
const fmtWarn = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

const DIRS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg: number) => DIRS[Math.round(deg / 22.5) % 16]!;
const num = (n: number | null, digits = 1) => (n === null ? '–' : n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const dir = (deg: number | null) => (deg === null ? '–' : `${compass(deg)} (${Math.round(deg)}°)`);

export interface WeatherPrintContext {
  vehicle: VehicleInfo;
  operator: string;
  /** Standort der Prognose, z. B. „Gemeinde Vogtei“ oder Koordinaten */
  place: string;
  /** Messwerte der Wetterstation; die GPS-Angaben werden nicht gedruckt. */
  station: { state: WeatherState; online: boolean; updatedAt: string } | null;
  /** Böen ab diesem Wert hervorheben (m/s) */
  stormLimitMs: number;
  now?: Date;
}

/** Wetterbericht auf A4 hoch: Warnungen, Messwerte der Wetterstation, Prognose für 24 Stunden und 7 Tage. */
export async function renderWeatherPdf(report: WeatherReport | null, ctx: WeatherPrintContext): Promise<Buffer> {
  const now = ctx.now ?? new Date();
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: mm(15), bottom: mm(15), left: mm(15), right: mm(15) },
    info: { Title: 'Wetterbericht', Author: pdfText(`${ctx.vehicle.callsign} – ${ctx.operator}`), Creator: 'ELVIS' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const text = (s: string, opts: PDFKit.Mixins.TextOptions = {}) => doc.text(pdfText(s), opts);
  const heading = (s: string) => {
    if (doc.y > doc.page.height - mm(45)) doc.addPage();
    doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor('#111111');
    text(s, { width });
    doc.moveTo(left, doc.y + 1).lineTo(left + width, doc.y + 1).lineWidth(0.5).strokeColor('#999999').stroke();
    doc.moveDown(0.4).font('Helvetica').fontSize(9.5);
  };
  /** Tabelle mit festen Spaltenbreiten (Anteile von `width`); Kopfzeile fett */
  const table = (cols: { title: string; share: number; align?: 'left' | 'right' }[], rows: { cells: string[]; alarm?: boolean }[]) => {
    const widths = cols.map((c) => c.share * width);
    const row = (cells: string[], font: string, color: string) => {
      if (doc.y > doc.page.height - mm(20)) doc.addPage();
      const y = doc.y;
      doc.font(font).fontSize(9).fillColor(color);
      let x = left;
      let h = 0;
      cells.forEach((c, i) => {
        doc.text(pdfText(c), x + 4, y, { width: widths[i]! - 8, align: cols[i]!.align ?? 'left' });
        h = Math.max(h, doc.y - y);
        x += widths[i]!;
      });
      doc.x = left;
      doc.y = y + h + 2;
    };
    row(
      cols.map((c) => c.title),
      'Helvetica-Bold',
      '#111111',
    );
    for (const r of rows) row(r.cells, r.alarm ? 'Helvetica-Bold' : 'Helvetica', r.alarm ? '#c62828' : '#222222');
    doc.font('Helvetica').fontSize(9.5).fillColor('#222222');
  };
  const gust = (ms: number | null) => ms !== null && ms >= ctx.stormLimitMs;

  // --- Kopf ---
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111');
  text('Wetterbericht', { width });
  doc.font('Helvetica').fontSize(10).fillColor('#333333');
  text(`${ctx.place}  ·  DTG ${formatDtg(now)}`, { width });
  text(`${ctx.vehicle.callsign} · ${ctx.vehicle.organization}  ·  erstellt ${fmtDateTime.format(now)} von ${ctx.operator}`, { width });

  // --- Warnungen ---
  heading('Amtliche Warnungen (DWD)');
  const warnings = report?.warnings;
  if (!warnings) text(report?.warningsError ? `Nicht abrufbar: ${report.warningsError}` : 'Nicht verfügbar.', { width });
  else if (!warnings.items.length) text(`Für ${warnings.area ?? 'diesen Standort'} liegen keine Warnungen vor (Stand ${fmtDateTime.format(new Date(warnings.fetchedAt))}).`, { width });
  else {
    for (const w of [...warnings.items].sort((a, b) => WARNING_LEVEL[b.severity].level - WARNING_LEVEL[a.severity].level)) {
      const lvl = WARNING_LEVEL[w.severity];
      doc.font('Helvetica-Bold').fillColor(lvl.level >= 3 ? '#c62828' : '#111111');
      text(`${lvl.label} (Stufe ${lvl.level}): ${w.headline}`, { width });
      doc.font('Helvetica').fillColor('#333333');
      text(`${fmtWarn.format(new Date(w.onset))} bis ${w.expires ? fmtWarn.format(new Date(w.expires)) : 'auf Weiteres'}`, { width });
      if (w.description) text(w.description, { width });
      if (w.instruction) text(w.instruction, { width });
      doc.moveDown(0.4);
    }
  }

  // --- Wetterstation (ohne GPS) ---
  const st = ctx.station;
  if (st) {
    heading(`Wetterstation am Fahrzeug${st.online ? '' : ' – keine aktuellen Daten'}`);
    const s = st.state;
    const rows: [string, string][] = [
      ['Mittelwind (2 min)', s.windSpeedMs === null ? '–' : `${num(s.windSpeedMs)} m/s (${num(s.windSpeedMs * 3.6, 0)} km/h)`],
      ['Böen (10 min)', s.windGustMs === null ? '–' : `${num(s.windGustMs)} m/s (${num(s.windGustMs * 3.6, 0)} km/h)`],
      ['Wind aus', dir(s.windDirectionDeg)],
      ['Ausbreitung nach (Rauch / Gefahrstoffe)', s.windDirectionDeg === null ? '–' : compass((s.windDirectionDeg + 180) % 360)],
      ['Temperatur', s.temperatureC === null ? '–' : `${num(s.temperatureC)} °C`],
      ['Luftdruck', s.pressureHpa === null ? '–' : `${num(s.pressureHpa, 0)} hPa`],
    ];
    for (const [k, v] of rows) {
      const y = doc.y;
      doc.font('Helvetica').fillColor('#555555').text(pdfText(k), left, y, { width: width * 0.45 });
      doc.font('Helvetica-Bold').fillColor(k.startsWith('Böen') && gust(s.windGustMs) ? '#c62828' : '#111111').text(pdfText(v), left + width * 0.45, y, { width: width * 0.55 });
      doc.x = left;
    }
    doc.font('Helvetica').fontSize(8.5).fillColor('#555555');
    text(`Messwerte vom ${fmtDateTime.format(new Date(st.updatedAt))}`, { width });
    doc.fontSize(9.5);
  }

  // --- Prognose ---
  const fc = report?.forecast;
  if (!fc) {
    heading('Prognose');
    text(`Keine Prognose verfügbar${report?.forecastError ? `: ${report.forecastError}` : ''}.`, { width });
  } else {
    const c = fc.current;
    heading(`Aktuell laut Prognose (${fmtHour.format(new Date(c.time))} Uhr)`);
    text(
      [
        `${weatherCodeText(c.weatherCode)}, ${num(c.temperatureC)} °C (gefühlt ${num(c.feelsLikeC)} °C)`,
        `Wind ${num(c.windSpeedMs)} m/s aus ${dir(c.windDirectionDeg)}, Böen ${num(c.windGustMs)} m/s`,
        `Luftfeuchte ${num(c.humidityPercent, 0)} %, Niederschlag ${num(c.precipitationMm)} mm, Bewölkung ${num(c.cloudCoverPercent, 0)} %, Luftdruck ${num(c.pressureHpa, 0)} hPa`,
      ].join('\n'),
      { width },
    );

    heading('Nächste 24 Stunden');
    table(
      [
        { title: 'Zeit', share: 0.1 },
        { title: 'Wetter', share: 0.3 },
        { title: 'Temp.', share: 0.1, align: 'right' },
        { title: 'Regen', share: 0.12, align: 'right' },
        { title: 'Wind', share: 0.12, align: 'right' },
        { title: 'Böen', share: 0.12, align: 'right' },
        { title: 'aus', share: 0.14 },
      ],
      fc.hourly
        .filter((_, i) => i % 2 === 0)
        .map((h) => ({
          alarm: gust(h.windGustMs),
          cells: [
            fmtHour.format(new Date(h.time)),
            weatherCodeText(h.weatherCode),
            h.temperatureC === null ? '–' : `${num(h.temperatureC)} °C`,
            h.precipitationProbability === null ? '–' : `${h.precipitationProbability} %`,
            `${num(h.windSpeedMs)} m/s`,
            `${num(h.windGustMs)} m/s`,
            h.windDirectionDeg === null ? '–' : compass(h.windDirectionDeg),
          ],
        })),
    );

    heading('7 Tage');
    table(
      [
        { title: 'Tag', share: 0.13 },
        { title: 'Wetter', share: 0.27 },
        { title: 'Min / Max', share: 0.16, align: 'right' },
        { title: 'Niederschlag', share: 0.18, align: 'right' },
        { title: 'Wind / Böen', share: 0.17, align: 'right' },
        { title: 'aus', share: 0.09 },
      ],
      fc.daily.map((d) => ({
        alarm: gust(d.windGustMaxMs),
        cells: [
          fmtDay.format(new Date(d.date)),
          weatherCodeText(d.weatherCode),
          `${num(d.tempMinC, 0)} / ${num(d.tempMaxC, 0)} °C`,
          `${num(d.precipitationMm)} mm${d.precipitationProbability === null ? '' : ` · ${d.precipitationProbability} %`}`,
          `${num(d.windSpeedMaxMs, 0)} / ${num(d.windGustMaxMs, 0)} m/s`,
          d.windDirectionDeg === null ? '–' : compass(d.windDirectionDeg),
        ],
      })),
    );
    doc.moveDown(0.6).font('Helvetica').fontSize(8).fillColor('#555555');
    text(
      `Rot: Böen ab ${num(ctx.stormLimitMs, 0)} m/s. Prognose vom ${fmtDateTime.format(new Date(fc.fetchedAt))}${report?.forecastError ? ` (${report.forecastError})` : ''}: Open-Meteo.com (Modelle u. a. DWD ICON). Warnungen: Deutscher Wetterdienst über Bright Sky.`,
      { width },
    );
  }

  doc.end();
  return done;
}
