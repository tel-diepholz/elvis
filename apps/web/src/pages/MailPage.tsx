import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Download, KeyRound, Lock, LockOpen, Mail, MailOpen, Paperclip, PenSquare, Reply, ReplyAll, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { MAIL_MAX_ATTACHMENT_BYTES, type MailDraft, type MailFolder, type MailRecipientKey, type MailSummary } from '@elvis/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtBytes, fmtDateTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { Badge, Card, EmptyState, Field, Loading, Modal, PageHeader, Segmented } from '../components/ui';
import { AddressInput } from '../components/mail/AddressInput';

const ENCRYPTION: Record<MailSummary['encryption'], { tone: 'ok' | 'warn'; label: string; title: string }> = {
  e2e: { tone: 'ok', label: 'Ende-zu-Ende verschlüsselt', title: 'Nur der ELW und die Gegenstelle können die Mail lesen' },
  relay: { tone: 'warn', label: 'Unverschlüsselt übertragen', title: 'Der Absender hat nicht verschlüsselt; das Relay hat die Mail beim Eingang für den ELW verschlüsselt' },
  none: { tone: 'warn', label: 'Unverschlüsselt gesendet', title: 'Für mindestens einen Empfänger war kein Schlüssel bekannt' },
};
const SIGNATURE: Record<Exclude<MailSummary['signature'], 'none'>, { tone: 'ok' | 'alarm' | 'muted'; label: string }> = {
  valid: { tone: 'ok', label: 'Signatur gültig' },
  invalid: { tone: 'alarm', label: 'Signatur ungültig' },
  'unknown-key': { tone: 'muted', label: 'Signiert, Schlüssel unbekannt' },
};

const splitAddresses = (v: string) =>
  v
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);
const bareAddress = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();

/** E-Mail: Postfach des ELW (…@einsatzleitwagen.app) für alle Bediener */
export function MailPage() {
  const admin = !!useAuth().user?.isAdmin;
  const { data: avail } = useQuery({ queryKey: ['mail', 'available'], queryFn: api.mailAvailable });
  const [folder, setFolder] = useState<MailFolder>('inbox');
  const [selected, setSelected] = useState<number | null>(null);
  // /mail?an=… (z. B. aus den Kontakten) öffnet gleich eine neue Mail
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Partial<DraftForm> | null>(() => (params.get('an') ? { to: `${params.get('an')}, ` } : null));
  useEffect(() => {
    if (params.has('an')) setParams({}, { replace: true });
  }, [params, setParams]);
  const [keysOpen, setKeysOpen] = useState(false);
  const { data: list } = useQuery({ queryKey: ['mail', 'messages', folder], queryFn: () => api.mailMessages(folder), enabled: !!avail?.available });

  if (!avail) return <Loading />;
  if (!avail.available)
    return (
      <>
        <PageHeader title="E-Mail" />
        <EmptyState icon={<AtSign size={32} />} title="Kein Postfach eingerichtet">
          {admin ? (
            <>
              Unter <Link to="/einstellungen#mail">Einstellungen → E-Mail</Link> ein Postfach für den ELW beantragen.
            </>
          ) : (
            'Ein Admin kann in den Einstellungen ein Postfach für den ELW beantragen.'
          )}
        </EmptyState>
      </>
    );

  return (
    <>
      <PageHeader
        title="E-Mail"
        subtitle={<span className="mono">{avail.address}</span>}
        actions={
          <>
            <button className="btn" onClick={() => setKeysOpen(true)}>
              <KeyRound size={16} /> Schlüssel
            </button>
            <button className="btn btn-primary" onClick={() => setDraft({})}>
              <PenSquare size={16} /> Neue Mail
            </button>
          </>
        }
      />
      <div className="mail-layout">
        <Card className="mail-list-card">
          <Segmented
            label="Ordner"
            value={folder}
            onChange={(f) => (setFolder(f), setSelected(null))}
            options={[
              { value: 'inbox', label: `Eingang${list && list.unread ? ` (${list.unread})` : ''}` },
              { value: 'sent', label: 'Gesendet' },
            ]}
          />
          {!list ? (
            <Loading />
          ) : list.items.length === 0 ? (
            <p className="muted">{folder === 'inbox' ? 'Keine Mails.' : 'Noch nichts gesendet.'}</p>
          ) : (
            <ul className="mail-list">
              {list.items.map((m) => (
                <li key={m.id}>
                  <button className={`mail-item ${m.id === selected ? 'active' : ''} ${m.seen ? '' : 'unread'}`} onClick={() => setSelected(m.id)}>
                    <span className="mail-item-top">
                      <span className="mail-item-from">{folder === 'inbox' ? m.from : `An ${m.to.join(', ')}`}</span>
                      <span className="mail-item-date muted">{fmtDateTime(m.date)}</span>
                    </span>
                    <span className="mail-item-subject">
                      {m.encryption === 'e2e' ? <Lock size={14} aria-label="verschlüsselt" className="tone-ok" /> : <LockOpen size={14} aria-label="unverschlüsselt" className="muted" />}
                      {m.attachments > 0 && <Paperclip size={14} aria-label={`${m.attachments} Anhänge`} />}
                      {m.subject || '(ohne Betreff)'}
                    </span>
                    <span className="mail-item-snippet muted">{m.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="mail-reader-pane">
          {selected ? (
            <Reader id={selected} onReply={setDraft} onDeleted={() => setSelected(null)} ownAddress={avail.address ?? ''} />
          ) : (
            <EmptyState icon={<Mail size={32} />} title="Keine Mail ausgewählt" />
          )}
        </div>
      </div>
      <Modal open={draft !== null} title="Neue Mail" onClose={() => setDraft(null)} wide>
        {draft && <Composer initial={draft} onDone={() => setDraft(null)} />}
      </Modal>
      <Modal open={keysOpen} title="Schlüssel der Gegenstellen" onClose={() => setKeysOpen(false)} wide>
        <Keys />
      </Modal>
    </>
  );
}

function Reader({ id, onReply, onDeleted, ownAddress }: { id: number; onReply: (d: Partial<DraftForm>) => void; onDeleted: () => void; ownAddress: string }) {
  const toast = useToast();
  const { data: m } = useQuery({ queryKey: ['mail', 'message', id], queryFn: () => api.mailMessage(id) });
  const [showHtml, setShowHtml] = useState(false);
  const seen = useMutation({ mutationFn: (v: boolean) => api.setMailSeen(id, v) });
  const remove = useMutation({ mutationFn: () => api.removeMail(id), onSuccess: onDeleted, onError: (e) => toast('error', e.message) });

  useEffect(() => {
    setShowHtml(false);
  }, [id]);
  useEffect(() => {
    if (m && !m.seen && m.folder === 'inbox') seen.mutate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.id]);

  if (!m) return <Loading />;
  const enc = ENCRYPTION[m.encryption];
  const sig = m.signature !== 'none' ? SIGNATURE[m.signature] : null;
  const reply = (all: boolean) => {
    const to = m.folder === 'inbox' ? [m.replyTo ? bareAddress(m.replyTo) : m.fromAddress] : m.to.map(bareAddress);
    const cc = all ? [...m.to, ...m.cc].map(bareAddress).filter((a) => a !== ownAddress && !to.includes(a)) : [];
    const quoted = m.text
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n');
    onReply({
      to: to.join(', '),
      cc: cc.join(', '),
      subject: /^(re|aw):/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
      text: `\n\nAm ${fmtDateTime(m.date)} schrieb ${m.from}:\n${quoted}`,
      replyToId: m.id,
    });
  };

  return (
    <Card
      title={m.subject || '(ohne Betreff)'}
      actions={
        <span className="btn-row">
          <button className="btn btn-ghost btn-icon" title="Antworten" aria-label="Antworten" onClick={() => reply(false)}>
            <Reply size={18} />
          </button>
          <button className="btn btn-ghost btn-icon" title="Allen antworten" aria-label="Allen antworten" onClick={() => reply(true)}>
            <ReplyAll size={18} />
          </button>
          {m.folder === 'inbox' && (
            <button className="btn btn-ghost btn-icon" title="Als ungelesen markieren" aria-label="Als ungelesen markieren" onClick={() => seen.mutate(false)}>
              <MailOpen size={18} />
            </button>
          )}
          <a className="btn btn-ghost btn-icon" href={`/api/mail/messages/${m.id}/raw`} title="Als .eml speichern" aria-label="Als .eml speichern">
            <Download size={18} />
          </a>
          <button className="btn btn-ghost btn-icon" title="Löschen" aria-label="Löschen" onClick={() => window.confirm('Mail löschen?') && remove.mutate()}>
            <Trash2 size={18} />
          </button>
        </span>
      }
    >
      <dl className="kv">
        <dt>Von</dt>
        <dd>{m.from}</dd>
        <dt>An</dt>
        <dd>{m.to.join(', ')}</dd>
        {m.cc.length > 0 && (
          <>
            <dt>Kopie</dt>
            <dd>{m.cc.join(', ')}</dd>
          </>
        )}
        <dt>Datum</dt>
        <dd>{fmtDateTime(m.date)}</dd>
      </dl>
      <p className="mail-badges">
        <span title={enc.title}>
          <Badge tone={enc.tone}>
            {m.encryption === 'e2e' ? <Lock size={12} /> : <LockOpen size={12} />} {enc.label}
          </Badge>
        </span>
        {sig && (
          <Badge tone={sig.tone}>
            {m.signature === 'valid' ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />} {sig.label}
          </Badge>
        )}
      </p>
      {m.html && (
        <Segmented
          label="Darstellung"
          value={showHtml ? 'html' : 'text'}
          onChange={(v) => setShowHtml(v === 'html')}
          options={[
            { value: 'text', label: 'Text' },
            { value: 'html', label: 'HTML (ohne externe Inhalte)' },
          ]}
        />
      )}
      {showHtml && m.html ? <HtmlBody html={m.html} /> : <div className="mail-body">{m.text || <span className="muted">(kein Text)</span>}</div>}
      {m.attachments.length > 0 && (
        <ul className="mail-attachments">
          {m.attachments.map((a) => (
            <li key={a.id}>
              <a href={`/api/mail/attachments/${a.id}`}>
                <Paperclip size={14} /> {a.filename}
              </a>{' '}
              <span className="muted">{fmtBytes(a.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** HTML-Mail in einer Sandbox ohne Skripte und ohne Nachladen (keine Zählpixel) */
function HtmlBody({ html }: { html: string }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'"><base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:8px;background:#fff;color:#111}</style></head><body>${html}</body></html>`;
  return <iframe className="mail-html" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} title="HTML-Inhalt der Mail" />;
}

interface DraftForm {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  replyToId?: number;
}

function Composer({ initial, onDone }: { initial: Partial<DraftForm>; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<DraftForm>({ to: '', cc: '', bcc: '', subject: '', text: '', ...initial });
  const [files, setFiles] = useState<File[]>([]);
  const [allowUnencrypted, setAllowUnencrypted] = useState(false);
  const all = useMemo(() => [...new Set([form.to, form.cc, form.bcc].flatMap(splitAddresses).map((a) => a.toLowerCase()))], [form.to, form.cc, form.bcc]);
  const [debounced, setDebounced] = useState(all);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(all), 600);
    return () => clearTimeout(t);
  }, [all]);
  const valid = debounced.filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
  const { data: keys } = useQuery({ queryKey: ['mail', 'recipients', valid.join(',')], queryFn: () => api.mailRecipients(valid), enabled: valid.length > 0 });
  const missing = (keys ?? []).filter((k) => !k.encrypt);
  const size = files.reduce((n, f) => n + f.size, 0);

  const send = useMutation({
    mutationFn: async () => {
      const attachments = await Promise.all(
        files.map(async (f) => ({ filename: f.name, contentType: f.type || 'application/octet-stream', data: await toBase64(f) })),
      );
      const draft: MailDraft = {
        to: splitAddresses(form.to),
        cc: splitAddresses(form.cc),
        bcc: splitAddresses(form.bcc),
        subject: form.subject,
        text: form.text,
        attachments,
        replyToId: form.replyToId,
        allowUnencrypted,
      };
      return api.sendMail(draft);
    },
    onSuccess: (r) => {
      toast('success', r.encrypted ? 'Verschlüsselt gesendet' : 'Unverschlüsselt gesendet');
      void qc.invalidateQueries({ queryKey: ['mail'] });
      onDone();
    },
    onError: (e) => toast('error', e.message),
  });
  const change = (patch: Partial<DraftForm>) => setForm({ ...form, ...patch });
  const ready = splitAddresses(form.to).length > 0 && size <= MAIL_MAX_ATTACHMENT_BYTES && (missing.length === 0 || allowUnencrypted) && !!keys;

  return (
    <div className="stack">
      <div className="form-grid">
        <Field label="An" hint="Mehrere Adressen durch Komma trennen">
          <AddressInput value={form.to} onChange={(to) => change({ to })} autoFocus={!form.to} />
        </Field>
        <Field label="Kopie (Cc)">
          <AddressInput value={form.cc} onChange={(cc) => change({ cc })} />
        </Field>
        <Field label="Blindkopie (Bcc)">
          <AddressInput value={form.bcc} onChange={(bcc) => change({ bcc })} />
        </Field>
        <Field label="Betreff">
          <input value={form.subject} onChange={(e) => change({ subject: e.target.value })} maxLength={998} />
        </Field>
      </div>
      {keys && keys.length > 0 && (
        <p className="mail-badges">
          {keys.map((k) => (
            <span key={k.address} title={k.encrypt ? `Schlüssel ${k.fingerprint ?? ''} (${k.source ?? 'eigen'})` : 'Kein Schlüssel gefunden'}>
              <Badge tone={k.encrypt ? 'ok' : 'warn'}>
                {k.encrypt ? <Lock size={12} /> : <LockOpen size={12} />} {k.address}
              </Badge>
            </span>
          ))}
        </p>
      )}
      {missing.length > 0 && (
        <div className="mail-warning">
          <p>
            <strong>Nicht verschlüsselt:</strong> Für {missing.map((k) => k.address).join(', ')} ist kein Schlüssel bekannt (weder per Autocrypt noch im Web Key Directory). Die
            Mail ginge dann an alle Empfänger unverschlüsselt (nur signiert).
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={allowUnencrypted} onChange={(e) => setAllowUnencrypted(e.target.checked)} /> Trotzdem unverschlüsselt senden
          </label>
        </div>
      )}
      <Field label="Nachricht">
        <textarea rows={12} value={form.text} onChange={(e) => change({ text: e.target.value })} autoFocus={!!form.to} />
      </Field>
      <Field label="Anhänge" hint={`Zusammen höchstens ${fmtBytes(MAIL_MAX_ATTACHMENT_BYTES)}`}>
        <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </Field>
      {size > MAIL_MAX_ATTACHMENT_BYTES && <p className="tone-alarm">Anhänge zu groß ({fmtBytes(size)}).</p>}
      <div className="form-actions">
        <button className="btn" onClick={onDone}>
          Verwerfen
        </button>
        <button className="btn btn-primary" disabled={!ready || send.isPending} onClick={() => send.mutate()}>
          {missing.length === 0 ? <Lock size={16} /> : <LockOpen size={16} />} {send.isPending ? 'Sende …' : missing.length === 0 ? 'Verschlüsselt senden' : 'Unverschlüsselt senden'}
        </button>
      </div>
    </div>
  );
}

function toBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error(`${f.name} nicht lesbar`));
    r.readAsDataURL(f);
  });
}

function Keys() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['mail', 'keys'], queryFn: api.mailKeys });
  const [armored, setArmored] = useState('');
  const add = useMutation({
    mutationFn: () => api.importMailKey(armored),
    onSuccess: (r: MailRecipientKey[]) => (setArmored(''), toast('success', `Schlüssel für ${r.map((k) => k.address).join(', ')} importiert`)),
    onError: (e) => toast('error', e.message),
  });
  const remove = useMutation({ mutationFn: api.removeMailKey, onError: (e) => toast('error', e.message) });
  const SOURCE: Record<string, string> = { autocrypt: 'aus Mail gelernt (Autocrypt)', wkd: 'Web Key Directory', manual: 'importiert' };

  return (
    <div className="stack">
      <p className="muted">
        An diese Adressen verschlüsselt ELVIS automatisch. Schlüssel lernt ELVIS aus eingehenden Mails (Autocrypt) und sucht sie im Web Key Directory der Empfängerdomain. Fehlt
        einer, lässt er sich hier importieren – den Fingerprint am besten telefonisch abgleichen.
      </p>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <p className="muted">Noch keine Schlüssel bekannt.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Adresse</th>
                <th>Fingerprint</th>
                <th>Herkunft</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((k) => (
                <tr key={k.address}>
                  <td>{k.address}</td>
                  <td className="mono">{k.fingerprint?.replace(/(.{4})/g, '$1 ').trim()}</td>
                  <td>{k.source ? SOURCE[k.source] : ''}</td>
                  <td>
                    <button className="btn btn-ghost btn-icon" aria-label="Schlüssel entfernen" onClick={() => window.confirm(`Schlüssel für ${k.address} entfernen?`) && remove.mutate(k.address)}>
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Field label="Öffentlichen Schlüssel importieren" hint="-----BEGIN PGP PUBLIC KEY BLOCK----- …">
        <textarea rows={6} className="mono" value={armored} onChange={(e) => setArmored(e.target.value)} />
      </Field>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={armored.length < 100 || add.isPending} onClick={() => add.mutate()}>
          Importieren
        </button>
      </div>
    </div>
  );
}

