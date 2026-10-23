import { describe, expect, it } from 'vitest';
import { DEFAULT_VEHICLE_SIGN, buildTacticalSign, describeTacticalSign, tacticalSignSchema, tacticalSignSvg } from './tactical';

const circles = (g: ReturnType<typeof buildTacticalSign>) => g.primitives.filter((p) => p.kind === 'circle');

describe('Taktische Zeichen', () => {
  it('zeichnet Fahrzeuge mit gewölbter Oberkante und Rädern je Antrieb', () => {
    const kfz = buildTacticalSign({ base: 'vehicle', mobility: 'wheeled' });
    expect(kfz.primitives[0]).toMatchObject({ kind: 'path', d: expect.stringMatching(/^M0,0 Q50,18 100,0/) });
    expect(circles(kfz)).toHaveLength(2);
    expect(circles(buildTacticalSign({ base: 'vehicle', mobility: 'offroad' }))).toHaveLength(3);
    expect(circles(buildTacticalSign({ base: 'vehicle', mobility: 'none' }))).toHaveLength(0);
  });

  it('setzt Größenordnungen als Punkte bzw. Balken über das Zeichen', () => {
    const dots = (size: Parameters<typeof buildTacticalSign>[0]['size']) => circles(buildTacticalSign({ base: 'unit', size })).length;
    expect([dots('trupp'), dots('staffel'), dots('gruppe'), dots('zug')]).toEqual([1, 2, 2, 3]);
    const g = buildTacticalSign({ base: 'unit', size: 'verband3' });
    expect(g.primitives.filter((p) => p.kind === 'path' && p.fill === '#000000')).toHaveLength(3);
    expect(g.box.y).toBeLessThan(-20);
  });

  it('verwendet die Organisationsfarben der DV 102', () => {
    const fill = (org: Parameters<typeof buildTacticalSign>[0]['org']) => (buildTacticalSign({ base: 'unit', org }).primitives[0] as { fill: string }).fill;
    expect(fill('feuerwehr')).toBe('#ff0000');
    expect(fill('thw')).toBe('#0000ff');
    expect(fill('fuehrung')).toBe('#ffff00');
    expect(fill('polizei')).toBe('#008000');
  });

  it('erzeugt für die Befehlsstelle einen Fahnenmast und für Führer eine gefüllte Spitze', () => {
    const cmd = buildTacticalSign({ base: 'command' });
    expect(cmd.primitives.some((p) => p.kind === 'path' && p.d === 'M0,70 L0,96')).toBe(true);
    const leader = buildTacticalSign({ base: 'person', leader: true });
    expect(leader.primitives.filter((p) => p.kind === 'path')).toHaveLength(2);
  });

  it('liefert gültiges SVG mit maskiertem Text', () => {
    const svg = tacticalSignSvg({ ...DEFAULT_VEHICLE_SIGN, text: 'A<B&C' }, { height: 60, title: 'Test' });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="[-\d. ]+" width="[\d.]+" height="60.0"/);
    expect(svg).toContain('A&lt;B&amp;C');
    expect(svg).toContain('<title>Test</title>');
  });

  it('beschreibt das Zeichen und weist ungültige Werte ab', () => {
    expect(describeTacticalSign(DEFAULT_VEHICLE_SIGN)).toBe('Kraftfahrzeug, Feuerwehr, Führung, Leitung, Stab, „ELW 2“');
    expect(tacticalSignSchema.safeParse({ org: 'marine' }).success).toBe(false);
    expect(tacticalSignSchema.safeParse({ text: 'viel zu langer Text' }).success).toBe(false);
  });
});
