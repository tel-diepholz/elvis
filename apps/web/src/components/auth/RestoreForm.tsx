import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BACKUP_DRIVERS, parseRecoveryKey, type BackupDriverId } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtBytes, fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Field, Meter } from '../ui';

/**
 * Ersteinrichtung „Aus Backup wiederherstellen“: Treiber und Wiederherstellungsschlüssel eingeben, Backup wählen,
 * herunterladen lassen. ELVIS startet danach neu; angemeldet wird mit den Benutzern aus dem Backup.
 */
export function RestoreForm() {
  const toast = useToast();
  const [driver, setDriver] = useState<BackupDriverId>(BACKUP_DRIVERS[0]!.id);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [backupId, setBackupId] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const keyValid = parseRecoveryKey(recoveryKey) !== null;

  const list = useMutation({
    mutationFn: () => api.restoreList(driver, recoveryKey),
    onSuccess: (b) => setBackupId(b[0]?.id ?? null),
    onError: (e) => toast('error', e.message),
  });
  const start = useMutation({
    mutationFn: () => api.restoreStart({ driver, recoveryKey, backupId: backupId! }),
    onSuccess: () => setStarted(true),
    onError: (e) => toast('error', e.message),
  });

  if (started) return <Progress onFailed={() => setStarted(false)} />;
  const backups = list.data;

  return (
    <div className="form">
      <p className="muted">Eine frisch installierte ELVIS-Instanz aus einem Backup wiederherstellen. Dafür brauchen Sie den Wiederherstellungsschlüssel aus der Einrichtung des Backups.</p>
      <div className="form-grid">
        <Field label="Treiber">
          <select
            value={driver}
            onChange={(e) => {
              setDriver(e.target.value as BackupDriverId);
              list.reset();
            }}
          >
            {BACKUP_DRIVERS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Wiederherstellungsschlüssel" hint={recoveryKey && !keyValid ? 'Schlüssel unvollständig oder Tippfehler' : 'ELVIS-XXXX-XXXX-… (Groß-/Kleinschreibung egal)'}>
          <textarea
            className="mono"
            rows={2}
            value={recoveryKey}
            onChange={(e) => {
              setRecoveryKey(e.target.value);
              list.reset();
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      </div>
      {!backups && (
        <div className="form-actions">
          <button className="btn btn-primary" disabled={!keyValid || list.isPending} onClick={() => list.mutate()}>
            {list.isPending ? 'Suche …' : 'Backups suchen'}
          </button>
        </div>
      )}

      {backups && backups.length === 0 && <p className="muted">Zu diesem Schlüssel gibt es noch kein abgeschlossenes Backup.</p>}
      {backups && backups.length > 0 && (
        <>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>Backup</th>
                <th>Fahrzeug</th>
                <th>Größe</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.id} onClick={() => setBackupId(b.id)}>
                  <td>
                    <input type="radio" name="backup" checked={backupId === b.id} onChange={() => setBackupId(b.id)} aria-label={fmtDateTime(b.createdAt)} />
                  </td>
                  <td>{fmtDateTime(b.createdAt)}</td>
                  <td>{b.vehicle ?? '–'}</td>
                  <td>{fmtBytes(b.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="banner banner-alarm">
            Die alte Installation bitte vorher abschalten: Diese Instanz übernimmt ihre Cloud-Anmeldung, gekoppelte Apps, das Postfach und das Backup. Laufen beide weiter,
            stören sie sich gegenseitig.
          </div>
          <div className="form-actions">
            <button className="btn btn-primary" disabled={!backupId || start.isPending} onClick={() => start.mutate()}>
              Wiederherstellen
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Fortschritt; nach dem Neustart neu laden, sobald ELVIS die Benutzer aus dem Backup kennt */
function Progress({ onFailed }: { onFailed: () => void }) {
  const toast = useToast();
  const { data: s } = useQuery({ queryKey: ['restore'], queryFn: api.restoreStatus, refetchInterval: 1000, retry: false, gcTime: 0 });
  const restarting = s?.state === 'restarting';
  const { data: auth } = useQuery({ queryKey: ['restore', 'auth'], queryFn: api.authStatus, enabled: restarting, refetchInterval: 1500, retry: false });

  useEffect(() => {
    if (auth?.hasUsers) window.location.reload();
  }, [auth?.hasUsers]);
  useEffect(() => {
    if (s?.state !== 'error') return;
    toast('error', s.error ?? 'Wiederherstellung fehlgeschlagen');
    onFailed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.state]);

  return (
    <div className="form">
      <p>{restarting ? 'Backup übernommen – ELVIS startet neu …' : (s?.step ?? 'Wird vorbereitet …')}</p>
      {s?.progress !== null && s?.progress !== undefined && <Meter value={s.progress * 100} label="Fortschritt" />}
      <p className="muted">Bitte dieses Fenster offen lassen. Danach melden Sie sich mit einem Benutzer und der PIN aus dem Backup an.</p>
    </div>
  );
}
