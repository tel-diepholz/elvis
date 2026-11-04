import { defineConfig } from 'tsup';

/**
 * Der unveränderte ELVIS-Server (apps/server) als ein ESM-Bündel für den Windows-Dienst. Extern bleiben nur Pakete
 * mit nativen Teilen oder Dateien, die sie zur Laufzeit nachladen (pdfkit: Schriften) – scripts/stage.mjs legt sie
 * daneben. serialport fehlt absichtlich: ELVIS lite hat keine seriellen Gerätemodule, der Server lädt es nur bei Bedarf.
 */
export const EXTERNAL = ['better-sqlite3', 'dockerode', 'pdfkit', 'serialport'];

export default defineConfig({
  entry: { index: '../server/src/index.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  target: 'node24',
  platform: 'node',
  outDir: 'dist/server',
  clean: true,
  // noExternal hat bei tsup Vorrang vor external, daher als Ausschluss formuliert
  noExternal: [new RegExp(`^(?!(${EXTERNAL.join('|')})(/|$))`)],
  external: EXTERNAL,
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
});
