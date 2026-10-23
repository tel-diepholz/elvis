import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/tools/n2k-monitor.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  // Shared types are TypeScript sources and must be bundled into the server build.
  noExternal: ['@elvis/shared'],
});
