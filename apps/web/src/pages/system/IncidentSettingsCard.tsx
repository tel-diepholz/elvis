import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Lock, Siren } from 'lucide-react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading } from '../../components/ui';
import { useIncidentSettings } from '../incident/IncidentForm';

const parse = (text: string) => [...new Set(text.split('\n').map((l) => l.trim().slice(0, 40)).filter(Boolean))];

/** Vordefinierte Einsatzstichworte für Lagen der Art Brand/Technische Hilfe. Nur Admins. */
export function IncidentSettingsCard() {
  const toast = useToast();
  const { data } = useIncidentSettings();
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    // Bearbeitbar sind nur die eigenen; die anderer Bereiche stehen darüber
    if (data && !dirty) setText(data.keywords.filter((k) => !data.managed.some((m) => m.name === k)).join('\n'));
  }, [data, dirty]);

  const save = useMutation({
    mutationFn: () => api.saveIncidentSettings({ keywords: parse(text) }),
    onSuccess: () => (setDirty(false), toast('success', 'Einsatzstichworte gespeichert')),
    onError: (e) => toast('error', e.message),
  });

  if (!data) return <Loading />;
  const count = parse(text).length;

  return (
    <Card title="Einsatzstichworte" icon={<Siren size={18} />} className="span-2">
      <p className="muted">
        Bei Lagen der Art „Brand/Technische Hilfe“ wird das Einsatzstichwort aus dieser Liste ausgewählt. Freie Eingaben sind dort nicht möglich.
      </p>
      {data.managed.length > 0 && (
        <div className="form">
          <span className="field-label">Aus der Cloud (hier nur lesbar)</span>
          <div className="chip-row">
            {data.managed.map((m) => (
              <span key={m.name} title={`Gepflegt von ${m.origin}`}>
                <Badge>
                  <Lock size={12} /> {m.name}
                </Badge>
              </span>
            ))}
          </div>
        </div>
      )}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Stichworte (eines pro Zeile, in der gewünschten Reihenfolge)" hint={`${count} Stichwort${count === 1 ? '' : 'e'} · höchstens 40 Zeichen je Stichwort`}>
          <textarea
            rows={8}
            value={text}
            placeholder={'B1\nB2\nB3\nTH1\nTH2\nABC1'}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
          />
        </Field>
        <div className="form-actions spread">
          <span className="cell-sub">{data.updatedAt && `Zuletzt geändert ${fmtDateTime(data.updatedAt)} von ${data.updatedBy}`}</span>
          <button type="submit" className="btn btn-primary" disabled={!dirty || save.isPending || count > 200}>
            Speichern
          </button>
        </div>
      </form>
    </Card>
  );
}
