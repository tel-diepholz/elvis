import { z } from 'zod';

/**
 * Arbeitsplätze: Notebooks, die das Addon „ELVIS Arbeitsplatz“ per PXE installiert hat. Sie melden sich mit einem
 * Gerätetoken an ELVIS (Authorization: Bearer) und prüfen dort die PINs der Benutzer für die Anmeldemaske.
 */

export interface Workstation {
  id: string;
  name: string;
  hostname: string;
  mac: string;
  enrolledAt: string;
  lastSeenAt: string | null;
  /** Zuletzt angemeldeter Benutzer (Name) */
  lastUser: string | null;
  /** Version des Client-Dienstes */
  version: string;
}

/** Benutzer für die Anmeldemaske; pinStamp ändert sich mit jeder PIN-Änderung (je Gerät verschieden) */
export interface WorkstationUser {
  id: number;
  firstName: string;
  lastName: string;
  pinStamp: string;
}

export interface WorkstationIncident {
  id: number;
  keyword: string;
  title: string;
}

/** GET /api/clients/state – alles, was die Anmeldemaske braucht (auch für den Offline-Betrieb) */
export interface WorkstationState {
  workstation: { id: string; name: string };
  users: WorkstationUser[];
  incident: WorkstationIncident | null;
  serverTime: string;
}

export interface WorkstationLoginResult {
  user: WorkstationUser;
  incident: WorkstationIncident | null;
}

/** Installer-ISO eines laufenden Addons (System → Arbeitsplätze) */
export interface WorkstationInstaller {
  id: string;
  name: string;
  isoUrl: string;
}

export const MAC_PATTERN = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

export const workstationEnrollSchema = z.object({
  hostname: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/, 'Ungültiger Hostname'),
  mac: z.string().trim().toLowerCase().regex(MAC_PATTERN, 'MAC-Adresse im Format aa:bb:cc:dd:ee:ff'),
});

export const workstationLoginSchema = z.object({
  userId: z.number().int().positive(),
  pin: z.string().max(10),
});

export const workstationHeartbeatSchema = z.object({
  version: z.string().max(40).optional(),
  user: z.string().max(130).nullable().optional(),
});
