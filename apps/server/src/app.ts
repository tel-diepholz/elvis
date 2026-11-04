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
import { vehiclePositionRoutes } from './routes/vehiclePosition.js';
import { VehiclePositionService } from './services/vehiclePosition.js';
import { ForceService } from './services/forces.js';
import { IncidentService } from './services/incidents.js';
import { SettingsService } from './services/settings.js';
import { GeocoderService, type GeocodeFetch } from './services/geocoder.js';
import { OverpassService, type OverpassFetch } from './services/overpass.js';
import { RouterService, type RouterFetch } from './services/router.js';
import { RadarService, type RadarFetch } from './services/radar.js';
import { WeatherAlertWatch, WeatherService, type WeatherFetch } from './services/weather.js';
import { weatherRoutes } from './routes/weather.js';
import { trafficRoutes } from './routes/traffic.js';
import { energyFlowRoutes } from './routes/energyflow.js';
import { TrafficService, type AisSocketFactory, type TrafficFetch } from './services/traffic.js';
import { AppLinkService } from './services/applinks.js';
import { RelayClient, type RelayFetch } from './services/relay.js';
import { PersonnelService } from './services/personnel.js';
import { personnelRoutes } from './routes/personnel.js';
import { appLinkRoutes } from './routes/applinks.js';
import { MailService, type MailFetch } from './services/mail.js';
import type { WkdFetch } from './services/mailcrypto.js';
import { mailRoutes } from './routes/mail.js';
import { reportRoutes } from './routes/report.js';
import { ReportService } from './services/report/index.js';
import type { OfficeConverter } from './services/report/attachments.js';
import { chatRoutes } from './routes/chat.js';
import { messagingRoutes } from './routes/messaging.js';
import { telephonyRoutes } from './routes/telephony.js';
import { ChatService } from './services/chat.js';
import { MessagingService, type MessagingFetch } from './services/messaging/index.js';
import type { SocketFactory } from './services/messaging/socket.js';
import { ReachabilityService } from './services/reachability.js';
import { MessengerBus } from './devices/messaging/bus.js';
import { dbVault } from './devices/messaging/vault.js';
import { HookService } from './services/hooks.js';
import { MessengerProvisions } from './devices/messaging/provisions.js';
import { CallLogService } from './services/telephony.js';
import { TelephonyBus } from './devices/telephony/bus.js';
import { contactRoutes } from './routes/contacts.js';
import { ContactService } from './services/contacts.js';
import { phonebookRoutes } from './routes/phonebook.js';
import { PhonebookService } from './services/phonebook.js';
import { phoneRoutes } from './routes/phones.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { DashboardService } from './services/dashboards.js';
import { PhoneService, type PhoneFetch } from './services/phones.js';
import { backupRoutes } from './routes/backup.js';
import { updateRoutes } from './routes/updates.js';
import { UpdateService, type UpdateFetch } from './services/updates.js';
import { ELVIS_VERSION } from './version.js';
import { BackupService, type DriverFactory } from './services/backup/service.js';
import { ElwCloudDriver, type BackupFetch } from './services/backup/elwCloud.js';
import { RestoreService } from './services/backup/restore.js';
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
import { georefRoutes } from './routes/georef.js';
import { GeorefService } from './services/georef.js';
import { wopiRoutes } from './routes/wopi.js';
import { DocumentService } from './services/documents.js';
import { OfficeService, type DiscoveryFetch } from './services/office.js';
import { TemplateService } from './services/templates.js';
import { RoleService } from './services/roles.js';
import { TaskService } from './services/tasks.js';
import { taskRoutes } from './routes/tasks.js';
import { MessageService } from './services/messages.js';
import { RequestService } from './services/requests.js';
import { DamageService } from './services/damage.js';
import { messageRoutes } from './routes/messages.js';
import { requestRoutes } from './routes/requests.js';
import { damageRoutes } from './routes/damage.js';
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
  phones: PhoneService;
  appLinks: AppLinkService;
  personnel: PersonnelService;
  mail: MailService;
  chat: ChatService;
  messaging: MessagingService;
  report: ReportService;
  reachability: ReachabilityService;
  calls: CallLogService;
  traffic: TrafficService;
  router: RouterService;
  backup: BackupService;
  start(): Promise<void>;
  close(): Promise<void>;
}

export async function buildApp(config: ElvisConfig, opts: { logger?: boolean; dockerFactory?: DockerFactory; geocodeFetch?: GeocodeFetch; overpassFetch?: OverpassFetch; overpassRetryDelaysMs?: number[]; routerFetch?: RouterFetch; radarFetch?: RadarFetch; weatherFetch?: WeatherFetch; trafficFetch?: TrafficFetch; trafficRequestGapMs?: number; aisSocket?: AisSocketFactory; wifiHttp?: UbusHttp; officeFetch?: DiscoveryFetch; officeConvert?: OfficeConverter | null; ippTransport?: IppTransport; officeDownload?: OfficeDownload; monitoringProbes?: ProbeDeps; relayFetch?: RelayFetch; mailFetch?: MailFetch; wkdFetch?: WkdFetch; backupFetch?: BackupFetch; messagingFetch?: MessagingFetch; messagingSocket?: SocketFactory; updateFetch?: UpdateFetch; phoneFetch?: PhoneFetch; phonePushDelayMs?: number; restart?: () => void } = {}): Promise<App> {
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
  // Telefonie- und Messenger-Treiber → Nachrichten und Anrufliste (die Dienste entstehen erst nach den Fahrzeugmodulen)
  const telephonyBus = new TelephonyBus();
  const messengerBus = new MessengerBus();
  // Cloud-Relay vor den Fahrzeugmodulen: WhatsApp und Threema empfangen ihre Webhooks darüber
  const relay = new RelayClient(db, config.app.relayUrl, opts.relayFetch);
  const hooks = new HookService(db, relay, server.log);
  const messengerServices = new MessengerProvisions();
  const devices = new DeviceManager(config, server.log, new DeviceConfigStore(db, config.devices, config.edition), { cameras, wifi, monitoring, bluetooth, telephony: telephonyBus, messenger: messengerBus, vault: dbVault(db), hooks, messengerServices });
  const settings = new SettingsService(db, { vehicle: config.vehicle });
  const hub = new LiveHub(devices, () => settings.get().vehicle);
  // Fahrzeugstandort: GPS der Wetterstation, ohne GPS-Fix von Hand in der Karte gesetzt
  const vehiclePos = new VehiclePositionService(db, () => devices.adapter('weather')?.getState().position, () => hub.invalidate(['settings']));
  devices.onDevice((d) => d.id === 'weather' && vehiclePos.gpsChanged());
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
  const messages = new MessageService(db, { store, roles, notify: (t) => hub.invalidate(t) });
  const requests = new RequestService(db, { store, roles, tasks, messages, notify: (t) => hub.invalidate(t) });
  const damage = new DamageService(db, { store, notify: (t) => hub.invalidate(t) });
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
    try {
      chat.cleanup();
    } catch (err) {
      server.log.warn({ err }, 'Nachrichten-Bilder aufräumen fehlgeschlagen');
    }
    void printing.cleanupGuest().catch((err) => server.log.warn({ err }, 'Gastaufträge aufräumen fehlgeschlagen'));
    try {
      calls.cleanup();
    } catch (err) {
      server.log.warn({ err }, 'Anrufliste aufräumen fehlgeschlagen');
    }
  };
  let cleanupTimer: NodeJS.Timeout | null = null;
  const tiles = new TileService(config.map, config.dataDir, db);
  const geocoder = new GeocoderService(
    { onlineUrl: config.map.geocoderUrl, outlineUrl: config.map.outlineUrl, dataDir: config.dataDir, userAgent: config.map.userAgent },
    opts.geocodeFetch,
  );
  const overpass = new OverpassService({ onlineUrl: config.map.overpassUrl, userAgent: config.map.userAgent, retryDelaysMs: opts.overpassRetryDelaysMs }, db, opts.overpassFetch);
  const router = new RouterService(opts.routerFetch);
  const radar = new RadarService({ ...config.map.radar, userAgent: config.map.userAgent }, opts.radarFetch);
  const weather = new WeatherService(
    { ...config.weather, userAgent: config.map.userAgent, cacheFile: config.dataDir === ':memory:' ? null : join(config.dataDir, 'weather-cache.json') },
    opts.weatherFetch,
  );
  // Unwetter am Fahrzeugstandort (GPS bzw. von Hand gesetzt, sonst Einsatzort) erscheinen als Meldung
  const weatherWatch = new WeatherAlertWatch(
    weather,
    () => {
      const pos = vehiclePos.current();
      if (pos) return pos;
      const incident = store.activeIncident();
      return incident?.lat != null && incident.lon != null ? { lat: incident.lat, lon: incident.lon } : null;
    },
    (alerts) => devices.setExtraAlerts('weather', alerts),
  );
  // Luft- und Schiffsverkehr; das AIS-Abo folgt dem Einsatzort, sonst der Fahrzeugposition
  const traffic = new TrafficService(
    { ...config.traffic, userAgent: config.map.userAgent, requestGapMs: opts.trafficRequestGapMs },
    {
      db,
      store,
      incidents,
      center: () => {
        const incident = store.activeIncident();
        if (incident?.lat != null && incident.lon != null) return { lat: incident.lat, lon: incident.lon };
        return vehiclePos.current();
      },
    },
    opts.trafficFetch,
    opts.aisSocket,
  );
  const appLinks = new AppLinkService(db, store, incidents, (t) => hub.invalidate(t), relay);
  const personnel = new PersonnelService(db, store, incidents, (t) => hub.invalidate(t), relay, () => settings.get().vehicle.name);
  const contacts = new ContactService(db, store, (t) => {
    if (!t.includes('contacts')) return hub.invalidate(t);
    // Kontaktnamen stehen auch in den Nachrichten; neue oder geänderte Rufnummern gleich bei den Messengern prüfen
    hub.invalidate([...t, 'chat']);
    reachability.kick();
    // Kontakt-Tasten der Telefone zeigen Namen und Nummer des Kontakts
    phones.contactsChanged();
  });
  const phonebook = new PhonebookService(db, contacts);
  const phones = new PhoneService(db, {
    contacts: () => contacts.list(),
    activeIncident: () => incidents.active(),
    phonebook: () => phonebook.entries(),
    log: server.log,
    fetch: opts.phoneFetch,
    pushDelayMs: opts.phonePushDelayMs,
  });
  phones.onChange(() => hub.invalidate(['phones']));
  // Überschreibungen der Tasten gelten nur im Einsatz
  incidents.onClosed((incident) => phones.incidentClosed(incident.id));
  const trunkName = (port: number | null) => (port === null ? null : (devices.adapter('telephony')?.getState().trunks.find((t) => t.port === port)?.name ?? `GSM ${port}`));
  const calls = new CallLogService(db, { store, bus: telephonyBus, numbers: () => contacts.numberIndex(), trunkName, self: () => settings.get().vehicle.name, notify: (t) => hub.invalidate(t) });
  const chat = new ChatService(db, { store, devices, telephony: telephonyBus, messenger: messengerBus, numbers: () => contacts.numberIndex(), notify: (t) => hub.invalidate(t), dataDir: config.dataDir });
  const reachability = new ReachabilityService(db, {
    devices,
    contactNumbers: () => [...contacts.numberIndex().keys()],
    channels: () => {
      const a = chat.available();
      return { order: a.order, available: new Set(a.channels.filter((c) => c.available).map((c) => c.channel)) };
    },
    notify: (t) => hub.invalidate(t),
  });
  const backupDrivers: DriverFactory = (_driver, keys) =>
    new ElwCloudDriver(config.app.relayUrl, keys.vaultId, keys.vaultToken, async () => (await relay.ensureCredentials()).token, opts.backupFetch);
  const updates = new UpdateService({ edition: config.edition, dataDir: config.dataDir, repo: config.updates.repo, apiUrl: config.updates.apiUrl, fetch: opts.updateFetch, log: server.log });
  const backup = new BackupService(db, {
    dataDir: config.dataDir,
    configFile: config.configFile,
    drivers: backupDrivers,
    vehicle: () => settings.get().vehicle.name,
    notify: (t) => hub.invalidate(t),
    audit: (message, operator) => {
      store.addAudit({ operator, target: 'backup', action: 'update', params: '', success: true, message });
      hub.invalidate(['audit']);
    },
  });
  // Ohne Neustart-Funktion (Tests) bleibt die Wiederherstellung vorbereitet bis zum nächsten Start
  const restore = new RestoreService({ dataDir: config.dataDir, drivers: backupDrivers, hasUsers: () => users.hasUsers(), restart: opts.restart ?? (() => undefined) });
  const mail = new MailService(db, store, (t) => {
    hub.invalidate(t);
    // Postfach aktiv geworden oder weg: Cloud Messaging verbindet bzw. trennt
    if (t.includes('mail')) messaging.mailChanged();
  }, relay, {
    ...config.mail,
    dataDir: config.dataDir,
    vehicleName: () => settings.get().vehicle.name,
    fetch: opts.mailFetch,
    wkdFetch: opts.wkdFetch,
  });
  // Cloud Messaging: Fahrzeug-Chat mit anderen ELVIS-Installationen (Kanal „Fahrzeug-Chat“ in den Nachrichten)
  const messaging: MessagingService = new MessagingService({
    db,
    store,
    notify: (t) => hub.invalidate(t),
    relay,
    mail,
    vehicle: () => settings.get().vehicle,
    crew: () => sessions.activeMembers().map(({ name, roles }) => ({ name, roles })),
    meldungen: {
      incident: () => {
        const i = store.activeIncident();
        return i ? { id: i.id, label: [i.keyword, i.title].filter(Boolean).join(' ') } : null;
      },
      units: (incidentId) => store.units(incidentId),
      message: (id) => messages.get(id, null),
      receive: (incidentId, sender, body, createdBy) => messages.receive(incidentId, sender, body, createdBy),
    },
    log: server.log,
    fetch: opts.messagingFetch,
    socketFactory: opts.messagingSocket,
  });
  messaging.attachChat(chat);
  chat.attachCloud(messaging);
  settings.onChange(() => void messaging.syncProfile());
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
    addons.attachOverpass(overpass);
    addons.attachRouter(router);
    addons.attachOffice(office);
    addons.attachMessengers(messengerServices);
    addons.attachPrinting(printing);
    addons.attachWorkstations(workstations);
    docker = { hosts, repos, addons };
  }
  const georef = new GeorefService({ dataDir: config.dataDir, documents, incidents, hosts: docker?.hosts ?? null, notify: (t) => hub.invalidate(t) });
  const report = new ReportService({
    db,
    store,
    documents,
    personnel,
    damage,
    tasks,
    requests,
    messages,
    calls,
    chat,
    mail,
    tiles,
    office,
    settings: () => settings.get(),
    overlayTile: (id, z, x, y) => georef.tile(id, z, x, y),
    convert: opts.officeConvert,
    log: server.log,
  });
  // Beim Beenden: Einsatzbericht erzeugen und unter „Protokolle“ ablegen
  incidents.onClosed((incident, operator) => void report.archive(incident, operator));

  await server.register(fastifyCookie);
  await server.register(fastifyWebsocket);
  await server.register(fastifyMultipart);

  // Anmeldung: Sitzung aus dem Cookie auflösen und Zugriffsregeln durchsetzen (siehe auth/access.ts).
  server.decorateRequest('user', null);
  // Fastify verbietet Arrays als Vorgabe (geteilte Referenz) – der Hook setzt den Wert bei jeder Anfrage
  server.decorateRequest('roleIds', null as unknown as number[]);
  server.decorateRequest('roleChosen', false);
  server.addHook('onRequest', async (req) => {
    const session = sessions.resolve(req.cookies[SESSION_COOKIE]);
    req.user = session ? users.find(session.userId) : null;
    req.roleIds = req.user ? session!.roleIds : [];
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
      edition: config.edition,
      version: ELVIS_VERSION,
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
    messageRoutes(api, { messages, store, incidents, forces, mail, chat, notify: (t) => hub.invalidate(t) });
    requestRoutes(api, { requests, store, notify: (t) => hub.invalidate(t) });
    damageRoutes(api, { damage });
    deviceRoutes(api, devices, store, (t) => hub.invalidate(t));
    incidentRoutes(api, { incidents, forces, store, notify: (t) => hub.invalidate(t) });
    documentRoutes(api, { documents, templates, office, store, notify: (t) => hub.invalidate(t) });
    georefRoutes(api, georef);
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
    vehiclePositionRoutes(api, { position: vehiclePos, store, notify: (t) => hub.invalidate(t) });
    mapRoutes(api, tiles, store, settings, (t) => hub.invalidate(t), geocoder, overpass, router, radar, (id, z, x, y) => georef.tile(id, z, x, y));
    weatherRoutes(api, weather, weatherWatch, {
      settings,
      store,
      notify: (t) => hub.invalidate(t),
      station: () => (devices.adapter('weather') ? devices.snapshot('weather') : null),
      stormLimitMs: config.alerts.stormWarnMs,
    });
    trafficRoutes(api, { traffic, store, notify: (t) => hub.invalidate(t) });
    energyFlowRoutes(api, { db, store, notify: (t) => hub.invalidate(t) });
    appLinkRoutes(api, appLinks);
    personnelRoutes(api, personnel);
    mailRoutes(api, mail);
    messagingRoutes(api, messaging);
    chatRoutes(api, { chat, reachability, contacts, documents });
    telephonyRoutes(api, { calls });
    reportRoutes(api, { report, store, notify: (t) => hub.invalidate(t) });
    contactRoutes(api, { contacts, personnel });
    phonebookRoutes(api, { phonebook, store, notify: (t) => hub.invalidate(t) });
    phoneRoutes(api, { phones, store, notify: (t) => hub.invalidate(t) });
    dashboardRoutes(api, { dashboards: new DashboardService(db, config.edition) });
    backupRoutes(api, { backup, restore });
    updateRoutes(api, { updates, store });
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
    phones,
    appLinks,
    personnel,
    mail,
    report,
    chat,
    messaging,
    reachability,
    calls,
    traffic,
    router,
    backup,
    async start() {
      // Webserver zuerst: ein hängendes Gerät (z. B. ein Monitoring-Ziel, das nicht antwortet) darf
      // Weboberfläche und Healthcheck nicht blockieren
      await server.listen({ host: config.host, port: config.port });
      await devices.start();
      videos.start();
      wifi.start();
      weatherWatch.start();
      traffic.start();
      appLinks.start();
      personnel.start();
      mail.start();
      messaging.start();
      backup.start();
      reachability.start();
      cleanup();
      cleanupTimer = setInterval(cleanup, 3600_000);
      if (docker) {
        await docker.repos.refresh();
        docker.hosts.start();
        docker.addons.start();
      }
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
      traffic.stop();
      appLinks.stop();
      personnel.stop();
      mail.stop();
      messaging.stop();
      backup.stop();
      reachability.stop();
      phones.stop();
      hooks.stop();
      if (cleanupTimer) clearInterval(cleanupTimer);
      docker?.hosts.stop();
      docker?.addons.stop();
      await devices.stop();
      await scanning.stop();
      await report.idle();
      await server.close();
      db.close();
    },
  };
}
