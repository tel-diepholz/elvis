import type { ChatLocation, ChatStatus, HookKind, MessengerId, MessengerSetupInput, RelayHook, RelayHookEvent } from '@elvis/shared';
import type { DeviceAdapter } from '../adapter.js';

/** Eingegangene Nachricht eines Messengers */
export interface IncomingChat {
  channel: MessengerId;
  /** Kennung der Gegenstelle im Dienst (Rufnummer im phoneKey-Format, Threema-ID, Telegram-ID …) */
  peer: string;
  /** Rufnummer der Gegenstelle, falls der Dienst sie liefert */
  number: string | null;
  /** Name, den der Dienst liefert (Profilname) */
  peerName: string | null;
  text: string;
  attachment: { name: string; mimeType: string; data: Buffer } | null;
  location: ChatLocation | null;
  /** Kennung der Nachricht beim Dienst – doppelte Zustellungen werden verworfen */
  externalId: string | null;
  receivedAt: string;
}

/** Zustellbestätigung einer gesendeten Nachricht */
export interface ChatReceipt {
  channel: MessengerId;
  externalId: string;
  status: Extract<ChatStatus, 'sent' | 'delivered' | 'read' | 'failed'>;
  error?: string | null;
}

/** Zu sendende Nachricht; der Treiber löst ggf. die Rufnummer in seine Kennung auf */
export interface OutgoingChat {
  /** WhatsApp: letzte Nachricht der Gegenstelle liegt unter 24 h zurück (freie Antwort erlaubt) */
  windowOpen?: boolean;
  peer: string;
  number: string | null;
  text: string;
  attachment: { name: string; mimeType: string; path: string } | null;
  location: ChatLocation | null;
}

export interface SendResult {
  externalId: string | null;
  /** Meldung fürs Bedienprotokoll */
  info: string;
}

/** Ergebnis einer Erreichbarkeitsprüfung: Kennung im Dienst bzw. null = nutzt den Messenger nicht */
export type ReachabilityResult = Map<string, { reachable: boolean; peer: string | null }>;

/** Zusätzlich zum Gerätevertrag: was die Nachrichten von einem Messenger-Treiber brauchen */
export interface MessengerAdapter<K extends MessengerId = MessengerId> extends DeviceAdapter<K> {
  sendMessage(msg: OutgoingChat): Promise<SendResult>;
  /** Nur bei capabilities.reachability; Rufnummern im phoneKey-Format */
  checkReachable?(numbers: string[]): Promise<ReachabilityResult>;
  /** Einrichtung (nur Admins, nicht im Bedienprotokoll mit Parametern): Konto koppeln, Code eingeben … */
  setup?(input: MessengerSetupInput): Promise<string | void>;
  /** Inhalt des QR-Codes bzw. Webhook-Adresse für die Einrichtung – nicht im öffentlichen Gerätezustand */
  setupDetails?(): { qr: string | null; webhook: { url: string; verifyToken: string | null } | null };
}

/** Webhooks über das Cloud-Relay (WhatsApp Cloud API, Threema Gateway) */
export interface HookSource {
  /** Relay eingerichtet (app.relayUrl) */
  readonly enabled: boolean;
  /** Webhook-Adresse beim Relay (legt sie beim ersten Mal an) */
  register(kind: HookKind): Promise<RelayHook>;
  subscribe(kind: HookKind, fn: (e: RelayHookEvent) => Promise<void>): () => void;
}

export const noHooks: HookSource = {
  enabled: false,
  register: () => Promise.reject(new Error('Kein Relay eingerichtet')),
  subscribe: () => () => {},
};

/** Kleiner Ablage-Speicher für Treiber (z. B. Telegram-Sitzung), in der Datenbank */
export interface DriverVault {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export function memoryVault(): DriverVault {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => (v === null ? m.delete(k) : m.set(k, v)) };
}

export const isMessengerAdapter = (a: DeviceAdapter | null | undefined): a is MessengerAdapter => !!a && typeof (a as Partial<MessengerAdapter>).sendMessage === 'function';

type Fn<T> = (v: T) => void;

/** Verbindet die Messenger-Treiber mit dem Nachrichtendienst (wie TelephonyBus für SMS) */
export class MessengerBus {
  private readonly messageListeners = new Set<Fn<IncomingChat>>();
  private readonly receiptListeners = new Set<Fn<ChatReceipt>>();

  onMessage(fn: Fn<IncomingChat>): () => void {
    this.messageListeners.add(fn);
    return () => this.messageListeners.delete(fn);
  }

  onReceipt(fn: Fn<ChatReceipt>): () => void {
    this.receiptListeners.add(fn);
    return () => this.receiptListeners.delete(fn);
  }

  message(v: IncomingChat): void {
    for (const fn of this.messageListeners) fn(v);
  }

  receipt(v: ChatReceipt): void {
    for (const fn of this.receiptListeners) fn(v);
  }
}
