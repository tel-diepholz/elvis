import { describe, expect, it } from 'vitest';
import { formatRecoveryKey, parseRecoveryKey, RECOVERY_KEY_BYTES, recoveryKeyCheck } from './backup';

const secret = Uint8Array.from({ length: RECOVERY_KEY_BYTES }, (_, i) => (i * 37 + 11) & 0xff);

describe('Wiederherstellungsschlüssel', () => {
  it('ist lesbar gruppiert und lässt sich zurücklesen', () => {
    const key = formatRecoveryKey(secret);
    expect(key).toMatch(/^ELVIS(-[0-9A-HJKMNP-TV-Z]{4}){12}$/);
    expect(parseRecoveryKey(key)).toEqual(secret);
    expect(recoveryKeyCheck(key)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  });

  it('verzeiht Schreibweisen, erkennt aber Tippfehler', () => {
    const key = formatRecoveryKey(secret);
    const loose = key.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
    expect(parseRecoveryKey(loose)).toEqual(secret);
    expect(parseRecoveryKey(key.replace(/^ELVIS-/, ''))).toEqual(secret);
    const last = key.at(-1)!;
    expect(parseRecoveryKey(key.slice(0, -1) + (last === 'A' ? 'B' : 'A'))).toBeNull();
    expect(parseRecoveryKey(key.slice(0, -5))).toBeNull();
    expect(parseRecoveryKey('Hallo')).toBeNull();
  });
});
