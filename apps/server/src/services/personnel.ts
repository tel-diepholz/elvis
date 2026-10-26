import { constants, createDecipheriv, generateKeyPair, privateDecrypt } from 'node:crypto';
import { promisify } from 'node:util';
import {
  encryptedSheetSchema,
  newUnitSchema,
  personnelSheetInputSchema,
  personnelStrength,
  sheetAssignSchema,
  type EncryptedSheet,
  type Person,
  type PersonData,
  type PersonnelForm,
  type PersonnelInbox,
  type PersonnelSheet,
  type RelayForm,
  type RelayFormRequest,
  type RelaySubmissionBatch,
  type RsaPublicJwk,
  type Topic,
  type Unit,
} from '@elvis/shared';
import type { z } from 'zod';
import type { Db } from '../db/index.js';
import type { Store } from '../db/store.js';
import { HttpError } from '../errors.js';
import type { IncidentService } from './incidents.js';
import { RelayError, type RelayClient } from './relay.js';

/** So oft fragt ELVIS beim Relay nach neuen Personalbögen, solange ein Formular-Link gilt */
export const SHEET_POLL_MS = 15_000;
/** Personalbögen im Eingang werden danach gelöscht; zugeordnetes Personal bleibt beim Einsatz */
export const SHEET_RETENTION_DAYS = 30;
const BATCH = 100;

interface PersonRow {
  id: number;
  incident_id: number;
  unit_id: number;
  sheet_id: number | null;
  last_name: string;
  first_name: string;
  birth_date: string;
  grade: Person['grade'];
  function: string;
  qualifications: string;
  organization: string;
  phone: string;
  address: string;
  employer: string;
  emergency_contact: string;
  notes: string;
  created_at: string;
  created_by: string;
  updated_at: string;
}

interface SheetRow {
  id: number;
  form_id: string | null;
  incident_id: number | null;
  unit_label: string;
  persons: string;
  submitted_at: string;
  received_at: string;
  read_at: string | null;
  unit_id: number | null;
  unit_name: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
}

interface FormRow {
  id: string;
  incident_id: number;
  url: string;
  private_key: string;
  created_at: string;
  created_by: string;
  expires_at: string;
  closed_at: string | null;
  relay_pending: number;
}

const toPerson = (r: PersonRow): Person => ({
  id: r.id,
  unitId: r.unit_id,
  incidentId: r.incident_id,
  sheetId: r.sheet_id,
  lastName: r.last_name,
  firstName: r.first_name,
  birthDate: r.birth_date,
  grade: r.grade,
  function: r.function,
  qualifications: JSON.parse(r.qualifications) as string[],
  organization: r.organization,
  phone: r.phone,
  address: r.address,
  employer: r.employer,
  emergencyContact: r.emergency_contact,
  notes: r.notes,
  createdAt: r.created_at,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
});

const personParams = (p: PersonData) => ({
  lastName: p.lastName,
  firstName: p.firstName,
  birthDate: p.birthDate,
  grade: p.grade,
  function: p.function,
  qualifications: JSON.stringify(p.qualifications),
  organization: p.organization,
  phone: p.phone,
  address: p.address,
  employer: p.employer,
  emergencyContact: p.emergencyContact,
  notes: p.notes,
});

const toSheet = (r: SheetRow): PersonnelSheet => ({
  id: r.id,
  incidentId: r.incident_id,
  unitLabel: r.unit_label,
  persons: JSON.parse(r.persons) as PersonData[],
  submittedAt: r.submitted_at,
  receivedAt: r.received_at,
  readAt: r.read_at,
  unitId: r.unit_id,
  unitName: r.unit_name,
  assignedAt: r.assigned_at,
  assignedBy: r.assigned_by,
});

const toForm = (r: FormRow): PersonnelForm => ({ id: r.id, incidentId: r.incident_id, url: r.url, createdAt: r.created_at, createdBy: r.created_by, expiresAt: r.expires_at });

const plural = (n: number) => `${n} Person${n === 1 ? '' : 'en'}`;

/** Personalbogen entschlüsseln: AES-Schlüssel per RSA-OAEP-256, Inhalt AES-256-GCM mit der Formular-ID als Zusatzdaten */
export function decryptSheet(payload: EncryptedSheet, privateKeyPem: string, formId: string): unknown {
  const aesKey = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(payload.key, 'base64'));
  const data = Buffer.from(payload.data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(Buffer.from(formId, 'utf8'));
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * Personal der Einheiten und Personalbögen aus dem Online-Formular. ELVIS fordert beim Relay einen Link an
 * (je Einsatz einer); Einheitsführer tragen dort Einheit und Personal ein. Der Bogen wird im Browser für
 * diesen ELW verschlüsselt, ELVIS holt ihn ab und legt ihn in den Eingang, wo er einer Einheit zugeordnet wird.
 * Der Link endet beim Beenden, nach Ablauf und mit dem Einsatz; danach verwirft ELVIS den Schlüssel.
 */
export class PersonnelService {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly incidents: IncidentService,
    private readonly notify: (topics: Topic[]) => void,
    private readonly relay: RelayClient,
    private readonly vehicleName: () => string,
  ) {}

  // --- Personal ---

  list(unitId: number): Person[] {
    return (this.db.prepare('SELECT * FROM personnel WHERE unit_id = ? ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, id').all(unitId) as PersonRow[]).map(toPerson);
  }

  listIncident(incidentId: number): Person[] {
    return (this.db.prepare('SELECT * FROM personnel WHERE incident_id = ? ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE, id').all(incidentId) as PersonRow[]).map(toPerson);
  }

  private person(id: number): Person {
    const r = this.db.prepare('SELECT * FROM personnel WHERE id = ?').get(id) as PersonRow | undefined;
    if (!r) throw new HttpError(404, `Person ${id} nicht gefunden`);
    return toPerson(r);
  }

  /** Einheit in einem laufenden Einsatz */
  private openUnit(unitId: number): Unit {
    const unit = this.store.unit(unitId);
    if (!unit) throw new HttpError(404, `Einheit ${unitId} nicht gefunden`);
    if (this.store.incident(unit.incidentId)?.closedAt) throw new HttpError(409, 'Einsatz ist abgeschlossen und kann nicht mehr geändert werden');
    return unit;
  }

  private insert(unit: Unit, persons: PersonData[], sheetId: number | null, operator: string): void {
    const ts = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO personnel (incident_id, unit_id, sheet_id, last_name, first_name, birth_date, grade, function, qualifications, organization,
         phone, address, employer, emergency_contact, notes, created_at, created_by, updated_at)
       VALUES (@incidentId, @unitId, @sheetId, @lastName, @firstName, @birthDate, @grade, @function, @qualifications, @organization,
         @phone, @address, @employer, @emergencyContact, @notes, @ts, @operator, @ts)`,
    );
    for (const p of persons) stmt.run({ ...personParams(p), incidentId: unit.incidentId, unitId: unit.id, sheetId, ts, operator });
  }

  /** Personalbogen auf der Detailseite: eine oder mehrere Personen */
  add(unitId: number, persons: PersonData[], operator: string): Person[] {
    const unit = this.openUnit(unitId);
    if (persons.length === 0) throw new HttpError(400, 'Mindestens eine Person');
    this.store.transaction(() => {
      this.insert(unit, persons, null, operator);
      this.incidents.unitEvent(unit.id, `Personal erfasst (${plural(persons.length)})`, operator);
    });
    this.notify(['personnel']);
    return this.list(unitId);
  }

  update(id: number, input: PersonData): Person {
    const before = this.person(id);
    this.openUnit(before.unitId);
    this.db
      .prepare(
        `UPDATE personnel SET last_name=@lastName, first_name=@firstName, birth_date=@birthDate, grade=@grade, function=@function,
           qualifications=@qualifications, organization=@organization, phone=@phone, address=@address, employer=@employer,
           emergency_contact=@emergencyContact, notes=@notes, updated_at=@ts WHERE id=@id`,
      )
      .run({ ...personParams(input), id, ts: new Date().toISOString() });
    this.notify(['personnel']);
    return this.person(id);
  }

  remove(id: number, operator: string): void {
    const p = this.person(id);
    this.openUnit(p.unitId);
    this.store.transaction(() => {
      this.db.prepare('DELETE FROM personnel WHERE id = ?').run(id);
      this.incidents.unitEvent(p.unitId, 'Personal: 1 Person entfernt', operator);
    });
    this.notify(['personnel']);
  }

  /** Personal an eine andere Einheit desselben Einsatzes übergeben (z. B. falsch zugeordneter Personalbogen) */
  transfer(unitId: number, personIds: number[], targetId: number, operator: string): Person[] {
    const from = this.openUnit(unitId);
    const to = this.openUnit(targetId);
    if (to.id === from.id) throw new HttpError(400, 'Personal ist bereits bei dieser Einheit');
    if (to.incidentId !== from.incidentId) throw new HttpError(409, 'Einheit gehört zu einem anderen Einsatz');
    const own = new Set(this.list(unitId).map((p) => p.id));
    const ids = [...new Set(personIds)];
    if (ids.length === 0) throw new HttpError(400, 'Keine Person ausgewählt');
    if (ids.some((id) => !own.has(id))) throw new HttpError(400, `Person gehört nicht zu ${from.name}`);
    const ts = new Date().toISOString();
    this.store.transaction(() => {
      const stmt = this.db.prepare('UPDATE personnel SET unit_id = ?, updated_at = ? WHERE id = ?');
      for (const id of ids) stmt.run(to.id, ts, id);
      // Ganzer Bogen umgezogen: der Bogen gehört jetzt zur neuen Einheit
      this.db
        .prepare('UPDATE personnel_sheets SET unit_id = ? WHERE unit_id = ? AND NOT EXISTS (SELECT 1 FROM personnel WHERE sheet_id = personnel_sheets.id AND unit_id = ?)')
        .run(to.id, from.id, from.id);
      this.incidents.unitEvent(from.id, `Personal an ${to.name} übergeben (${plural(ids.length)})`, operator);
      this.incidents.unitEvent(to.id, `Personal von ${from.name} übernommen (${plural(ids.length)})`, operator);
    });
    this.notify(['personnel']);
    return this.list(to.id);
  }

  // --- Eingang ---

  private sheetRows(where = '', ...args: unknown[]): SheetRow[] {
    return this.db
      .prepare(`SELECT s.*, u.name AS unit_name FROM personnel_sheets s LEFT JOIN units u ON u.id = s.unit_id ${where} ORDER BY s.received_at DESC, s.id DESC`)
      .all(...args) as SheetRow[];
  }

  private sheet(id: number): PersonnelSheet {
    const r = this.sheetRows('WHERE s.id = ?', id)[0];
    if (!r) throw new HttpError(404, `Personalbogen ${id} nicht gefunden`);
    return toSheet(r);
  }

  /** Eingang: nur noch nicht zugeordnete Bögen; zugeordnete stehen beim Personal der Einheit */
  inbox(): PersonnelInbox {
    const incident = this.store.activeIncident();
    const form = incident ? this.activeForm(incident.id) : null;
    return { relayEnabled: this.relay.enabled, form: form ? toForm(form) : null, sheets: this.sheetRows('WHERE s.unit_id IS NULL').map(toSheet), lastError: this.lastError };
  }

  unread(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM personnel_sheets WHERE read_at IS NULL').get() as { n: number }).n;
  }

  markRead(): void {
    const r = this.db.prepare('UPDATE personnel_sheets SET read_at = ? WHERE read_at IS NULL').run(new Date().toISOString());
    if (r.changes) this.notify(['personnelSheets']);
  }

  /** Einer Einheit im laufenden Einsatz zuordnen (oder dafür eine neue anlegen); nochmals zuordnen verschiebt das Personal */
  assign(sheetId: number, input: z.output<typeof sheetAssignSchema>, operator: string): PersonnelSheet {
    const sheet = this.sheet(sheetId);
    const incident = this.store.activeIncident();
    if (!incident) throw new HttpError(409, 'Kein Einsatz aufgelegt');
    const ts = new Date().toISOString();
    this.store.transaction(() => {
      let unit: Unit;
      if ('unitId' in input) {
        unit = this.openUnit(input.unitId);
        if (unit.incidentId !== incident.id) throw new HttpError(409, 'Einheit gehört nicht zum laufenden Einsatz');
      } else {
        unit = this.incidents.addUnit(
          incident.id,
          newUnitSchema.parse({ name: input.newUnit.name, parentId: input.newUnit.parentId, strength: personnelStrength(sheet.persons) }),
          operator,
        );
      }
      if (sheet.unitId === unit.id) return;
      const moved = sheet.unitId !== null ? this.db.prepare('UPDATE personnel SET unit_id = ?, incident_id = ?, updated_at = ? WHERE sheet_id = ?').run(unit.id, unit.incidentId, ts, sheetId).changes : 0;
      if (sheet.unitId === null) this.insert(unit, sheet.persons, sheetId, operator);
      this.db.prepare('UPDATE personnel_sheets SET unit_id = ?, incident_id = ?, assigned_at = ?, assigned_by = ?, read_at = COALESCE(read_at, ?) WHERE id = ?').run(unit.id, unit.incidentId, ts, operator, ts, sheetId);
      const n = sheet.unitId === null ? sheet.persons.length : moved;
      this.incidents.unitEvent(unit.id, `Personalbogen „${sheet.unitLabel}“ zugeordnet (${plural(n)})`, operator);
      if (sheet.unitId !== null && this.store.unit(sheet.unitId)) this.incidents.unitEvent(sheet.unitId, `Personalbogen „${sheet.unitLabel}“ an ${unit.name} abgegeben`, operator);
    });
    this.notify(['personnel', 'personnelSheets']);
    return this.sheet(sheetId);
  }

  /** Aus dem Eingang löschen; zugeordnetes Personal bleibt bei der Einheit */
  removeSheet(id: number): void {
    this.sheet(id);
    this.db.prepare('DELETE FROM personnel_sheets WHERE id = ?').run(id);
    this.notify(['personnelSheets']);
  }

  cleanup(now = new Date()): void {
    const before = new Date(now.getTime() - SHEET_RETENTION_DAYS * 86_400_000).toISOString();
    if (this.db.prepare('DELETE FROM personnel_sheets WHERE received_at < ?').run(before).changes) this.notify(['personnelSheets']);
  }

  // --- Online-Formular ---

  private activeForm(incidentId: number): FormRow | null {
    return (this.db.prepare('SELECT * FROM personnel_forms WHERE incident_id = ? AND closed_at IS NULL AND expires_at > ? ORDER BY created_at DESC').get(incidentId, new Date().toISOString()) as FormRow | undefined) ?? null;
  }

  /** Neuen Link für den laufenden Einsatz anfordern; ein bestehender endet damit */
  async createForm(validHours: number, operator: string): Promise<PersonnelForm> {
    const incident = this.store.activeIncident();
    if (!incident) throw new HttpError(409, 'Kein Einsatz aufgelegt');
    if (!this.relay.enabled) throw new HttpError(503, 'Cloud-Anbindung ist nicht eingerichtet (app.relayUrl in config/elvis.json)');
    const { publicKey, privateKey } = await promisify(generateKeyPair)('rsa', { modulusLength: 3072 });
    const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    const expiresAt = new Date(Date.now() + validHours * 3600_000).toISOString();
    const title = [this.vehicleName(), [incident.keyword, incident.title].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const request: RelayFormRequest = { title, expiresAt, publicKey: { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RSA-OAEP-256', ext: true, key_ops: ['encrypt'] } satisfies RsaPublicJwk };
    const created = (await this.relay.call('POST', '/v1/elws/me/forms', request).catch((e: unknown) => {
      if (e instanceof RelayError) throw new HttpError(502, e.message);
      throw e;
    })) as RelayForm;

    const ts = new Date().toISOString();
    this.store.transaction(() => {
      this.db.prepare('UPDATE personnel_forms SET closed_at = ?, relay_pending = 1 WHERE incident_id = ? AND closed_at IS NULL').run(ts, incident.id);
      this.db
        .prepare('INSERT INTO personnel_forms (id, incident_id, url, private_key, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(created.formId, incident.id, created.url, privateKey.export({ type: 'pkcs8', format: 'pem' }), ts, operator, expiresAt);
      this.incidents.incidentEvent(incident.id, `Cloud-Personalabfrage gestartet (${validHours} Stunden gültig)`, operator);
    });
    this.notify(['personnelSheets']);
    this.schedule();
    void this.poll();
    return toForm(this.db.prepare('SELECT * FROM personnel_forms WHERE id = ?').get(created.formId) as FormRow);
  }

  /** Link vorzeitig beenden; bereits eingereichte Bögen holt der nächste Lauf noch ab */
  async closeForm(operator: string): Promise<void> {
    const incident = this.store.activeIncident();
    const form = incident ? this.activeForm(incident.id) : null;
    if (!incident || !form) throw new HttpError(404, 'Kein aktiver Formular-Link');
    this.store.transaction(() => {
      this.db.prepare('UPDATE personnel_forms SET closed_at = ?, relay_pending = 1 WHERE id = ?').run(new Date().toISOString(), form.id);
      this.incidents.incidentEvent(incident.id, 'Cloud-Personalabfrage beendet', operator);
    });
    this.notify(['personnelSheets']);
    await this.poll();
  }

  // --- Abruf ---

  start(): void {
    if (!this.relay.enabled) return;
    void this.poll();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.relay.enabled && !this.timer) this.timer = setInterval(() => void this.poll(), SHEET_POLL_MS);
  }

  poll(): Promise<void> {
    this.running ??= this.run()
      .then(() => this.setError(null))
      .catch((e: unknown) => this.setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private setError(msg: string | null): void {
    if (msg === this.lastError) return;
    this.lastError = msg;
    this.notify(['personnelSheets']);
  }

  private forms(where: string, ...args: unknown[]): FormRow[] {
    return this.db.prepare(`SELECT * FROM personnel_forms WHERE ${where}`).all(...args) as FormRow[];
  }

  private async run(): Promise<void> {
    const ts = new Date().toISOString();
    // Mit dem Einsatz und nach Ablauf endet der Link
    const ended = this.forms('closed_at IS NULL').filter((f) => f.expires_at <= ts || this.store.incident(f.incident_id)?.closedAt);
    for (const f of ended) this.db.prepare('UPDATE personnel_forms SET closed_at = ?, relay_pending = 1 WHERE id = ?').run(ts, f.id);
    if (ended.length) this.notify(['personnelSheets']);

    const live = this.forms('closed_at IS NULL OR relay_pending = 1');
    if (live.length === 0) {
      this.stop();
      return;
    }
    // Erst abholen, dann beendete Links beim Relay löschen – so geht kein eingereichter Bogen verloren
    await this.fetchSheets();
    for (const f of this.forms('relay_pending = 1')) {
      try {
        await this.relay.call('DELETE', `/v1/elws/me/forms/${f.id}`);
      } catch (e) {
        if (!(e instanceof RelayError && e.status === 404)) throw e;
      }
      // Ohne Link braucht es den Schlüssel nicht mehr
      this.db.prepare("UPDATE personnel_forms SET relay_pending = 0, private_key = '' WHERE id = ?").run(f.id);
    }
  }

  private async fetchSheets(): Promise<void> {
    const creds = await this.relay.ensureCredentials();
    const after = creds.sheetCursor ?? 0;
    const batch = (await this.relay.call('GET', `/v1/elws/me/submissions?after=${after}`)) as RelaySubmissionBatch;
    let added = 0;
    const failed: string[] = [];
    for (const item of batch.items) {
      const form = this.db.prepare('SELECT * FROM personnel_forms WHERE id = ?').get(item.formId) as FormRow | undefined;
      if (!form?.private_key) continue;
      let sheet: z.output<typeof personnelSheetInputSchema>;
      try {
        sheet = personnelSheetInputSchema.parse(decryptSheet(encryptedSheetSchema.parse(item.payload), form.private_key, form.id));
      } catch {
        failed.push(`#${item.seq}`);
        continue;
      }
      this.db
        .prepare('INSERT INTO personnel_sheets (form_id, incident_id, unit_label, persons, submitted_at, received_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(form.id, form.incident_id, sheet.unitLabel, JSON.stringify(sheet.persons), item.submittedAt, new Date().toISOString());
      added++;
    }
    if (batch.next !== after) this.relay.saveCursor(creds.elwId, { sheetCursor: batch.next });
    if (added) this.notify(['personnelSheets']);
    if (failed.length) throw new Error(`Personalbogen ${failed.join(', ')} ließ sich nicht lesen und wurde verworfen`);
    if (batch.items.length >= BATCH) await this.fetchSheets();
  }
}

