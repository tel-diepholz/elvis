import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RadioTower } from 'lucide-react';
import { VEHICLE_CONTACT_KIND_LABEL, vehicleLabel, type MessagingConnection, type MessagingStatus } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { useSettings } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading } from '../../components/ui';
import { RegionPicker } from '../../components/messaging/RegionPicker';

const CONNECTION: Record<MessagingConnection, { tone: 'ok' | 'warn' | 'alarm' | undefined; label: string }> = {
  connected: { tone: 'ok', label: 'Verbunden' },
  connecting: { tone: 'warn', label: 'Verbindet …' },
  polling: { tone: 'alarm', label: 'Gestört – Abruf jede Minute' },
  disabled: { tone: undefined, label: 'Getrennt' },
};

const fingerprint = (fp: string) => fp.replace(/(.{4})/g, '$1 ').trim();

/**
 * Cloud Messaging: diese Installation mit ihrer Gebietskörperschaft ins Verzeichnis eintragen, damit andere
 * Fahrzeuge sie finden und anschreiben können. Voraussetzung ist ein aktives ELVIS-Postfach.
 */
export function MessagingCard() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const admin = !!user?.isAdmin;
  const { data: s } = useQuery({ queryKey: ['messaging', 'status'], queryFn: api.messagingStatus });
  const { data: settings } = useSettings();
  const [regionArs, setRegionArs] = useState<string | null>(null);
  const [listed, setListed] = useState(true);
  useEffect(() => {
    if (s?.profile && regionArs === null) {
      setRegionArs(s.profile.regionArs);
      setListed(s.profile.listed);
    }
  }, [s, regionArs]);

  const done = (msg: string) => (next: MessagingStatus) => {
    qc.setQueryData(['messaging', 'status'], next);
    void qc.invalidateQueries({ queryKey: ['chat'] });
    toast('success', msg);
  };
  const register = useMutation({
    mutationFn: () => api.messagingRegister({ regionArs: regionArs ?? '', listed }),
    onSuccess: done('Im Verzeichnis eingetragen'),
    onError: (e) => toast('error', e.message),
  });
  const unregister = useMutation({
    mutationFn: api.messagingUnregister,
    onSuccess: (next) => (setRegionArs(null), done('Aus dem Verzeichnis abgemeldet')(next)),
    onError: (e) => toast('error', e.message),
  });

  if (!s || !settings) return <Loading />;
  const conn = CONNECTION[s.connection];
  const vehicle = settings.vehicle;
  const changed = !!s.profile && (s.profile.regionArs !== regionArs || s.profile.listed !== listed);

  return (
    <Card title="Cloud Messaging" icon={<RadioTower size={18} />} actions={s.registered && <Badge tone={conn.tone}>{conn.label}</Badge>}>
      {!s.enabled ? (
        <p className="muted">
          Abgeschaltet. Cloud Messaging braucht die Cloud-Anbindung (<code>app.relayUrl</code> in <code>config/elvis.json</code>).
        </p>
      ) : !s.mailbox ? (
        <p className="muted">
          Cloud Messaging verschlüsselt mit dem Schlüssel des ELVIS-Postfachs. Bitte zuerst unter <Link to="/einstellungen#mail">E-Mail</Link> ein Postfach einrichten.
        </p>
      ) : (
        <>
          <p className="muted">
            Andere ELVIS-Installationen finden dieses Fahrzeug über seine Gebietskörperschaft und können einen Chat anfragen. Nachrichten und Dokumente sind
            Ende-zu-Ende verschlüsselt; das Relay sieht nur, wer wann wem schreibt.
          </p>
          <Field label="Gebietskörperschaft" hint="Jede Ebene ist möglich – vom Land bis zur Gemeinde.">
            <RegionPicker value={regionArs ?? ''} onChange={(ars) => setRegionArs(ars)} disabled={!admin} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} disabled={!admin} />
            Im Verzeichnis sichtbar (sonst kann diese Installation nur selbst anfragen)
          </label>
          <h3 className="section-title">Was andere sehen</h3>
          <dl className="kv">
            <dt>Fahrzeug</dt>
            <dd>
              {vehicleLabel(vehicle)} · {vehicle.organization}
            </dd>
            <dt>Kontakt</dt>
            <dd>
              {vehicle.contacts.length ? (
                vehicle.contacts.map((c, i) => (
                  <span key={i} className="messaging-contact">
                    {c.label || VEHICLE_CONTACT_KIND_LABEL[c.kind]}: {c.value}
                  </span>
                ))
              ) : (
                <span className="muted">
                  keine – unter <Link to="/einstellungen#fahrzeug">Fahrzeug &amp; Einheit</Link> eintragen
                </span>
              )}
            </dd>
            {s.profile && (
              <>
                <dt>Adresse</dt>
                <dd>{s.profile.address}</dd>
                <dt>Schlüssel</dt>
                <dd className="mono small">{fingerprint(s.profile.fingerprint)}</dd>
              </>
            )}
          </dl>
          {s.registered && s.connection !== 'connected' && s.lastError && <p className="tone-alarm small">{s.lastError}</p>}
          {s.registered && s.since && <p className="muted small">{conn.label} seit {fmtDateTime(s.since)}</p>}
          {admin && (
            <div className="form-actions spread">
              {s.registered ? (
                <button className="btn btn-danger" disabled={unregister.isPending} onClick={() => window.confirm('Aus dem Verzeichnis abmelden? Laufende Fahrzeug-Chats werden beendet.') && unregister.mutate()}>
                  Abmelden
                </button>
              ) : (
                <span />
              )}
              <button className="btn btn-primary" disabled={regionArs === null || register.isPending || (s.registered && !changed)} onClick={() => register.mutate()}>
                {s.registered ? 'Speichern' : 'Registrieren'}
              </button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
