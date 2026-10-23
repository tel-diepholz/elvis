import { useState } from 'react';
import { Download } from 'lucide-react';
import { DEFAULT_VEHICLE_SIGN, describeTacticalSign, tacticalSignSvg, type TacticalSign } from '@elvis/shared';
import { Card, PageHeader } from '../components/ui';
import { TacticalSignImage } from '../components/tactical/TacticalSign';
import { TacticalSignEditor } from '../components/tactical/TacticalSignEditor';

const base: TacticalSign = { ...DEFAULT_VEHICLE_SIGN, function: 'none', text: '' };

/** Häufige Zeichen als Ausgangspunkt. */
const PRESETS: { name: string; sign: TacticalSign }[] = [
  { name: 'ELW 2', sign: DEFAULT_VEHICLE_SIGN },
  { name: 'LF 20', sign: { ...base, function: 'brandbekaempfung', text: 'LF 20' } },
  { name: 'DLK 23/12', sign: { ...base, text: 'DLK' } },
  { name: 'RTW', sign: { ...base, org: 'hilfsorganisation', function: 'rettung', text: 'RTW' } },
  { name: 'Löschzug', sign: { ...base, base: 'unit', function: 'brandbekaempfung', size: 'zug' } },
  { name: 'Gruppe TH (THW)', sign: { ...base, base: 'unit', org: 'thw', function: 'technischeHilfe', size: 'gruppe' } },
  { name: 'TEL', sign: { ...base, base: 'unit', org: 'fuehrung', text: 'TEL' } },
  { name: 'Einsatzleiter', sign: { ...base, base: 'person', org: 'fuehrung', leader: true, text: 'EL' } },
  { name: 'Meldekopf', sign: { ...base, base: 'facility', org: 'fuehrung', text: 'M' } },
  { name: 'Befehlsstelle', sign: { ...base, base: 'command', org: 'feuerwehr', size: 'gruppe' } },
];

function download(sign: TacticalSign) {
  const svg = tacticalSignSvg(sign, { height: 300, title: describeTacticalSign(sign) });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `taktisches-zeichen-${(sign.text || sign.base).replace(/[^\w-]+/g, '_')}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function SignGeneratorPage() {
  const [sign, setSign] = useState<TacticalSign>(DEFAULT_VEHICLE_SIGN);
  return (
    <>
      <PageHeader
        title="Taktische Zeichen"
        subtitle="Zeichen nach der Empfehlung „Taktische Zeichen im Bevölkerungsschutz“ (DV 102) zusammenstellen"
        actions={
          <button className="btn btn-primary" onClick={() => download(sign)}>
            <Download size={18} /> SVG herunterladen
          </button>
        }
      />
      <div className="grid">
        <Card title="Zeichen" className="span-2">
          <TacticalSignEditor value={sign} onChange={setSign} />
          <p className="muted">{describeTacticalSign(sign)}</p>
        </Card>
        <Card title="Vorlagen">
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button key={p.name} className="preset" onClick={() => setSign(p.sign)} title={describeTacticalSign(p.sign)}>
                <TacticalSignImage sign={p.sign} height={48} />
                <span>{p.name}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
