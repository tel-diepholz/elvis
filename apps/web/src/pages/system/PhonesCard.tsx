import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Eye, EyeOff, Pencil, Plus, Power, RefreshCw, Send, Trash2 } from 'lucide-react';
import { PHONE_MODEL, PHONE_MODELS, phoneConfigSchema, phoneInputSchema, type Phone, type PhoneConfig, type PhoneInput, type PhoneKeySlot, type PhoneModel } from '@elvis/shared';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Card, Field, Loading, Modal } from '../../components/ui';
import { KeyEditor, KeyGrid } from '../../components/phones/PhoneKeys';
import { PhoneStatus } from '../PhonesPage';
import { copyText } from '../DockerHostsPage';

const EMPTY: PhoneInput = { name: '', mac: '', model: 'd385', extension: '', displayName: '', authUser: '', sipPassword: '' };

function PhoneForm({ phone, onClose }: { phone: Phone | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState<PhoneInput>(() => (phone ? { name: phone.name, mac: phone.mac, model: phone.model, extension: phone.extension, displayName: phone.displayName, authUser: phone.authUser, sipPassword: '' } : EMPTY));
  const set = (patch: Partial<PhoneInput>) => setF((x) => ({ ...x, ...patch }));
  const result = phoneInputSchema.safeParse(f);
  const save = useMutation({
    mutationFn: () => (phone ? api.updatePhone(phone.id, f) : api.createPhone(f)),
    onSuccess: () => (void qc.invalidateQueries({ queryKey: ['phones'] }), toast('success', phone ? 'Telefon gespeichert' : 'Telefon angelegt'), onClose()),
    onError: (e) => toast('error', e.message),
  });
  const submit = (e: FormEvent) => (e.preventDefault(), result.success && save.mutate());

  return (
    <Modal open title={phone ? `Telefon „${phone.name}“` : 'Telefon hinzufügen'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Name *">
            <input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} required autoFocus placeholder="z. B. Lagetisch" />
          </Field>
          <Field label="Modell">
            <select value={f.model} onChange={(e) => set({ model: e.target.value as PhoneModel })}>
              {PHONE_MODELS.map((m) => (
                <option key={m} value={m}>
                  {PHONE_MODEL[m].label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="MAC-Adresse *" hint="Auf dem Typenschild unter dem Telefon">
            <input value={f.mac} onChange={(e) => set({ mac: e.target.value })} maxLength={17} required className="mono" placeholder="00:04:13:…" />
          </Field>
          <Field label="Nebenstelle *">
            <input value={f.extension} onChange={(e) => set({ extension: e.target.value })} maxLength={20} required inputMode="tel" />
          </Field>
          <Field label="Anzeigename" hint="Leer = Name">
            <input value={f.displayName} onChange={(e) => set({ displayName: e.target.value })} maxLength={60} />
          </Field>
          <Field label="Anmeldename" hint="An der Telefonanlage, leer = Nebenstelle">
            <input value={f.authUser} onChange={(e) => set({ authUser: e.target.value })} maxLength={60} autoComplete="off" />
          </Field>
          <Field label="SIP-Passwort" hint={phone?.hasPassword ? 'Leer = unverändert' : undefined}>
            <input type="password" value={f.sipPassword} onChange={(e) => set({ sipPassword: e.target.value })} maxLength={100} autoComplete="new-password" />
          </Field>
        </div>
        {!result.success && f.mac !== '' && <p className="tone-warn">{result.error.issues[0]?.message}</p>}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="btn btn-primary" disabled={!result.success || save.isPending}>
            Speichern
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfigForm({ config }: { config: PhoneConfig }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [f, setF] = useState(config);
  useEffect(() => setF(config), [config]);
  const set = (patch: Partial<PhoneConfig>) => setF((x) => ({ ...x, ...patch }));
  const result = phoneConfigSchema.safeParse(f);
  const save = useMutation({
    mutationFn: () => api.setPhoneConfig(f),
    onSuccess: (s) => (qc.setQueryData(['phones', 'system'], s), toast('success', 'Gespeichert – die Telefone übernehmen es beim nächsten Abruf (oder Neustart)')),
    onError: (e) => toast('error', e.message),
  });
  const dirty = JSON.stringify(f) !== JSON.stringify(config);
  return (
    <form className="form" onSubmit={(e) => (e.preventDefault(), result.success && save.mutate())}>
      <div className="form-grid">
        <Field label="SIP-Server (Telefonanlage)" hint="IP oder Name, optional mit Port">
          <input value={f.registrar} onChange={(e) => set({ registrar: e.target.value })} maxLength={120} placeholder="192.168.1.10" />
        </Field>
        <Field label="Outbound-Proxy" hint="Meist leer">
          <input value={f.outboundProxy} onChange={(e) => set({ outboundProxy: e.target.value })} maxLength={120} />
        </Field>
        <Field label="Heranholen (BLF)" hint="Kennziffer der Anlage, z. B. *8 – leer = ohne">
          <input value={f.pickupPrefix} onChange={(e) => set({ pickupPrefix: e.target.value })} maxLength={10} />
        </Field>
        <Field label="Zeitserver (NTP)">
          <input value={f.ntpServer} onChange={(e) => set({ ntpServer: e.target.value })} maxLength={120} />
        </Field>
      </div>
      {!result.success && <p className="tone-warn">{result.error.issues[0]?.message}</p>}
      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={!dirty || !result.success || save.isPending}>
          Speichern
        </button>
      </div>
    </form>
  );
}

function TemplateEditor({ phones }: { phones: Phone[] }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: slots } = useQuery({ queryKey: ['phones', 'template'], queryFn: api.phoneTemplate });
  const [editing, setEditing] = useState<PhoneKeySlot | null>(null);
  const done = (s: PhoneKeySlot[]) => (qc.setQueryData(['phones', 'template'], s), void qc.invalidateQueries({ queryKey: ['phones'] }), setEditing(null));
  const save = useMutation({ mutationFn: ({ idx, key }: { idx: number; key: Parameters<typeof api.setPhoneTemplateKey>[1] }) => api.setPhoneTemplateKey(idx, key), onSuccess: done, onError: (e) => toast('error', e.message) });
  const clear = useMutation({ mutationFn: api.clearPhoneTemplateKey, onSuccess: done, onError: (e) => toast('error', e.message) });
  if (!slots) return <Loading />;
  return (
    <>
      <KeyGrid slots={slots} perPage={PHONE_MODEL.d385.keysPerPage} onSelect={setEditing} showSource={false} />
      {editing && (
        <KeyEditor
          slot={editing}
          layer={editing.template}
          title={`Vorlage: Taste ${editing.idx + 1}`}
          phones={phones}
          pending={save.isPending || clear.isPending}
          onClear={editing.template ? () => clear.mutate(editing.idx) : undefined}
          onSave={(key) => save.mutate({ idx: editing.idx, key })}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** Tischtelefone (Snom): Einstellungen, Provisionierungs-URL, Telefone und Tastenvorlage. Nur Admins. */
export function PhonesCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: system } = useQuery({ queryKey: ['phones', 'system'], queryFn: api.phoneSystem });
  const { data: phones } = useQuery({ queryKey: ['phones'], queryFn: api.phones });
  const [form, setForm] = useState<Phone | 'new' | null>(null);
  const [showPass, setShowPass] = useState(false);
  const regenerate = useMutation({
    mutationFn: api.regeneratePhoneToken,
    onSuccess: (s) => (qc.setQueryData(['phones', 'system'], s), toast('success', 'Neue Provisionierungs-URL erzeugt – an den Telefonen bzw. im DHCP eintragen')),
    onError: (e) => toast('error', e.message),
  });
  const push = useMutation({ mutationFn: api.pushPhone, onSuccess: (p) => toast(p.push?.state === 'ok' ? 'success' : 'error', p.push?.state === 'ok' ? 'Tasten übertragen' : `Nicht übertragen: ${p.push?.error ?? ''}`), onError: (e) => toast('error', e.message) });
  const reboot = useMutation({ mutationFn: api.rebootPhone, onSuccess: () => toast('success', 'Telefon startet neu'), onError: (e) => toast('error', e.message) });
  const remove = useMutation({ mutationFn: api.removePhone, onSuccess: () => void qc.invalidateQueries({ queryKey: ['phones'] }), onError: (e) => toast('error', e.message) });

  if (!system || !phones) return <Loading />;
  const url = `${location.origin}/api/provisioning/${system.token}/snom/{mac}.xml`;
  const copy = async (text: string) => {
    const ok = await copyText(text);
    toast(ok ? 'success' : 'error', ok ? 'Kopiert' : 'Kopieren nicht möglich');
  };

  return (
    <>
      <Card title="Telefonanlage" className="span-3">
        <ConfigForm config={system.config} />
      </Card>

      <Card title="Provisionierung" className="span-3">
        <p className="muted">
          Die Telefone holen SIP-Konto, Telefonbuch (Kontakte, Taste <em>Verzeichnis</em>) und Funktionstasten von ELVIS. Die URL im DHCP-Server als Option 66 eintragen
          oder einmalig am Telefon unter <em>Einstellungen → Erweitert → Aktualisieren → Einstellungs-URL</em>. <code>{'{mac}'}</code> setzt das Telefon selbst ein. Danach
          überträgt ELVIS geänderte Tasten sofort; zusätzlich fragt jedes Telefon stündlich nach. Die URL enthält einen geheimen Schlüssel und die SIP-Passwörter – nicht
          weitergeben.
        </p>
        <div className="form-actions spread">
          <code style={{ wordBreak: 'break-all' }}>{url}</code>
          <button type="button" className="btn btn-icon" aria-label="Provisionierungs-URL kopieren" onClick={() => void copy(url)}>
            <Copy size={16} />
          </button>
        </div>
        <dl className="kv">
          <dt>Weboberfläche der Telefone</dt>
          <dd>
            Benutzer <code>{system.adminUser}</code>, Passwort <code>{showPass ? system.adminPassword : '••••••••'}</code>{' '}
            <button type="button" className="btn btn-ghost btn-icon" aria-label={showPass ? 'Passwort verbergen' : 'Passwort zeigen'} onClick={() => setShowPass((x) => !x)}>
              {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </dd>
        </dl>
        <div className="form-actions">
          <button
            type="button"
            className="btn"
            disabled={regenerate.isPending}
            onClick={() => window.confirm('Neue URL erzeugen? Die bisherige URL funktioniert danach nicht mehr.') && regenerate.mutate()}
          >
            <RefreshCw size={16} /> Neue URL erzeugen
          </button>
        </div>
      </Card>

      <Card
        title="Telefone"
        className="span-3"
        actions={
          <button type="button" className="btn btn-sm" onClick={() => setForm('new')}>
            <Plus size={16} /> Telefon hinzufügen
          </button>
        }
      >
        {phones.length === 0 ? (
          <p className="muted">Noch keine Telefone. Mit der MAC-Adresse anlegen – das Telefon bekommt seine Konfiguration beim nächsten Start.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Nebenstelle</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {phones.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-title">{p.name}</div>
                      <div className="cell-sub mono">
                        {PHONE_MODEL[p.model].label} · {p.mac}
                        {p.lastIp && ` · ${p.lastIp}`}
                        {p.firmware && ` · ${p.firmware}`}
                      </div>
                    </td>
                    <td>{p.extension}</td>
                    <td>
                      <PhoneStatus phone={p} />
                    </td>
                    <td>
                      <span className="btn-row">
                        <button type="button" className="btn btn-icon" title="Tasten jetzt übertragen" aria-label={`Tasten an ${p.name} übertragen`} disabled={!p.lastIp || push.isPending} onClick={() => push.mutate(p.id)}>
                          <Send size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          title="Neu starten (lädt die Konfiguration neu)"
                          aria-label={`${p.name} neu starten`}
                          disabled={!p.lastIp || reboot.isPending}
                          onClick={() => window.confirm(`„${p.name}“ neu starten? Ein laufendes Gespräch bricht ab.`) && reboot.mutate(p.id)}
                        >
                          <Power size={16} />
                        </button>
                        <button type="button" className="btn btn-icon" aria-label={`${p.name} bearbeiten`} onClick={() => setForm(p)}>
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`${p.name} entfernen`}
                          disabled={remove.isPending}
                          onClick={() => window.confirm(`Telefon „${p.name}“ entfernen? Es bekommt danach keine Konfiguration mehr von ELVIS.`) && remove.mutate(p.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Tastenvorlage" className="span-3">
        <p className="muted">
          Gilt für alle Telefone, soweit deren Grundbelegung eine Taste nicht selbst belegt. Die Grundbelegung je Telefon steht unter <em>Fahrzeug → Telefone</em>; dort
          dürfen im laufenden Einsatz alle Angemeldeten Tasten ändern – mit dem Einsatzende gilt wieder die Grundbelegung.
        </p>
        <TemplateEditor phones={phones} />
      </Card>

      {form && <PhoneForm phone={form === 'new' ? null : form} onClose={() => setForm(null)} />}
    </>
  );
}
