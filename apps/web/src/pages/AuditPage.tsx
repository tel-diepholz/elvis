import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Badge, Card, Loading, PageHeader } from '../components/ui';

/** Bedienprotokoll: wer wann was ausgelöst hat (Befehle, Einstellungen, Addons …) – nur Admins */
export function AuditPage() {
  const { data: audit } = useQuery({ queryKey: ['audit'], queryFn: () => api.audit(100) });

  return (
    <>
      <PageHeader title="Bedienprotokoll" subtitle="Die letzten 100 Bedienvorgänge" />
      <Card>
        {!audit ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Bediener</th>
                  <th>Gerät</th>
                  <th>Aktion</th>
                  <th>Ergebnis</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="mono">{fmtDateTime(a.timestamp)}</td>
                    <td>{a.operator}</td>
                    <td>{a.target}</td>
                    <td>
                      <code>{a.action}</code> {a.params !== '{}' && <span className="cell-sub">{a.params}</span>}
                    </td>
                    <td>
                      <Badge tone={a.success ? 'ok' : 'alarm'}>{a.success ? 'OK' : 'abgelehnt'}</Badge> {a.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
