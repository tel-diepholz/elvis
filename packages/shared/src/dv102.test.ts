import { describe, expect, it } from 'vitest';
import { DV102_CATEGORIES, DV102_SIGNS, dv102Sign, isDv102Sign, searchDv102 } from './dv102';

describe('Lagezeichen nach DV 102', () => {
  it('bringt nur Lagezeichen mit eindeutiger Kennung und sauberem SVG', () => {
    expect(DV102_SIGNS.length).toBeGreaterThan(70);
    expect(new Set(DV102_SIGNS.map((s) => s.id)).size).toBe(DV102_SIGNS.length);
    for (const s of DV102_SIGNS) {
      expect(DV102_CATEGORIES).toContain(s.category);
      expect(s.svg, s.id).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 256 256">.*<\/svg>$/s);
      // Schrift steckt einmal im Modul, nicht in jedem Zeichen
      expect(s.svg, s.id).not.toMatch(/base64|<style|<title|DOCTYPE/);
    }
    // Fahrzeuge gehören nicht dazu, Personen baut der Generator
    expect(DV102_SIGNS.some((s) => /fahrzeug/i.test(s.id) || s.category === ('Personen' as string))).toBe(false);
  });

  it('macht IDs je Zeichen eindeutig (Clip-Pfade mehrerer Zeichen auf einer Seite)', () => {
    const ids = DV102_SIGNS.flatMap((s) => [...s.svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('findet Zeichen auch über Einsatzbegriffe', () => {
    expect(isDv102Sign('Gefahren/Gefahr_durch_Gas')).toBe(true);
    expect(dv102Sign('Fahrzeuge/LF_20')).toBeNull();
    expect(searchDv102('einsturz').map((s) => s.name)).toContain('Zerstört');
    expect(searchDv102('feuer').map((s) => s.name)).toContain('Vollbrand');
    expect(searchDv102('gefahr gas').map((s) => s.name)).toEqual(['Akute Gefahr durch Gas', 'Gefahr durch Gas', 'Vermutete Gefahr durch Gas']);
  });
});
