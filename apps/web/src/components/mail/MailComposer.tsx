import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen } from 'lucide-react';
import { MAIL_MAX_ATTACHMENT_BYTES, type MailDraft } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtBytes } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Field } from '../ui';
import { AddressInput } from './AddressInput';

const splitAddresses = (v: string) =>
  v
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter(Boolean);

export interface DraftForm {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  replyToId?: number;
}

/** Neue Mail mit Schlüsselprüfung je Empfänger; ohne Schlüssel nur nach ausdrücklicher Bestätigung unverschlüsselt */
export function MailComposer({ initial, onDone, onSent }: { initial: Partial<DraftForm>; onDone: () => void; onSent?: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<DraftForm>({ to: '', cc: '', bcc: '', subject: '', text: '', ...initial });
  const [files, setFiles] = useState<File[]>([]);
  const [allowUnencrypted, setAllowUnencrypted] = useState(false);
  // Cc/Bcc erst auf Wunsch einblenden (bei „Allen antworten“ ist Cc schon gefüllt)
  const [showCc, setShowCc] = useState(!!initial.cc);
  const [showBcc, setShowBcc] = useState(!!initial.bcc);
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
      onSent?.();
      onDone();
    },
    onError: (e) => toast('error', e.message),
  });
  const change = (patch: Partial<DraftForm>) => setForm({ ...form, ...patch });
  const ready = splitAddresses(form.to).length > 0 && size <= MAIL_MAX_ATTACHMENT_BYTES && (missing.length === 0 || allowUnencrypted) && !!keys;

  return (
    <div className="stack">
      <div className="mail-to">
        <Field label="An" hint="Mehrere Adressen durch Komma trennen">
          <AddressInput value={form.to} onChange={(to) => change({ to })} autoFocus={!form.to} />
        </Field>
        <span className="mail-to-toggles">
          {!showCc && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowCc(true)}>
              Cc
            </button>
          )}
          {!showBcc && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowBcc(true)}>
              Bcc
            </button>
          )}
        </span>
      </div>
      {showCc && (
        <Field label="Kopie (Cc)">
          <AddressInput value={form.cc} onChange={(cc) => change({ cc })} autoFocus={!initial.cc} />
        </Field>
      )}
      {showBcc && (
        <Field label="Blindkopie (Bcc)">
          <AddressInput value={form.bcc} onChange={(bcc) => change({ bcc })} autoFocus />
        </Field>
      )}
      <Field label="Betreff">
        <input value={form.subject} onChange={(e) => change({ subject: e.target.value })} maxLength={998} />
      </Field>
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
      <Field label="Nachricht">
        <textarea rows={8} value={form.text} onChange={(e) => change({ text: e.target.value })} autoFocus={!!form.to} />
      </Field>
      <Field label="Anhänge" hint={`Zusammen höchstens ${fmtBytes(MAIL_MAX_ATTACHMENT_BYTES)}`}>
        <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </Field>
      {size > MAIL_MAX_ATTACHMENT_BYTES && <p className="tone-alarm">Anhänge zu groß ({fmtBytes(size)}).</p>}
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
