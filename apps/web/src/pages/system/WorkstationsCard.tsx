import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Download, FileText, Laptop, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import type { Workstation, WorkstationUpdate } from '@elvis/shared';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useToast } from '../../lib/toast';
import { Badge, Card, Loading, Modal, type Tone } from '../../components/ui';

/** Ohne Lebenszeichen seit dieser Zeit gilt ein Arbeitsplatz als ausgeschaltet (der Dienst meldet sich jede Minute) */
const ONLINE_MS = 3 * 60_000;

const UPDATE_STATE: Record<WorkstationUpdate['state'], { label: string; tone: Tone }> = {
  pending: { label: 'Update wartet', tone: 'info' },
  running: { label: 'Update läuft', tone: 'warn' },
  done: { label: 'Aktualisiert', tone: 'ok' },
  failed: { label: 'Update fehlgeschlagen', tone: 'alarm' },
  cancelled: { label: 'Update zurückgenommen', tone: 'muted' },
};

/** Update für einen oder alle Arbeitsplätze anstoßen */
function UpdateDialog({ target, onClose }: { target: Workstation | 'all'; onClose: () => void }) {
  const toast = useToast();
  const [apt, setApt] = useState(true);
  const [firmware, setFirmware] = useState(false);
  const start = useMutation({
    mutationFn: () => api.updateWorkstation(target === 'all' ? 'all' : target.id, { apt, firmware }),
    onSuccess: (list) => (toast('success', `Update angestoßen: ${list.map((w) => w.name).join(', ')}`), onClose()),
    onError: (e) => toast('error', e.message),
  });
  return (
    <Modal open title={target === 'all' ? 'Alle Arbeitsplätze aktualisieren' : `${target.name} aktualisieren`} onClose={onClose}>
      <div className="form">
        <label className="checkbox">
          <input type="checkbox" checked={apt} onChange={(e) => setApt(e.target.checked)} /> Pakete (Ubuntu, Firefox) – über den apt-Cache des Addons
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={firmware} onChange={(e) => setFirmware(e.target.checked)} /> Firmware (BIOS/UEFI, SSD, Dock … über fwupd/LVFS)
        </label>
        <p className="muted">
          Das Update startet, sobald niemand am Gerät angemeldet ist (sonst nach der nächsten Abmeldung). Während des Updates ist die Anmeldung gesperrt; ist ein Neustart nötig,
          startet das Notebook danach selbst neu. Nur der Docker-Host des Addons braucht Internet. Firmware-Updates nur mit Netzteil durchführen.
        </p>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn btn-primary" disabled={(!apt && !firmware) || start.isPending} onClick={() => start.mutate()}>
            Update anstoßen
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Per PXE installierte Arbeitsplätze (Addon „ELVIS Arbeitsplatz“) – nur Admins */
export function WorkstationsCard() {
  const toast = useToast();
  const { data: list } = useQuery({ queryKey: ['workstations'], queryFn: api.workstations, refetchInterval: 60_000 });
  const rename = useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => api.renameWorkstation(id, name), onError: (e) => toast('error', e.message) });
  const remove = useMutation({ mutationFn: api.removeWorkstation, onError: (e) => toast('error', e.message) });
  const cancel = useMutation({ mutationFn: api.cancelWorkstationUpdate, onError: (e) => toast('error', e.message) });
  const [updating, setUpdating] = useState<Workstation | 'all' | null>(null);
  const [logOf, setLogOf] = useState<Workstation | null>(null);
  // Teil der Arbeitsplatz-Liste: ändert sich mit den laufenden Addons (Topic „workstations“)
  const { data: installers } = useQuery({ queryKey: ['workstations', 'installers'], queryFn: api.workstationInstallers });

  return (
    <Card
      title="Arbeitsplätze"
      icon={<Laptop size={18} />}
      className="span-3"
      actions={
        <>
          {!!list?.length && (
            <button type="button" className="btn btn-sm" onClick={() => setUpdating('all')}>
              <RefreshCw size={16} /> Alle aktualisieren
            </button>
          )}
          {installers?.map((i) => (
            <a key={i.id} className="btn btn-sm" href={i.isoUrl} download title="Startet per BIOS und UEFI (auch Secure Boot); als CD brennen oder auf einen USB-Stick schreiben">
              <Download size={16} /> Installer-ISO
            </a>
          ))}
        </>
      }
    >
      {!!installers?.length && (
        <p className="muted">
          Notebooks ohne Netzwerkstart (PXE): Installer-ISO auf einen USB-Stick schreiben (z. B. balenaEtcher, Rufus im DD-Modus oder <code>dd</code>) und davon starten. Das Notebook
          braucht dabei ein Netzwerkkabel ins Netz des Addons; Installer-System und Abbild lädt es von dort.
        </p>
      )}
      {!list ? (
        <Loading />
      ) : list.length === 0 ? (
        <p className="muted">
          Noch keine Arbeitsplätze. Mit dem Addon „ELVIS Arbeitsplatz“ starten Notebooks per Netzwerk (PXE) und installieren das Arbeitsplatz-System; sie erscheinen
          danach hier.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Benutzer</th>
                <th>Update</th>
                <th>Installiert</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((w) => {
                const online = !!w.lastSeenAt && Date.now() - new Date(w.lastSeenAt).getTime() < ONLINE_MS;
                return (
                  <tr key={w.id}>
                    <td>
                      <div className="cell-title">{w.name}</div>
                      <div className="cell-sub mono">
                        {w.hostname} · {w.mac}
                        {w.version && ` · v${w.version}`}
                      </div>
                    </td>
                    <td>{online ? <Badge tone="ok">eingeschaltet</Badge> : <Badge>{w.lastSeenAt ? `zuletzt ${fmtDateTime(w.lastSeenAt)}` : 'noch nie gestartet'}</Badge>}</td>
                    <td>{w.lastUser ?? '–'}</td>
                    <td>
                      {w.update ? (
                        <>
                          <Badge tone={UPDATE_STATE[w.update.state].tone}>{UPDATE_STATE[w.update.state].label}</Badge>
                          <div className="cell-sub" title={w.update.message}>
                            {[w.update.apt && 'Pakete', w.update.firmware && 'Firmware'].filter(Boolean).join(' + ')} · {fmtDateTime(w.update.finishedAt ?? w.update.requestedAt)}
                            {w.update.message && ` · ${w.update.message}`}
                          </div>
                        </>
                      ) : (
                        '–'
                      )}
                    </td>
                    <td>{fmtDateTime(w.enrolledAt)}</td>
                    <td>
                      <span className="btn-row">
                        {w.update?.state === 'pending' ? (
                          <button type="button" className="btn btn-icon" aria-label={`Update auf ${w.name} zurücknehmen`} title="Update zurücknehmen" disabled={cancel.isPending} onClick={() => cancel.mutate(w.id)}>
                            <X size={16} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-icon"
                            aria-label={`${w.name} aktualisieren`}
                            title="Aktualisieren"
                            disabled={w.update?.state === 'running'}
                            onClick={() => setUpdating(w)}
                          >
                            <RefreshCw size={16} />
                          </button>
                        )}
                        {!!w.update?.log && (
                          <button type="button" className="btn btn-icon" aria-label={`Update-Protokoll von ${w.name}`} title="Update-Protokoll" onClick={() => setLogOf(w)}>
                            <FileText size={16} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`${w.name} umbenennen`}
                          onClick={() => {
                            const name = window.prompt('Neuer Name', w.name)?.trim();
                            if (name && name !== w.name) rename.mutate({ id: w.id, name });
                          }}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-icon"
                          aria-label={`${w.name} entfernen`}
                          disabled={remove.isPending}
                          onClick={() =>
                            window.confirm(`Arbeitsplatz „${w.name}“ entfernen? Das Gerät wird gesperrt und verwirft beim nächsten Kontakt auch die Offline-Anmeldung. Wieder einrichten nur per Neuinstallation.`) &&
                            remove.mutate(w.id)
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {updating && <UpdateDialog target={updating} onClose={() => setUpdating(null)} />}
      {logOf && (
        <Modal open title={`Update-Protokoll ${logOf.name}`} onClose={() => setLogOf(null)}>
          <pre className="logs">{list?.find((w) => w.id === logOf.id)?.update?.log || '(keine Ausgabe)'}</pre>
        </Modal>
      )}
    </Card>
  );
}
