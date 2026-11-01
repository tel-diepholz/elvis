import { z } from 'zod';
import { formatPhone, phoneKey, type TelephonyState } from '@elvis/shared';
import { CommandError, command } from '../adapter.js';
import type { TelephonyBus } from '../telephony/bus.js';
import { emptyTrunk } from '../drivers/yeastar/adapter.js';
import { SimAdapter, clamp, jitter } from './sim-adapter.js';

const SIM_NUMBERS = ['+491701234567', '+491609876543', '+4954415550', '+491515551234', '+4942129876'];
const SIM_SMS = [
  'Bitte Rückruf an Einsatzleiter.',
  'Wir sind in 10 Minuten an der Einsatzstelle.',
  'Verpflegung für 40 Personen ist bestellt, Lieferung gegen 14 Uhr.',
  'Lagemeldung: Wasserversorgung über lange Wegstrecke steht.',
];
const pick = <T>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)]!;

interface SimCall {
  id: string;
  direction: 'in' | 'out';
  port: number;
  number: string;
  startedAt: string;
  answeredAt: string | null;
  answerAt: number | null;
  endAt: number;
}

/** GSM-Gateway mit zwei Trunks: gelegentlich Anrufe und SMS, Senden klappt nach zwei Sekunden. */
export class TelephonySim extends SimAdapter<'telephony'> {
  protected readonly commands = {
    sendSms: command(z.object({ number: z.string().min(3), text: z.string().min(1).max(1000), port: z.number().int().optional() }), async ({ number, text, port }) => {
      const p = port ?? 1;
      if (!this.state.trunks.some((t) => t.port === p && t.status === 'up')) throw new CommandError(`GSM ${p} nicht verbunden`, 503);
      await new Promise((r) => setTimeout(r, 2000));
      if (text.includes('#fehler')) throw new CommandError('Netz lehnt ab (Simulation)', 502);
      return `SMS an ${formatPhone(number)} über ${this.state.trunks.find((t) => t.port === p)!.name} gesendet`;
    }),
    /** Zum Vorführen: eine SMS oder einen Anruf auslösen */
    simulate: command(z.object({ kind: z.enum(['sms', 'call']), number: z.string().optional(), text: z.string().optional() }), ({ kind, number, text }) => {
      if (kind === 'sms') this.bus.sms({ port: 1, number: phoneKey(number ?? pick(SIM_NUMBERS)), text: text ?? pick(SIM_SMS), receivedAt: new Date().toISOString() });
      else this.startCall(number);
    }),
  };
  private readonly calls = new Map<string, SimCall>();
  private seq = 0;
  private ticks = 0;
  private readonly createdAt = Date.now();

  constructor(
    private readonly bus: TelephonyBus,
    private readonly rate = 1,
  ) {
    super('telephony', {
      link: null,
      trunks: [
        { ...emptyTrunk(1, 'Telekom 1'), status: 'up', statusText: 'Power on, Up, Active, Standard', operator: 'Telekom.de', registration: 'Registered (Home network)', csq: 24, signalPercent: 77, rssiDbm: -65, ber: 0, model: 'Quectel EC21' },
        { ...emptyTrunk(2, 'Telekom 2'), status: 'up', statusText: 'Power on, Up, Active, Standard', operator: 'Telekom.de', registration: 'Registered (Home network)', csq: 19, signalPercent: 61, rssiDbm: -75, ber: 0, model: 'Quectel EC21' },
      ],
      sip: { reachable: true, registration: null, checkedAt: new Date().toISOString(), target: 'Simulation' },
      calls: [],
      capabilities: { sms: true },
    } satisfies TelephonyState);
  }

  private startCall(number?: string): void {
    const now = Date.now();
    const free = this.state.trunks.filter((t) => t.status === 'up' && ![...this.calls.values()].some((c) => c.port === t.port));
    if (!free.length) return;
    const answered = Math.random() < 0.75;
    const call: SimCall = {
      id: `sim-${++this.seq}`,
      direction: Math.random() < 0.6 ? 'in' : 'out',
      port: pick(free).port,
      number: phoneKey(number ?? pick(SIM_NUMBERS)),
      startedAt: new Date(now).toISOString(),
      answeredAt: null,
      answerAt: answered ? now + (3 + Math.random() * 8) * 1000 : null,
      endAt: now + (answered ? 30 + Math.random() * 150 : 15 + Math.random() * 10) * 1000,
    };
    this.calls.set(call.id, call);
  }

  protected tick(): void {
    const t = Date.now();
    // Im Schnitt etwa alle 20 Minuten ein Anruf und alle 30 Minuten eine SMS – erst nach drei Minuten, damit kurze
    // Läufe (Tests) keine zufälligen Tagebucheinträge bekommen
    const quiet = t - this.createdAt < 180_000;
    if (!quiet && Math.random() < this.rate / 1200) this.startCall();
    if (!quiet && Math.random() < this.rate / 1800) this.bus.sms({ port: 1, number: pick(SIM_NUMBERS), text: pick(SIM_SMS), receivedAt: new Date().toISOString() });
    for (const c of this.calls.values()) {
      if (c.answerAt !== null && !c.answeredAt && c.answerAt <= t) c.answeredAt = new Date(t).toISOString();
      if (c.endAt <= t) {
        this.calls.delete(c.id);
        this.bus.call({ direction: c.direction, port: c.port, number: c.number, startedAt: c.startedAt, answeredAt: c.answeredAt, endedAt: new Date(t).toISOString() });
      }
    }
    const signal = this.ticks++ % 10 === 0;
    const calls = [...this.calls.values()].map((c) => ({ id: c.id, direction: c.direction, port: c.port, number: c.number, name: null, startedAt: c.startedAt, answeredAt: c.answeredAt }));
    if (!signal && JSON.stringify(calls) === JSON.stringify(this.state.calls)) return;
    this.update((s) => {
      s.calls = calls;
      for (const tr of s.trunks) {
        tr.busy = calls.some((c) => c.port === tr.port);
        if (signal && tr.csq !== null) {
          tr.csq = Math.round(clamp(tr.csq + jitter(2), 10, 31));
          tr.signalPercent = Math.round((tr.csq / 31) * 100);
          tr.rssiDbm = -113 + 2 * tr.csq;
        }
      }
      if (signal) s.sip.checkedAt = new Date(t).toISOString();
    });
  }
}
