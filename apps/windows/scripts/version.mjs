// Version des Builds: aus ELVIS_VERSION (Release-Workflow: Tag ohne „v“), sonst aus package.json.
import { readFileSync } from 'node:fs';

export function elvisVersion() {
  const fromEnv = process.env.ELVIS_VERSION?.trim().replace(/^v/, '');
  const version = fromEnv || JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Version „${version}“ ist nicht x.y.z (Release-Tags: vX.Y.Z)`);
  return version;
}
