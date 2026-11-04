import type { DeviceId } from './devices';

/**
 * Ausbaustufe von ELVIS: „full“ für den Fahrzeugserver im ELW 2, „lite“ als Windows-Dienst für kleinere
 * Fahrzeuge ohne eigene Fahrzeugtechnik – Einsatzführung und Kommunikation, keine Gerätemodule und keine Addons.
 */
export type Edition = 'full' | 'lite';

export const EDITIONS: readonly Edition[] = ['full', 'lite'];

/** Fahrzeugmodule, die in ELVIS lite eingerichtet werden können (nur Messenger, die ohne Addon auskommen). */
export const LITE_DEVICE_IDS: readonly DeviceId[] = ['threema', 'whatsapp', 'telegram'];

/** Kann das Modul in dieser Ausbaustufe eingerichtet werden? */
export function editionAllowsDevice(edition: Edition, id: DeviceId): boolean {
  return edition === 'full' || LITE_DEVICE_IDS.includes(id);
}
