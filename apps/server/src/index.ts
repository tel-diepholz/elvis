import { buildApp, type App } from './app.js';
import { loadConfig } from './config.js';
import { applyPendingRestore } from './services/backup/restore.js';

let app: App;

/** Konfiguration laden, eine vorbereitete Wiederherstellung übernehmen und ELVIS starten */
async function run(): Promise<void> {
  let config = loadConfig();
  if (applyPendingRestore(config.dataDir, config.configFile)) config = loadConfig();
  app = await buildApp(config, { restart: () => void restart() });
  await app.start();
}

/** Nach einer Wiederherstellung: im selben Prozess neu starten (auch ohne Docker-Neustartregel) */
async function restart(): Promise<void> {
  app.server.log.info('Starte neu, um das Backup zu übernehmen …');
  await app.close();
  await run();
}

const shutdown = async (signal: string) => {
  app.server.log.info(`${signal} empfangen, fahre herunter …`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await run();
