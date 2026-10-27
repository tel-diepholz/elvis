import { useEffect, useMemo, useState } from 'react';
import L from 'leaflet';
import { MapPin, Search } from 'lucide-react';
import { SIGN_GENERATOR_BASES, tacticalSignSchema, type TacticalSign } from '@elvis/shared';
import { Modal } from '../ui';
import { TacticalSignImage } from '../tactical/TacticalSign';
import { TacticalSignEditor } from '../tactical/TacticalSignEditor';

/**
 * Lagezeichen nach DV 102 (eigener, nachgeladener Teil der Oberfläche – nur wenn Zeichen gebraucht werden).
 * Zeichensatz von Jonas Köritz (github.com/jonas-koeritz/Taktische-Zeichen, CC0), Schrift Roboto Slab (Apache 2.0).
 */
type Dv102Module = typeof import('@elvis/shared/dv102');

let loaded: Dv102Module | null = null;
let loading: Promise<Dv102Module> | null = null;
const load = () =>
  (loading ??= import('@elvis/shared/dv102').then((m) => {
    // Schrift der Zeichen einmal für die ganze Seite
    const style = document.createElement('style');
    style.textContent = `@font-face { font-family: 'Roboto Slab'; font-weight: bold; src: url(data:font/woff;base64,${m.DV102_FONT_WOFF}) format('woff'); }`;
    document.head.appendChild(style);
    return (loaded = m);
  }));

/** Zeichen-Daten, sobald geladen; needed = false lädt nichts nach (z. B. keine Zeichen auf der Karte) */
export function useDv102(needed = true): Dv102Module | null {
  const [mod, setMod] = useState(loaded);
  useEffect(() => {
    if (!mod && needed) void load().then(setMod);
  }, [mod, needed]);
  return mod;
}

/** Zeichen als Inline-SVG auf heller Kachel (Objektliste, Auswahl); bis zum Laden leer */
export function Dv102Image({ id, size = 28 }: { id: string; size?: number }) {
  const mod = useDv102();
  const sign = mod?.dv102Sign(id);
  return <span className="dv102-image" style={{ width: size, height: size }} title={sign?.name} dangerouslySetInnerHTML={sign ? { __html: sign.svg } : undefined} />;
}

const icons = new Map<string, L.DivIcon>();

/** Leaflet-Marker eines Zeichens (zwischengespeichert); der Bezugspunkt ist die Mitte */
export function dv102Icon(mod: Dv102Module | null, id: string, size = 64): L.DivIcon {
  const key = `${mod ? 'ok' : 'wait'}|${id}|${size}`;
  let icon = icons.get(key);
  if (!icon) {
    icon = L.divIcon({ className: 'map-marker dv102', html: mod?.dv102Sign(id)?.svg ?? '', iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
    icons.set(key, icon);
  }
  return icon;
}

export type GeneratorBase = (typeof SIGN_GENERATOR_BASES)[number];

/** Kurzname je Grundzeichen (Vorgabename, Objektliste) und Suchbegriffe für die Auswahl */
export const GENERATOR_LABELS: Record<GeneratorBase, string> = { unit: 'Einheit', command: 'Befehlsstelle', facility: 'Einrichtung', person: 'Person' };
const GENERATOR_SEARCH: Record<GeneratorBase, string> = {
  unit: 'einheit dienststelle taktische formation trupp staffel gruppe zug verband',
  command: 'befehlsstelle führungsstelle einsatzleitung elw tel',
  facility: 'stelle einrichtung sammelstelle bereitstellungsraum krankenhaus',
  person: 'personen person führer helfer einsatzkraft',
};

/** Vorgabe für ein neues Zeichen aus dem Generator */
export const generatorSign = (base: GeneratorBase = 'person'): TacticalSign => tacticalSignSchema.parse({ base });
/** Vorgabename: Kurzname des Grundzeichens und Text im Zeichen, z. B. „Einheit LF 20“ */
export const generatorName = (s: TacticalSign) => [GENERATOR_LABELS[s.base as GeneratorBase] ?? 'Zeichen', s.text.trim()].filter(Boolean).join(' ');

/**
 * Auswahl der Lagezeichen mit Suche, nach Gruppen der DV 102. Einheiten, Stellen und Personen kommen nicht aus dem
 * Zeichensatz, sondern aus dem Zeichengenerator: ihre Kacheln öffnen ihn über onGenerator.
 */
export function Dv102Picker({ value, onPick, onGenerator }: { value: string | null; onPick: (id: string) => void; onGenerator: (base: GeneratorBase) => void }) {
  const mod = useDv102();
  const [q, setQ] = useState('');
  const hits = useMemo(() => mod?.searchDv102(q) ?? [], [mod, q]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const bases = SIGN_GENERATOR_BASES.filter((b) => words.every((w) => `${GENERATOR_SEARCH[b]} generator zusammenstellen`.includes(w)));
  const generatorGroup = bases.length > 0 && (
    <section key="generator">
      <h4>Einheiten, Stellen, Personen</h4>
      <div className="dv102-grid">
        {bases.map((b) => (
          <button key={b} type="button" className="dv102-choice" onClick={() => onGenerator(b)} title={`${GENERATOR_LABELS[b]} mit dem Zeichengenerator zusammenstellen`}>
            <span className="dv102-image dv102-generator">
              <TacticalSignImage sign={generatorSign(b)} height={b === 'command' ? 44 : 34} />
            </span>
            <span className="dv102-name">{GENERATOR_LABELS[b]} …</span>
          </button>
        ))}
      </div>
    </section>
  );
  return (
    <div className="dv102-picker">
      <div className="map-icon-search">
        <Search size={15} aria-hidden />
        <input type="search" aria-label="Zeichen suchen" placeholder="Zeichen suchen, z. B. Gas, Brand, verletzt" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      {!mod ? (
        <p className="muted">Zeichen werden geladen …</p>
      ) : (
        <div className="dv102-groups">
          {mod.DV102_CATEGORIES.flatMap((category) => {
            const signs = hits.filter((s) => s.category === category);
            // Einheiten, Stellen und Personen stehen nach Gefahren und Schäden
            const generator = category === 'Maßnahmen' ? [generatorGroup] : [];
            if (!signs.length) return generator;
            return [
              ...generator,
              <section key={category}>
                <h4>{category}</h4>
                <div className="dv102-grid" role="radiogroup" aria-label={category}>
                  {signs.map((s) => (
                    <button key={s.id} type="button" role="radio" aria-checked={value === s.id} className={`dv102-choice ${value === s.id ? 'active' : ''}`} onClick={() => onPick(s.id)} title={s.name}>
                      <span className="dv102-image" dangerouslySetInnerHTML={{ __html: s.svg }} />
                      <span className="dv102-name">{s.name}</span>
                    </button>
                  ))}
                </div>
              </section>,
            ];
          })}
          {!hits.length && !bases.length && <p className="muted">Kein Zeichen gefunden</p>}
        </div>
      )}
      <p className="muted dv102-credit">Zeichen nach DV 102 aus dem Zeichensatz von Jonas Köritz (gemeinfrei).</p>
    </div>
  );
}

/** Zeichen mit dem Zeichengenerator zusammenstellen (alle Grundzeichen außer Fahrzeug) */
export function GeneratorSignDialog({ open, initial, action, onClose, onDone }: { open: boolean; initial: TacticalSign; action: string; onClose: () => void; onDone: (sign: TacticalSign) => void }) {
  const [sign, setSign] = useState(initial);
  useEffect(() => {
    if (open) setSign(initial);
  }, [open, initial]);
  return (
    <Modal open={open} title="Zeichen zusammenstellen" onClose={onClose}>
      <div className="generator-sign-dialog">
        <TacticalSignEditor value={sign} onChange={setSign} bases={[...SIGN_GENERATOR_BASES]} />
        <button type="button" className="btn btn-primary" onClick={() => onDone(sign)}>
          <MapPin size={16} /> {action}
        </button>
      </div>
    </Modal>
  );
}
