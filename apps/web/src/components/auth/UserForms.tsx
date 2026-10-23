import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PIN_PATTERN, type User } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../lib/toast';
import { Field } from '../ui';
import { PinPad } from './PinPad';

/** PIN zweimal eingeben – Grundlage für Anlegen, Zurücksetzen und Ändern. */
function NewPinFields({ pin, setPin, confirm, setConfirm }: { pin: string; setPin: (v: string) => void; confirm: string; setConfirm: (v: string) => void }) {
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 4);
  return (
    <div className="form-grid">
      <Field label="PIN (4 Ziffern) *">
        <input type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(digits(e.target.value))} placeholder="••••" />
      </Field>
      <Field label="PIN wiederholen *">
        <input type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(digits(e.target.value))} placeholder="••••" />
      </Field>
    </div>
  );
}

const pinError = (pin: string, confirm: string) =>
  !PIN_PATTERN.test(pin) ? 'Die PIN muss aus genau 4 Ziffern bestehen' : pin !== confirm ? 'Die PINs stimmen nicht überein' : null;

/** Ersteinrichtung oder neuer Benutzer. */
export function UserCreateForm({ mode, onDone }: { mode: 'setup' | 'create'; onDone: (u: User) => void }) {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [touched, setTouched] = useState(false);
  const err = pinError(pin, confirm);

  const save = useMutation({
    mutationFn: () =>
      mode === 'setup' ? api.setupFirstAdmin({ firstName, lastName, pin }) : api.createUser({ firstName, lastName, pin, isAdmin }),
    onSuccess: async (u) => {
      if (mode === 'setup') await refresh();
      toast('success', mode === 'setup' ? `Willkommen, ${u.firstName}! Sie sind als Admin angemeldet.` : `${u.firstName} ${u.lastName} angelegt`);
      onDone(u);
    },
    onError: (e) => toast('error', e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!err && firstName.trim() && lastName.trim()) save.mutate();
  };

  return (
    <form className="form" onSubmit={submit}>
      {mode === 'setup' && <p className="muted">Willkommen bei ELVIS. Legen Sie den ersten Benutzer an – er erhält Admin-Rechte.</p>}
      <div className="form-grid">
        <Field label="Vorname *">
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={60} autoFocus required />
        </Field>
        <Field label="Nachname *">
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={60} required />
        </Field>
      </div>
      <NewPinFields pin={pin} setPin={setPin} confirm={confirm} setConfirm={setConfirm} />
      {touched && err && <p className="hint tone-alarm">{err}</p>}
      {mode === 'create' && user?.isAdmin && (
        <label className="checkbox">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Admin-Rechte (Benutzer verwalten, Addons, Docker-Hosts)
        </label>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {mode === 'setup' ? 'Admin anlegen und anmelden' : 'Benutzer anlegen'}
        </button>
      </div>
    </form>
  );
}

/** Eigene PIN ändern (aktuelle PIN per Ziffernblock, neue doppelt). */
export function ChangePinForm({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const err = pinError(pin, confirm);
  const save = useMutation({
    mutationFn: () => api.changeOwnPin(current, pin),
    onSuccess: () => {
      toast('success', 'PIN geändert – andere Sitzungen wurden abgemeldet');
      onDone();
    },
    onError: (e) => {
      toast('error', e.message);
      setCurrent('');
    },
  });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!err && current.length === 4) save.mutate();
      }}
    >
      <Field label="Aktuelle PIN">
        <PinPad value={current} onChange={setCurrent} label="Aktuelle PIN" />
      </Field>
      <NewPinFields pin={pin} setPin={setPin} confirm={confirm} setConfirm={setConfirm} />
      {touched && err && <p className="hint tone-alarm">{err}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={save.isPending || current.length !== 4}>
          PIN ändern
        </button>
      </div>
    </form>
  );
}

/** Admin: Name, Admin-Flag und PIN eines anderen Benutzers bearbeiten. */
export function UserEditForm({ target, onDone }: { target: User; onDone: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [firstName, setFirstName] = useState(target.firstName);
  const [lastName, setLastName] = useState(target.lastName);
  const [isAdmin, setIsAdmin] = useState(target.isAdmin);
  const [resetPin, setResetPin] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const err = resetPin ? pinError(pin, confirm) : null;
  const self = user?.id === target.id;

  const save = useMutation({
    mutationFn: () =>
      api.updateUser(target.id, {
        firstName,
        lastName,
        ...(user?.isAdmin && { isAdmin }),
        ...(resetPin && { pin }),
      }),
    onSuccess: () => {
      toast('success', 'Gespeichert');
      onDone();
    },
    onError: (e) => toast('error', e.message),
  });

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!err) save.mutate();
      }}
    >
      <div className="form-grid">
        <Field label="Vorname">
          <input value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={60} required />
        </Field>
        <Field label="Nachname">
          <input value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={60} required />
        </Field>
      </div>
      {user?.isAdmin && (
        <label className="checkbox">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Admin-Rechte
        </label>
      )}
      {user?.isAdmin && !self && (
        <>
          <label className="checkbox">
            <input type="checkbox" checked={resetPin} onChange={(e) => setResetPin(e.target.checked)} /> PIN zurücksetzen (meldet den Benutzer überall ab)
          </label>
          {resetPin && <NewPinFields pin={pin} setPin={setPin} confirm={confirm} setConfirm={setConfirm} />}
          {err && (pin || confirm) && <p className="hint tone-alarm">{err}</p>}
        </>
      )}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={save.isPending || !!err}>
          Speichern
        </button>
      </div>
    </form>
  );
}
