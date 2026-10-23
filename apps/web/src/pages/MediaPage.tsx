import { Camera, Monitor, Power, VideoOff } from 'lucide-react';
import { useCommand } from '../lib/hooks';
import { useDevice } from '../lib/live';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { Badge, Card, PageHeader } from '../components/ui';

export function MediaPage() {
  const dev = useDevice('media');
  const { send, pending } = useCommand('media');
  if (!dev)
    return (
      <>
        <PageHeader title="Medien" subtitle="Videomatrix, Monitore und Kameras" />
        <ModuleDisabled name="Videomatrix & Kameras" />
      </>
    );
  const s = dev.state;

  return (
    <>
      <PageHeader title="Medien" subtitle="Videomatrix, Monitore und Kameras" />
      <div className="grid">
        <Card title="Monitore & Videomatrix" icon={<Monitor size={18} />} className="span-2">
          <div className="displays">
            {s.displays.map((d) => (
              <div key={d.id} className={`display ${d.power ? 'on' : ''}`}>
                <div className="display-head">
                  <div>
                    <strong>{d.name}</strong>
                    <div className="cell-sub">{d.location}</div>
                  </div>
                  <button
                    className={`btn btn-icon ${d.power ? 'btn-primary' : ''}`}
                    disabled={pending}
                    onClick={() => send('display.power', { id: d.id, on: !d.power })}
                    aria-label={`${d.name} ${d.power ? 'ausschalten' : 'einschalten'}`}
                    aria-pressed={d.power}
                  >
                    <Power size={18} />
                  </button>
                </div>
                <div className="source-grid" role="radiogroup" aria-label={`Quelle für ${d.name}`}>
                  {s.sources.map((src) => (
                    <button
                      key={src.id}
                      role="radio"
                      aria-checked={d.sourceId === src.id}
                      className={`source ${d.sourceId === src.id ? 'active' : ''}`}
                      disabled={pending}
                      onClick={() => send('display.source', { id: d.id, sourceId: src.id })}
                    >
                      {src.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Kameras" icon={<Camera size={18} />}>
          {s.cameras.map((c) => (
            <div key={c.id} className="camera">
              <div className="camera-view">
                {c.online ? (
                  c.snapshotUrl ? <img src={c.snapshotUrl} alt={c.name} /> : <span className="muted">Kein Vorschaubild konfiguriert</span>
                ) : (
                  <span className="muted">
                    <VideoOff size={28} />
                    <br />
                    {c.id === 'cam-mast' ? 'Lichtmast eingefahren' : 'Offline'}
                  </span>
                )}
              </div>
              <div className="camera-head">
                <strong>{c.name}</strong>
                <Badge tone={c.online ? 'ok' : 'muted'}>{c.online ? 'online' : 'offline'}</Badge>
              </div>
              {c.ptz && c.presets.length > 0 && (
                <div className="chip-row">
                  {c.presets.map((p) => (
                    <button
                      key={p.id}
                      className={`btn btn-sm ${c.activePresetId === p.id ? 'btn-primary' : ''}`}
                      disabled={pending || !c.online}
                      onClick={() => send('camera.preset', { id: c.id, presetId: p.id })}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}
