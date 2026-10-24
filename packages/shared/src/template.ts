/** Werte je Bereich, z. B. { einsatz: { stichwort: 'B3' } } für {{einsatz.stichwort}} */
export type PlaceholderBags = Record<string, Record<string, unknown> | undefined>;

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\.([a-zA-Z0-9_]+)\s*\}\}/g;

/** Wert eines Platzhalters „bereich.schlüssel“ oder undefined, wenn es ihn nicht gibt */
export function placeholderValue(bags: PlaceholderBags, scope: string, key: string): string | undefined {
  const value = bags[scope]?.[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(',') : String(value);
}

/** Ersetzt {{bereich.schlüssel}}; unbekannte Platzhalter sind ein Fehler. */
export function renderPlaceholders(template: string, bags: PlaceholderBags): string {
  return template.replace(PLACEHOLDER, (match, scope: string, key: string) => {
    const value = placeholderValue(bags, scope, key);
    if (value === undefined) throw new Error(`Unbekannter Platzhalter ${match}`);
    return value;
  });
}
