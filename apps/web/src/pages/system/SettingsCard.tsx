import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Truck } from 'lucide-react';
import type { Settings, TacticalSign } from '@elvis/shared';
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
  const setV = (k: keyof Settings['vehicle']) => (e: { target: { value: string } }) => (setVehicle({ ...vehicle, [k]: e.target.value }), setDirty(true));

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
      <h3 className="section-title">Taktisches Zeichen für die Karte</h3>
      <TacticalSignEditor value={sign} onChange={(s) => (setSign(s), setDirty(true))} disabled={!admin} />
      <div className="form-actions spread">
        <span className="muted">{settings.updatedAt ? `Zuletzt geändert ${fmtDateTime(settings.updatedAt)} von ${settings.updatedBy}` : 'Vorgaben aus der Konfiguration'}</span>
        {admin && (
          <span className="btn-row">
            <button className="btn" disabled={!dirty} onClick={() => setDirty(false)}>
              Verwerfen
            </button>
            <button className="btn btn-primary" disabled={!dirty || save.isPending || !vehicle.name.trim() || !vehicle.callsign.trim() || !vehicle.organization.trim()} onClick={() => save.mutate()}>
              Speichern
            </button>
          </span>
        )}
      </div>
    </Card>
  );
}
