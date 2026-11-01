import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PhoneCall, RotateCcw } from 'lucide-react';
import { PHONE_MODEL, type Phone, type PhoneKeyInput, type PhoneKeySlot } from '@elvis/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/format';
import { useActiveIncident } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { KeyEditor, KeyGrid } from '../components/phones/PhoneKeys';
import { Badge, Card, EmptyState, Loading, PageHeader, Segmented, type Tone } from '../components/ui';

type Scope = 'incident' | 'phone';

const PUSH: Record<NonNullable<Phone['push']>['state'], [string, Tone]> = {
  ok: ['übertragen', 'ok'],
  running: ['wird übertragen', 'info'],
  failed: ['nicht übertragen', 'warn'],
};

/** Zustand eines Telefons: zuletzt gesehen und letzte Übertragung der Tasten */
export function PhoneStatus({ phone }: { phone: Phone }) {
  return (
    <span className="btn-row">
      {phone.lastSeenAt ? <Badge>{`Konfiguration ${fmtDateTime(phone.lastSeenAt)}`}</Badge> : <Badge tone="warn">noch nie abgerufen</Badge>}
      {phone.push && (
        <span title={phone.push.error ?? undefined}>
          <Badge tone={PUSH[phone.push.state][1]}>{`Tasten ${PUSH[phone.push.state][0]}`}</Badge>
        </span>
      )}
    </span>
  );
}

function PhoneKeysCard({ phone, phones }: { phone: Phone; phones: Phone[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: incident } = useActiveIncident();
  const isAdmin = !!user?.isAdmin;
  const [scope, setScope] = useState<Scope>(incident ? 'incident' : 'phone');
  useEffect(() => setScope(incident ? 'incident' : 'phone'), [incident?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [editing, setEditing] = useState<PhoneKeySlot | null>(null);

  const queryKey = ['phones', phone.id, 'keys'];
  const { data: slots } = useQuery({ queryKey, queryFn: () => api.phoneKeys(phone.id) });
  const done = (s: PhoneKeySlot[]) => (qc.setQueryData(queryKey, s), setEditing(null));
  const save = useMutation({ mutationFn: ({ idx, key }: { idx: number; key: PhoneKeyInput }) => api.setPhoneKey(phone.id, idx, key, scope), onSuccess: done, onError: (e) => toast('error', e.message) });
  const clear = useMutation({ mutationFn: (idx: number) => api.clearPhoneKey(phone.id, idx, scope), onSuccess: done, onError: (e) => toast('error', e.message) });
  const reset = useMutation({ mutationFn: () => api.clearPhoneOverrides(phone.id), onSuccess: done, onError: (e) => toast('error', e.message) });

  const canEdit = scope === 'incident' ? !!incident : isAdmin;
  const overrides = slots?.filter((s) => s.incident).length ?? 0;
  const layer = (s: PhoneKeySlot) => (scope === 'incident' ? s.incident : s.phone);

  return (
    <Card
      title={`${phone.name} · ${phone.extension}`}
      icon={<PhoneCall size={18} />}
      className="span-3"
      actions={
        overrides > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={reset.isPending}
            onClick={() => window.confirm(`Alle ${overrides} Änderungen für diesen Einsatz zurücknehmen?`) && reset.mutate()}
          >
            <RotateCcw size={16} /> Grundbelegung
          </button>
        )
      }
    >
      <div className="form-actions spread">
        <PhoneStatus phone={phone} />
        {isAdmin && (
          <Segmented
            label="Was wird geändert"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'incident', label: 'Nur für diesen Einsatz', disabled: !incident, title: incident ? undefined : 'Kein Einsatz aufgelegt' },
              { value: 'phone', label: 'Grundbelegung' },
            ]}
          />
        )}
      </div>
      <p className="muted">
        {scope === 'incident'
          ? incident
            ? 'Änderungen gelten nur für den laufenden Einsatz – mit dem Einsatzende bekommt das Telefon wieder seine Grundbelegung.'
            : 'Tasten lassen sich im laufenden Einsatz ändern. Ohne Einsatz gilt die Grundbelegung (pflegen Admins).'
          : 'Grundbelegung dieses Telefons – gilt außerhalb von Einsätzen und zu Beginn jedes Einsatzes. Freie Tasten übernimmt es aus der Vorlage (Einstellungen → Telefone).'}
      </p>
      {!slots ? <Loading /> : <KeyGrid slots={slots} perPage={PHONE_MODEL[phone.model].keysPerPage} onSelect={setEditing} disabled={!canEdit} />}
      {editing && (
        <KeyEditor
          slot={editing}
          layer={layer(editing)}
          title={`${phone.name}: Taste ${editing.idx + 1}${scope === 'incident' ? ' (Einsatz)' : ' (Grundbelegung)'}`}
          phones={phones.filter((p) => p.id !== phone.id)}
          pending={save.isPending || clear.isPending}
          clearLabel={scope === 'incident' ? 'Zurück auf Grundbelegung' : 'Vorlage verwenden'}
          onClear={layer(editing) ? () => clear.mutate(editing.idx) : undefined}
          onSave={(key) => save.mutate({ idx: editing.idx, key })}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

/** Tischtelefone: Schnellwahltasten je Telefon – im Einsatz für alle änderbar, die Grundbelegung pflegen Admins */
export function PhonesPage() {
  const { user } = useAuth();
  const { data: phones } = useQuery({ queryKey: ['phones'], queryFn: api.phones });
  const [selected, setSelected] = useState<string | null>(null);
  const phone = phones?.find((p) => p.id === selected) ?? phones?.[0];

  return (
    <>
      <PageHeader title="Telefone" subtitle="Schnellwahl- und Nebenstellentasten der Tischtelefone" />
      {!phones ? (
        <Loading />
      ) : phones.length === 0 ? (
        <EmptyState icon={<PhoneCall size={32} />} title="Noch keine Telefone">
          {user?.isAdmin ? (
            <>
              Telefone legen Admins unter <Link to="/einstellungen#telefone">Einstellungen → Telefone (Snom)</Link> an.
            </>
          ) : (
            'Telefone legen Admins in den Einstellungen an.'
          )}
        </EmptyState>
      ) : (
        <div className="grid">
          {phones.length > 1 && (
            <div className="span-3">
              <Segmented label="Telefon" value={phone!.id} onChange={setSelected} options={phones.map((p) => ({ value: p.id, label: `${p.name} (${p.extension})` }))} />
            </div>
          )}
          {phone && <PhoneKeysCard key={phone.id} phone={phone} phones={phones} />}
        </div>
      )}
    </>
  );
}
