import PDFDocument from 'pdfkit';
import {
  CHAT_CHANNEL_LABEL,
  CHAT_STATUS_LABEL,
  DAMAGE_COUNT_LABELS,
  DAMAGE_ENTRY_SIDE_LABELS,
  JOURNAL_CATEGORY_LABELS,
  MAP_OBJECT_LABELS,
  PERSON_GRADE,
  REQUEST_STATUS_LABELS,
  UNIT_STATUS,
  extensionOf,
  formatStrength,
  requestLabel,
  sumStrength,
  type DamageAccount,
  type DamageEntry,
  type Person,
  type Unit,
  type VehicleInfo,
} from '@elvis/shared';
import { pdfText } from '../print.js';
import type { PreparedAttachment } from './attachments.js';
import type { ReportData } from './collect.js';
import { PAGE_MARGINS, Writer, mm, type Cell } from './layout.js';

const TZ = 'Europe/Berlin';
const fmtDateTime = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtShort = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export const dt = (iso: string | null | undefined) => (iso ? fmtDateTime.format(new Date(iso)) : '');
const st = (iso: string | null | undefined) => (iso ? fmtShort.format(new Date(iso)) : '');
const birth = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}` : d);
const join = (...parts: (string | number | null | undefined | false)[]) => parts.filter(Boolean).join('\n');

function duration(from: string, to: string | null): string {
  const min = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  return `${d ? `${d} d ` : ''}${h} h ${String(min % 60).padStart(2, '0')} min`;
}

/** Kurzer Dateityp für Tabellen: Endung, sonst MIME-Typ */
const fileType = (filename: string, mime: string) => extensionOf(filename).toUpperCase() || mime;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

/** Markdown der Meldungen als lesbarer Klartext */
export function plainMarkdown(md: string): string {
  return md
    .replace(/```[a-z]*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .trim();
}

export interface ReportRenderContext {
  vehicle: VehicleInfo;
  operator: string;
  now: Date;
  /** Seiten der Lagekarte (wird beim Zusammensetzen an die Stelle der Platzhalterseite gesetzt); 0 = keine Karte */
  mapPages: number;
  /** Warum keine Karte bzw. Hinweise dazu */
  mapNote: string;
  /** Dateianhänge aus Chat und E-Mail (Name im PDF), für den Hinweis im Bericht */
  messageAttachments: number;
}

export interface RenderedReport {
  pdf: Buffer;
  /** Platzhalterseite der Lagekarte (0-basiert) oder null */
  mapPage: number | null;
  /** Nach dieser Seite (0-basiert) das PDF der Anlage einfügen */
  inserts: { afterPage: number; attachment: PreparedAttachment }[];
}

/** Hauptteil des Einsatzberichts mit pdfkit (A4 hoch) */
export async function renderReport(data: ReportData, attachments: PreparedAttachment[], ctx: ReportRenderContext): Promise<RenderedReport> {
  const { incident } = data;
  const title = `Einsatzbericht ${[incident.keyword, incident.title].filter(Boolean).join(' – ')}`;
  const doc = new PDFDocument({
    size: 'A4',
    margins: PAGE_MARGINS,
    bufferPages: true,
    autoFirstPage: true,
    info: { Title: pdfText(title), Author: pdfText(`${ctx.vehicle.callsign || ctx.vehicle.name} – ${ctx.operator}`), Creator: 'ELVIS', CreationDate: ctx.now },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const w = new Writer(doc);
  const toc: { title: string; page: number }[] = [];
  const section = (t: string) => toc.push({ title: t, page: w.section(t) });
  const unitName = new Map(data.units.map((u) => [u.id, u.name]));
  const accountName = new Map(data.accounts.map((a) => [a.id, `${a.number} ${a.name}`]));

  // --- Deckblatt (Inhaltsverzeichnis wird am Ende eingetragen) ---
  doc.outline.addItem('Deckblatt');
  doc.font('Helvetica-Bold').fontSize(26).fillColor('#b71c1c').text('Einsatzbericht', w.left, mm(40), { width: w.width });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('black').text(pdfText([incident.keyword, incident.title].filter(Boolean).join(' – ') || `Lage ${incident.id}`), { width: w.width });
  doc.moveDown(1);
  w.keyValues([
    ['Einsatzort', incident.location],
    ['Koordinaten', incident.lat !== null && incident.lon !== null ? `${incident.lat.toFixed(5)}, ${incident.lon.toFixed(5)}` : null],
    ['Einsatzleiter', incident.leader],
    ['Beginn', dt(incident.startedAt)],
    ['Ende', incident.closedAt ? dt(incident.closedAt) : 'läuft noch (Zwischenbericht)'],
    ['Dauer', duration(incident.startedAt, incident.closedAt)],
    ['Fahrzeug', [ctx.vehicle.name, ctx.vehicle.callsign, ctx.vehicle.organization].filter(Boolean).join(' · ')],
    ['Erstellt', `${dt(ctx.now.toISOString())} von ${ctx.operator}`],
  ]);
  const tocY = doc.y + mm(10);

  // --- Übersicht ---
  section('Übersicht');
  const active = data.units.filter((u) => u.status !== 'geplant');
  const persons = data.persons.length;
  w.keyValues(
    [
      ['Einheiten', `${active.length} (Stärke ${formatStrength(sumStrength(active))})`],
      ['Erfasstes Personal', String(persons)],
      ['Einsatzabschnitte', String(data.accounts.length)],
      ['Tagebucheinträge', String(data.journal.length)],
      ['Meldungen', String(data.messages.length)],
      ['Aufgaben', `${data.tasks.length} (${data.tasks.filter((t) => t.doneAt).length} erledigt)`],
      ['Anforderungen', String(data.requests.length)],
      ['Telefonate', String(data.calls.length)],
      ['Chat / E-Mail im Zeitraum', `${data.chat.length} / ${data.mails.length}`],
      ['Kartenobjekte', String(data.mapObjects.length)],
      ['Dokumente', String(data.documents.length)],
    ],
    0.4,
  );
  if (data.totals.length) {
    w.heading('Personenschäden gesamt');
    w.table(
      [
        { header: 'Kategorie', width: 0.4 },
        { header: 'Anzahl', width: 0.15 },
        { header: 'davon EK', width: 0.15 },
        { header: 'Stand', width: 0.3 },
      ],
      data.totals.map((t) => [DAMAGE_COUNT_LABELS[t.category], `${t.estimated ? 'ca. ' : ''}${t.value}`, String(t.forces), dt(t.at)]),
    );
  }

  // --- Lagekarte ---
  let mapPage: number | null = null;
  if (ctx.mapPages > 0) {
    section('Lagekarte (Endstand)');
    w.muted('Die Lagekarte folgt auf der nächsten Seite.');
    if (ctx.mapNote) w.muted(ctx.mapNote);
    w.newPage();
    mapPage = w.pageIndex;
  } else {
    section('Lagekarte (Endstand)');
    w.muted(ctx.mapNote || 'Keine Lagekarte: weder Einsatzort noch Kräfte oder Objekte mit Position.');
  }

  // --- Einsatztagebuch ---
  section('Einsatztagebuch');
  const corrected = new Set(data.journal.map((j) => j.correctsId).filter((x): x is number => x !== null));
  w.table(
    [
      { header: 'Nr.', width: 0.06 },
      { header: 'Zeit', width: 0.12 },
      { header: 'Art', width: 0.1 },
      { header: 'Von / An', width: 0.16 },
      { header: 'Inhalt', width: 0.42 },
      { header: 'Erfasst', width: 0.14 },
    ],
    data.journal.map((j): Cell[] => {
      const late = Math.abs(Date.parse(j.recordedAt) - Date.parse(j.timestamp)) > 60_000;
      const text = `${j.important ? '! ' : ''}${j.correctsId ? `[Korrektur zu Nr. ${j.correctsId}] ` : ''}${j.text}`;
      return [
        String(j.id),
        st(j.timestamp),
        JOURNAL_CATEGORY_LABELS[j.category],
        join(j.sender && `von ${j.sender}`, j.recipient && `an ${j.recipient}`),
        { text, bold: j.important, strike: corrected.has(j.id), color: j.category === 'system' ? '#555555' : undefined },
        join(j.author, late && `nachgetragen ${st(j.recordedAt)}`),
      ];
    }),
  );

  // --- Einsatzabschnitte / Schadenkonten ---
  section('Einsatzabschnitte und Schadenkonten');
  if (data.accounts.length === 0) w.muted('Keine Einsatzabschnitte angelegt.');
  for (const a of data.accounts) renderAccount(w, a, data.units.filter((u) => u.accountId === a.id));

  // --- Kräfte ---
  section('Kräfte');
  const children = new Map<number | null, Unit[]>();
  for (const u of data.units) children.set(u.parentId, [...(children.get(u.parentId) ?? []), u]);
  const ordered: { u: Unit; depth: number }[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const u of children.get(parent) ?? []) {
      ordered.push({ u, depth });
      walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  // Einheiten, deren Eltern fehlen (sollte nicht vorkommen), trotzdem aufführen
  for (const u of data.units) if (!ordered.some((o) => o.u.id === u.id)) ordered.push({ u, depth: 0 });
  const radio = new Map<number, string[]>();
  for (const r of data.radioIds) if (r.unitId) radio.set(r.unitId, [...(radio.get(r.unitId) ?? []), r.issi]);
  w.table(
    [
      { header: 'Einheit', width: 0.27 },
      { header: 'Organisation / Funk', width: 0.2 },
      { header: 'Stärke', width: 0.09 },
      { header: 'Abschnitt', width: 0.14 },
      { header: 'Status', width: 0.14 },
      { header: 'Eingetroffen / Entlassen', width: 0.16 },
    ],
    ordered.map(({ u, depth }) => [
      { text: `${'   '.repeat(depth)}${depth ? '└ ' : ''}${u.name}${u.role ? ` (${u.role})` : ''}`, bold: depth === 0 },
      join(u.organization, u.callsign && `Rufname ${u.callsign}`, radio.get(u.id)?.length && `ISSI ${radio.get(u.id)!.join(', ')}`, u.mobile, u.email),
      formatStrength(u.strength),
      u.accountId ? (accountName.get(u.accountId) ?? u.section) : u.section,
      UNIT_STATUS[u.status],
      join(u.arrivedAt && `an ${st(u.arrivedAt)}`, u.releasedAt && `ab ${st(u.releasedAt)}`),
    ]),
  );
  const notes = ordered.filter(({ u }) => u.notes);
  if (notes.length) {
    w.heading('Bemerkungen zu Einheiten', 10);
    w.table(
      [
        { header: 'Einheit', width: 0.3 },
        { header: 'Bemerkung', width: 0.7 },
      ],
      notes.map(({ u }) => [u.name, u.notes]),
    );
  }

  w.heading('Personal');
  if (data.persons.length === 0) w.muted('Kein Personal erfasst.');
  for (const { u } of ordered) {
    const list = data.persons.filter((p) => p.unitId === u.id);
    if (list.length === 0) continue;
    w.heading(`${u.name} (${list.length})`, 9.5);
    w.table(
      [
        { header: 'Name / Geburtsdatum', width: 0.22 },
        { header: 'Dienstgrad / Funktion', width: 0.18 },
        { header: 'Qualifikationen', width: 0.17 },
        { header: 'Kontakt / Anschrift', width: 0.22 },
        { header: 'Arbeitgeber / Notfallkontakt / Notizen', width: 0.21 },
      ],
      list.map((p) => personRow(p)),
      7.5,
    );
  }

  // --- Aufgaben ---
  section('Aufgaben');
  w.table(
    [
      { header: 'Aufgabe', width: 0.36 },
      { header: 'Verantwortlich', width: 0.16 },
      { header: 'Fällig / Intervall', width: 0.16 },
      { header: 'Erledigt', width: 0.18 },
      { header: 'Angelegt', width: 0.14 },
    ],
    data.tasks.map((t) => [
      { text: join(t.summary, t.description !== t.summary && t.description, t.requestId && 'Wiedervorlage einer Anforderung'), strike: !!t.doneAt },
      t.assigneeName ?? 'alle',
      join(t.dueAt && st(t.dueAt), t.intervalMinutes && `alle ${t.intervalMinutes} min`),
      join(t.doneAt && `${st(t.doneAt)} ${t.doneBy ?? ''}`, !t.doneAt && t.lastDoneAt && `zuletzt ${st(t.lastDoneAt)} ${t.lastDoneBy ?? ''}`),
      join(st(t.createdAt), t.createdBy),
    ]),
  );

  // --- Anforderungen ---
  section('Anforderungen');
  w.table(
    [
      { header: 'Nr.', width: 0.07 },
      { header: 'Anfordernde Kraft', width: 0.17 },
      { header: 'Material / Leistung', width: 0.34 },
      { header: 'Benötigt bis', width: 0.12 },
      { header: 'Status', width: 0.16 },
      { header: 'Angelegt', width: 0.14 },
    ],
    data.requests.map((r) => [
      requestLabel(r),
      r.unit,
      join(r.material, r.forwardedAt && `an Stab ${st(r.forwardedAt)} (${r.forwardedBy ?? ''})`),
      r.neededBy ? st(r.neededBy) : 'sofort',
      join(REQUEST_STATUS_LABELS[r.status], `${st(r.statusAt)} ${r.statusBy}`),
      join(st(r.createdAt), r.createdBy),
    ]),
  );

  // --- Meldungen ---
  section('Meldungen');
  if (data.messages.length === 0) w.muted('Keine Meldungen.');
  for (const m of data.messages) {
    w.ensure(60);
    w.heading(`Nr. ${m.id} · ${m.direction === 'in' ? 'Eingang' : 'Ausgang'} · ${st(m.createdAt)} · von ${m.sender} an ${m.recipient ?? '(nicht verteilt)'}`, 9.5);
    w.paragraph(plainMarkdown(m.body));
    w.muted(
      [
        `erfasst von ${m.createdBy}`,
        m.replyToId && `Antwort auf Nr. ${m.replyToId}`,
        m.requestId && `zu Anforderung ${data.requests.find((r) => r.id === m.requestId)?.number ? `A-${data.requests.find((r) => r.id === m.requestId)!.number}` : m.requestId}`,
        m.claimedBy && `bearbeitet von ${m.claimedBy}`,
        m.snoozeCount && `${m.snoozeCount}× erneut versucht`,
        m.doneAt && `übermittelt/erledigt ${st(m.doneAt)} ${m.doneBy ?? ''}`,
        m.ackAt && `zur Kenntnis ${st(m.ackAt)} ${m.ackBy ?? ''}`,
        ...m.copies.map((c) => `Kopie an ${c.role}${c.ackAt ? ` (gelesen ${st(c.ackAt)} ${c.ackBy ?? ''})` : ''}`),
      ]
        .filter(Boolean)
        .join(' · '),
    );
    if (m.reply) {
      w.paragraph(`Antwort (${st(m.repliedAt)} ${m.repliedBy ?? ''}):`, { size: 9, bold: true });
      w.paragraph(plainMarkdown(m.reply));
    }
    w.gap(0.4);
  }

  // --- Telefonate ---
  section('Telefonate');
  w.table(
    [
      { header: 'Beginn', width: 0.16 },
      { header: 'Richtung', width: 0.12 },
      { header: 'Gegenstelle', width: 0.32 },
      { header: 'Leitung', width: 0.16 },
      { header: 'Dauer', width: 0.12 },
      { header: 'Ende', width: 0.12 },
    ],
    data.calls.map((c) => [
      st(c.startedAt),
      c.direction === 'in' ? 'eingehend' : 'ausgehend',
      join(c.name, c.number),
      c.trunk ?? '',
      c.durationS ? `${Math.floor(c.durationS / 60)}:${String(c.durationS % 60).padStart(2, '0')} min` : 'nicht angenommen',
      st(c.endedAt),
    ]),
  );

  // --- Chat und E-Mail ---
  section('Chat und E-Mail im Einsatzzeitraum');
  w.muted('Nachrichten und E-Mails sind keiner Lage fest zugeordnet; aufgeführt ist der gesamte Verkehr zwischen Beginn und Ende der Lage.');
  if (ctx.messageAttachments) w.muted(`${ctx.messageAttachments} Anhang/Anhänge aus Chat und E-Mail sind als Dateianhang in dieses PDF eingebettet (E-Mails zusätzlich im Original als .eml).`);
  w.heading('Chat / SMS');
  w.table(
    [
      { header: 'Zeit', width: 0.13 },
      { header: 'Kanal', width: 0.1 },
      { header: 'Gegenstelle', width: 0.2 },
      { header: 'Nachricht', width: 0.43 },
      { header: 'Status', width: 0.14 },
    ],
    data.chat.map((m) => [
      st(m.date),
      CHAT_CHANNEL_LABEL[m.channel] ?? m.channel,
      join(m.folder === 'inbox' ? 'von' : 'an', m.name, m.peer !== m.name && m.peer),
      join(m.text, m.attachment && `[Anhang: ${m.attachment.name}]`, m.location && `[Standort ${m.location.lat.toFixed(5)}, ${m.location.lon.toFixed(5)}]`),
      join(CHAT_STATUS_LABEL[m.status], m.folder === 'sent' && m.createdBy, m.error),
    ]),
  );
  w.heading('E-Mail');
  if (data.mails.length === 0) w.muted('Keine E-Mails.');
  for (const m of data.mails) {
    w.ensure(70);
    w.heading(`${st(m.date)} · ${m.folder === 'inbox' ? 'Eingang' : 'Ausgang'} · ${m.subject || '(ohne Betreff)'}`, 9.5);
    w.keyValues(
      [
        ['Von', m.from],
        ['An', m.to.join(', ')],
        ['Kopie', m.cc.join(', ')],
        ['Sicherheit', `${m.encryption === 'e2e' ? 'Ende-zu-Ende verschlüsselt' : m.encryption === 'relay' ? 'Transport verschlüsselt' : 'unverschlüsselt'}${m.signature === 'valid' ? ', Signatur gültig' : m.signature === 'invalid' ? ', Signatur UNGÜLTIG' : ''}`],
        ['Anhänge', m.attachments.map((a) => `${a.filename} (${size(a.size)})`).join(', ')],
      ],
      0.15,
    );
    w.paragraph(m.text.trim() || '(kein Textteil)', { size: 8.5 });
    w.gap(0.5);
  }

  // --- Kartenobjekte ---
  section('Kartenobjekte');
  w.table(
    [
      { header: 'Art', width: 0.12 },
      { header: 'Bezeichnung', width: 0.3 },
      { header: 'Position', width: 0.2 },
      { header: 'Angaben', width: 0.2 },
      { header: 'Angelegt', width: 0.18 },
    ],
    data.mapObjects.map((o) => [
      MAP_OBJECT_LABELS[o.kind],
      { text: `${o.name}${o.visible ? '' : ' (ausgeblendet)'}`, color: o.visible ? undefined : '#777777' },
      `${o.lat.toFixed(5)}, ${o.lon.toFixed(5)}`,
      objectDetail(o),
      join(st(o.createdAt), o.createdBy),
    ]),
  );

  // --- Dokumente ---
  section('Dokumentenverzeichnis');
  w.muted('Alle Originaldateien sind als Dateianhang in dieses PDF eingebettet (in PDF-Programmen unter „Anhänge“). Inhalte, die sich darstellen lassen, folgen im Anhang.');
  w.table(
    [
      { header: 'Anl.', width: 0.06 },
      { header: 'Ordner / Datei', width: 0.36 },
      { header: 'Typ / Größe', width: 0.16 },
      { header: 'Beschreibung', width: 0.2 },
      { header: 'Hochgeladen', width: 0.12 },
      { header: 'Im Bericht', width: 0.1 },
    ],
    attachments.map((a) => [
      a.label,
      join(a.doc.folder || '(Hauptordner)', a.doc.filename),
      join(fileType(a.doc.filename, a.doc.mimeType), size(a.doc.sizeBytes), a.doc.version > 1 && `Version ${a.doc.version}`),
      a.doc.description,
      join(st(a.doc.uploadedAt), a.doc.uploadedBy),
      a.mode === 'none' ? 'nur Anhang' : a.mode === 'image' ? 'Bild' : a.mode === 'text' ? 'Text' : `${a.pdfPages} S.`,
    ]),
  );

  // --- Anhang ---
  const inserts: RenderedReport['inserts'] = [];
  if (attachments.length) {
    let outline: ReturnType<PDFKit.PDFDocument['outline']['addItem']> | null = null;
    // Dateien ohne darstellbaren Inhalt stehen nur im Verzeichnis und als Dateianhang
    for (const a of attachments.filter((x) => x.mode !== 'none')) {
      w.newPage();
      if (!outline) {
        outline = doc.outline.addItem('Anhang');
        toc.push({ title: 'Anhang', page: w.pageIndex });
      }
      outline.addItem(pdfText(`${a.label} ${a.doc.filename}`));
      doc.font('Helvetica-Bold').fontSize(13).fillColor('#b71c1c').text(pdfText(`Anlage ${a.label}: ${a.doc.filename}`), w.left, doc.y, { width: w.width });
      doc.fillColor('black').moveDown(0.3);
      w.keyValues(
        [
          ['Ordner', a.doc.folder || '(Hauptordner)'],
          ['Typ / Größe', `${fileType(a.doc.filename, a.doc.mimeType)} (${a.doc.mimeType}) · ${size(a.doc.sizeBytes)}`],
          ['Beschreibung', a.doc.description],
          ['Hochgeladen', `${dt(a.doc.uploadedAt)} von ${a.doc.uploadedBy}`],
          ['Zuletzt geändert', a.doc.updatedAt !== a.doc.uploadedAt ? `${dt(a.doc.updatedAt)} von ${a.doc.updatedBy}` : null],
        ],
        0.22,
      );
      if (a.note) w.muted(a.note);
      w.gap(0.5);
      if (a.mode === 'image' && a.image) {
        try {
          const top = doc.y;
          doc.image(a.image, w.left, top, { fit: [w.width, w.bottom - top], align: 'center' });
        } catch {
          w.muted('Bild konnte nicht dargestellt werden – siehe Dateianhang.');
        }
      } else if (a.mode === 'text' && a.text !== undefined) {
        doc.font('Courier').fontSize(7.5).fillColor('black').text(pdfText(a.text), w.left, doc.y, { width: w.width });
      } else if ((a.mode === 'pdf' || a.mode === 'office') && a.pdf) {
        w.muted(`Es folgen ${a.pdfPages} Seite(n).`);
        inserts.push({ afterPage: w.pageIndex, attachment: a });
      }
    }
  }

  // --- Inhaltsverzeichnis, Kopf- und Fußzeilen (Seitenzahlen inkl. eingefügter Seiten) ---
  const range = doc.bufferedPageRange();
  const finalPage = (i: number) => {
    let n = i + 1;
    for (const ins of inserts) if (ins.afterPage < i) n += ins.attachment.pdfPages ?? 0;
    if (mapPage !== null && i > mapPage) n += ctx.mapPages - 1;
    return n;
  };
  const total = range.count + inserts.reduce((s, i) => s + (i.attachment.pdfPages ?? 0), 0) + (mapPage !== null ? ctx.mapPages - 1 : 0);
  doc.switchToPage(0);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text('Inhalt', w.left, tocY, { width: w.width });
  doc.moveDown(0.3);
  for (const t of toc) {
    const y = doc.y;
    doc.font('Helvetica').fontSize(10).text(pdfText(t.title), w.left, y, { width: w.width - 40 });
    doc.text(String(finalPage(t.page)), w.left + w.width - 40, y, { width: 40, align: 'right' });
    doc.moveDown(0.15);
  }
  const header = pdfText(`${title} · ${ctx.vehicle.name}`);
  for (let i = 0; i < range.count; i++) {
    if (i === mapPage) continue;
    doc.switchToPage(i);
    // Außerhalb der Ränder schreiben, ohne dass pdfkit eine neue Seite beginnt
    const { margins } = doc.page;
    doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };
    const n = finalPage(i);
    doc.font('Helvetica').fontSize(7).fillColor('#777777');
    if (i > 0) doc.text(header, PAGE_MARGINS.left, mm(9), { width: w.width, lineBreak: false, ellipsis: true });
    doc.text(`Erstellt ${dt(ctx.now.toISOString())} · ELVIS`, PAGE_MARGINS.left, doc.page.height - mm(11), { width: w.width / 2, lineBreak: false });
    doc.text(`Seite ${n} von ${total}`, PAGE_MARGINS.left + w.width / 2, doc.page.height - mm(11), { width: w.width / 2, align: 'right', lineBreak: false });
    doc.page.margins = margins;
  }
  doc.end();
  return { pdf: await done, mapPage, inserts };
}

function personRow(p: Person): Cell[] {
  return [
    { text: join(`${p.lastName}, ${p.firstName}`, p.birthDate && `geb. ${birth(p.birthDate)}`, p.organization), bold: false },
    join(PERSON_GRADE[p.grade], p.function),
    p.qualifications.join(', '),
    join(p.phone, p.email, p.address),
    join(p.employer && `AG: ${p.employer}`, p.emergencyContact && `Notfall: ${p.emergencyContact}`, p.notes),
  ];
}

function entryText(e: DamageEntry): Cell {
  const text = `${e.count !== null ? `${e.count} × ` : ''}${e.text}${e.uncertain ? ' (?)' : ''}\n${st(e.createdAt)} ${e.createdBy}${e.doneAt ? ` · erledigt ${st(e.doneAt)} ${e.doneBy ?? ''}` : ''}`;
  return { text, strike: !!e.doneAt };
}

function renderAccount(w: Writer, a: DamageAccount & { bookings: { category: string; value: number; forces: number; estimated: boolean; note: string; at: string; by: string }[] }, units: Unit[]): void {
  w.heading(`Abschnitt ${a.number}: ${a.name}${a.closedAt ? ' (abgeschlossen)' : ''}`);
  w.keyValues([
    ['Abschnittsleiter', a.leader],
    ['Fm-Verbindung', a.radio],
    ['Position', a.lat !== null && a.lon !== null ? `${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}` : null],
    ['Eröffnet', `${dt(a.createdAt)} von ${a.createdBy}`],
    ['Abgeschlossen', a.closedAt ? `${dt(a.closedAt)} von ${a.closedBy ?? ''}` : null],
    ['Kräfte', units.map((u) => u.name).join(', ')],
  ]);
  // T-Konto: links Schaden und Gefahr, rechts Maßnahmen
  const left = a.entries.filter((e) => e.side !== 'massnahme');
  const right = a.entries.filter((e) => e.side === 'massnahme');
  const rows: Cell[][] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    const r = right[i];
    rows.push([l ? `${DAMAGE_ENTRY_SIDE_LABELS[l.side]}` : '', l ? entryText(l) : '', r ? entryText(r) : '']);
  }
  w.table(
    [
      { header: 'Art', width: 0.1 },
      { header: 'Schaden / Gefahr', width: 0.45 },
      { header: 'Maßnahme', width: 0.45 },
    ],
    rows,
  );
  if (a.bookings.length) {
    w.heading('Personenschäden – Buchungsverlauf', 9.5);
    w.table(
      [
        { header: 'Zeit', width: 0.14 },
        { header: 'Kategorie', width: 0.22 },
        { header: 'Anzahl', width: 0.1 },
        { header: 'davon EK', width: 0.1 },
        { header: 'Bemerkung', width: 0.28 },
        { header: 'Von', width: 0.16 },
      ],
      a.bookings.map((b) => [st(b.at), DAMAGE_COUNT_LABELS[b.category as keyof typeof DAMAGE_COUNT_LABELS] ?? b.category, `${b.estimated ? 'ca. ' : ''}${b.value}`, String(b.forces), b.note, b.by]),
    );
  }
}

function objectDetail(o: ReportData['mapObjects'][number]): string {
  switch (o.kind) {
    case 'point':
    case 'sign':
    case 'area':
    case 'line':
      return o.data.detail;
    case 'sector':
      return `Länge ${o.data.sectorM} m`;
    case 'gauss':
      return `Quellhöhe ${o.data.sourceHeightM} m${o.data.releaseRateKgS ? `, ${o.data.releaseRateKgS} kg/s` : ''}`;
    case 'overlay':
      return `Seite ${o.data.page} aus ${o.data.filename}`;
    default:
      return '';
  }
}
