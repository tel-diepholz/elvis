import {
  type AddonStoreEntry,
  type AuditEntry,
  type AuthStatus,
  type LoginCandidate,
  type NewUser,
  type Settings,
  type SettingsInput,
  type User,
  type UserPatch,
  type DockerHost,
  type HostSetup,
  type InstalledAddon,
  type OptionValues,
  type CommandResponse,
  type DeviceId,
  type DeviceModule,
  type CameraConfig,
  type DisplayCommand,
  type DisplayMapView,
  type DisplayDevice,
  type DisplayScene,
  type DisplayLayout,
  type DisplaySelf,
  type Workstation,
  type WorkstationInstaller,
  type VideoSources,
  type CameraConfigInput,
  type CameraPreset,
  type CameraTestResult,
  type DeviceModuleConfig,
  type MonitoringTargetConfig,
  type MonitoringTargetInput,
  type MonitoringTestResult,
  type SerialPortInfo,
  type DocumentFolder,
  type DocumentListing,
  type DocumentPatch,
  type DocumentTemplate,
  type FolderSpec,
  type Incident,
  type IncidentDocument,
  type NewBlankDocument,
  type NewFolder,
  type OfficeSession,
  type OfficeStatus,
  type TemplateFolder,
  type TemplateFolderInput,
  type TemplateMeta,
  type TemplateTree,
  type IncidentPatch,
  type JournalEntry,
  type GeoOutline,
  type GeocodeResponse,
  type MapObject,
  type MapObjectPatch,
  type MapPrintRequest,
  type NewMapObject,
  type MapSource,
  type NewIncident,
  type NewJournalEntry,
  type NewUnit,
  type DeployUnitInput,
  type ForceUnit,
  type ForceUnitInput,
  type Unit,
  type UnitPatch,
  type WifiAp,
  type WifiApConfigInput,
  type WifiApTestResult,
  type WifiClient,
  type WifiGuestInfo,
  type WifiOverview,
  type WifiSettings,
  type WifiSettingsInput,
  type Role,
  type RoleInfo,
  type RoleInput,
  type SnoozeInput,
  type Task,
  type TaskInput,
  type TaskTemplate,
  type TaskTemplateInput,
  type GuestPrintJob,
  type PrintJob,
  type PrintOptionsInput,
  type PrintSettings,
  type PrintSettingsInput,
  type PrintStatus,
  type ScanAssign,
  type ScanInbox,
  type ScanItem,
  type ScanSettings,
  type ScanSettingsInput,
} from '@elvis/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'Server nicht erreichbar');
  }
  // Sitzung abgelaufen oder beendet → Anmeldestatus neu laden (siehe lib/auth.tsx).
  if (res.status === 401) window.dispatchEvent(new Event('elvis:unauthorized'));
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Fehler ${res.status}`);
  return data as T;
}

export const api = {
  command: (device: DeviceId, action: string, params?: Record<string, unknown>) =>
    request<CommandResponse>('POST', `/api/devices/${device}/commands`, { action, params }),

  incidents: () => request<Incident[]>('GET', '/api/incidents'),
  activeIncident: () => request<Incident | null>('GET', '/api/incidents/active'),
  incident: (id: number) => request<Incident>('GET', `/api/incidents/${id}`),
  startIncident: (input: NewIncident) => request<Incident>('POST', '/api/incidents', input),
  updateIncident: (id: number, patch: IncidentPatch) => request<Incident>('PATCH', `/api/incidents/${id}`, patch),
  closeIncident: (id: number) => request<Incident>('POST', `/api/incidents/${id}/close`),

  journal: (id: number) => request<JournalEntry[]>('GET', `/api/incidents/${id}/journal`),
  addJournal: (id: number, entry: NewJournalEntry) => request<JournalEntry>('POST', `/api/incidents/${id}/journal`, entry),
  journalCsvUrl: (id: number) => `/api/incidents/${id}/journal.csv`,

  units: (id: number) => request<Unit[]>('GET', `/api/incidents/${id}/units`),
  addUnit: (id: number, unit: NewUnit) => request<Unit>('POST', `/api/incidents/${id}/units`, unit),
  patchUnit: (unitId: number, patch: UnitPatch) => request<Unit>('PATCH', `/api/units/${unitId}`, patch),
  deployUnit: (id: number, input: DeployUnitInput) => request<Unit>('POST', `/api/incidents/${id}/units/deploy`, input),

  forces: () => request<ForceUnit[]>('GET', '/api/forces'),
  createForce: (input: ForceUnitInput) => request<ForceUnit>('POST', '/api/system/forces', input),
  updateForce: (id: number, input: ForceUnitInput) => request<ForceUnit>('PUT', `/api/system/forces/${id}`, input),
  removeForce: (id: number) => request<void>('DELETE', `/api/system/forces/${id}`),
  adoptUnit: (unitId: number) => request<ForceUnit>('POST', `/api/system/forces/adopt/${unitId}`),

  documents: (id: number) => request<DocumentListing>('GET', `/api/incidents/${id}/documents`),
  uploadDocument: (id: number, file: File, description: string, folderId: number | null) => {
    const form = new FormData();
    // Fields must precede the file so the server sees them while streaming.
    form.append('description', description);
    if (folderId !== null) form.append('folderId', String(folderId));
    form.append('file', file);
    return request<IncidentDocument>('POST', `/api/incidents/${id}/documents`, form);
  },
  createFolder: (id: number, folder: NewFolder) => request<DocumentFolder>('POST', `/api/incidents/${id}/folders`, folder),
  removeFolder: (folderId: number) => request<void>('DELETE', `/api/document-folders/${folderId}`),
  createBlankDocument: (id: number, input: NewBlankDocument) => request<IncidentDocument>('POST', `/api/incidents/${id}/documents/blank`, input),
  createFromTemplate: (id: number, templateId: number) => request<IncidentDocument>('POST', `/api/incidents/${id}/documents/from-template`, { templateId }),
  patchDocument: (docId: number, patch: DocumentPatch) => request<IncidentDocument>('PATCH', `/api/documents/${docId}`, patch),
  removeDocument: (docId: number) => request<void>('DELETE', `/api/documents/${docId}`),
  documentUrl: (docId: number, download = false) => `/api/documents/${docId}/content${download ? '?download=1' : ''}`,
  editDocument: (docId: number) => request<OfficeSession>('POST', `/api/documents/${docId}/edit`),
  office: () => request<OfficeStatus>('GET', '/api/office'),

  printing: () => request<PrintStatus>('GET', '/api/printing'),
  printPdf: (file: File, options: PrintOptionsInput) => {
    const form = new FormData();
    // Optionen vor der Datei, damit der Server sie beim Streamen schon kennt
    form.append('options', JSON.stringify(options));
    form.append('file', file);
    return request<PrintJob>('POST', '/api/printing/jobs', form);
  },
  printOffice: (url: string, filename: string, options: PrintOptionsInput) => request<PrintJob>('POST', '/api/printing/office', { url, filename, options }),
  printJob: (ref: string) => request<PrintJob>('GET', `/api/printing/jobs/${ref}`),
  guestPrintJobs: () => request<GuestPrintJob[]>('GET', '/api/printing/guest'),
  guestPrintFileUrl: (id: number) => `/api/printing/guest/${id}/file`,
  releaseGuestPrint: (id: number, options: PrintOptionsInput) => request<PrintJob>('POST', `/api/printing/guest/${id}/release`, { options }),
  discardGuestPrint: (id: number) => request<void>('DELETE', `/api/printing/guest/${id}`),
  printSettings: () => request<{ settings: PrintSettings; jobs: PrintJob[] }>('GET', '/api/system/printing'),
  savePrintSettings: (input: PrintSettingsInput) => request<PrintSettings>('PUT', '/api/system/printing', input),
  scans: () => request<ScanInbox>('GET', '/api/scans'),
  assignScan: (id: number, input: ScanAssign) => request<ScanItem>('POST', `/api/scans/${id}/assign`, input),
  removeScan: (id: number) => request<void>('DELETE', `/api/scans/${id}`),
  scanSettings: () => request<ScanSettings>('GET', '/api/system/scanning'),
  saveScanSettings: (input: ScanSettingsInput) => request<ScanSettings>('PUT', '/api/system/scanning', input),

  templates: () => request<TemplateTree>('GET', '/api/templates'),
  templateUrl: (id: number, download = false) => `/api/templates/${id}/content${download ? '?download=1' : ''}`,
  uploadTemplate: (meta: TemplateMeta, file: File) => {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('file', file);
    return request<DocumentTemplate>('POST', '/api/templates', form);
  },
  updateTemplate: (id: number, meta: TemplateMeta) => request<DocumentTemplate>('PUT', `/api/templates/${id}`, meta),
  replaceTemplateFile: (id: number, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<DocumentTemplate>('PUT', `/api/templates/${id}/file`, form);
  },
  removeTemplate: (id: number) => request<void>('DELETE', `/api/templates/${id}`),
  editTemplate: (id: number) => request<OfficeSession>('POST', `/api/templates/${id}/edit`),
  createTemplateFolder: (input: TemplateFolderInput) => request<TemplateFolder>('POST', '/api/template-folders', input),
  updateTemplateFolder: (id: number, input: TemplateFolderInput) => request<TemplateFolder>('PUT', `/api/template-folders/${id}`, input),
  removeTemplateFolder: (id: number) => request<void>('DELETE', `/api/template-folders/${id}`),

  documentFolderSpec: () => request<{ folders: FolderSpec[]; updatedAt: string | null; updatedBy: string | null }>('GET', '/api/system/document-folders'),
  saveDocumentFolderSpec: (folders: FolderSpec[]) =>
    request<{ folders: FolderSpec[]; updatedAt: string | null; updatedBy: string | null }>('PUT', '/api/system/document-folders', { folders }),

  tasks: (incidentId: number) => request<Task[]>('GET', `/api/incidents/${incidentId}/tasks`),
  createTask: (incidentId: number, input: TaskInput) => request<Task>('POST', `/api/incidents/${incidentId}/tasks`, input),
  updateTask: (id: number, input: TaskInput) => request<Task>('PUT', `/api/tasks/${id}`, input),
  taskDone: (id: number, final = false) => request<Task>('POST', `/api/tasks/${id}/done`, { final }),
  reopenTask: (id: number) => request<Task>('POST', `/api/tasks/${id}/reopen`),
  snoozeTask: (id: number, input: SnoozeInput) => request<Task>('POST', `/api/tasks/${id}/snooze`, input),
  removeTask: (id: number) => request<void>('DELETE', `/api/tasks/${id}`),

  roles: () => request<RoleInfo[]>('GET', '/api/roles'),
  chooseRole: (roleId: number | null) => request<{ role: Role | null }>('PUT', '/api/auth/role', { roleId }),
  createRole: (input: RoleInput) => request<Role>('POST', '/api/system/roles', input),
  updateRole: (id: number, input: RoleInput) => request<Role>('PUT', `/api/system/roles/${id}`, input),
  removeRole: (id: number) => request<void>('DELETE', `/api/system/roles/${id}`),
  reorderRoles: (ids: number[]) => request<Role[]>('PUT', '/api/system/roles/order', { ids }),
  taskTemplates: () => request<TaskTemplate[]>('GET', '/api/system/task-templates'),
  createTaskTemplate: (input: TaskTemplateInput) => request<TaskTemplate>('POST', '/api/system/task-templates', input),
  updateTaskTemplate: (id: number, input: TaskTemplateInput) => request<TaskTemplate>('PUT', `/api/system/task-templates/${id}`, input),
  removeTaskTemplate: (id: number) => request<void>('DELETE', `/api/system/task-templates/${id}`),
  reorderTaskTemplates: (ids: number[]) => request<TaskTemplate[]>('PUT', '/api/system/task-templates/order', { ids }),

  audit: (limit = 200) => request<AuditEntry[]>('GET', `/api/audit?limit=${limit}`),

  settings: () => request<Settings>('GET', '/api/settings'),
  updateSettings: (input: SettingsInput) => request<Settings>('PUT', '/api/settings', input),

  deviceModules: () => request<DeviceModule[]>('GET', '/api/system/devices'),
  configureDevice: (id: DeviceId, config: DeviceModuleConfig) => request<DeviceModule>('PUT', `/api/system/devices/${id}`, config),
  serialPorts: () => request<SerialPortInfo[]>('GET', '/api/system/serialports'),

  videoSources: () => request<VideoSources>('GET', '/api/video/sources'),
  displays: () => request<DisplayDevice[]>('GET', '/api/displays'),
  saveDisplayLayout: (id: string, layout: DisplayLayout) => request<DisplayDevice>('PUT', `/api/displays/${id}/layout`, { layout }),
  saveDisplayScene: (id: string, name: string) => request<DisplayScene>('POST', `/api/displays/${id}/scenes`, { name }),
  updateDisplayScene: (id: string, sceneId: number, patch: { name?: string; overwrite?: boolean }) => request<DisplayScene>('PUT', `/api/displays/${id}/scenes/${sceneId}`, patch),
  removeDisplayScene: (id: string, sceneId: number) => request<void>('DELETE', `/api/displays/${id}/scenes/${sceneId}`),
  lockDisplayScene: (id: string, sceneId: number, locked: boolean) => request<DisplayDevice>('PUT', `/api/displays/${id}/scenes/${sceneId}/lock`, { locked }),
  applyDisplayScene: (id: string, sceneId: number) => request<DisplayDevice>('POST', `/api/displays/${id}/scenes/${sceneId}/apply`),
  reorderDisplayScenes: (id: string, ids: number[]) => request<DisplayDevice>('PUT', `/api/displays/${id}/scenes/order`, { ids }),
  displayCommand: (id: string, action: DisplayCommand) => request<{ ok: boolean }>('POST', `/api/displays/${id}/command`, { action }),
  displayMapView: (id: string, tileId: string, view: DisplayMapView) => request<{ ok: boolean }>('POST', `/api/displays/${id}/map-view`, { tileId, ...view }),
  reportDisplayMapView: (tileId: string, view: DisplayMapView) => request<void>('POST', '/api/display/map-view', { tileId, ...view }),
  pairDisplay: (code: string, name: string) => request<DisplayDevice>('POST', '/api/system/displays/pair', { code, name }),
  renameDisplay: (id: string, name: string) => request<DisplayDevice>('PUT', `/api/system/displays/${id}`, { name }),
  removeDisplay: (id: string) => request<void>('DELETE', `/api/system/displays/${id}`),
  workstations: () => request<Workstation[]>('GET', '/api/system/workstations'),
  workstationInstallers: () => request<WorkstationInstaller[]>('GET', '/api/system/workstations/installers'),
  renameWorkstation: (id: string, name: string) => request<Workstation>('PUT', `/api/system/workstations/${id}`, { name }),
  removeWorkstation: (id: string) => request<void>('DELETE', `/api/system/workstations/${id}`),
  reorderDisplays: (ids: string[]) => request<DisplayDevice[]>('PUT', '/api/system/displays/order', { ids }),
  displaySelf: () => request<DisplaySelf>('GET', '/api/display/self'),
  displayStartPairing: () => request<DisplaySelf>('POST', '/api/display/pair'),
  displayHeartbeat: (width: number, height: number) => request<void>('POST', '/api/display/heartbeat', { width, height }),

  cameraConfigs: () => request<CameraConfig[]>('GET', '/api/system/cameras'),
  createCamera: (input: CameraConfigInput) => request<CameraConfig>('POST', '/api/system/cameras', input),
  updateCamera: (id: string, input: CameraConfigInput) => request<CameraConfig>('PUT', `/api/system/cameras/${id}`, input),
  removeCamera: (id: string) => request<void>('DELETE', `/api/system/cameras/${id}`),
  reorderCameras: (ids: string[]) => request<CameraConfig[]>('PUT', '/api/system/cameras/order', { ids }),
  testCamera: (camera: CameraConfigInput, id?: string) => request<CameraTestResult>('POST', '/api/system/cameras/test', { camera, id }),
  cameraStreamUrl: (id: string, kind: 'live' | 'thumb' = 'live') => `/api/cameras/${encodeURIComponent(id)}/stream?kind=${kind}`,
  wifi: () => request<WifiOverview>('GET', '/api/system/wifi'),
  updateWifiSettings: (input: WifiSettingsInput) => request<WifiSettings>('PUT', '/api/system/wifi/settings', input),
  createWifiAp: (input: WifiApConfigInput) => request<WifiAp>('POST', '/api/system/wifi/aps', input),
  updateWifiAp: (id: string, input: WifiApConfigInput) => request<WifiAp>('PUT', `/api/system/wifi/aps/${id}`, input),
  removeWifiAp: (id: string) => request<void>('DELETE', `/api/system/wifi/aps/${id}`),
  reorderWifiAps: (ids: string[]) => request<WifiAp[]>('PUT', '/api/system/wifi/aps/order', { ids }),
  testWifiAp: (ap: WifiApConfigInput, id?: string) => request<WifiApTestResult>('POST', '/api/system/wifi/aps/test', { ap, id }),
  syncWifi: () => request<WifiOverview>('POST', '/api/system/wifi/sync'),
  wifiClients: () => request<WifiClient[]>('GET', '/api/wifi/clients'),
  wifiGuest: () => request<WifiGuestInfo>('GET', '/api/wifi/guest'),
  monitoringTargets: () => request<MonitoringTargetConfig[]>('GET', '/api/system/monitoring'),
  createMonitoringTarget: (input: MonitoringTargetInput) => request<MonitoringTargetConfig>('POST', '/api/system/monitoring', input),
  updateMonitoringTarget: (id: string, input: MonitoringTargetInput) => request<MonitoringTargetConfig>('PUT', `/api/system/monitoring/${id}`, input),
  removeMonitoringTarget: (id: string) => request<void>('DELETE', `/api/system/monitoring/${id}`),
  reorderMonitoringTargets: (ids: string[]) => request<MonitoringTargetConfig[]>('PUT', '/api/system/monitoring/order', { ids }),
  testMonitoringTarget: (input: MonitoringTargetInput) => request<MonitoringTestResult>('POST', '/api/system/monitoring/test', input),
  cameraPresets: () => request<CameraPreset[]>('GET', '/api/cameras/presets'),
  saveCameraPreset: (cameraId: string, name: string) => request<CameraPreset>('POST', '/api/cameras/presets', { cameraId, name }),
  gotoCameraPreset: (id: number) => request<CommandResponse>('POST', `/api/cameras/presets/${id}/goto`),
  removeCameraPreset: (id: number) => request<void>('DELETE', `/api/cameras/presets/${id}`),

  authStatus: () => request<AuthStatus>('GET', '/api/auth/status'),
  loginCandidates: () => request<LoginCandidate[]>('GET', '/api/auth/candidates'),
  login: (userId: number, pin: string) => request<User>('POST', '/api/auth/login', { userId, pin }),
  logout: () => request<void>('POST', '/api/auth/logout'),
  setupFirstAdmin: (input: NewUser) => request<User>('POST', '/api/auth/setup', input),
  changeOwnPin: (currentPin: string, newPin: string) => request<void>('POST', '/api/auth/pin', { currentPin, newPin }),
  users: () => request<User[]>('GET', '/api/users'),
  createUser: (input: NewUser) => request<User>('POST', '/api/users', input),
  updateUser: (id: number, patch: UserPatch) => request<User>('PATCH', `/api/users/${id}`, patch),
  deleteUser: (id: number) => request<void>('DELETE', `/api/users/${id}`),

  dockerHosts: () => request<DockerHost[]>('GET', '/api/docker/hosts'),
  addDockerHost: (input: { certMode: 'elvis'; name: string; address: string; port?: number } | { certMode: 'custom'; name: string; address: string; port?: number; caPem: string; certPem: string; keyPem: string }) =>
    request<HostSetup | { host: DockerHost; command: null; expiresAt: null }>('POST', '/api/docker/hosts', input),
  renewHostSetup: (id: number) => request<HostSetup>('POST', `/api/docker/hosts/${id}/setup`),
  testDockerHost: (id: number) => request<DockerHost>('POST', `/api/docker/hosts/${id}/test`),
  updateDockerHost: (id: number, patch: { name?: string; address?: string; port?: number }) =>
    request<{ host: DockerHost; setup: HostSetup | null }>('PATCH', `/api/docker/hosts/${id}`, patch),
  removeDockerHost: (id: number, force = false) => request<void>('DELETE', `/api/docker/hosts/${id}${force ? '?force=true' : ''}`),

  addonStore: () => request<AddonStoreEntry[]>('GET', '/api/addons/store'),
  refreshAddonStore: () => request<{ ok: boolean }>('POST', '/api/addons/store/refresh'),
  addons: () => request<InstalledAddon[]>('GET', '/api/addons'),
  addon: (id: string) => request<InstalledAddon>('GET', `/api/addons/${id}`),
  installAddon: (addonId: string, hostId: number, options: OptionValues) => request<InstalledAddon>('POST', '/api/addons', { addonId, hostId, options }),
  reconfigureAddon: (id: string, options: OptionValues) => request<InstalledAddon>('PATCH', `/api/addons/${id}`, { options }),
  updateAddon: (id: string) => request<InstalledAddon>('POST', `/api/addons/${id}/update`),
  addonPower: (id: string, action: 'start' | 'stop' | 'restart') => request<InstalledAddon>('POST', `/api/addons/${id}/${action}`),
  runAddonJob: (id: string, job: string) => request<InstalledAddon>('POST', `/api/addons/${id}/jobs/${job}`),
  uninstallAddon: (id: string, removeData: boolean) => request<void>('DELETE', `/api/addons/${id}${removeData ? '?data=1' : ''}`),
  addonLogs: async (id: string, target: string, tail: number): Promise<string> => {
    const res = await fetch(`/api/addons/${id}/logs?target=${encodeURIComponent(target)}&tail=${tail}`);
    if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Fehler ${res.status}`);
    return res.text();
  },

  mapSources: () => request<MapSource[]>('GET', '/api/map/sources'),
  tileUrl: (sourceId: string) => `/api/map/tiles/${sourceId}/{z}/{x}/{y}`,
  mapObjects: (incidentId: number) => request<MapObject[]>('GET', `/api/incidents/${incidentId}/objects`),
  addMapObject: (incidentId: number, o: NewMapObject) => request<MapObject>('POST', `/api/incidents/${incidentId}/objects`, o),
  patchMapObject: (id: number, patch: MapObjectPatch) => request<MapObject>('PATCH', `/api/map-objects/${id}`, patch),
  removeMapObject: (id: number) => request<void>('DELETE', `/api/map-objects/${id}`),
  mapOutline: (osm: string) => request<GeoOutline>('GET', `/api/map/outline/${osm}`),
  mapSearch: (q: string, focus: { lat: number; lon: number } | null) =>
    request<GeocodeResponse>('GET', `/api/map/search?${new URLSearchParams({ q, ...(focus && { lat: focus.lat.toFixed(4), lon: focus.lon.toFixed(4) }) })}`),
  /** Liefert das PDF als Blob; Fehler kommen wie bei den übrigen Aufrufen als ApiError. */
  printMap: async (req: MapPrintRequest): Promise<{ pdf: Blob; filename: string; missingTiles: number }> => {
    let res: Response;
    try {
      res = await fetch('/api/print/map', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
    } catch {
      throw new ApiError(0, 'Server nicht erreichbar');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Fehler ${res.status}`);
    }
    const disposition = res.headers.get('content-disposition') ?? '';
    const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
    const filename = encoded ? decodeURIComponent(encoded) : (/filename="([^"]+)"/.exec(disposition)?.[1] ?? 'Lagekarte.pdf');
    return { pdf: await res.blob(), filename, missingTiles: Number(res.headers.get('x-missing-tiles') ?? 0) };
  },
};
