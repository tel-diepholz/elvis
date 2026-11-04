import { contextBridge } from 'electron';

/** Bewusst minimal: die Oberfläche läuft wie im Browser und erfährt nur, dass sie in der Desktop-App steckt. */
contextBridge.exposeInMainWorld('elvisDesktop', { edition: 'lite' as const, platform: process.platform });
