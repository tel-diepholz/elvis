import { useEffect, useRef, useState } from 'react';
import { CloudRain, Droplets, Navigation, Thermometer, Wind } from 'lucide-react';
import { beaufort, compass, fmtNum, fmtOpt, fmtTime } from '../lib/format';
import { useInfo } from '../lib/hooks';
import { useDevice } from '../lib/live';
import { ModuleDisabled } from '../components/ModuleDisabled';
import { WindCompass } from '../components/WindCompass';
import { Badge, Card, PageHeader, Stat } from '../components/ui';

interface Sample {
  t: number;
  speed: number;
  gust: number;
}

const HISTORY_MIN = 30;

/** Rolling wind history kept in the browser while the page is open. */
function useWindHistory(speed?: number | null, gust?: number | null): Sample[] {
  const [samples, setSamples] = useState<Sample[]>([]);
  const last = useRef(0);
  useEffect(() => {
    if (speed === undefined || gust === undefined || speed === null || gust === null) return;
    const now = Date.now();
    if (now - last.current < 5000) return;
    last.current = now;
    setSamples((s) => [...s.filter((x) => now - x.t < HISTORY_MIN * 60_000), { t: now, speed, gust }]);
  }, [speed, gust]);
  return samples;
}

function WindChart({ samples, limit }: { samples: Sample[]; limit: number }) {
  if (samples.length < 2) return <p className="muted">Verlauf wird aufgezeichnet …</p>;
  const W = 600;
  const H = 160;
  const t0 = samples[0]!.t;
  const t1 = samples.at(-1)!.t;
  const max = Math.max(limit + 3, ...samples.map((s) => s.gust));
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - (v / max) * H;
  const line = (key: 'speed' | 'gust') => samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Windverlauf">
        <line x1="0" x2={W} y1={y(limit)} y2={y(limit)} className="chart-limit" />
        <path d={line('gust')} className="chart-line gust" />
        <path d={line('speed')} className="chart-line speed" />
      </svg>
      <figcaption className="chart-legend">
        <span className="legend speed">Mittelwind</span>
        <span className="legend gust">Böen</span>
        <span className="legend limit">Sturmwarnung ({limit} m/s)</span>
        <span className="muted">
          {fmtTime(new Date(t0))} – {fmtTime(new Date(t1))}
        </span>
      </figcaption>
    </figure>
  );
}

export function WeatherPage() {
  const dev = useDevice('weather');
  const { data: info } = useInfo();
  const stormLimit = info?.limits.stormWarnMs ?? 17;
  const history = useWindHistory(dev?.state.windSpeedMs, dev?.state.windGustMs);
  if (!dev)
    return (
      <>
        <PageHeader title="Wetterstation" />
        <ModuleDisabled name="Wetterstation" />
      </>
    );
  const s = dev.state;
  const dir = s.windDirectionDeg;
  const gust = s.windGustMs;
  // Taupunkt nach Magnus-Formel, nur mit Temperatur und Luftfeuchte
  const dewPoint =
    s.temperatureC !== null && s.humidityPercent !== null && s.humidityPercent > 0
      ? (() => {
          const g = Math.log(s.humidityPercent / 100) + (17.62 * s.temperatureC) / (243.12 + s.temperatureC);
          return (243.12 * g) / (17.62 - g);
        })()
      : null;

  return (
    <>
      <PageHeader
        title="Wetterstation"
        subtitle={
          <>
            {dev.name} · {dev.driver === 'sim' ? 'Simulation' : dev.driver} · <Badge tone={dev.online ? 'ok' : 'alarm'}>{dev.online ? 'empfängt Daten' : 'keine Daten'}</Badge>
          </>
        }
      />
      <div className="grid">
        <Card title="Wind" icon={<Wind size={18} />} className="span-2">
          <div className="wind-hero">
            <WindCompass directionDeg={dir} size={180} />
            <div className="grid-2 grow">
              <Stat
                label="Mittelwind (2 min)"
                value={fmtOpt(s.windSpeedMs)}
                unit="m/s"
                sub={s.windSpeedMs === null ? undefined : `${fmtNum(s.windSpeedMs * 3.6, 0)} km/h · Bft ${beaufort(s.windSpeedMs)}`}
              />
              <Stat
                label="Böen (10 min)"
                value={fmtOpt(gust)}
                unit="m/s"
                tone={gust === null ? undefined : gust >= stormLimit ? 'alarm' : gust >= stormLimit * 0.7 ? 'warn' : undefined}
                sub={gust === null ? undefined : `${fmtNum(gust * 3.6, 0)} km/h`}
              />
              <Stat label="Wind aus" value={dir === null ? '–' : compass(dir)} sub={dir === null ? undefined : `${dir}°`} />
              <Stat label="Ausbreitung nach" value={dir === null ? '–' : compass((dir + 180) % 360)} sub="Rauch / Gefahrstoffe" />
            </div>
          </div>
          <WindChart samples={history} limit={stormLimit} />
        </Card>
        <Card title="Atmosphäre" icon={<Thermometer size={18} />}>
          <div className="grid-2">
            <Stat label="Temperatur" value={fmtOpt(s.temperatureC)} unit="°C" />
            <Stat label="Luftfeuchte" value={fmtOpt(s.humidityPercent, 0)} unit="%" />
            <Stat label="Luftdruck" value={fmtOpt(s.pressureHpa, 0)} unit="hPa" />
            <Stat label="Niederschlag" value={fmtOpt(s.precipitationMmH)} unit="mm/h" />
          </div>
          <ul className="icon-list muted">
            {dewPoint !== null && (
              <li>
                <Droplets size={16} /> Taupunkt {fmtNum(dewPoint)} °C
              </li>
            )}
            <li>
              <CloudRain size={16} /> Aktualisiert {fmtTime(dev.updatedAt)}
            </li>
            {s.humidityPercent === null && <li>Luftfeuchte und Niederschlag misst diese Station nicht (bzw. noch keine Werte).</li>}
          </ul>
        </Card>
        <Card title="GPS & Kurs" icon={<Navigation size={18} />}>
          {s.position ? (
            <dl className="kv">
              <dt>Position</dt>
              <dd className="mono">
                {s.position.lat.toFixed(5)}, {s.position.lon.toFixed(5)}
              </dd>
              <dt>GPS</dt>
              <dd>
                <Badge tone={s.position.fix ? 'ok' : 'warn'}>{s.position.fix ? 'Fix' : 'kein Fix – letzte Position'}</Badge>
              </dd>
              <dt>Kurs</dt>
              <dd>{s.position.headingDeg === null ? '–' : `${s.position.headingDeg}° (${compass(s.position.headingDeg)})`}</dd>
            </dl>
          ) : (
            <p className="muted">Keine GPS-Daten von der Wetterstation.</p>
          )}
        </Card>
      </div>
    </>
  );
}
