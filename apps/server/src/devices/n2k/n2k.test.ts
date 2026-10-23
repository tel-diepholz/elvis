import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AirmarAdapter, type SerialLink } from '../drivers/airmar.js';
import { ActisenseDecoder, SET_RX_ALL_FRAME, composeFrame, composeN2k, type N2kMessage } from './actisense.js';
import { decodePgn } from './pgns.js';
import { WindStatistics } from './wind.js';

const msg = (pgn: number, data: number[] | Buffer, source = 35) => composeN2k({ priority: 2, pgn, source, destination: 255, data: Buffer.from(data) });

/** Hilfen zum Bauen von NMEA-2000-Nutzdaten */
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v);
  return [...b];
};

function decodeAll(frames: Buffer): N2kMessage[] {
  const out: N2kMessage[] = [];
  new ActisenseDecoder((m) => out.push(m)).push(frames);
  return out;
}

describe('Actisense-Rahmen (BST-93)', () => {
  it('setzt den Start-Befehl „Rx All“ wie canboat zusammen', () => {
    expect([...SET_RX_ALL_FRAME]).toEqual([0x10, 0x02, 0xa1, 0x03, 0x11, 0x02, 0x00, 0x49, 0x10, 0x03]);
  });

  it('dekodiert Nachrichten mit DLE-Stuffing in Daten und Prüfsumme', () => {
    const data = Buffer.from([0x10, 0x10, 0x01, 0x10, 0x02, 0x10, 0x03, 0xff]);
    const [m] = decodeAll(msg(130306, data, 0x10));
    expect(m).toMatchObject({ pgn: 130306, source: 0x10, priority: 2, destination: 255 });
    expect([...m!.data]).toEqual([...data]);
  });

  it('kommt mit beliebig zerstückelten Daten und Störbytes zurecht', () => {
    const stream = Buffer.concat([Buffer.from([0x00, 0x55, 0x10, 0x07]), msg(130306, [1, 2, 3, 4, 5, 6, 7, 8]), msg(127250, [9, 9, 9, 9, 9, 9, 9, 9])]);
    const out: N2kMessage[] = [];
    const dec = new ActisenseDecoder((m) => out.push(m));
    for (const b of stream) dec.push(Uint8Array.of(b));
    expect(out.map((m) => m.pgn)).toEqual([130306, 127250]);
  });

  it('verwirft Rahmen mit falscher Prüfsumme und ignoriert Gateway-Antworten', () => {
    const bad = msg(130306, [1, 2, 3, 4, 5, 6, 7, 8]);
    bad[bad.length - 3] = bad[bad.length - 3]! ^ 0x01; // Prüfsumme verfälschen
    const dec = new ActisenseDecoder(() => {
      throw new Error('darf nicht ankommen');
    });
    dec.push(bad);
    dec.push(composeFrame(0xa0, Uint8Array.from([0x11, 0x02, 0x00])));
    expect(dec.rejected).toBe(1);
  });
});

describe('PGN-Dekodierung (Airmar)', () => {
  it('Wind 130306: 5,25 m/s aus 90°, auf Nord bezogen', () => {
    const v = decodePgn(130306, Buffer.from([0, ...le16(525), ...le16(15708), 0xf8, 0xff, 0xff]));
    expect(v).toMatchObject({ pgn: 130306, speedMs: 5.25, reference: 'true-north' });
    expect((v as { angleDeg: number }).angleDeg).toBeCloseTo(90, 1);
  });

  it('Umwelt 130311 und Druck 130314', () => {
    const env = decodePgn(130311, Buffer.from([0, 0x41, ...le16(28515), ...le16(12500), ...le16(1013)]));
    expect(env).toMatchObject({ tempSource: 1, pressureHpa: 1013 });
    expect((env as { tempC: number }).tempC).toBeCloseTo(12, 5);
    expect((env as { humidityPercent: number }).humidityPercent).toBeCloseTo(50, 5);
    const p = decodePgn(130314, Buffer.from([0, 0, 0, ...le32(1013250), 0xff]));
    expect((p as { pressureHpa: number }).pressureHpa).toBeCloseTo(1013.25, 5);
  });

  it('meldet „nicht verfügbar“ als null', () => {
    const env = decodePgn(130311, Buffer.from([0, 0x01, 0xff, 0xff, 0xff, 0x7f, 0xff, 0xff]));
    expect(env).toMatchObject({ tempC: null, humidityPercent: null, pressureHpa: null });
  });

  it('Position 129025 und GNSS 129029 mit Fix', () => {
    expect(decodePgn(129025, Buffer.from([...le32(511657000), ...le32(104515000)]))).toMatchObject({ lat: 51.1657, lon: 10.4515 });
    const d = Buffer.alloc(43, 0xff);
    d.writeBigInt64LE(BigInt(511657000) * 1000000000n, 7);
    d.writeBigInt64LE(BigInt(104515000) * 1000000000n, 15);
    d[31] = (1 << 4) | 0; // Methode 1 = GNSS-Fix, Typ 0 = GPS
    d[33] = 9;
    const g = decodePgn(129029, d) as { lat: number; lon: number; fix: boolean; satellites: number };
    expect(g.fix).toBe(true);
    expect(g.satellites).toBe(9);
    expect(g.lat).toBeCloseTo(51.1657, 6);
    d[31] = 0; // kein GNSS
    expect((decodePgn(129029, d) as { fix: boolean }).fix).toBe(false);
  });

  it('Kurs 127250 magnetisch mit Missweisung', () => {
    const v = decodePgn(127250, Buffer.from([0, ...le16(31416), 0xff, 0x7f, ...le16(524), 0xfd])) as { headingDeg: number; variationDeg: number; reference: string };
    expect(v.reference).toBe('magnetic');
    expect(v.headingDeg).toBeCloseTo(180, 1);
    expect(v.variationDeg).toBeCloseTo(3, 1);
  });
});

describe('Wind-Statistik', () => {
  it('liefert Mittelwind, Böe (3-s-Mittel) und vektoriell gemittelte Richtung', () => {
    const w = new WindStatistics();
    for (let t = 0; t < 60_000; t += 1000) w.add(t, t >= 30_000 && t < 33_000 ? 12 : 4, (t / 1000) % 2 ? 350 : 10);
    const v = w.values(59_000);
    expect(v.meanMs).toBeCloseTo((57 * 4 + 3 * 12) / 60, 5);
    expect(v.gustMs).toBeCloseTo(12, 5);
    expect(Math.min(v.directionDeg!, 360 - v.directionDeg!)).toBeLessThan(2); // ~0°, nicht 180°
  });
});

class FakeLink extends EventEmitter {
  written: Buffer[] = [];
  closed = false;
  write(data: Buffer): void {
    this.written.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit('close');
  }
}

describe('Airmar-Treiber', () => {
  afterEach(() => vi.useRealTimers());
  const ctx = { log: { info: () => {}, warn: () => {}, error: () => {} }, getState: () => undefined };

  it('versetzt das Gateway in „Rx All“ und veröffentlicht Wind, Wetter und Position', async () => {
    let t = 1_000_000;
    const link = new FakeLink();
    const a = new AirmarAdapter({ port: '/dev/test' }, async () => link as unknown as SerialLink, () => t);
    await a.start(ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(link.written[0]).toEqual(SET_RX_ALL_FRAME);

    const feed = (b: Buffer) => link.emit('data', b);
    // Kurs 90° (wahr), scheinbarer Wind 6 m/s von 30° → aus 120°
    feed(msg(127250, [0, ...le16(15708), 0xff, 0x7f, 0xff, 0x7f, 0xfc]));
    feed(msg(130306, [0, ...le16(600), ...le16(5236), 0xfa, 0xff, 0xff]));
    feed(msg(130311, [0, 0x41, ...le16(28515), 0xff, 0x7f, ...le16(1009)]));
    feed(msg(129025, [...le32(511657000), ...le32(104515000)]));
    a.publish();
    const s = a.getState();
    expect(s.windSpeedMs).toBe(6);
    expect(s.windDirectionDeg).toBe(120);
    expect(s.temperatureC).toBe(12);
    expect(s.humidityPercent).toBeNull(); // 150WX ohne Feuchtemodul
    expect(s.pressureHpa).toBe(1009);
    expect(s.position).toMatchObject({ lat: 51.1657, lon: 10.4515, headingDeg: 90, fix: true });

    // Wahrer Wind (Nord) hat Vorrang vor scheinbarem
    t += 1000;
    feed(msg(130306, [0, ...le16(400), ...le16(0), 0xf8, 0xff, 0xff]));
    feed(msg(130306, [0, ...le16(900), ...le16(0), 0xfa, 0xff, 0xff]));
    a.publish();
    expect(a.getState().windSpeedMs).toBe(5); // Mittel aus 6 und 4, die 9 (scheinbar) wird ignoriert
    await a.stop();
  });

  it('filtert nach Quelladresse und verbindet sich nach Abbruch neu', async () => {
    vi.useFakeTimers();
    const links: FakeLink[] = [];
    const a = new AirmarAdapter({ port: '/dev/test', sourceAddress: 35 }, async () => {
      const l = new FakeLink();
      links.push(l);
      return l as unknown as SerialLink;
    });
    await a.start(ctx);
    await vi.advanceTimersByTimeAsync(0);
    links[0]!.emit('data', msg(130314, [0, 0, 0, ...le32(1013250), 0xff], 99)); // fremde Quelle
    a.publish();
    expect(a.getState().pressureHpa).toBeNull();
    links[0]!.emit('data', msg(130314, [0, 0, 0, ...le32(1013250), 0xff], 35));
    a.publish();
    expect(a.getState().pressureHpa).toBe(1013.3);

    // Funkstille: Gateway wird erneut auf „Rx All“ gestellt
    const before = links[0]!.written.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(links[0]!.written.length).toBeGreaterThan(before);
    expect(links[0]!.written.at(-1)).toEqual(SET_RX_ALL_FRAME);

    links[0]!.emit('error', new Error('USB getrennt'));
    expect(a.isOnline()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(links).toHaveLength(2);
    await a.stop();
  });
});
