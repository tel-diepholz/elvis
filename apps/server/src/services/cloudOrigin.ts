import type { CloudOrigin } from '@elvis/shared';
import { HttpError } from '../errors.js';

/**
 * Herkunft von Stammdaten beim Cloud-Abgleich. Der eigene Knoten kommt vom Abgleich (app.ts setzt die Quelle);
 * Datensätze anderer Knoten sind lokal nur lesbar.
 */
let ownNode: () => string | null = () => null;

export function setCloudOwner(source: () => string | null): void {
  ownNode = source;
}

export function cloudOrigin(row: { origin_node?: unknown; origin_name?: unknown }): CloudOrigin | null {
  if (typeof row.origin_node !== 'string' || !row.origin_node) return null;
  return { node: row.origin_node, name: typeof row.origin_name === 'string' ? row.origin_name : '', editable: row.origin_node === ownNode() };
}

/** Ändern/Löschen nur für eigene Datensätze */
export function assertEditable(row: { origin_node?: unknown; origin_name?: unknown }, what: string): void {
  const o = cloudOrigin(row);
  if (o && !o.editable) throw new HttpError(409, `${what} pflegt ${o.name || 'ein anderer Bereich'} in der Cloud – hier nur lesbar`);
}
