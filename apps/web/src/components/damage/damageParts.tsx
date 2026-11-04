import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { damageAccountLabel, type DamageAccount } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';

/** Schadenkonten einer Lage (Topic „damage“) */
export function useDamageAccounts(incidentId: number | null | undefined) {
  const { user } = useAuth();
  return useQuery({ queryKey: ['damage', incidentId ?? 0], queryFn: () => api.damageAccounts(incidentId!), enabled: !!user && !!incidentId });
}

/** Nummer der Schadenstelle im roten Kreis (wie auf der Lagekarte) */
export function DamageNumber({ number, size = 26 }: { number: number; size?: number }) {
  return (
    <span className="damage-number" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-label={`Schadenstelle ${number}`}>
      {number}
    </span>
  );
}

const NEW = 'new';

/**
 * Einsatzabschnitt einer Einheit = Schadenkonto. Aufgelöste Konten stehen nur zur Wahl, wenn die Einheit noch darin ist;
 * „+ neues Schadenkonto“ legt eines an und wählt es aus.
 */
export function AccountSelect({ incidentId, value, onChange }: { incidentId: number; value: number | null; onChange: (id: number | null) => void }) {
  const toast = useToast();
  const { data: accounts = [] } = useDamageAccounts(incidentId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.createDamageAccount(incidentId, { name: name.trim() }),
    onSuccess: (a: DamageAccount) => (onChange(a.id), setCreating(false), setName(''), toast('success', `Schadenkonto ${damageAccountLabel(a)} eingerichtet`)),
    onError: (e: Error) => toast('error', e.message),
  });
  const options = accounts.filter((a) => !a.closedAt || a.id === value);

  if (creating)
    return (
      <div className="inline-form">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Bezeichnung, z. B. EA Brandbekämpfung"
          maxLength={100}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }
            if (e.key === 'Escape') setCreating(false);
          }}
        />
        <button type="button" className="btn btn-sm btn-primary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
          Anlegen
        </button>
        <button type="button" className="btn btn-sm" onClick={() => setCreating(false)}>
          Abbrechen
        </button>
      </div>
    );

  return (
    <select value={value ?? ''} onChange={(e) => (e.target.value === NEW ? setCreating(true) : onChange(e.target.value ? Number(e.target.value) : null))}>
      <option value="">– kein Abschnitt –</option>
      {options.map((a) => (
        <option key={a.id} value={a.id}>
          {damageAccountLabel(a)}
          {a.closedAt ? ' (aufgelöst)' : ''}
        </option>
      ))}
      <option value={NEW}>+ neues Schadenkonto …</option>
    </select>
  );
}
