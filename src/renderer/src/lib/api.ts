import type {
  AppInfo,
  AssetRecord,
  AuthSignUpResult,
  AuthStatus,
  AuthUserView,
  BridgePathsResult,
  BridgePingResult,
  ChatMessageRecord,
  ChatSendResult,
  ClaimRow,
  CreateProjectInput,
  JobRecord,
  LedgerKind,
  OpenProjectResult,
  ProjectRecord,
  ProviderHealth,
  ProviderKeyStatus,
  SourceRow,
  ThemeMode
} from '@shared/ipc'

/** Typed accessor over the preload bridge (window.api). */

interface WindowApi {
  invoke(channel: string, payload?: unknown): Promise<unknown>
  on(event: string, callback: (payload: unknown) => void): () => void
  send(event: string, payload?: unknown): void
}

declare global {
  interface Window {
    api: WindowApi
  }
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  return (await window.api.invoke(channel, payload)) as T
}

export const api = {
  appInfo: () => call<AppInfo>('app:info'),

  getTheme: () => call<ThemeMode>('theme:get'),
  setTheme: (mode: ThemeMode) => call<ThemeMode>('theme:set', mode),

  listProjects: () => call<ProjectRecord[]>('projects:list'),
  recentProjects: () => call<ProjectRecord[]>('projects:recent'),
  createProject: (input: CreateProjectInput) => call<ProjectRecord>('projects:create', input),
  openProject: (path: string) => call<OpenProjectResult>('projects:open', path),
  deleteProject: (projectId: string, deleteFolder: boolean, folderPath?: string) =>
    call<{ folderDeleted: boolean; registryRemoved: boolean }>('projects:delete', { projectId, deleteFolder, folderPath }),

  settingsAll: () => call<Record<string, unknown>>('settings:getAll'),
  setSetting: (key: string, value: unknown) => call<boolean>('settings:set', { key, value }),

  setProviderKey: (key: string) => call<ProviderKeyStatus>('provider:keySet', key),
  providerKeyStatus: () => call<ProviderKeyStatus>('provider:keyStatus'),
  deleteProviderKey: () => call<ProviderKeyStatus>('provider:keyDelete'),
  providerHealth: () => call<ProviderHealth>('provider:health'),

  authStatus: () => call<AuthStatus>('auth:status'),
  authSignUp: (email: string, password: string) => call<AuthSignUpResult>('auth:signUp', { email, password }),
  authSignIn: (email: string, password: string) => call<AuthUserView>('auth:signIn', { email, password }),
  authSignOut: () => call<void>('auth:signOut'),

  bridgePing: () => call<BridgePingResult>('bridge:ping'),
  bridgePaths: () => call<BridgePathsResult>('bridge:paths'),
  bridgeStatus: () => call<{ status: string; detail: string | null }>('bridge:statusGet'),

  listJobs: () => call<JobRecord[]>('jobs:list'),
  cancelJob: (id: string) => call<void>('jobs:cancel', id),
  retryJob: (id: string) => call<JobRecord | null>('jobs:retry', id),
  dismissJob: (id: string | null) => call<{ removed: number }>('jobs:dismiss', id),

  chatList: (projectId: string | null) => call<ChatMessageRecord[]>('chat:list', projectId),
  chatSend: (projectId: string | null, content: string) =>
    call<ChatSendResult>('chat:send', { projectId, content }),

  scoutRun: (projectId: string, topic: string) => call<JobRecord>('scout:run', { projectId, topic }),
  directorRun: (projectId: string, notes?: string) => call<JobRecord>('director:run', { projectId, notes }),
  produceRun: (projectId: string, notes?: string, quality?: 'draft' | 'standard' | 'high', autopilot?: boolean) =>
    call<import('@shared/ipc').JobRecord>('producer:run', { projectId, notes, quality, autopilot: autopilot === true }),
  makeFilm: (idea: string, opts?: { minutes?: number; fps?: number; projectId?: string }) =>
    call<import('@shared/ipc').ShowrunnerMakeResult>('showrunner:make', { idea, ...opts }),
  refineFilm: (projectId: string, notes: string) =>
    call<import('@shared/ipc').JobRecord>('showrunner:refine', { projectId, notes }),
  gateResolve: (projectId: string, gate: string, approve: boolean) =>
    call<import('@shared/ipc').JobRecord | { declined: true }>('producer:gateResolve', { projectId, gate, approve }),
  deliveryGet: (projectId: string) => call<import('@shared/ipc').DeliveryBundle>('delivery:get', projectId),
  youtubeKit: (projectId: string) => call<string | null>('delivery:youtubeKit', projectId),
  ttsVoices: (locale?: string) =>
    call<{ count: number; voices: Array<{ shortName: string; gender: string; locale: string; name: string }> }>('tts:voices', locale),
  ttsPreviewVoice: (projectId: string, voice: string, text?: string) =>
    call<import('@shared/ipc').TtsGenerateResult>('tts:previewVoice', { projectId, voice, text }),
  agentRunsList: (projectId: string | null) => call<import('@shared/ipc').AgentRunRow[]>('agentRuns:list', projectId),
  createSampleProject: () => call<import('@shared/ipc').ProjectRecord>('onboarding:sampleProject'),
  styleGet: (projectId: string) => call<import('@shared/ipc').ProjectStyle | null>('style:get', projectId),
  styleSave: (projectId: string, style: import('@shared/ipc').ProjectStyle) =>
    call<import('@shared/ipc').ProjectStyle>('style:save', { projectId, style }),
  bibleGet: (projectId: string) => call<import('@shared/ipc').BibleBundle>('bible:get', projectId),
  bibleSaveSceneNotes: (projectId: string, sceneId: string, notes: string) =>
    call<boolean>('bible:saveSceneNotes', { projectId, sceneId, notes }),
  assetsList: (projectId: string) => call<{ assets: AssetRecord[]; downloadedCount: number }>('assets:list', projectId),
  assetsSetRights: (projectId: string, assetIds: string[], approved: boolean, notes?: string) =>
    call<{ changed: number }>('assets:setRights', { projectId, assetIds, approved, notes }),
  assetsDownload: (projectId: string, assetIds?: string[]) => call<JobRecord>('assets:download', { projectId, assetIds }),
  assetsThumb: (projectId: string, absPath: string) => call<string | null>('assets:thumb', { projectId, absPath }),
  ledgerList: (projectId: string, kind: LedgerKind) => call<Record<string, unknown>[]>('ledger:list', { projectId, kind })
}

/** studio:// URL for a project-local absolute path (thumbnails, previews). */
export function studioUrl(absPath: string): string {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(absPath)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `studio://local/${b64}`
}

export type { SourceRow, ClaimRow, AssetRecord }

export function subscribeEvents(handlers: {
  onJob?: (job: JobRecord) => void
  onBridge?: (status: { status: string; detail: string | null }) => void
  onProvider?: (health: ProviderHealth) => void
  onScout?: (payload: { projectId: string; activity: import('@shared/ipc').ScoutActivity }) => void
  onDirector?: (payload: { projectId: string; activity: import('@shared/ipc').DirectorActivity }) => void
  onProducer?: (payload: { projectId: string; activity: import('@shared/ipc').ProducerActivity }) => void
}): () => void {
  const offs: Array<() => void> = []
  if (handlers.onJob) offs.push(window.api.on('job:updated', (p) => handlers.onJob?.(p as JobRecord)))
  if (handlers.onBridge)
    offs.push(window.api.on('bridge:status', (p) => handlers.onBridge?.(p as { status: string; detail: string | null })))
  if (handlers.onProvider) offs.push(window.api.on('provider:status', (p) => handlers.onProvider?.(p as ProviderHealth)))
  if (handlers.onScout)
    offs.push(
      window.api.on('scout:activity', (p) =>
        handlers.onScout?.(p as { projectId: string; activity: import('@shared/ipc').ScoutActivity })
      )
    )
  if (handlers.onDirector)
    offs.push(
      window.api.on('director:activity', (p) =>
        handlers.onDirector?.(p as { projectId: string; activity: import('@shared/ipc').DirectorActivity })
      )
    )
  if (handlers.onProducer)
    offs.push(
      window.api.on('producer:activity', (p) =>
        handlers.onProducer?.(p as { projectId: string; activity: import('@shared/ipc').ProducerActivity })
      )
    )
  return () => offs.forEach((off) => off())
}
