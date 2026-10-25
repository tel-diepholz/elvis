import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Badge, Card, Loading } from '../../components/ui';

/** App-Anbindung: Zustand des Cloud-Relays. Vorgabe https://elvis-relay.hhansen06.workers.dev, abweichend in config/elvis.json (app.relayUrl). */
export function AppRelayCard() {
  // Schlüssel unter „appLinks“, damit Kopplungen und Abrufe die Anzeige auffrischen
  const { data: s } = useQuery({ queryKey: ['appLinks', 'relay'], queryFn: api.appRelayStatus, refetchInterval: 15_000 });
  if (!s) return <Loading />;
  const badge = !s.enabled ? (
    <Badge>Aus</Badge>
  ) : s.lastError ? (
    <Badge tone="alarm">Fehler</Badge>
  ) : s.activeLinks > 0 ? (
    <Badge tone="ok">Aktiv</Badge>
  ) : (
    <Badge tone="info">Bereit</Badge>
  );
  return (
    <Card title="App-Anbindung" actions={badge}>
      {!s.enabled ? (
        <p className="muted">
          Abgeschaltet (<code>app.relayUrl</code> ist <code>null</code>). Damit Einsatzkräfte ihre Position mit der ELVIS-App senden können, in{' '}
          <code>config/elvis.json</code> die Relay-Adresse eintragen (Vorgabe <code>https://elvis-relay.hhansen06.workers.dev</code>) oder per <code>ELVIS_APP_RELAY_URL</code>.
        </p>
      ) : (
        <>
          <dl className="kv">
            <dt>Relay</dt>
            <dd className="mono">{s.relayUrl}</dd>
            <dt>Angemeldet</dt>
            <dd>{s.registered ? 'ja' : 'noch nicht (beim ersten Koppeln)'}</dd>
            <dt>Gekoppelte Apps</dt>
            <dd>{s.activeLinks}</dd>
            <dt>Letzter Abruf</dt>
            <dd>{s.lastPollAt ? fmtDateTime(s.lastPollAt) : '–'}</dd>
            {s.lastError && (
              <>
                <dt>Fehler</dt>
                <dd>{s.lastError}</dd>
              </>
            )}
          </dl>
          <p className="muted">Apps werden in der Kräfteübersicht eines Einsatzes mit einer Einheit gekoppelt (Smartphone-Symbol, App-ID und Code aus der App).</p>
        </>
      )}
    </Card>
  );
}
