import { z } from 'zod';
import type { RadioDevice, RadioState } from '@elvis/shared';
import { CommandError, command } from '../adapter.js';
import { activity } from '../radio/activity.js';
import { SimAdapter, clamp, jitter } from './sim-adapter.js';

const SIM_SDS = [
  'Lage unverändert',
  'Benötigen weitere Atemschutzgeräteträger',
  'Abschnitt 1 Wasserversorgung steht',
  'Rückmeldung an ELW: Personal vollzählig',
  'Bitte Rückruf Einsatzleiter',
];
/** Gegenstellen außerhalb des Fahrzeugs (Fahrzeuge an der Einsatzstelle, Leitstelle) */
const SIM_PEERS = ['6122101', '6122102', '6122203', '6122204', '6125001', '6125002', '6127010'];
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!;

interface SimCall {
  /** ISSI des Sprechers */
  caller: string;
  until: number;
}

/** Digitalfunk (BOS-TETRA). Real driver: PEI-Schnittstelle der MRT/FRT bzw. Funkvermittlungssystem. */
export class RadioSim extends SimAdapter<'radio'> {
  protected readonly commands = {
    'talkgroup.set': command(z.object({ deviceId: z.string(), talkgroupId: z.string() }), ({ deviceId, talkgroupId }) => {
      const dev = this.requireDevice(deviceId);
      const tg = this.state.talkgroups.find((t) => t.id === talkgroupId);
      if (!tg) throw new CommandError(`Unbekannte Rufgruppe ${talkgroupId}`, 404);
      if (dev.type === 'HRT') throw new CommandError('Handfunkgeräte können nicht ferngeschaltet werden');
      this.update((s) => {
        const d = s.devices.find((x) => x.id === deviceId)!;
        d.talkgroupId = tg.id;
        d.mode = tg.mode;
      });
      return `${dev.name} auf ${tg.name} geschaltet`;
    }),
    'status.set': command(z.object({ deviceId: z.string(), status: z.number().int().min(0).max(9) }), ({ deviceId, status }) => {
      this.requireDevice(deviceId);
      this.update((s) => {
        const d = s.devices.find((x) => x.id === deviceId)!;
        d.fmsStatus = status;
        d.lastActivity = new Date().toISOString();
        activity.point(s.activity, deviceId, 'status', new Date(), null, `Status ${status} gesendet`);
      });
    }),
  };

  constructor() {
    const dev = (d: Partial<RadioDevice> & Pick<RadioDevice, 'id' | 'name' | 'type' | 'issi' | 'talkgroupId'>): RadioDevice => ({
      workplace: null,
      mode: 'TMO',
      rssiDbm: -75,
      fmsStatus: null,
      transmitting: false,
      receiving: false,
      online: true,
      lastActivity: null,
      ...d,
    });
    super('radio', {
      talkgroups: [
        { id: 'tg-fw-1', name: 'FW_MST_1', mode: 'TMO', description: 'Feuerwehr Kreis – Einsatz 1' },
        { id: 'tg-fw-2', name: 'FW_MST_2', mode: 'TMO', description: 'Feuerwehr Kreis – Einsatz 2' },
        { id: 'tg-el', name: 'EL_MST_1', mode: 'TMO', description: 'Einsatzleitung' },
        { id: 'tg-ils', name: 'ILS_MST', mode: 'TMO', description: 'Leitstelle' },
        { id: 'tg-dmo-307', name: 'DMO 307_F', mode: 'DMO', description: 'Einsatzstelle Abschnitt 1' },
        { id: 'tg-dmo-308', name: 'DMO 308_F', mode: 'DMO', description: 'Einsatzstelle Abschnitt 2' },
      ],
      devices: [
        dev({ id: 'mrt-1', name: 'MRT Fahrzeug', type: 'MRT', issi: '6123401', talkgroupId: 'tg-ils', fmsStatus: 2 }),
        dev({ id: 'frt-1', name: 'Funkplatz 1', type: 'FRT', workplace: 'Funkraum', issi: '6123402', talkgroupId: 'tg-fw-1' }),
        dev({ id: 'frt-2', name: 'Funkplatz 2', type: 'FRT', workplace: 'Funkraum', issi: '6123403', talkgroupId: 'tg-el' }),
        dev({ id: 'frt-3', name: 'Führungsplatz', type: 'FRT', workplace: 'Führungsraum', issi: '6123404', talkgroupId: 'tg-dmo-307', mode: 'DMO' }),
        dev({ id: 'hrt-1', name: 'HRT 1', type: 'HRT', issi: '6123411', talkgroupId: 'tg-dmo-307', mode: 'DMO' }),
        dev({ id: 'hrt-2', name: 'HRT 2', type: 'HRT', issi: '6123412', talkgroupId: 'tg-dmo-307', mode: 'DMO' }),
        dev({ id: 'hrt-3', name: 'HRT 3', type: 'HRT', issi: '6123413', talkgroupId: 'tg-fw-1' }),
        dev({ id: 'hrt-4', name: 'HRT 4', type: 'HRT', issi: '6123414', talkgroupId: 'tg-fw-1' }),
      ],
      activity: [],
      capabilities: { talkgroupSwitch: true, statusSet: true },
      link: null,
    } satisfies RadioState);
  }

  private requireDevice(id: string): RadioDevice {
    const d = this.state.devices.find((x) => x.id === id);
    if (!d) throw new CommandError(`Unbekanntes Funkgerät ${id}`, 404);
    if (!d.online) throw new CommandError(`${d.name} ist nicht erreichbar`);
    return d;
  }

  private ticks = 0;
  /** Laufende Gespräche je Rufgruppe */
  private readonly calls = new Map<string, SimCall>();

  protected tick(): void {
    const now = new Date();
    const t = now.getTime();
    const iso = now.toISOString();
    // Pegel nur alle 5 s ändern – sonst ginge jede Sekunde der ganze Zustand an alle Clients.
    const rssiTick = this.ticks++ % 5 === 0;

    // Gespräche auf den Rufgruppen: ein Sprecher (fremde ISSI oder eigenes Gerät) für einige Sekunden,
    // danach antwortet oft die Gegenstelle. Im Schnitt etwa ein Funkspruch je Rufgruppe und Minute.
    const online = this.state.devices.filter((d) => d.online);
    for (const tg of this.state.talkgroups) {
      const call = this.calls.get(tg.id);
      if (call && call.until > t) continue;
      if (call) this.calls.delete(tg.id);
      const listeners = online.filter((d) => d.talkgroupId === tg.id);
      const reply = call && Math.random() < 0.5;
      if (!reply && Math.random() > 1 / 60) continue;
      const own = listeners.length > 0 && Math.random() < 0.2 ? pick(listeners) : null;
      const caller = own ? own.issi : pick(SIM_PEERS.filter((p) => p !== call?.caller));
      this.calls.set(tg.id, { caller, until: t + (3 + Math.random() * 10) * 1000 });
    }

    this.update((s) => {
      for (const d of s.devices) {
        // Handhelds occasionally leave coverage / get switched off.
        if (d.type === 'HRT' && Math.random() < 0.002) d.online = !d.online;
        if (!d.online) {
          d.rssiDbm = null;
          d.transmitting = d.receiving = false;
          activity.end(s.activity, d.id, now);
          continue;
        }
        if (rssiTick || d.rssiDbm === null) d.rssiDbm = Math.round(clamp((d.rssiDbm ?? -75) + jitter(2), d.mode === 'DMO' ? -95 : -105, -55));
        const call = this.calls.get(d.talkgroupId);
        const tg = s.talkgroups.find((x) => x.id === d.talkgroupId)?.name ?? null;
        d.transmitting = !!call && call.caller === d.issi;
        d.receiving = !!call && !d.transmitting;
        if (d.receiving) activity.begin(s.activity, d.id, 'rx', now, call!.caller, null, tg);
        else activity.end(s.activity, d.id, now, 'rx');
        if (d.transmitting) activity.begin(s.activity, d.id, 'tx', now, null, null, tg);
        else activity.end(s.activity, d.id, now, 'tx');
        if (d.receiving || d.transmitting) d.lastActivity = iso;
        if (d.type !== 'HRT' && Math.random() < 0.002) activity.point(s.activity, d.id, 'sds', now, pick(SIM_PEERS), pick(SIM_SDS));
        if (d.type === 'MRT' && Math.random() < 0.003) activity.point(s.activity, d.id, 'status', now, pick(SIM_PEERS), `Status ${pick([1, 2, 3, 4, 6])}`);
      }
      s.activity = activity.prune(s.activity, now);
    });
  }
}
