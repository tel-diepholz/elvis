import { z } from 'zod';
import type { GeoPosition } from './devices';

/**
 * Fahrzeugstandort. Quelle ist das GPS der Wetterstation. Ohne GPS-Empfang oder ohne GPS-Empfänger
 * setzen Benutzer die Position von Hand in der Karte. Kommt der GPS-Fix zurück, gilt wieder das GPS.
 */
export type VehiclePositionSource = 'gps' | 'manual' | 'last-gps';

export const VEHICLE_POSITION_SOURCE_LABELS: Record<VehiclePositionSource, string> = {
  gps: 'GPS',
  manual: 'von Hand gesetzt',
  'last-gps': 'letzte GPS-Position',
};

export const manualPositionInputSchema = z.object({
  lat: z.number().min(-85).max(85),
  lon: z.number().min(-180).max(180),
});
export type ManualPositionInput = z.infer<typeof manualPositionInputSchema>;

/** Von Hand gesetzter Standort (null = keiner gesetzt) */
export interface ManualPosition extends ManualPositionInput {
  setAt: string;
  setBy: string;
}

export interface VehiclePosition {
  lat: number;
  lon: number;
  headingDeg: number | null;
  source: VehiclePositionSource;
  /** Nur bei source = 'manual' */
  setAt: string | null;
  setBy: string | null;
}

/** Von Hand setzen geht nur, solange kein GPS-Fix vorliegt (kein Empfang oder kein Empfänger). */
export const canSetVehiclePosition = (gps: GeoPosition | null | undefined): boolean => !gps?.fix;

/** Gültiger Fahrzeugstandort: GPS mit Fix, sonst von Hand gesetzt, sonst die letzte GPS-Position. */
export function vehiclePosition(gps: GeoPosition | null | undefined, manual: ManualPosition | null | undefined): VehiclePosition | null {
  if (gps?.fix) return { lat: gps.lat, lon: gps.lon, headingDeg: gps.headingDeg, source: 'gps', setAt: null, setBy: null };
  if (manual) return { lat: manual.lat, lon: manual.lon, headingDeg: null, source: 'manual', setAt: manual.setAt, setBy: manual.setBy };
  if (gps) return { lat: gps.lat, lon: gps.lon, headingDeg: gps.headingDeg, source: 'last-gps', setAt: null, setBy: null };
  return null;
}
