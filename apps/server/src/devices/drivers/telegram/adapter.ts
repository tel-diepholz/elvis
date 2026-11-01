import { isChatImage, phoneKey, type MessengerSetup, type MessengerSetupInput, type MessengerState } from '@elvis/shared';
import { BaseAdapter, CommandError, type AdapterContext } from '../../adapter.js';
import type { DriverVault, MessengerAdapter, MessengerBus, OutgoingChat, ReachabilityResult, SendResult } from '../../messaging/bus.js';
import { gramjsApi, type TelegramApi, type TgIncoming, type TgPeer } from './api.js';

export interface TelegramOptions {
  /** Von my.telegram.org → API development tools */
  apiId: number;
  apiHash: string;
  /** Rufnummer des Telegram-Kontos */
  phone: string;
}

const SESSION = 'telegram:session';
const PEERS = 'telegram:peers';
const START_HINT = 'Anmelden: Telegram schickt einen Code an die Telegram-App (bzw. per SMS), danach ggf. das Passwort der zweistufigen Bestätigung.';

class Cancelled extends Error {}

/**
 * Telegram als Nutzerkonto (MTProto über gramjs, kein Bot): Anmeldung mit Code und ggf. 2FA-Passwort in den
 * Einstellungen, die Sitzung bleibt in der Datenbank. Erreichbarkeit über den Kontaktimport des Kontos.
 */
export class TelegramAdapter extends BaseAdapter<'telegram'> implements MessengerAdapter<'telegram'> {
  protected readonly commands = {};
  private api: TelegramApi | null = null;
  private waiting: { step: 'code' | 'password'; resolve: (v: string) => void; reject: (e: Error) => void } | null = null;
  private loggingIn = false;
  private subscribed = false;
  /** Gesendete Nachrichten je Gegenstelle, die noch nicht gelesen sind (für Lesebestätigungen) */
  private unread = new Map<string, number[]>();

  constructor(
    private readonly opts: TelegramOptions,
    private readonly bus: MessengerBus,
    private readonly vault: DriverVault,
    private readonly factory: (session: string) => TelegramApi = (session) => gramjsApi({ apiId: opts.apiId, apiHash: opts.apiHash, session }),
  ) {
    super('telegram', 'mtproto', {
      status: 'connecting',
      account: null,
      link: { connected: false, target: 'Telegram (MTProto)', error: null, lastEventAt: null },
      capabilities: { images: true, files: true, location: true, reachability: true },
      setup: null,
    } satisfies MessengerState);
    this.online = false;
  }

  override async start(ctx: AdapterContext): Promise<void> {
    await super.start(ctx);
    if (!this.opts.apiId || !this.opts.apiHash || !this.opts.phone) {
      this.update((s) => {
        s.status = 'setup';
        s.setup = { step: 'info', hint: 'API-ID und API-Hash (my.telegram.org) sowie die Rufnummer des Kontos in den Moduleinstellungen eintragen.' };
      });
      return;
    }
    void this.connect();
  }

  override async stop(): Promise<void> {
    this.waiting?.reject(new Cancelled('Abgebrochen'));
    this.waiting = null;
    await this.api?.disconnect().catch(() => undefined);
    this.api = null;
  }

  private async connect(): Promise<void> {
    try {
      this.api = this.factory(this.vault.get(SESSION) ?? '');
      await this.api.connect();
      this.setOnline(true);
      if (await this.api.isAuthorized()) return await this.ready();
      this.setSetup({ step: 'start', hint: START_HINT }, 'setup');
    } catch (e) {
      this.setOnline(false);
      this.update((s) => {
        s.status = 'error';
        s.link = { ...s.link!, connected: false, error: e instanceof Error ? e.message : String(e) };
      });
    }
  }

  private setSetup(setup: MessengerSetup | null, status?: MessengerState['status']): void {
    this.update((s) => {
      s.setup = setup;
      if (status) s.status = status;
      s.link = { ...s.link!, connected: true, error: null };
    });
  }

  /** Angemeldet: Konto übernehmen, Sitzung sichern, Ereignisse abonnieren */
  private async ready(): Promise<void> {
    const api = this.api!;
    const me = await api.me();
    this.vault.set(SESSION, api.session());
    if (!this.subscribed) {
      this.subscribed = true;
      api.onMessage((m) => void this.incoming(m).catch((e) => this.ctx.log.warn(`Telegram: Nachricht nicht verarbeitet: ${e instanceof Error ? e.message : String(e)}`)));
      api.onReadOutbox((peerId, maxId) => this.readOutbox(peerId, maxId));
    }
    this.update((s) => {
      s.status = 'connected';
      s.account = me.phone ? phoneKey(me.phone) : me.name;
      s.setup = null;
      s.link = { ...s.link!, connected: true, error: null };
    });
  }

  // --- Gegenstellen (Zugriffsschlüssel) ---

  private peers(): Record<string, string> {
    try {
      return JSON.parse(this.vault.get(PEERS) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  }

  private remember(p: TgPeer): void {
    const all = this.peers();
    if (all[p.id] === p.accessHash) return;
    all[p.id] = p.accessHash;
    this.vault.set(PEERS, JSON.stringify(all));
  }

  /** Telegram-ID, Benutzername oder Rufnummer → anschreibbare Gegenstelle */
  private async resolve(msg: Pick<OutgoingChat, 'peer' | 'number'>): Promise<TgPeer> {
    const api = this.need();
    if (/^\d+$/.test(msg.peer)) {
      const hash = this.peers()[msg.peer];
      if (hash) return { id: msg.peer, accessHash: hash };
    }
    if (msg.number) {
      const found = (await api.importContacts([msg.number])).get(msg.number);
      if (!found) throw new CommandError(`Telegram: ${msg.number} nutzt kein Telegram`, 404);
      this.remember(found);
      return found;
    }
    if (!/^\d+$/.test(msg.peer)) {
      const p = await api.resolveUsername(msg.peer.replace(/^@/, ''));
      this.remember(p);
      return p;
    }
    throw new CommandError('Telegram: Gegenstelle unbekannt – zuerst muss sie schreiben oder ihre Rufnummer bekannt sein', 404);
  }

  private need(): TelegramApi {
    if (!this.api || this.state.status !== 'connected') throw new CommandError('Telegram ist nicht angemeldet', 409);
    return this.api;
  }

  // --- Eingang ---

  async incoming(m: TgIncoming): Promise<void> {
    this.remember(m.peer);
    let attachment: { name: string; mimeType: string; data: Buffer } | null = null;
    if (m.photo) {
      const data = await m.photo().catch(() => null);
      if (data) attachment = { name: `telegram-${m.id}.jpg`, mimeType: 'image/jpeg', data };
    }
    if (!m.text && !attachment && !m.geo) return;
    this.update((s) => {
      s.link = { ...s.link!, lastEventAt: new Date().toISOString() };
    });
    this.bus.message({
      channel: 'telegram',
      peer: m.peer.id,
      number: m.phone ? phoneKey(m.phone) : null,
      peerName: m.name ?? (m.username ? `@${m.username}` : null),
      text: m.text,
      attachment,
      location: m.geo,
      externalId: `${m.peer.id}:${m.id}`,
      receivedAt: new Date(m.date * 1000).toISOString(),
    });
  }

  private readOutbox(peerId: string, maxId: number): void {
    const ids = this.unread.get(peerId) ?? [];
    const read = ids.filter((id) => id <= maxId);
    this.unread.set(
      peerId,
      ids.filter((id) => id > maxId),
    );
    for (const id of read) this.bus.receipt({ channel: 'telegram', externalId: `${peerId}:${id}`, status: 'read' });
  }

  // --- Senden ---

  async sendMessage(msg: OutgoingChat): Promise<SendResult> {
    const api = this.need();
    const peer = await this.resolve(msg);
    let id: number;
    if (msg.attachment && isChatImage(msg.attachment.mimeType)) id = await api.sendPhoto(peer, msg.attachment.path, msg.text);
    else if (msg.attachment) id = await api.sendDocument(peer, msg.attachment.path, msg.attachment.name, msg.text);
    else if (msg.text) id = await api.sendText(peer, msg.text);
    else id = 0;
    if (msg.location) {
      const loc = await api.sendLocation(peer, msg.location.lat, msg.location.lon);
      if (!id) id = loc;
    }
    this.unread.set(peer.id, [...(this.unread.get(peer.id) ?? []), id]);
    return { externalId: `${peer.id}:${id}`, info: `Telegram an ${msg.number ?? msg.peer} gesendet` };
  }

  async checkReachable(numbers: string[]): Promise<ReachabilityResult> {
    const found = await this.need().importContacts(numbers);
    const out: ReachabilityResult = new Map();
    for (const n of numbers) {
      const p = found.get(n);
      if (p) this.remember(p);
      out.set(n, p ? { reachable: true, peer: p.id } : { reachable: false, peer: null });
    }
    return out;
  }

  // --- Einrichtung ---

  private wait(step: 'code' | 'password', hint: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiting = { step, resolve, reject };
      this.setSetup({ step, hint, error: this.state.setup?.error ?? null }, 'setup');
    });
  }

  async setup(input: MessengerSetupInput): Promise<string | void> {
    switch (input.action) {
      case 'login': {
        if (!this.api) throw new CommandError('Telegram ist nicht verbunden', 409);
        if (this.state.status === 'connected') return 'Bereits angemeldet';
        if (this.loggingIn) return;
        this.loggingIn = true;
        const api = this.api;
        api
          .login(this.opts.phone, {
            code: () => this.wait('code', `Code eingeben, den Telegram an ${this.opts.phone} geschickt hat (in der Telegram-App, sonst per SMS).`),
            password: (hint) => this.wait('password', `Passwort der zweistufigen Bestätigung eingeben${hint ? ` (Hinweis: ${hint})` : ''}.`),
            onError: (e) => {
              if (e instanceof Cancelled) return true;
              this.update((s) => {
                s.setup = { ...(s.setup ?? { step: 'start', hint: START_HINT }), error: telegramError(e) };
              });
              // Bei falschem Code oder Passwort fragt gramjs erneut, andere Fehler beenden die Anmeldung
              return !/PHONE_CODE_INVALID|PASSWORD_HASH_INVALID|PHONE_CODE_EMPTY/.test(e.message);
            },
          })
          .then(() => this.ready())
          .catch((e) => {
            if (!(e instanceof Cancelled)) this.setSetup({ step: 'start', hint: START_HINT, error: telegramError(e) }, 'setup');
          })
          .finally(() => {
            this.loggingIn = false;
            this.waiting = null;
          });
        return 'Anmeldung gestartet';
      }
      case 'code':
      case 'password': {
        const w = this.waiting;
        const value = input.action === 'code' ? input.code : input.password;
        if (!w || w.step !== input.action) throw new CommandError(input.action === 'code' ? 'Telegram wartet nicht auf einen Code' : 'Telegram wartet nicht auf ein Passwort', 409);
        if (!value) throw new CommandError(input.action === 'code' ? 'Code fehlt' : 'Passwort fehlt', 400);
        this.waiting = null;
        this.update((s) => {
          s.setup = { ...s.setup!, hint: 'Wird geprüft …', error: null };
        });
        w.resolve(input.action === 'code' ? value.replace(/\D/g, '') : value);
        return;
      }
      case 'cancel':
        this.waiting?.reject(new Cancelled('Abgebrochen'));
        this.waiting = null;
        this.setSetup(this.state.status === 'connected' ? null : { step: 'start', hint: START_HINT });
        return;
      case 'logout':
        this.vault.set(SESSION, null);
        this.vault.set(PEERS, null);
        await this.stop();
        this.subscribed = false;
        this.update((s) => {
          s.status = 'connecting';
          s.account = null;
        });
        void this.connect();
        return 'Telegram-Sitzung gelöscht';
      default:
        throw new CommandError(`Telegram kennt die Aktion „${input.action}“ nicht`, 400);
    }
  }
}

/** Fehlermeldungen von Telegram verständlich machen */
export function telegramError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/PHONE_CODE_INVALID/.test(m)) return 'Code falsch';
  if (/PHONE_CODE_EXPIRED/.test(m)) return 'Code abgelaufen – erneut anmelden';
  if (/PASSWORD_HASH_INVALID/.test(m)) return 'Passwort falsch';
  if (/PHONE_NUMBER_INVALID/.test(m)) return 'Rufnummer ungültig (Moduleinstellungen)';
  if (/API_ID_INVALID/.test(m)) return 'API-ID oder API-Hash ungültig (Moduleinstellungen)';
  const flood = /FLOOD_WAIT_(\d+)|wait of (\d+) seconds/i.exec(m);
  if (flood) return `Telegram drosselt – in ${Math.ceil(Number(flood[1] ?? flood[2]) / 60)} min erneut versuchen`;
  return m;
}
