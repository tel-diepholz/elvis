// Stellt den Programmordner von ELVIS lite für Windows in stage/ zusammen (läuft auch unter Linux):
//   node.exe                 Node.js für Windows (fest: Version + SHA-256)
//   elvis-lite-dienst.exe    WinSW, Dienst-Wrapper um node.exe (fest: Version + SHA-256) – dazu .xml
//   server/index.mjs         der ELVIS-Server als Bündel (tsup, vorher `npm run build`)
//   node_modules/            nur die externen Pakete (native bzw. mit Laufzeitdateien), nur Windows-Binärdateien
//   web/                     die Weboberfläche (apps/web/dist)
//   elvis-oeffnen.ps1        öffnet ELVIS im Browser bzw. meldet einen belegten Port
// Aufruf: node scripts/stage.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { elvisVersion } from './version.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(ROOT, 'stage');
const CACHE = join(ROOT, '.cache');

const NODE = {
  version: '24.22.1',
  sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
};
const WINSW = {
  version: '2.12.0',
  // .NET-4.6.1-Variante: nutzt das in Windows 10/11 enthaltene .NET Framework (650 KB statt 18 MB)
  file: 'WinSW.NET461.exe',
  sha256: 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f',
};
/** Externe Pakete des Server-Bündels (siehe tsup.config.ts), Versionen wie im Lockfile */
const RUNTIME = { 'better-sqlite3': '13.0.3', pdfkit: '0.15.2', dockerode: '4.0.12' };

async function download(url, sha256, name) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, name);
  const hash = (buf) => createHash('sha256').update(buf).digest('hex');
  if (existsSync(file) && hash(readFileSync(file)) === sha256) return readFileSync(file);
  console.log(`Lade ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (hash(buf) !== sha256) throw new Error(`${name}: Prüfsumme stimmt nicht (erwartet ${sha256}, erhalten ${hash(buf)})`);
  writeFileSync(file, buf);
  return buf;
}

for (const need of [join(ROOT, 'dist/server/index.mjs'), join(ROOT, '../web/dist/index.html')]) {
  if (!existsSync(need)) throw new Error(`${need} fehlt – vorher „npm run build -w @elvis/windows“`);
}
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

// Node.js: nur node.exe aus dem offiziellen ZIP
const zipName = `node-v${NODE.version}-win-x64.zip`;
const zip = await download(`https://nodejs.org/dist/v${NODE.version}/${zipName}`, NODE.sha256, zipName);
const entry = `node-v${NODE.version}-win-x64/node.exe`;
const files = unzipSync(new Uint8Array(zip), { filter: (f) => f.name === entry || f.name === `node-v${NODE.version}-win-x64/LICENSE` });
writeFileSync(join(STAGE, 'node.exe'), files[entry]);
writeFileSync(join(STAGE, 'NODE-LICENSE.txt'), files[`node-v${NODE.version}-win-x64/LICENSE`]);

// WinSW: Name der .exe = Name der .xml daneben
const winsw = await download(`https://github.com/winsw/winsw/releases/download/v${WINSW.version}/${WINSW.file}`, WINSW.sha256, `winsw-${WINSW.version}-${WINSW.file}`);
writeFileSync(join(STAGE, 'elvis-lite-dienst.exe'), winsw);

cpSync(join(ROOT, 'dist/server'), join(STAGE, 'server'), { recursive: true });
cpSync(join(ROOT, '../web/dist'), join(STAGE, 'web'), { recursive: true });
for (const f of ['elvis-lite-dienst.xml', 'elvis-oeffnen.ps1', 'elvis.ico']) cpSync(join(ROOT, 'installer', f), join(STAGE, f));
cpSync(join(ROOT, '../../LICENSE'), join(STAGE, 'LICENSE.txt'));

// Externe Pakete außerhalb des Workspaces installieren (sonst installiert npm ins Repo), ohne Install-Skripte:
// better-sqlite3 bringt fertige Binärdateien je Plattform mit, ssh2 (über dockerode) läuft auch ohne seine optionalen
// nativen Teile.
const tmp = mkdtempSync(join(tmpdir(), 'elvis-lite-runtime-'));
writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'elvis-lite-runtime', private: true, dependencies: RUNTIME }, null, 2));
execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--os=win32', '--cpu=x64'], { cwd: tmp, stdio: 'inherit', shell: process.platform === 'win32' });
cpSync(join(tmp, 'node_modules'), join(STAGE, 'node_modules'), { recursive: true });
rmSync(tmp, { recursive: true, force: true });
// Nur die Windows-Binärdatei von better-sqlite3 behalten
const prebuilds = join(STAGE, 'node_modules/better-sqlite3/prebuilds');
for (const f of readdirSync(prebuilds)) if (f !== 'win32-x64.node') rmSync(join(prebuilds, f));
if (!existsSync(join(prebuilds, 'win32-x64.node'))) throw new Error('better-sqlite3: keine Binärdatei für win32-x64');

const version = elvisVersion();
const built = readFileSync(join(ROOT, 'dist/server/index.mjs'), 'utf8');
if (!built.includes(JSON.stringify(version))) throw new Error(`dist/server ist nicht für Version ${version} gebaut – vorher „npm run build -w @elvis/windows“`);
writeFileSync(join(STAGE, 'VERSION'), `${version}\n`);
console.log(`stage/ fertig (ELVIS lite ${version}, Node.js ${NODE.version}, WinSW ${WINSW.version})`);
