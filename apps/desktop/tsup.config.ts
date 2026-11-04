import { cpSync, rmSync } from 'node:fs';
import { defineConfig } from 'tsup';

/**
 * Zwei Bündel:
 * - main/preload: Electron-Hauptprozess (CommonJS, Electron selbst bleibt extern)
 * - server: der unveränderte ELVIS-Server (apps/server) als ein ESM-Bündel. Extern bleiben nur native Module und
 *   Pakete, die zur Laufzeit eigene Dateien nachladen (pdfkit: Schriften) – sie stehen in den dependencies und
 *   kommen über electron-builder samt nativer Neuübersetzung in die App. serialport fehlt absichtlich: ELVIS lite
 *   hat keine seriellen Gerätemodule, der Server lädt es nur bei Bedarf.
 */
const NATIVE_OR_DATA = ['better-sqlite3', 'dockerode', 'pdfkit', 'serialport'];
/** Alles andere bündeln (noExternal hat bei tsup Vorrang vor external, daher als Ausschluss formuliert) */
const BUNDLED = new RegExp(`^(?!(${NATIVE_OR_DATA.join('|')})(/|$))`);

export default defineConfig([
  {
    entry: { main: 'src/main.ts', preload: 'src/preload.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    target: 'node20',
    platform: 'node',
    outDir: 'dist',
    // nur die eigenen Dateien aufräumen – dist/server baut parallel
    clean: ['main.cjs', 'preload.cjs'],
    external: ['electron'],
    onSuccess: async () => {
      // Weboberfläche neben das Bündel legen (ELVIS_WEB_DIST)
      rmSync('dist/web', { recursive: true, force: true });
      cpSync('../web/dist', 'dist/web', { recursive: true });
    },
  },
  {
    entry: { index: '../server/src/index.ts' },
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
    target: 'node20',
    platform: 'node',
    outDir: 'dist/server',
    clean: true,
    noExternal: [BUNDLED],
    external: NATIVE_OR_DATA,
    // CommonJS-Pakete im ESM-Bündel brauchen require/__dirname
    banner: {
      js: [
        "import { createRequire as __elvisCreateRequire } from 'node:module';",
        "import { fileURLToPath as __elvisToPath } from 'node:url';",
        "import { dirname as __elvisDirname } from 'node:path';",
        'const require = __elvisCreateRequire(import.meta.url);',
        'const __filename = __elvisToPath(import.meta.url);',
        'const __dirname = __elvisDirname(__filename);',
      ].join('\n'),
    },
  },
]);
