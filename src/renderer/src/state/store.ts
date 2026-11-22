import { create } from 'zustand'
import type { AppInfo, AuthUserView, JobRecord, ProjectRecord, ProviderHealth, ProviderKeyStatus, ThemeMode } from '@shared/ipc'

/** Global UI state (zustand). Server-of-truth stays in main; this mirrors it. */

export type StageId = 'home' | 'chat' | 'bible' | 'assets' | 'script' | 'preview' | 'delivery' | 'settings'

export const STAGE_TABS: Array<{ id: StageId; label: string; needsProject: boolean }> = [
  { id: 'chat', label: 'Chat', needsProject: false },
  { id: 'bible', label: 'Bible', needsProject: true },
  { id: 'assets', label: 'Assets', needsProject: true },
  { id: 'script', label: 'Script', needsProject: true },
  { id: 'preview', label: 'Preview', needsProject: true },
  { id: 'delivery', label: 'Delivery', needsProject: true }
]

export interface StudioState {
  booted: boolean
  appInfo: AppInfo | null
  theme: ThemeMode
  stage: StageId
  projects: ProjectRecord[]
  activeProject: ProjectRecord | null
  jobs: Record<string, JobRecord>
  bridge: { status: string; detail: string | null }
  provider: ProviderHealth | null
  keyStatus: ProviderKeyStatus | null
  inspectJobId: string | null
  toast: string | null
  /** Supabase session (auth gate). null user + configured ⇒ show the gate. */
  authUser: AuthUserView | null
  /** null = auth:status not answered yet (e.g. IPC failure at boot). */
  authConfigured: boolean | null
  /** Stored session exists but Supabase is unreachable — gate offers retry. */
  authOffline: boolean

  setBooted: (v: boolean) => void
  setAppInfo: (info: AppInfo) => void
  setTheme: (mode: ThemeMode) => void
  setStage: (stage: StageId) => void
  setProjects: (projects: ProjectRecord[]) => void
  setActiveProject: (project: ProjectRecord | null) => void
  upsertJob: (job: JobRecord) => void
  removeJob: (id: string) => void
  setJobs: (jobs: JobRecord[]) => void
  setBridge: (status: string, detail: string | null) => void
  setProvider: (health: ProviderHealth | null) => void
  setKeyStatus: (status: ProviderKeyStatus | null) => void
  setInspectJob: (id: string | null) => void
  setToast: (msg: string | null) => void
  setAuthUser: (user: AuthUserView | null) => void
  setAuthConfigured: (configured: boolean) => void
  setAuthOffline: (offline: boolean) => void
}

export const useStudio = create<StudioState>((set) => ({
  booted: false,
  appInfo: null,
  theme: 'dark',
  stage: 'home',
  projects: [],
  activeProject: null,
  jobs: {},
  bridge: { status: 'starting', detail: null },
  provider: null,
  keyStatus: null,
  inspectJobId: null,
  toast: null,
  authUser: null,
  authConfigured: null,
  authOffline: false,

  setBooted: (v) => set({ booted: v }),
  setAppInfo: (info) => set({ appInfo: info }),
  setTheme: (theme) => set({ theme }),
  setStage: (stage) => set({ stage }),
  setProjects: (projects) => set({ projects }),
  setActiveProject: (activeProject) => set({ activeProject }),
  upsertJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  removeJob: (id) =>
    set((s) => {
      const next = { ...s.jobs }
      delete next[id]
      return { jobs: next }
    }),
  setJobs: (jobs) => set(() => ({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])) })),
  setBridge: (status, detail) => set({ bridge: { status, detail } }),
  setProvider: (provider) => set({ provider }),
  setKeyStatus: (keyStatus) => set({ keyStatus }),
  setInspectJob: (inspectJobId) => set({ inspectJobId }),
  setToast: (toast) => set({ toast }),
  setAuthUser: (authUser) => set({ authUser, authOffline: false }),
  setAuthConfigured: (authConfigured) => set({ authConfigured }),
  setAuthOffline: (authOffline) => set({ authOffline })
}))

/** Convenience selectors */
export const selectActiveJobs = (s: StudioState): JobRecord[] =>
  Object.values(s.jobs).filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'awaiting_approval')
