import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { settingsInputSchema } from '@elvis/shared';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { AddonManager } from './addons/manager.js';
import { RepoService } from './addons/repos.js';
import { accessLevel, displayReadable } from './auth/access.js';
import { LoginLimiter } from './auth/limiter.js';
import { SESSION_COOKIE, SessionStore } from './auth/sessions.js';
import { UserService } from './auth/users.js';
import type { ElvisConfig } from './config.js';
import { openDb } from './db/index.js';
import { Store } from './db/store.js';
import { DeviceConfigStore } from './devices/config-store.js';
import { cameraRoutes } from './routes/cameras.js';
import { displayRoutes } from './routes/displays.js';
import { DisplayImageService } from './services/displayImages.js';
import { DISPLAY_COOKIE, DisplayService } from './services/displays.js';
import { WorkstationService } from './services/workstations.js';
import { workstationRoutes } from './routes/workstations.js';
import { VideoSourceService } from './services/videos.js';
import { CameraConfigStore, CameraPresetStore } from './services/cameras.js';
import { DeviceManager } from './devices/manager.js';
import { HostService, type DockerFactory } from './docker/hosts.js';
import { DockerPki } from './docker/pki.js';
import { HttpError } from './errors.js';
import { addonRoutes } from './routes/addons.js';
import { authRoutes } from './routes/auth.js';
import { operatorOf } from './routes/util.js';
import { deviceRoutes } from './routes/devices.js';
import { incidentRoutes } from './routes/incidents.js';
import { LiveHub } from './routes/live.js';
import { mapRoutes } from './routes/map.js';
import { ForceService } from './services/forces.js';
import { IncidentService } from './services/incidents.js';
import { SettingsService } from './services/settings.js';
import { GeocoderService, type GeocodeFetch } from './services/geocoder.js';
import { WeatherAlertWatch, WeatherService, type WeatherFetch } from './services/weather.js';
import { weatherRoutes } from './routes/weather.js';
import { AppLinkService } from './services/applinks.js';
import { RelayClient, type RelayFetch } from './services/relay.js';
import { PersonnelService } from './services/personnel.js';
import { personnelRoutes } from './routes/personnel.js';
import { appLinkRoutes } from './routes/applinks.js';
import { TileService } from './services/tiles.js';
import type { UbusHttp } from './services/openwrt.js';
import { WifiService } from './services/wifi.js';
import { wifiRoutes } from './routes/wifi.js';
import { bluetoothRoutes } from './routes/bluetooth.js';
import { monitoringRoutes } from './routes/monitoring.js';
import { BluetoothService } from './services/bluetooth.js';
import { MonitoringService } from './services/monitoring.js';
import type { ProbeDeps } from './services/monitoring-probes.js';
import { documentRoutes } from './routes/documents.js';
import { wopiRoutes } from './routes/wopi.js';
import { DocumentService } from './services/documents.js';
import { OfficeService, type DiscoveryFetch } from './services/office.js';
import { TemplateService } from './services/templates.js';
import { RoleService } from './services/roles.js';
import { TaskService } from './services/tasks.js';
import { taskRoutes } from './routes/tasks.js';
import { printingRoutes, type OfficeDownload } from './routes/printing.js';
import { PrintService, type IppTransport } from './services/printing.js';
import { scanningRoutes } from './routes/scanning.js';
import { ScanService } from './services/scanning.js';

export interface App {
  server: FastifyInstance;
  devices: DeviceManager;
  docker: { hosts: HostService; repos: RepoService; addons: AddonManager } | null;
  wifi: WifiService;
  office: OfficeService;
  printing: PrintService;
  scanning: ScanService;
  workstations: WorkstationService;
  appLinks: AppLinkService;
  personnel: PersonnelService;
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function buildApp(config: ElvisConfig, opts: { logger?: boolean; dockerFactory?: DockerFactory; geocodeFetch?: GeocodeFetch; weatherFetch?: WeatherFetch; wifiHttp?: UbusHttp; officeFetch?: DiscoveryFetch; ippTransport?: IppTransport; officeDownload?: OfficeDownload; monitoringProbes?: ProbeDeps; relayFetch?: RelayFetch } = {}): Promise<App> {
  const server = Fastify({ logger: opts.logger ?? true });

  const db = openDb(config.dataDir);
  const store = new Store(db);
  const cameras = new CameraConfigStore(db);
  const cameraPresets = new CameraPresetStore(db);
  // vor den Fahrzeugmodulen: das Modul „WLAN-Accesspoints“ liest die APs hier
  const wifi = new WifiService(db, {
    activeIncident: () => store.activeIncident(),
    notify: () => hub.invalidate(['wifi']),
    notifyClients: () => hub.invalidate(['wifiClients']),
    audit: (e) => {
      store.addAudit(e);
      hub.invalidate(['audit']);
    },
    http: opts.wifiHttp,
  });
  const monitoring = new MonitoringService(db, () => hub.invalidate(['monitoring']), opts.monitoringProbes);
  const bluetooth = new BluetoothService(db, () => hub.invalidate(['bluetooth']));
  const devices = new DeviceManager(config, server.log, new DeviceConfigStore(db, config.devices), { cameras, wifi, monitoring, bluetooth });
  const settings = new SettingsService(db, { vehicle: config.vehicle });
  const hub = new LiveHub(devices, () => settings.get().vehicle);
  settings.onChange(() => hub.invalidate(['settings']));
  const videos = new VideoSourceService();
  videos.onChange(() => hub.invalidate(['videoSources']));
  const displays = new DisplayService(db);
  displays.onChange(() => hub.invalidate(['displays']));
  const displayImages = new DisplayImageService(db, config.dataDir, () => hub.invalidate(['displays']));
  hub.attachDisplays({ identify: (req) => displays.resolve(req.cookies[DISPLAY_COOKIE])?.id ?? null, setOnline: (id, on) => displays.setOnline(id, on) });
  const templates = new TemplateService(db, config.dataDir, (t) => hub.invalidate(t));
  const documents = new DocumentService(store, config.dataDir, { templates, vehicle: () => settings.get().vehicle, notify: (t) => hub.invalidate(t) });
  const office = new OfficeService(db, () => hub.invalidate(['office']), opts.officeFetch);
  const printing = new PrintService(store, config.dataDir, {
    documents,
    notify: (t) => hub.invalidate(t),
    transport: opts.ippTransport,
    guestWifiActive: () => wifi.guest().active,
  });
  const scanning = new ScanService(store, config.dataDir, { documents, notify: (t) => hub.invalidate(t) });
  const sessions = new SessionStore(db);
  const roles = new RoleService(db, sessions);
  const tasks = new TaskService(db, { store, roles, notify: (t) => hub.invalidate(t) });
  const forces = new ForceService(db, store);
  const incidents = new IncidentService(
    store,
    (topics) => {
      hub.invalidate(topics);
      // Gastnetz folgt dem Einsatz
      if (topics.includes('incident')) wifi.incidentChanged();
    },
    (incident) => {
      documents.snapshotFolders(incident.id);
      tasks.instantiate(incident);
    },
    forces,
  );
  // Nie gespeicherte Entwürfe und alte Scans aufräumen – beim Start und danach stündlich
  const cleanup = () => {
    void documents.cleanupDrafts().catch((err) => server.log.warn({ err }, 'Entwürfe aufräumen fehlgeschlagen'));
    void scanning.cleanup().catch((err) => server.log.warn({ err }, 'Scan-Eingang aufräumen fehlgeschlagen'));
    try {
      personnel.cleanup();
    } catch (err) {
      server.log.warn({ err }, 'Personalbögen aufräumen fehlgeschlagen');
    }
    void printing.cleanupGuest().catch((err) => server.log.warn({ err }, 'Gastaufträge aufräumen fehlgeschlagen'));
  };
  let cleanupTimer: NodeJS.Timeout | null = null;
  const tiles = new TileService(config.map, config.dataDir);
  const geocoder = new GeocoderService(
    { onlineUrl: config.map.geocoderUrl, outlineUrl: config.map.outlineUrl, dataDir: config.dataDir, userAgent: config.map.userAgent },
    opts.geocodeFetch,
  );
  const weather = new WeatherService({ ...config.weather, userAgent: config.map.userAgent }, opts.weatherFetch);
  // Unwetter am Fahrzeugstandort (GPS der Wetterstation, sonst Einsatzort) erscheinen als Meldung
  const weatherWatch = new WeatherAlertWatch(
    weather,
    () => {
      const gps = devices.adapter('weather')?.getState().position;
      if (gps) return gps;
      const incident = store.activeIncident();
      return incident?.lat != null && incident.lon != null ? { lat: incident.lat, lon: incident.lon } : null;
    },
    (alerts) => devices.setExtraAlerts('weather', alerts),
  );
  const relay = new RelayClient(db, config.app.relayUrl, opts.relayFetch);
  const appLinks = new AppLinkService(db, store, incidents, (t) => hub.invalidate(t), relay);
  const personnel = new PersonnelService(db, store, incidents, (t) => hub.invalidate(t), relay, () => settings.get().vehicle.name);
  const users = new UserService(db);
  const limiter = new LoginLimiter();
  const workstations = new WorkstationService(db, store, () => wifi.opsCredentials());
  workstations.onChange(() => hub.invalidate(['workstations']));

  // Docker- und Addon-Verwaltung (abschaltbar über docker.enabled)
  let docker: { hosts: HostService; repos: RepoService; addons: AddonManager } | null = null;
  if (config.docker.enabled) {
    const tlsDir = join(config.dataDir, 'docker-tls');
    const pki = new DockerPki(tlsDir);
    pki.init();
    const hosts = new HostService(db, pki, tlsDir, config.docker, (t) => hub.invalidate(t), opts.dockerFactory);
    const repos = new RepoService(config.addons, config.dataDir);
    const addons = new AddonManager(db, hosts, repos, tiles, (t) => hub.invalidate(t), (e) => {
      store.addAudit(e);
      hub.invalidate(['audit']);
    });
    addons.attachVideos(videos);
    addons.attachGeocoder(geocoder);
    addons.attachOffice(office);
    addons.attachPrinting(printing);
    addons.attachWorkstations(workstations);
    docker = { hosts, repos, addons };
  }

  await server.register(fastifyCookie);
  await server.register(fastifyWebsocket);
  await server.register(fastifyMultipart);

  // Anmeldung: Sitzung aus dem Cookie auflösen und Zugriffsregeln durchsetzen (siehe auth/access.ts).
  server.decorateRequest('user', null);
  server.decorateRequest('roleId', null);
  server.decorateRequest('roleChosen', false);
  server.addHook('onRequest', async (req) => {
    const session = sessions.resolve(req.cookies[SESSION_COOKIE]);
    req.user = session ? users.find(session.userId) : null;
    req.roleId = req.user ? session!.roleId : null;
    req.roleChosen = req.user ? session!.roleChosen : false;
    const level = accessLevel(req.method, req.url);
    if (level === 'public') return;
    // Gekoppelte Bildschirme dürfen einzelne Einsatzdaten lesen (z. B. Einsatzort für die Lagekarte)
    if (!req.user && level === 'user' && displayReadable(req.method, req.url) && displays.resolve(req.cookies[DISPLAY_COOKIE])) return;
    if (!req.user) throw new HttpError(401, 'Bitte anmelden');
    if (level === 'admin' && !req.user.isAdmin) throw new HttpError(403, 'Nur für Admins');
  });

  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    server.log.error(err);
    return reply.code(500).send({ error: 'Interner Fehler' });
  });

  server.register(async (api) => {
    hub.register(api);
    api.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));
    api.get('/api/info', async () => ({
      vehicle: settings.get().vehicle,
      drivers: Object.fromEntries(devices.snapshots().map((d) => [d.id, d.driver])),
      limits: config.alerts,
      docker: { enabled: config.docker.enabled },
    }));
    api.get('/api/audit', async (req) => {
      const limit = Math.min(1000, Number((req.query as { limit?: string }).limit) || 200);
      return store.audit(limit);
    });
    authRoutes(api, { users, sessions, limiter, store, roles, notify: (t) => hub.invalidate(t) });
    taskRoutes(api, { tasks, roles, store, notify: (t) => hub.invalidate(t) });
    deviceRoutes(api, devices, store, (t) => hub.invalidate(t));
    incidentRoutes(api, { incidents, forces, store, notify: (t) => hub.invalidate(t) });
    documentRoutes(api, { documents, templates, office, store, notify: (t) => hub.invalidate(t) });
    wopiRoutes(api, { office, documents, templates });
    printingRoutes(api, { printing, office, store, notify: (t) => hub.invalidate(t), download: opts.officeDownload });
    scanningRoutes(api, { scanning, store, notify: (t) => hub.invalidate(t) });
    displayRoutes(api, { displays, images: displayImages, hub, store, notify: (t) => hub.invalidate(t) });
    workstationRoutes(api, { workstations, users, limiter, store, notify: (t) => hub.invalidate(t) });
    api.get('/api/video/sources', async () => videos.list());
    cameraRoutes(api, { cameras, presets: cameraPresets, devices, incidents, store, notify: (t) => hub.invalidate(t) });
    wifiRoutes(api, { wifi, store, notify: (t) => hub.invalidate(t) });
    monitoringRoutes(api, { monitoring, store, notify: (t) => hub.invalidate(t) });
    bluetoothRoutes(api, { bluetooth, store, notify: (t) => hub.invalidate(t) });
    mapRoutes(api, tiles, store, settings, () => hub.invalidate(['audit']), geocoder);
    weatherRoutes(api, weather, weatherWatch);
    appLinkRoutes(api, appLinks);
    personnelRoutes(api, personnel);
    api.get('/api/settings', async () => settings.get());
    api.put('/api/settings', async (req) => {
      const parsed = settingsInputSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const before = settings.get();
      const next = settings.update(parsed.data, operatorOf(req));
      const changed = [
        JSON.stringify(before.vehicle) !== JSON.stringify(next.vehicle) && `Fahrzeug: ${next.vehicle.name} / ${next.vehicle.callsign}`,
        JSON.stringify(before.mapSign) !== JSON.stringify(next.mapSign) && 'Kartenzeichen geändert',
      ].filter(Boolean);
      store.addAudit({ operator: operatorOf(req), target: 'einstellungen', action: 'update', params: '', success: true, message: changed.join(', ') });
      hub.invalidate(['audit']);
      return next;
    });
    if (docker) addonRoutes(api, { ...docker, store, notifyAudit: () => hub.invalidate(['audit']) });
  });

  const webDist = config.webDist ? resolve(config.webDist) : null;
  if (webDist && existsSync(webDist)) {
    await server.register(fastifyStatic, { root: webDist });
    // SPA fallback: unknown client routes deliver index.html, missing API routes and assets stay 404.
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/assets/')) return reply.code(404).send({ error: 'Nicht gefunden' });
      return reply.sendFile('index.html');
    });
  }

  return {
    server,
    devices,
    docker,
    wifi,
    office,
    printing,
    scanning,
    workstations,
    appLinks,
    personnel,
    async start() {
      await devices.start();
      videos.start();
      wifi.start();
      weatherWatch.start();
      appLinks.start();
      personnel.start();
      cleanup();
      cleanupTimer = setInterval(cleanup, 3600_000);
      if (docker) {
        await docker.repos.refresh();
        docker.hosts.start();
        docker.addons.start();
      }
      await server.listen({ host: config.host, port: config.port });
      await scanning.start(config.scan.smtpPort);
      const scan = scanning.status();
      if (scan.error) server.log.warn(`Scan-Eingang (SMTP) nicht gestartet: ${scan.error}`);
      else if (scan.listening) server.log.info(`Scan-Eingang (SMTP) auf Port ${scan.port}`);
    },
    async close() {
      hub.closeAll();
      videos.stop();
      wifi.stop();
      weatherWatch.stop();
      appLinks.stop();
      personnel.stop();
      if (cleanupTimer) clearInterval(cleanupTimer);
      docker?.hosts.stop();
      docker?.addons.stop();
      await devices.stop();
      await scanning.stop();
      await server.close();
      db.close();
    },
  };
}
