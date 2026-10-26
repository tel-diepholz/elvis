import { VICTRON_STATE_LABELS, type Alert, type AlertSeverity, type DeviceId, type DeviceStateMap } from '@elvis/shared';
import type { ElvisConfig } from './config.js';
import { DEVICE_DEFINITIONS } from './devices/drivers.js';

export type AlertDraft = Omit<Alert, 'since'>;
type StateGetter = <K extends DeviceId>(id: K) => DeviceStateMap[K] | undefined;

const SEVERITY_ORDER: Record<AlertSeverity, number> = { alarm: 0, warn: 1, info: 2 };

/** Pure rule evaluation over the current device states; sorted by severity. */
export function evaluateAlerts(get: StateGetter, offline: DeviceId[], limits: ElvisConfig['alerts']): AlertDraft[] {
  const out: AlertDraft[] = [];
  const add = (a: AlertDraft) => out.push(a);

  for (const id of offline) {
    const def = DEVICE_DEFINITIONS[id];
    add({ id: `offline:${id}`, severity: 'alarm', system: def.system, title: `${def.name} nicht erreichbar` });
  }

  const weather = get('weather');
  if (weather) {
    if (weather.windGustMs !== null && weather.windGustMs >= limits.stormWarnMs) {
      add({ id: 'weather:storm', severity: 'warn', system: 'media', title: 'Sturmböen', detail: `${weather.windGustMs.toFixed(1)} m/s` });
    }
    if (weather.position && !weather.position.fix) {
      add({ id: 'weather:gps', severity: 'warn', system: 'media', title: 'Kein GPS-Empfang', detail: 'Fahrzeugstandort ist der zuletzt bekannte' });
    }
  }

  const router = get('router');
  if (router && !offline.includes('router')) {
    const active = router.failover.members.find((m) => m.active);
    if (!router.internet) {
      add({ id: 'router:internet', severity: 'alarm', system: 'comms', title: 'Router: keine Internetverbindung', detail: 'Weder WAN noch Mobilfunk verfügbar' });
    } else if (router.failover.onBackup && active) {
      add({ id: 'router:backup', severity: 'info', system: 'comms', title: 'Router: Ausweichverbindung aktiv', detail: active.label });
    }
    const sim = router.sims.find((x) => x.active);
    const SIM_PROBLEM: Partial<Record<string, string>> = {
      'no-sim': 'keine SIM-Karte',
      'pin-required': 'PIN erforderlich',
      'puk-required': 'PUK erforderlich',
      denied: 'Netz verweigert Anmeldung',
      error: 'SIM-Fehler',
    };
    if (sim && SIM_PROBLEM[sim.status]) {
      add({ id: 'router:sim', severity: 'warn', system: 'comms', title: `Router: SIM ${sim.slot} – ${SIM_PROBLEM[sim.status]}`, detail: sim.detail ?? undefined });
    }
  }

  const cameras = get('cameras');
  if (cameras && !offline.includes('cameras')) {
    for (const c of cameras.cameras.filter((x) => !x.online)) {
      add({ id: `camera:${c.id}`, severity: 'warn', system: 'media', title: `Kamera ${c.name} nicht erreichbar`, detail: c.error ?? undefined });
    }
  }

  const wifi = get('wifi');
  if (wifi && !offline.includes('wifi')) {
    for (const ap of wifi.aps.filter((x) => !x.online)) {
      add({ id: `wifi:${ap.id}`, severity: 'alarm', system: 'comms', title: `Accesspoint ${ap.name} nicht erreichbar`, detail: ap.error ?? undefined });
    }
  }

  const monitoring = get('monitoring');
  if (monitoring && !offline.includes('monitoring')) {
    for (const t of monitoring.targets) {
      // Nicht dauerhaft eingeschaltete Geräte dürfen fehlen; ihre letzten Messwerte gelten dann nicht mehr
      if (t.reachable === false) {
        if (t.alwaysOn) add({ id: `monitoring:${t.id}`, severity: 'alarm', system: 'comms', title: `${t.name} nicht erreichbar`, detail: t.error ?? undefined });
        continue;
      }
      for (const m of t.metrics) {
        if (m.severity === 'ok') continue;
        add({ id: `monitoring:${t.id}:${m.id}`, severity: m.severity, system: 'comms', title: `${t.name}: ${m.label}`, detail: m.problem && m.problem !== m.text ? `${m.text} – ${m.problem}` : m.text });
      }
    }
  }

  const bluetooth = get('bluetooth');
  if (bluetooth && !offline.includes('bluetooth')) {
    const volts = (v: number) => `${v.toFixed(2).replace('.', ',')} V`;
    for (const d of bluetooth.devices) {
      const id = `bluetooth:${d.id}`;
      if (d.stale) {
        add({ id, severity: 'warn', system: 'energy', title: `${d.name}: kein Empfang`, detail: d.seenAt ? 'Werte sind die zuletzt empfangenen' : 'Seit dem Start nichts empfangen – Adresse und Reichweite prüfen' });
        continue;
      }
      if (d.error) add({ id: `${id}:error`, severity: 'warn', system: 'energy', title: `${d.name}: ${d.error}` });
      const r = d.readout;
      if (!r) continue;
      if (r.type === 'lithium') {
        if (r.errorFlags) add({ id: `${id}:bms`, severity: 'alarm', system: 'energy', title: `${d.name}: Batteriefehler`, detail: `Fehlercode 0x${r.errorFlags.toString(16)} – in VictronConnect prüfen` });
        if (r.cells.includes('low')) add({ id: `${id}:cell-low`, severity: 'alarm', system: 'energy', title: `${d.name}: Zellspannung zu niedrig`, detail: 'unter 2,61 V' });
        if (r.cells.includes('high')) add({ id: `${id}:cell-high`, severity: 'alarm', system: 'energy', title: `${d.name}: Zellspannung zu hoch`, detail: 'über 3,85 V' });
      }
      if (r.type === 'battery-monitor') {
        for (const a of r.alarms) add({ id: `${id}:alarm:${a}`, severity: 'alarm', system: 'energy', title: `${d.name}: ${a}` });
      }
      if ((r.type === 'solar' || r.type === 'dcdc' || r.type === 'ac-charger') && (r.state === 2 || (r.error !== null && r.error !== 0))) {
        add({ id: `${id}:fault`, severity: 'warn', system: 'energy', title: `${d.name}: Störung`, detail: r.error ? `Fehler ${r.error}` : VICTRON_STATE_LABELS[2] });
      }
      const voltage = r.type === 'lithium' || r.type === 'battery-monitor' || r.type === 'solar' ? r.voltageV : null;
      if (d.warnBelowV !== null && voltage !== null && voltage < d.warnBelowV) {
        add({ id: `${id}:low`, severity: 'warn', system: 'energy', title: `${d.name}: Spannung niedrig`, detail: `${volts(voltage)} (Grenze ${volts(d.warnBelowV)})` });
      }
    }
  }

  const network = get('network');
  if (network) {
    if (!network.internet) {
      add({ id: 'net:internet', severity: 'alarm', system: 'comms', title: 'Keine Internetverbindung' });
    } else if (!network.vpn.connected) {
      add({ id: 'net:vpn', severity: 'warn', system: 'comms', title: 'VPN getrennt', detail: network.vpn.peer });
    }
    const down = network.uplinks.filter((u) => !u.online);
    if (network.internet && down.length > 0) {
      add({ id: 'net:uplinks', severity: 'info', system: 'comms', title: 'Uplink ausgefallen', detail: down.map((u) => u.name).join(', ') });
    }
  }

  const radio = get('radio');
  if (radio) {
    const fixed = radio.devices.filter((d) => d.type !== 'HRT' && !d.online);
    if (fixed.length > 0) {
      add({ id: 'radio:fixed', severity: 'alarm', system: 'comms', title: 'Funkgerät gestört', detail: fixed.map((d) => d.name).join(', ') });
    }
  }

  return sortAlerts(out);
}

/** Schwerste zuerst; bei gleicher Schwere bleibt die Reihenfolge */
export function sortAlerts(alerts: AlertDraft[]): AlertDraft[] {
  return [...alerts].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
