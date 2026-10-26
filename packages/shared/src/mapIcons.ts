/**
 * Symbole für Punkte der Objektliste: alle Icons von Lucide (https://lucide.dev, ISC-Lizenz), gespeichert unter
 * ihrem Namen in PascalCase („Flame“). Das Modul bringt alle rund 1.500 Icons mit – die Weboberfläche lädt es
 * deshalb erst bei Bedarf (`@elvis/shared/mapIcons`); der Server zeichnet damit die Symbole im Kartendruck.
 */
import { icons } from 'lucide';

/** [Element, Attribute] wie in Lucide; Koordinaten im Raster 24 × 24 */
export type MapIconElement = readonly [tag: string, attrs: Record<string, string | number>];

export interface MapIconEntry {
  name: string;
  /** Kleingeschriebene Namen (auch frühere Namen) und deutsche Suchbegriffe */
  search: string;
}

const ALL = icons as unknown as Record<string, readonly [string, Record<string, string | number>, MapIconElement[]?]>;

/** Elemente eines Icons; null, wenn es den Namen nicht gibt */
export function mapIconElements(name: string): MapIconElement[] | null {
  return ALL[name]?.[2] ?? null;
}

export const isMapIcon = (name: string) => Object.prototype.hasOwnProperty.call(ALL, name);

/** „AlarmClockCheck“ → „alarm clock check“ */
const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();

/** Deutsche Suchbegriffe für Icons, die im Einsatz häufig gebraucht werden */
const GERMAN: Record<string, string> = {
  Flame: 'feuer brand flamme',
  FlameKindling: 'feuer lagerfeuer brand',
  FireExtinguisher: 'feuerlöscher löscher',
  Droplet: 'wasser tropfen hydrant löschwasser',
  Droplets: 'wasser löschwasser',
  Waves: 'wasser fluss see hochwasser',
  Siren: 'sirene alarm blaulicht',
  TriangleAlert: 'warnung gefahr achtung',
  OctagonAlert: 'stopp gefahr warnung',
  Biohazard: 'biogefahr biologisch gefahrstoff',
  Radiation: 'strahlung radioaktiv atom',
  Skull: 'gift tod gefahrstoff',
  FlaskConical: 'chemie gefahrstoff labor',
  Hospital: 'krankenhaus klinik',
  Ambulance: 'rettungswagen rtw krankenwagen',
  Cross: 'kreuz sanität erste hilfe',
  HeartPulse: 'medizin puls patient',
  Stethoscope: 'arzt medizin',
  Pill: 'medikament apotheke',
  Syringe: 'spritze impfung',
  User: 'person patient',
  Users: 'personen gruppe betroffene',
  Baby: 'kind baby kita',
  House: 'haus gebäude wohnhaus',
  Building: 'gebäude haus',
  Building2: 'gebäude firma',
  Factory: 'fabrik industrie betrieb',
  Warehouse: 'lager halle',
  School: 'schule',
  Church: 'kirche',
  Tent: 'zelt bereitstellungsraum lager',
  Car: 'auto pkw fahrzeug',
  Truck: 'lkw fahrzeug',
  Bus: 'bus',
  TrainFront: 'zug bahn',
  Plane: 'flugzeug',
  Ship: 'schiff boot',
  Sailboat: 'boot segelboot',
  Bike: 'fahrrad',
  Fuel: 'tankstelle kraftstoff',
  Zap: 'strom elektrizität blitz',
  Plug: 'strom stecker',
  Construction: 'baustelle absperrung',
  Ban: 'verbot sperrung',
  CircleParking: 'parkplatz',
  MapPin: 'ort punkt markierung',
  Flag: 'fahne flagge ziel',
  Crosshair: 'ziel fadenkreuz',
  Target: 'ziel',
  Navigation: 'navigation richtung',
  Wind: 'wind wetter',
  CloudRain: 'regen unwetter',
  Snowflake: 'schnee eis frost',
  Thermometer: 'temperatur hitze',
  TreePine: 'baum wald',
  Trees: 'wald bäume',
  Mountain: 'berg',
  Camera: 'kamera foto',
  Phone: 'telefon',
  Radio: 'funk',
  RadioTower: 'funkmast sender',
  Wifi: 'wlan netz',
  Megaphone: 'lautsprecher durchsage',
  Lightbulb: 'licht beleuchtung',
  Utensils: 'verpflegung essen',
  Coffee: 'kaffee verpflegung pause',
  Toilet: 'toilette wc',
  Dog: 'hund rettungshund tier',
  PawPrint: 'tier',
  Shield: 'schutz polizei',
  ShieldAlert: 'polizei warnung',
  Lock: 'schloss gesperrt',
  Key: 'schlüssel',
  Package: 'paket material',
  Box: 'kiste material',
  Wrench: 'werkzeug technik',
  Hammer: 'hammer werkzeug',
  Info: 'information hinweis',
  CircleHelp: 'frage unbekannt',
  Eye: 'beobachtung sicht',
  Clock: 'uhr zeit',
};

let list: MapIconEntry[] | null = null;

/** Alle Icons (Aliasse zusammengefasst), Einsatz-Icons mit deutschen Begriffen zuerst, sonst alphabetisch */
export function mapIconList(): MapIconEntry[] {
  if (list) return list;
  const byNode = new Map<unknown, string[]>();
  for (const [name, node] of Object.entries(ALL)) byNode.set(node, [...(byNode.get(node) ?? []), name]);
  const entries = [...byNode.values()].map((names) => {
    const name = names.find((n) => GERMAN[n]) ?? names[names.length - 1]!;
    return { name, search: [...names.map(words), ...names.map((n) => GERMAN[n] ?? '')].join(' ').trim() };
  });
  const featured = Object.keys(GERMAN);
  const rank = (e: MapIconEntry) => (featured.includes(e.name) ? featured.indexOf(e.name) : featured.length);
  list = entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return list;
}

/** Icons zum Suchbegriff (alle Wörter müssen vorkommen); leer = alle */
export function searchMapIcons(query: string): MapIconEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return mapIconList().filter((e) => terms.every((t) => e.search.includes(t)));
}

const escapeAttr = (v: string | number) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** SVG-Markup für Karte und Auswahl; null bei unbekanntem Namen */
export function mapIconSvg(name: string, { size = 24, color = 'currentColor', strokeWidth = 2 }: { size?: number; color?: string; strokeWidth?: number } = {}): string | null {
  const elements = mapIconElements(name);
  if (!elements) return null;
  const children = elements.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(' ')}/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${escapeAttr(color)}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}
