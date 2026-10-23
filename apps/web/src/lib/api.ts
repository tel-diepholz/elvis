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
  type DisplayDevice,
  type DisplayScene,
  type DisplayLayout,
  type DisplaySelf,
  type VideoSources,
  type CameraConfigInput,
  type CameraPreset,
  type CameraTestResult,
  type DeviceModuleConfig,
  type SerialPortInfo,
  type Incident,
  type IncidentDocument,
  type IncidentPatch,
  type JournalEntry,
  type MapPrintRequest,
  type MapSource,
  type NewIncident,
  type NewJournalEntry,
  type NewUnit,
  type Unit,
  type UnitPatch,
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

  documents: (id: number) => request<IncidentDocument[]>('GET', `/api/incidents/${id}/documents`),
  uploadDocument: (id: number, file: File, description: string) => {
    const form = new FormData();
    // Fields must precede the file so the server sees them while streaming.
    form.append('description', description);
    form.append('file', file);
    return request<IncidentDocument>('POST', `/api/incidents/${id}/documents`, form);
  },
  removeDocument: (docId: number) => request<void>('DELETE', `/api/documents/${docId}`),
  documentUrl: (docId: number, download = false) => `/api/documents/${docId}/content${download ? '?download=1' : ''}`,

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
  applyDisplayScene: (id: string, sceneId: number) => request<DisplayDevice>('POST', `/api/displays/${id}/scenes/${sceneId}/apply`),
  reorderDisplayScenes: (id: string, ids: number[]) => request<DisplayDevice>('PUT', `/api/displays/${id}/scenes/order`, { ids }),
  displayCommand: (id: string, action: DisplayCommand) => request<{ ok: boolean }>('POST', `/api/displays/${id}/command`, { action }),
  pairDisplay: (code: string, name: string) => request<DisplayDevice>('POST', '/api/system/displays/pair', { code, name }),
  renameDisplay: (id: string, name: string) => request<DisplayDevice>('PUT', `/api/system/displays/${id}`, { name }),
  removeDisplay: (id: string) => request<void>('DELETE', `/api/system/displays/${id}`),
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
  removeDockerHost: (id: number) => request<void>('DELETE', `/api/docker/hosts/${id}`),

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
