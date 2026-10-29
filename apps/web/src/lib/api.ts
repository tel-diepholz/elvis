import {
  type BackupConfirmInput,
  type BackupDriverId,
  type BackupSettingsInput,
  type BackupSetup,
  type BackupStatus,
  type BackupSummary,
  type RestoreStartInput,
  type RestoreStatus,
  type Contact,
  type ContactCategory,
  type ContactCategoryInput,
  type ContactInput,
  type MailAddressSuggestion,
  type MailAccountRequest,
  type MailAccountStatus,
  type MailDraft,
  type MailFolder,
  type MailList,
  type MailMessage,
  type MailRecipientKey,
  type MailSendResult,
  type IncidentOverpassQuery,
  type OverpassBounds,
  type OverpassQuery,
  type OverpassQueryInput,
  type OverpassQuerySettings,
  type OverpassResult,
  type OverpassStatus,
  type RadarFrames,
  type Person,
  type PersonInput,
  type PersonnelForm,
  type PersonnelFormInput,
  type PersonnelInbox,
  type PersonnelSheet,
  type SheetAssign,
  type AppLink,
  type AppRelayStatus,
  type PairInput,
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
  type DisplayImage,
  type DisplayScene,
  type DisplayLayout,
  type DisplaySelf,
  type DisplayTheme,
  type Workstation,
  type WorkstationInstaller,
  type WorkstationUpdateRequest,
  type VideoSources,
  type CameraConfigInput,
  type CameraPreset,
  type CameraTestResult,
  type DeviceModuleConfig,
  type BluetoothDeviceConfig,
  type BluetoothDeviceInput,
  type MonitoringTargetConfig,
  type MonitoringTargetInput,
  type MonitoringTestResult,
  type SerialPortInfo,
  type DocumentFolder,
  type DocumentListing,
  type GeorefJob,
  type GeorefPage,
  type GeorefRequest,
  type GeorefStatus,
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
  type WeatherReport,
  type WeatherWarnings,
  type GeocodeResponse,
  type MapHistoryState,
  type MapObject,
  type MapObjectPatch,
  type MapPrintRequest,
  type RoutePrintRequest,
  type RouteRequest,
  type RouteResult,
  type RouterStatus,
  type NewMapObject,
  type MapSource,
  type MapSourceInput,
  type MapSourceSettings,
  type MapSourceTestResult,
  type Aircraft,
  type AircraftDetail,
  type AircraftPhoto,
  type Ship,
  type TrafficHit,
  type TrafficResult,
  type TrafficSettings,
  type TrafficSettingsInput,
  type NewIncident,
  type NewJournalEntry,
  type NewUnit,
  type DeployUnitInput,
  type ForceUnit,
  type ForceUnitInput,
  type ForceImportInput,
  type ForceImportPreview,
  type ForceImportResult,
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
  type Message,
  type MessageContext,
  type MessageInput,
  type MessageSettings,
  type MessageSettingsInput,
  type MaterialRequest,
  type RequestForwardInput,
  type RequestInput,
  type RequestNoteInput,
  type RequestPatch,
  type RequestSettings,
  type RequestSettingsInput,
  type RequestStatusInput,
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
  appRelayEnabled: () => request<{ enabled: boolean }>('GET', '/api/app-relay'),
  appRelayStatus: () => request<AppRelayStatus>('GET', '/api/system/app-relay'),
  mailAccount: () => request<MailAccountStatus>('GET', '/api/system/mail'),
  requestMailAccount: (input: MailAccountRequest) => request<MailAccountStatus>('POST', '/api/system/mail', input),
  cancelMailAccount: () => request<void>('DELETE', '/api/system/mail'),
  backupStatus: () => request<BackupStatus>('GET', '/api/system/backup'),
  updateBackup: (input: BackupSettingsInput) => request<BackupStatus>('PUT', '/api/system/backup', input),
  disableBackup: () => request<void>('DELETE', '/api/system/backup'),
  backupSetup: (driver: BackupDriverId) => request<BackupSetup>('POST', '/api/system/backup/setup', { driver }),
  backupConfirm: (input: BackupConfirmInput) => request<BackupStatus>('POST', '/api/system/backup/setup/confirm', input),
  runBackup: () => request<BackupStatus>('POST', '/api/system/backup/run'),
  restoreList: (driver: BackupDriverId, recoveryKey: string) => request<BackupSummary[]>('POST', '/api/restore/list', { driver, recoveryKey }),
  restoreStart: (input: RestoreStartInput) => request<RestoreStatus>('POST', '/api/restore/start', input),
  restoreStatus: () => request<RestoreStatus>('GET', '/api/restore/status'),
  mailAvailable: () => request<{ available: boolean; address: string | null }>('GET', '/api/mail/available'),
  mailUnread: () => request<{ count: number }>('GET', '/api/mail/unread'),
  mailMessages: (folder: MailFolder) => request<MailList>('GET', `/api/mail/messages?folder=${folder}`),
  mailMessage: (id: number) => request<MailMessage>('GET', `/api/mail/messages/${id}`),
  setMailSeen: (id: number, seen: boolean) => request<void>('POST', `/api/mail/messages/${id}/seen`, { seen }),
  removeMail: (id: number) => request<void>('DELETE', `/api/mail/messages/${id}`),
  sendMail: (draft: MailDraft) => request<MailSendResult>('POST', '/api/mail/send', draft),
  mailRecipients: (addresses: string[]) => request<MailRecipientKey[]>('POST', '/api/mail/recipients', { addresses }),
  mailKeys: () => request<MailRecipientKey[]>('GET', '/api/mail/keys'),
  importMailKey: (publicKey: string) => request<MailRecipientKey[]>('POST', '/api/mail/keys', { publicKey }),
  removeMailKey: (address: string) => request<void>('DELETE', `/api/mail/keys/${encodeURIComponent(address)}`),
  mailSuggest: (q: string) => request<MailAddressSuggestion[]>('GET', `/api/mail/suggest?q=${encodeURIComponent(q)}`),

  contacts: () => request<Contact[]>('GET', '/api/contacts'),
  createContact: (input: ContactInput) => request<Contact>('POST', '/api/contacts', input),
  updateContact: (id: number, input: ContactInput) => request<Contact>('PUT', `/api/contacts/${id}`, input),
  removeContact: (id: number) => request<void>('DELETE', `/api/contacts/${id}`),
  contactCategories: () => request<ContactCategory[]>('GET', '/api/contact-categories'),
  createContactCategory: (input: ContactCategoryInput) => request<ContactCategory>('POST', '/api/contact-categories', input),
  updateContactCategory: (id: number, input: ContactCategoryInput) => request<ContactCategory>('PUT', `/api/contact-categories/${id}`, input),
  removeContactCategory: (id: number) => request<void>('DELETE', `/api/contact-categories/${id}`),
  personToContact: (personId: number) => request<Contact>('POST', `/api/personnel/${personId}/contact`),
  appLinks: (id: number) => request<AppLink[]>('GET', `/api/incidents/${id}/app-links`),
  pairApp: (unitId: number, input: PairInput) => request<AppLink>('POST', `/api/units/${unitId}/app-link`, input),
  unpairApp: (unitId: number) => request<void>('DELETE', `/api/units/${unitId}/app-link`),
  unit: (unitId: number) => request<Unit>('GET', `/api/units/${unitId}`),
  incidentPersonnel: (id: number) => request<Person[]>('GET', `/api/incidents/${id}/personnel`),
  unitPersonnel: (unitId: number) => request<Person[]>('GET', `/api/units/${unitId}/personnel`),
  addPersonnel: (unitId: number, persons: PersonInput[]) => request<Person[]>('POST', `/api/units/${unitId}/personnel`, { persons }),
  transferPersonnel: (unitId: number, personIds: number[], targetUnitId: number) =>
    request<Person[]>('POST', `/api/units/${unitId}/personnel/transfer`, { personIds, unitId: targetUnitId }),
  updatePerson: (id: number, input: PersonInput) => request<Person>('PUT', `/api/personnel/${id}`, input),
  removePerson: (id: number) => request<void>('DELETE', `/api/personnel/${id}`),
  personnelSheets: () => request<PersonnelInbox>('GET', '/api/personnel-sheets'),
  personnelUnread: () => request<{ count: number }>('GET', '/api/personnel-sheets/unread'),
  markSheetsRead: () => request<void>('POST', '/api/personnel-sheets/read'),
  assignSheet: (id: number, input: SheetAssign) => request<PersonnelSheet>('POST', `/api/personnel-sheets/${id}/assign`, input),
  removeSheet: (id: number) => request<void>('DELETE', `/api/personnel-sheets/${id}`),
  createPersonnelForm: (input: PersonnelFormInput) => request<PersonnelForm>('POST', '/api/personnel-form', input),
  closePersonnelForm: () => request<void>('DELETE', '/api/personnel-form'),

  forces: () => request<ForceUnit[]>('GET', '/api/forces'),
  createForce: (input: ForceUnitInput) => request<ForceUnit>('POST', '/api/system/forces', input),
  updateForce: (id: number, input: ForceUnitInput) => request<ForceUnit>('PUT', `/api/system/forces/${id}`, input),
  removeForce: (id: number) => request<void>('DELETE', `/api/system/forces/${id}`),
  adoptUnit: (unitId: number) => request<ForceUnit>('POST', `/api/system/forces/adopt/${unitId}`),
  forceImportTemplateUrl: '/api/system/forces/import/template',
  previewForceImport: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<ForceImportPreview>('POST', '/api/system/forces/import/preview', form);
  },
  importForces: (input: ForceImportInput) => request<ForceImportResult>('POST', '/api/system/forces/import', input),

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
  georefStatus: () => request<GeorefStatus>('GET', '/api/georef/status'),
  georefJob: (jobId: string) => request<GeorefJob>('GET', `/api/georef/jobs/${jobId}`),
  renderPdfPages: (docId: number) => request<GeorefJob>('POST', `/api/documents/${docId}/georef/pages`),
  pdfPages: (docId: number) => request<GeorefPage[]>('GET', `/api/documents/${docId}/georef/pages`),
  pdfPageUrl: (docId: number, page: number, thumb = false) => `/api/documents/${docId}/georef/pages/${page}${thumb ? '?thumb=1' : ''}`,
  createOverlay: (docId: number, input: GeorefRequest) => request<GeorefJob>('POST', `/api/documents/${docId}/georef/overlay`, input),
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

  messages: (incidentId: number) => request<Message[]>('GET', `/api/incidents/${incidentId}/messages`),
  messageContext: () => request<MessageContext>('GET', '/api/messages/context'),
  createMessage: (incidentId: number, input: MessageInput) => request<Message>('POST', `/api/incidents/${incidentId}/messages`, input),
  claimMessage: (id: number, force = false) => request<Message>('POST', `/api/messages/${id}/claim`, { force }),
  releaseMessage: (id: number) => request<Message>('POST', `/api/messages/${id}/release`),
  snoozeMessage: (id: number, minutes?: number) => request<Message>('POST', `/api/messages/${id}/snooze`, { minutes }),
  replyMessage: (id: number, body: string) => request<Message>('POST', `/api/messages/${id}/reply`, { body }),
  messageDone: (id: number) => request<Message>('POST', `/api/messages/${id}/done`),
  routeMessage: (id: number, roleId: number) => request<Message>('POST', `/api/messages/${id}/route`, { roleId }),
  ackMessage: (id: number) => request<Message>('POST', `/api/messages/${id}/ack`),
  messageSettings: () => request<MessageSettings>('GET', '/api/system/messages'),
  saveMessageSettings: (input: MessageSettingsInput) => request<MessageSettings>('PUT', '/api/system/messages', input),
  // Anforderungen
  requests: (incidentId: number) => request<MaterialRequest[]>('GET', `/api/incidents/${incidentId}/requests`),
  requestSettings: () => request<RequestSettings>('GET', '/api/requests/settings'),
  createRequest: (incidentId: number, input: RequestInput) => request<MaterialRequest>('POST', `/api/incidents/${incidentId}/requests`, input),
  updateRequest: (id: number, input: RequestPatch) => request<MaterialRequest>('PUT', `/api/requests/${id}`, input),
  requestJournal: (id: number) => request<JournalEntry[]>('GET', `/api/requests/${id}/journal`),
  setRequestStatus: (id: number, input: RequestStatusInput) => request<MaterialRequest>('POST', `/api/requests/${id}/status`, input),
  setRequestFollowUp: (id: number, followUpAt: string) => request<MaterialRequest>('POST', `/api/requests/${id}/follow-up`, { followUpAt }),
  forwardRequest: (id: number, input: RequestForwardInput) => request<MaterialRequest>('POST', `/api/requests/${id}/forward`, input),
  attachRequestMessage: (id: number, messageId: number) => request<MaterialRequest>('POST', `/api/requests/${id}/messages`, { messageId }),
  addRequestNote: (id: number, input: RequestNoteInput) => request<JournalEntry>('POST', `/api/requests/${id}/notes`, input),
  saveRequestSettings: (input: RequestSettingsInput) => request<RequestSettings>('PUT', '/api/system/requests', input),

  roles: () => request<RoleInfo[]>('GET', '/api/roles'),
  chooseRoles: (roleIds: number[]) => request<{ roles: Role[] }>('PUT', '/api/auth/role', { roleIds }),
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
  displayImages: () => request<DisplayImage[]>('GET', '/api/displays/images'),
  uploadDisplayImage: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<DisplayImage>('POST', '/api/displays/images', form);
  },
  removeDisplayImage: (imageId: number) => request<void>('DELETE', `/api/displays/images/${imageId}`),
  displayImageUrl: (imageId: number) => `/api/displays/images/${imageId}`,
  setDisplayTheme: (id: string, theme: DisplayTheme) => request<DisplayDevice>('PUT', `/api/displays/${id}/theme`, { theme }),
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
  /** id = 'all' für alle Arbeitsplätze */
  updateWorkstation: (id: string, req: WorkstationUpdateRequest) => request<Workstation[]>('POST', `/api/system/workstations/${id}/update`, req),
  cancelWorkstationUpdate: (id: string) => request<Workstation>('DELETE', `/api/system/workstations/${id}/update`),
  reorderDisplays: (ids: string[]) => request<DisplayDevice[]>('PUT', '/api/system/displays/order', { ids }),
  displaySelf: () => request<DisplaySelf>('GET', '/api/display/self'),
  displayStartPairing: () => request<DisplaySelf>('POST', '/api/display/pair'),
  displaySelfApplyScene: (sceneId: number) => request<DisplayDevice>('POST', `/api/display/scenes/${sceneId}/apply`),
  displaySelfTheme: (theme: DisplayTheme) => request<DisplayDevice>('PUT', '/api/display/theme', { theme }),
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
  bluetoothDevices: () => request<BluetoothDeviceConfig[]>('GET', '/api/system/bluetooth'),
  createBluetoothDevice: (input: BluetoothDeviceInput) => request<BluetoothDeviceConfig>('POST', '/api/system/bluetooth', input),
  updateBluetoothDevice: (id: string, input: BluetoothDeviceInput) => request<BluetoothDeviceConfig>('PUT', `/api/system/bluetooth/${id}`, input),
  removeBluetoothDevice: (id: string) => request<void>('DELETE', `/api/system/bluetooth/${id}`),
  reorderBluetoothDevices: (ids: string[]) => request<BluetoothDeviceConfig[]>('PUT', '/api/system/bluetooth/order', { ids }),
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
  mapSourceSettings: () => request<MapSourceSettings>('GET', '/api/system/map-sources'),
  saveMapSources: (sources: MapSourceInput[]) => request<MapSourceSettings>('PUT', '/api/system/map-sources', { sources }),
  testMapSource: (source: MapSourceInput) => request<MapSourceTestResult>('POST', '/api/system/map-sources/test', source),
  tileUrl: (sourceId: string) => `/api/map/tiles/${sourceId}/{z}/{x}/{y}`,
  radarFrames: () => request<RadarFrames>('GET', '/api/map/radar'),
  overlayTileUrl: (objectId: number) => `/api/map/overlays/${objectId}/{z}/{x}/{y}`,
  radarTileUrl: (time: string) => `/api/map/radar/${encodeURIComponent(time)}/{z}/{x}/{y}`,
  radarLegendUrl: '/api/map/radar/legend',
  mapObjects: (incidentId: number) => request<MapObject[]>('GET', `/api/incidents/${incidentId}/objects`),
  mapHistory: (incidentId: number, at: string) => request<MapHistoryState>('GET', `/api/incidents/${incidentId}/map-history?at=${encodeURIComponent(at)}`),
  addMapObject: (incidentId: number, o: NewMapObject) => request<MapObject>('POST', `/api/incidents/${incidentId}/objects`, o),
  patchMapObject: (id: number, patch: MapObjectPatch) => request<MapObject>('PATCH', `/api/map-objects/${id}`, patch),
  removeMapObject: (id: number) => request<void>('DELETE', `/api/map-objects/${id}`),
  overpassRun: (query: OverpassQueryInput, bounds: OverpassBounds) => request<OverpassResult>('POST', '/api/map/overpass', { query, bounds }),
  overpassStatus: () => request<OverpassStatus>('GET', '/api/map/overpass/status'),
  overpassDefaults: () => request<OverpassQuery[]>('GET', '/api/map/overpass/queries'),
  overpassSettings: () => request<OverpassQuerySettings>('GET', '/api/system/overpass-queries'),
  saveOverpassSettings: (queries: OverpassQueryInput[]) => request<OverpassQuerySettings>('PUT', '/api/system/overpass-queries', { queries }),
  incidentOverpassQueries: (incidentId: number) => request<IncidentOverpassQuery[]>('GET', `/api/incidents/${incidentId}/overpass-queries`),
  addIncidentOverpassQuery: (incidentId: number, q: OverpassQueryInput) => request<IncidentOverpassQuery>('POST', `/api/incidents/${incidentId}/overpass-queries`, q),
  saveIncidentOverpassQuery: (id: number, q: OverpassQueryInput) => request<IncidentOverpassQuery>('PUT', `/api/overpass-queries/${id}`, q),
  removeIncidentOverpassQuery: (id: number) => request<void>('DELETE', `/api/overpass-queries/${id}`),
  mapOutline: (osm: string) => request<GeoOutline>('GET', `/api/map/outline/${osm}`),
  mapSearch: (q: string, focus: { lat: number; lon: number } | null) =>
    request<GeocodeResponse>('GET', `/api/map/search?${new URLSearchParams({ q, ...(focus && { lat: focus.lat.toFixed(4), lon: focus.lon.toFixed(4) }) })}`),
  vehicleWeather: () => request<WeatherReport | null>('GET', '/api/weather/vehicle'),
  vehicleWeatherWarnings: () => request<WeatherWarnings | null>('GET', '/api/weather/warnings'),
  trafficAircraft: (q: { lat: number; lon: number; radius: number }) =>
    request<TrafficResult<Aircraft>>('GET', `/api/traffic/aircraft?lat=${q.lat.toFixed(3)}&lon=${q.lon.toFixed(3)}&radius=${Math.round(q.radius)}`),
  trafficShips: (b: { south: number; west: number; north: number; east: number }) =>
    request<TrafficResult<Ship>>('GET', `/api/traffic/ships?${new URLSearchParams({ south: b.south.toFixed(4), west: b.west.toFixed(4), north: b.north.toFixed(4), east: b.east.toFixed(4) })}`),
  trafficAircraftDetail: (hex: string) => request<{ aircraft: AircraftDetail | null; problem: string | null }>('GET', `/api/traffic/aircraft/${encodeURIComponent(hex)}`),
  trafficAircraftPhoto: (hex: string) => request<{ photo: AircraftPhoto | null }>('GET', `/api/traffic/aircraft/${encodeURIComponent(hex)}/photo`),
  trafficShip: (mmsi: string) => request<{ ship: Ship | null; problem: string | null }>('GET', `/api/traffic/ships/${mmsi}`),
  trafficSearch: (q: string) => request<TrafficResult<TrafficHit>>('GET', `/api/traffic/search?${new URLSearchParams({ q })}`),
  trafficSettings: () => request<TrafficSettings>('GET', '/api/system/traffic'),
  saveTrafficSettings: (input: TrafficSettingsInput) => request<TrafficSettings>('PUT', '/api/system/traffic', input),
  weather: (pos: { lat: number; lon: number }) => request<WeatherReport>('GET', `/api/weather?lat=${pos.lat}&lon=${pos.lon}`),
  /** Liefert das PDF als Blob; Fehler kommen wie bei den übrigen Aufrufen als ApiError. */
  printMap: async (req: MapPrintRequest): Promise<{ pdf: Blob; filename: string; missingTiles: number }> => {
    const { res, pdf, filename } = await fetchPdf('/api/print/map', req, 'Lagekarte.pdf');
    return { pdf, filename, missingTiles: Number(res.headers.get('x-missing-tiles') ?? 0) };
  },
  routerStatus: () => request<RouterStatus>('GET', '/api/map/router'),
  route: (req: RouteRequest) => request<RouteResult>('POST', '/api/map/route', req),
  printRoute: async (req: RoutePrintRequest): Promise<{ pdf: Blob; filename: string; missingTiles: number }> => {
    const { res, pdf, filename } = await fetchPdf('/api/print/route', req, 'Route.pdf');
    return { pdf, filename, missingTiles: Number(res.headers.get('x-missing-tiles') ?? 0) };
  },
  printWeather: async (pos: { lat: number; lon: number }): Promise<{ pdf: Blob; filename: string }> => {
    const { pdf, filename } = await fetchPdf('/api/print/weather', pos, 'Wetterbericht.pdf');
    return { pdf, filename };
  },
};

/** POST mit JSON, Antwort als PDF samt Dateiname aus Content-Disposition */
async function fetchPdf(url: string, body: unknown, fallbackName: string): Promise<{ res: Response; pdf: Blob; filename: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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
  const filename = encoded ? decodeURIComponent(encoded) : (/filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName);
  return { res, pdf: await res.blob(), filename };
}
