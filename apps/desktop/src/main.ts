/**
 * ELVIS lite – Electron-Hauptprozess.
 *
 * Die App ist nur eine Hülle um den unveränderten ELVIS-Server (apps/server) und die Weboberfläche (apps/web):
 * Der Server läuft als eigener Prozess (utilityProcess) mit ELVIS_EDITION=lite, lauscht im LAN (Tablets im
 * Fahrzeug verbinden sich per Browser) und liefert die Oberfläche aus, die das Fenster über http://127.0.0.1 lädt.
 * Schließen des Fensters legt die App in den Infobereich – der Server bleibt für die Tablets erreichbar.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, type WriteStream } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, shell, Tray, utilityProcess, type UtilityProcess } from 'electron';

interface DesktopSettings {
  /** Port des ELVIS-Servers (fest, damit Tablets und gespeicherte Ansichten ihn wiederfinden) */
  port: number;
}

const DEFAULTS: DesktopSettings = { port: 8080 };
/** Entwicklung: Oberfläche vom Vite-Server laden, den Server startet `ELVIS_EDITION=lite npm run dev` */
const DEV_URL = process.env.ELVIS_DEV_URL;

const userData = app.getPath('userData');
const settingsFile = join(userData, 'desktop.json');
const dataDir = join(userData, 'data');
const logDir = join(userData, 'logs');

let settings: DesktopSettings = DEFAULTS;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: UtilityProcess | null = null;
let serverLog: WriteStream | null = null;
let quitting = false;
const crashes: number[] = [];

function loadSettings(): DesktopSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(settingsFile, 'utf8')) as Partial<DesktopSettings>) };
  } catch {
    return DEFAULTS;
  }
}

const localUrl = () => DEV_URL ?? `http://127.0.0.1:${settings.port}`;

/** Adressen, unter denen Tablets im LAN den Server erreichen */
function lanUrls(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${settings.port}`);
}

/** Weboberfläche: im Installer als extraResource neben app.asar, in der Entwicklung in dist/web */
const webDist = () => (app.isPackaged ? join(process.resourcesPath, 'web') : join(__dirname, 'web'));
const icon = () => nativeImage.createFromPath(app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '..', 'build', 'icon.png'));

function startServer(): void {
  mkdirSync(logDir, { recursive: true });
  serverLog ??= createWriteStream(join(logDir, 'server.log'), { flags: 'a' });
  server = utilityProcess.fork(join(__dirname, 'server', 'index.mjs'), [], {
    serviceName: 'ELVIS-Server',
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELVIS_EDITION: 'lite',
      HOST: '0.0.0.0',
      PORT: String(settings.port),
      ELVIS_DATA_DIR: dataDir,
      ELVIS_CONFIG: join(userData, 'elvis.json'),
      ELVIS_WEB_DIST: webDist(),
    },
  });
  server.stdout?.pipe(serverLog, { end: false });
  server.stderr?.pipe(serverLog, { end: false });
  server.on('exit', (code) => {
    server = null;
    if (quitting) return;
    // Abstürze neu starten, aber nicht endlos (z. B. Port belegt)
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && crashes[0]! < now - 60_000) crashes.shift();
    if (crashes.length <= 3) {
      serverLog?.write(`\n[desktop] Server beendet (Code ${code}), starte neu …\n`);
      startServer();
      return;
    }
    dialog.showErrorBox(
      'ELVIS-Server gestoppt',
      `Der ELVIS-Server ist mehrfach beendet worden (zuletzt Code ${code}). Häufigste Ursache: Port ${settings.port} ist belegt.\n\nProtokoll: ${join(logDir, 'server.log')}`,
    );
  });
}

/** Wartet, bis der Server antwortet (Datenbank-Migrationen können beim ersten Start etwas dauern) */
async function waitForServer(timeoutMs = 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${localUrl()}/api/info`)).ok) return true;
    } catch {
      // noch nicht bereit
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function showWindow(): void {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'ELVIS',
    icon: icon(),
    autoHideMenuBar: true,
    backgroundColor: '#111418',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const origin = new URL(localUrl()).origin;
  // Eigene Seiten (z. B. Dokument-Editor) in einem App-Fenster, alles andere im Standardbrowser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin === origin) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: icon() } };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== origin) {
      e.preventDefault();
      void shell.openExternal(url);
    }
  });
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    tray?.displayBalloon?.({ title: 'ELVIS läuft weiter', content: 'Tablets bleiben verbunden. Beenden über das Symbol im Infobereich.', iconType: 'info' });
  });
  win.on('closed', () => (win = null));
  void win.loadURL(localUrl());
}

function showTabletAddresses(): void {
  const urls = lanUrls();
  const detail = urls.length
    ? `Im Browser des Tablets öffnen:\n\n${urls.join('\n')}\n\nDas Tablet muss im selben Netz wie dieser Rechner sein.`
    : 'Dieser Rechner hat gerade keine Netzwerkverbindung.';
  const choice = dialog.showMessageBoxSync({ type: 'info', title: 'Adresse für Tablets', message: 'ELVIS auf Tablets', detail, buttons: urls.length ? ['Adresse kopieren', 'Schließen'] : ['Schließen'] });
  if (urls.length && choice === 0) clipboard.writeText(urls[0]!);
}

function buildTray(): void {
  tray = new Tray(icon().resize({ width: 16, height: 16 }));
  tray.setToolTip('ELVIS lite');
  const autostart = () => app.getLoginItemSettings().openAtLogin;
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'ELVIS öffnen', click: showWindow },
      { label: 'Adresse für Tablets …', click: showTabletAddresses },
      { type: 'separator' },
      { label: 'Mit Windows starten', type: 'checkbox', checked: autostart(), click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }) },
      { label: 'Datenordner öffnen', click: () => void shell.openPath(userData) },
      { type: 'separator' },
      { label: 'ELVIS beenden', click: () => app.quit() },
    ]);
  tray.setContextMenu(menu());
  tray.on('click', showWindow);
  tray.on('right-click', () => tray?.setContextMenu(menu()));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });
  // Fenster zu ≠ App beenden: der Server bleibt für die Tablets erreichbar
  app.on('window-all-closed', () => {});

  void app.whenReady().then(async () => {
    app.setAppUserModelId('app.einsatzleitwagen.elvis.lite');
    mkdirSync(userData, { recursive: true });
    settings = loadSettings();
    if (!existsSync(settingsFile)) writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    Menu.setApplicationMenu(null);
    buildTray();
    if (!DEV_URL) startServer();
    if (!(await waitForServer())) {
      dialog.showErrorBox('ELVIS startet nicht', `Der ELVIS-Server antwortet nicht unter ${localUrl()}.\n\nProtokoll: ${join(logDir, 'server.log')}`);
    }
    if (!process.argv.includes('--hidden')) showWindow();
  });
}
