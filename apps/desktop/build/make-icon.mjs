// Erzeugt build/icon.png (256 px) aus der Form des Favicons (apps/web/public/favicon.svg) – ohne SVG-Werkzeug.
// Aufruf: node build/make-icon.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const SS = 4; // Kantenglättung durch Überabtastung
const s = 32 / SIZE; // Pixel → Favicon-Koordinaten (viewBox 0 0 32 32)
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

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let py = 0; py < SIZE; py++) {
  raw[py * (SIZE * 4 + 1)] = 0; // Filter „none“
  for (let px = 0; px < SIZE; px++) {
    let a = 0, w = 0;
    for (let sy = 0; sy < SS; sy++)
      for (let sx = 0; sx < SS; sx++) {
        const x = (px + (sx + 0.5) / SS) * s, y = (py + (sy + 0.5) / SS) * s;
        if (inRoundRect(x, y)) { a++; if (white(x, y)) w++; }
      }
    const n = SS * SS, o = py * (SIZE * 4 + 1) + 1 + px * 4;
    const t = a ? w / a : 0; // Anteil Weiß innerhalb der Fläche
    raw[o] = Math.round(0xc6 + (255 - 0xc6) * t);
    raw[o + 1] = Math.round(0x28 + (255 - 0x28) * t);
    raw[o + 2] = Math.round(0x28 + (255 - 0x28) * t);
    raw[o + 3] = Math.round((255 * a) / n);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6; // RGBA, 8 Bit
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(new URL('./icon.png', import.meta.url), png);
console.log(`build/icon.png geschrieben (${png.length} Bytes)`);
