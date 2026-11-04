// Baut den Windows-Installer aus stage/ (vorher scripts/stage.mjs) mit NSIS 3 (makensis im PATH oder im
// Standardordner; unter Linux z. B. Paket „nsis“). Ergebnis: release/ELVIS-lite-<Version>-setup.exe
// Aufruf: node scripts/installer.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(ROOT, 'stage');
if (!existsSync(join(STAGE, 'node.exe'))) throw new Error('stage/ fehlt – vorher „node scripts/stage.mjs“');

const version = readFileSync(join(STAGE, 'VERSION'), 'utf8').trim();
const out = join(ROOT, 'release', `ELVIS-lite-${version}-setup.exe`);
mkdirSync(dirname(out), { recursive: true });

const candidates = ['makensis', 'C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe'];
const makensis = candidates.find((c) => {
  try {
    execFileSync(c, ['-VERSION'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});
if (!makensis) throw new Error('makensis (NSIS 3) nicht gefunden – unter Windows z. B. „choco install nsis“, unter Linux Paket „nsis“');

execFileSync(makensis, ['-V2', '-INPUTCHARSET', 'UTF8', `-DVERSION=${version}`, `-DSTAGE=${STAGE}`, `-DOUTFILE=${out}`, join(ROOT, 'installer', 'elvis-lite.nsi')], { stdio: 'inherit' });
console.log(`Installer: ${out}`);
