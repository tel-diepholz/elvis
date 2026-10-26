/** Regenradar des DWD: Zeitschritte (ISO, UTC) vom Rückblick bis zum Ende der Vorhersage */
export interface RadarFrames {
  /** Letzte Messung; spätere Zeitschritte sind Vorhersage (Nowcast) */
  reference: string;
  frames: string[];
  attribution: string;
}

/** Rückblick vor der letzten Messung */
export const RADAR_HISTORY_MS = 2 * 3_600_000;
