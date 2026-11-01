/** Eingegangene SMS (mehrteilige schon zusammengesetzt) */
export interface IncomingSms {
  port: number | null;
  number: string;
  text: string;
  receivedAt: string;
}

/** Beendetes Gespräch, wie es der Treiber erkannt hat */
export interface EndedCall {
  direction: 'in' | 'out';
  port: number | null;
  number: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string;
}

type Fn<T> = (v: T) => void;

/**
 * Verbindet den Telefonie-Treiber mit den Diensten (SMS-Postfach, Anrufliste): Der Treiber entsteht vor den
 * Diensten und kennt sie nicht, die Dienste melden sich hier an.
 */
export class TelephonyBus {
  private readonly smsListeners = new Set<Fn<IncomingSms>>();
  private readonly callListeners = new Set<Fn<EndedCall>>();

  onSms(fn: Fn<IncomingSms>): () => void {
    this.smsListeners.add(fn);
    return () => this.smsListeners.delete(fn);
  }

  onCall(fn: Fn<EndedCall>): () => void {
    this.callListeners.add(fn);
    return () => this.callListeners.delete(fn);
  }

  sms(v: IncomingSms): void {
    for (const fn of this.smsListeners) fn(v);
  }

  call(v: EndedCall): void {
    for (const fn of this.callListeners) fn(v);
  }
}
