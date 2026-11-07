import type { LogoClient, LogoClientFactory } from './client.js';

/** Echter S7-Client auf Basis von nodes7 (wird erst beim Verbinden geladen) */
export const s7ClientFactory: LogoClientFactory = (c) => {
  type Conn = InstanceType<(typeof import('nodes7'))['default']>;
  let conn: Conn | null = null;
  let names: string[] = [];
  let key = '';

  const rangeName = (r: { offset: number; length: number }) => (r.length === 1 ? `DB1,BYTE${r.offset}` : `DB1,BYTE${r.offset}.${r.length}`);

  const client: LogoClient = {
    async connect() {
      if (conn) return;
      const mod = await import('nodes7');
      // CommonJS-Modul: je nach Bundler liegt die Klasse unter default oder default.default
      const NodeS7 = ((mod as { default: unknown }).default as { default?: unknown }).default ?? (mod as { default: unknown }).default;
      const next = new (NodeS7 as new () => Conn)();
      try {
        await new Promise<void>((resolve, reject) => {
          next.initiateConnection({ host: c.host, port: c.port, localTSAP: c.localTsap, remoteTSAP: c.remoteTsap, timeout: c.timeoutMs }, (err) => (err ? reject(new Error(String(err))) : resolve()));
        });
      } catch (err) {
        // nodes7 baut sonst von selbst immer wieder neu auf; ELVIS entscheidet beim nächsten Abfragen selbst
        next.dropConnection();
        throw err;
      }
      conn = next;
      names = [];
      key = '';
    },

    async readBytes(ranges) {
      if (!conn) throw new Error('Nicht verbunden');
      const c2 = conn;
      const wanted = ranges.map(rangeName);
      if (wanted.join('|') !== key) {
        if (names.length) c2.removeItems(names);
        names = wanted;
        key = wanted.join('|');
        c2.setTranslationCB((tag) => tag);
        c2.addItems(names);
      }
      const values = await new Promise<Record<string, unknown>>((resolve, reject) => {
        c2.readAllItems((bad, v) => (bad ? reject(new Error('Lesen der LOGO fehlgeschlagen')) : resolve(v)));
      });
      return ranges.map((r, i) => {
        const raw = values[wanted[i]!];
        const arr = Array.isArray(raw) ? raw : [raw];
        if (arr.length !== r.length || arr.some((x) => typeof x !== 'number')) throw new Error('Ungültige Antwort der LOGO');
        return Uint8Array.from(arr as number[]);
      });
    },

    async writeBit(byte, bit, value) {
      if (!conn) throw new Error('Nicht verbunden');
      const c2 = conn;
      c2.setTranslationCB((tag) => tag);
      await new Promise<void>((resolve, reject) => {
        c2.writeItems(`DB1,X${byte}.${bit}`, value, (bad) => (bad ? reject(new Error('Schreiben zur LOGO fehlgeschlagen')) : resolve()));
      });
    },

    async close() {
      const c2 = conn;
      conn = null;
      if (!c2) return;
      await new Promise<void>((resolve) => c2.dropConnection(() => resolve()));
    },
  };
  return client;
};
