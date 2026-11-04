import {
  DAMAGE_COUNT_CATEGORIES,
  folderPath,
  type CallRecord,
  type ChatMessage,
  type DamageAccount,
  type DamageCountBooking,
  type DamageTotal,
  type Incident,
  type IncidentDocument,
  type JournalEntry,
  type MailMessage,
  type MapObject,
  type MaterialRequest,
  type Message,
  type Person,
  type RadioIdentity,
  type Task,
  type Unit,
} from '@elvis/shared';
import type { Db } from '../../db/index.js';
import type { Store } from '../../db/store.js';
import type { ChatService } from '../chat.js';
import type { DamageService } from '../damage.js';
import type { DocumentService } from '../documents.js';
import type { MailService } from '../mail.js';
import type { MessageService } from '../messages.js';
import type { PersonnelService } from '../personnel.js';
import type { RequestService } from '../requests.js';
import type { TaskService } from '../tasks.js';
import type { CallLogService } from '../telephony.js';

/** Kennzeichen des Einsatzberichts in documents.generated */
export const REPORT_KIND = 'report';

export interface ReportDocument extends IncidentDocument {
  /** Ordnerpfad, leer = Wurzel */
  folder: string;
  /** Datei auf dem Datenträger */
  path: string;
}

export interface ReportData {
  incident: Incident;
  journal: JournalEntry[];
  units: Unit[];
  radioIds: RadioIdentity[];
  persons: Person[];
  accounts: (DamageAccount & { bookings: DamageCountBooking[] })[];
  totals: DamageTotal[];
  tasks: Task[];
  requests: MaterialRequest[];
  messages: Message[];
  mapObjects: MapObject[];
  calls: CallRecord[];
  chat: ChatMessage[];
  mails: MailMessage[];
  documents: ReportDocument[];
}

export interface CollectDeps {
  db: Db;
  store: Store;
  documents: DocumentService;
  personnel: PersonnelService;
  damage: DamageService;
  tasks: TaskService;
  requests: RequestService;
  messages: MessageService;
  calls: CallLogService;
  chat: ChatService;
  mail: MailService;
}

/** Summe der Personenschäden über alle Abschnitte (jeweils letzter Stand je Konto) */
export function damageTotals(accounts: DamageAccount[]): DamageTotal[] {
  const out: DamageTotal[] = [];
  for (const category of DAMAGE_COUNT_CATEGORIES) {
    const counts = accounts.flatMap((a) => a.counts.filter((c) => c.category === category));
    if (counts.length === 0) continue;
    out.push({
      category,
      value: counts.reduce((s, c) => s + c.value, 0),
      forces: counts.reduce((s, c) => s + c.forces, 0),
      estimated: counts.some((c) => c.estimated),
      at: counts.map((c) => c.at).sort().at(-1)!,
    });
  }
  return out;
}

/** Alles, was ELVIS zu einem Einsatz erfasst hat – Chat und E-Mail über den Einsatzzeitraum */
export function collectReport(deps: CollectDeps, incident: Incident): ReportData {
  const id = incident.id;
  const until = incident.closedAt ?? new Date().toISOString();
  const between = (table: string) =>
    (deps.db.prepare(`SELECT id FROM ${table} WHERE date >= ? AND date <= ? ORDER BY date, id`).all(incident.startedAt, until) as { id: number }[]).map((r) => r.id);

  const accounts = deps.damage.list(id).map((a) => ({ ...a, bookings: deps.damage.counts(a.id) }));
  const folders = deps.store.folders(id);
  const reports = deps.store.generatedDocumentIds(id, REPORT_KIND);
  const documents = deps.store
    .documents(id)
    .filter((d) => !d.draft && !reports.has(d.id))
    .map((d) => ({ ...d, folder: folderPath(folders, d.folderId), path: deps.documents.document(d.id).path }))
    .sort((a, b) => `${a.folder}/${a.filename}`.localeCompare(`${b.folder}/${b.filename}`, 'de'));

  return {
    incident,
    journal: deps.store.journal(id),
    units: deps.store.units(id),
    radioIds: deps.store.radioIds(id),
    persons: deps.personnel.listIncident(id),
    accounts,
    totals: damageTotals(accounts),
    tasks: deps.tasks.list(id, null),
    requests: deps.requests.list(id, null),
    messages: deps.messages.list(id, null).reverse(),
    mapObjects: deps.store.mapObjects(id),
    calls: deps.calls.forIncident(id),
    chat: between('chat_messages').map((m) => deps.chat.message(m)),
    mails: between('mail_messages').map((m) => deps.mail.message(m)),
    documents,
  };
}
