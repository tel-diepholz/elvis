import { z } from 'zod';
import type { MediaState } from '@elvis/shared';
import { CommandError, command } from '../adapter.js';
import { SimAdapter } from './sim-adapter.js';

/** Videomatrix, Monitore und Kameras. Real driver: Matrix-Steuerprotokoll, CEC/RS-232, ONVIF. */
export class MediaSim extends SimAdapter<'media'> {
  protected readonly commands = {
    'display.power': command(z.object({ id: z.string(), on: z.boolean() }), ({ id, on }) => {
      this.requireDisplay(id);
      this.update((s) => void (s.displays.find((d) => d.id === id)!.power = on));
    }),
    'display.source': command(z.object({ id: z.string(), sourceId: z.string() }), ({ id, sourceId }) => {
      const display = this.requireDisplay(id);
      const source = this.state.sources.find((x) => x.id === sourceId);
      if (!source) throw new CommandError(`Unbekannte Quelle ${sourceId}`, 404);
      this.update((s) => {
        const d = s.displays.find((x) => x.id === id)!;
        d.sourceId = sourceId;
        d.power = true;
      });
      return `${display.name}: ${source.name}`;
    }),
    'camera.preset': command(z.object({ id: z.string(), presetId: z.string() }), ({ id, presetId }) => {
      const cam = this.state.cameras.find((c) => c.id === id);
      if (!cam) throw new CommandError(`Unbekannte Kamera ${id}`, 404);
      if (!cam.online) throw new CommandError(`${cam.name} ist offline`);
      if (!cam.presets.some((p) => p.id === presetId)) throw new CommandError(`Unbekannte Position ${presetId}`, 404);
      this.update((s) => void (s.cameras.find((c) => c.id === id)!.activePresetId = presetId));
    }),
  };

  constructor() {
    super('media', {
      sources: [
        { id: 'pc-lage', name: 'PC Lagekarte' },
        { id: 'pc-etb', name: 'PC Einsatztagebuch' },
        { id: 'elvis', name: 'ELVIS Übersicht' },
        { id: 'cam-mast', name: 'Mastkamera' },
        { id: 'cam-heck', name: 'Heckkamera' },
        { id: 'hdmi-gast', name: 'HDMI Besprechung' },
      ],
      displays: [
        { id: 'mon-fuehrung-l', name: 'Monitor Führung links', location: 'Führungsraum', power: true, sourceId: 'pc-lage' },
        { id: 'mon-fuehrung-r', name: 'Monitor Führung rechts', location: 'Führungsraum', power: true, sourceId: 'pc-etb' },
        { id: 'mon-funk', name: 'Monitor Funkraum', location: 'Funkraum', power: true, sourceId: 'elvis' },
        { id: 'mon-aussen', name: 'Außenmonitor Heck', location: 'Heck / Lagebesprechung', power: false, sourceId: 'pc-lage' },
      ],
      cameras: [
        {
          id: 'cam-mast',
          name: 'Mastkamera',
          online: true,
          ptz: true,
          presets: [
            { id: 'front', name: 'Front' },
            { id: 'heck', name: 'Heck' },
            { id: 'links', name: 'Links' },
            { id: 'rechts', name: 'Rechts' },
            { id: 'uebersicht', name: 'Übersicht' },
          ],
          activePresetId: 'uebersicht',
          snapshotUrl: null,
        },
        { id: 'cam-heck', name: 'Heckkamera', online: true, ptz: false, presets: [], activePresetId: null, snapshotUrl: null },
      ],
    } satisfies MediaState);
  }

  private requireDisplay(id: string) {
    const d = this.state.displays.find((x) => x.id === id);
    if (!d) throw new CommandError(`Unbekannter Monitor ${id}`, 404);
    return d;
  }

  protected tick(): void {
    /* statisch – Zustand ändert sich nur durch Befehle */
  }
}
