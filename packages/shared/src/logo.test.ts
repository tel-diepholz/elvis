import { describe, expect, it } from 'vitest';
import {
  LOGO_SIGNALS,
  allLogoSignalIds,
  decodeLogoRange,
  evaluateLogoRules,
  logoBitAddress,
  logoLinkInputSchema,
  logoReadRanges,
  logoRuleInputSchema,
  parseLogoSignalId,
  type LogoRule,
} from './logo';

describe('LOGO: Adressen', () => {
  it('erkennt Kennungen und lehnt unbekannte oder zu große Nummern ab', () => {
    expect(parseLogoSignalId('NI4')).toEqual({ kind: 'NI', n: 4 });
    expect(parseLogoSignalId('Q20')).toEqual({ kind: 'Q', n: 20 });
    expect(parseLogoSignalId('Q21')).toBeNull();
    expect(parseLogoSignalId('NI0')).toBeNull();
    expect(parseLogoSignalId('X1')).toBeNull();
    expect(parseLogoSignalId('ni1')).toBeNull();
  });

  it('rechnet Bits in Byte und Bit der VM-Adresse um', () => {
    expect(logoBitAddress('I', 1)).toEqual({ byte: 1024, bit: 0 });
    expect(logoBitAddress('Q', 7)).toEqual({ byte: 1064, bit: 6 });
    expect(logoBitAddress('Q', 9)).toEqual({ byte: 1065, bit: 0 });
    expect(logoBitAddress('NI', 4)).toEqual({ byte: 1246, bit: 3 });
  });

  it('hat überschneidungsfreie Bereiche', () => {
    const ranges = logoReadRanges().sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i - 1]!.offset + ranges[i - 1]!.length).toBeLessThanOrEqual(ranges[i]!.offset);
    expect(allLogoSignalIds()).toHaveLength(LOGO_SIGNALS.reduce((n, s) => n + s.count, 0));
  });

  it('dekodiert Bits und vorzeichenbehaftete Analogwerte', () => {
    const q = decodeLogoRange('Q', Uint8Array.from([0b0100_0001, 0, 0b0000_0001]));
    expect(q.Q1).toBe(1);
    expect(q.Q7).toBe(1);
    expect(q.Q2).toBe(0);
    expect(q.Q17).toBe(1);
    const ai = decodeLogoRange('AI', Uint8Array.from([0x01, 0xf4, 0xff, 0xfe, ...new Array(12).fill(0)]));
    expect(ai.AI1).toBe(500);
    expect(ai.AI2).toBe(-2);
  });
});

describe('LOGO: Regeln', () => {
  const rule = (r: Partial<LogoRule>): LogoRule => ({ id: 'r1', signal: 'NI1', op: '=', value: 1, severity: 'warn', title: 'Lichtmast ausgefahren', enabled: true, ...r });

  it('meldet, solange die Bedingung gilt', () => {
    const state = { labels: {}, rules: [rule({})] };
    expect(evaluateLogoRules({ ...state, values: { NI1: 1 } })).toEqual([{ id: 'logo:rule:r1', severity: 'warn', title: 'Lichtmast ausgefahren', detail: undefined }]);
    expect(evaluateLogoRules({ ...state, values: { NI1: 0 } })).toEqual([]);
    // ohne Wert (noch nie gelesen) keine Meldung
    expect(evaluateLogoRules({ ...state, values: {} })).toEqual([]);
  });

  it('wertet Vergleiche auf Analogwerten aus und überspringt abgeschaltete Regeln', () => {
    const state = { labels: {}, values: { AI1: 30 } };
    expect(evaluateLogoRules({ ...state, rules: [rule({ signal: 'AI1', op: '>', value: 20 })] })).toHaveLength(1);
    expect(evaluateLogoRules({ ...state, rules: [rule({ signal: 'AI1', op: '<=', value: 20 })] })).toHaveLength(0);
    expect(evaluateLogoRules({ ...state, rules: [rule({ signal: 'AI1', op: '>', value: 20, enabled: false })] })).toHaveLength(0);
  });

  it('prüft Eingaben', () => {
    expect(logoRuleInputSchema.safeParse({ signal: 'NI1', title: 'x' }).success).toBe(true);
    expect(logoRuleInputSchema.safeParse({ signal: 'NI99', title: 'x' }).success).toBe(false);
    expect(logoRuleInputSchema.safeParse({ signal: 'NI1', title: ' ' }).success).toBe(false);
    expect(logoLinkInputSchema.safeParse({ name: 'Umfeldbeleuchtung', button: 'NI4', output: 'Q7' }).success).toBe(true);
    // Taster muss ein NI sein, Ausgang ein Ausgang
    expect(logoLinkInputSchema.safeParse({ name: 'x', button: 'I4', output: 'Q7' }).success).toBe(false);
    expect(logoLinkInputSchema.safeParse({ name: 'x', button: 'NI4', output: 'I1' }).success).toBe(false);
    expect(logoLinkInputSchema.safeParse({ name: 'x', button: 'NI4', output: 'AQ1' }).success).toBe(false);
  });
});
