import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Plus, Trash2, Truck } from 'lucide-react';
import { MAX_VEHICLE_CONTACTS, VEHICLE_CONTACT_KIND_LABEL, settingsInputSchema, type Settings, type TacticalSign, type VehicleContact } from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { useSettings } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { Card, Field, Loading } from '../../components/ui';
import { TacticalSignEditor } from '../../components/tactical/TacticalSignEditor';

/** Fahrzeug, Einheit und Kartenzeichen – nur Admins dürfen ändern. */
export function SettingsCard() {
  const { user } = useAuth();
  const toast = useToast();
  const { data: settings } = useSettings();
  const [vehicle, setVehicle] = useState<Settings['vehicle'] | null>(null);
  const [sign, setSign] = useState<TacticalSign | null>(null);
  const [dirty, setDirty] = useState(false);
  const admin = !!user?.isAdmin;

  useEffect(() => {
    if (settings && !dirty) {
      setVehicle(settings.vehicle);
      setSign(settings.mapSign);
    }
  }, [settings, dirty]);

  const save = useMutation({
    mutationFn: () => api.updateSettings({ vehicle: vehicle!, mapSign: sign! }),
    onSuccess: () => {
      setDirty(false);
      toast('success', 'Einstellungen gespeichert');
    },
    onError: (e) => toast('error', e.message),
  });

  if (!settings || !vehicle || !sign) return <Loading />;
  const setV = (k: 'name' | 'callsign' | 'organization') => (e: { target: { value: string } }) => (setVehicle({ ...vehicle, [k]: e.target.value }), setDirty(true));
  const contacts = vehicle.contacts ?? [];
  const setContacts = (next: VehicleContact[]) => (setVehicle({ ...vehicle, contacts: next }), setDirty(true));
  const setContact = (i: number, patch: Partial<VehicleContact>) => setContacts(contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const check = settingsInputSchema.safeParse({ vehicle, mapSign: sign });

  return (
    <Card title="Fahrzeug & Einheit" icon={<Truck size={18} />} className="span-3">
      {!admin && <p className="muted">Nur Admins können diese Einstellungen ändern.</p>}
      <div className="form-grid">
        <Field label="Fahrzeugname">
          <input value={vehicle.name} onChange={setV('name')} maxLength={40} disabled={!admin} />
        </Field>
        <Field label="Funkrufname">
          <input value={vehicle.callsign} onChange={setV('callsign')} maxLength={60} disabled={!admin} />
        </Field>
        <Field label="Einheit / Organisation">
          <input value={vehicle.organization} onChange={setV('organization')} maxLength={100} disabled={!admin} />
        </Field>
      </div>
      <h3 className="section-title">Kontaktdaten</h3>
      {contacts.length === 0 ? (
        <p className="muted">Noch keine Kontaktdaten. Hier stehen z. B. Primär- und Sekundär-SIM, Satellitentelefon oder die E-Mail-Adresse der Einheit.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Art</th>
                <th>E-Mail / Rufnummer</th>
                <th>Beschriftung</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contacts.map((c, i) => (
                <tr key={i}>
                  <td>
                    <select value={c.kind} onChange={(e) => setContact(i, { kind: e.target.value as VehicleContact['kind'] })} disabled={!admin} aria-label={`Art von Kontakt ${i + 1}`}>
                      {(Object.keys(VEHICLE_CONTACT_KIND_LABEL) as VehicleContact['kind'][]).map((k) => (
                        <option key={k} value={k}>
                          {VEHICLE_CONTACT_KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type={c.kind === 'email' ? 'email' : 'tel'}
                      value={c.value}
                      onChange={(e) => setContact(i, { value: e.target.value })}
                      maxLength={c.kind === 'email' ? 254 : 40}
                      placeholder={c.kind === 'email' ? 'elw@feuerwehr.de' : '+49 170 1234567'}
                      disabled={!admin}
                      aria-label={`${VEHICLE_CONTACT_KIND_LABEL[c.kind]} von Kontakt ${i + 1}`}
                    />
                  </td>
                  <td>
                    <input value={c.label} onChange={(e) => setContact(i, { label: e.target.value })} maxLength={40} placeholder="z. B. Satellitentelefon" disabled={!admin} aria-label={`Beschriftung von Kontakt ${i + 1}`} />
                  </td>
                  <td>
                    {admin && (
                      <button type="button" className="btn btn-icon" aria-label={`Kontakt ${i + 1} entfernen`} onClick={() => setContacts(contacts.filter((_, j) => j !== i))}>
                        <Trash2 size={16} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {admin && (
        <div className="form-actions">
          <button type="button" className="btn" disabled={contacts.length >= MAX_VEHICLE_CONTACTS} onClick={() => setContacts([...contacts, { kind: 'phone', value: '', label: '' }])}>
            <Plus size={16} /> Kontakt hinzufügen
          </button>
        </div>
      )}
      {dirty && !check.success && <p className="tone-warn">{check.error.issues[0]?.message}</p>}
      <h3 className="section-title">Taktisches Zeichen für die Karte</h3>
      <TacticalSignEditor value={sign} onChange={(s) => (setSign(s), setDirty(true))} disabled={!admin} />
      <div className="form-actions spread">
        <span className="muted">{settings.updatedAt ? `Zuletzt geändert ${fmtDateTime(settings.updatedAt)} von ${settings.updatedBy}` : 'Vorgaben aus der Konfiguration'}</span>
        {admin && (
          <span className="btn-row">
            <button className="btn" disabled={!dirty} onClick={() => setDirty(false)}>
              Verwerfen
            </button>
            <button className="btn btn-primary" disabled={!dirty || save.isPending || !check.success} onClick={() => save.mutate()}>
              Speichern
            </button>
          </span>
        )}
      </div>
    </Card>
  );
}
