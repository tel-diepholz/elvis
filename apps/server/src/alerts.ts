import type { Alert, AlertSeverity, DeviceId, DeviceStateMap } from '@elvis/shared';
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

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
