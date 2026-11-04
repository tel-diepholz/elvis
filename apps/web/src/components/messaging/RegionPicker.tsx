import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import type { Region, RegionKind } from '@elvis/shared';
import { api } from '../../lib/api';
import { Loading } from '../ui';

const KIND: Record<RegionKind, string> = { land: 'Land', kreis: 'Kreis', verband: 'Gemeindeverband', gemeinde: 'Gemeinde' };

/**
 * Gebietskörperschaft wählen: Deutschland › Land › Kreis › (Samtgemeinde) › Gemeinde. Jede Ebene ist eine gültige Wahl.
 * Durchklicken oder nach Namen suchen; der Katalog kommt vom Cloud-Relay (Gemeindeverzeichnis, © Destatis).
 */
export function RegionPicker({ value, onChange, disabled }: { value: string; onChange: (ars: string, label: string) => void; disabled?: boolean }) {
  const [path, setPath] = useState<Region[] | null>(value ? null : []);
  const [q, setQ] = useState('');
  const parent = path?.at(-1)?.ars ?? '';
  const current = useQuery({ queryKey: ['messaging', 'region', value], queryFn: () => api.messagingRegion(value), enabled: !!value, staleTime: Infinity });
  const children = useQuery({ queryKey: ['messaging', 'regions', parent], queryFn: () => api.messagingRegions(parent), enabled: path !== null, staleTime: Infinity });
  const hits = useQuery({ queryKey: ['messaging', 'regions', 'q', q.trim()], queryFn: () => api.messagingRegionSearch(q.trim()), enabled: q.trim().length >= 2, staleTime: Infinity });

  // Vorhandene Wahl: dorthin aufklappen (bei einer Gemeinde ohne Unterebene die Ebene darüber)
  useEffect(() => {
    if (path !== null || !current.data) return;
    setPath(current.data.hasChildren ? current.data.path : current.data.path.slice(0, -1));
  }, [current.data, path]);

  const labelOf = (trail: Region[]) => (trail.length ? trail.map((r) => r.name).join(' › ') : 'Deutschland');
  const pick = (r: Region, trail: Region[]) => {
    onChange(r.ars, labelOf(trail));
    setPath(r.hasChildren ? trail : trail.slice(0, -1));
    setQ('');
  };
  const crumbs = path ?? [];

  return (
    <div className="region-picker">
      <div className="region-crumbs" aria-label="Gewählte Region">
        <button type="button" className={`region-crumb ${value === '' ? 'active' : ''}`} disabled={disabled} onClick={() => (onChange('', 'Deutschland'), setPath([]))}>
          Deutschland
        </button>
        {crumbs.map((r, i) => (
          <span key={r.ars} className="region-crumb-sep">
            <ChevronRight size={14} />
            <button type="button" className={`region-crumb ${value === r.ars ? 'active' : ''}`} disabled={disabled} onClick={() => pick(r, crumbs.slice(0, i + 1))}>
              {r.name}
            </button>
          </span>
        ))}
        {current.data && !current.data.hasChildren && (
          <span className="region-crumb-sep">
            <ChevronRight size={14} />
            <span className="region-crumb active">{current.data.name}</span>
          </span>
        )}
      </div>
      {!disabled && (
        <>
          <div className="region-search">
            <Search size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gemeinde, Kreis oder Land suchen" aria-label="Region suchen" />
          </div>
          {q.trim().length >= 2 ? (
            hits.isLoading ? (
              <Loading />
            ) : (
              <ul className="region-list">
                {(hits.data ?? []).map((r) => (
                  <li key={r.ars}>
                    <button type="button" onClick={() => pick(r, r.path)}>
                      <span>{r.name}</span>
                      <span className="muted small">
                        {KIND[r.kind]} · {r.path.slice(0, -1).map((p) => p.name).join(' › ') || 'Deutschland'}
                      </span>
                    </button>
                  </li>
                ))}
                {hits.data?.length === 0 && <li className="muted small">Kein Treffer</li>}
              </ul>
            )
          ) : children.isLoading || path === null ? (
            <Loading />
          ) : children.error ? (
            <p className="tone-alarm small">{children.error.message}</p>
          ) : (
            (children.data ?? []).length > 0 && (
              <ul className="region-list">
                {children.data!.map((r) => (
                  <li key={r.ars}>
                    <button type="button" className={value === r.ars ? 'active' : ''} onClick={() => pick(r, [...crumbs, r])}>
                      <span>{r.name}</span>
                      {r.hasChildren && <ChevronRight size={14} className="muted" />}
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}
        </>
      )}
    </div>
  );
}
