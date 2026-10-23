import { useMemo } from 'react';
import L from 'leaflet';
import { buildTacticalSign, describeTacticalSign, tacticalSignSchema, tacticalSignSvg, type TacticalSign } from '@elvis/shared';

/** Taktisches Zeichen als Inline-SVG. */
export function TacticalSignImage({ sign, height = 64, className }: { sign: Partial<TacticalSign>; height?: number; className?: string }) {
  const svg = useMemo(() => tacticalSignSvg(sign, { height, title: describeTacticalSign(tacticalSignSchema.parse(sign)) }), [sign, height]);
  return <span className={`tactical-sign ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Leaflet-Marker; der Bezugspunkt ist die Mitte des Zeichenkörpers. */
export function tacticalIcon(sign: Partial<TacticalSign>, height = 44): L.DivIcon {
  const g = buildTacticalSign(sign);
  const scale = height / g.box.height;
  const width = g.box.width * scale;
  return L.divIcon({
    className: 'map-marker tactical',
    html: tacticalSignSvg(sign, { height }),
    iconSize: [width, height],
    iconAnchor: [(g.anchor.x - g.box.x) * scale, (g.anchor.y - g.box.y) * scale],
  });
}
