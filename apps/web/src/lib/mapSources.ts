import type { MapSource } from '@elvis/shared';

/**
 * Kartenstil passend zum Design: im Dunkelmodus eine dunkle Variante, sonst die (lokale) Standardvariante.
 * Druckvarianten werden am Bildschirm nie automatisch gewählt.
 */
export function autoSource(sources: MapSource[], dark: boolean): MapSource | undefined {
  return (
    (dark ? sources.find((s) => s.variant === 'dark') : undefined) ??
    sources.find((s) => s.variant === 'light') ??
    sources.find((s) => !s.variant) ??
    sources[0]
  );
}

/** Für den Druck: bevorzugt eine Druckvariante. */
export function printSource(sources: MapSource[], current: MapSource | undefined): MapSource | undefined {
  return sources.find((s) => s.variant === 'print') ?? current ?? sources[0];
}
