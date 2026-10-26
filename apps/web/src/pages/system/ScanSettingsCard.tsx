import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ScanLine } from 'lucide-react';
import { DOCUMENT_PLACEHOLDERS, scanSettingsInputSchema, type ScanSettingsInput } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Toggle } from '../../components/ui';

type Form = Omit<ScanSettingsInput, 'allowedHosts'> & { allowedHosts: string };

/** Eingang (SMTP für „Scan an E-Mail“): Annahme, Ablage im Einsatz, Absender und Anmeldung. Nur Admins. */
export function ScanSettingsCard() {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['scans', 'system'], queryFn: api.scanSettings });
  const { data: inbox } = useQuery({ queryKey: ['scans'], queryFn: api.scans });
  const [form, setForm] = useState<Form | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data && !dirty)
      setForm({
        enabled: data.enabled,
        archive: data.archive,
        folderPath: data.folderPath,
        allowedHosts: data.allowedHosts.join(', '),
        username: data.username,
        password: undefined,
        retentionDays: data.retentionDays,
      });
  }, [data, dirty]);

  const input = (f: Form): ScanSettingsInput => ({
    ...f,
    allowedHosts: f.allowedHosts
      .split(/[\s,;]+/)
      .map((h) => h.trim())
      .filter(Boolean),
    // Ohne Eingabe bleibt das gespeicherte Passwort
    password: f.username && !f.password && data?.passwordSet ? undefined : (f.password ?? ''),
  });

  const save = useMutation({
    mutationFn: () => api.saveScanSettings(input(form!)),
    onSuccess: () => (setDirty(false), toast('success', 'Scan-Einstellungen gespeichert')),
    onError: (e) => toast('error', e.message),
  });

  if (!data || !form) return <Loading />;
  const change = (patch: Partial<Form>) => (setForm({ ...form, ...patch }), setDirty(true));
  const valid = scanSettingsInputSchema.safeParse(input(form));
  const status = inbox?.status;
  const host = window.location.hostname;

  return (
    <Card
      title="Scannen"
      icon={<ScanLine size={18} />}
      className="span-2"
      actions={
        status && (
          <Badge tone={status.listening && status.enabled ? 'ok' : 'alarm'}>
            {!status.listening ? 'Empfänger aus' : status.enabled ? `SMTP-Port ${status.port}` : 'abgeschaltet'}
          </Badge>
        )
      }
    >
      <p className="muted">
        Multifunktionsgeräte schicken Scans per <em>Scan an E-Mail</em> an ELVIS. Jeder Scan erscheint im <em>Posteingang</em>; läuft ein Einsatz, wird er
        zusätzlich in dessen Dokumenten abgelegt.
        {status?.lastReceivedAt && ` Letzter Scan: ${fmtDateTime(status.lastReceivedAt)}.`}
      </p>
      {status?.error && <p className="tone-alarm">Empfänger nicht gestartet: {status.error}</p>}
      {status && !status.listening && !status.error && <p className="tone-alarm">Der SMTP-Empfänger ist in der Serverkonfiguration abgeschaltet (scan.smtpPort).</p>}

      <Toggle label="Scans annehmen" checked={form.enabled} onChange={(v) => change({ enabled: v })} />
      <Toggle label="Scans im laufenden Einsatz ablegen" checked={form.archive} onChange={(v) => change({ archive: v })} />
      <div className="form-grid">
        <Field label="Ablageort im Einsatz" hint="Leer = oberste Ebene. Fehlende Ordner werden angelegt.">
          <input value={form.folderPath} onChange={(e) => change({ folderPath: e.target.value })} maxLength={200} placeholder="Scans/{{datum.iso}}" disabled={!form.archive} />
        </Field>
        <Field label="Aufbewahrung im Posteingang (Tage)" hint="Danach werden Scans aus dem Posteingang gelöscht; abgelegte Dokumente bleiben.">
          <input type="number" min={1} max={365} value={form.retentionDays} onChange={(e) => change({ retentionDays: Number(e.target.value) })} />
        </Field>
        <Field label="Erlaubte Geräte (IP-Adressen)" hint="Leer = alle Geräte im Netz. Mehrere durch Komma trennen.">
          <input value={form.allowedHosts} onChange={(e) => change({ allowedHosts: e.target.value })} placeholder="z. B. 192.168.10.20" />
        </Field>
        <Field label="SMTP-Benutzername" hint="Leer = ohne Anmeldung">
          <input value={form.username} onChange={(e) => change({ username: e.target.value })} maxLength={80} autoComplete="off" />
        </Field>
        <Field label="SMTP-Passwort">
          <input
            type="password"
            value={form.password ?? ''}
            onChange={(e) => change({ password: e.target.value })}
            maxLength={200}
            autoComplete="new-password"
            disabled={!form.username}
            placeholder={data.passwordSet && form.username ? 'unverändert' : ''}
          />
        </Field>
      </div>
      {form.archive && (
        <p className="muted">
          Platzhalter:{' '}
          {DOCUMENT_PLACEHOLDERS.filter((p) => p.inPath).map((p, i) => (
            <span key={p.key}>
              {i > 0 && ', '}
              <code title={p.label}>{`{{${p.key}}}`}</code>
            </span>
          ))}
        </p>
      )}
      {!valid.success && <p className="tone-alarm">{valid.error.issues[0]?.message}</p>}
      <div className="form-actions spread">
        <span className="muted">{data.updatedAt ? `Zuletzt geändert ${fmtDateTime(data.updatedAt)} von ${data.updatedBy}` : 'Vorgaben'}</span>
        <span className="btn-row">
          <button className="btn" disabled={!dirty} onClick={() => setDirty(false)}>
            Verwerfen
          </button>
          <button className="btn btn-primary" disabled={!dirty || !valid.success || save.isPending} onClick={() => save.mutate()}>
            Speichern
          </button>
        </span>
      </div>

      <h3 className="section-title">Einrichtung am HP-Drucker (z. B. Color LaserJet Pro MFP 3302)</h3>
      <ol className="muted">
        <li>
          Im Browser die Drucker-Adresse öffnen (Embedded Web Server) → <em>Scannen</em> → <em>Scan an E-Mail</em> → <em>Ausgehende E-Mail-Profile</em> →
          neues Profil.
        </li>
        <li>
          SMTP-Server <code>{host}</code>, Port <code>{status?.port ?? 2525}</code>, <em>SSL/TLS</em> aus.{' '}
          {form.username ? (
            <>
              Authentifizierung an, Benutzer <code>{form.username}</code> und das Passwort von oben.
            </>
          ) : (
            'Keine Authentifizierung.'
          )}
        </li>
        <li>
          Absender z. B. <code>scanner@elvis</code>; im Adressbuch einen Empfänger wie <code>scan@elvis</code> anlegen (die Adresse selbst ist beliebig).
        </li>
        <li>
          Dateityp <em>PDF</em> wählen. Am Gerät dann <em>Scannen → E-Mail</em> mit diesem Profil – der Scan erscheint sofort im Posteingang.
        </li>
      </ol>
    </Card>
  );
}
