import type { IncomingMessage } from 'node:http';
import type { CameraCaps, CameraPosition, DayNightMode } from '@elvis/shared';
import { AxisError, AxisHttp, parseKeyValues, type AxisConnection } from './http.js';

export interface CameraProbe {
  model: string | null;
  caps: CameraCaps;
  /** Welche Schnittstelle Zoom/Fokus/Tag-Nacht übernimmt und Hinweise der Erkennung (für „Verbindung testen“) */
  notes?: string[];
}

export interface CameraReading {
  position: CameraPosition;
  dayNight: DayNightMode | null;
}

/**
 * Wege zur Objektivsteuerung: Optics Control API (neuere Kameras), ptz.cgi (PTZ-Kameras) oder
 * opticssetup.cgi (ältere feste Kameras mit Motorobjektiv, z. B. P3225-LVE Mk II).
 */
type LensApi = 'optics' | 'ptz' | 'setup';

/** Gemeinsame Schnittstelle aller Kameratypen. Geschwindigkeiten -100 … 100. */
export interface CameraClient {
  probe(): Promise<CameraProbe>;
  read(): Promise<CameraReading>;
  move(pan: number, tilt: number, zoom: number): Promise<void>;
  stop(): Promise<void>;
  zoomStep(direction: 1 | -1, big: boolean): Promise<void>;
  focusStep(direction: 1 | -1, big: boolean): Promise<void>;
  autofocus(): Promise<void>;
  setDayNight(mode: DayNightMode): Promise<void>;
  home(): Promise<void>;
  goto(p: CameraPosition): Promise<void>;
  /** MJPEG-Livebild; null = kein Bild (z. B. Demo-Kamera) */
  openStream(kind: 'live' | 'thumb', resolution: string): Promise<IncomingMessage | null>;
}

export const NO_CAPS: CameraCaps = { panTilt: false, zoom: false, continuousZoom: false, focus: false, autofocus: false, dayNight: false, home: false, zoomUnit: null };

const IR_TO_MODE: Record<string, DayNightMode> = { on: 'day', off: 'night', auto: 'auto' };
const MODE_TO_IR: Record<DayNightMode, string> = { day: 'on', night: 'off', auto: 'auto' };
const num = (v: string | undefined) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const round = (v: number | null, d: number) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

interface OpticsCaps {
  numberOfOptics: number;
  optics: { opticsId: string; capabilities: string[]; maxMagnification?: number }[];
}
interface OpticsState {
  optics: { opticsId: string; focusPosition?: number; magnification?: number; irCutFilterState?: string }[];
}

/** Attribute eines XML-Elements, z. B. <opticsSetupState zoomPosition="0.95" …/> */
export function xmlAttributes(xml: string, element: string): Record<string, string> {
  const m = new RegExp(`<${element}\\b([^>]*)>`).exec(xml);
  const out: Record<string, string> = {};
  if (m) for (const a of m[1]!.matchAll(/([\w:]+)="([^"]*)"/g)) out[a[1]!] = a[2]!;
  return out;
}

const PARAM_IRCUT = 'ImageSource.I0.DayNight.IrCutFilter';
const PARAM_TO_MODE: Record<string, DayNightMode> = { yes: 'day', no: 'night', auto: 'auto' };
const MODE_TO_PARAM: Record<DayNightMode, string> = { day: 'yes', night: 'no', auto: 'auto' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Axis-Kamera über VAPIX. Was die Kamera kann, wird beim Verbinden ermittelt:
 * - Objektiv: Optics Control API (neuere Kameras), ptz.cgi (PTZ-Kameras) oder opticssetup.cgi (ältere feste
 *   Kameras mit Motorobjektiv wie P3225-LVE Mk II – dort nur relative Befehle, Werte 0…1)
 * - Tag/Nacht: Optics Control, ptz.cgi oder der Parameter ImageSource.I0.DayNight.IrCutFilter
 * ptz.cgi zählt nur, wenn die Kamera ihre Befehlsliste liefert: feste Kameras melden dort Standardgrenzen
 * (sogar Schwenken), antworten auf info=1 aber mit „PTZ disabled“.
 */
export class AxisCamera implements CameraClient {
  readonly http: AxisHttp;
  /** Welche Schnittstelle welche Funktion übernimmt */
  private api = { panTilt: false, zoom: null as LensApi | null, focus: null as LensApi | null, dayNight: null as 'optics' | 'ptz' | 'param' | null };
  private opticsId = '0';
  private opticsVersion = '1.0';
  private ptzCommandSet = new Set<string>();

  constructor(connection: AxisConnection, http?: AxisHttp) {
    this.http = http ?? new AxisHttp(connection);
  }

  private optics<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.http.json<T>('/axis-cgi/opticscontrol.cgi', { apiVersion: this.opticsVersion, method, ...(params && { params: { optics: [{ opticsId: this.opticsId, ...params }] } }) });
  }

  private async ptz(query: string): Promise<void> {
    const r = await this.http.send('GET', `/axis-cgi/com/ptz.cgi?camera=1&${query}`);
    if (r.status >= 300) throw new AxisError(`PTZ-Befehl abgelehnt (HTTP ${r.status})`, r.status);
    const text = r.body.toString('utf8');
    // z. B. „Error:\r\nrfocus: unsupported“
    if (/^Error/im.test(text)) throw new AxisError(`Kamera lehnt ab: ${text.replace(/^Error:?/i, '').replace(/\s+/g, ' ').trim()}`, 400);
  }

  /** opticssetup.cgi; Erfolg = „ok“, Fehler = HTTP 400 mit Klartext */
  private async setup(query: string): Promise<string> {
    const r = await this.http.send('GET', `/axis-cgi/opticssetup.cgi?${query}`);
    const text = r.body.toString('utf8');
    if (r.status >= 300 || /^\s*Error/i.test(text)) throw new AxisError(`Kamera lehnt ab: ${text.replace(/^\s*Error:?/i, '').replace(/\s+/g, ' ').trim() || `HTTP ${r.status}`}`, r.status >= 300 ? r.status : 400);
    return text;
  }

  private async setupState(): Promise<Record<string, string>> {
    return xmlAttributes(await this.setup('monitor=poll'), 'opticsSetupState');
  }

  /**
   * Optics Control API: unterstützte Version erfragen und Fähigkeiten lesen. Die Version wird als
   * „<Major>.<Minor>“ erwartet; ohne Antwort auf getSupportedVersions werden gängige Versionen probiert.
   */
  private async probeOptics(notes: string[]): Promise<OpticsCaps['optics'][number] | null> {
    const path = '/axis-cgi/opticscontrol.cgi';
    let candidates = ['1.2', '1.1', '1.0'];
    try {
      const v = await this.http.json<{ apiVersions?: string[] }>(path, { method: 'getSupportedVersions' });
      const sorted = (v.apiVersions ?? []).filter((x) => /^\d+\.\d+$/.test(x)).sort((a, b) => {
        const [am, an] = a.split('.').map(Number);
        const [bm, bn] = b.split('.').map(Number);
        return bm! - am! || bn! - an!;
      });
      if (sorted.length) candidates = sorted;
    } catch (err) {
      if (err instanceof AxisError && err.status === 404) return null;
    }
    let lastError = '';
    for (const version of candidates) {
      try {
        const c = await this.http.json<OpticsCaps>(path, { apiVersion: version, method: 'getCapabilities' });
        this.opticsVersion = version;
        return c.optics?.[0] ?? null;
      } catch (err) {
        lastError = (err as Error).message;
        if (err instanceof AxisError && err.status === 404) return null;
      }
    }
    notes.push(`Optics Control nicht nutzbar: ${lastError}`);
    return null;
  }

  /** Befehlsliste von ptz.cgi (info=1); null = keine oder abgeschaltete PTZ-Schnittstelle */
  private async probePtz(notes: string[]): Promise<Set<string> | null> {
    const text = await this.http.text('/axis-cgi/com/ptz.cgi?camera=1&info=1').catch(() => null);
    if (text === null) return null;
    if (/^\s*Error/i.test(text)) {
      notes.push(`ptz.cgi: ${text.replace(/^\s*Error:?/i, '').replace(/\s+/g, ' ').trim()}`);
      return null;
    }
    return new Set([...text.matchAll(/^\s*\{?([a-z]+)=/gm)].map((m) => m[1]!));
  }

  /** opticssetup.cgi?monitor=poll liefert XML mit zoomPosition/focusPosition (0…1) */
  private async probeOpticsSetup(): Promise<{ zoom: boolean; focus: boolean } | null> {
    const r = await this.http.send('GET', '/axis-cgi/opticssetup.cgi?monitor=poll').catch(() => null);
    if (!r || r.status >= 300) return null;
    const a = xmlAttributes(r.body.toString('utf8'), 'opticsSetupState');
    return { zoom: num(a.zoomPosition) !== null, focus: num(a.focusPosition) !== null };
  }

  private async readIrCutParam(): Promise<string | null> {
    const kv = parseKeyValues(await this.http.text(`/axis-cgi/param.cgi?action=list&group=${PARAM_IRCUT}`).catch(() => ''));
    return kv[`root.${PARAM_IRCUT}`] ?? kv[PARAM_IRCUT] ?? null;
  }

  /** Liste aller Schnittstellen der Kamera (API Discovery) – zur Diagnose */
  private async apiList(): Promise<string | null> {
    try {
      const d = await this.http.json<{ apiList?: { id: string; version: string }[] }>('/axis-cgi/apidiscovery.cgi', { apiVersion: '1.0', method: 'getApiList' });
      return (d.apiList ?? []).map((a) => `${a.id} ${a.version}`).sort().join(', ') || null;
    } catch {
      return null;
    }
  }

  async probe(): Promise<CameraProbe> {
    // Modell – zugleich Test von Erreichbarkeit und Anmeldung
    const brand = parseKeyValues(await this.http.text('/axis-cgi/param.cgi?action=list&group=Brand'));
    const model = brand['root.Brand.ProdShortName'] ?? brand['root.Brand.ProdFullName'] ?? null;
    const notes: string[] = [];

    const optics = await this.probeOptics(notes);
    if (optics) this.opticsId = optics.opticsId;
    const oc = new Set(optics?.capabilities ?? []);
    const ptz = await this.probePtz(notes);
    this.ptzCommandSet = ptz ?? new Set();
    const has = (...cmds: string[]) => !!ptz && cmds.every((c) => ptz.has(c));
    const needSetup = (!oc.has('zoom') && !has('rzoom')) || (!oc.has('focus') && !has('rfocus'));
    const setup = needSetup ? await this.probeOpticsSetup() : null;
    const irParam = !oc.has('irCutFilter') && !has('ircutfilter') ? await this.readIrCutParam() : null;

    this.api = {
      panTilt: has('continuouspantiltmove'),
      zoom: oc.has('zoom') ? 'optics' : has('rzoom') ? 'ptz' : setup?.zoom ? 'setup' : null,
      focus: oc.has('focus') ? 'optics' : has('rfocus') ? 'ptz' : setup?.focus ? 'setup' : null,
      dayNight: oc.has('irCutFilter') ? 'optics' : has('ircutfilter') ? 'ptz' : irParam && irParam in PARAM_TO_MODE ? 'param' : null,
    };

    const via = (a: LensApi | 'param' | null) =>
      a === 'optics' ? `Optics Control ${this.opticsVersion}` : a === 'ptz' ? 'ptz.cgi' : a === 'setup' ? 'opticssetup.cgi' : a === 'param' ? 'param.cgi' : null;
    const used = ([['Zoom', this.api.zoom], ['Fokus', this.api.focus], ['Tag/Nacht', this.api.dayNight]] as const).filter(([, a]) => a).map(([label, a]) => `${label} über ${via(a)}`);
    // Diagnose, wenn Objektivfunktionen fehlen: was bietet die Kamera stattdessen an?
    if (!this.api.zoom || !this.api.focus) {
      notes.push(setup ? 'opticssetup.cgi: ohne Zoom-/Fokuswerte' : 'opticssetup.cgi: nicht vorhanden');
      const apis = await this.apiList();
      if (apis) notes.push(`Schnittstellen der Kamera: ${apis}`);
    }
    notes.unshift(...used);

    const autofocus = this.api.focus === 'optics' || this.api.focus === 'setup' || (this.api.focus === 'ptz' && has('autofocus'));
    return {
      model,
      caps: {
        panTilt: this.api.panTilt,
        zoom: this.api.zoom !== null,
        continuousZoom: this.api.zoom === 'ptz' && has('continuouszoommove'),
        focus: this.api.focus !== null,
        autofocus,
        dayNight: this.api.dayNight !== null,
        home: this.api.panTilt && has('move'),
        zoomUnit: this.api.zoom === 'optics' ? 'factor' : this.api.zoom === 'setup' ? 'fraction' : this.api.zoom === 'ptz' ? 'steps' : null,
      },
      notes,
    };
  }

  async read(): Promise<CameraReading> {
    const position: CameraPosition = { pan: null, tilt: null, zoom: null, focus: null };
    let dayNight: DayNightMode | null = null;
    if (this.api.panTilt || this.api.zoom === 'ptz' || this.api.focus === 'ptz' || this.api.dayNight === 'ptz') {
      const p = parseKeyValues(await this.http.text('/axis-cgi/com/ptz.cgi?camera=1&query=position'));
      if (this.api.panTilt) Object.assign(position, { pan: round(num(p.pan), 2), tilt: round(num(p.tilt), 2) });
      if (this.api.zoom === 'ptz') position.zoom = num(p.zoom);
      if (this.api.focus === 'ptz') position.focus = num(p.focus);
      if (this.api.dayNight === 'ptz') dayNight = IR_TO_MODE[p.ircutfilter ?? ''] ?? null;
    }
    if (this.api.zoom === 'setup' || this.api.focus === 'setup') {
      const a = await this.setupState();
      if (this.api.zoom === 'setup') position.zoom = round(num(a.zoomPosition), 4);
      if (this.api.focus === 'setup') position.focus = round(num(a.focusPosition), 4);
    }
    if (this.api.zoom === 'optics' || this.api.focus === 'optics' || this.api.dayNight === 'optics') {
      const o = (await this.optics<OpticsState>('getOptics')).optics?.find((x) => x.opticsId === this.opticsId);
      if (this.api.zoom === 'optics') position.zoom = round(o?.magnification ?? null, 2);
      if (this.api.focus === 'optics') position.focus = round(o?.focusPosition ?? null, 4);
      if (this.api.dayNight === 'optics') dayNight = IR_TO_MODE[o?.irCutFilterState ?? ''] ?? null;
    }
    if (this.api.dayNight === 'param') dayNight = PARAM_TO_MODE[(await this.readIrCutParam()) ?? ''] ?? null;
    return { position, dayNight };
  }

  async move(pan: number, tilt: number, zoom: number): Promise<void> {
    const q: string[] = [];
    if (this.api.panTilt) q.push(`continuouspantiltmove=${Math.round(pan)},${Math.round(tilt)}`);
    if (this.api.zoom === 'ptz' && this.ptzCommandSet.has('continuouszoommove')) q.push(`continuouszoommove=${Math.round(zoom)}`);
    if (q.length) await this.ptz(q.join('&'));
  }

  async stop(): Promise<void> {
    await this.move(0, 0, 0);
  }

  async zoomStep(direction: 1 | -1, big: boolean): Promise<void> {
    if (this.api.zoom === 'optics') await this.optics('setRelativeMagnification', { type: `${direction > 0 ? '+' : '-'}${big ? 'bigStep' : 'smallStep'}` });
    else if (this.api.zoom === 'ptz') await this.ptz(`rzoom=${direction * (big ? 2000 : 500)}`);
    else if (this.api.zoom === 'setup') await this.setup(`rzoom=${direction * (big ? 0.1 : 0.02)}`);
  }

  async focusStep(direction: 1 | -1, big: boolean): Promise<void> {
    if (this.api.focus === 'optics') await this.optics('setRelativeFocus', { type: `${direction > 0 ? '+' : '-'}${big ? 'bigStep' : 'smallStep'}` });
    else if (this.api.focus === 'ptz') await this.ptz(`rfocus=${direction * (big ? 1000 : 250)}`);
    else if (this.api.focus === 'setup') await this.setup(`rfocus=${direction * (big ? 0.05 : 0.01)}`);
  }

  async autofocus(): Promise<void> {
    if (this.api.focus === 'optics') await this.optics('performAutofocus', {});
    else if (this.api.focus === 'ptz') await this.ptz('autofocus=on');
    else if (this.api.focus === 'setup') await this.setup('autofocus=perform');
  }

  async setDayNight(mode: DayNightMode): Promise<void> {
    if (this.api.dayNight === 'optics') await this.optics('setIrCutFilterState', { irCutFilterState: MODE_TO_IR[mode] });
    else if (this.api.dayNight === 'ptz') await this.ptz(`ircutfilter=${MODE_TO_IR[mode]}`);
    else if (this.api.dayNight === 'param') {
      const text = await this.http.text(`/axis-cgi/param.cgi?action=update&${PARAM_IRCUT}=${MODE_TO_PARAM[mode]}`);
      if (!/^\s*OK/i.test(text)) throw new AxisError(`Kamera lehnt ab: ${text.replace(/\s+/g, ' ').trim()}`, 400);
    }
  }

  async home(): Promise<void> {
    if (this.api.panTilt) await this.ptz('move=home');
  }

  /**
   * opticssetup.cgi kennt nur relative Befehle: Differenz zum aktuellen Stand fahren und den Motor abwarten.
   * Wegen Getriebespiel bis zu drei Korrekturen, bis die Abweichung unter 0,001 liegt.
   */
  private async setupMoveTo(axis: 'zoom' | 'focus', target: number): Promise<void> {
    const key = axis === 'zoom' ? 'zoomPosition' : 'focusPosition';
    const busy = axis === 'zoom' ? 'zoomOperationInProgress' : 'focusOperationInProgress';
    for (let attempt = 0; attempt < 4; attempt++) {
      const current = num((await this.setupState())[key]);
      if (current === null) return;
      const delta = Math.round((target - current) * 1e6) / 1e6;
      if (Math.abs(delta) < 0.001) return;
      await this.setup(`r${axis}=${delta}`);
      for (let i = 0; i < 40; i++) {
        await sleep(this.settleMs);
        if ((await this.setupState())[busy] !== '1') break;
      }
    }
  }

  /** Wartezeit zwischen Statusabfragen beim Anfahren (in Tests verkürzbar) */
  settleMs = 250;

  async goto(p: CameraPosition): Promise<void> {
    const q: string[] = [];
    if (this.api.panTilt && p.pan !== null && p.tilt !== null) q.push(`pan=${p.pan}`, `tilt=${p.tilt}`);
    if (this.api.zoom === 'ptz' && p.zoom !== null) q.push(`zoom=${Math.round(p.zoom)}`);
    if (this.api.focus === 'ptz' && p.focus !== null) q.push(`focus=${Math.round(p.focus)}`);
    if (q.length) await this.ptz(q.join('&'));
    if (this.api.zoom === 'optics' && p.zoom !== null) await this.optics('setMagnification', { magnification: p.zoom });
    if (this.api.focus === 'optics' && p.focus !== null) await this.optics('setFocus', { position: p.focus });
    // Zoom zuerst: die Kamera führt den Fokus beim Zoomen nach, danach wird er korrigiert
    if (this.api.zoom === 'setup' && p.zoom !== null) await this.setupMoveTo('zoom', p.zoom);
    if (this.api.focus === 'setup' && p.focus !== null) await this.setupMoveTo('focus', p.focus);
  }

  /** Je Bildart die zuletzt erfolgreiche Parametervariante (Index in streamVariants) */
  private readonly streamVariant: Record<'live' | 'thumb', number> = { live: 0, thumb: 0 };

  /**
   * Parameter vom Wunsch bis zur Minimalanfrage. Nicht jede Kamera nimmt jeden Wert an (z. B. Auflösung, die im
   * gewählten Aufnahmemodus fehlt) und antwortet dann mit HTTP 400 – dann wird die nächste Variante versucht.
   */
  static streamVariants(kind: 'live' | 'thumb', resolution: string): string[] {
    return kind === 'live'
      ? [`resolution=${resolution}&fps=15`, `resolution=${resolution}`, '']
      : [`resolution=${resolution}&fps=2&compression=60`, `resolution=${resolution}&fps=2`, `resolution=${resolution}`, 'fps=2', ''];
  }

  async openStream(kind: 'live' | 'thumb', resolution: string): Promise<IncomingMessage> {
    const variants = AxisCamera.streamVariants(kind, resolution);
    let lastError = '';
    for (let i = this.streamVariant[kind]; i < variants.length; i++) {
      const q = variants[i]!;
      // Livebild läuft unbegrenzt; Zeitüberschreitung gilt nur, wenn keine Daten mehr kommen
      const res = await this.http.stream('GET', `/axis-cgi/mjpg/video.cgi${q ? `?${q}` : ''}`, undefined, undefined, 15_000);
      if ((res.statusCode ?? 0) < 300) {
        this.streamVariant[kind] = i;
        return res;
      }
      // Axis nennt den Grund im Antworttext (z. B. „Invalid resolution“)
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      const reason = Buffer.concat(chunks).toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      lastError = `Videobild abgelehnt (HTTP ${res.statusCode}${reason ? `: ${reason}` : ''}; Anfrage: ${q || 'ohne Parameter'})`;
      if (res.statusCode !== 400) break;
    }
    this.streamVariant[kind] = 0;
    throw new AxisError(lastError, 502);
  }
}

/** Demo-Kamera ohne Hardware (zum Ausprobieren der Bedienung); liefert kein Videobild. */
export class DemoCamera implements CameraClient {
  private pos: CameraPosition = { pan: 0, tilt: 0, zoom: 1, focus: 0.5 };
  private mode: DayNightMode = 'auto';
  private velocity = { pan: 0, tilt: 0, zoom: 0 };
  private last = Date.now();

  private advance() {
    const dt = (Date.now() - this.last) / 1000;
    this.last = Date.now();
    const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
    this.pos = {
      pan: Math.round((((this.pos.pan! + this.velocity.pan * 0.6 * dt + 540) % 360) - 180) * 100) / 100,
      tilt: Math.round(clamp(this.pos.tilt! + this.velocity.tilt * 0.3 * dt, -90, 20) * 100) / 100,
      zoom: Math.round(clamp(this.pos.zoom! + this.velocity.zoom * 0.05 * dt, 1, 30) * 100) / 100,
      focus: this.pos.focus,
    };
  }

  async probe(): Promise<CameraProbe> {
    return { model: 'Demo-Kamera', caps: { panTilt: true, zoom: true, continuousZoom: true, focus: true, autofocus: true, dayNight: true, home: true, zoomUnit: 'factor' } };
  }
  async read(): Promise<CameraReading> {
    this.advance();
    return { position: { ...this.pos }, dayNight: this.mode };
  }
  async move(pan: number, tilt: number, zoom: number): Promise<void> {
    this.advance();
    this.velocity = { pan, tilt, zoom };
  }
  async stop(): Promise<void> {
    await this.move(0, 0, 0);
  }
  async zoomStep(direction: 1 | -1, big: boolean): Promise<void> {
    this.pos.zoom = Math.min(30, Math.max(1, (this.pos.zoom ?? 1) + direction * (big ? 4 : 1)));
  }
  async focusStep(direction: 1 | -1, big: boolean): Promise<void> {
    this.pos.focus = Math.round(Math.min(1, Math.max(0, (this.pos.focus ?? 0.5) + direction * (big ? 0.1 : 0.02))) * 10000) / 10000;
  }
  async autofocus(): Promise<void> {
    this.pos.focus = 0.5;
  }
  async setDayNight(mode: DayNightMode): Promise<void> {
    this.mode = mode;
  }
  async home(): Promise<void> {
    this.pos = { ...this.pos, pan: 0, tilt: 0 };
  }
  async goto(p: CameraPosition): Promise<void> {
    this.pos = { pan: p.pan ?? this.pos.pan, tilt: p.tilt ?? this.pos.tilt, zoom: p.zoom ?? this.pos.zoom, focus: p.focus ?? this.pos.focus };
  }
  async openStream(): Promise<null> {
    return null;
  }
}
