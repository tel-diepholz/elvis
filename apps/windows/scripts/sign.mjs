// Signiert die Installer in release/ für Einstellungen → Update (Ed25519, <Installer>.sig mit Base64-Signatur).
// Schlüssel: ELVIS_UPDATE_SIGNING_KEY (Base64, 64 Byte, GitHub-Secret). Den passenden öffentlichen Schlüssel prüft der
// Server (UPDATE_PUBLIC_KEY in apps/server/src/services/updates.ts). Aufruf: node scripts/sign.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nacl from 'tweetnacl';

const key = Buffer.from(process.env.ELVIS_UPDATE_SIGNING_KEY?.trim() ?? '', 'base64');
if (key.length !== nacl.sign.secretKeyLength) throw new Error('ELVIS_UPDATE_SIGNING_KEY fehlt oder ist kein Ed25519-Schlüssel (Base64, 64 Byte)');
const dir = new URL('../release/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = readdirSync(dir).filter((f) => f.endsWith('-setup.exe'));
if (!files.length) throw new Error('Kein Installer in release/');
for (const f of files) {
  const sig = nacl.sign.detached(readFileSync(join(dir, f)), key);
  writeFileSync(join(dir, `${f}.sig`), `${Buffer.from(sig).toString('base64')}\n`);
  console.log(`${f}.sig geschrieben (öffentlicher Schlüssel ${Buffer.from(key.subarray(32)).toString('base64')})`);
}
