/**
 * Dekodierung der NMEA-2000-Nachrichten einer Airmar-Wetterstation (z. B. 150WX).
 * Felder sind Little Endian; Bitfelder beginnen beim niederwertigsten Bit. „Nicht verfügbar“ ist
 * je nach Typ der Höchstwert (0xFF…, bei vorzeichenbehafteten Werten 0x7F…).
 */

const KELVIN = 273.15;
const RAD = 180 / Math.PI;

const u16 = (d: Buffer, o: number) => (d.length >= o + 2 ? d.readUInt16LE(o) : null);
const i16 = (d: Buffer, o: number) => (d.length >= o + 2 ? d.readInt16LE(o) : null);
const i32 = (d: Buffer, o: number) => (d.length >= o + 4 ? d.readInt32LE(o) : null);
const i64 = (d: Buffer, o: number) => (d.length >= o + 8 ? d.readBigInt64LE(o) : null);

/** Werte ab 0xFFFD (unsigned) bzw. 0x7FFD (signed) sind „nicht verfügbar“/„Fehler“. */
const okU16 = (v: number | null) => (v === null || v >= 0xfffd ? null : v);
const okI16 = (v: number | null) => (v === null || v >= 0x7ffd ? null : v);
const okI32 = (v: number | null) => (v === null || v >= 0x7ffffffd ? null : v);

export type WindReference = 'true-north' | 'magnetic-north' | 'apparent' | 'true-boat' | 'true-water';
const WIND_REFERENCE: WindReference[] = ['true-north', 'magnetic-north', 'apparent', 'true-boat', 'true-water'];

export type N2kValue =
  | { pgn: 130306; speedMs: number | null; angleDeg: number | null; reference: WindReference | null }
  | { pgn: 130310; airTempC: number | null; pressureHpa: number | null }
  | { pgn: 130311; tempSource: number; tempC: number | null; humidityPercent: number | null; pressureHpa: number | null }
  | { pgn: 130312; source: number; tempC: number | null }
  | { pgn: 130313; source: number; humidityPercent: number | null }
  | { pgn: 130314; source: number; pressureHpa: number | null }
  | { pgn: 129025; lat: number; lon: number }
  | { pgn: 129029; lat: number | null; lon: number | null; fix: boolean; satellites: number | null }
  | { pgn: 127250; headingDeg: number | null; reference: 'true' | 'magnetic' | null; variationDeg: number | null };

/** Temperatur-/Feuchtequellen nach NMEA 2000 (Auszug). */
export const TEMP_SOURCE_OUTSIDE = 1;
export const HUMIDITY_SOURCE_OUTSIDE = 1;

export const SUPPORTED_PGNS = [130306, 130310, 130311, 130312, 130313, 130314, 129025, 129029, 127250] as const;

export function decodePgn(pgn: number, d: Buffer): N2kValue | null {
  switch (pgn) {
    case 130306: {
      // SID, Geschwindigkeit (0,01 m/s), Winkel (0,0001 rad), Referenz (3 Bit)
      const speed = okU16(u16(d, 1));
      const angle = okU16(u16(d, 3));
      const ref = d.length > 5 ? d[5]! & 0x07 : 7;
      return { pgn, speedMs: speed === null ? null : speed * 0.01, angleDeg: angle === null ? null : (angle * 0.0001 * RAD) % 360, reference: WIND_REFERENCE[ref] ?? null };
    }
    case 130310: {
      // SID, Wassertemperatur, Lufttemperatur (0,01 K), Luftdruck (100 Pa = 1 hPa)
      const t = okU16(u16(d, 3));
      const p = okU16(u16(d, 5));
      return { pgn, airTempC: t === null ? null : t * 0.01 - KELVIN, pressureHpa: p };
    }
    case 130311: {
      // SID, Temperaturquelle (6 Bit) + Feuchtequelle (2 Bit), Temperatur (0,01 K), Feuchte (0,004 %), Luftdruck (1 hPa)
      const tempSource = d.length > 1 ? d[1]! & 0x3f : 0;
      const t = okU16(u16(d, 2));
      const h = okI16(i16(d, 4));
      const p = okU16(u16(d, 6));
      return { pgn, tempSource, tempC: t === null ? null : t * 0.01 - KELVIN, humidityPercent: h === null ? null : h * 0.004, pressureHpa: p };
    }
    case 130312: {
      // SID, Instanz, Quelle, Ist-Temperatur (0,01 K), Soll-Temperatur
      const t = okU16(u16(d, 3));
      return { pgn, source: d[2] ?? 0, tempC: t === null ? null : t * 0.01 - KELVIN };
    }
    case 130313: {
      // SID, Instanz, Quelle, Ist-Feuchte (0,004 %), Soll-Feuchte
      const h = okI16(i16(d, 3));
      return { pgn, source: d[2] ?? 0, humidityPercent: h === null ? null : h * 0.004 };
    }
    case 130314: {
      // SID, Instanz, Quelle, Druck (0,1 Pa)
      const p = okI32(i32(d, 3));
      return { pgn, source: d[2] ?? 0, pressureHpa: p === null ? null : p * 0.1 / 100 };
    }
    case 129025: {
      // Breite, Länge (je 1e-7 Grad)
      const lat = okI32(i32(d, 0));
      const lon = okI32(i32(d, 4));
      return lat === null || lon === null ? null : { pgn, lat: lat * 1e-7, lon: lon * 1e-7 };
    }
    case 129029: {
      // SID, Datum, Zeit, Breite/Länge (je 1e-16 Grad, int64), Höhe, GNSS-Typ (4 Bit) + Methode (4 Bit), …, Satelliten
      const lat = i64(d, 7);
      const lon = i64(d, 15);
      const method = d.length > 31 ? d[31]! >> 4 : 0;
      const sats = d.length > 33 && d[33] !== 0xff ? d[33]! : null;
      const na = 0x7fffffffffffffffn;
      return {
        pgn,
        lat: lat === null || lat === na ? null : Number(lat) * 1e-16,
        lon: lon === null || lon === na ? null : Number(lon) * 1e-16,
        // 0 = kein GNSS, 1 = GNSS-Fix, 2 = DGNSS, 3 = präzise, 4/5 = RTK …; 15 = nicht verfügbar
        fix: method >= 1 && method <= 8,
        satellites: sats,
      };
    }
    case 127250: {
      // SID, Kurs (0,0001 rad), Deviation, Missweisung (0,0001 rad), Referenz (2 Bit)
      const h = okU16(u16(d, 1));
      const v = okI16(i16(d, 5));
      const ref = d.length > 7 ? d[7]! & 0x03 : 3;
      return { pgn, headingDeg: h === null ? null : (h * 0.0001 * RAD) % 360, variationDeg: v === null ? null : v * 0.0001 * RAD, reference: ref === 0 ? 'true' : ref === 1 ? 'magnetic' : null };
    }
    default:
      return null;
  }
}
