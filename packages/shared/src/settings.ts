import { z } from 'zod';
import { tacticalSignSchema, type TacticalSign } from './tactical';
import type { VehicleInfo } from './protocol';

/** Von Admins in den Einstellungen pflegbar. */
export interface Settings {
  vehicle: VehicleInfo;
  /** Taktisches Zeichen für den Fahrzeugstandort auf Karte und Druck. */
  mapSign: TacticalSign;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const settingsInputSchema = z.object({
  vehicle: z.object({
    name: z.string().trim().min(1, 'Pflichtfeld').max(40),
    callsign: z.string().trim().min(1, 'Pflichtfeld').max(60),
    organization: z.string().trim().min(1, 'Pflichtfeld').max(100),
  }),
  mapSign: tacticalSignSchema,
});

export type SettingsInput = z.input<typeof settingsInputSchema>;
