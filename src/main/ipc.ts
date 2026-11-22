import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Db } from './db'
import { SettingsStore } from './settings'
import { deleteSecret, secretStatus, setSecret } from './secrets'
import { OpenRouterAdapter } from './provider'
import type { BridgeClient } from './bridge'
import type { JobManager } from './jobs'
import { ProjectService } from './projects'
import { insertChat, listChat } from './chat'
import { readBibleBundle } from './artifacts'
import { setGateApprovalByGate } from './approvals'
import { routePlainMessage, workflowExists } from './showrunner'
import { listAgentRuns } from './audit'
import type { AuthService } from './auth'
import type {
  AppInfo,
  AssetRecord,
  AuthCredentials,
  AuthSignUpResult,
  AuthStatus,
  AuthUserView,
  ChatMessageRecord,
  ChatSendResult,
  CreateProjectInput,
  DeliveryBundle,
  JobRecord,
  LedgerKind,
  ProjectRecord,
  AgentRunRow,
  ProjectStyle,
  ThemeMode,
  TtsVoice,
  ShowrunnerMakeInput,
  ShowrunnerMakeResult,
  ShowrunnerRefineInput
} from '@shared/ipc'
import { EVENTS, IPC } from '@shared/ipc'

/**
 * IPC handler registration. Each handler is thin: validate → delegate to a
 * service → return data or throw (ipcRenderer.invoke rejects with message).
 */

export interface IpcDeps {
  db: Db
  settings: SettingsStore
  bridge: BridgeClient
  jobs: JobManager
  projects: ProjectService
  provider: OpenRouterAdapter
  auth: AuthService
  getMainWindow: () => Electron.BrowserWindow | null
}

const PROVIDER_KEY = 'provider.api_key'

export function registerIpcHandlers(deps: IpcDeps): void {
  const { db, settings, bridge, jobs, projects, provider, auth } = deps

  // ------------------------------------------------------------- app/theme
  ipcMain.handle(IPC.AppInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    projectsRoot: settings.get('projects_root', join(app.getPath('documents'), 'VendoTube Studio')),
    appDataDir: app.getPath('userData'),
    smoke: process.env.VENDOTUBE_SMOKE === '1'
  }))

  ipcMain.handle(IPC.ThemeGet, (): ThemeMode => settings.get<ThemeMode>('theme', 'dark'))
  ipcMain.handle(IPC.ThemeSet, (_e, mode: ThemeMode): ThemeMode => {
    if (mode !== 'dark' && mode !== 'light' && mode !== 'system') throw new Error('invalid theme')
    settings.set('theme', mode)
    return mode
  })

  // ------------------------------------------------------------------- auth
  // Supabase (vendoria.ai project) email/password auth. The service lives in
  // auth.ts; handlers stay thin. Validation errors throw → invoke rejects.

  ipcMain.handle(IPC.AuthStatus, (): Promise<AuthStatus> => auth.status())

  ipcMain.handle(IPC.AuthSignUp, (_e, input: AuthCredentials): Promise<AuthSignUpResult> => {
    if (!input?.email || !input?.password) throw new Error('Email and password are required')
    return auth.signUp(String(input.email), String(input.password))
  })

  ipcMain.handle(IPC.AuthSignIn, (_e, input: AuthCredentials): Promise<AuthUserView> => {
    if (!input?.email || !input?.password) throw new Error('Email and password are required')
    return auth.signIn(String(input.email), String(input.password))
  })

  ipcMain.handle(IPC.AuthSignOut, (): Promise<void> => auth.signOut())

  // -------------------------------------------------------------- projects
  ipcMain.handle(IPC.ProjectsList, (): ProjectRecord[] => projects.list())
  ipcMain.handle(IPC.ProjectsRecent, (): ProjectRecord[] => projects.recent())

  // Job kinds whose parked artifacts carry a producer gate card (M6: the
  // Showrunner orchestrates the produce pipeline inside its own job).
  const GATED_JOB_KINDS = ['producer.produce', 'showrunner.make', 'showrunner.refine']

  ipcMain.handle(IPC.ProjectsCreate, async (_e, input: CreateProjectInput) => {
    if (!input?.title?.trim()) throw new Error('Project title is required')
    const job = await jobs.enqueue('project.create', {
      agent: 'system',
      resumable: true,
      params: input,
      projectId: null
    })
    const done = await jobs.whenDone(job.id)
    if (done.status === 'failed') throw new Error(done.error ?? 'project creation failed')
    if (done.status === 'cancelled') throw new Error('project creation cancelled')
    return extractProjectArtifact(done)
  })

  ipcMain.handle(IPC.SampleProjectCreate, async (): Promise<ProjectRecord> => {
    // Onboarding (M5): a fully seeded demo film — the user just presses produce.
    const job = await jobs.enqueue('project.create', {
      agent: 'system',
      resumable: true,
      params: { title: 'Welcome to VendoTube Studio', runtimeSeconds: 30, fps: 30 },
      projectId: null
    })
    const done = await jobs.whenDone(job.id)
    if (done.status === 'failed') throw new Error(done.error ?? 'sample project creation failed')
    const record = extractProjectArtifact(done)
    seedSampleProject(record.path)
    projects.setStage(record.id, 'bible_ready')
    insertChat(
      db,
      record.id,
      'assistant',
      '[Showrunner] This is a seeded demo film ("The Clock That Watched"). Open the Preview tab and press produce (draft) — the Producer will narrate, compose, render, and package it end-to-end. Gates pause for your approval.'
    )
    return record
  })

  ipcMain.handle(IPC.ProjectsOpen, async (_e, path: string) => {
    if (typeof path !== 'string' || !path.trim()) throw new Error('path required')
    const project = projects.open(path)
    const job = await jobs.enqueue('project.validate', {
      agent: 'system',
      resumable: true,
      params: { projectPath: project.path },
      projectId: project.id
    })
    return { project, validation: job }
  })

  ipcMain.handle(IPC.ProjectsDelete, async (e, input: { projectId: string; deleteFolder?: boolean; folderPath?: string }) => {
    if (!input?.projectId) throw new Error('projectId required')
    // Ask the renderer to release anything it holds open in this project (the
    // Preview <video> streams the master over studio://). Chromium drops the
    // handle once the element's src is cleared; without this the unlink fails
    // with EBUSY on Windows (2026-11-19). Bounded wait — a renderer that is
    // gone or wedged must not block the delete forever.
    const sender = e.sender
    await new Promise<void>((resolve) => {
      const onReleased = (evt: Electron.IpcMainEvent): void => {
        if (evt.sender !== sender) return
        finish()
      }
      const timer = setTimeout(finish, 1500)
      function finish(): void {
        clearTimeout(timer)
        ipcMain.removeListener(EVENTS.ProjectsReleased, onReleased)
        resolve()
      }
      ipcMain.on(EVENTS.ProjectsReleased, onReleased)
      sender.send(EVENTS.ProjectsRelease, { projectId: String(input.projectId), folderPath: input.folderPath })
    })
    // folderPath lets an orphaned folder (registry row already gone) still be
    // removed — projects.delete re-applies the inside-root guard.
    return projects.delete(String(input.projectId), input.deleteFolder === true, input.folderPath)
  })

  // -------------------------------------------------------------- settings
  ipcMain.handle(IPC.SettingsGetAll, () => {
    // Never expose secrets through settings.
    const all = { ...settings.all() }
    delete all.window_bounds
    return all
  })

  ipcMain.handle(IPC.SettingsSet, (_e, kv: { key: string; value: unknown }) => {
    if (typeof kv?.key !== 'string' || kv.key.includes('secret')) throw new Error('invalid settings key')
    settings.set(kv.key, kv.value)
    return true
  })

  // -------------------------------------------------------------- provider
  ipcMain.handle(IPC.ProviderKeySet, (_e, apiKey: string) => {
    if (typeof apiKey !== 'string' || apiKey.trim().length < 8) throw new Error('API key looks too short')
    const res = setSecret(db, PROVIDER_KEY, apiKey.trim())
    return { ...secretStatus(db, PROVIDER_KEY), secure: res.secure }
  })

  ipcMain.handle(IPC.ProviderKeyStatus, () => secretStatus(db, PROVIDER_KEY))
  ipcMain.handle(IPC.ProviderKeyDelete, () => {
    deleteSecret(db, PROVIDER_KEY)
    return secretStatus(db, PROVIDER_KEY)
  })

  ipcMain.handle(IPC.ProviderHealth, async () => {
    const health = await provider.health()
    deps.getMainWindow()?.webContents.send('provider:status', health)
    return health
  })

  // ---------------------------------------------------------------- bridge
  ipcMain.handle(IPC.BridgePing, () => bridge.ping())
  ipcMain.handle(IPC.BridgePaths, () => bridge.paths())
  ipcMain.handle(IPC.BridgeStatusGet, () => ({ status: bridge.status, detail: bridge.lastDetail }))

  // ------------------------------------------------------------------ jobs
  ipcMain.handle(IPC.JobsList, () => jobs.list())
  ipcMain.handle(IPC.JobsCancel, (_e, id: string) => jobs.cancel(String(id)))
  ipcMain.handle(IPC.JobsRetry, (_e, id: string) => jobs.retry(String(id)))
  ipcMain.handle(IPC.JobsDismiss, (_e, id: string | null) => {
    if (id === null) return { removed: jobs.dismissAllFinished() }
    return { removed: jobs.dismiss(String(id)) ? 1 : 0 }
  })

  // ------------------------------------------------------------------ chat
  ipcMain.handle(IPC.ChatList, (_e, projectId: string | null): ChatMessageRecord[] => listChat(db, projectId))

  ipcMain.handle(IPC.ChatSend, (_e, input: { projectId: string | null; content: string }): ChatSendResult => {
    const content = String(input?.content ?? '').trim()
    if (!content) throw new Error('empty message')
    const projectId = input?.projectId ?? null
    const user = insertChat(db, projectId, 'user', content)
    // /research hands the brief to Scout (M1); other messages get an honest ack.
    if (content.toLowerCase().startsWith('/research')) {
      const topic = content.replace(/^\/research\s*/i, '').trim()
      if (!topic) {
        return {
          user,
          assistant: insertChat(db, projectId, 'assistant', 'Give me a topic after /research — e.g. `/research the lost city of Cahokia`.')
        }
      }
      if (!projectId) {
        // Never claim Scout took a brief it cannot file anywhere.
        return {
          user,
          assistant: insertChat(
            db,
            projectId,
            'assistant',
            'I can\'t run that yet: /research needs a project to file sources, claims, and media into. Click ⌂ (top-left) → create a project, then send the same /research again.'
          )
        }
      }
      const project = projects.byId(projectId)
      if (!project) throw new Error('project not found')
      const assistant = insertChat(
        db,
        projectId,
        'assistant',
        `Scout takes the brief: "${topic}". Follow the live activity below — sources, claims, and media candidates land in the project ledgers and the Assets tab.`
      )
      void jobs.enqueue('scout.research', {
        agent: 'scout',
        resumable: false,
        projectId,
        params: { topic, projectId, projectPath: project.path }
      })
      return { user, assistant }
    }
    if (content.toLowerCase().startsWith('/direct')) {
      const notes = content.replace(/^\/direct\s*/i, '').trim()
      if (!projectId) {
        return {
          user,
          assistant: insertChat(
            db,
            projectId,
            'assistant',
            '/direct needs a project. Create one from Home (⌂), run /research first, then direct.'
          )
        }
      }
      const project = projects.byId(projectId)
      if (!project) throw new Error('project not found')
      const assistant = insertChat(
        db,
        projectId,
        'assistant',
        notes
          ? `Director takes the brief${notes ? ` — revision notes: "${notes}"` : ''}. The Bible Reader will show the film design when it completes.`
          : 'Give direction notes after /direct — e.g. `/direct focus more on the decline era`.'
      )
      if (notes) {
        void jobs.enqueue('director.build', {
          agent: 'director',
          resumable: false,
          projectId,
          params: {
            projectId,
            projectPath: project.path,
            notes: notes || null,
            voice: settings.get('tts_voice', 'en-US-AndrewMultilingualNeural')
          }
        })
      }
      return { user, assistant }
    }
    if (content.toLowerCase().startsWith('/produce')) {
      const notes = content.replace(/^\/produce\s*/i, '').trim()
      if (!projectId) {
        return {
          user,
          assistant: insertChat(
            db,
            projectId,
            'assistant',
            '/produce needs a project. Create one from Home (⌂), run /research and /direct first, then produce.'
          )
        }
      }
      const project = projects.byId(projectId)
      if (!project) throw new Error('project not found')
      const assistant = insertChat(
        db,
        projectId,
        'assistant',
        notes
          ? `Producer takes the stage — revision notes: "${notes}". The film (VO → subtitles → compositions → render → QC → package) runs below; approval gates will pause it when your say-so is required.`
          : 'Producer takes the stage: narration → subtitles → compositions → render → QC → delivery. Approval gates (G-D narration, G-E render, G-F package) will pause the run for your approval.'
      )
      void jobs.enqueue('producer.produce', {
        agent: 'producer',
        resumable: true,
        projectId,
        params: { projectId, projectPath: project.path, notes: notes || null }
      })
      return { user, assistant }
    }
    // Plain text → Showrunner routing (M6): with a designed film, the line is
    // a revision note; without one it starts/continues the film; with no
    // project open there is nothing to route — honest ack.
    const routedProject = projectId ? projects.byId(projectId) : null
    const route = routePlainMessage(!!routedProject, routedProject ? workflowExists(routedProject.path) : false)
    if (route === 'refine' && routedProject) {
      const assistant = insertChat(
        db,
        projectId,
        'assistant',
        '[Showrunner] Sending that to the Director as a revision note — a fresh draft renders automatically when direction lands.'
      )
      void jobs.enqueue('showrunner.refine', {
        agent: 'showrunner',
        resumable: true,
        projectId,
        params: { projectId, projectPath: routedProject.path, notes: content }
      })
      return { user, assistant }
    }
    if (route === 'make' && routedProject) {
      const assistant = insertChat(
        db,
        projectId,
        'assistant',
        '[Showrunner] Taking that as the brief — running the crew (research → film design → draft render). I\'ll pause once to ask about research media; the draft preview opens when it\'s ready.'
      )
      void jobs.enqueue('showrunner.make', {
        agent: 'showrunner',
        resumable: true,
        projectId,
        params: { idea: content, projectId, projectPath: routedProject.path }
      })
      return { user, assistant }
    }
    const assistant = insertChat(
      db,
      projectId,
      'assistant',
      'Noted to the transcript. Describe a film idea on Home ("What story do we tell today?") and the crew runs it end-to-end — or use /research, /direct, /produce here.'
    )
    return { user, assistant }
  })

  // ------------------------------------------------------------------ M2
  ipcMain.handle(IPC.DirectorRun, (_e, input: { projectId: string; notes?: string }) => {
    if (!input?.projectId) throw new Error('projectId required')
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    return jobs.enqueue('director.build', {
      agent: 'director',
      resumable: false,
      projectId: project.id,
      params: {
        projectId: project.id,
        projectPath: project.path,
        notes: typeof input.notes === 'string' ? input.notes.trim() : null,
        voice: settings.get('tts_voice', 'en-US-AndrewMultilingualNeural')
      }
    })
  })

  ipcMain.handle(IPC.BibleGet, async (_e, projectId: string) => {
    const project = projects.byId(String(projectId))
    if (!project) throw new Error('project not found')
    const bundle = readBibleBundle(project.path)
    let sceneNotes: Record<string, string> = {}
    const notesFile = join(project.path, 'studio', 'scene_edits.json')
    try {
      sceneNotes = JSON.parse(readFileSync(notesFile, 'utf-8')) as Record<string, string>
    } catch {
      sceneNotes = {}
    }
    let validation: { valid: boolean; errors: string[]; warnings: string[] } | null = null
    const qcFile = join(project.path, 'qc', 'validation_report.json')
    try {
      const rep = JSON.parse(readFileSync(qcFile, 'utf-8')) as { valid: boolean; errors: string[]; warnings: string[] }
      validation = { valid: rep.valid, errors: rep.errors, warnings: rep.warnings }
    } catch {
      validation = null
    }
    return { ...bundle, sceneNotes, validation, stage: project.stage }
  })

  ipcMain.handle(IPC.BibleSaveSceneNotes, (_e, input: { projectId: string; sceneId: string; notes: string }) => {
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    const notesFile = join(project.path, 'studio', 'scene_edits.json')
    let notes: Record<string, string> = {}
    try {
      notes = JSON.parse(readFileSync(notesFile, 'utf-8')) as Record<string, string>
    } catch {
      notes = {}
    }
    if (input.notes.trim()) notes[String(input.sceneId)] = input.notes.trim()
    else delete notes[String(input.sceneId)]
    mkdirSync(dirname(notesFile), { recursive: true })
    writeFileSync(notesFile, JSON.stringify(notes, null, 2), 'utf-8')
    return true
  })

  // ------------------------------------------------------------------ M3
  ipcMain.handle(IPC.ProducerRun, (_e, input: { projectId: string; notes?: string; quality?: string; autopilot?: boolean }) => {
    if (!input?.projectId) throw new Error('projectId required')
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    const quality = ['draft', 'standard', 'high'].includes(String(input.quality)) ? String(input.quality) : null
    return jobs.enqueue('producer.produce', {
      agent: 'producer',
      resumable: true,
      projectId: project.id,
      params: {
        projectId: project.id,
        projectPath: project.path,
        notes: typeof input.notes === 'string' ? input.notes.trim() : null,
        quality,
        autopilot: input.autopilot === true
      }
    })
  })

  // ---- M6: Showrunner autopilot -----------------------------------------
  ipcMain.handle(IPC.ShowrunnerMake, async (_e, input: ShowrunnerMakeInput): Promise<ShowrunnerMakeResult> => {
    const idea = String(input?.idea ?? '').trim()
    if (!idea) throw new Error('Describe the film idea first')
    const minutes = Number.isFinite(Number(input?.minutes)) && Number(input?.minutes) > 0 ? Number(input?.minutes) : undefined
    const fps = [24, 25, 30, 50, 60].includes(Number(input?.fps)) ? Number(input?.fps) : undefined
    let projectId: string
    if (input?.projectId) {
      const existing = projects.byId(String(input.projectId))
      if (!existing) throw new Error('project not found')
      projectId = existing.id
    } else {
      // Create the project first (fast, local) so the renderer can select it
      // while the crew job runs in the background.
      const job = await jobs.enqueue('project.create', {
        agent: 'system',
        resumable: true,
        params: { title: idea, fps, runtimeSeconds: minutes ? Math.max(30, Math.round(minutes * 60)) : undefined },
        projectId: null
      })
      const done = await jobs.whenDone(job.id)
      if (done.status === 'failed') throw new Error(done.error ?? 'project creation failed')
      if (done.status === 'cancelled') throw new Error('project creation cancelled')
      projectId = extractProjectArtifact(done).id
    }
    const project = projects.byId(projectId)
    if (!project) throw new Error('project not found')
    const job = await jobs.enqueue('showrunner.make', {
      agent: 'showrunner',
      resumable: true,
      projectId,
      params: { idea, projectId, projectPath: project.path, minutes, fps }
    })
    return { project, jobId: job.id }
  })

  ipcMain.handle(IPC.ShowrunnerRefine, (_e, input: ShowrunnerRefineInput) => {
    const project = projects.byId(String(input?.projectId))
    if (!project) throw new Error('project not found')
    const notes = String(input?.notes ?? '').trim()
    if (!notes) throw new Error('Tell the Director what to change')
    return jobs.enqueue('showrunner.refine', {
      agent: 'showrunner',
      resumable: true,
      projectId: project.id,
      params: { projectId: project.id, projectPath: project.path, notes }
    })
  })

  ipcMain.handle(IPC.ProducerGateResolve, (_e, input: { projectId: string; gate: string; approve: boolean }) => {
    // Gates G-D/G-E/G-F resolve HERE — the user's click is the approval.
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    const gate = String(input.gate ?? '')
    if (!['G-D', 'G-M', 'G-E', 'G-V', 'G-F'].includes(gate)) throw new Error('unknown gate')
    setGateApprovalByGate(db, project.id, gate, input.approve ? 'approved' : 'declined')
    const job = jobs
      .list()
      .find((j) => GATED_JOB_KINDS.includes(j.kind) && j.projectId === project.id && j.status === 'awaiting_approval')
    if (input.approve) {
      if (!job) throw new Error('no production run is waiting at that gate')
      return jobs.resumeAwaiting(job.id)
    }
    if (job) void jobs.cancel(job.id)
    return { declined: true }
  })

  ipcMain.handle(IPC.DeliveryGet, (_e, projectId: string): DeliveryBundle => {
    const project = projects.byId(String(projectId))
    if (!project) throw new Error('project not found')
    const readFile = (rel: string): string | null => {
      try {
        return readFileSync(join(project.path, rel), 'utf-8')
      } catch {
        return null
      }
    }
    const statFile = (rel: string): { path: string; abs: string; bytes: number } | null => {
      const abs = join(project.path, rel)
      if (!existsSync(abs)) return null
      return { path: rel, abs, bytes: statSync(abs).size }
    }
    const parseJson = (rel: string): unknown => {
      try {
        return JSON.parse(readFile(rel) ?? 'null')
      } catch {
        return null
      }
    }
    const qc = parseJson('qc/qc_report.json') as { passed?: boolean; errors?: string[] } | null
    const retention = parseJson('qc/retention_report.json') as
      | { verdict?: string; dead_zones?: Array<{ from_s: number; to_s: number }>; lufs?: number | null }
      | null
    const visual = parseJson('qc/visual_report.json') as
      | { verdict?: string; findings?: Array<Record<string, unknown>>; coverage?: Record<string, unknown>; notes?: string[] }
      | null
    const master = statFile('delivery/documentary.mp4')
    const zipRow = statFile('delivery/project.zip')
    let zipSha: string | null = null
    try {
      zipSha = readFile('delivery/project.zip.sha256')?.split(/\s+/)[0] ?? null
    } catch {
      zipSha = null
    }
    const awaitingJob = jobs
      .list()
      .find((j) => GATED_JOB_KINDS.includes(j.kind) && j.projectId === project.id && j.status === 'awaiting_approval')
    let pendingGate: DeliveryBundle['pendingGate'] = null
    if (awaitingJob) {
      const paused = (awaitingJob.artifacts as Array<{ pausedAtGate?: string; gateSummary?: string }> | undefined)?.[0]
      pendingGate = {
        job: awaitingJob,
        gate: String(paused?.pausedAtGate ?? '?'),
        summary: String(paused?.gateSummary ?? 'awaiting approval')
      }
    }
    let pictureQuality: string | null = null
    try {
      pictureQuality = (JSON.parse(readFile('studio/producer_state.json') ?? 'null') as { quality?: string } | null)?.quality ?? null
    } catch {
      pictureQuality = null
    }
    const thumbDir = join(project.path, 'delivery', 'thumbnails')
    const thumbnails: string[] = existsSync(thumbDir)
      ? readdirSync(thumbDir)
          .filter((f) => f.endsWith('.png'))
          .map((f) => join(thumbDir, f))
      : []
    return {
      stage: project.stage,
      master,
      picture: statFile('delivery/picture.mp4'),
      pictureDraft: statFile('delivery/picture-draft.mp4'),
      pictureQuality,
      thumbnails,
      srt: (() => {
        const abs = join(project.path, 'production', 'subtitles.en.srt')
        return existsSync(abs) ? { path: 'production/subtitles.en.srt', bytes: statSync(abs).size } : null
      })(),
      zip: zipRow ? { path: zipRow.path, bytes: zipRow.bytes, sha256: zipSha } : null,
      youtubeKit: readFile('delivery/youtube_kit.md'),
      qcReport: qc ? { passed: qc.passed === true, errors: qc.errors ?? [], durationSeconds: (qc as { streams?: { duration_seconds?: number } }).streams?.duration_seconds ?? null } : null,
      retentionReport: retention
        ? {
            verdict: String(retention.verdict ?? 'warn'),
            dead_zones: retention.dead_zones ?? [],
            lufs: retention.lufs ?? null
          }
        : null,
      visualReport: visual
        ? {
            verdict: String(visual.verdict ?? 'warn'),
            findings: (visual.findings ?? []).map((f, i) => ({
              id: String(f.id ?? `F${i + 1}`),
              class: String(f.class ?? 'unknown'),
              severity: (f.severity === 'fail' || f.severity === 'warn' || f.severity === 'info' ? f.severity : 'info') as 'info' | 'warn' | 'fail',
              t_s: Number(f.t_s ?? 0),
              to_s: typeof f.to_s === 'number' ? f.to_s : undefined,
              evidence: String(f.evidence ?? ''),
              suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
              scene_id: typeof f.scene_id === 'string' ? f.scene_id : undefined
            })),
            coverage: visual.coverage as { frames_sampled?: number; detectors?: string[]; vision?: boolean } | undefined,
            notes: visual.notes ?? []
          }
        : null,
      pendingGate
    }
  })

  ipcMain.handle(IPC.YoutubeKitGet, (_e, projectId: string) => {
    const project = projects.byId(String(projectId))
    if (!project) throw new Error('project not found')
    try {
      return readFileSync(join(project.path, 'delivery', 'youtube_kit.md'), 'utf-8')
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.TtsVoices, async (_e, locale?: string): Promise<{ count: number; voices: TtsVoice[] }> => {
    return bridge.ttsVoices({ locale: typeof locale === 'string' ? locale : undefined })
  })

  ipcMain.handle(IPC.AgentRunsList, (_e, projectId: string | null): AgentRunRow[] => {
    // Audit view (PRD metric: agent actions 100% auditable).
    const pid = typeof projectId === 'string' ? String(projectId) : null
    if (pid && !projects.byId(pid)) throw new Error('project not found')
    return listAgentRuns(db, pid)
  })

  ipcMain.handle(IPC.StyleGet, (_e, projectId: string): ProjectStyle | null => {
    // studio/style.json (DATA-SCHEMA §6) — null when the project has no overrides.
    const project = projects.byId(String(projectId))
    if (!project) throw new Error('project not found')
    try {
      return JSON.parse(readFileSync(join(project.path, 'studio', 'style.json'), 'utf-8')) as ProjectStyle
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.StyleSave, (_e, input: { projectId: string; style: ProjectStyle }) => {
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    const raw = input?.style
    if (!raw || typeof raw !== 'object') throw new Error('style payload required')
    // Whitelist: only the DATA-SCHEMA §6 keys survive, values validated.
    const style: ProjectStyle = {}
    if (typeof raw.preset === 'string' && raw.preset.trim() && raw.preset.trim().length <= 40) style.preset = raw.preset.trim()
    if (typeof raw.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.accent)) style.accent = raw.accent
    if (['kinetic', 'boxed', 'off'].includes(String(raw.caption_style))) style.caption_style = String(raw.caption_style)
    if (typeof raw.vignette === 'boolean') style.vignette = raw.vignette
    if (typeof raw.grain === 'boolean') style.grain = raw.grain
    if (typeof raw.transition_set === 'string' && raw.transition_set.trim()) style.transition_set = raw.transition_set.trim()
    if (typeof raw.look === 'string' && raw.look.trim()) style.look = raw.look.trim().slice(0, 200)
    // Merge over the existing file: a user tweak must not silently drop the
    // Director-authored keys (look/transition_set) — last writer wins per key.
    let prev: ProjectStyle = {}
    try {
      const parsed = JSON.parse(readFileSync(join(project.path, 'studio', 'style.json'), 'utf-8')) as ProjectStyle
      if (parsed && typeof parsed === 'object') prev = parsed
    } catch {
      // no previous style — the whitelist payload is the whole file
    }
    const merged: ProjectStyle = { ...prev, ...style }
    mkdirSync(join(project.path, 'studio'), { recursive: true })
    writeFileSync(join(project.path, 'studio', 'style.json'), JSON.stringify(merged, null, 2) + '\n', 'utf-8')
    return merged
  })

  ipcMain.handle(IPC.TtsPreviewVoice, async (_e, input: { projectId: string; voice: string; text?: string }) => {
    // Voice preview is the user's own explicit click — consent is the click itself;
    // the Producer's generate gate (G-D) still formally covers narration batches.
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    return bridge.ttsPreview({
      projectPath: project.path,
      text: input.text?.trim() || 'This is how your documentary could sound with this voice.',
      voice: String(input.voice)
    })
  })

  // ------------------------------------------------------------------ M1
  ipcMain.handle(IPC.ScoutRun, (_e, input: { projectId: string; topic: string }) => {
    if (!input?.topic?.trim()) throw new Error('topic required')
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    return jobs.enqueue('scout.research', {
      agent: 'scout',
      resumable: false,
      projectId: project.id,
      params: { topic: input.topic.trim(), projectId: project.id, projectPath: project.path }
    })
  })

  ipcMain.handle(IPC.AssetsList, async (_e, projectId: string) => {
    const project = projects.byId(String(projectId))
    if (!project) throw new Error('project not found')
    const view = (await bridge.request('assets.list', { project_path: project.path })) as {
      candidates: Array<Record<string, unknown>>
      downloaded_count: number
    }
    return {
      assets: view.candidates.map(mapAsset),
      downloadedCount: Number(view.downloaded_count ?? 0)
    }
  })

  ipcMain.handle(IPC.AssetsSetRights, async (_e, input: { projectId: string; assetIds: string[]; approved: boolean; notes?: string }) => {
    // Gate G-C: rights approval is never automatic — this handler IS the
    // user's explicit click in the Asset Library.
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    if (!Array.isArray(input.assetIds) || input.assetIds.length === 0) throw new Error('no assets selected')
    const res = (await bridge.request('ledger.set_rights', {
      project_path: project.path,
      asset_ids: input.assetIds,
      rights_status: input.approved ? 'approved' : 'review',
      notes: input.notes ?? undefined
    })) as { changed: number }
    return { changed: Number(res.changed) }
  })

  ipcMain.handle(IPC.AssetsDownload, async (_e, input: { projectId: string; assetIds?: string[] }) => {
    // Gate G-B: downloads are jobs the user explicitly starts.
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    return jobs.enqueue('assets.download', {
      agent: 'system',
      resumable: true,
      projectId: project.id,
      params: { projectPath: project.path, assetIds: input.assetIds ?? null }
    })
  })

  ipcMain.handle(IPC.LedgerList, async (_e, input: { projectId: string; kind: LedgerKind }) => {
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    const res = (await bridge.request('ledger.list', { project_path: project.path, kind: input.kind })) as {
      rows: Array<Record<string, unknown>>
    }
    return res.rows
  })

  ipcMain.handle(IPC.AssetsThumb, async (_e, input: { projectId: string; absPath: string }) => {
    const project = projects.byId(String(input.projectId))
    if (!project) throw new Error('project not found')
    const abs = String(input.absPath ?? '')
    if (!abs.toLowerCase().startsWith(project.path.toLowerCase())) throw new Error('path outside project')
    const res = (await bridge.request('media.thumbnail', { project_path: project.path, media_path: abs }, 120_000)) as {
      thumb: string | null
    }
    return res.thumb // relative path; renderer converts to studio:// URL
  })
}

// ---------------------------------------------------------------- utilities

function extractProjectArtifact(done: JobRecord): ProjectRecord {
  const record = done.artifacts?.[0] as ProjectRecord | undefined
  if (!record || typeof record.path !== 'string') {
    throw new Error('project.create finished without a project record')
  }
  return record
}

function mapAsset(row: Record<string, unknown>): AssetRecord {
  const str = (k: string): string => (typeof row[k] === 'string' ? (row[k] as string) : '')
  return {
    assetId: str('asset_id'),
    sourceId: str('source_id'),
    provider: str('provider'),
    title: str('title'),
    date: str('date'),
    assetPageUrl: str('asset_page_url'),
    downloadUrl: str('download_url'),
    filename: str('filename'),
    mediaType: str('media_type'),
    license: str('license'),
    licenseUrl: str('license_url'),
    creator: str('creator'),
    attribution: str('attribution'),
    rightsStatement: str('rights_statement'),
    rightsStatus: str('rights_status') || 'review',
    notes: str('notes'),
    savedPath: str('saved_path'),
    sha256: str('sha256'),
    bytes: Number(row.bytes ?? 0) || 0,
    downloaded: row.downloaded === true
  }
}

/** Seed files for the onboarding demo film: a tiny 2-scene, compositions-only
 * documentary the Producer can run without research or assets (M5). */
function seedSampleProject(projectPath: string): void {
  const write = (rel: string, content: string): void => {
    const abs = join(projectPath, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf-8')
  }
  write(
    'production/script.md',
    [
      '---',
      'voice: en-US-AndrewMultilingualNeural',
      'sections:',
      '  - id: hook',
      '    pace: 1.0',
      '  - id: payoff',
      '    pace: 1.0',
      '---',
      '## [hook] The Hook',
      '',
      'Every documentary begins as a single sentence. This one began the moment you pressed create.',
      '',
      '## [payoff] The Payoff',
      '',
      'Research, rights, narration, motion, and delivery — one crew, one file, no video editor required. This film was made entirely inside VendoTube Studio.'
    ].join('\n')
  )
  write(
    'production/beats.json',
    JSON.stringify(
      {
        version: 1,
        beats: [
          { id: 'B01', scene: 'S01', label: 'Hook', startS: 0, durS: 10, curiosity: 0.9, tension: 0.2, rehook: false, patternInterrupt: null, opensLoop: 'why does the clock tick differently here?', closesLoop: null, music: '', sfx: [] },
          { id: 'B02', scene: 'S02', label: 'Payoff', startS: 10, durS: 12, curiosity: 0.5, tension: 0.4, rehook: true, patternInterrupt: null, opensLoop: null, closesLoop: 'why does the clock tick differently here?', music: '', sfx: [] }
        ],
        rehooks: ['B02'],
        chapter_markers: true
      },
      null,
      2
    ) + '\n'
  )
  write(
    'production/bible.md',
    [
      '---',
      'title: "The Clock That Watched"',
      'thesis: "A studio of agents can make a documentary from one sentence."',
      'target_runtime_seconds: 22',
      'style_preset: vox-explainer',
      'emotional_promise: "curiosity turning into a small, honest delight"'
    ].join('\n') +
      '\n\n## Arc\n\nA hook about beginnings, a payoff about the craft: research, rights, narration, motion, delivery.\n\n## Scenes\n\n' +
      [
        '### S01 — Hook: A single sentence',
        '- shows: title card',
        '- feels: curiosity — why they stay: the film is about to be made in front of them',
        '- motion: snap-in title, marker wipe',
        '- on-screen text: The Clock That Watched',
        '- duration_target_s: 10',
        '',
        '### S02 — Payoff: One crew, one file',
        '- shows: end card',
        '- feels: delight — the crew already finished',
        '- motion: end card with credits note',
        '- on-screen text: Made in VendoTube Studio',
        '- duration_target_s: 12'
      ].join('\n') +
      '\n'
  )
  write(
    'studio/workflow.json',
    JSON.stringify(
      {
        version: 1,
        render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
        scenes: [
          {
            id: 'S01',
            beats: ['B01'],
            vo: { script_section: 'hook', voice: 'en-US-AndrewMultilingualNeural' },
            shots: [{ kind: 'composition', template: 'vox-explainer/title-01', text: 'The Clock That Watched', dur_s: 10 }],
            transitions: { in: 'fade', out: 'crossfade' },
            sfx: [],
            claims: []
          },
          {
            id: 'S02',
            beats: ['B02'],
            vo: { script_section: 'payoff', voice: 'en-US-AndrewMultilingualNeural' },
            shots: [
              {
                kind: 'composition',
                template: 'data-list',
                text: 'One crew, one file',
                // Honest product facts (the actual pipeline stages) — showcases the list card.
                data: {
                  kind: 'list',
                  title: 'One crew, one file',
                  items: [
                    { label: 'Research (evidence ledger)' },
                    { label: 'Rights approval (human gate)' },
                    { label: 'Narration + subtitles' },
                    { label: 'Motion compositions' },
                    { label: 'Render + delivery' }
                  ]
                },
                dur_s: 5
              },
              { kind: 'composition', template: 'end-card', text: 'Made in VendoTube Studio', dur_s: 7 }
            ],
            transitions: { in: 'crossfade', out: 'crossfade' },
            sfx: [],
            claims: []
          }
        ],
        music: null
      },
      null,
      2
    ) + '\n'
  )
}
