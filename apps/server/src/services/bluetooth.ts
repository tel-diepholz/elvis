import { randomBytes } from 'node:crypto';
import { bluetoothDeviceInputSchema, type BluetoothDeviceConfig, type BluetoothDeviceInput, type BluetoothKind } from '@elvis/shared';
import type { Db } from '../db/index.js';
import type { BluetoothSource } from '../devices/drivers/bluetooth.js';
import { HttpError } from '../errors.js';

interface Row {
  id: string;
  name: string;
  kind: BluetoothKind;
  address: string;
  key: string;
  warn_below_v: number | null;
  enabled: number;
  sort: number;
}

const fromRow = (r: Row): BluetoothDeviceConfig => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  address: r.address,
  key: r.key,
  warnBelowV: r.warn_below_v,
  enabled: !!r.enabled,
  sort: r.sort,
});

/** Bluetooth-Geräte (Tabelle bluetooth_devices); mitgelesen werden sie vom Modul „Bluetooth“ */
export class BluetoothService implements BluetoothSource {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    private readonly notify: () => void,
  ) {}

  list(): BluetoothDeviceConfig[] {
    return (this.db.prepare('SELECT * FROM bluetooth_devices ORDER BY sort, name').all() as Row[]).map(fromRow);
  }

  get(id: string): BluetoothDeviceConfig {
    const d = this.list().find((x) => x.id === id);
    if (!d) throw new HttpError(404, `Bluetooth-Gerät ${id} nicht gefunden`);
    return d;
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private changed(): void {
    this.notify();
    this.listeners.forEach((l) => l());
  }

  private validate(input: BluetoothDeviceInput, current?: BluetoothDeviceConfig): BluetoothDeviceConfig {
    const parsed = bluetoothDeviceInputSchema.safeParse(input);
    if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const twin = this.list().find((d) => d.address === parsed.data.address && d.id !== current?.id);
    if (twin) throw new HttpError(409, `Die Adresse ${parsed.data.address} ist schon als „${twin.name}“ eingetragen`);
    return { id: current?.id ?? `bt-${randomBytes(4).toString('hex')}`, sort: current?.sort ?? this.list().length, ...parsed.data };
  }

  create(input: BluetoothDeviceInput): BluetoothDeviceConfig {
    const d = this.validate(input);
    this.db
      .prepare('INSERT INTO bluetooth_devices (id, name, kind, address, key, warn_below_v, enabled, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, d.name, d.kind, d.address, d.key, d.warnBelowV, d.enabled ? 1 : 0, d.sort, new Date().toISOString());
    this.changed();
    return d;
  }

  update(id: string, input: BluetoothDeviceInput): BluetoothDeviceConfig {
    const d = this.validate(input, this.get(id));
    this.db
      .prepare('UPDATE bluetooth_devices SET name = ?, kind = ?, address = ?, key = ?, warn_below_v = ?, enabled = ? WHERE id = ?')
      .run(d.name, d.kind, d.address, d.key, d.warnBelowV, d.enabled ? 1 : 0, id);
    this.changed();
    return d;
  }

  remove(id: string): BluetoothDeviceConfig {
    const d = this.get(id);
    this.db.prepare('DELETE FROM bluetooth_devices WHERE id = ?').run(id);
    this.changed();
    return d;
  }

  reorder(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE bluetooth_devices SET sort = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, id)))();
    this.changed();
  }
}
