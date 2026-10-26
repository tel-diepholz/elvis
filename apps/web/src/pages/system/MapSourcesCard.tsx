import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight, Map as MapIcon, Plus, Trash2 } from 'lucide-react';
import { MAP_SOURCE_PLACEHOLDERS, mapSourceListSchema, mapSourcePresets, type MapSourceInput, type MapSourceOrigin, type MapSourceTestResult } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Toggle } from '../../components/ui';

const ORIGIN: Record<MapSourceOrigin, string> = { config: 'elvis.json', settings: 'Einstellungen', addon: 'Addon' };
const VARIANTS = { '': 'Standard', light: 'Hell (bevorzugt)', dark: 'Dunkelmodus', print: 'Druck' } as const;

const kind = (url: string) => (url.includes('{bbox}') ? 'WMS' : 'XYZ');

/** Kennung aus dem Namen: „Luftbild Niedersachsen“ → luftbild-niedersachsen, bei Bedarf mit Zähler */
function slugFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'karte';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** Kartenstile: eigene XYZ- und WMS-Dienste (z. B. Luftbilder der Länder) neben elvis.json und Addons. Nur Admins. */
export function MapSourcesCard() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['mapSources', 'system'], queryFn: api.mapSourceSettings });
  const [list, setList] = useState<MapSourceInput[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tests, setTests] = useState<Record<number, MapSourceTestResult | 'pending'>>({});
  /** Aufgeklappte Quellen (id); bei nur einer Quelle ist sie immer offen */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (data && !dirty) setList(data.sources.filter((s) => s.origin === 'settings').map(({ origin: _, ...s }) => s));
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => api.saveMapSources(list!),
    onSuccess: () => (setDirty(false), toast('success', 'Kartenquellen gespeichert')),
    onError: (e) => toast('error', e.message),
  });

  if (!data || !list) return <Loading />;
  const fixed = data.sources.filter((s) => s.origin !== 'settings');
  const taken = new Set([...fixed, ...list].map((s) => s.id));
  const change = (next: MapSourceInput[]) => (setList(next), setDirty(true), setTests({}));
  const patch = (i: number, p: Partial<MapSourceInput>) => change(list.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const add = (s: MapSourceInput) => {
    const id = taken.has(s.id) ? slugFor(s.name, taken) : s.id;
    change([...list, { ...s, id }]);
    setExpanded((e) => new Set(e).add(id));
  };
  const toggle = (id: string) =>
    setExpanded((e) => {
      const next = new Set(e);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const valid = mapSourceListSchema.safeParse(list);
  const invalid = new Set(valid.success ? [] : valid.error.issues.map((i) => i.path[0]));
  const presets = mapSourcePresets();

  const test = async (i: number) => {
    setTests((t) => ({ ...t, [i]: 'pending' }));
    try {
      const r = await api.testMapSource(list[i]!);
      setTests((t) => ({ ...t, [i]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [i]: { ok: false, contentType: null, error: (e as Error).message } }));
    }
  };

  return (
    <Card title="Kartenquellen" icon={<MapIcon size={18} />} className="span-2">
      <p className="muted">
        Kartenstile für Karte, Bildschirme und Druck. Neben Kacheldiensten (XYZ) lassen sich WMS-Dienste einbinden, etwa die Luftbilder der Vermessungsverwaltungen. Alle Kacheln
        laufen über den Fahrzeugserver und bleiben offline verfügbar.
      </p>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Art</th>
              <th>Max. Zoom</th>
              <th>Herkunft</th>
            </tr>
          </thead>
          <tbody>
            {fixed.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.name}
                  <span className="cell-sub">{s.attribution}</span>
                </td>
                <td>{kind(s.url)}</td>
                <td>{s.maxZoom}</td>
                <td>
                  <Badge>{ORIGIN[s.origin]}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {list.map((s, i) => {
        const t = tests[i];
        const open = list.length === 1 || expanded.has(s.id) || invalid.has(i);
        return (
          <div key={s.id} className={`map-source ${open ? 'open' : ''}`}>
            <div className="map-source-head">
              <button type="button" className="map-source-toggle" aria-expanded={open} disabled={list.length === 1} onClick={() => toggle(s.id)}>
                <ChevronRight size={16} className="map-source-chevron" aria-hidden />
                <strong>{s.name || 'Neue Kartenquelle'}</strong>
                <Badge tone={invalid.has(i) ? 'alarm' : 'info'}>{kind(s.url)}</Badge>
                {!open && <span className="muted map-source-summary">{s.attribution}</span>}
              </button>
              <span className="btn-row">
                <button type="button" className="btn btn-sm" disabled={t === 'pending'} onClick={() => void test(i)}>
                  Testen
                </button>
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Entfernen" onClick={() => change(list.filter((_, j) => j !== i))}>
                  <Trash2 size={17} />
                </button>
              </span>
            </div>
            {t && t !== 'pending' && <p className={t.ok ? 'tone-ok' : 'tone-alarm'}>{t.ok ? `Dienst antwortet (${t.contentType})` : `Fehler: ${t.error}`}</p>}
            {open && (
              <>
                <div className="form-grid">
                  <Field label="Name">
                    <input value={s.name} maxLength={80} onChange={(e) => patch(i, { name: e.target.value })} />
                  </Field>
                  <Field label="Quellenangabe" hint="Erscheint auf der Karte und im Druck">
                    <input value={s.attribution} maxLength={200} onChange={(e) => patch(i, { attribution: e.target.value })} />
                  </Field>
                  <Field label="Höchste Zoomstufe">
                    <input type="number" min={1} max={22} value={s.maxZoom} onChange={(e) => patch(i, { maxZoom: Number(e.target.value) })} />
                  </Field>
                  <Field label="Verwendung">
                    <select value={s.variant ?? ''} onChange={(e) => patch(i, { variant: (e.target.value || undefined) as MapSourceInput['variant'] })}>
                      {Object.entries(VARIANTS).map(([v, label]) => (
                        <option key={v} value={v}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="URL" hint="XYZ: {z}, {x}, {y} · WMS: GetMap-Abfrage mit CRS=EPSG:3857 und {bbox}, {width}, {height}">
                  <input className="mono" value={s.url} maxLength={1000} onChange={(e) => patch(i, { url: e.target.value })} />
                </Field>
                <Toggle label="Hochauflösend (512 px je Kachel, schärferer Druck)" checked={s.pixelRatio === 2} onChange={(v) => patch(i, { pixelRatio: v ? 2 : 1 })} />
                <Toggle label="Kacheln zwischenspeichern (offline verfügbar)" checked={s.cache} onChange={(v) => patch(i, { cache: v })} />
              </>
            )}
          </div>
        );
      })}

      <p className="muted">
        Platzhalter:{' '}
        {MAP_SOURCE_PLACEHOLDERS.map((p, i) => (
          <span key={p.key}>
            {i > 0 && ', '}
            <code title={p.label}>{p.key}</code>
          </span>
        ))}
      </p>
      {!valid.success && <p className="tone-alarm">{valid.error.issues.map((i) => `${list[i.path[0] as number]?.name ?? ''}: ${i.message}`)[0]}</p>}
      <div className="form-actions spread">
        <span className="btn-row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              const name = 'Neue Kartenquelle';
              add({ id: slugFor(name, taken), name, url: 'https://', attribution: '', maxZoom: 19, pixelRatio: 1, cache: true });
            }}
          >
            <Plus size={16} /> Quelle
          </button>
          <select
            aria-label="Vorlage einfügen"
            value=""
            onChange={(e) => {
              const preset = presets.find((p) => p.id === e.target.value);
              if (preset) add(preset);
            }}
          >
            <option value="">Vorlage einfügen …</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </span>
        <span className="btn-row">
          <button type="button" className="btn" disabled={!dirty} onClick={() => (setDirty(false), setTests({}))}>
            Verwerfen
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || !valid.success || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>
      {data.updatedAt && (
        <p className="cell-sub">
          Zuletzt geändert {fmtDateTime(data.updatedAt)} von {data.updatedBy}
        </p>
      )}
    </Card>
  );
}
