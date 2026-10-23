import { z } from 'zod';
import type { RadioDevice, RadioState } from '@elvis/shared';
import { CommandError, command } from '../adapter.js';
import { SimAdapter, clamp, jitter } from './sim-adapter.js';

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
    } satisfies RadioState);
  }

  private requireDevice(id: string): RadioDevice {
    const d = this.state.devices.find((x) => x.id === id);
    if (!d) throw new CommandError(`Unbekanntes Funkgerät ${id}`, 404);
    if (!d.online) throw new CommandError(`${d.name} ist nicht erreichbar`);
    return d;
  }

  protected tick(): void {
    const now = new Date().toISOString();
    this.update((s) => {
      for (const d of s.devices) {
        // Handhelds occasionally leave coverage / get switched off.
        if (d.type === 'HRT' && Math.random() < 0.004) d.online = !d.online;
        if (!d.online) {
          d.rssiDbm = null;
          d.transmitting = d.receiving = false;
          continue;
        }
        d.rssiDbm = Math.round(clamp((d.rssiDbm ?? -75) + jitter(2), d.mode === 'DMO' ? -95 : -105, -55));
        const wasActive = d.transmitting || d.receiving;
        d.receiving = wasActive ? Math.random() < 0.6 && d.receiving : Math.random() < 0.05;
        d.transmitting = !d.receiving && (wasActive ? Math.random() < 0.5 && d.transmitting : Math.random() < 0.015);
        if (d.receiving || d.transmitting) d.lastActivity = now;
      }
    });
  }
}
