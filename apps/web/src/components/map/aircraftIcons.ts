import L from 'leaflet';

/**
 * Flugzeugsymbole in der Art von tar1090: Farbe nach Höhe (orange tief → grün → blau → magenta hoch, grau am Boden),
 * Silhouette nach ADS-B-Kategorie bzw. ICAO-Typ. Eigene Zeichnungen (64er-Raster, Nase oben).
 */

export type AircraftShape = 'airliner' | 'heavy' | 'jet' | 'fast' | 'light' | 'helicopter' | 'glider' | 'balloon' | 'drone' | 'ground';

// --- Farbe nach Höhe (Stützstellen wie tar1090: Farbton über die Höhe, Helligkeit je Farbton ausgeglichen) ---

const HUE_BY_ALT: [number, number][] = [
  [0, 20],
  [2000, 32.5],
  [4000, 43],
  [6000, 54],
  [8000, 72],
  [9000, 85],
  [11000, 140],
  [40000, 300],
];
const LIGHT_BY_HUE: [number, number][] = [
  [0, 53], [20, 50], [32, 54], [40, 52], [46, 51], [50, 46], [60, 43], [80, 41], [100, 41], [120, 41], [140, 41], [160, 40], [180, 40], [190, 44],
  [198, 50], [200, 58], [220, 58], [240, 58], [255, 55], [266, 55], [270, 58], [280, 58], [290, 47], [300, 43], [310, 48], [320, 48], [340, 52], [360, 53],
];

function interpolate(points: [number, number][], x: number): number {
  if (x <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x0, y0] = points[i - 1]!;
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return points.at(-1)![1];
}

export const GROUND_COLOR = 'hsl(220, 0%, 45%)';
export const UNKNOWN_ALT_COLOR = 'hsl(0, 0%, 35%)';

/** Füllfarbe nach Höhe in Fuß (tar1090-Skala) */
export function altitudeColor(altFt: number | null, onGround = false): string {
  if (onGround) return GROUND_COLOR;
  if (altFt == null) return UNKNOWN_ALT_COLOR;
  const h = interpolate(HUE_BY_ALT, altFt);
  const l = interpolate(LIGHT_BY_HUE, h);
  return `hsl(${Math.round(h)}, 88%, ${Math.round(l)}%)`;
}

/** Farbskala für die Legende */
export const ALTITUDE_LEGEND = [0, 2000, 4000, 6000, 8000, 10000, 20000, 30000, 40000].map((alt) => ({ alt, color: altitudeColor(alt) }));

// --- Form ---

const HELICOPTERS = /^(EC[0-9]{2}|H1[2-7][0-9]|H160|AS[0-9]{2}|SA[0-9]{2}|R22|R44|R66|B0[0-9]|B[0-9]{3}|BK17|A1[0-9]{2}|AW[0-9]{2,3}|NH90|S76|S92|UH1|H60|EH10|MI[0-9]|KA[0-9]{2}|G2CA|EXPL|LYNX|PUMA|TIGR|ALO3|ALH)$/;
const HEAVIES = /^(A3[0-9]{2}|A30[0-9]|A31[0-9]|A33[0-9]|A34[0-9]|A35[0-9]|A38[0-9]|B74[0-9]|B76[0-9]|B77[0-9]|B78[0-9]|B79[0-9]|MD11|DC10|IL76|IL96|AN12|AN22|A124|A225|C17|C5M|A400|K35R|KC2|E3TF|E3CF|B52)$/;
const GLIDERS = /^(GLID|ASK[0-9]*|AS[0-9]{2}|DG[0-9]+|LS[0-9]|DUO|ARCP|VENT|NIMB|DISC|JS[0-9]|ANTA)$/;
const LIGHT = /^(C1[0-9]{2}|C2[0-9]{2}|C17|C42|PA[0-9]{2}|P28[A-Z]?|P32R|DA[0-9]{2}|SR2[0-9]|DR40|TB[0-9]{2}|BE[0-9]{2}|RV[0-9]+|AT[0-9]{2}|FDCT|ULAC|PC6T|PC12|M20P|AAT3|DV20|C68A|BW6T|EV97|TL20|WT9|SIRA|VL3|ZLIN|Z42|Z43)$/;

export function aircraftShape(category: string | null | undefined, type: string | null | undefined): AircraftShape {
  const t = type?.toUpperCase() ?? '';
  switch (category) {
    case 'A1':
    case 'B4':
      return 'light';
    case 'A2':
      return t && LIGHT.test(t) ? 'light' : 'jet';
    case 'A3':
    case 'A4':
      return 'airliner';
    case 'A5':
      return 'heavy';
    case 'A6':
      return 'fast';
    case 'A7':
      return 'helicopter';
    case 'B1':
      return 'glider';
    case 'B2':
      return 'balloon';
    case 'B6':
      return 'drone';
    case 'C0':
    case 'C1':
    case 'C2':
    case 'C3':
      return 'ground';
  }
  if (HELICOPTERS.test(t)) return 'helicopter';
  if (HEAVIES.test(t)) return 'heavy';
  if (GLIDERS.test(t)) return 'glider';
  if (LIGHT.test(t)) return 'light';
  return 'airliner';
}

/** SVG-Inhalt je Form (64er-Raster); F = Füllfarbe, wird ersetzt */
const SHAPES: Record<AircraftShape, { size: number; rotate: boolean; svg: string }> = {
  airliner: {
    size: 34,
    rotate: true,
    svg: '<path d="M32 3c2.2 0 3.4 2.6 3.4 5.5V22l20 11v4.5l-20-5.5v13.5l6.5 5v3.8L32 52.2l-9.9 2.1v-3.8l6.5-5V32L8.6 37.5V33l20-11V8.5C28.6 5.6 29.8 3 32 3z"/><path d="M17 27.5h4.4v6.5H17zM42.6 27.5H47v6.5h-4.4z"/>',
  },
  heavy: {
    size: 42,
    rotate: true,
    svg: '<path d="M32 2c2.8 0 4.2 3 4.2 6.5V21l23 13v5l-23-6.5V46l7 5.5v4L32 53l-11.2 2.5v-4l7-5.5V32.5L4.8 39v-5l23-13V8.5C27.8 5 29.2 2 32 2z"/><path d="M12 30h3.6v5.5H12zM20.4 25.5H24V31h-3.6zM40 25.5h3.6V31H40zM48.4 30H52v5.5h-3.6z"/>',
  },
  jet: {
    size: 30,
    rotate: true,
    svg: '<path d="M32 6c1.6 0 2.5 2 2.5 4.5V26l14 9.5v3.5l-14-4V47l5 4v3l-7.5-1.5L24.5 54v-3l5-4V35l-14 4v-3.5l14-9.5V10.5C29.5 8 30.4 6 32 6z"/><path d="M26.2 38h2.6v6h-2.6zM35.2 38h2.6v6h-2.6z"/>',
  },
  fast: { size: 30, rotate: true, svg: '<path d="M32 3l3.5 15L54 45v5l-18.5-6.5V50l6 4.5V58L32 56l-9.5 2v-3.5l6-4.5v-6.5L10 50v-5l18.5-27z"/>' },
  light: {
    size: 28,
    rotate: true,
    svg: '<path d="M30.2 9h3.6l1 7.5H58v6.5H34.8l-1.4 19h8.8v5h-8.6l-.6 6h-6l-.6-6h-8.6v-5h8.8l-1.4-19H6v-6.5h23.2z"/><path d="M24 6.6h16v2.2H24z"/>',
  },
  helicopter: {
    size: 32,
    rotate: true,
    svg: '<circle cx="32" cy="24" r="19" fill="none" stroke="F" stroke-width="2.4" opacity=".75"/><ellipse cx="32" cy="24" rx="7" ry="11"/><path d="M30.6 33h2.8v21h-2.8z"/><path d="M26 52h12v3.2H26z"/>',
  },
  glider: { size: 32, rotate: true, svg: '<path d="M31 9h2l1.2 13H62v3.4H34.2l-1 21.6h6v3.5H24.8V47h6l-1-21.6H2V22h27.8z"/>' },
  balloon: { size: 24, rotate: false, svg: '<circle cx="32" cy="26" r="17"/><path d="M27 46h10v8H27z"/>' },
  drone: {
    size: 22,
    rotate: true,
    svg: '<circle cx="18" cy="18" r="8"/><circle cx="46" cy="18" r="8"/><circle cx="18" cy="46" r="8"/><circle cx="46" cy="46" r="8"/><path d="M22 18l10 10 10-10 4 4-10 10 10 10-4 4-10-10-10 10-4-4 10-10-10-10z"/>',
  },
  ground: { size: 16, rotate: true, svg: '<rect x="18" y="10" width="28" height="44" rx="6"/><path d="M32 4l8 8H24z"/>' },
};

const cache = new Map<string, L.DivIcon>();

export interface AircraftIconInput {
  category?: string | null;
  type?: string | null;
  altFt: number | null;
  onGround: boolean;
  track: number | null;
}

/**
 * Symbol eines Flugzeugs: Silhouette nach Kategorie/Typ, gedreht nach Kurs (auf 5° gerundet), Farbe nach Höhe oder fest
 * (verfolgte Objekte); blass, wenn das Signal fehlt.
 */
export function aircraftMarker(a: AircraftIconInput, opts: { color?: string; faded?: boolean; selected?: boolean } = {}): L.DivIcon {
  const shape = aircraftShape(a.category, a.type);
  const s = SHAPES[shape];
  const fill = opts.color ?? altitudeColor(a.altFt, a.onGround);
  const rot = s.rotate ? Math.round((a.track ?? 0) / 5) * 5 : 0;
  const key = `${shape}:${fill}:${rot}:${opts.faded ? 1 : 0}:${opts.selected ? 1 : 0}`;
  let icon = cache.get(key);
  if (!icon) {
    const size = s.size + (opts.selected ? 6 : 0);
    const stroke = opts.selected ? '#fff' : '#000';
    icon = L.divIcon({
      className: 'map-marker traffic',
      html: `<svg viewBox="0 0 64 64" width="${size}" height="${size}" style="transform:rotate(${rot}deg);opacity:${opts.faded ? 0.45 : 1}"><g fill="${fill}" stroke="${stroke}" stroke-width="${opts.selected ? 2.4 : 1.6}" stroke-linejoin="round">${s.svg.replaceAll('"F"', `"${fill}"`)}</g></svg>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    cache.set(key, icon);
    if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  }
  return icon;
}
