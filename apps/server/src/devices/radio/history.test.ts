import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot, RadioActivity } from '@elvis/shared';
import { RadioHistory } from './history.js';

const entry = (id: string, start: string, end: string | null): RadioActivity => ({
  id,
  deviceId: 'fug-1',
  kind: 'rx',
  start,
  end,
  peer: '6122101',
  text: null,
});

describe('Funk: Verlauf für die Timeline', () => {
  it('sammelt die Aktivität aus dem Gerätezustand, aktualisiert laufende Einträge und behält beendete', () => {
    let emit: (s: DeviceSnapshot) => void = () => {};
    const history = new RadioHistory({ onDevice: (l) => ((emit = l), () => {}) });
    const snap = (activity: RadioActivity[]) => ({ id: 'radio', state: { activity } }) as unknown as DeviceSnapshot;
    const t0 = new Date(Date.now() - 60_000).toISOString();
    const t1 = new Date(Date.now() - 30_000).toISOString();

    emit(snap([entry('a', t0, null)]));
    emit({ id: 'weather', state: {} } as unknown as DeviceSnapshot);
    expect(history.list()).toEqual([entry('a', t0, null)]);
    emit(snap([entry('a', t0, t1), entry('b', t1, null)]));
    // aus dem Gerätezustand herausgefallen, im Verlauf noch da
    emit(snap([entry('b', t1, t1)]));
    expect(history.list().map((a) => [a.id, a.end])).toEqual([
      ['a', t1],
      ['b', t1],
    ]);
    // „seit“: alles, was danach noch lief
    expect(history.list(new Date(Date.now() - 45_000).toISOString()).map((a) => a.id)).toEqual(['a', 'b']);
    expect(history.list(new Date(Date.now() - 20_000).toISOString())).toEqual([]);
  });
});
