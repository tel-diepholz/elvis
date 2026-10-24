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
  /** Letztes oder laufendes Update (von ELVIS angestoßen), null = noch nie */
  update: WorkstationUpdate | null;
}

/**
 * Update eines Arbeitsplatzes: apt-Pakete (über den apt-Cache des Addons) und/oder Firmware (fwupd).
 * pending = wartet, bis niemand angemeldet ist; running = läuft (Anmeldung gesperrt); danach done/failed/cancelled.
 */
export type WorkstationUpdateState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface WorkstationUpdateRequest {
  apt: boolean;
  firmware: boolean;
}

export interface WorkstationUpdate extends WorkstationUpdateRequest {
  id: string;
  state: WorkstationUpdateState;
  /** Kurzer Stand bzw. Ergebnis, z. B. „12 Pakete aktualisiert, Neustart“ */
  message: string;
  requestedAt: string;
  requestedBy: string;
  finishedAt: string | null;
  /** Ende der Ausgabe von apt/fwupd */
  log: string;
}

/** Auftrag an den Client-Dienst (in GET /api/clients/state) */
export interface WorkstationUpdateOrder extends WorkstationUpdateRequest {
  id: string;
  /** apt-Proxy des Addons (apt-cacher-ng), z. B. http://192.168.1.10:3142 */
  aptProxy: string;
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
  /** Angestoßenes Update (pending oder running), sonst null */
  update: WorkstationUpdateOrder | null;
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
  /** Anmeldung an der Anmeldemaske oder Entsperren der Bildschirmsperre (nur fürs Bedienprotokoll) */
  purpose: z.enum(['login', 'unlock']).default('login'),
});

export const workstationHeartbeatSchema = z.object({
  version: z.string().max(40).optional(),
  user: z.string().max(130).nullable().optional(),
});

export const workstationUpdateRequestSchema = z
  .object({ apt: z.boolean().default(true), firmware: z.boolean().default(false) })
  .refine((r) => r.apt || r.firmware, 'Pakete und/oder Firmware wählen');

/** Rückmeldung des Client-Dienstes: POST /api/clients/update */
export const workstationUpdateReportSchema = z.object({
  id: z.string().min(1).max(40),
  state: z.enum(['running', 'done', 'failed']),
  message: z.string().max(300).default(''),
  log: z.string().max(20_000).default(''),
});
