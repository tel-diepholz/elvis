import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AtSign } from 'lucide-react';
import { mailAccountRequestSchema, type MailAccountStatus, type StatusLevel } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Segmented } from '../../components/ui';

const STATUS_PAGE = 'https://einsatzleitwagen.app/status';
const HEALTH: Record<StatusLevel, { tone: 'ok' | 'warn' | 'alarm'; label: string }> = {
  ok: { tone: 'ok', label: 'Mail-Dienst ok' },
  degraded: { tone: 'warn', label: 'Mail-Dienst gestört' },
  outage: { tone: 'alarm', label: 'Mail-Dienst ausgefallen' },
};

const fingerprint = (fp: string) => fp.replace(/(.{4})/g, '$1 ').trim();

/** E-Mail: Postfach des ELW beantragen, übernehmen (Neuinstallation) und kündigen. Nur Admins. */
export function MailCard() {
  const { data: s } = useQuery({ queryKey: ['mail', 'account'], queryFn: api.mailAccount, refetchInterval: 30_000 });
  if (!s) return <Loading />;
  const badge =
    s.state === 'active' ? <Badge tone="ok">Aktiv</Badge> : ['pending', 'approval', 'rebind-pending'].includes(s.state) ? <Badge tone="info">Wartet</Badge> : s.state === 'none' ? <Badge>Kein Postfach</Badge> : <Badge tone="alarm">Getrennt</Badge>;

  return (
    <Card title="E-Mail" icon={<AtSign size={18} />} actions={s.enabled && badge}>
      {!s.enabled ? (
        <p className="muted">
          Abgeschaltet. E-Mail braucht die Cloud-Anbindung (<code>app.relayUrl</code>) und <code>mail.enabled</code> in <code>config/elvis.json</code>.
        </p>
      ) : s.state === 'active' ? (
        <Active s={s} />
      ) : s.state === 'pending' || s.state === 'approval' || s.state === 'rebind-pending' ? (
        <Waiting s={s} />
      ) : (
        <RequestForm s={s} />
      )}
      {s.enabled && <Health s={s} />}
    </Card>
  );
}

function Health({ s }: { s: MailAccountStatus }) {
  if (!s.relayHealth) return null;
  const h = HEALTH[s.relayHealth];
  return (
    <p className="muted">
      <Badge tone={h.tone}>{h.label}</Badge>{' '}
      <a href={STATUS_PAGE} target="_blank" rel="noreferrer">
        Statusseite
      </a>
      {s.lastError && <span className="tone-alarm"> · {s.lastError}</span>}
    </p>
  );
}

function RequestForm({ s }: { s: MailAccountStatus }) {
  const toast = useToast();
  const [mode, setMode] = useState<'new' | 'rebind'>(s.state === 'lost' ? 'rebind' : 'new');
  const [localpart, setLocalpart] = useState(s.address?.split('@')[0] ?? '');
  const [adminEmail, setAdminEmail] = useState(s.adminEmail ?? '');
  const input = { localpart, adminEmail, mode };
  const valid = mailAccountRequestSchema.safeParse(input);
  const send = useMutation({
    mutationFn: () => api.requestMailAccount(input),
    onSuccess: () => toast('success', mode === 'new' ? `Bestätigungslink an ${adminEmail} geschickt` : 'Übernahme beantragt'),
    onError: (e) => toast('error', e.message),
  });

  return (
    <>
      {s.state === 'moved' && <p className="tone-alarm">Das Postfach {s.address} wurde auf eine andere ELVIS-Installation übertragen. Diese Installation kann keine Mails mehr abrufen.</p>}
      {s.state === 'lost' && (
        <p className="tone-alarm">
          Das Relay ordnet {s.address} dieser Installation nicht mehr zu (z. B. nach neuer Anmeldung bei der Cloud). Mit „Bestehendes übernehmen“ lässt es sich wieder
          zuordnen.
        </p>
      )}
      <p className="muted">
        Der ELW bekommt eine eigene Adresse <code>…@einsatzleitwagen.app</code>, die alle Bediener unter <Link to="/mail">E-Mail</Link> lesen und nutzen. ELVIS erzeugt dafür
        einen OpenPGP-Schlüssel; der private Schlüssel verlässt den ELW nie. Der Admin bestätigt per Link und bekommt einmalig den öffentlichen Schlüssel und das
        Widerrufszertifikat per Mail.
      </p>
      <Segmented
        label="Art des Antrags"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'new', label: 'Neues Postfach' },
          { value: 'rebind', label: 'Bestehendes übernehmen' },
        ]}
      />
      {mode === 'rebind' && (
        <p className="muted">
          Nach einer Neuinstallation: Adresse und die beim Beantragen angegebene Admin-Adresse eintragen. Dorthin geht ein Bestätigungslink. Danach gehört die Adresse
          dieser Installation; ältere und noch nicht abgeholte Mails sind nicht mehr lesbar.
        </p>
      )}
      <div className="form-grid">
        <Field label="Adresse" hint="3–40 Zeichen: a–z, 0–9, Punkt, Bindestrich">
          <div className="input-suffix">
            <input value={localpart} onChange={(e) => setLocalpart(e.target.value)} placeholder="elw2-musterstadt" maxLength={40} autoComplete="off" />
            <span className="muted">@einsatzleitwagen.app</span>
          </div>
        </Field>
        <Field label="Admin-Adresse (Kontakt)" hint="Außerhalb von ELVIS, z. B. die Adresse der Wehrführung. Bestätigungslink und Schlüssel gehen hierhin.">
          <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="wehrfuehrung@feuerwehr-musterstadt.de" autoComplete="email" />
        </Field>
      </div>
      {!valid.success && (localpart || adminEmail) && <p className="tone-alarm">{valid.error.issues[0]?.message}</p>}
      <div className="form-actions">
        <button className="btn btn-primary" disabled={!valid.success || send.isPending} onClick={() => send.mutate()}>
          {send.isPending ? 'Schlüssel werden erzeugt …' : mode === 'new' ? 'Postfach beantragen' : 'Übernahme beantragen'}
        </button>
      </div>
    </>
  );
}

function Waiting({ s }: { s: MailAccountStatus }) {
  const toast = useToast();
  const cancel = useMutation({ mutationFn: api.cancelMailAccount, onError: (e) => toast('error', e.message) });
  const text =
    s.state === 'pending'
      ? `Ein Bestätigungslink ist an ${s.adminEmail} unterwegs (gültig 24 Stunden). Nach dem Bestätigen wird ${s.address} aktiv.`
      : s.state === 'approval'
        ? `Bestätigt. ${s.address} wird aktiv, sobald der Betreiber des Relays den Antrag freigegeben hat.`
        : `Stimmt die Admin-Adresse, ist an ${s.adminEmail} ein Bestätigungslink unterwegs (gültig 24 Stunden). Danach gehört ${s.address} dieser Installation.`;
  return (
    <>
      <p>{text}</p>
      <dl className="kv">
        <dt>Beantragt</dt>
        <dd>{s.requestedAt ? fmtDateTime(s.requestedAt) : '–'}</dd>
        <dt>Fingerprint</dt>
        <dd className="mono">{s.fingerprint ? fingerprint(s.fingerprint) : '–'}</dd>
      </dl>
      <div className="form-actions">
        <button className="btn" disabled={cancel.isPending} onClick={() => window.confirm('Antrag zurückziehen?') && cancel.mutate()}>
          Antrag zurückziehen
        </button>
      </div>
    </>
  );
}

function Active({ s }: { s: MailAccountStatus }) {
  const toast = useToast();
  const cancel = useMutation({ mutationFn: api.cancelMailAccount, onSuccess: () => toast('success', 'Postfach gekündigt'), onError: (e) => toast('error', e.message) });
  return (
    <>
      <dl className="kv">
        <dt>Adresse</dt>
        <dd className="mono">{s.address}</dd>
        <dt>Fingerprint</dt>
        <dd className="mono">{s.fingerprint ? fingerprint(s.fingerprint) : '–'}</dd>
        <dt>Admin-Kontakt</dt>
        <dd>{s.adminEmail}</dd>
        <dt>Aktiv seit</dt>
        <dd>{s.activatedAt ? fmtDateTime(s.activatedAt) : '–'}</dd>
        <dt>Schlüssel-Mail</dt>
        <dd>{s.keysMailedAt ? `verschickt ${fmtDateTime(s.keysMailedAt)}` : 'noch nicht verschickt'}</dd>
        <dt>Letzter Abruf</dt>
        <dd>
          {s.lastFetchAt ? fmtDateTime(s.lastFetchAt) : '–'}
          {s.lastFetchCountry && ` (${s.lastFetchCountry})`}
        </dd>
      </dl>
      <p className="muted">
        Eingehende Mails verschlüsselt das Relay sofort mit dem Schlüssel des ELW; ELVIS holt sie alle 30 Sekunden ab. Gegenstellen finden den Schlüssel automatisch (WKD,
        Autocrypt) und antworten verschlüsselt.
      </p>
      <div className="form-actions">
        <button
          className="btn btn-danger"
          disabled={cancel.isPending}
          onClick={() =>
            window.confirm(`${s.address} kündigen? Noch nicht abgeholte Mails werden gelöscht, die Adresse ist 90 Tage gesperrt. Bereits abgeholte Mails bleiben in ELVIS.`) &&
            cancel.mutate()
          }
        >
          Postfach kündigen
        </button>
      </div>
    </>
  );
}
