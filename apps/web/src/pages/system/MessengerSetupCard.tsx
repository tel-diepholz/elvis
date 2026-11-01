import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, Copy, KeyRound, LogIn, LogOut, QrCode as QrIcon, Smartphone, X } from 'lucide-react';
import { copyText } from '../DockerHostsPage';
import { CHAT_CHANNEL_LABEL, type MessengerId, type MessengerSetupInput, type MessengerState } from '@elvis/shared';
import { api } from '../../lib/api';
import { useDevice } from '../../lib/live';
import { useToast } from '../../lib/toast';
import { Card, Field, Modal } from '../../components/ui';
import { DocView } from '../../components/docs/DocView';
import { MESSENGER_DOCS } from '../../components/docs/messengerDocs';
import { QrCode } from '../../components/WifiQr';
import { ChannelIcon } from '../../components/chat/ChannelIcon';

const STATUS_LABEL: Record<MessengerState['status'], string> = {
  connected: 'verbunden',
  connecting: 'verbindet …',
  setup: 'Einrichtung ausstehend',
  error: 'gestört',
  offline: 'aus',
};

function CopyButton({ text }: { text: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon btn-sm"
      aria-label="Kopieren"
      title="Kopieren"
      onClick={async () => {
        const ok = await copyText(text);
        toast(ok ? 'success' : 'error', ok ? 'Kopiert' : 'Kopieren nicht möglich');
      }}
    >
      <Copy size={14} />
    </button>
  );
}

/**
 * Einrichtung eines Messenger-Kontos (nur Admins): Signal koppeln (QR-Code) oder registrieren, Telegram anmelden
 * (Code, Passwort). Der Simulator braucht nichts.
 */
export function MessengerSetupCard({ id }: { id: MessengerId }) {
  const toast = useToast();
  const qc = useQueryClient();
  const device = useDevice(id);
  const state = device?.state as MessengerState | undefined;
  const step = state?.setup?.step ?? null;
  const hooked = device?.driver === 'cloud-api' || device?.driver === 'gateway-e2e';
  const { data: info } = useQuery({ queryKey: ['messengerSetup', id, step, device?.driver, state?.status], queryFn: () => api.messengerSetup(id), enabled: step === 'qr' || (hooked && !!device) });
  const run = useMutation({
    mutationFn: (input: MessengerSetupInput) => api.messengerSetupAction(id, input),
    onSuccess: (r) => (r.message && toast('success', r.message), void qc.invalidateQueries({ queryKey: ['messengerSetup', id] })),
    onError: (e) => toast('error', e.message),
  });
  const [number, setNumber] = useState('');
  const [captcha, setCaptcha] = useState('');
  const [voice, setVoice] = useState(false);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  /** Signal: gewählte Variante beim Einrichten (null = Auswahl zeigen) */
  const [variant, setVariant] = useState<'register' | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);

  if (!device || !state || device.driver === 'sim') return null;
  const label = CHAT_CHANNEL_LABEL[id];
  const submit = (e: FormEvent, input: MessengerSetupInput, reset?: () => void) => {
    e.preventDefault();
    run.mutate(input, { onSuccess: reset });
  };
  const cancel = (
    <button type="button" className="btn" disabled={run.isPending} onClick={() => (setVariant(null), run.mutate({ action: 'cancel' }))}>
      <X size={14} /> Abbrechen
    </button>
  );

  return (
    <Card
      title={`${label}-Konto`}
      icon={<ChannelIcon channel={id} size={18} />}
      className="span-3"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setDocsOpen(true)}>
          <BookOpen size={14} /> Anleitung
        </button>
      }
    >
      {/* Solange die Einrichtung nicht abgeschlossen ist: deutlicher Hinweis auf die Anleitung */}
      {state.status !== 'connected' && (
        <div className="banner banner-info setup-docs-hint">
          <BookOpen size={16} />
          <span>
            Noch nicht eingerichtet? Die <strong>Schritt-für-Schritt-Anleitung</strong> zeigt, was bei {label} anzulegen und hier einzutragen ist.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setDocsOpen(true)}>
            Anleitung öffnen
          </button>
        </div>
      )}
      <Modal open={docsOpen} title={`Anleitung: ${label}`} onClose={() => setDocsOpen(false)} wide>
        <DocView markdown={MESSENGER_DOCS[id].markdown} page={MESSENGER_DOCS[id].page} />
      </Modal>
      <dl className="kv">
        <dt>Zustand</dt>
        <dd className={state.status === 'connected' ? 'tone-ok' : state.status === 'error' ? 'tone-alarm' : undefined}>{STATUS_LABEL[state.status]}</dd>
        {state.account && (
          <>
            <dt>Konto</dt>
            <dd className="mono">{state.account}</dd>
          </>
        )}
        {state.link?.error && (
          <>
            <dt>Fehler</dt>
            <dd className="tone-alarm">{state.link.error}</dd>
          </>
        )}
      </dl>
      {/* Bei Signal steht der Hinweis im Kasten der jeweiligen Variante */}
      {state.setup && !(id === 'signal' && (step === 'start' || step === 'qr' || step === 'code')) && <p className="muted">{state.setup.hint}</p>}
      {state.setup?.error && <p className="tone-alarm">{state.setup.error}</p>}

      {info?.webhook && (
        <div className="stack">
          <p className="muted small">
            {id === 'whatsapp'
              ? 'Im Meta-Entwicklerportal unter WhatsApp → Konfiguration als Webhook eintragen (Rückruf-URL und Prüf-Token) und das Feld „messages“ abonnieren.'
              : 'Unter gateway.threema.ch bei der Gateway-ID als Rückruf-URL eintragen.'}{' '}
            Die Aufrufe gehen an das Cloud-Relay, ELVIS holt sie dort ab und prüft die Signatur.
          </p>
          <dl className="kv">
            <dt>Rückruf-URL</dt>
            <dd className="mono copyable">
              {info.webhook.url} <CopyButton text={info.webhook.url} />
            </dd>
            {info.webhook.verifyToken && (
              <>
                <dt>Prüf-Token</dt>
                <dd className="mono copyable">
                  {info.webhook.verifyToken} <CopyButton text={info.webhook.verifyToken} />
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      {step === 'start' && id === 'signal' && !variant && (
        <div className="stack">
          <p>Wie soll ELVIS bei Signal angemeldet werden? Bitte eine der beiden Varianten wählen.</p>
          <div className="setup-options">
            <section className="setup-option">
              <h3>
                <Smartphone size={18} /> Variante A: Mit einem Handy koppeln
              </h3>
              <p>ELVIS wird ein weiteres Gerät einer Signal-Nummer, die schon auf einem Handy läuft – wie Signal am PC.</p>
              <ul>
                <li>Kein Captcha, kein Bestätigungscode – nur einen QR-Code scannen</li>
                <li>Das Handy behält Signal und bleibt das Hauptgerät</li>
                <li className="tone-warn">Ist das Handy rund 30 Tage offline, trennt Signal die Kopplung</li>
              </ul>
              <div className="btn-row">
                <button className="btn btn-primary" disabled={run.isPending} onClick={() => run.mutate({ action: 'link' })}>
                  <QrIcon size={16} /> QR-Code anzeigen
                </button>
              </div>
            </section>
            <section className="setup-option">
              <h3>
                <KeyRound size={18} /> Variante B: Eigene Nummer registrieren
              </h3>
              <p>ELVIS bekommt eine eigene Signal-Nummer, z. B. die SIM im GSM-Gateway.</p>
              <ul>
                <li>Unabhängig von einem Handy</li>
                <li>Braucht ein Captcha und einen Bestätigungscode per SMS oder Anruf</li>
                <li className="tone-warn">Die Nummer lässt sich danach in keiner Signal-App auf einem Handy mehr nutzen</li>
              </ul>
              <div className="btn-row">
                <button className="btn" onClick={() => setVariant('register')}>
                  <KeyRound size={16} /> Nummer registrieren …
                </button>
              </div>
            </section>
          </div>
        </div>
      )}

      {step === 'start' && id === 'signal' && variant === 'register' && (
        <form className="stack setup-variant" onSubmit={(e) => submit(e, { action: 'register', number, ...(captcha && { captcha }), voice })}>
          <h3>
            <KeyRound size={18} /> Variante B: Eigene Nummer registrieren – Schritt 1 von 2
          </h3>
          <ol className="setup-steps">
            <li>
              Captcha lösen auf{' '}
              <a href="https://signalcaptchas.org/registration/generate.html" target="_blank" rel="noreferrer">
                signalcaptchas.org
              </a>
              . Danach den Link „Open Signal“ per Rechtsklick kopieren (beginnt mit <code>signalcaptcha://</code>). Er gilt nur wenige Minuten.
            </li>
            <li>Rufnummer und Captcha hier eintragen und auf „Registrieren“ drücken.</li>
            <li>Im nächsten Schritt den Bestätigungscode eingeben, den Signal schickt.</li>
          </ol>
          <Field label="Rufnummer" hint="Mit Ländervorwahl">
            <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+49 170 1234567" required autoFocus />
          </Field>
          <Field label="Captcha" hint="signalcaptcha://…">
            <input value={captcha} onChange={(e) => setCaptcha(e.target.value)} spellCheck={false} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Code per Anruf statt SMS (z. B. Festnetz)
          </label>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={run.isPending || !number.trim()}>
              Registrieren
            </button>
            <button type="button" className="btn" onClick={() => setVariant(null)}>
              <ArrowLeft size={16} /> Andere Variante wählen
            </button>
          </div>
        </form>
      )}

      {step === 'start' && id === 'telegram' && (
        <div className="btn-row">
          <button className="btn btn-primary" disabled={run.isPending} onClick={() => run.mutate({ action: 'login' })}>
            <LogIn size={16} /> Anmelden
          </button>
        </div>
      )}

      {step === 'qr' && (
        <div className="stack setup-variant">
          {id === 'signal' && (
            <>
              <h3>
                <Smartphone size={18} /> Variante A: Mit einem Handy koppeln
              </h3>
              <p>{state.setup?.hint}</p>
            </>
          )}
          {info?.qr ? <QrCode data={info.qr} label={`QR-Code zum Koppeln mit ${label}`} className="messenger-qr" /> : <p className="muted">QR-Code wird geladen …</p>}
          <div className="btn-row">
            <span className="muted small">
              <QrIcon size={14} /> Wartet auf das Scannen …
            </span>
            {cancel}
          </div>
        </div>
      )}

      {step === 'code' && (
        <form className="stack setup-variant" onSubmit={(e) => submit(e, { action: 'code', code, ...(pin && { password: pin }) }, () => (setCode(''), setPin('')))}>
          {id === 'signal' && (
            <>
              <h3>
                <KeyRound size={18} /> Variante B: Eigene Nummer registrieren – Schritt 2 von 2
              </h3>
              <p>{state.setup?.hint}</p>
            </>
          )}
          <Field label="Bestätigungscode">
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required />
          </Field>
          {id === 'signal' && (
            <Field label="PIN der Registrierungssperre" hint="Nur nötig, wenn die Nummer schon mit Sperre bei Signal registriert war">
              <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" />
            </Field>
          )}
          <div className="btn-row">
            <button className="btn btn-primary" disabled={run.isPending || !code.trim()}>
              <KeyRound size={16} /> Bestätigen
            </button>
            {cancel}
          </div>
        </form>
      )}

      {step === 'password' && (
        <form className="stack" onSubmit={(e) => submit(e, { action: 'password', password }, () => setPassword(''))}>
          <Field label="Passwort (zweistufige Bestätigung)">
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoFocus required />
          </Field>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={run.isPending || !password}>
              <KeyRound size={16} /> Anmelden
            </button>
            {cancel}
          </div>
        </form>
      )}

      {id === 'telegram' && state.status === 'connected' && (
        <div className="btn-row">
          <button className="btn" disabled={run.isPending} onClick={() => window.confirm('Telegram-Sitzung löschen? Danach ist eine neue Anmeldung nötig.') && run.mutate({ action: 'logout' })}>
            <LogOut size={16} /> Abmelden
          </button>
        </div>
      )}
    </Card>
  );
}
