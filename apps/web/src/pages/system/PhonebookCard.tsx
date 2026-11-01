import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Phone, RefreshCw } from 'lucide-react';
import type { ContactCategory } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Card, Loading } from '../../components/ui';
import { copyText } from '../DockerHostsPage';

/** Kategorien als Pfad („Unternehmen / Getränke“), sortiert */
function categoryPaths(list: ContactCategory[]): { id: number; path: string }[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  const path = (c: ContactCategory): string => (c.parentId !== null && byId.has(c.parentId) ? `${path(byId.get(c.parentId)!)} / ${c.name}` : c.name);
  return list.map((c) => ({ id: c.id, path: path(c) })).sort((a, b) => a.path.localeCompare(b.path, 'de'));
}

/** Telefonbuch für DECT-Basen (Yealink W70B): Abruf-URLs der Kontakte, Token neu erzeugen. Nur Admins. */
export function PhonebookCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['contacts', 'phonebook'], queryFn: api.phonebook });
  const { data: categories } = useQuery({ queryKey: ['contacts', 'categories'], queryFn: api.contactCategories });
  const regenerate = useMutation({
    mutationFn: api.regeneratePhonebookToken,
    onSuccess: (s) => (qc.setQueryData(['contacts', 'phonebook'], s), toast('success', 'Neue Telefonbuch-URL erzeugt – an der Basis eintragen')),
    onError: (e) => toast('error', e.message),
  });

  if (!data) return <Loading />;

  const base = `${location.origin}/api/phonebook/${data.token}`;
  const rows = [{ name: 'Alle Kontakte', url: `${base}/yealink.xml` }, ...categoryPaths(categories ?? []).map((c) => ({ name: c.path, url: `${base}/kategorie/${c.id}/yealink.xml` }))];
  const copy = async (url: string) => {
    const ok = await copyText(url);
    toast(ok ? 'success' : 'error', ok ? 'URL kopiert' : 'Kopieren nicht möglich');
  };

  return (
    <Card title="Telefonbuch (DECT)" icon={<Phone size={18} />} className="span-3">
      <p className="muted">
        Die DECT-Basis (Yealink W70B) lädt die <em>Kontakte</em> als Remote-Telefonbuch: je Telefonnummer ein Eintrag, die Bezeichnung (z. B. „Mobil“) steht hinter dem
        Namen. An der Basis unter <em>Directory → Remote Phone Book</em> die URL und einen Namen eintragen (bis zu fünf Telefonbücher, z. B. eines je Kategorie) und ein
        Aktualisierungsintervall setzen. Die URL enthält einen geheimen Schlüssel und funktioniert ohne Anmeldung – nicht weitergeben.
      </p>
      <dl className="kv">
        <dt>Einträge</dt>
        <dd>
          {data.entries} aus {data.contacts} Kontakten mit Telefonnummer
        </dd>
      </dl>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Telefonbuch</th>
              <th>URL</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.url}>
                <td>{r.name}</td>
                <td className="mono" style={{ wordBreak: 'break-all' }}>
                  {r.url}
                </td>
                <td>
                  <button type="button" className="btn btn-icon" aria-label={`URL für ${r.name} kopieren`} onClick={() => void copy(r.url)}>
                    <Copy size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="field-hint">
        Die Basis muss ELVIS unter <code>{location.host}</code> erreichen – sonst die IP-Adresse des Fahrzeugservers einsetzen. Nummern werden wählbar gemacht
        („+49 (0)5441 / 123-4“ → „+4954411234“).
      </p>
      <div className="form-actions spread">
        <span className="cell-sub">{data.updatedAt && `URL erzeugt ${fmtDateTime(data.updatedAt)} von ${data.updatedBy}`}</span>
        <button
          type="button"
          className="btn"
          disabled={regenerate.isPending}
          onClick={() => window.confirm('Neue URL erzeugen? Die bisherige URL funktioniert danach nicht mehr und muss an der Basis ersetzt werden.') && regenerate.mutate()}
        >
          <RefreshCw size={16} /> Neue URL erzeugen
        </button>
      </div>
    </Card>
  );
}
