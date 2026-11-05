/**
 * Objektbibliothek: dauerhafte Objekte unabhängig von einer Lage (Wasserentnahmestellen, Einsatzobjekte und frei
 * definierbare Typen mit eigenen Feldern). Die Karte blendet sie als Ebene ein, in eine Lage übernommen werden sie als
 * Punkt kopiert. Einsatzobjekte (und jeder andere Typ) können Dateien angehängt haben, z. B. Feuerwehrpläne.
 *
 * Jeder Datensatz trägt eine `uid` und eine Revision; damit lässt er sich später mit der Cloud abgleichen.
 */
import { z } from 'zod';
import { mapColorSchema, mapIconNameSchema, type GeoPath } from './mapobjects';
import type { GeoOutline } from './geocode';

export const OBJECT_FIELD_TYPES = ['text', 'longtext', 'number', 'select', 'bool', 'url', 'phone'] as const;
export type ObjectFieldType = (typeof OBJECT_FIELD_TYPES)[number];

export const OBJECT_FIELD_TYPE_LABELS: Record<ObjectFieldType, string> = {
  text: 'Text',
  longtext: 'Mehrzeiliger Text',
  number: 'Zahl',
  select: 'Auswahl',
  bool: 'Ja/Nein',
  url: 'Link',
  phone: 'Telefon',
};

/** Feldschlüssel: Kleinbuchstaben, Ziffern, Unterstrich (stabil, auch wenn die Beschriftung sich ändert) */
const fieldKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'Schlüssel: Kleinbuchstaben, Ziffern und _, beginnt mit einem Buchstaben');

export const objectFieldSchema = z
  .object({
    key: fieldKeySchema,
    label: z.string().trim().min(1, 'Beschriftung fehlt').max(60),
    type: z.enum(OBJECT_FIELD_TYPES),
    /** Auswahlwerte bei `select` */
    options: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
    /** Einheit hinter Zahlen, z. B. „l/min“ */
    unit: z.string().trim().max(12).default(''),
    /** Wert erscheint als Schild am Kartensymbol (höchstens ein Feld je Typ) */
    badge: z.boolean().default(false),
  })
  .superRefine((f, ctx) => {
    if (f.type === 'select' && !f.options.length) ctx.addIssue({ code: 'custom', path: ['options'], message: 'Auswahl braucht mindestens einen Wert' });
  });
export type ObjectField = z.infer<typeof objectFieldSchema>;
export type ObjectFieldInput = z.input<typeof objectFieldSchema>;

export const objectTypeInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Name fehlt').max(60),
    icon: mapIconNameSchema,
    color: mapColorSchema,
    fields: z.array(objectFieldSchema).max(40).default([]),
  })
  .superRefine((t, ctx) => {
    const keys = new Set<string>();
    t.fields.forEach((f, i) => {
      if (keys.has(f.key)) ctx.addIssue({ code: 'custom', path: ['fields', i, 'key'], message: `Schlüssel „${f.key}“ doppelt` });
      keys.add(f.key);
    });
    if (t.fields.filter((f) => f.badge).length > 1) ctx.addIssue({ code: 'custom', path: ['fields'], message: 'Nur ein Feld kann als Schild erscheinen' });
  });
export type ObjectTypeInput = z.input<typeof objectTypeInputSchema>;

/** Vordefinierte Typen: nicht löschbar, Felder lassen sich ergänzen */
export type BuiltinObjectType = 'water' | 'site';

export interface ObjectType {
  id: number;
  uid: string;
  builtin: BuiltinObjectType | null;
  name: string;
  icon: string;
  color: string;
  fields: ObjectField[];
  sort: number;
  rev: number;
  updatedAt: string;
  /** Anzahl Objekte dieses Typs */
  count: number;
}

export const WATER_KINDS = ['Hydrant Unterflur', 'Hydrant Überflur', 'Hydrant Wand', 'Löschwasserbrunnen', 'Löschteich', 'Löschwasserbehälter / Zisterne', 'Saugstelle', 'Offenes Gewässer'] as const;

/** Vorgaben der vordefinierten Typen (Seed der Migration, Wiederherstellen fehlender Pflichtfelder) */
export const BUILTIN_TYPES: Record<BuiltinObjectType, ObjectTypeInput> = {
  water: {
    name: 'Wasserentnahmestelle',
    icon: 'Droplet',
    color: '#2563eb',
    fields: [
      { key: 'art', label: 'Art', type: 'select', options: [...WATER_KINDS] },
      { key: 'dn', label: 'Nennweite (DN)', type: 'number', badge: true },
      { key: 'leistung', label: 'Leistung', type: 'number', unit: 'l/min' },
      { key: 'volumen', label: 'Volumen', type: 'number', unit: 'm³' },
      { key: 'druck', label: 'Druck', type: 'number', unit: 'bar' },
    ],
  },
  site: {
    name: 'Einsatzobjekt',
    icon: 'Building2',
    color: '#dc2626',
    fields: [
      { key: 'objektnummer', label: 'Objektnummer', type: 'text', badge: true },
      { key: 'bma', label: 'Brandmeldeanlage', type: 'bool' },
      { key: 'fsd', label: 'FSD / FBF-Standort', type: 'text' },
      { key: 'ansprechpartner', label: 'Ansprechpartner', type: 'text' },
      { key: 'telefon', label: 'Telefon', type: 'phone' },
      { key: 'gefahren', label: 'Gefahren', type: 'longtext' },
      { key: 'zufahrt', label: 'Zufahrt', type: 'longtext' },
    ],
  },
};

/** Eigenschaften eines Objekts: Werte je Feldschlüssel */
export type ObjectProps = Record<string, string | number | boolean>;

const propValueSchema = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);

/** Umriss bzw. Verlauf aus OSM (Löschteich als Fläche, Gewässer als Linie) */
export type LibraryGeometry = GeoOutline | GeoPath;

export const libraryObjectInputSchema = z.object({
  typeId: z.number().int().positive(),
  name: z.string().trim().min(1, 'Name fehlt').max(120),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  address: z.string().trim().max(200).default(''),
  notes: z.string().trim().max(5000).default(''),
  props: z.record(propValueSchema).default({}),
});
export type LibraryObjectInput = z.input<typeof libraryObjectInputSchema>;

export interface LibraryFile {
  id: number;
  uid: string;
  objectId: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
}

export interface LibraryObject {
  id: number;
  uid: string;
  typeId: number;
  name: string;
  lat: number;
  lon: number;
  address: string;
  notes: string;
  props: ObjectProps;
  /** Herkunft, z. B. „osm:N123“ bei einem OSM-Import */
  source: string | null;
  geometry: LibraryGeometry | null;
  rev: number;
  updatedAt: string;
  updatedBy: string;
  /** Anzahl angehängter Dateien */
  fileCount: number;
}

export interface LibraryObjectDetail extends LibraryObject {
  files: LibraryFile[];
}

/** Ausschnitt für die Kartenebene: s,w,n,e */
export const libraryBboxSchema = z
  .string()
  .regex(/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/)
  .transform((v) => {
    const [s, w, n, e] = v.split(',').map(Number) as [number, number, number, number];
    return { s, w, n, e };
  });

/** Höchstens so viele Objekte je Abfrage der Kartenebene */
export const LIBRARY_MAX_OBJECTS = 5000;

/** Bereinigte Eigenschaften (nur bekannte Felder, passender Typ) oder Fehlertexte */
export function cleanProps(fields: ObjectField[], props: Record<string, unknown>): { props: ObjectProps; errors: string[] } {
  const out: ObjectProps = {};
  const errors: string[] = [];
  for (const f of fields) {
    const v = props[f.key];
    if (v === undefined || v === null || v === '') continue;
    switch (f.type) {
      case 'number': {
        const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
        if (Number.isFinite(n)) out[f.key] = n;
        else errors.push(`${f.label}: keine Zahl`);
        break;
      }
      case 'bool':
        if (typeof v === 'boolean') out[f.key] = v;
        else errors.push(`${f.label}: ja oder nein erwartet`);
        break;
      case 'select':
        if (f.options.includes(String(v))) out[f.key] = String(v);
        else errors.push(`${f.label}: „${String(v)}“ ist kein erlaubter Wert`);
        break;
      case 'url': {
        const s = String(v).trim();
        if (/^https?:\/\/\S+$/i.test(s)) out[f.key] = s;
        else errors.push(`${f.label}: Link muss mit http:// oder https:// beginnen`);
        break;
      }
      default:
        out[f.key] = String(v).trim().slice(0, 2000);
    }
  }
  return { props: out, errors };
}

/** Angezeigter Wert eines Feldes, z. B. „1600 l/min“ oder „ja“; leer ohne Wert */
export function formatProp(f: ObjectField, v: ObjectProps[string] | undefined): string {
  if (v === undefined || v === '') return '';
  if (f.type === 'bool') return v ? 'ja' : 'nein';
  if (f.type === 'number') return `${String(v).replace('.', ',')}${f.unit ? ` ${f.unit}` : ''}`;
  return String(v);
}

/** Schild am Kartensymbol (Feld mit `badge`), z. B. „DN 100“ */
export function objectBadge(type: Pick<ObjectType, 'fields' | 'builtin'>, props: ObjectProps): string | null {
  const f = type.fields.find((x) => x.badge);
  const v = f ? props[f.key] : undefined;
  if (!f || v === undefined || v === '' || v === false) return null;
  if (f.key === 'dn' && type.builtin === 'water') return `DN ${v}`;
  return (f.type === 'bool' ? f.label : formatProp(f, v)).slice(0, 40);
}

/** Wasserentnahmestellen aus OSM: diese Tags übernimmt der Import */
export const OSM_WATER_QL = `[out:json][timeout:90];
(
  nwr["emergency"="fire_hydrant"]({{bbox}});
  nwr["emergency"="suction_point"]({{bbox}});
  nwr["emergency"="water_tank"]({{bbox}});
  nwr["emergency"="fire_water_pond"]({{bbox}});
  nwr["emergency"="water_source"]({{bbox}});
);
out geom;`;

const HYDRANT_KIND: Record<string, (typeof WATER_KINDS)[number]> = { underground: 'Hydrant Unterflur', pillar: 'Hydrant Überflur', wall: 'Hydrant Wand', pipe: 'Hydrant Überflur' };

/** Eigenschaften einer Wasserentnahmestelle aus OSM-Tags */
export function waterPropsFromOsm(tags: Record<string, string>): { name: string; props: ObjectProps } {
  const props: ObjectProps = {};
  const e = tags.emergency;
  let kind: string | null = null;
  if (e === 'fire_hydrant') kind = HYDRANT_KIND[tags['fire_hydrant:type'] ?? ''] ?? 'Hydrant Unterflur';
  else if (e === 'suction_point') kind = 'Saugstelle';
  else if (e === 'water_tank') kind = 'Löschwasserbehälter / Zisterne';
  else if (e === 'fire_water_pond') kind = 'Löschteich';
  else if (e === 'water_source' && tags.water_source === 'well') kind = 'Löschwasserbrunnen';
  if (kind) props.art = kind;
  const num = (v: string | undefined) => {
    const n = v ? Number.parseFloat(v.replace(',', '.')) : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };
  const dn = num(tags['fire_hydrant:diameter'] ?? tags.diameter);
  if (dn !== null) props.dn = dn;
  const flow = num(tags.flow_rate);
  if (flow !== null) props.leistung = flow;
  const vol = num(tags['water_tank:volume'] ?? tags.volume);
  if (vol !== null) props.volumen = vol;
  const p = num(tags['fire_hydrant:pressure'] ?? tags.pressure);
  if (p !== null) props.druck = p;
  const name = (tags.name ?? tags.ref ?? kind ?? 'Wasserentnahmestelle').slice(0, 120);
  return { name, props };
}
