import { z } from 'zod';
import { tacticalSignSchema, type TacticalSign } from './tactical';
import type { VehicleContact, VehicleInfo } from './protocol';

/** Von Admins in den Einstellungen pflegbar. */
export interface Settings {
  vehicle: VehicleInfo;
  /** Taktisches Zeichen für den Fahrzeugstandort auf Karte und Druck. */
  mapSign: TacticalSign;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const MAX_VEHICLE_CONTACTS = 20;

export const VEHICLE_CONTACT_KIND_LABEL: Record<VehicleContact['kind'], string> = { email: 'E-Mail', phone: 'Telefon' };

export const vehicleContactSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email'),
    value: z.string().trim().min(1, 'E-Mail-Adresse fehlt').max(254).email('Ungültige E-Mail-Adresse'),
    label: z.string().trim().max(40).default(''),
  }),
  z.object({
    kind: z.literal('phone'),
    value: z
      .string()
      .trim()
      .min(1, 'Rufnummer fehlt')
      .max(40)
      .regex(/^\+?[0-9][0-9 /()-]*$/, 'Ungültige Rufnummer'),
    label: z.string().trim().max(40).default(''),
  }),
]);

export const settingsInputSchema = z.object({
  vehicle: z.object({
    name: z.string().trim().min(1, 'Pflichtfeld').max(40),
    callsign: z.string().trim().min(1, 'Pflichtfeld').max(60),
    organization: z.string().trim().min(1, 'Pflichtfeld').max(100),
    contacts: z.array(vehicleContactSchema).max(MAX_VEHICLE_CONTACTS, `Höchstens ${MAX_VEHICLE_CONTACTS} Kontakte`).default([]),
  }),
  mapSign: tacticalSignSchema,
});

export type SettingsInput = z.input<typeof settingsInputSchema>;
