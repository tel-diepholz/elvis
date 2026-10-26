import { z } from 'zod';

/**
 * Kartenquellen, die Admins in den Einstellungen pflegen (zusätzlich zu elvis.json und Addons).
 * XYZ-Dienste nutzen {z}/{x}/{y}, WMS-Dienste {bbox} (EPSG:3857) mit {width}/{height}.
 */
export const MAP_SOURCE_PLACEHOLDERS: { key: string; label: string }[] = [
  { key: '{z}', label: 'Zoomstufe' },
  { key: '{x}', label: 'Kachelspalte' },
  { key: '{y}', label: 'Kachelzeile' },
  { key: '{s}', label: 'Subdomain (a, b, c)' },
  { key: '{r}', label: '„@2x“ bei hochauflösenden Kacheln' },
  { key: '{bbox}', label: 'WMS: Ausschnitt in EPSG:3857 (minx,miny,maxx,maxy)' },
  { key: '{width}', label: 'WMS: Bildbreite in Pixel' },
  { key: '{height}', label: 'WMS: Bildhöhe in Pixel' },
];

export const mapSourceInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'nur Kleinbuchstaben, Ziffern und Bindestriche'),
  name: z.string().trim().min(1, 'Name fehlt').max(80),
  url: z
    .string()
    .trim()
    .regex(/^https?:\/\//, 'muss mit http:// oder https:// beginnen')
    .max(1000)
    .refine((u) => u.includes('{bbox}') || ['{z}', '{x}', '{y}'].every((p) => u.includes(p)), 'braucht {z}, {x} und {y} oder (WMS) {bbox}'),
  attribution: z.string().trim().max(200).default(''),
  maxZoom: z.number().int().min(1).max(22).default(19),
  /** 2 für hochauflösende Kacheln (512 px je Kachel), verbessert die Druckschärfe. */
  pixelRatio: z.union([z.literal(1), z.literal(2)]).default(1),
  /** Verwendungszweck: Standard, Dunkelmodus oder Druck. */
  variant: z.enum(['light', 'dark', 'print']).optional(),
  /** Kacheln zwischenspeichern (offline verfügbar). */
  cache: z.boolean().default(true),
});

export type MapSourceInput = z.infer<typeof mapSourceInputSchema>;

export const mapSourceListSchema = z
  .array(mapSourceInputSchema)
  .max(30)
  .refine((l) => new Set(l.map((s) => s.id)).size === l.length, 'Kennungen doppelt');

export type MapSourceOrigin = 'config' | 'settings' | 'addon';

export interface MapSourceEntry extends MapSourceInput {
  origin: MapSourceOrigin;
}

export interface MapSourceSettings {
  /** Alle Quellen in der Reihenfolge der Kartenstil-Auswahl; nur origin „settings“ ist hier bearbeitbar. */
  sources: MapSourceEntry[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface MapSourceTestResult {
  ok: boolean;
  contentType: string | null;
  error: string | null;
}

/** WMS-GetMap-Vorlage für den Kachel-Proxy (EPSG:3857, JPEG) */
const wms = (base: string, layers: string) =>
  `${base}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layers}&STYLES=&CRS=EPSG:3857&BBOX={bbox}&WIDTH={width}&HEIGHT={height}&FORMAT=image/jpeg`;

/** Luftbilder (DOP20) der Vermessungsverwaltungen, frei nutzbar; Lizenzangaben laut Dienstbeschreibung bzw. OSM editor-layer-index. */
const DOP: { state: string; id: string; base: string; layers: string; attribution: (year: number) => string }[] = [
  { state: 'Baden-Württemberg', id: 'dop-bw', base: 'https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C', layers: 'IMAGES_DOP_20_RGB', attribution: (y) => `LGL-BW (${y}), dl-de/by-2-0, www.lgl-bw.de` },
  { state: 'Bayern', id: 'dop-by', base: 'https://geoservices.bayern.de/od/wms/dop/v1/dop20', layers: 'by_dop20c', attribution: (y) => `© Bayerische Vermessungsverwaltung ${y}, CC BY 4.0` },
  { state: 'Berlin und Brandenburg', id: 'dop-bebb', base: 'https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms', layers: 'bebb_dop20c', attribution: () => '© GeoBasis-DE/LGB, dl-de/by-2-0' },
  { state: 'Bremen', id: 'dop-hb', base: 'https://geodienste.bremen.de/wms_dop20_2023', layers: 'DOP20_2023_HB,DOP20_2023_BHV', attribution: () => '© Landesamt GeoInformation Bremen' },
  { state: 'Hamburg', id: 'dop-hh', base: 'https://geodienste.hamburg.de/wms_dop_zeitreihe_unbelaubt', layers: 'dop_zeitreihe_unbelaubt', attribution: () => '© Freie und Hansestadt Hamburg, LGV' },
  { state: 'Hessen', id: 'dop-he', base: 'https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows', layers: 'he_dop20_rgb', attribution: () => 'Geobasisdaten © Hessische Verwaltung für Bodenmanagement und Geoinformation' },
  { state: 'Mecklenburg-Vorpommern', id: 'dop-mv', base: 'https://www.geodaten-mv.de/dienste/adv_dop', layers: 'mv_dop', attribution: (y) => `© GeoBasis-DE/MV ${y}, CC BY 4.0` },
  { state: 'Niedersachsen', id: 'lgln-dop', base: 'https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms', layers: 'ni_dop20', attribution: (y) => `© GeoBasis-DE/LGLN ${y}, CC BY 4.0` },
  { state: 'Nordrhein-Westfalen', id: 'dop-nw', base: 'https://www.wms.nrw.de/geobasis/wms_nw_dop', layers: 'nw_dop_rgb', attribution: (y) => `© Land NRW (${y}), dl-de/zero-2-0` },
  { state: 'Rheinland-Pfalz', id: 'dop-rp', base: 'https://geo4.service24.rlp.de/wms/rp_dop20.fcgi', layers: 'rp_dop20', attribution: (y) => `© GeoBasis-DE / LVermGeoRP ${y}, dl-de/by-2-0` },
  { state: 'Saarland', id: 'dop-sl', base: 'https://geoportal.saarland.de/freewms/truedop', layers: 'sl_dop20_rgb', attribution: () => '© LVGL Saarland, dl-de/by-2-0' },
  { state: 'Sachsen', id: 'dop-sn', base: 'https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest', layers: 'sn_dop_020', attribution: () => '© GeoSN, dl-de/by-2-0' },
  { state: 'Schleswig-Holstein', id: 'dop-sh', base: 'https://dienste.gdi-sh.de/WMS_SH_DOP20col_OpenGBD', layers: 'sh_dop20_rgb', attribution: () => '© GeoBasis-DE/LVermGeo SH, CC BY 4.0' },
  { state: 'Thüringen', id: 'dop-th', base: 'https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP', layers: 'th_dop', attribution: () => '© GeoBasis-DE/TLBG, dl-de/by-2-0' },
];

/** Vorlagen für die Einstellungen; die Quellenangabe enthält das aktuelle Jahr. */
export function mapSourcePresets(year = new Date().getFullYear()): (MapSourceInput & { label: string })[] {
  return DOP.map((d) => ({
    label: `Luftbild ${d.state}`,
    id: d.id,
    name: `Luftbild ${d.state}`,
    url: wms(d.base, d.layers),
    attribution: d.attribution(year),
    maxZoom: 20,
    pixelRatio: 2,
    cache: true,
  }));
}
