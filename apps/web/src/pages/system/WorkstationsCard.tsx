import { useMutation, useQuery } from '@tanstack/react-query';
import { Laptop, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Loading } from '../../components/ui';

/** Ohne Lebenszeichen seit dieser Zeit gilt ein Arbeitsplatz als ausgeschaltet (der Dienst meldet sich jede Minute) */
const ONLINE_MS = 3 * 60_000;

/** Per PXE installierte Arbeitsplätze (Addon „ELVIS Arbeitsplatz“) – nur Admins */
export function WorkstationsCard() {
  const toast = useToast();
  const { data: list } = useQuery({ queryKey: ['workstations'], queryFn: api.workstations, refetchInterval: 60_000 });
  const rename = useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.renameWorkstation(id, name), onError: (e) => toast('error', e.message) });
  const remove = useMutation({ mutationFn: api.removeWorkstation, onError: (e) => toast('error', e.message) });

  return (
    <Card title="Arbeitsplätze" icon={<Laptop size={18} />} className="span-3">
      {!list ? (
        <Loading />
      ) : list.length === 0 ? (
        <p className="muted">
          Noch keine Arbeitsplätze. Mit dem Addon „ELVIS Arbeitsplatz“ starten Notebooks per Netzwerk (PXE) und installieren das Arbeitsplatz-System; sie erscheinen
          danach hier.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Benutzer</th>
                <th>Installiert</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((w) => {
                const online = !!w.lastSeenAt && Date.now() - new Date(w.lastSeenAt).getTime() < ONLINE_MS;
                return (
                  <tr key={w.id}>
                    <td>
                      <div className="cell-title">{w.name}</div>
                      <div className="cell-sub mono">
                        {w.hostname} · {w.mac}
                        {w.version && ` · v${w.version}`}
                      </div>
                    </td>
                    <td>{online ? <Badge tone="ok">eingeschaltet</Badge> : <Badge>{w.lastSeenAt ? `zuletzt ${fmtDateTime(w.lastSeenAt)}` : 'noch nie gestartet'}</Badge>}</td>
                    <td>{w.lastUser ?? '–'}</td>
                    <td>{fmtDateTime(w.enrolledAt)}</td>
                    <td>
                      <span className="btn-row">
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`${w.name} umbenennen`}
                          onClick={() => {
                            const name = window.prompt('Neuer Name', w.name)?.trim();
                            if (name && name !== w.name) rename.mutate({ id: w.id, name });
                          }}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`${w.name} entfernen`}
                          disabled={remove.isPending}
                          onClick={() =>
                            window.confirm(`Arbeitsplatz „${w.name}“ entfernen? Das Gerät wird gesperrt und verwirft beim nächsten Kontakt auch die Offline-Anmeldung. Wieder einrichten nur per Neuinstallation.`) &&
                            remove.mutate(w.id)
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
