import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronRight, Database, Plus, Trash2 } from 'lucide-react';
import { overpassQueryListSchema, type OverpassQuery } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Loading } from '../../components/ui';
import { MapIcon } from '../../components/map/mapIcons';
import { NEW_OVERPASS_QUERY, OverpassQueryEditor, overpassProblem, queryFields } from '../map/overpass';

/** Overpass-Vorlagen: erscheinen in der Karte im Menü „Objekte“ und laufen dort mit einem Klick. Nur Admins. */
export function OverpassQueriesCard() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['overpassQueries', 'system'], queryFn: api.overpassSettings });
  const { data: status } = useQuery({ queryKey: ['addons', 'overpassStatus'], queryFn: api.overpassStatus, staleTime: 30_000 });
  const [list, setList] = useState<OverpassQuery[] | null>(null);
  const [dirty, setDirty] = useState(false);
  /** Aufgeklappte Vorlagen (Index) */
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (data && !dirty) setList(data.queries.map(queryFields));
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: (queries: OverpassQuery[]) => api.saveOverpassSettings(queries),
    onSuccess: () => (setDirty(false), setExpanded(new Set()), toast('success', 'Overpass-Vorlagen gespeichert')),
    onError: (e) => toast('error', e.message),
  });

  if (!data || !list) return <Loading />;
  const change = (next: OverpassQuery[]) => (setList(next), setDirty(true));
  const toggle = (i: number) =>
    setExpanded((e) => {
      const next = new Set(e);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    change(next);
    setExpanded(new Set());
  };
  const valid = overpassQueryListSchema.safeParse(list);

  return (
    <Card title="Overpass-Vorlagen" icon={<Database size={18} />} className="span-2">
      <p className="muted">
        Vorlagen erscheinen in der Karte im Menü „Objekte“ und fragen mit einem Klick OpenStreetMap im Kartenausschnitt ab. Symbol, Schild und Farbe bestimmen, wie die
        Treffer aussehen; übernommene Objekte behalten sie. Abfragen laufen über die Overpass-API des Addons „OSM-Daten“ (offline), solange es nicht bereit ist über einen
        öffentlichen Server.
        {status?.name && (
          <>
            {' '}
            Aktuell: <strong>{status.name}</strong> ({status.source === 'local' ? 'lokal' : 'öffentlich'}).
          </>
        )}
      </p>

      {list.length === 0 && <p className="muted">Noch keine Vorlagen.</p>}
      {list.map((q, i) => {
        const problem = overpassProblem(q);
        const open = expanded.has(i) || !!problem;
        return (
          <div key={i} className={`map-source ${open ? 'open' : ''}`}>
            <div className="map-source-head">
              <button type="button" className="map-source-toggle" aria-expanded={open} onClick={() => toggle(i)}>
                <ChevronRight size={16} className="map-source-chevron" aria-hidden />
                {q.icon && (
                  <span style={q.color ? { color: q.color } : undefined}>
                    <MapIcon name={q.icon} />
                  </span>
                )}
                <strong>{q.name || 'Neue Abfrage'}</strong>
                <Badge tone={problem ? 'alarm' : 'info'}>{q.mode === 'ql' ? 'QL' : 'Einfach'}</Badge>
                {!open && q.badge && <span className="muted map-source-summary mono">{q.badge}</span>}
              </button>
              <span className="btn-row">
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Nach oben" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={17} />
                </button>
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Nach unten" disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={17} />
                </button>
                <button type="button" className="btn btn-ghost btn-icon" aria-label="Entfernen" onClick={() => (change(list.filter((_, j) => j !== i)), setExpanded(new Set()))}>
                  <Trash2 size={17} />
                </button>
              </span>
            </div>
            {problem && <p className="tone-alarm">{problem}</p>}
            {open && <OverpassQueryEditor value={q} onChange={(next) => change(list.map((x, j) => (j === i ? next : x)))} />}
          </div>
        );
      })}

      <div className="form-actions spread">
        <span className="btn-row">
          <button
            type="button"
            className="btn btn-sm"
            disabled={list.length >= 50}
            onClick={() => (change([...list, NEW_OVERPASS_QUERY]), setExpanded((e) => new Set(e).add(list.length)))}
          >
            <Plus size={16} /> Vorlage
          </button>
        </span>
        <span className="btn-row">
          <button type="button" className="btn" disabled={!dirty} onClick={() => (setDirty(false), setExpanded(new Set()))}>
            Verwerfen
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || !valid.success || save.isPending} onClick={() => save.mutate(list)}>
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
