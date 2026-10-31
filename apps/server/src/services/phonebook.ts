import { randomBytes, timingSafeEqual } from 'node:crypto';
import { contactName, dialableNumber, type Contact, type PhonebookStatus } from '@elvis/shared';
import type { Db } from '../db/index.js';
import { HttpError } from '../errors.js';
import type { ContactService } from './contacts.js';

const TOKEN_KEY = 'phonebook:token';

export interface PhonebookEntry {
  name: string;
  number: string;
}

const xmlEscape = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
// Steuerzeichen machen das XML ungültig
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Telefonbuch für DECT-Basen (Yealink W70B, „Remote Phone Book“): die Kontakte als XML im Yealink-Format. Die Basis
 * ruft ohne Anmeldung ab und weist sich über ein geheimes Token in der URL aus; Admins können es neu erzeugen.
 * Je Telefonnummer ein Eintrag, die Bezeichnung (z. B. „Mobil“) hängt am Namen – so zeigt jedes Mobilteil sie an.
 */
export class PhonebookService {
  constructor(
    private readonly db: Db,
    private readonly contacts: ContactService,
  ) {}

  private tokenRow(): { value: string; updated_at: string; updated_by: string } | undefined {
    return this.db.prepare('SELECT * FROM settings WHERE key = ?').get(TOKEN_KEY) as { value: string; updated_at: string; updated_by: string } | undefined;
  }

  private writeToken(actor: string): string {
    const token = randomBytes(18).toString('base64url');
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(TOKEN_KEY, JSON.stringify(token), new Date().toISOString(), actor);
    return token;
  }

  private token(): string {
    const r = this.tokenRow();
    return r ? (JSON.parse(r.value) as string) : this.writeToken('System');
  }

  status(): PhonebookStatus {
    const token = this.token();
    const r = this.tokenRow();
    const all = this.contacts.list();
    return {
      token,
      contacts: all.filter((c) => c.phones.some((p) => dialableNumber(p.number))).length,
      entries: this.entries(all).length,
      updatedAt: r?.updated_at ?? null,
      updatedBy: r?.updated_by ?? null,
    };
  }

  /** Neues Token – die bisherige URL gilt danach nicht mehr */
  regenerate(actor: string): PhonebookStatus {
    this.writeToken(actor);
    return this.status();
  }

  private check(token: string): void {
    const a = Buffer.from(token);
    const b = Buffer.from(this.token());
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(404, 'Nicht gefunden');
  }

  /** Einträge, optional nur einer Kategorie samt Unterkategorien, nach Namen sortiert */
  entries(list: Contact[] = this.contacts.list(), categoryId: number | null = null): PhonebookEntry[] {
    let selected = list;
    if (categoryId !== null) {
      const categories = this.contacts.categories();
      if (!categories.some((c) => c.id === categoryId)) throw new HttpError(404, 'Kategorie nicht gefunden');
      const ids = new Set([categoryId]);
      // Unterkategorien einsammeln (Baum ist zyklenfrei)
      for (let grew = true; grew; ) {
        grew = false;
        for (const c of categories) if (c.parentId !== null && ids.has(c.parentId) && !ids.has(c.id)) (ids.add(c.id), (grew = true));
      }
      selected = list.filter((c) => c.categoryIds.some((id) => ids.has(id)));
    }
    const out: PhonebookEntry[] = [];
    for (const c of selected) {
      const name = clean(contactName(c));
      const phones = c.phones.map((p) => ({ label: clean(p.label), number: dialableNumber(p.number) })).filter((p) => p.number);
      for (const p of phones) out.push({ name: p.label ? `${name} - ${p.label}` : phones.length > 1 ? `${name} - ${p.number}` : name, number: p.number });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  /** XML für die Basis (YealinkIPPhoneDirectory) – prüft das Token */
  yealinkXml(token: string, categoryId: number | null = null): string {
    this.check(token);
    const body = this.entries(undefined, categoryId)
      .map((e) => `  <DirectoryEntry>\n    <Name>${xmlEscape(e.name)}</Name>\n    <Telephone>${xmlEscape(e.number)}</Telephone>\n  </DirectoryEntry>\n`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<YealinkIPPhoneDirectory>\n${body}</YealinkIPPhoneDirectory>\n`;
  }
}
