import { readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SerialPortInfo } from '@elvis/shared';

interface ListedPort {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

const BY_ID = '/dev/serial/by-id';

const listSystemPorts = async (): Promise<ListedPort[]> => {
  const { SerialPort } = await import('serialport');
  return SerialPort.list();
};

/** Stabile Namen (/dev/serial/by-id/…) → tatsächliches Gerät (/dev/ttyUSB0). */
async function byIdLinks(dir: string): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const name of names) {
    const target = await realpath(join(dir, name)).catch(() => null);
    if (target) links.set(target, join(dir, name));
  }
  return links;
}

/**
 * Serielle Schnittstellen des Servers. USB-Geräte werden bevorzugt über ihren stabilen Namen unter
 * /dev/serial/by-id angeboten – der bleibt gleich, auch wenn sich ttyUSB0/ttyUSB1 nach einem Neustart vertauschen.
 */
export async function listSerialPorts(list: () => Promise<ListedPort[]> = listSystemPorts, byIdDir = BY_ID): Promise<SerialPortInfo[]> {
  const [ports, links] = await Promise.all([list().catch(() => [] as ListedPort[]), byIdLinks(byIdDir)]);
  const out: SerialPortInfo[] = ports.map((p) => {
    const stable = links.get(p.path);
    links.delete(p.path);
    const vendor = [p.manufacturer, p.vendorId && p.productId ? `${p.vendorId}:${p.productId}` : null, p.serialNumber && `S/N ${p.serialNumber}`].filter(Boolean).join(', ');
    return { path: stable ?? p.path, device: p.path, label: `${basename(p.path)}${vendor ? ` – ${vendor}` : ''}` };
  });
  // by-id-Einträge, die die Bibliothek nicht gemeldet hat
  for (const [device, stable] of links) out.push({ path: stable, device, label: `${basename(device)} – ${basename(stable)}` });
  // USB vor fest eingebauten Schnittstellen (ttyS*), sonst nach Name
  const rank = (p: SerialPortInfo) => (p.path.startsWith(BY_ID) || /ttyUSB|ttyACM/.test(p.device) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.device.localeCompare(b.device, 'de', { numeric: true }));
}
