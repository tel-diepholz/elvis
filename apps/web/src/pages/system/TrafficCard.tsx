import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plane } from 'lucide-react';
import { trafficSettingsInputSchema, type TrafficSettingsInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Toggle } from '../../components/ui';

/** Flugzeuge (adsb.fi) und Schiffe (aisstream.io) für die Kartenebenen. Nur Admins. */
export function TrafficCard() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ['traffic', 'system'], queryFn: api.trafficSettings });
  const [form, setForm] = useState<{ aircraft: boolean; ships: boolean } | null>(null);
  /** undefined = Schlüssel unverändert, '' = Eingabe läuft, null = entfernen */
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty) setForm({ aircraft: data.aircraft, ships: data.ships });
  }, [data, dirty]);

  const input: TrafficSettingsInput | null = form && { ...form, ...(key !== undefined && { aisKey: key }) };
  const save = useMutation({
    mutationFn: () => api.saveTrafficSettings(input!),
    onSuccess: () => {
      setDirty(false);
      setKey(undefined);
      void queryClient.invalidateQueries({ queryKey: ['traffic'] });
      toast('success', 'Einstellungen gespeichert');
    },
    onError: (e) => toast('error', e.message),
  });

  if (!data || !form || !input) return <Loading />;
  const change = (p: Partial<typeof form>) => (setForm({ ...form, ...p }), setDirty(true));
  const valid = trafficSettingsInputSchema.safeParse(input);

  return (
    <Card title="Luft- und Schiffsverkehr" icon={<Plane size={18} />} className="span-2">
      <p className="muted">
        Auf der Karte lassen sich unter <em>Ebenen</em> Flugzeuge und Schiffe einblenden und einzelne über <em>Objekte</em> in die Objektliste übernehmen. Die Daten
        kommen aus dem Internet; ohne Verbindung bleiben die Ebenen leer.
      </p>

      <h3 className="section-title">Flugzeuge (ADS-B und MLAT)</h3>
      <Toggle label="Flugzeuge anbieten" checked={form.aircraft} onChange={(v) => change({ aircraft: v })} disabled={!data.aircraftUrl} />
      <p className="muted">
        {data.aircraftUrl ? (
          <>
            Quelle: <code>{data.aircraftUrl}</code> – Daten der Empfänger-Community, ohne Schlüssel, frei für nicht kommerzielle Nutzung mit Quellenangabe.
            Höchstens eine Anfrage pro Sekunde: alle Arbeitsplätze und Bildschirme teilen sich die Abfragen, aktualisiert wird alle 10 s. MLAT-Ziele (ohne ADS-B, per
            Laufzeitmessung geortet) sind gekennzeichnet.
          </>
        ) : (
          'In der Konfiguration abgeschaltet (traffic.aircraftUrl = null).'
        )}
      </p>

      <h3 className="section-title">Schiffe (AIS)</h3>
      <Toggle label="Schiffe anbieten" checked={form.ships} onChange={(v) => change({ ships: v })} disabled={!data.aisUrl} />
      <p className="muted">
        Quelle: aisstream.io (kostenlos, ohne Verfügbarkeitsgarantie). Den Schlüssel gibt es nach Anmeldung mit einem GitHub-Konto auf{' '}
        <a href="https://aisstream.io" target="_blank" rel="noreferrer">
          aisstream.io
        </a>
        . Empfangen werden Schiffe im Umkreis von rund 100 km um den Einsatzort, ohne Einsatz um das Fahrzeug.
      </p>
      <div className="form-grid">
        <Field label="aisstream.io-Schlüssel" hint="Bleibt auf dem Fahrzeugserver und wird nicht wieder angezeigt">
          {key === undefined ? (
            <span className="btn-row">
              <Badge tone={data.aisKeySet ? 'ok' : 'muted'}>{data.aisKeySet ? 'hinterlegt' : 'nicht hinterlegt'}</Badge>
              <button type="button" className="btn btn-sm" onClick={() => (setKey(''), setDirty(true))}>
                {data.aisKeySet ? 'Ändern' : 'Eintragen'}
              </button>
              {data.aisKeySet && (
                <button type="button" className="btn btn-sm" onClick={() => (setKey(null), setDirty(true))}>
                  Entfernen
                </button>
              )}
            </span>
          ) : key === null ? (
            <span className="muted">Wird beim Speichern entfernt</span>
          ) : (
            <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Schlüssel einfügen" />
          )}
        </Field>
      </div>

      {!valid.success && key !== '' && <p className="tone-alarm">{valid.error.issues[0]?.message}</p>}
      <div className="form-actions spread">
        <span className="muted">{data.updatedAt ? `Zuletzt geändert ${fmtDateTime(data.updatedAt)} von ${data.updatedBy}` : 'Vorgaben'}</span>
        <span className="btn-row">
          <button type="button" className="btn" disabled={!dirty} onClick={() => (setDirty(false), setKey(undefined))}>
            Verwerfen
          </button>
          <button type="button" className="btn btn-primary" disabled={!dirty || !valid.success || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>
    </Card>
  );
}
