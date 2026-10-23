import { compass } from '../lib/format';

/**
 * Wind rose. The arrow points in the direction the wind is blowing *to*
 * (Ausbreitungsrichtung), the label shows where it comes *from* (meteorological convention).
 */
export function WindCompass({ directionDeg, size = 120 }: { directionDeg: number | null; size?: number }) {
  const towards = directionDeg === null ? 0 : (directionDeg + 180) % 360;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className="compass" role="img" aria-label={directionDeg === null ? 'Windrichtung unbekannt' : `Wind aus ${compass(directionDeg)}`}>
      <circle cx="50" cy="50" r="46" className="compass-ring" />
      {Array.from({ length: 16 }, (_, i) => (
        <line
          key={i}
          x1="50"
          y1="6"
          x2="50"
          y2={i % 4 === 0 ? 13 : 10}
          className="compass-tick"
          transform={`rotate(${i * 22.5} 50 50)`}
        />
      ))}
      {(
        [
          ['N', 50, 25],
          ['O', 77, 54],
          ['S', 50, 83],
          ['W', 23, 54],
        ] as const
      ).map(([l, x, y]) => (
        <text key={l} x={x} y={y} className="compass-label">
          {l}
        </text>
      ))}
      {directionDeg !== null && (
        <g transform={`rotate(${towards} 50 50)`} className="compass-arrow">
          <path d="M50 20 L58 52 L50 46 L42 52 Z" />
          <line x1="50" y1="46" x2="50" y2="78" />
        </g>
      )}
      <circle cx="50" cy="50" r="3" className="compass-hub" />
    </svg>
  );
}
