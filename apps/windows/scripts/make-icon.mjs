// Erzeugt installer/elvis.ico (16–256 px, PNG-Einträge) aus der Form des Favicons (apps/web/public/favicon.svg) –
// ohne SVG-Werkzeug. Für Installer, Verknüpfungen und Infobereich. Aufruf: node scripts/make-icon.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 24, 32, 48, 64, 256];
const SS = 4; // Kantenglättung durch Überabtastung
const E = [[8, 22], [8, 10], [18, 10], [18, 13], [11.5, 13], [11.5, 14.5], [17, 14.5], [17, 17.5], [11.5, 17.5], [11.5, 19], [18, 19], [18, 22]];

const inPoly = (x, y) => {
  let inside = false;
  for (let i = 0, j = E.length - 1; i < E.length; j = i++) {
    const [xi, yi] = E[i], [xj, yj] = E[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inRoundRect = (x, y, r = 7) => {
  const cx = Math.min(Math.max(x, r), 32 - r), cy = Math.min(Math.max(y, r), 32 - r);
  return x >= 0 && y >= 0 && x <= 32 && y <= 32 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const white = (x, y) => inPoly(x, y) || (x - 23) ** 2 + (y - 20) ** 2 <= 2.5 ** 2;

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function png(size) {
  const s = 32 / size; // Pixel → Favicon-Koordinaten (viewBox 0 0 32 32)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // Filter „none“
    for (let px = 0; px < size; px++) {
      let a = 0, w = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * s, y = (py + (sy + 0.5) / SS) * s;
          if (inRoundRect(x, y)) { a++; if (white(x, y)) w++; }
        }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const t = a ? w / a : 0; // Anteil Weiß innerhalb der Fläche
      raw[o] = Math.round(0xc6 + (255 - 0xc6) * t);
      raw[o + 1] = Math.round(0x28 + (255 - 0x28) * t);
      raw[o + 2] = Math.round(0x28 + (255 - 0x28) * t);
      raw[o + 3] = Math.round((255 * a) / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // RGBA, 8 Bit
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ICO: Kopf, ein Verzeichniseintrag je Größe, dann die PNG-Daten (seit Windows Vista zulässig)
const images = SIZES.map(png);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const entries = images.map((img, i) => {
  const e = Buffer.alloc(16);
  e[0] = SIZES[i] >= 256 ? 0 : SIZES[i]; e[1] = SIZES[i] >= 256 ? 0 : SIZES[i]; // 0 = 256
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(img.length, 8); e.writeUInt32LE(offset, 12);
  offset += img.length;
  return e;
});
const ico = Buffer.concat([header, ...entries, ...images]);
writeFileSync(new URL('../installer/elvis.ico', import.meta.url), ico);
console.log(`installer/elvis.ico geschrieben (${SIZES.join(', ')} px, ${ico.length} Bytes)`);
