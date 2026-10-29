import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Copy, DatabaseBackup, Download } from 'lucide-react';
import {
  BACKUP_DRIVERS,
  BACKUP_INTERVAL_LABELS,
  BACKUP_INTERVALS,
  DEFAULT_BACKUP_KEEP,
  normalizeRecoveryKey,
  recoveryKeyCheck,
  type BackupDriverId,
  type BackupInterval,
  type BackupStatus,
} from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtBytes, fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Field, Loading, Modal, Segmented, Toggle } from '../../components/ui';
import { copyText } from '../DockerHostsPage';

const driverLabel = (id: BackupDriverId | null) => BACKUP_DRIVERS.find((d) => d.id === id)?.label ?? '–';

/** Wiederherstellungsschlüssel als Textdatei zum Ablegen außerhalb des ELW */
export function downloadRecoveryKey(key: string, vehicle: string) {
  const text = `ELVIS – Wiederherstellungsschlüssel\n\nFahrzeug: ${vehicle}\nErstellt: ${fmtDateTime(new Date())}\n\n${key}\n\nMit diesem Schlüssel lässt sich eine neu installierte ELVIS-Instanz aus dem Backup wiederherstellen.\nSicher und getrennt vom Fahrzeug aufbewahren – ohne ihn sind die Backups nicht lesbar.\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `elvis-wiederherstellungsschluessel-${vehicle.replace(/[^\w-]+/g, '_')}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Backup: Treiber einrichten (mit Wiederherstellungsschlüssel), Intervall, Aufbewahrung, „Jetzt sichern“. Nur Admins. */
export function BackupCard() {
  const { data: s } = useQuery({ queryKey: ['backup'], queryFn: api.backupStatus, refetchInterval: (q) => (q.state.data?.running ? 3000 : false) });
  if (!s) return <Loading />;
  const badge = s.state === 'off' ? <Badge>Aus</Badge> : s.running ? <Badge tone="info">Sichert …</Badge> : s.lastError ? <Badge tone="alarm">Fehler</Badge> : <Badge tone="ok">Aktiv</Badge>;
  return (
    <Card title="Backup" icon={<DatabaseBackup size={18} />} actions={badge}>
      {s.state === 'off' ? <Setup /> : <Active s={s} />}
    </Card>
  );
}

function Setup() {
  const toast = useToast();
  const [enabled, setEnabled] = useState(false);
  const [driver, setDriver] = useState<BackupDriverId>(BACKUP_DRIVERS[0]!.id);
  const [key, setKey] = useState<string | null>(null);
  const begin = useMutation({ mutationFn: () => api.backupSetup(driver), onSuccess: (r) => setKey(r.recoveryKey), onError: (e) => toast('error', e.message) });
  const info = BACKUP_DRIVERS.find((d) => d.id === driver);

  return (
    <>
      <p className="muted">
        ELVIS sichert Datenbank, Dokumente, Vorlagen, Schlüssel und Konfiguration verschlüsselt. Mit dem Wiederherstellungsschlüssel lässt sich eine neu installierte
        Instanz bei der Ersteinrichtung wiederherstellen.
      </p>
      <Toggle label="Backup aktiv" checked={enabled} onChange={setEnabled} />
      {enabled && (
        <>
          <div className="form-grid">
            <Field label="Treiber" hint={info?.description}>
              <select value={driver} onChange={(e) => setDriver(e.target.value as BackupDriverId)}>
                {BACKUP_DRIVERS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" disabled={begin.isPending} onClick={() => begin.mutate()}>
              Einrichten …
            </button>
          </div>
        </>
      )}
      {key && <KeyDialog recoveryKey={key} onClose={() => setKey(null)} />}
    </>
  );
}

/** Schlüssel einmal anzeigen; erst nach dem Abtippen der letzten Gruppen ist das Backup eingerichtet */
function KeyDialog({ recoveryKey, onClose }: { recoveryKey: string; onClose: () => void }) {
  const toast = useToast();
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.settings });
  const [check, setCheck] = useState('');
  const [interval, setBackupInterval] = useState<BackupInterval>('1h');
  const confirm = useMutation({
    mutationFn: () => api.backupConfirm({ check, interval, keep: DEFAULT_BACKUP_KEEP }),
    onSuccess: () => {
      toast('success', 'Backup eingerichtet, das erste Backup läuft');
      onClose();
    },
    onError: (e) => toast('error', e.message),
  });
  const matches = normalizeRecoveryKey(check) === normalizeRecoveryKey(recoveryKeyCheck(recoveryKey));
  const groups = recoveryKey.split('-');

  return (
    <Modal open title="Wiederherstellungsschlüssel" onClose={onClose} dismissible={false}>
      <div className="form">
        <p>
          Diesen Schlüssel <strong>jetzt notieren oder als Datei speichern</strong> und getrennt vom Fahrzeug aufbewahren. Er wird nur dieses eine Mal angezeigt. Ohne ihn
          lassen sich die Backups nicht wiederherstellen – auch nicht vom Betreiber.
        </p>
        <p className="mono recovery-key">
          {groups.map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </p>
        <div className="btn-row">
          <button className="btn btn-sm" onClick={() => void copyText(recoveryKey).then((ok) => toast(ok ? 'success' : 'error', ok ? 'Kopiert' : 'Kopieren nicht möglich'))}>
            <Copy size={14} /> Kopieren
          </button>
          <button className="btn btn-sm" onClick={() => downloadRecoveryKey(recoveryKey, settings?.vehicle.name ?? 'ELW')}>
            <Download size={14} /> Als Datei speichern
          </button>
        </div>
        <div className="form-grid">
          <Field label="Zur Bestätigung: die letzten zwei Gruppen" hint="z. B. AB12-CD34">
            <input value={check} onChange={(e) => setCheck(e.target.value)} className="mono" autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <Segmented label="Intervall" value={interval} onChange={setBackupInterval} options={BACKUP_INTERVALS.map((v) => ({ value: v, label: BACKUP_INTERVAL_LABELS[v] }))} />
        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button className="btn btn-primary" disabled={!matches || confirm.isPending} onClick={() => confirm.mutate()}>
            {confirm.isPending ? 'Richte ein …' : 'Einrichtung abschließen'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Active({ s }: { s: BackupStatus }) {
  const toast = useToast();
  const [keep, setKeep] = useState(String(s.keep));
  useEffect(() => setKeep(String(s.keep)), [s.keep]);
  const update = useMutation({
    mutationFn: (input: { interval: BackupInterval; keep: number }) => api.updateBackup(input),
    onSuccess: () => toast('success', 'Backup-Einstellungen übernommen'),
    onError: (e) => toast('error', e.message),
  });
  const run = useMutation({ mutationFn: api.runBackup, onError: (e) => toast('error', e.message) });
  const disable = useMutation({ mutationFn: api.disableBackup, onSuccess: () => toast('success', 'Backup abgeschaltet'), onError: (e) => toast('error', e.message) });
  const maxKeep = s.quota?.maxBackups ?? 1000;
  const keepNum = Number(keep);
  const keepValid = Number.isInteger(keepNum) && keepNum >= 1 && keepNum <= maxKeep;

  return (
    <>
      <Toggle
        label="Backup aktiv"
        checked
        disabled={disable.isPending}
        onChange={() =>
          window.confirm('Backup abschalten? Vorhandene Backups bleiben beim Treiber und lassen sich mit dem bisherigen Schlüssel weiter wiederherstellen.') && disable.mutate()
        }
      />
      <dl className="kv">
        <dt>Treiber</dt>
        <dd>{driverLabel(s.driver)}</dd>
        <dt>Letztes Backup</dt>
        <dd>{s.lastSuccessAt ? fmtDateTime(s.lastSuccessAt) : '–'}</dd>
        <dt>Nächstes Backup</dt>
        <dd>{s.running ? 'läuft gerade' : s.nextRunAt ? fmtDateTime(s.nextRunAt) : '–'}</dd>
        <dt>Belegt</dt>
        <dd>
          {s.usedBytes !== null ? fmtBytes(s.usedBytes) : '–'}
          {s.quota && ` von ${fmtBytes(s.quota.maxBytes)} · ${s.backups.length} von höchstens ${s.quota.maxBackups} Backups`}
        </dd>
        {s.lastError && (
          <>
            <dt>Fehler</dt>
            <dd className="tone-alarm">
              {s.lastError} {s.lastRunAt && `(${fmtDateTime(s.lastRunAt)})`}
            </dd>
          </>
        )}
      </dl>

      <Segmented
        label="Intervall"
        value={s.interval}
        disabled={update.isPending}
        onChange={(interval) => update.mutate({ interval, keep: s.keep })}
        options={BACKUP_INTERVALS.map((v) => ({ value: v, label: BACKUP_INTERVAL_LABELS[v] }))}
      />
      <div className="form-grid">
        <Field label="Aufbewahren (Anzahl)" hint={s.quota ? `Höchstens ${s.quota.maxBackups} im Kontingent; ältere Backups werden gelöscht.` : 'Ältere Backups werden gelöscht.'}>
          <input type="number" min={1} max={maxKeep} value={keep} onChange={(e) => setKeep(e.target.value)} />
        </Field>
      </div>

      <div className="form-actions spread">
        <button className="btn btn-primary" disabled={s.running || run.isPending} onClick={() => run.mutate()}>
          {s.running ? 'Sichere …' : 'Jetzt sichern'}
        </button>
        <span className="btn-row">
          <button className="btn" disabled={!keepValid || keepNum === s.keep || update.isPending} onClick={() => update.mutate({ interval: s.interval, keep: keepNum })}>
            Übernehmen
          </button>
        </span>
      </div>

      {s.backups.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Backup</th>
              <th>Fahrzeug</th>
              <th>Größe</th>
            </tr>
          </thead>
          <tbody>
            {s.backups.map((b) => (
              <tr key={b.id}>
                <td>{fmtDateTime(b.createdAt)}</td>
                <td>{b.vehicle ?? '–'}</td>
                <td>{fmtBytes(b.size)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
