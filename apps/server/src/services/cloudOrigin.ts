import type { CloudOrigin } from '@elvis/shared';
import { HttpError } from '../errors.js';

/** Herkunft von Stammdaten: aus der Cloud abgeholt (hier nur lesbar) oder null = lokal */
export function cloudOrigin(row: { origin_node?: unknown; origin_name?: unknown }): CloudOrigin | null {
  if (typeof row.origin_node !== 'string' || !row.origin_node) return null;
  return { node: row.origin_node, name: typeof row.origin_name === 'string' ? row.origin_name : '' };
}

/** Ändern/Löschen nur für lokale Datensätze */
export function assertEditable(row: { origin_node?: unknown; origin_name?: unknown } | undefined, what: string): void {
  const o = row && cloudOrigin(row);
  if (o) throw new HttpError(409, `${what} kommt aus der Cloud (${o.name || 'Portal'}) – hier nur lesbar, Änderungen im Portal`);
}
