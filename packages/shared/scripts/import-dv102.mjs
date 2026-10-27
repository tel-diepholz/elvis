// Übernimmt Lagezeichen nach DV 102 aus dem Zeichensatz „Taktische-Zeichen“ von Jonas Köritz
// (https://github.com/jonas-koeritz/Taktische-Zeichen, fertige Zeichen aus release.zip: CC0, Schrift Roboto Slab: Apache 2.0).
//
//   unzip release.zip 'svg/*' -d /tmp/tz && node packages/shared/scripts/import-dv102.mjs /tmp/tz/svg
//
// Schreibt packages/shared/src/dv102.ts. Übernommen werden nur Lagezeichen (keine Fahrzeuge, Einheiten, Einrichtungen, Personen).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Personen baut ELVIS mit dem eigenen Generator (tactical.ts), darum nicht aus dem Zeichensatz
const CATEGORIES = ['Gefahren', 'Schäden', 'Maßnahmen', 'Sonstiges'];

/** Zusätzliche Suchbegriffe (Einsatzsprache), je nach Kennung */
const KEYWORDS = [
  [/^Schäden\//, 'einsturz eingestürzt gebäude trümmer schaden'],
  [/brand/i, 'feuer brand'],
  [/Wassereinbruch|Überschwemmt|Wasser/, 'wasser hochwasser überflutung flut'],
  [/Explosivstoffe/, 'sprengstoff bombe munition'],
  [/Explosion/, 'explosion ex'],
  [/Radioaktivität/, 'strahlung atom radioaktiv abc'],
  [/gefährliche_Stoffe/, 'gefahrgut chemie gefahrstoff abc'],
  [/Gas/, 'gas gasaustritt'],
  [/elektrischen_Strom/, 'strom elektrizität spannung'],
  [/Luftmangel/, 'sauerstoff atemschutz ersticken'],
  [/Mineralöl/, 'öl kraftstoff benzin diesel'],
  [/Tier/, 'tier hund katze vieh'],
];
const src = process.argv[2];
if (!src) throw new Error('Pfad zum Ordner svg/ aus release.zip fehlt');

let font = null;
const signs = [];
for (const category of CATEGORIES) {
  for (const file of readdirSync(join(src, category)).filter((f) => f.endsWith('.svg')).sort((a, b) => a.localeCompare(b, 'de'))) {
    const base = file.replace(/\.svg$/, '');
    const id = `${category}/${base}`;
    let svg = readFileSync(join(src, category, file), 'utf8');
    // Schrift einmal übernehmen statt in jedem Zeichen
    const woff = svg.match(/url\("data:application\/font-woff;charset=utf-8;base64,([A-Za-z0-9+/=]+)"\)/);
    if (woff) font ??= woff[1];
    const prefix = `dv${signs.length}-`;
    svg = svg
      .replace(/<!DOCTYPE[^>]*>/, '')
      .replace(/<title>[^<]*<\/title>/, '')
      .replace(/<style[\s\S]*?<\/style>/g, '')
      .replace(/<defs>\s*<\/defs>/g, '')
      .replace(/\sviewbox=/, ' viewBox=')
      .replace(/(<svg[^>]*?)\s(?:width|height)="256"/g, '$1')
      .replace(/(<svg[^>]*?)\s(?:width|height)="256"/g, '$1')
      .replace(/\sversion="1\.1"/, '')
      .replace(/id="([^"]+)"/g, `id="${prefix}$1"`)
      .replace(/url\(#([^)]+)\)/g, `url(#${prefix}$1)`)
      .replace(/>\s+</g, '><')
      .trim();
    const name = base.replace(/_/g, ' ');
    const search = [name, category, ...KEYWORDS.filter(([re]) => re.test(id)).map(([, words]) => words)].join(' ').toLowerCase();
    signs.push({ id, category, name, search, svg });
  }
}
if (!font) throw new Error('Schrift Roboto Slab nicht gefunden');

const out = `/**
 * Lagezeichen nach DV 102 (Gefahren, Schäden, Maßnahmen, Sonstiges) für das Kartenobjekt „Zeichen“; Personen
 * entstehen mit dem Generator in tactical.ts.
 * Quelle: Zeichensatz „Taktische-Zeichen“ von Jonas Köritz, https://github.com/jonas-koeritz/Taktische-Zeichen
 * (fertige Zeichen aus release.zip v2.0.0: CC0 1.0; Schrift Roboto Slab Bold: Apache 2.0).
 *
 * Erzeugt von scripts/import-dv102.mjs – nicht von Hand ändern. Die Weboberfläche lädt das Modul erst bei Bedarf
 * (\`@elvis/shared/dv102\`); der Server prüft damit Zeichen und zeichnet sie im Kartendruck.
 */

export const DV102_CATEGORIES = ${JSON.stringify(CATEGORIES)} as const;
export type Dv102Category = (typeof DV102_CATEGORIES)[number];

export interface Dv102Sign {
  /** „Kategorie/Dateiname“, z. B. „Gefahren/Gefahr_durch_Gas“ */
  id: string;
  category: Dv102Category;
  name: string;
  /** Name, Kategorie und Suchbegriffe (klein geschrieben) */
  search: string;
  /** SVG im Raster 256 × 256 (ohne Breite/Höhe), Text in „Roboto Slab“ */
  svg: string;
}

export const DV102_SIGNS: Dv102Sign[] = ${JSON.stringify(signs, null, 1)};

const BY_ID = new Map(DV102_SIGNS.map((s) => [s.id, s]));
export const dv102Sign = (id: string): Dv102Sign | null => BY_ID.get(id) ?? null;
export const isDv102Sign = (id: string) => BY_ID.has(id);

/** Roboto Slab Bold (WOFF, Base64) für den Text in den Zeichen */
export const DV102_FONT_WOFF = '${font}';

/** Suche über Name, Kategorie und Suchbegriffe, ohne Groß-/Kleinschreibung */
export function searchDv102(q: string): Dv102Sign[] {
  const words = q.toLowerCase().split(/\\s+/).filter(Boolean);
  return DV102_SIGNS.filter((s) => words.every((w) => s.search.includes(w)));
}
`;
writeFileSync(new URL('../src/dv102.ts', import.meta.url), out);
console.log(`${signs.length} Zeichen, ${Math.round(out.length / 1024)} KB`);
