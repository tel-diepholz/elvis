import { z } from 'zod';

/**
 * Kontakte: globales Adressbuch des ELW (Personen und Einrichtungen), unabhängig vom Einsatz.
 * Kategorien bilden einen Baum (z. B. Unternehmen → Getränkelieferanten); ein Kontakt kann in mehreren stehen.
 */

const text = (max: number) => z.string().trim().max(max);

export const CONTACT_KIND = {
  person: 'Person',
  organization: 'Einrichtung',
} as const;
export type ContactKind = keyof typeof CONTACT_KIND;
export const CONTACT_KINDS = Object.keys(CONTACT_KIND) as [ContactKind, ...ContactKind[]];

export const MAX_CONTACT_PHONES = 10;

export const contactPhoneSchema = z.object({
  /** z. B. „Mobil“, „Büro“, „24h-Notruf“ */
  label: text(40).default(''),
  number: text(40).min(1, 'Telefonnummer fehlt'),
});
export type ContactPhone = z.output<typeof contactPhoneSchema>;

export const contactInputSchema = z
  .object({
    kind: z.enum(CONTACT_KINDS).default('person'),
    lastName: text(80).default(''),
    firstName: text(80).default(''),
    /** Einrichtung, Firma, Behörde – bei kind = organization der Name */
    organization: text(120).default(''),
    /** Funktion / Ansprechpartner-Rolle */
    function: text(80).default(''),
    phones: z.array(contactPhoneSchema).max(MAX_CONTACT_PHONES).default([]),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .refine((v) => v === '' || z.string().email().safeParse(v).success, 'E-Mail-Adresse ungültig')
      .default(''),
    address: text(200).default(''),
    notes: text(2000).default(''),
    categoryIds: z.array(z.number().int().positive()).max(50).default([]),
  })
  .refine((c) => (c.kind === 'organization' ? c.organization !== '' : c.lastName !== '' || c.firstName !== ''), {
    message: 'Name fehlt',
    path: ['lastName'],
  });
export type ContactInput = z.input<typeof contactInputSchema>;
export type ContactData = z.output<typeof contactInputSchema>;

export interface Contact extends ContactData {
  id: number;
  createdAt: string;
  updatedAt: string;
}

export const contactCategoryInputSchema = z.object({
  parentId: z.number().int().positive().nullable(),
  name: text(80).min(1, 'Name fehlt').refine((n) => !n.includes('/'), '„/“ ist im Namen nicht erlaubt'),
});
export type ContactCategoryInput = z.infer<typeof contactCategoryInputSchema>;

export interface ContactCategory {
  id: number;
  parentId: number | null;
  name: string;
}

/** Vorschlag für die Adresszeile einer Mail */
export interface MailAddressSuggestion {
  address: string;
  /** Anzeigename (Kontakt oder Absendername), kann leer sein */
  name: string;
  source: 'contact' | 'mail';
}

/** Anzeigename: Einrichtung bzw. „Nachname, Vorname (Organisation)“ */
export function contactName(c: Pick<ContactData, 'kind' | 'lastName' | 'firstName' | 'organization'>): string {
  if (c.kind === 'organization') return c.organization;
  const name = [c.lastName, c.firstName].filter(Boolean).join(', ');
  return c.organization ? `${name} (${c.organization})` : name;
}

/** Telefonbuch für DECT-Basen (Yealink W70B): Abruf per URL mit geheimem Token, ohne Anmeldung */
export interface PhonebookStatus {
  token: string;
  /** Kontakte mit mindestens einer Telefonnummer */
  contacts: number;
  /** Einträge im Telefonbuch (je Telefonnummer einer) */
  entries: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Wählbare Nummer: nur Ziffern, *, # und ein führendes +; „+49 (0)5441“ → „+495441“ */
export function dialableNumber(number: string): string {
  const n = number.trim().replace(/^(\+\d+)\s*\(0\)/, '$1');
  const plus = n.startsWith('+') || n.startsWith('00') ? '+' : '';
  const digits = n.replace(/[^\d*#]/g, '');
  return plus === '+' && n.startsWith('00') ? `+${digits.slice(2)}` : plus + digits;
}
