import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CloudRain, CloudSun, Clock, Droplets, MapPin, Navigation, Printer, Sunrise, Sunset, Thermometer, TriangleAlert, Wind } from 'lucide-react';
import { WARNING_LEVEL, weatherCodeText, type GeoPosition, type GnssInfo, type GnssMethod, type WeatherDay, type WeatherHour, type WeatherNow, type WeatherReport, type WeatherWarning } from '@elvis/shared';
import { api } from '../lib/api';
import { beaufort, compass, fmtDateTime, fmtNum, fmtOpt, fmtTime, fmtTimeSec } from '../lib/format';
import { useActiveIncident, useInfo } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { useDevice } from '../lib/live';
import { WindCompass } from '../components/WindCompass';
import { WeatherIcon, WindArrow, gustTone } from '../components/WeatherIcon';
import { Badge, Card, EmptyState, Loading, Modal, PageHeader, Stat } from '../components/ui';
import { WeatherPrintDialog } from './WeatherPrintDialog';

const kmh = (ms: number | null) => (ms === null ? '–' : fmtNum(ms * 3.6, 0));
const dayName = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
const dayLong = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function warningPeriod(w: WeatherWarning): string {
  const from = new Date(w.onset);
  const started = from.getTime() <= Date.now();
  if (!w.expires) return started ? 'seit ' + dayLong.format(from) : 'ab ' + dayLong.format(from);
  return `${started ? 'bis' : `${dayLong.format(from)} –`} ${dayLong.format(new Date(w.expires))}`;
}

function WarningsCard({ report, error }: { report: WeatherReport['warnings']; error: string | null }) {
  const items = report?.items ?? [];
  return (
    <Card
      title="Amtliche Warnungen"
      icon={<TriangleAlert size={18} />}
      className="span-3"
      actions={report && <span className="muted small">{report.area ?? 'außerhalb Deutschlands'}</span>}
    >
      {!report ? (
        <p className="muted">Keine Warnungen abrufbar{error ? `: ${error}` : ''}.</p>
      ) : !report.area ? (
        <p className="muted">Amtliche Warnungen des DWD gibt es nur für Standorte in Deutschland.</p>
      ) : items.length === 0 ? (
        <p className="wx-nowarn">
          <Badge tone="ok">keine Warnungen</Badge> Für {report.area} liegen derzeit keine Warnungen des DWD vor.
        </p>
      ) : (
        <ul className="wx-warnings">
          {items.map((w) => (
            <li key={w.id} className={`wx-warning sev-${w.severity}`}>
              <div className="wx-warning-head">
                <span className="wx-level">
                  Stufe {WARNING_LEVEL[w.severity].level} · {WARNING_LEVEL[w.severity].label}
                </span>
                <span className="muted small">{warningPeriod(w)}</span>
              </div>
              <strong>{w.headline || w.event}</strong>
              <p>{w.description}</p>
              {w.instruction && (
                <details>
                  <summary>Hinweise</summary>
                  <p className="pre-line">{w.instruction}</p>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && report && <p className="muted small">Letzter Stand {fmtTime(report.fetchedAt)} – {error}</p>}
    </Card>
  );
}

function NowCard({ now, today, limit }: { now: WeatherNow; today: WeatherDay | undefined; limit: number }) {
  return (
    <Card title="Aktuell" icon={<Thermometer size={18} />} className="wx-stretch">
      <div className="wx-now">
        <WeatherIcon code={now.weatherCode} isDay={now.isDay} size={56} />
        <div>
          <div className="wx-now-temp">{fmtOpt(now.temperatureC)} °C</div>
          <div>{weatherCodeText(now.weatherCode)}</div>
          {now.feelsLikeC !== null && <div className="muted small">gefühlt {fmtNum(now.feelsLikeC)} °C</div>}
        </div>
      </div>
      <div className="grid-2">
        <Stat
          label="Wind"
          value={fmtOpt(now.windSpeedMs)}
          unit="m/s"
          sub={
            now.windSpeedMs === null ? undefined : (
              <>
                {now.windDirectionDeg !== null && `aus ${compass(now.windDirectionDeg)} · `}Bft {beaufort(now.windSpeedMs)}
              </>
            )
          }
        />
        <Stat label="Böen" value={fmtOpt(now.windGustMs)} unit="m/s" tone={gustTone(now.windGustMs, limit)} sub={`${kmh(now.windGustMs)} km/h`} />
        <Stat label="Luftfeuchte" value={fmtOpt(now.humidityPercent, 0)} unit="%" />
        <Stat label="Niederschlag" value={fmtOpt(now.precipitationMm)} unit="mm" />
      </div>
      <ul className="icon-list muted">
        {now.pressureHpa !== null && (
          <li>
            <Droplets size={16} /> Luftdruck {fmtNum(now.pressureHpa, 0)} hPa · Bewölkung {fmtOpt(now.cloudCoverPercent, 0)} %
          </li>
        )}
        {today?.sunrise && today.sunset && (
          <li>
            <Sunrise size={16} /> {fmtTime(today.sunrise)} <Sunset size={16} /> {fmtTime(today.sunset)}
          </li>
        )}
      </ul>
    </Card>
  );
}

function HoursCard({ hours, limit }: { hours: WeatherHour[]; limit: number }) {
  return (
    <Card title="Nächste 24 Stunden" icon={<Clock size={18} />} className="span-2 wx-stretch">
      <div className="wx-hours" role="list">
        {hours.map((h) => (
          <div key={h.time} className="wx-hour" role="listitem">
            <span className="muted small">{fmtTime(h.time)}</span>
            <WeatherIcon code={h.weatherCode} isDay={h.isDay} />
            <strong>{h.temperatureC === null ? '–' : `${fmtNum(h.temperatureC, 0)}°`}</strong>
            <span className="wx-rain small">{h.precipitationProbability === null ? '' : `${h.precipitationProbability} %`}</span>
            <span className="small">
              <WindArrow deg={h.windDirectionDeg} /> {fmtOpt(h.windSpeedMs, 0)}
            </span>
            <span className={`small ${gustTone(h.windGustMs, limit) ? `tone-${gustTone(h.windGustMs, limit)}` : 'muted'}`}>{fmtOpt(h.windGustMs, 0)}</span>
          </div>
        ))}
      </div>
      <p className="muted small">Regenwahrscheinlichkeit, Mittelwind und Böen in m/s</p>
    </Card>
  );
}

function DaysCard({ days, limit }: { days: WeatherDay[]; limit: number }) {
  const lo = Math.min(...days.map((d) => d.tempMinC ?? Infinity));
  const hi = Math.max(...days.map((d) => d.tempMaxC ?? -Infinity));
  const pct = (t: number) => ((t - lo) / Math.max(1, hi - lo)) * 100;
  return (
    <Card title={`${days.length} Tage`} icon={<CalendarDays size={18} />} className="span-3">
      <div className="wx-days">
        {days.map((d, i) => (
          <div key={d.date} className="wx-day">
            <span className="wx-day-name">{i === 0 ? 'Heute' : dayName.format(new Date(d.date))}</span>
            <span className="wx-day-sky">
              <WeatherIcon code={d.weatherCode} size={22} />
              <span className="wx-day-text">{weatherCodeText(d.weatherCode)}</span>
            </span>
            <span className="wx-temps">
              <span className="muted">{d.tempMinC === null ? '–' : `${fmtNum(d.tempMinC, 0)}°`}</span>
              {d.tempMinC !== null && d.tempMaxC !== null && (
                <span className="wx-bar">
                  <span style={{ left: `${pct(d.tempMinC)}%`, right: `${100 - pct(d.tempMaxC)}%` }} />
                </span>
              )}
              <strong>{d.tempMaxC === null ? '–' : `${fmtNum(d.tempMaxC, 0)}°`}</strong>
            </span>
            <span className="wx-rain small">
              <Droplets size={14} /> {fmtOpt(d.precipitationMm)} mm{d.precipitationProbability !== null && ` · ${d.precipitationProbability} %`}
            </span>
            <span className="small">
              <WindArrow deg={d.windDirectionDeg} /> {fmtOpt(d.windSpeedMaxMs, 0)} m/s · Böen{' '}
              <span className={gustTone(d.windGustMaxMs, limit) ? `tone-${gustTone(d.windGustMaxMs, limit)}` : ''}>{fmtOpt(d.windGustMaxMs, 0)} m/s</span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Standort für die Prognose: GPS des Fahrzeugs, sonst Einsatzort */
function useForecastPosition() {
  const gps = useDevice('weather')?.state.position ?? null;
  const { data: incident } = useActiveIncident();
  if (gps) return { lat: gps.lat, lon: gps.lon, source: gps.fix ? 'Fahrzeug-GPS' : 'letzte GPS-Position' };
  if (incident?.lat != null && incident.lon != null) return { lat: incident.lat, lon: incident.lon, source: 'Einsatzort' };
  return null;
}

const GNSS_METHOD: Record<GnssMethod, string> = {
  none: 'kein Fix',
  gnss: 'GPS',
  dgnss: 'DGPS',
  precise: 'präzise',
  'rtk-fixed': 'RTK',
  'rtk-float': 'RTK (float)',
  estimated: 'geschätzt',
  manual: 'manuell',
  simulated: 'simuliert',
};
/** Ab dieser Geschwindigkeit gilt das Fahrzeug als in Fahrt (GPS-Rauschen im Stand liegt darunter). */
const MOVING_MS = 0.5;
/** Ab dieser Neigung zeigt der Windsensor merklich falsch. */
const TILT_WARN_DEG = 5;
/** Ab dieser Abweichung von der GPS-Zeit gilt die Server-Uhr als falsch gestellt. */
const CLOCK_WARN_S = 2;

function hdopText(h: number): string {
  return h < 1 ? 'sehr gut' : h < 2 ? 'gut' : h < 5 ? 'mäßig' : 'ungenau';
}

function GpsDetails({ position: p, gnss: g }: { position: GeoPosition; gnss: GnssInfo | null }) {
  const moving = g?.speedMs != null && g.speedMs >= MOVING_MS;
  const tilt = g && g.pitchDeg !== null && g.rollDeg !== null ? Math.max(Math.abs(g.pitchDeg), Math.abs(g.rollDeg)) : null;
  const offset = g?.clockOffsetS ?? null;
  return (
    <dl className="kv">
      <dt>Position</dt>
      <dd className="mono">
        {p.lat.toFixed(5)}, {p.lon.toFixed(5)}
      </dd>
      <dt>GPS</dt>
      <dd>
        <Badge tone={p.fix ? 'ok' : 'warn'}>{p.fix ? (g?.method ? GNSS_METHOD[g.method] : 'Fix') : 'kein Fix – letzte Position'}</Badge>
        {g?.satellites != null && ` ${g.satellites} Satelliten`}
      </dd>
      {g?.hdop != null && (
        <>
          <dt>Genauigkeit</dt>
          <dd>
            {hdopText(g.hdop)} <small className="muted">(HDOP {fmtNum(g.hdop)})</small>
          </dd>
        </>
      )}
      {g?.altitudeM != null && (
        <>
          <dt>Höhe</dt>
          <dd>{fmtNum(g.altitudeM, 0)} m ü. NN</dd>
        </>
      )}
      <dt>Kurs</dt>
      <dd>{p.headingDeg === null ? '–' : `${p.headingDeg}° (${compass(p.headingDeg)})`}</dd>
      {g?.speedMs != null && (
        <>
          <dt>Fahrt</dt>
          <dd>
            {moving ? `${kmh(g.speedMs)} km/h` : 'steht'}
            {moving && g.courseDeg !== null && ` · über Grund ${g.courseDeg}° (${compass(g.courseDeg)})`}
          </dd>
        </>
      )}
      {tilt !== null && (
        <>
          <dt>Neigung</dt>
          <dd>
            {tilt >= TILT_WARN_DEG ? <Badge tone="warn">schief – Wind ungenau</Badge> : 'eben'}{' '}
            <small className="muted">
              (Nicken {fmtNum(g!.pitchDeg!)}°, Rollen {fmtNum(g!.rollDeg!)}°)
            </small>
          </dd>
        </>
      )}
      {g?.time && (
        <>
          <dt>GPS-Zeit</dt>
          <dd>
            {fmtTimeSec(g.time)}
            {offset !== null && Math.abs(offset) >= CLOCK_WARN_S && (
              <>
                {' '}
                <Badge tone="warn">Server-Uhr geht {fmtNum(Math.abs(offset), 0)} s {offset > 0 ? 'nach' : 'vor'}</Badge>
              </>
            )}
          </dd>
        </>
      )}
    </dl>
  );
}

export function WeatherPage() {
  const dev = useDevice('weather');
  const { data: info } = useInfo();
  const stormLimit = info?.limits.stormWarnMs ?? 17;
  const pos = useForecastPosition();
  // auf ca. 1 km runden, damit kleine GPS-Schwankungen keine neue Abfrage auslösen
  const at = pos && { lat: Math.round(pos.lat * 100) / 100, lon: Math.round(pos.lon * 100) / 100 };
  const loggedIn = !!useAuth().user;
  const [printing, setPrinting] = useState(false);
  // der Server hält den letzten Stand vor und lädt ihn alle 15 Minuten neu; hier nur dessen Stand abholen
  const { data: report, isLoading, error } = useQuery({
    queryKey: ['weather', at?.lat, at?.lon],
    queryFn: () => api.weather(at!),
    enabled: !!at,
    refetchInterval: 60_000,
    placeholderData: (prev) => prev,
  });
  const fc = report?.forecast ?? null;
  const asOf = fc?.fetchedAt ?? report?.warnings?.fetchedAt ?? null;

  const s = dev?.state;
  const dir = s?.windDirectionDeg ?? null;
  const gust = s?.windGustMs ?? null;
  return (
    <>
      <PageHeader
        title="Wetter"
        actions={
          loggedIn &&
          at && (
            <button className="btn" onClick={() => setPrinting(true)}>
              <Printer size={18} /> Drucken
            </button>
          )
        }
        subtitle={
          pos ? (
            <>
              <MapPin size={14} /> {report?.warnings?.area ?? `${pos.lat.toFixed(3)}, ${pos.lon.toFixed(3)}`} · {pos.source}
              {dev && (
                <>
                  {' '}
                  · Wetterstation <Badge tone={dev.online ? 'ok' : 'alarm'}>{dev.online ? 'empfängt Daten' : 'keine Daten'}</Badge>
                </>
              )}
              {asOf && (
                <span className="page-subtitle-line">
                  <Clock size={14} /> Stand {fmtDateTime(asOf)}
                  {error && ` · Server nicht erreichbar: ${error.message}`}
                </span>
              )}
            </>
          ) : undefined
        }
      />
      <div className="grid">
        {!pos ? (
          <div className="span-3">
            <EmptyState icon={<MapPin size={32} />} title="Kein Standort bekannt">
              Für Prognose und Warnungen braucht ELVIS einen Standort: das GPS der Wetterstation oder den Einsatzort des laufenden Einsatzes.
            </EmptyState>
          </div>
        ) : !report && isLoading ? (
          <div className="span-3">
            <Loading />
          </div>
        ) : !report && error ? (
          <Card title="Wetter" className="span-3">
            <p className="muted">Wetterdaten nicht abrufbar: {error.message}</p>
          </Card>
        ) : (
          report && (
            <>
              <WarningsCard report={report.warnings} error={report.warningsError} />
              {fc ? (
                <>
                  <NowCard now={fc.current} today={fc.daily[0]} limit={stormLimit} />
                  <HoursCard hours={fc.hourly} limit={stormLimit} />
                  <DaysCard days={fc.daily} limit={stormLimit} />
                </>
              ) : (
                <Card title="Prognose" icon={<CloudSun size={18} />} className="span-3">
                  <p className="muted">Keine Prognose verfügbar{report.forecastError ? `: ${report.forecastError}` : ''}.</p>
                </Card>
              )}
              {fc && report.forecastError && (
                <p className="span-3 muted small">
                  Prognose vom {fmtDateTime(fc.fetchedAt)} – {report.forecastError}
                </p>
              )}
            </>
          )
        )}

        {dev && s && (
          <>
            <Card title="Wind (Wetterstation)" icon={<Wind size={18} />} className="span-2">
              <div className="wind-hero">
                <WindCompass directionDeg={dir} size={180} />
                <div className="grid-2 grow">
                  <Stat
                    label="Mittelwind (2 min)"
                    value={fmtOpt(s.windSpeedMs)}
                    unit="m/s"
                    sub={s.windSpeedMs === null ? undefined : `${fmtNum(s.windSpeedMs * 3.6, 0)} km/h · Bft ${beaufort(s.windSpeedMs)}`}
                  />
                  <Stat label="Böen (10 min)" value={fmtOpt(gust)} unit="m/s" tone={gustTone(gust, stormLimit)} sub={gust === null ? undefined : `${kmh(gust)} km/h`} />
                  <Stat label="Wind aus" value={dir === null ? '–' : compass(dir)} sub={dir === null ? undefined : `${dir}°`} />
                  <Stat label="Ausbreitung nach" value={dir === null ? '–' : compass((dir + 180) % 360)} sub="Rauch / Gefahrstoffe" />
                </div>
              </div>
            </Card>
            <div className="stack">
              <Card title="Atmosphäre (Wetterstation)" icon={<Thermometer size={18} />}>
                <div className="grid-2">
                  <Stat label="Temperatur" value={fmtOpt(s.temperatureC)} unit="°C" />
                  <Stat label="Luftdruck" value={fmtOpt(s.pressureHpa, 0)} unit="hPa" />
                </div>
                <ul className="icon-list muted">
                  <li>
                    <CloudRain size={16} /> Aktualisiert {fmtTime(dev.updatedAt)}
                  </li>
                </ul>
              </Card>
              <Card title="GPS & Kurs" icon={<Navigation size={18} />}>
                {s.position ? <GpsDetails position={s.position} gnss={s.gnss} /> : <p className="muted">Keine GPS-Daten von der Wetterstation.</p>}
              </Card>
            </div>
          </>
        )}
      </div>
      {fc && (
        <p className="muted small wx-credits">
          Prognose: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo.com</a> (Modelle u. a. DWD ICON) · Warnungen: Deutscher Wetterdienst über{' '}
          <a href="https://brightsky.dev/" target="_blank" rel="noreferrer">Bright Sky</a>
        </p>
      )}
      {at && (
        <Modal open={printing} title="Wetterbericht drucken" onClose={() => setPrinting(false)}>
          {printing && <WeatherPrintDialog position={at} onDone={() => setPrinting(false)} />}
        </Modal>
      )}
    </>
  );
}
