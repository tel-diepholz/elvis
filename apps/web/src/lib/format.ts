const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const timeSec = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const date = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const weekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

export const fmtTime = (d: string | Date) => time.format(new Date(d));
export const fmtTimeSec = (d: string | Date) => timeSec.format(new Date(d));
export const fmtDate = (d: string | Date) => date.format(new Date(d));
export const fmtDateTime = (d: string | Date) => `${date.format(new Date(d))} ${time.format(new Date(d))}`;
export const fmtWeekday = (d: Date) => weekday.format(d);

export { formatDtg as fmtDtg } from '@elvis/shared';

export function fmtDuration(fromIso: string, to: Date | string = new Date()): string {
  const ms = Math.max(0, new Date(to).getTime() - new Date(fromIso).getTime());
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s % 60)}`;
}

/** „gerade eben“, „vor 3 min“, „vor 2 h“ */
export function fmtAgo(iso: string, now: Date = new Date()): string {
  const min = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} min`;
  return `vor ${Math.floor(min / 60)} h`;
}

export function fmtMinutes(min: number | null): string {
  if (min === null) return '–';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

const DIRS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg: number) => DIRS[Math.round(deg / 22.5) % 16]!;

/** Beaufort from m/s. */
export function beaufort(ms: number): number {
  const limits = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  const i = limits.findIndex((l) => ms < l);
  return i === -1 ? 12 : i;
}

export const fmtNum = (n: number, digits = 1) => n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Fläche: bis 1 km² in m² (ganze Zahl mit Tausenderpunkt), darüber in km² */
export const fmtArea = (m2: number) => (m2 < 1_000_000 ? `${Math.round(m2).toLocaleString('de-DE')} m²` : `${fmtNum(m2 / 1_000_000, 2)} km²`);

/** Zahl oder „–“, wenn der Sensor keinen Wert liefert. */
export const fmtOpt = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '–' : fmtNum(n, digits));
