import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MAX_PAGING_ZONES,
  MAX_PHONE_KEYS,
  PHONE_MODEL,
  dialableNumber,
  phoneConfigSchema,
  phoneKeySchema,
  type Contact,
  type Incident,
  type Phone,
  type PagingZone,
  type PhoneConfig,
  type PhoneConfigInput,
  type PhoneData,
  type PhoneKey,
  type PhoneKeySlot,
  type PhoneKeys,
  type PhoneModel,
  type PhonePush,
  type PhoneSystemStatus,
} from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { Logger } from '../devices/adapter.js';
import { HttpError } from '../errors.js';
import { xmlEscape, type PhonebookEntry } from './phonebook.js';

const CONFIG_KEY = 'phones:config';
const TOKEN_KEY = 'phones:token';
const ADMIN_KEY = 'phones:admin';
/** Benutzer der Weboberfläche der Telefone */
const ADMIN_USER = 'admin';
/** Telefone fragen zusätzlich regelmäßig nach (Sekunden) – falls eine Übertragung nicht ankam */
const REFRESH_S = 3600;
/** Tasten je Übertragung (die Weboberfläche der Telefone verträgt keine beliebig langen URLs) */
const PUSH_CHUNK = 12;
const PUSH_TIMEOUT_MS = 5000;
const PUSH_DELAY_MS = 300;
/** Einträge im Telefonbuch des Telefons (Snom D3xx: bis 2000) */
const MAX_TBOOK = 2000;

export type PhoneFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface PhoneDeps {
  contacts: () => Contact[];
  activeIncident: () => Incident | null;
  /** Kontakte als Telefonbuch-Einträge (services/phonebook.ts) – kommen ins Telefonbuch des Telefons */
  phonebook: () => PhonebookEntry[];
  log: Logger;
  fetch?: PhoneFetch;
  now?: () => number;
  pushDelayMs?: number;
}

interface Row {
  id: string;
  name: string;
  mac: string;
  model: string;
  extension: string;
  display_name: string;
  auth_user: string;
  sip_password: string;
  keys_json: string;
  last_seen_at: string | null;
  last_ip: string | null;
  firmware: string | null;
}

/** Wirksame Belegung einer Taste, wie sie am Telefon ankommt */
interface ResolvedKey {
  label: string;
  target: string;
  error: string | null;
}

/** Snom-MAC in der Abruf-URL ({mac}: 000413AABBCC) → aa:bb:cc:dd:ee:ff */
export function normalizeMac(raw: string): string | null {
  const hex = raw.toLowerCase().replace(/[-:.]/g, '');
  return /^[0-9a-f]{12}$/.test(hex) ? hex.replace(/(..)(?!$)/g, '$1:') : null;
}

const parseKeys = (json: string): PhoneKeys => {
  const out: PhoneKeys = {};
  for (const [idx, k] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    const parsed = phoneKeySchema.safeParse(k);
    if (parsed.success) out[Number(idx)] = parsed.data;
  }
  return out;
};

/** Mobilfunknummern (015x, 016x, 017x) bekommen im Telefonbuch das Handy-Symbol */
export const numberType = (n: string) => (/^(\+49|0049|0)1[5-7]/.test(n) ? 'mobile' : 'business');

/** Snom-Wert einer Durchsage-Zone (mc_address): immer über den Lautsprecher */
export const mcAddress = (z: PagingZone) =>
  `ip=${z.address},speaker=1,interrupt=${z.interrupt ? 1 : 0},volmax=${z.loud ? 1 : 0},priority=${z.priority},name=${z.name.replace(/\s*,\s*/g, ' ')}`;

/** mc_address-Platz i (ab 0), leer = Platz frei */
const zoneSetting = (config: PhoneConfig, i: number) => {
  const z = config.pagingZones[i];
  return z ? mcAddress(z) : '';
};

/** Kurzer Name für die Tastenbeschriftung: „Meyer, Hans“ bzw. die Einrichtung */
const shortName = (c: Contact) => (c.kind === 'organization' ? c.organization : [c.lastName, c.firstName].filter(Boolean).join(', ') || c.organization);

const toPhone = (r: Row, push: PhonePush | null): Phone => ({
  id: r.id,
  name: r.name,
  mac: r.mac,
  model: r.model as PhoneModel,
  extension: r.extension,
  displayName: r.display_name,
  authUser: r.auth_user,
  hasPassword: r.sip_password !== '',
  lastSeenAt: r.last_seen_at,
  lastIp: r.last_ip,
  firmware: r.firmware,
  push,
});

/**
 * Tischtelefone (Snom D385): Stammdaten, Tastenbelegung in drei Ebenen (Vorlage → Telefon → Einsatz) und die
 * Provisionierung. Das Telefon holt seine Konfiguration über eine URL mit geheimem Token (ohne Anmeldung) und
 * meldet dabei seine Adresse – an die überträgt ELVIS geänderte Tasten sofort über die Weboberfläche des Telefons.
 */
export class PhoneService {
  private readonly listeners = new Set<() => void>();
  private readonly pushes = new Map<string, PhonePush>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<PhonePush | null>>();
  private readonly fetch: PhoneFetch;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly deps: PhoneDeps,
  ) {
    this.fetch = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? Date.now;
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    this.listeners.forEach((l) => l());
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // --- Einstellungen ---

  private setting<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  private writeSetting(key: string, value: unknown, actor: string): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      )
      .run(key, JSON.stringify(value), new Date(this.now()).toISOString(), actor);
  }

  private secret(key: string): string {
    const v = this.setting<string>(key);
    if (v) return v;
    const fresh = randomBytes(18).toString('base64url');
    this.writeSetting(key, fresh, 'System');
    return fresh;
  }

  config(): PhoneConfig {
    return phoneConfigSchema.parse(this.setting<PhoneConfigInput>(CONFIG_KEY) ?? {});
  }

  status(): PhoneSystemStatus {
    return { config: this.config(), token: this.secret(TOKEN_KEY), adminUser: ADMIN_USER, adminPassword: this.secret(ADMIN_KEY) };
  }

  /** Gemeinsame Einstellungen ändern – Telefone übernehmen sie beim nächsten Abruf der Konfiguration */
  setConfig(input: PhoneConfig, actor: string): PhoneSystemStatus {
    this.writeSetting(CONFIG_KEY, input, actor);
    this.changed();
    // BLF-Tasten enthalten den SIP-Server
    this.schedulePush(this.list().map((p) => p.id));
    return this.status();
  }

  /** Neues Token – die bisherige Provisionierungs-URL gilt danach nicht mehr */
  regenerateToken(actor: string): PhoneSystemStatus {
    this.writeSetting(TOKEN_KEY, randomBytes(18).toString('base64url'), actor);
    return this.status();
  }

  // --- Telefone ---

  list(): Phone[] {
    return (this.db.prepare('SELECT * FROM phones ORDER BY name COLLATE NOCASE').all() as Row[]).map((r) => toPhone(r, this.pushes.get(r.id) ?? null));
  }

  get(id: string): Phone {
    const r = this.row(id);
    return toPhone(r, this.pushes.get(r.id) ?? null);
  }

  private row(id: string): Row {
    const r = this.db.prepare('SELECT * FROM phones WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new HttpError(404, 'Telefon nicht gefunden');
    return r;
  }

  private assertUnique(input: PhoneData, id: string | null): void {
    const mac = this.db.prepare('SELECT name FROM phones WHERE mac = ? AND id IS NOT ?').get(input.mac, id) as { name: string } | undefined;
    if (mac) throw new HttpError(409, `MAC-Adresse gehört schon zu „${mac.name}“`);
    const ext = this.db.prepare('SELECT name FROM phones WHERE extension = ? AND id IS NOT ?').get(input.extension, id) as { name: string } | undefined;
    if (ext) throw new HttpError(409, `Nebenstelle ${input.extension} gehört schon zu „${ext.name}“`);
  }

  create(input: PhoneData): Phone {
    this.assertUnique(input, null);
    const id = `ph-${randomBytes(4).toString('hex')}`;
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO phones (id, name, mac, model, extension, display_name, auth_user, sip_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.mac, input.model, input.extension, input.displayName, input.authUser, input.sipPassword ?? '', at, at);
    this.changed();
    return this.get(id);
  }

  update(id: string, input: PhoneData): Phone {
    const before = this.row(id);
    this.assertUnique(input, id);
    const password = input.sipPassword ? input.sipPassword : before.sip_password;
    this.db
      .prepare('UPDATE phones SET name = ?, mac = ?, model = ?, extension = ?, display_name = ?, auth_user = ?, sip_password = ?, updated_at = ? WHERE id = ?')
      .run(input.name, input.mac, input.model, input.extension, input.displayName, input.authUser, password, new Date(this.now()).toISOString(), id);
    // Tasten jenseits der Tastenzahl eines kleineren Modells fallen weg
    const max = PHONE_MODEL[input.model].keys;
    const keys = parseKeys(before.keys_json);
    if (Object.keys(keys).some((i) => Number(i) >= max)) {
      for (const i of Object.keys(keys)) if (Number(i) >= max) delete keys[Number(i)];
      this.db.prepare('UPDATE phones SET keys_json = ? WHERE id = ?').run(JSON.stringify(keys), id);
      this.db.prepare('DELETE FROM phone_key_overrides WHERE phone_id = ? AND idx >= ?').run(id, max);
    }
    this.changed();
    return this.get(id);
  }

  remove(id: string): Phone {
    const p = this.get(id);
    this.db.prepare('DELETE FROM phones WHERE id = ?').run(id);
    this.pushes.delete(id);
    this.changed();
    return p;
  }

  // --- Tastenbelegung ---

  template(): PhoneKeys {
    return parseKeys(JSON.stringify(this.setting<PhoneKeys>('phones:template') ?? {}));
  }

  private checkIdx(idx: number, max: number): void {
    if (!Number.isInteger(idx) || idx < 0 || idx >= max) throw new HttpError(400, `Taste ${idx + 1} gibt es nicht (1–${max})`);
  }

  /** Taste der Vorlage setzen (null = entfernen) */
  setTemplateKey(idx: number, key: PhoneKey | null, actor: string): PhoneKeySlot[] {
    this.checkIdx(idx, MAX_PHONE_KEYS);
    const t = this.template();
    if (key) t[idx] = key;
    else delete t[idx];
    this.writeSetting('phones:template', t, actor);
    this.changed();
    this.schedulePush(this.list().map((p) => p.id));
    return this.templateSlots();
  }

  /** Grundbelegung einer Taste am Telefon setzen (null = Vorlage gilt) */
  setPhoneKey(id: string, idx: number, key: PhoneKey | null): PhoneKeySlot[] {
    const r = this.row(id);
    this.checkIdx(idx, PHONE_MODEL[r.model as PhoneModel].keys);
    const keys = parseKeys(r.keys_json);
    if (key) keys[idx] = key;
    else delete keys[idx];
    this.db.prepare('UPDATE phones SET keys_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(keys), new Date(this.now()).toISOString(), id);
    this.changed();
    this.schedulePush([id]);
    return this.slots(id);
  }

  /** Taste nur für den laufenden Einsatz überschreiben (null = Überschreibung entfernen) */
  setOverride(id: string, idx: number, key: PhoneKey | null, actor: string): PhoneKeySlot[] {
    const r = this.row(id);
    this.checkIdx(idx, PHONE_MODEL[r.model as PhoneModel].keys);
    const incident = this.deps.activeIncident();
    if (!incident) throw new HttpError(409, 'Kein Einsatz aufgelegt – Tasten lassen sich nur für einen laufenden Einsatz überschreiben');
    if (key) {
      this.db
        .prepare(
          `INSERT INTO phone_key_overrides (phone_id, idx, incident_id, key_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(phone_id, idx) DO UPDATE SET incident_id = excluded.incident_id, key_json = excluded.key_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        )
        .run(id, idx, incident.id, JSON.stringify(key), actor, new Date(this.now()).toISOString());
    } else {
      this.db.prepare('DELETE FROM phone_key_overrides WHERE phone_id = ? AND idx = ?').run(id, idx);
    }
    this.changed();
    this.schedulePush([id]);
    return this.slots(id);
  }

  /** Alle Überschreibungen eines Telefons entfernen */
  clearOverrides(id: string): PhoneKeySlot[] {
    this.row(id);
    this.db.prepare('DELETE FROM phone_key_overrides WHERE phone_id = ?').run(id);
    this.changed();
    this.schedulePush([id]);
    return this.slots(id);
  }

  /** Einsatzende: Überschreibungen fallen weg, die Telefone bekommen wieder ihre Grundbelegung */
  incidentClosed(incidentId: number): void {
    const ids = (this.db.prepare('SELECT DISTINCT phone_id FROM phone_key_overrides WHERE incident_id = ?').all(incidentId) as { phone_id: string }[]).map((r) => r.phone_id);
    this.db.prepare('DELETE FROM phone_key_overrides WHERE incident_id = ?').run(incidentId);
    if (!ids.length) return;
    this.changed();
    this.schedulePush(ids);
  }

  /** Kontakte geändert: Telefone mit Kontakt-Tasten neu übertragen */
  contactsChanged(): void {
    const ids = this.list()
      .filter((p) => this.slots(p.id).some((s) => this.effective(s)?.type === 'contact'))
      .map((p) => p.id);
    if (!ids.length) return;
    this.changed();
    this.schedulePush(ids);
  }

  private overrides(id: string): PhoneKeys {
    const incident = this.deps.activeIncident();
    if (!incident) return {};
    const rows = this.db.prepare('SELECT idx, key_json FROM phone_key_overrides WHERE phone_id = ? AND incident_id = ?').all(id, incident.id) as { idx: number; key_json: string }[];
    const out: PhoneKeys = {};
    for (const r of rows) {
      const parsed = phoneKeySchema.safeParse(JSON.parse(r.key_json));
      if (parsed.success) out[r.idx] = parsed.data;
    }
    return out;
  }

  private effective(s: Pick<PhoneKeySlot, 'incident' | 'phone' | 'template'>): PhoneKey | null {
    return s.incident ?? s.phone ?? s.template;
  }

  private resolve(key: PhoneKey | null, contacts: Map<number, Contact>): ResolvedKey {
    if (!key || key.type === 'empty') return { label: '', target: '', error: null };
    if (key.type === 'number') return { label: key.label || key.number, target: dialableNumber(key.number), error: null };
    if (key.type === 'blf') return { label: key.label || key.extension, target: key.extension, error: null };
    if (key.type === 'paging') {
      if (!key.address) return { label: key.label || 'Durchsage', target: 'Zone wählen', error: null };
      const zone = this.config().pagingZones.find((z) => z.address === key.address);
      return { label: key.label || zone?.name || key.address, target: key.address, error: null };
    }
    const c = contacts.get(key.contactId);
    if (!c) return { label: key.label || 'Kontakt gelöscht', target: '', error: 'Kontakt gelöscht' };
    const phone = c.phones[key.phone];
    const number = phone ? dialableNumber(phone.number) : '';
    if (!number) return { label: key.label || shortName(c), target: '', error: 'Nummer im Kontakt fehlt' };
    return { label: key.label || shortName(c), target: number, error: null };
  }

  private buildSlots(max: number, layers: { incident: PhoneKeys; phone: PhoneKeys; template: PhoneKeys }): PhoneKeySlot[] {
    const contacts = new Map(this.deps.contacts().map((c) => [c.id, c]));
    return Array.from({ length: max }, (_, idx) => {
      const incident = layers.incident[idx] ?? null;
      const phone = layers.phone[idx] ?? null;
      const template = layers.template[idx] ?? null;
      const source = incident ? 'incident' : phone ? 'phone' : template ? 'template' : null;
      return { idx, incident, phone, template, source, ...this.resolve(incident ?? phone ?? template, contacts) };
    });
  }

  /** Alle Tasten eines Telefons mit Ebenen und wirksamer Belegung */
  slots(id: string): PhoneKeySlot[] {
    const r = this.row(id);
    return this.buildSlots(PHONE_MODEL[r.model as PhoneModel].keys, { incident: this.overrides(id), phone: parseKeys(r.keys_json), template: this.template() });
  }

  templateSlots(): PhoneKeySlot[] {
    return this.buildSlots(MAX_PHONE_KEYS, { incident: {}, phone: {}, template: this.template() });
  }

  /** Snom-Wert einer Funktionstaste */
  private fkey(slot: PhoneKeySlot, config: PhoneConfig): string {
    const key = this.effective(slot);
    if (!key || key.type === 'empty' || !slot.target) return 'none';
    if (key.type === 'blf') {
      const uri = `<sip:${slot.target}@${config.registrar}>`;
      return config.pickupPrefix ? `blf ${uri}|${config.pickupPrefix}` : `blf ${uri}`;
    }
    // Ohne Adresse: Liste der Zonen am Telefon
    if (key.type === 'paging') return key.address ? `multicast ${key.address}` : 'keyevent F_ZONES';
    return `speed ${slot.target}`;
  }

  // --- Provisionierung ---

  private checkToken(token: string): void {
    const a = Buffer.from(token);
    const b = Buffer.from(this.secret(TOKEN_KEY));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(404, 'Nicht gefunden');
  }

  /**
   * Konfiguration im Snom-XML-Format für das Telefon mit dieser MAC. Prüft das Token und merkt sich Adresse und
   * Firmware des Telefons (für die sofortige Übertragung von Tasten). `base` ist die Adresse, unter der das Telefon
   * ELVIS erreicht hat.
   */
  provisioningXml(token: string, rawMac: string, base: string, client: { ip: string; userAgent: string }): string {
    this.checkToken(token);
    const mac = normalizeMac(rawMac);
    const r = mac ? (this.db.prepare('SELECT * FROM phones WHERE mac = ?').get(mac) as Row | undefined) : undefined;
    if (!r) throw new HttpError(404, 'Nicht gefunden');

    // „Mozilla/4.0 (compatible; snom D385 10.1.141.13)“
    const firmware = /snom\s*\S+\s+([\d.]+)/i.exec(client.userAgent)?.[1] ?? null;
    const seen = r.last_ip !== client.ip || r.firmware !== firmware;
    this.db.prepare('UPDATE phones SET last_seen_at = ?, last_ip = ?, firmware = ? WHERE id = ?').run(new Date(this.now()).toISOString(), client.ip, firmware, r.id);
    if (seen) this.changed();

    const config = this.config();
    const status = this.status();
    // Steuerzeichen machen das XML ungültig; Leerzeichen bleiben (Passwörter)
    const e = (v: string) => xmlEscape(v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
    const setting = (name: string, value: string, idx?: number) => `    <${name}${idx === undefined ? '' : ` idx="${idx}"`} perm="R">${e(value)}</${name}>\n`;
    const settings = [
      setting('setting_server', `${base}/api/provisioning/${status.token}/snom/{mac}.xml`),
      setting('settings_refresh_timer', String(REFRESH_S)),
      setting('language', 'Deutsch'),
      setting('web_language', 'Deutsch'),
      setting('tone_scheme', 'GER'),
      setting('timezone', config.timezone),
      config.ntpServer ? setting('ntp_server', config.ntpServer) : '',
      setting('http_user', ADMIN_USER),
      setting('http_pass', status.adminPassword),
      setting('admin_mode_password', status.adminPassword),
      setting('user_active', 'on', 1),
      setting('user_realname', r.display_name || r.name, 1),
      setting('user_name', r.extension, 1),
      setting('user_pname', r.auth_user || r.extension, 1),
      setting('user_pass', r.sip_password, 1),
      setting('user_host', config.registrar, 1),
      setting('user_outbound', config.outboundProxy, 1),
      // Verzeichnistaste öffnet das Telefonbuch des Telefons (früher: XML-Seite mit den Kontakten)
      setting('dkey_directory', 'keyevent F_DIRECTORY_SEARCH'),
      setting('multicast_listen', config.pagingZones.length ? 'on' : 'off'),
      // Alle Plätze schreiben, damit entfernte Zonen auch am Telefon verschwinden
      ...Array.from({ length: MAX_PAGING_ZONES }, (_, i) => setting('mc_address', zoneSetting(config, i), i + 1)),
    ].join('');
    const keys = this.slots(r.id)
      .map((s) => `    <fkey idx="${s.idx}" context="active" label="${e(s.label)}" perm="R">${e(this.fkey(s, config))}</fkey>\n`)
      .join('');
    // complete="true": ersetzt das Telefonbuch des Telefons, gelöschte Kontakte verschwinden mit
    const tbook = this.deps
      .phonebook()
      .slice(0, MAX_TBOOK)
      .map((p) => `    <item context="line1" type="none">\n      <name>${e(p.name)}</name>\n      <number>${e(p.number)}</number>\n      <number_type>${numberType(p.number)}</number_type>\n    </item>\n`)
      .join('');
    return `<?xml version="1.0" encoding="utf-8"?>\n<settings>\n  <phone-settings e="2">\n${settings}  </phone-settings>\n  <functionKeys e="2">\n${keys}  </functionKeys>\n  <tbook e="2" complete="true">\n${tbook}  </tbook>\n</settings>\n`;
  }

  // --- Übertragung an das Telefon ---

  /** Übertragung gebündelt kurz nach der Änderung (mehrere Änderungen hintereinander → eine Übertragung) */
  private schedulePush(ids: string[]): void {
    for (const id of ids) {
      clearTimeout(this.timers.get(id));
      this.timers.set(
        id,
        setTimeout(() => {
          this.timers.delete(id);
          void this.push(id).catch((err) => this.deps.log.warn(`Telefon: Übertragung fehlgeschlagen: ${String(err)}`));
        }, this.deps.pushDelayMs ?? PUSH_DELAY_MS),
      );
    }
  }

  /**
   * Tasten über die Weboberfläche des Telefons setzen (dummy.htm?settings=save). Nur für Telefone, die ihre
   * Konfiguration schon einmal abgerufen haben (sonst ist die Adresse unbekannt). Fehler sind nicht schlimm: Beim
   * nächsten Abruf der Konfiguration ist das Telefon wieder auf dem Stand.
   */
  push(id: string): Promise<PhonePush | null> {
    const prev = this.running.get(id) ?? Promise.resolve(null);
    const next = prev.catch(() => null).then(() => this.pushNow(id));
    this.running.set(id, next);
    void next.finally(() => this.running.get(id) === next && this.running.delete(id)).catch(() => undefined);
    return next;
  }

  private async pushNow(id: string): Promise<PhonePush | null> {
    const r = this.db.prepare('SELECT * FROM phones WHERE id = ?').get(id) as Row | undefined;
    if (!r?.last_ip) return null;
    const config = this.config();
    const status = this.status();
    const slots = this.slots(id);
    this.setPush(id, { state: 'running', at: new Date(this.now()).toISOString(), error: null });
    const auth = `Basic ${Buffer.from(`${ADMIN_USER}:${status.adminPassword}`).toString('base64')}`;
    const host = r.last_ip.includes(':') ? `[${r.last_ip}]` : r.last_ip;
    try {
      for (let i = 0; i < slots.length; i += PUSH_CHUNK) {
        const params = new URLSearchParams({ settings: 'save', store_settings: 'save' });
        // Durchsage-Zonen gleich mit, damit neue Durchsage-Tasten sofort ein Ziel haben
        if (i === 0) {
          params.set('multicast_listen', config.pagingZones.length ? 'on' : 'off');
          for (let z = 0; z < MAX_PAGING_ZONES; z++) params.set(`mc_address${z + 1}`, zoneSetting(config, z));
        }
        for (const s of slots.slice(i, i + PUSH_CHUNK)) {
          params.set(`fkey${s.idx}`, this.fkey(s, config));
          params.set(`fkey_label${s.idx}`, s.label);
        }
        const res = await this.fetch(`http://${host}/dummy.htm?${params.toString()}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(res.status === 401 ? 'Zugang abgelehnt – Telefon neu starten, damit es die Konfiguration abruft' : `HTTP ${res.status}`);
      }
      return this.setPush(id, { state: 'ok', at: new Date(this.now()).toISOString(), error: null });
    } catch (err) {
      const msg = err instanceof Error ? (err.name === 'TimeoutError' ? 'Telefon antwortet nicht' : err.message) : String(err);
      return this.setPush(id, { state: 'failed', at: new Date(this.now()).toISOString(), error: msg });
    }
  }

  private setPush(id: string, p: PhonePush): PhonePush {
    this.pushes.set(id, p);
    this.changed();
    return p;
  }

  /** Telefon neu starten – es ruft dabei die komplette Konfiguration neu ab */
  async reboot(id: string): Promise<void> {
    const r = this.row(id);
    if (!r.last_ip) throw new HttpError(409, 'Adresse des Telefons unbekannt – es hat die Konfiguration noch nicht abgerufen');
    const auth = `Basic ${Buffer.from(`${ADMIN_USER}:${this.status().adminPassword}`).toString('base64')}`;
    const host = r.last_ip.includes(':') ? `[${r.last_ip}]` : r.last_ip;
    try {
      const res = await this.fetch(`http://${host}/confirm.html?REBOOT=yes`, { headers: { authorization: auth }, signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw new HttpError(502, `Neustart fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
