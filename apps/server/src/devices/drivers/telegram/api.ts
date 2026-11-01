import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { Raw } from 'telegram/events/Raw.js';
import { LogLevel } from 'telegram/extensions/Logger.js';
import { generateRandomBigInt, returnBigInt } from 'telegram/Helpers.js';

/** Telegram-Nutzer mit Zugriffsschlüssel (ohne ihn lässt sich niemand anschreiben) */
export interface TgPeer {
  id: string;
  accessHash: string;
}

export interface TgIncoming {
  id: number;
  peer: TgPeer;
  /** Rufnummer, falls der Absender sie teilt (mit +) */
  phone: string | null;
  name: string | null;
  username: string | null;
  text: string;
  /** Lädt das Foto der Nachricht; null = kein Foto */
  photo: (() => Promise<Buffer | null>) | null;
  geo: { lat: number; lon: number; label: string } | null;
  /** Unix-Zeit in Sekunden */
  date: number;
}

export interface TgLogin {
  code: () => Promise<string>;
  password: (hint?: string) => Promise<string>;
  onError: (err: Error) => boolean;
}

/** Was der Treiber von Telegram braucht – für Tests ersetzbar */
export interface TelegramApi {
  connect(): Promise<void>;
  isAuthorized(): Promise<boolean>;
  login(phone: string, cb: TgLogin): Promise<void>;
  me(): Promise<{ id: string; phone: string | null; name: string }>;
  /** Sitzung zum Speichern */
  session(): string;
  onMessage(fn: (m: TgIncoming) => void): void;
  /** Gegenstelle hat bis maxId gelesen */
  onReadOutbox(fn: (peerId: string, maxId: number) => void): void;
  sendText(peer: TgPeer, text: string): Promise<number>;
  sendPhoto(peer: TgPeer, path: string, caption: string): Promise<number>;
  sendLocation(peer: TgPeer, lat: number, lon: number): Promise<number>;
  /** Rufnummern als Kontakte des Kontos übernehmen: wer Telegram nutzt, kommt mit Kennung zurück */
  importContacts(numbers: string[]): Promise<Map<string, TgPeer>>;
  resolveUsername(username: string): Promise<TgPeer>;
  disconnect(): Promise<void>;
}

const userPeer = (u: Api.User): TgPeer => ({ id: u.id.toString(), accessHash: u.accessHash?.toString() ?? '0' });

/** Kennung der gesendeten Nachricht aus der Antwort von messages.SendMedia */
function sentId(r: Api.TypeUpdates): number {
  const updates = 'updates' in r ? r.updates : [];
  for (const u of updates) {
    if (u instanceof Api.UpdateMessageID) return u.id;
    if (u instanceof Api.UpdateNewMessage) return u.message.id;
  }
  return 'id' in r && typeof r.id === 'number' ? r.id : 0;
}

/** Anbindung über gramjs (MTProto, Nutzerkonto) */
export function gramjsApi(o: { apiId: number; apiHash: string; session: string }): TelegramApi {
  const client = new TelegramClient(new StringSession(o.session), o.apiId, o.apiHash, { connectionRetries: 5, autoReconnect: true, deviceModel: 'ELVIS', appVersion: '1.0' });
  client.setLogLevel(LogLevel.ERROR);
  const input = (p: TgPeer) => new Api.InputPeerUser({ userId: returnBigInt(p.id), accessHash: returnBigInt(p.accessHash) });

  return {
    connect: async () => {
      await client.connect();
    },
    isAuthorized: () => client.checkAuthorization(),
    login: (phone, cb) => client.start({ phoneNumber: phone, phoneCode: cb.code, password: cb.password, onError: async (e) => cb.onError(e) }),
    me: async () => {
      const u = (await client.getMe()) as Api.User;
      return { id: u.id.toString(), phone: u.phone ? `+${u.phone}` : null, name: [u.firstName, u.lastName].filter(Boolean).join(' ') };
    },
    session: () => (client.session as StringSession).save(),
    onMessage(fn) {
      client.addEventHandler(async (e: NewMessageEvent) => {
        const m = e.message;
        if (!e.isPrivate || m.out) return;
        const sender = await m.getSender();
        if (!(sender instanceof Api.User) || sender.bot || sender.self) return;
        const media = m.media;
        let geo: TgIncoming['geo'] = null;
        if ((media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive) && media.geo instanceof Api.GeoPoint) geo = { lat: media.geo.lat, lon: media.geo.long, label: '' };
        if (media instanceof Api.MessageMediaVenue && media.geo instanceof Api.GeoPoint) geo = { lat: media.geo.lat, lon: media.geo.long, label: media.title };
        const photo =
          media instanceof Api.MessageMediaPhoto
            ? async () => {
                const b = await client.downloadMedia(m, {});
                return Buffer.isBuffer(b) ? b : null;
              }
            : null;
        fn({
          id: m.id,
          peer: userPeer(sender),
          phone: sender.phone ? `+${sender.phone}` : null,
          name: [sender.firstName, sender.lastName].filter(Boolean).join(' ') || null,
          username: sender.username ?? null,
          text: m.message ?? '',
          photo,
          geo,
          date: m.date,
        });
      }, new NewMessage({ incoming: true }));
    },
    onReadOutbox(fn) {
      client.addEventHandler(
        (u: Api.TypeUpdate) => {
          if (u instanceof Api.UpdateReadHistoryOutbox && u.peer instanceof Api.PeerUser) fn(u.peer.userId.toString(), u.maxId);
        },
        new Raw({ types: [Api.UpdateReadHistoryOutbox] }),
      );
    },
    sendText: async (p, text) => (await client.sendMessage(input(p), { message: text })).id,
    sendPhoto: async (p, path, caption) => (await client.sendFile(input(p), { file: path, caption, forceDocument: false })).id,
    sendLocation: async (p, lat, lon) =>
      sentId(await client.invoke(new Api.messages.SendMedia({ peer: input(p), media: new Api.InputMediaGeoPoint({ geoPoint: new Api.InputGeoPoint({ lat, long: lon }) }), message: '', randomId: generateRandomBigInt() }))),
    importContacts: async (numbers) => {
      const res = await client.invoke(
        new Api.contacts.ImportContacts({ contacts: numbers.map((n, i) => new Api.InputPhoneContact({ clientId: returnBigInt(i), phone: n, firstName: n, lastName: '(ELVIS)' })) }),
      );
      const users = new Map(res.users.filter((u): u is Api.User => u instanceof Api.User).map((u) => [u.id.toString(), u]));
      const out = new Map<string, TgPeer>();
      for (const imp of res.imported) {
        const u = users.get(imp.userId.toString());
        const n = numbers[imp.clientId.toJSNumber()];
        if (u && n) out.set(n, userPeer(u));
      }
      return out;
    },
    resolveUsername: async (username) => {
      const r = await client.invoke(new Api.contacts.ResolveUsername({ username }));
      const u = r.users.find((x): x is Api.User => x instanceof Api.User);
      if (!u) throw new Error(`@${username} ist kein Telegram-Nutzer`);
      return userPeer(u);
    },
    disconnect: () => client.destroy(),
  };
}
