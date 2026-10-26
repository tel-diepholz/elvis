import { describe, expect, it } from 'vitest';
import { RadarService, parseRadarCapabilities, radarFrames, type RadarFetch } from './radar.js';

const caps = (end: string, reference: string) => `<?xml version="1.0"?><WMS_Capabilities><Capability><Layer><Layer queryable="1">
  <Name>Niederschlagsradar</Name>
  <Dimension name="time" default="current" units="ISO8601">2026-10-23T00:00:00.000Z/${end}/PT5M</Dimension>
  <Dimension name="REFERENCE_TIME" default="${reference}" units="ISO8601">2026-10-23T00:00:00.000Z,${reference}</Dimension>
</Layer></Layer></Capability></WMS_Capabilities>`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function fakeDwd() {
  const state = { end: '2026-10-26T18:30:00.000Z', reference: '2026-10-26T16:30:00.000Z', online: true, calls: [] as string[] };
  const fetch: RadarFetch = async (url) => {
    state.calls.push(url);
    if (!state.online) throw new Error('offline');
    if (url.includes('GetCapabilities')) return { status: 200, contentType: 'application/xml', body: Buffer.from(caps(state.end, state.reference)) };
    return { status: 200, contentType: 'image/png', body: PNG };
  };
  return { state, fetch };
}

const opts = { wmsUrl: 'https://maps.dwd.de/geoserver/dwd/wms', layer: 'Niederschlagsradar', attribution: '© DWD', userAgent: 'test' };

describe('Regenradar', () => {
  it('liest die Zeitachse und bildet zwei Stunden Rückblick plus Vorhersage', () => {
    const axis = parseRadarCapabilities(caps('2026-10-26T18:30:00.000Z', '2026-10-26T16:30:00.000Z'));
    expect(axis.stepMs).toBe(300_000);
    const frames = radarFrames(axis);
    expect(frames[0]).toBe('2026-10-26T14:30:00.000Z');
    expect(frames.at(-1)).toBe('2026-10-26T18:30:00.000Z');
    expect(frames).toHaveLength(49);
  });

  it('fragt nur die Capabilities der einen Ebene ab und cacht sie', async () => {
    const dwd = fakeDwd();
    let now = 0;
    const radar = new RadarService(opts, dwd.fetch, () => now);
    const f = await radar.frames();
    expect(f.reference).toBe('2026-10-26T16:30:00.000Z');
    expect(dwd.state.calls[0]).toContain('/geoserver/dwd/Niederschlagsradar/ows?');
    await radar.frames();
    expect(dwd.state.calls).toHaveLength(1);
    now = 61_000;
    await radar.frames();
    expect(dwd.state.calls).toHaveLength(2);
  });

  it('liefert Kacheln nur für Zeitpunkte der Achse und cacht sie', async () => {
    const dwd = fakeDwd();
    const radar = new RadarService(opts, dwd.fetch);
    const tile = await radar.tile('2026-10-26T16:00:00.000Z', 8, 134, 83);
    expect(tile?.contentType).toBe('image/png');
    expect(dwd.state.calls[1]).toContain('request=GetMap');
    expect(dwd.state.calls[1]).toContain('time=2026-10-26T16%3A00%3A00.000Z');
    await radar.tile('2026-10-26T16:00:00.000Z', 8, 134, 83);
    expect(dwd.state.calls).toHaveLength(2);

    await expect(radar.tile('2026-10-26T16:02:00.000Z', 8, 134, 83)).rejects.toMatchObject({ statusCode: 404 });
    await expect(radar.tile('2026-10-26T10:00:00.000Z', 8, 134, 83)).rejects.toMatchObject({ statusCode: 404 });
    await expect(radar.tile('2026-10-26T19:00:00.000Z', 8, 134, 83)).rejects.toMatchObject({ statusCode: 404 });
    await expect(radar.tile('2026-10-26T16:00:00.000Z', 14, 0, 0)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('verwirft Vorhersagekacheln, sobald eine neue Messung vorliegt', async () => {
    const dwd = fakeDwd();
    let now = 0;
    const radar = new RadarService(opts, dwd.fetch, () => now);
    await radar.tile('2026-10-26T17:00:00.000Z', 8, 134, 83);
    await radar.tile('2026-10-26T16:00:00.000Z', 8, 134, 83);
    expect(dwd.state.calls).toHaveLength(3);
    dwd.state.reference = '2026-10-26T16:35:00.000Z';
    dwd.state.end = '2026-10-26T18:35:00.000Z';
    now = 61_000;
    await radar.tile('2026-10-26T17:00:00.000Z', 8, 134, 83); // neu geladen
    await radar.tile('2026-10-26T16:00:00.000Z', 8, 134, 83); // Messung bleibt
    expect(dwd.state.calls.filter((u) => u.includes('GetMap'))).toHaveLength(3);
  });

  it('nutzt offline den letzten Stand und meldet ohne ihn 503', async () => {
    const dwd = fakeDwd();
    let now = 0;
    const radar = new RadarService(opts, dwd.fetch, () => now);
    await radar.frames();
    dwd.state.online = false;
    now = 120_000;
    expect((await radar.frames()).reference).toBe('2026-10-26T16:30:00.000Z');
    expect(await radar.tile('2026-10-26T16:00:00.000Z', 8, 1, 1)).toBeNull();

    const fresh = new RadarService(opts, dwd.fetch);
    await expect(fresh.frames()).rejects.toMatchObject({ statusCode: 503 });
  });

  it('ist ohne WMS-Adresse abgeschaltet', async () => {
    const radar = new RadarService({ ...opts, wmsUrl: null }, fakeDwd().fetch);
    await expect(radar.frames()).rejects.toMatchObject({ statusCode: 404 });
  });
});
