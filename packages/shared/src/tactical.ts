import { z } from 'zod';

/**
 * Taktische Zeichen nach der Empfehlung „Taktische Zeichen im Bevölkerungsschutz“ (DV 102).
 * Das Zeichen wird als Liste geometrischer Grundelemente beschrieben; daraus entstehen SVG
 * (Browser, Karte) und PDF-Vektorgrafik (Druck) – beide sehen dadurch identisch aus.
 *
 * Koordinaten: Der Zeichenkörper liegt bei x 0…100, y 0…70; Größenordnung darüber,
 * Räder/Fahnenmast darunter, Bezeichnung rechts.
 */

export const TACTICAL_BASES = {
  unit: 'Taktische Einheit / Dienststelle',
  command: 'Befehlsstelle / Führungsstelle',
  facility: 'Stelle / Einrichtung',
  person: 'Person',
  vehicle: 'Fahrzeug',
} as const;

export const TACTICAL_MOBILITY = {
  none: 'Fahrzeug (landgebunden)',
  wheeled: 'Kraftfahrzeug',
  offroad: 'Kraftfahrzeug, geländegängig',
  tracked: 'Kettenfahrzeug',
  trailer: 'Anhänger',
} as const;

/** Grundfarbe, Umrandung/Schrift (Tabelle 2 der DV 102). */
export const TACTICAL_ORGS = {
  feuerwehr: { label: 'Feuerwehr', fill: '#ff0000', ink: '#ffffff' },
  thw: { label: 'Technisches Hilfswerk', fill: '#0000ff', ink: '#ffffff' },
  hilfsorganisation: { label: 'Hilfsorganisationen', fill: '#ffffff', ink: '#000000' },
  fuehrung: { label: 'Einrichtungen der Führung', fill: '#ffff00', ink: '#000000' },
  polizei: { label: 'Polizei, Bundespolizei, Zoll', fill: '#008000', ink: '#ffffff' },
  sonstige: { label: 'Sonstige Einrichtungen', fill: '#ffa000', ink: '#000000' },
  bundeswehr: { label: 'Bundeswehr', fill: '#996633', ink: '#000000' },
} as const;

export const TACTICAL_SIZES = {
  none: 'keine',
  trupp: 'Trupp',
  staffel: 'Staffel',
  gruppe: 'Gruppe',
  zug: 'Zug',
  verband1: 'Bereitschaft (Verband I)',
  verband2: 'Abteilung (Verband II)',
  verband3: 'Großverband (Verband III)',
} as const;

export const TACTICAL_FUNCTIONS = {
  none: 'keine',
  fuehrung: 'Führung, Leitung, Stab',
  brandbekaempfung: 'Brandbekämpfung / Löscheinsatz',
  rettung: 'Rettungs- und Sanitätswesen',
  technischeHilfe: 'Technische Hilfeleistung',
  iuk: 'Information und Kommunikation (IuK)',
  betreuung: 'Betreuung',
  logistik: 'Versorgung, Logistik',
} as const;

/** Symbol über dem Zeichen (z. B. Dach bei Leitstellen). */
export const TACTICAL_ABOVE = {
  none: 'keines',
  roof: 'Dach (Gebäude, z. B. Leitstelle)',
} as const;

/** Symbol im Zeichen (z. B. Schleife bei Hubschraubern). */
export const TACTICAL_INSIDE = {
  none: 'keines',
  loop: 'Schleife (z. B. Hubschrauber)',
} as const;

type Keys<T> = [keyof T & string, ...(keyof T & string)[]];
const keys = <T extends object>(o: T) => Object.keys(o) as Keys<T>;

export const tacticalSignSchema = z.object({
  base: z.enum(keys(TACTICAL_BASES)).default('vehicle'),
  mobility: z.enum(keys(TACTICAL_MOBILITY)).default('wheeled'),
  org: z.enum(keys(TACTICAL_ORGS)).default('feuerwehr'),
  size: z.enum(keys(TACTICAL_SIZES)).default('none'),
  function: z.enum(keys(TACTICAL_FUNCTIONS)).default('none'),
  /** Kurzbezeichnung im Zeichen, z. B. „ELW 2“. */
  text: z.string().max(12).default(''),
  /** Organisationskürzel unten rechts im Zeichen, z. B. „FW“. */
  orgLabel: z.string().max(6).default(''),
  /** Bezeichnung/Herkunft rechts neben dem Zeichen. */
  label: z.string().max(40).default(''),
  /** Symbol über dem Zeichen; die Größenordnung rückt darüber. */
  above: z.enum(keys(TACTICAL_ABOVE)).default('none'),
  /** Symbol im Zeichen, hinter Fachaufgabe und Text. */
  inside: z.enum(keys(TACTICAL_INSIDE)).default('none'),
  /** Nur Person: Führer (obere Spitze ausgefüllt). */
  leader: z.boolean().default(false),
});

export type TacticalSign = z.infer<typeof tacticalSignSchema>;

export const DEFAULT_VEHICLE_SIGN: TacticalSign = {
  base: 'vehicle',
  mobility: 'wheeled',
  org: 'feuerwehr',
  size: 'none',
  function: 'fuehrung',
  text: 'ELW 2',
  above: 'none',
  inside: 'none',
  orgLabel: '',
  label: '',
  leader: false,
};

// --- Geometrie ---

export type TacticalPrimitive =
  | { kind: 'path'; d: string; fill?: string; stroke?: string; width?: number }
  | { kind: 'circle'; cx: number; cy: number; r: number; fill?: string; stroke?: string; width?: number }
  | { kind: 'text'; x: number; y: number; text: string; size: number; fill: string; anchor: 'start' | 'middle' | 'end'; bold?: boolean };

export interface TacticalGeometry {
  primitives: TacticalPrimitive[];
  /** Umgebendes Rechteck aller Elemente. */
  box: { x: number; y: number; width: number; height: number };
  /** Mittelpunkt des Zeichenkörpers (Bezugspunkt auf der Karte). */
  anchor: { x: number; y: number };
}

const W = 100;
const H = 70;
const STROKE = 2.5;
/** Durchhang der gewölbten Fahrzeug-Oberkante. */
const SAG = 9;

function bodyPath(base: TacticalSign['base']): string {
  switch (base) {
    case 'vehicle':
      return `M0,0 Q${W / 2},${2 * SAG} ${W},0 L${W},${H} L0,${H} Z`;
    case 'facility':
      return `M${W / 2 - H / 2},${H / 2} a${H / 2},${H / 2} 0 1,0 ${H},0 a${H / 2},${H / 2} 0 1,0 ${-H},0 Z`;
    case 'person':
      return `M${W / 2},0 L${W / 2 + H / 2},${H / 2} L${W / 2},${H} L${W / 2 - H / 2},${H / 2} Z`;
    default:
      return `M0,0 L${W},0 L${W},${H} L0,${H} Z`;
  }
}

/** Balken an der Ober- bzw. Unterkante, auf die Körperform (Kreis, Raute, Wölbung) begrenzt – ragt nicht heraus. */
function bodyBand(base: TacticalSign['base'], edge: 'top' | 'bottom', t: number): string {
  const y = edge === 'top' ? t : H - t;
  const up = edge === 'top';
  if (base === 'facility') {
    const r = H / 2;
    const dx = Math.sqrt(Math.max(0, r * r - (y - r) ** 2)).toFixed(2);
    return `M${W / 2 - Number(dx)},${y} A${r},${r} 0 0,${up ? 1 : 0} ${W / 2 + Number(dx)},${y} Z`;
  }
  if (base === 'person') {
    const hw = up ? y : H - y;
    return up ? `M${W / 2},0 L${W / 2 + hw},${y} L${W / 2 - hw},${y} Z` : `M${W / 2 - hw},${y} L${W / 2 + hw},${y} L${W / 2},${H} Z`;
  }
  if (base === 'vehicle' && up) return `M0,0 Q${W / 2},${2 * SAG} ${W},0 L${W},${t} Q${W / 2},${2 * SAG + t} 0,${t} Z`;
  return up ? `M0,0 L${W},0 L${W},${t} L0,${t} Z` : `M0,${y} L${W},${y} L${W},${H} L0,${H} Z`;
}

/** Fachaufgabenzeichen in einem Feld (x0,y0)–(x1,y1) des Zeichenkörpers. */
function functionSymbol(fn: TacticalSign['function'], base: TacticalSign['base'], ink: string, f: { x0: number; y0: number; x1: number; y1: number }): TacticalPrimitive[] {
  const cx = (f.x0 + f.x1) / 2;
  const cy = (f.y0 + f.y1) / 2;
  const w = f.x1 - f.x0;
  const h = f.y1 - f.y0;
  const line = (d: string): TacticalPrimitive => ({ kind: 'path', d, stroke: ink, width: STROKE });
  switch (fn) {
    case 'fuehrung': {
      // Breiter Balken an der Oberkante (folgt bei Fahrzeugen der Wölbung)
      const t = 11;
      return [{ kind: 'path', d: bodyBand(base, 'top', t), fill: ink }];
    }
    case 'logistik':
      return [{ kind: 'path', d: bodyBand(base, 'bottom', 10), fill: ink }];
    case 'brandbekaempfung': {
      const jx = f.x0 + w * 0.62;
      return [line(`M${f.x0 + w * 0.08},${cy} L${jx},${cy} M${jx},${cy} L${f.x1 - w * 0.06},${cy - h * 0.32} M${jx},${cy} L${f.x1 - w * 0.06},${cy + h * 0.32}`)];
    }
    case 'rettung':
      return [line(`M${f.x0 + w * 0.08},${cy} L${f.x1 - w * 0.08},${cy} M${cx},${cy - h * 0.38} L${cx},${cy + h * 0.38}`)];
    case 'technischeHilfe': {
      const bw = w * 0.26;
      const bh = h * 0.3;
      return [
        line(`M${f.x0 + w * 0.08},${cy} L${cx - bw / 2},${cy} M${cx + bw / 2},${cy} L${f.x1 - w * 0.08},${cy}`),
        line(`M${cx - bw / 2},${cy - bh / 2} L${cx + bw / 2},${cy - bh / 2} L${cx + bw / 2},${cy + bh / 2} L${cx - bw / 2},${cy + bh / 2} Z M${cx - bw / 2 + 3},${cy} L${cx + bw / 2 - 3},${cy}`),
      ];
    }
    case 'iuk':
      return [line(`M${f.x0 + w * 0.2},${cy - h * 0.38} L${cx + w * 0.02},${cy + h * 0.06} L${cx - w * 0.02},${cy - h * 0.1} L${f.x1 - w * 0.2},${cy + h * 0.38}`)];
    case 'betreuung':
      return [line(`M${f.x0 + w * 0.25},${cy + h * 0.36} L${cx},${cy - h * 0.36} L${f.x1 - w * 0.25},${cy + h * 0.36}`)];
    default:
      return [];
  }
}

/** Größenordnungszeichen über dem Zeichen; liefert die belegte Höhe. */
function sizeMarks(size: TacticalSign['size'], topY: number, out: TacticalPrimitive[]): number {
  const r = 3.6;
  const dot = (x: number, y: number) => out.push({ kind: 'circle', cx: x, cy: y, r, fill: '#000000' });
  const bar = (x: number) => out.push({ kind: 'path', d: `M${x - 2.6},${topY - 4} L${x + 2.6},${topY - 4} L${x + 2.6},${topY - 20} L${x - 2.6},${topY - 20} Z`, fill: '#000000' });
  const y = topY - 4 - r;
  switch (size) {
    case 'trupp':
      dot(W / 2, y);
      return 12;
    case 'staffel':
      dot(W / 2, y);
      dot(W / 2, y - 2 * r - 2.5);
      return 21;
    case 'gruppe':
      dot(W / 2 - 5.5, y);
      dot(W / 2 + 5.5, y);
      return 12;
    case 'zug':
      [-11, 0, 11].forEach((dx) => dot(W / 2 + dx, y));
      return 12;
    case 'verband1':
      bar(W / 2);
      return 21;
    case 'verband2':
      [-5, 5].forEach((dx) => bar(W / 2 + dx));
      return 21;
    case 'verband3':
      [-10, 0, 10].forEach((dx) => bar(W / 2 + dx));
      return 21;
    default:
      return 0;
  }
}

/** Baut das Zeichen als Liste geometrischer Grundelemente. */
export function buildTacticalSign(input: Partial<TacticalSign>): TacticalGeometry {
  const s = tacticalSignSchema.parse(input);
  const org = TACTICAL_ORGS[s.org];
  const vehicle = s.base === 'vehicle';
  const out: TacticalPrimitive[] = [];
  let minX = 0;
  let maxX = W;
  let maxY = H + STROKE / 2;

  // Körper
  out.push({ kind: 'path', d: bodyPath(s.base), fill: org.fill, stroke: '#000000', width: STROKE });

  // Person als Führer: obere Spitze ausgefüllt
  if (s.base === 'person' && s.leader) {
    out.push({ kind: 'path', d: `M${W / 2},0 L${W / 2 + H / 4},${H / 4} L${W / 2 - H / 4},${H / 4} Z`, fill: '#000000' });
  }

  // Symbol im Zeichen: Schleife (Hubschrauber), hinter Fachaufgabe und Text
  if (s.inside === 'loop') {
    const r = s.base === 'facility' || s.base === 'person' ? H * 0.3 : H * 0.34;
    out.push({ kind: 'circle', cx: W / 2, cy: H / 2 + (vehicle ? SAG / 3 : 0), r, stroke: org.ink, width: STROKE });
  }

  // Fachaufgabe; bei Text rücken Linien-Symbole in den oberen Bereich
  const top = vehicle ? SAG + 2 : 0;
  const lineSymbol = !['none', 'fuehrung', 'logistik'].includes(s.function);
  const field = { x0: 6, y0: top + 4, x1: W - 6, y1: s.text && lineSymbol ? H * 0.55 : H - 4 };
  if (s.base === 'person' || s.base === 'facility') Object.assign(field, { x0: W / 2 - H * 0.3, x1: W / 2 + H * 0.3 });
  out.push(...functionSymbol(s.function, s.base, org.ink, field));

  // Text im Zeichen
  if (s.text) {
    const len = s.text.length;
    const size = Math.min(26, (s.base === 'unit' || s.base === 'command' || vehicle ? 86 : 52) / Math.max(1, len * 0.62));
    const textTop = s.function === 'fuehrung' ? 11 + (vehicle ? SAG : 0) : top;
    const textBottom = s.function === 'logistik' ? H - 10 : H;
    const y = lineSymbol ? H * 0.86 : (textTop + textBottom) / 2 + size * 0.36;
    out.push({ kind: 'text', x: W / 2, y, text: s.text, size, fill: org.ink, anchor: 'middle', bold: true });
  }

  // Organisationskürzel unten rechts
  if (s.orgLabel) out.push({ kind: 'text', x: W - 4, y: H - 4, text: s.orgLabel, size: 10, fill: org.ink, anchor: 'end', bold: true });

  // Unterbau: Räder, Kette, Deichsel, Fahnenmast
  if (vehicle) {
    const wheel = (x: number) => out.push({ kind: 'circle', cx: x, cy: H + 6.5, r: 4.5, fill: '#ffffff', stroke: '#000000', width: 2 });
    if (s.mobility === 'wheeled') [16, W - 16].forEach(wheel);
    if (s.mobility === 'offroad') [16, W / 2, W - 16].forEach(wheel);
    if (s.mobility === 'tracked') out.push({ kind: 'path', d: `M10,${H + 2} L${W - 10},${H + 2} A5,5 0 0,1 ${W - 10},${H + 12} L10,${H + 12} A5,5 0 0,1 10,${H + 2} Z`, fill: '#ffffff', stroke: '#000000', width: 2 });
    if (s.mobility === 'trailer') {
      out.push({ kind: 'path', d: `M-14,${H / 2} L0,${H / 2}`, stroke: '#000000', width: STROKE });
      minX = -14;
    }
    if (s.mobility !== 'none' && s.mobility !== 'trailer') maxY = H + 13;
  }
  if (s.base === 'command') {
    out.push({ kind: 'path', d: `M0,${H} L0,${H + 26}`, stroke: '#000000', width: STROKE });
    maxY = H + 26;
  }

  // Symbol über dem Zeichen: Dach (Gebäude); die Größenordnung sitzt darüber
  let topY = s.base === 'person' ? -1 : 0;
  let roofTop = -STROKE / 2;
  if (s.above === 'roof') {
    const round = s.base === 'facility' || s.base === 'person';
    const [eaves, apex] = round ? [12, -12] : [-2, -18];
    out.push({ kind: 'path', d: `M${W * 0.12},${eaves} L${W / 2},${apex} L${W * 0.88},${eaves}`, stroke: '#000000', width: STROKE + 1 });
    topY = apex - 2;
    roofTop = apex - (STROKE + 1) / 2;
  }

  // Größenordnung oben
  const marks = sizeMarks(s.size, topY, out);
  const minY = marks ? topY - marks : roofTop;

  // Bezeichnung rechts
  if (s.label) {
    out.push({ kind: 'text', x: W + 8, y: H / 2 + 5, text: s.label, size: 14, fill: '#000000', anchor: 'start', bold: true });
    maxX = W + 8 + s.label.length * 14 * 0.6;
  }

  return {
    primitives: out,
    box: { x: minX - STROKE, y: minY - STROKE, width: maxX - minX + 2 * STROKE, height: maxY - minY + 2 * STROKE },
    anchor: { x: W / 2, y: H / 2 },
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** SVG-Darstellung; `height` in Pixeln (Breite ergibt sich aus dem Seitenverhältnis). */
export function tacticalSignSvg(input: Partial<TacticalSign>, opts: { height?: number; title?: string } = {}): string {
  const g = buildTacticalSign(input);
  const { x, y, width, height } = g.box;
  const h = opts.height ?? height;
  const w = (width / height) * h;
  const body = g.primitives
    .map((p) => {
      if (p.kind === 'path') return `<path d="${p.d}" fill="${p.fill ?? 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.width ?? STROKE}" stroke-linejoin="round" stroke-linecap="round"` : ''}/>`;
      if (p.kind === 'circle') return `<circle cx="${p.cx}" cy="${p.cy}" r="${p.r}" fill="${p.fill ?? 'none'}"${p.stroke ? ` stroke="${p.stroke}" stroke-width="${p.width ?? STROKE}"` : ''}/>`;
      return `<text x="${p.x}" y="${p.y}" font-size="${p.size.toFixed(1)}" font-family="Arial, Helvetica, sans-serif"${p.bold ? ' font-weight="700"' : ''} fill="${p.fill}" text-anchor="${p.anchor}">${esc(p.text)}</text>`;
    })
    .join('');
  const title = opts.title ? `<title>${esc(opts.title)}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" role="img">${title}${body}</svg>`;
}

/** Lesbare Beschreibung, z. B. für Alternativtexte. */
export function describeTacticalSign(s: TacticalSign): string {
  const parts: string[] = [s.base === 'vehicle' ? TACTICAL_MOBILITY[s.mobility] : TACTICAL_BASES[s.base], TACTICAL_ORGS[s.org].label];
  if (s.function !== 'none') parts.push(TACTICAL_FUNCTIONS[s.function]);
  if (s.size !== 'none') parts.push(TACTICAL_SIZES[s.size]);
  if (s.text) parts.push(`„${s.text}“`);
  return parts.join(', ');
}
