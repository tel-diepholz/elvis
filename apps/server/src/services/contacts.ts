import { contactName, personName, type Contact, type ContactCategory, type ContactCategoryInput, type ContactData, type ContactPhone, type MailAddressSuggestion, type Person, type Topic } from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';

type Row = Record<string, unknown>;

const toCategory = (r: Row): ContactCategory => ({ id: r.id as number, parentId: (r.parent_id as number | null) ?? null, name: r.name as string });

const toContact = (r: Row, categoryIds: number[]): Contact => ({
  id: r.id as number,
  kind: r.kind as Contact['kind'],
  lastName: r.last_name as string,
  firstName: r.first_name as string,
  organization: r.organization as string,
  function: r.function as string,
  phones: JSON.parse(r.phones as string) as ContactPhone[],
  email: r.email as string,
  address: r.address as string,
  notes: r.notes as string,
  categoryIds,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const contactParams = (c: ContactData) => ({
  kind: c.kind,
  lastName: c.lastName,
  firstName: c.firstName,
  organization: c.organization,
  function: c.function,
  phones: JSON.stringify(c.phones),
  email: c.email,
  address: c.address,
  notes: c.notes,
});

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';

/** „Name <adresse>“ bzw. „adresse“ zerlegen */
const splitAddress = (v: string): { name: string; address: string } => {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(v);
  return m ? { name: m[1]!.trim(), address: m[2]!.trim().toLowerCase() } : { name: '', address: v.trim().toLowerCase() };
};

const MAX_SUGGESTIONS = 10;

/**
 * Kontakte: globales Adressbuch des ELW mit Kategoriebaum. Pflegen dürfen alle Angemeldeten, jede Änderung
 * steht im Bedienprotokoll.
 */
export class ContactService {
  constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly notify: (topics: Topic[]) => void,
  ) {}

  private audit(operator: string, action: string, message: string): void {
    this.store.addAudit({ operator, target: 'kontakte', action, params: '', success: true, message });
    this.notify(['contacts', 'audit']);
  }

  // --- Kategorien ---

  categories(): ContactCategory[] {
    return (this.db.prepare('SELECT * FROM contact_categories ORDER BY name COLLATE NOCASE').all() as Row[]).map(toCategory);
  }

  private category(id: number): ContactCategory {
    const r = this.db.prepare('SELECT * FROM contact_categories WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, `Kategorie ${id} nicht gefunden`);
    return toCategory(r);
  }

  private checkParent(parentId: number | null, selfId?: number): void {
    // Kategorie nicht in sich selbst oder eine eigene Unterkategorie verschieben
    for (let id = parentId; id !== null; id = this.category(id).parentId) {
      if (id === selfId) throw new HttpError(400, 'Eine Kategorie kann nicht in sich selbst liegen');
    }
  }

  createCategory(input: ContactCategoryInput, operator: string): ContactCategory {
    this.checkParent(input.parentId);
    let id: number;
    try {
      id = Number(this.db.prepare('INSERT INTO contact_categories (parent_id, name) VALUES (?, ?)').run(input.parentId, input.name).lastInsertRowid);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, `Kategorie „${input.name}“ gibt es hier schon`);
      throw e;
    }
    this.audit(operator, 'create', `Kategorie ${input.name}`);
    return this.category(id);
  }

  updateCategory(id: number, input: ContactCategoryInput, operator: string): ContactCategory {
    this.category(id);
    this.checkParent(input.parentId, id);
    try {
      this.db.prepare('UPDATE contact_categories SET parent_id = ?, name = ? WHERE id = ?').run(input.parentId, input.name, id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, `Kategorie „${input.name}“ gibt es hier schon`);
      throw e;
    }
    this.audit(operator, 'update', `Kategorie ${input.name}`);
    return this.category(id);
  }

  /** Nur ohne Unterkategorien; Kontakte bleiben erhalten, nur die Zuordnung entfällt */
  removeCategory(id: number, operator: string): void {
    const c = this.category(id);
    if (this.db.prepare('SELECT 1 FROM contact_categories WHERE parent_id = ?').get(id)) throw new HttpError(409, 'Kategorie hat Unterkategorien');
    this.db.prepare('DELETE FROM contact_categories WHERE id = ?').run(id);
    this.audit(operator, 'delete', `Kategorie ${c.name}`);
  }

  // --- Kontakte ---

  list(): Contact[] {
    const members = new Map<number, number[]>();
    for (const m of this.db.prepare('SELECT contact_id, category_id FROM contact_category_members').all() as { contact_id: number; category_id: number }[]) {
      members.set(m.contact_id, [...(members.get(m.contact_id) ?? []), m.category_id]);
    }
    return (this.db.prepare("SELECT * FROM contacts ORDER BY CASE kind WHEN 'organization' THEN organization ELSE last_name END COLLATE NOCASE, first_name COLLATE NOCASE, id").all() as Row[]).map((r) =>
      toContact(r, members.get(r.id as number) ?? []),
    );
  }

  get(id: number): Contact {
    const r = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, `Kontakt ${id} nicht gefunden`);
    const ids = (this.db.prepare('SELECT category_id FROM contact_category_members WHERE contact_id = ?').all(id) as { category_id: number }[]).map((m) => m.category_id);
    return toContact(r, ids);
  }

  private setCategories(id: number, categoryIds: number[]): void {
    const ids = [...new Set(categoryIds)];
    for (const c of ids) this.category(c);
    this.db.prepare('DELETE FROM contact_category_members WHERE contact_id = ?').run(id);
    const stmt = this.db.prepare('INSERT INTO contact_category_members (contact_id, category_id) VALUES (?, ?)');
    for (const c of ids) stmt.run(id, c);
  }

  create(input: ContactData, operator: string): Contact {
    const ts = new Date().toISOString();
    const id = this.store.transaction(() => {
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO contacts (kind, last_name, first_name, organization, function, phones, email, address, notes, created_at, updated_at)
             VALUES (@kind, @lastName, @firstName, @organization, @function, @phones, @email, @address, @notes, @ts, @ts)`,
          )
          .run({ ...contactParams(input), ts }).lastInsertRowid,
      );
      this.setCategories(id, input.categoryIds);
      return id;
    });
    this.audit(operator, 'create', contactName(input));
    return this.get(id);
  }

  update(id: number, input: ContactData, operator: string): Contact {
    this.get(id);
    this.store.transaction(() => {
      this.db
        .prepare(
          `UPDATE contacts SET kind=@kind, last_name=@lastName, first_name=@firstName, organization=@organization, function=@function,
             phones=@phones, email=@email, address=@address, notes=@notes, updated_at=@ts WHERE id=@id`,
        )
        .run({ ...contactParams(input), id, ts: new Date().toISOString() });
      this.setCategories(id, input.categoryIds);
    });
    this.audit(operator, 'update', contactName(input));
    return this.get(id);
  }

  remove(id: number, operator: string): void {
    const c = this.get(id);
    this.db.prepare('DELETE FROM contacts WHERE id = ?').run(id);
    this.audit(operator, 'delete', contactName(c));
  }

  /** Person aus dem Personal einer Einheit als Kontakt übernehmen */
  fromPerson(p: Person, operator: string): Contact {
    const duplicate = this.db
      .prepare(
        `SELECT id FROM contacts WHERE kind = 'person' AND last_name = ? COLLATE NOCASE AND first_name = ? COLLATE NOCASE
           AND ((? <> '' AND email = ?) OR (? <> '' AND phones LIKE ?) OR (? = '' AND ? = ''))`,
      )
      .get(p.lastName, p.firstName, p.email, p.email, p.phone, `%${JSON.stringify(p.phone).slice(1, -1)}%`, p.email, p.phone);
    if (duplicate) throw new HttpError(409, `${personName(p)} ist bereits in den Kontakten`);
    const notes = [p.employer && `Arbeitgeber: ${p.employer}`, p.emergencyContact && `Notfallkontakt: ${p.emergencyContact}`, p.notes].filter(Boolean).join('\n');
    return this.create(
      {
        kind: 'person',
        lastName: p.lastName,
        firstName: p.firstName,
        organization: p.organization,
        function: p.function,
        phones: p.phone ? [{ label: 'Telefon', number: p.phone }] : [],
        email: p.email,
        address: p.address,
        notes: notes.slice(0, 2000),
        categoryIds: [],
      },
      operator,
    );
  }

  /** Adressvorschläge für eine Mail: Kontakte zuerst, dann Absender und Empfänger bisheriger Mails */
  mailSuggestions(query: string): MailAddressSuggestion[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const out: MailAddressSuggestion[] = [];
    const seen = new Set<string>();
    const add = (s: MailAddressSuggestion) => {
      if (!s.address || seen.has(s.address) || out.length >= MAX_SUGGESTIONS) return;
      seen.add(s.address);
      out.push(s);
    };
    const contacts = this.db
      .prepare(
        `SELECT * FROM contacts WHERE email <> '' AND (email LIKE @like ESCAPE '\\' OR last_name LIKE @like ESCAPE '\\' OR first_name LIKE @like ESCAPE '\\'
           OR organization LIKE @like ESCAPE '\\' OR (first_name || ' ' || last_name) LIKE @like ESCAPE '\\')
         ORDER BY CASE WHEN email LIKE @prefix ESCAPE '\\' THEN 0 ELSE 1 END, last_name COLLATE NOCASE, organization COLLATE NOCASE LIMIT ${MAX_SUGGESTIONS}`,
      )
      .all({ like, prefix: like.slice(1) }) as Row[];
    for (const r of contacts) add({ address: r.email as string, name: contactName(toContact(r, [])), source: 'contact' });
    if (out.length >= MAX_SUGGESTIONS) return out;

    // Bisherige Mails (neueste zuerst): Absender im Eingang, Empfänger im Ausgang
    const rows = this.db
      .prepare(
        `SELECT folder, from_text, from_address, to_json, cc_json FROM mail_messages
         WHERE (folder = 'inbox' AND (from_address LIKE @like ESCAPE '\\' OR from_text LIKE @like ESCAPE '\\'))
            OR (folder = 'sent' AND (to_json LIKE @like ESCAPE '\\' OR cc_json LIKE @like ESCAPE '\\'))
         ORDER BY date DESC LIMIT 200`,
      )
      .all({ like }) as { folder: string; from_text: string; from_address: string; to_json: string; cc_json: string }[];
    for (const r of rows) {
      const candidates =
        r.folder === 'inbox'
          ? [{ name: splitAddress(r.from_text).name, address: r.from_address.toLowerCase() }]
          : [...(JSON.parse(r.to_json) as string[]), ...(JSON.parse(r.cc_json) as string[])].map(splitAddress);
      for (const c of candidates) {
        if (c.address.includes(q) || c.name.toLowerCase().includes(q)) add({ ...c, source: 'mail' });
      }
    }
    return out;
  }
}
