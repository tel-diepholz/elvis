import { useEffect, useMemo, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MapContainer, Marker, Polyline, TileLayer, useMap } from 'react-leaflet';
import type L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, ListPlus, MapPin, Plane, Ship as ShipIcon } from 'lucide-react';
import {
  AIRCRAFT_CATEGORIES,
  EMERGENCY_LABELS,
  NAV_STATUS,
  formatAltitude,
  objectColor,
  shipFlag,
  shipTypeLabel,
  toMgrs,
  type MapObject,
  type TrackedData,
  type TrafficHit,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtAgo, fmtDateTime, fmtNum } from '../../lib/format';
import { useActiveIncident, useNow } from '../../lib/hooks';
import { autoSource } from '../../lib/mapSources';
import { saveMapView } from '../../lib/mapView';
import { effectiveTheme, useTheme } from '../../lib/theme';
import { useToast } from '../../lib/toast';
import { Badge, Card, EmptyState, Loading, PageHeader } from '../../components/ui';
import { useMapObjects } from '../../components/map/objects';
import { aircraftMarker, altitudeColor } from '../../components/map/aircraftIcons';
import { shipColor, shipIcon, trafficObject } from '../../components/map/traffic';

const kn = (v: number | null) => (v == null ? '–' : `${Math.round(v)} kn (${Math.round(v * 1.852)} km/h)`);
const deg = (v: number | null) => (v == null ? '–' : `${Math.round(v)}°`);

/** Zeile der Tabelle; leere Werte entfallen */
function Row({ label, children }: { label: string; children: ReactNode }) {
  if (children == null || children === '' || children === false) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/** Kleine Karte, die dem Ziel folgt; mit Spur, wenn es verfolgt wird */
function MiniMap({ lat, lon, icon, trail, color }: { lat: number; lon: number; icon: L.DivIcon; trail: [number, number][] | null; color: string }) {
  const { data: sources = [] } = useQuery({ queryKey: ['mapSources'], queryFn: api.mapSources, staleTime: Infinity });
  const source = autoSource(sources, effectiveTheme(useTheme()) === 'dark');
  return (
    <MapContainer center={[lat, lon]} zoom={11} className="traffic-minimap" zoomControl={false} attributionControl={false}>
      {source && <TileLayer key={source.id} url={api.tileUrl(source.id)} maxZoom={source.maxZoom} />}
      {trail && trail.length > 1 && <Polyline positions={trail} pathOptions={{ color, weight: 2, dashArray: '4 4' }} />}
      <Marker position={[lat, lon]} icon={icon} />
      <Follow lat={lat} lon={lon} />
    </MapContainer>
  );
}

function Follow({ lat, lon }: { lat: number; lon: number }) {
  const map = useMap();
  useEffect(() => {
    map.panTo([lat, lon], { animate: true });
  }, [map, lat, lon]);
  return null;
}

/** Gemeinsames Gerüst: Kopf mit „Auf der Karte“ und „Zur Objektliste“, Hinweis bei Problemen */
function useTrafficPage(kind: 'aircraft' | 'ship', id: string) {
  const { user } = useAuth();
  const { data: incident } = useActiveIncident();
  const { data: objects = [] } = useMapObjects(incident?.id);
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const tracked = objects.find((o): o is Extract<MapObject, { kind: 'aircraft' | 'ship' }> => o.kind === kind && (o.data as TrackedData).id === id);
  const canEdit = !!user && !!incident && !incident.closedAt;
  const add = useMutation({
    mutationFn: (h: TrafficHit) => api.addMapObject(incident!.id, trafficObject(h)),
    onSuccess: (o) => {
      void queryClient.invalidateQueries({ queryKey: ['mapObjects', incident!.id] });
      toast('success', `„${o.name}“ zur Objektliste hinzugefügt`);
    },
    onError: (e) => toast('error', e.message),
  });
  const showOnMap = (lat: number, lon: number) => {
    saveMapView('elvis.map.view', { lat, lon, zoom: 12 });
    navigate('/karte');
  };
  const actions = (hit: TrafficHit | null, pos: { lat: number; lon: number } | null) => (
    <>
      <Link className="btn" to="/karte">
        <ArrowLeft size={16} /> Karte
      </Link>
      {pos && (
        <button type="button" className="btn" onClick={() => showOnMap(pos.lat, pos.lon)}>
          <MapPin size={16} /> Auf der Karte zeigen
        </button>
      )}
      {canEdit && hit && !tracked && (
        <button type="button" className="btn btn-primary" disabled={add.isPending} onClick={() => add.mutate(hit)}>
          <ListPlus size={16} /> Zur Objektliste
        </button>
      )}
    </>
  );
  return { tracked, actions };
}

function TrackedNote({ tracked }: { tracked: MapObject | undefined }) {
  if (!tracked) return null;
  const d = tracked.data as TrackedData;
  return (
    <p className="muted">
      In der Objektliste des Einsatzes seit {fmtDateTime(tracked.createdAt)} ({tracked.createdBy})
      {d.lostSince ? ` – kein Signal seit ${fmtDateTime(d.lostSince)}` : ''}.
    </p>
  );
}

/** Detailseite eines Flugzeugs: Foto, Stammdaten, Flugdaten, Position mit Spur */
export function AircraftDetailPage() {
  const hex = useParams().hex ?? '';
  const now = useNow();
  const { data, isLoading } = useQuery({
    queryKey: ['trafficDetail', 'aircraft', hex],
    queryFn: () => api.trafficAircraftDetail(hex),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  const { data: photo } = useQuery({ queryKey: ['trafficPhoto', hex], queryFn: () => api.trafficAircraftPhoto(hex), staleTime: Infinity });
  const { tracked, actions } = useTrafficPage('aircraft', hex);
  const a = data?.aircraft ?? null;
  const t = tracked?.data as TrackedData | undefined;
  const pos = a ? { lat: a.lat, lon: a.lon } : tracked ? { lat: tracked.lat, lon: tracked.lon } : null;
  const icon = useMemo(
    () =>
      aircraftMarker(
        { category: a?.category ?? t?.category, type: a?.type ?? t?.aircraftType, altFt: a?.altFt ?? t?.last?.altFt ?? null, onGround: a?.onGround ?? false, track: a?.track ?? t?.last?.track ?? null },
        tracked ? { color: objectColor(tracked), selected: true } : {},
      ),
    [a, t, tracked],
  );

  if (isLoading) return <Loading />;
  const title = a?.callsign ?? a?.registration ?? tracked?.name ?? hex.toUpperCase();
  const emergency = a?.emergency ? EMERGENCY_LABELS[a.emergency] ?? a.emergency : a?.squawk === '7700' ? EMERGENCY_LABELS.general : a?.squawk === '7600' ? EMERGENCY_LABELS.nordo : a?.squawk === '7500' ? EMERGENCY_LABELS.unlawful : null;

  return (
    <>
      <PageHeader title={title} subtitle={[a?.description, a?.operator].filter(Boolean).join(' · ') || t?.detail} actions={actions(a && { kind: 'aircraft', ...a }, pos)} />
      {data?.problem && <p className="tone-warn">{data.problem}</p>}
      {!a && !tracked ? (
        <EmptyState icon={<Plane size={28} />} title="Gerade nicht empfangen">
          Für die ICAO-Adresse {hex.toUpperCase()} liegt keine aktuelle Position vor – gelandet oder außerhalb der Abdeckung.
        </EmptyState>
      ) : (
        <div className="grid">
          <Card title="Flugzeug" icon={<Plane size={18} />}>
            {photo?.photo && (
              <figure className="traffic-photo">
                <a href={photo.photo.link} target="_blank" rel="noreferrer">
                  <img src={photo.photo.src} width={photo.photo.width} height={photo.photo.height} alt={`Foto ${a?.registration ?? title}`} />
                </a>
                <figcaption className="muted">
                  © {photo.photo.photographer} ·{' '}
                  <a href={photo.photo.link} target="_blank" rel="noreferrer">
                    planespotters.net
                  </a>
                </figcaption>
              </figure>
            )}
            <dl className="kv">
              <Row label="Rufzeichen">{a?.callsign}</Row>
              <Row label="Kennzeichen">{a?.registration}</Row>
              <Row label="Typ">{[a?.type ?? t?.aircraftType, a?.description].filter(Boolean).join(' · ')}</Row>
              <Row label="Kategorie">{(a?.category ?? t?.category) && (AIRCRAFT_CATEGORIES[(a?.category ?? t?.category)!] ?? a?.category)}</Row>
              <Row label="Halter">{a?.operator}</Row>
              <Row label="Baujahr">{a?.year}</Row>
              <Row label="ICAO-Adresse">
                <span className="mono">{hex.toUpperCase()}</span>
              </Row>
              <Row label="Ortung">{a && (a.source === 'mlat' ? 'MLAT (Laufzeitmessung, kein ADS-B)' : a.source === 'adsb' ? 'ADS-B' : 'sonstige')}</Row>
            </dl>
            <TrackedNote tracked={tracked} />
          </Card>

          <Card title="Flugdaten">
            {emergency && (
              <p>
                <Badge tone="alarm">{emergency}</Badge>
              </p>
            )}
            {a ? (
              <dl className="kv">
                <Row label="Höhe">
                  <span className="traffic-alt" style={{ background: altitudeColor(a.altFt, a.onGround) }} /> {formatAltitude(a.altFt, a.onGround)}
                  {a.altFt != null && !a.onGround && a.altFt >= 6000 && <span className="muted"> ({a.altFt.toLocaleString('de-DE')} ft)</span>}
                </Row>
                <Row label="GPS-Höhe">{a.altGeomFt != null && `${a.altGeomFt.toLocaleString('de-DE')} ft`}</Row>
                <Row label="Gewählte Höhe">{a.selectedAltFt != null && `${a.selectedAltFt.toLocaleString('de-DE')} ft`}</Row>
                <Row label="Steigen/Sinken">{a.vertRateFpm != null && `${a.vertRateFpm > 0 ? '+' : ''}${a.vertRateFpm.toLocaleString('de-DE')} ft/min`}</Row>
                <Row label="Geschwindigkeit">{kn(a.speedKt)}</Row>
                <Row label="IAS / TAS">{(a.iasKt != null || a.tasKt != null) && `${a.iasKt ?? '–'} / ${a.tasKt ?? '–'} kn`}</Row>
                <Row label="Mach">{a.mach != null && fmtNum(a.mach, 2)}</Row>
                <Row label="Kurs">{deg(a.track)}</Row>
                <Row label="Squawk">{a.squawk}</Row>
                <Row label="Position">
                  <span className="mono">
                    {a.lat.toFixed(5)}, {a.lon.toFixed(5)}
                  </span>
                </Row>
                <Row label="UTMREF">
                  <span className="mono">{toMgrs(a.lat, a.lon)}</span>
                </Row>
                <Row label="Empfangen">{a.seenS < 5 ? 'gerade eben' : `vor ${Math.round(a.seenS)} s`}</Row>
              </dl>
            ) : (
              t?.last && (
                <dl className="kv">
                  <Row label="Zuletzt">{fmtAgo(t.last.at, now)}</Row>
                  <Row label="Höhe">{formatAltitude(t.last.altFt, t.last.onGround)}</Row>
                  <Row label="Geschwindigkeit">{kn(t.last.speedKt)}</Row>
                </dl>
              )
            )}
          </Card>

          {pos && (
            <Card title="Position" className="span-2">
              <MiniMap lat={pos.lat} lon={pos.lon} icon={icon} trail={t?.trail ?? null} color={tracked ? objectColor(tracked) : '#888'} />
            </Card>
          )}

          <Card title="Weitere Quellen" icon={<ExternalLink size={18} />}>
            <ul className="simple-list">
              <li>
                <a href={`https://globe.adsb.fi/?icao=${hex}`} target="_blank" rel="noreferrer">
                  Flugverlauf auf globe.adsb.fi
                </a>
              </li>
              <li>
                <a href={`https://www.planespotters.net/hex/${hex.toUpperCase()}`} target="_blank" rel="noreferrer">
                  Fotos und Flottendaten auf planespotters.net
                </a>
              </li>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}

/** Detailseite eines Schiffs: Stammdaten, Fahrt, Position */
export function ShipDetailPage() {
  const mmsi = useParams().mmsi ?? '';
  const now = useNow();
  const { data, isLoading } = useQuery({ queryKey: ['trafficDetail', 'ship', mmsi], queryFn: () => api.trafficShip(mmsi), refetchInterval: 10_000, placeholderData: (prev) => prev });
  const { tracked, actions } = useTrafficPage('ship', mmsi);
  const s = data?.ship ?? null;
  const t = tracked?.data as TrackedData | undefined;
  const pos = s ? { lat: s.lat, lon: s.lon } : tracked ? { lat: tracked.lat, lon: tracked.lon } : null;
  const color = tracked ? objectColor(tracked) : shipColor(s?.shipType ?? null);
  const icon = useMemo(() => shipIcon(color, s?.cog ?? s?.heading ?? t?.last?.track ?? null, (s?.sogKn ?? t?.last?.speedKt ?? 0) >= 0.5), [color, s, t]);

  if (isLoading) return <Loading />;
  const title = s?.name ?? tracked?.name ?? `MMSI ${mmsi}`;

  return (
    <>
      <PageHeader title={title} subtitle={[shipTypeLabel(s?.shipType ?? null), shipFlag(mmsi)].filter(Boolean).join(' · ') || t?.detail} actions={actions(s && { kind: 'ship', ...s }, pos)} />
      {data?.problem && <p className="tone-warn">{data.problem}</p>}
      {!s && !tracked ? (
        <EmptyState icon={<ShipIcon size={28} />} title="Gerade nicht empfangen">
          Von MMSI {mmsi} kam in den letzten 20 Minuten keine Meldung im Empfangsgebiet.
        </EmptyState>
      ) : (
        <div className="grid">
          <Card title="Schiff" icon={<ShipIcon size={18} />}>
            <dl className="kv">
              <Row label="Name">{s?.name}</Row>
              <Row label="MMSI">
                <span className="mono">{mmsi}</span>
              </Row>
              <Row label="Flagge">{shipFlag(mmsi)}</Row>
              <Row label="Rufzeichen">{s?.callsign}</Row>
              <Row label="Schiffstyp">{s?.shipType != null && `${shipTypeLabel(s.shipType) ?? ''} (${s.shipType})`}</Row>
              <Row label="Ziel">{s?.destination}</Row>
            </dl>
            <TrackedNote tracked={tracked} />
          </Card>

          <Card title="Fahrt">
            {s ? (
              <dl className="kv">
                <Row label="Status">{s.navStatus != null && (NAV_STATUS[s.navStatus] ?? `Code ${s.navStatus}`)}</Row>
                <Row label="Geschwindigkeit">{kn(s.sogKn)}</Row>
                <Row label="Kurs über Grund">{deg(s.cog)}</Row>
                <Row label="Steuerkurs">{deg(s.heading)}</Row>
                <Row label="Position">
                  <span className="mono">
                    {s.lat.toFixed(5)}, {s.lon.toFixed(5)}
                  </span>
                </Row>
                <Row label="UTMREF">
                  <span className="mono">{toMgrs(s.lat, s.lon)}</span>
                </Row>
                <Row label="Empfangen">{fmtAgo(s.seenAt, now)}</Row>
              </dl>
            ) : (
              t?.last && (
                <dl className="kv">
                  <Row label="Zuletzt">{fmtAgo(t.last.at, now)}</Row>
                  <Row label="Geschwindigkeit">{kn(t.last.speedKt)}</Row>
                </dl>
              )
            )}
          </Card>

          {pos && (
            <Card title="Position" className="span-2">
              <MiniMap lat={pos.lat} lon={pos.lon} icon={icon} trail={t?.trail ?? null} color={color} />
            </Card>
          )}

          <Card title="Weitere Quellen" icon={<ExternalLink size={18} />}>
            <ul className="simple-list">
              <li>
                <a href={`https://www.marinetraffic.com/de/ais/details/ships/mmsi:${mmsi}`} target="_blank" rel="noreferrer">
                  MarineTraffic
                </a>
              </li>
              <li>
                <a href={`https://www.vesselfinder.com/de/vessels/details/${mmsi}`} target="_blank" rel="noreferrer">
                  VesselFinder
                </a>
              </li>
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
