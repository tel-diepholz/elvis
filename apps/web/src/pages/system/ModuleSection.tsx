import { useEffect, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { defaultOptionValues, type DeviceModule, type DeviceModuleConfig } from '@elvis/shared';
import { api } from '../../lib/api';
import { useLive } from '../../lib/live';
import { useToast } from '../../lib/toast';
import { OptionsForm, validateOptions } from '../../components/OptionsForm';
import { SettingsSection } from '../../components/SettingsSection';
import { Badge, Field, Toggle } from '../../components/ui';

/**
 * Ein Fahrzeugmodul als aufklappbarer Abschnitt: Kopfzeile mit Zustand und Treiber (nur wenn es eine Auswahl gibt), darin Aktivierung, Treiber und
 * dessen Einstellungen, darunter die Geräte des Moduls (`children`, z. B. die Bluetooth-Geräte). Nur für Admins.
 */
export function ModuleSection({ module: m, icon, children }: { module: DeviceModule; icon?: ReactNode; children?: ReactNode }) {
  const live = useLive().devices[m.id];
  const driver = m.drivers.find((d) => d.id === m.config.driver);
  const summary = !m.config.enabled ? (
    <Badge>deaktiviert</Badge>
  ) : (
    <>
      {m.config.driver === 'sim' ? <Badge tone="warn">Simulation</Badge> : m.drivers.length > 1 && <span>{driver?.label}</span>}
      {live ? <Badge tone={live.online ? 'ok' : 'alarm'}>{live.online ? 'verbunden' : 'keine Daten'}</Badge> : <Badge tone="alarm">{m.error ?? 'nicht gestartet'}</Badge>}
    </>
  );
  return (
    <SettingsSection id={`modul-${m.id}`} title={m.name} icon={icon} summary={summary}>
      <ModuleEditor module={m} />
      {children}
    </SettingsSection>
  );
}

function ModuleEditor({ module: m }: { module: DeviceModule }) {
  const toast = useToast();
  const [draft, setDraft] = useState<DeviceModuleConfig>(m.config);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(m.config);
  }, [m.config, dirty]);

  const driver = m.drivers.find((d) => d.id === draft.driver) ?? m.drivers[0]!;
  // Gespeicherte Passwörter gelten nur für den gespeicherten Treiber
  const secretsSet = draft.driver === m.config.driver ? m.secretsSet : [];
  const errors = draft.enabled ? validateOptions(driver.options, draft.options, secretsSet) : {};
  const change = (next: DeviceModuleConfig) => (setDraft(next), setDirty(true));

  const save = useMutation({
    mutationFn: () => api.configureDevice(m.id, draft),
    onSuccess: (res) => {
      setDirty(false);
      toast('success', `${m.name}: ${res.config.enabled ? 'übernommen' : 'deaktiviert'}`);
    },
    onError: (e) => toast('error', e.message),
  });

  return (
    <div className="module-editor">
      <Toggle label="Modul aktiv" checked={draft.enabled} onChange={(enabled) => change({ ...draft, enabled })} disabled={save.isPending} />

      {draft.enabled && (
        <>
          <Field label="Treiber" hint={driver.description}>
            <select
              value={draft.driver}
              disabled={save.isPending}
              onChange={(e) => {
                const next = m.drivers.find((d) => d.id === e.target.value)!;
                // Beim Zurückwechseln auf den gespeicherten Treiber dessen Einstellungen wiederherstellen
                change({ ...draft, driver: next.id, options: next.id === m.config.driver ? m.config.options : defaultOptionValues(next.options) });
              }}
            >
              {m.drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
          <OptionsForm
            options={driver.options}
            values={draft.options}
            onChange={(options) => change({ ...draft, options })}
            errors={errors}
            secretsSet={secretsSet}
            disabled={save.isPending}
            emptyText="Dieser Treiber hat keine Einstellungen."
          />
        </>
      )}

      <div className="form-actions spread">
        <span className="muted">{m.source === 'config' ? 'Vorgabe aus config/elvis.json' : 'In den Einstellungen gespeichert'}</span>
        <span className="btn-row">
          <button className="btn" disabled={!dirty || save.isPending} onClick={() => (setDirty(false), setDraft(m.config))}>
            Verwerfen
          </button>
          <button className="btn btn-primary" disabled={!dirty || save.isPending || Object.keys(errors).length > 0} onClick={() => save.mutate()}>
            {save.isPending ? 'Übernehme …' : 'Übernehmen'}
          </button>
        </span>
      </div>
    </div>
  );
}
