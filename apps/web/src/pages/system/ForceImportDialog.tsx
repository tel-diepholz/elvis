import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { FORCE_IMPORT_COLUMNS, FORCE_IMPORT_MAX_BYTES, formatStrength, type ForceImportAction, type ForceImportField, type ForceImportPlanRow, type ForceImportPreview } from '@elvis/shared';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { Badge, Toggle, type Tone } from '../../components/ui';

const ACTION: Record<ForceImportAction, { label: string; tone: Tone }> = {
  create: { label: 'neu', tone: 'ok' },
  update: { label: 'aktualisieren', tone: 'info' },
  skip: { label: 'überspringen', tone: 'muted' },
  error: { label: 'Fehler', tone: 'alarm' },
};

const strengthOf = (r: ForceImportPlanRow['row']) =>
  r && (r.leaders !== null || r.subLeaders !== null || r.crew !== null) ? formatStrength({ leaders: r.leaders ?? 0, subLeaders: r.subLeaders ?? 0, crew: r.crew ?? 0 }) : '';

/** Import aus CSV oder Excel: Datei wählen → Vorschau mit Aktion je Zeile → übernehmen */
export function ForceImportDialog({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ForceImportPreview | null>(null);
  const [updateExisting, setUpdateExisting] = useState(true);

  const load = useMutation({
    mutationFn: (f: File) => api.previewForceImport(f),
    onSuccess: setPreview,
    onError: (e) => (setPreview(null), toast('error', e.message)),
  });
  const run = useMutation({
    mutationFn: () => api.importForces({ rows: preview!.rows.filter((r) => r.action !== 'error').map((r) => r.row!), updateExisting }),
    onSuccess: (res) => {
      const parts = [`${res.created} neu`, `${res.updated} aktualisiert`, res.skipped && `${res.skipped} übersprungen`, res.linked && `${res.linked} zugeordnet`].filter(Boolean);
      toast('success', `Import: ${parts.join(', ')}`);
      const notes = res.rows.filter((r) => r.messages.length && r.action !== 'skip');
      if (notes.length) toast('error', notes.map((r) => `Zeile ${r.line}: ${r.messages.join('; ')}`).join(' · '));
      onDone();
    },
    onError: (e) => toast('error', e.message),
  });

  const choose = (f: File | null) => {
    setFile(f);
    setPreview(null);
    if (!f) return;
    if (f.size > FORCE_IMPORT_MAX_BYTES) return toast('error', `Datei größer als ${FORCE_IMPORT_MAX_BYTES / 1024 / 1024} MB`);
    load.mutate(f);
  };

  const rows = preview?.rows.map((r) => (r.action === 'update' && !updateExisting ? { ...r, action: 'skip' as const } : r)) ?? [];
  const count = (a: ForceImportAction) => rows.filter((r) => r.action === a).length;
  const writable = count('create') + count('update');

  return (
    <div className="form force-import">
      <p className="muted">
        CSV (Semikolon oder Komma, z. B. aus Excel „CSV UTF-8“) oder Excel-Datei (.xlsx, erstes Tabellenblatt). Die erste Zeile enthält die Spaltenüberschriften,
        erkannt werden: {Object.values(FORCE_IMPORT_COLUMNS).map((c) => c.label).join(', ')}. Stärke als „1/2/6“ oder in getrennten Spalten.
      </p>
      <div className="btn-row">
        <label className="btn btn-primary">
          <Upload size={16} /> Datei wählen
          <input type="file" accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => choose(e.target.files?.[0] ?? null)} />
        </label>
        <a className="btn btn-ghost" href={api.forceImportTemplateUrl} download>
          <Download size={16} /> Vorlage (CSV)
        </a>
        {file && (
          <span className="cell-sub">
            <FileSpreadsheet size={14} /> {file.name}
            {load.isPending && ' – wird gelesen …'}
          </span>
        )}
      </div>

      {preview && (
        <>
          <div className="force-import-columns">
            <span className="field-label">Erkannte Spalten</span>
            <div className="chip-row">
              {(Object.entries(preview.columns) as [ForceImportField, string][]).map(([field, header]) => (
                <Badge key={field} tone="info">
                  {header}
                  {header !== FORCE_IMPORT_COLUMNS[field].label && ` → ${FORCE_IMPORT_COLUMNS[field].label}`}
                </Badge>
              ))}
              {preview.ignored.map((h) => (
                <Badge key={h} tone="muted">
                  {h} (ignoriert)
                </Badge>
              ))}
            </div>
          </div>

          <div className="chip-row">
            {(['create', 'update', 'skip', 'error'] as const).map((a) => count(a) > 0 && <Badge key={a} tone={ACTION[a].tone}>{`${count(a)} ${ACTION[a].label}`}</Badge>)}
          </div>

          {count('update') + count('skip') > 0 && (
            <div className="field">
              <span className="field-label">Vorhandene Einheiten</span>
              <Toggle checked={updateExisting} onChange={setUpdateExisting} label="Mit den Werten aus der Datei aktualisieren" />
              <span className="field-hint">Erkannt am Funkrufnamen, sonst an Name und Organisation. Leere Zellen lassen vorhandene Werte stehen.</span>
            </div>
          )}

          <div className="table-wrap force-import-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Zeile</th>
                  <th>Name</th>
                  <th>Funkrufname</th>
                  <th>Organisation</th>
                  <th>Stärke</th>
                  <th>Gehört zu</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.line} className={r.action === 'error' ? 'force-import-error' : ''}>
                    <td className="mono">{r.line}</td>
                    <td>{r.name || '–'}</td>
                    <td>{r.row?.callsign ?? ''}</td>
                    <td>{r.row?.organization ?? ''}</td>
                    <td className="mono">{strengthOf(r.row)}</td>
                    <td>{r.row?.parent ? `${r.row.parent}${r.row.role ? ` (${r.row.role})` : ''}` : ''}</td>
                    <td>
                      <Badge tone={ACTION[r.action].tone}>{ACTION[r.action].label}</Badge>
                      {r.messages.length > 0 && <div className="cell-sub tone-alarm">{r.messages.join('; ')}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="form-actions spread">
            <span className="cell-sub">{count('error') > 0 && 'Zeilen mit Fehlern werden nicht übernommen – Datei korrigieren und erneut wählen.'}</span>
            <button className="btn btn-primary" disabled={!writable || run.isPending} onClick={() => run.mutate()}>
              {writable === 1 ? '1 Einheit übernehmen' : `${writable} Einheiten übernehmen`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
