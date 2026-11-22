import { app, BrowserWindow, net, protocol } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { openDb, type Db } from './db'
import { SettingsStore } from './settings'
import { deleteSecret, getSecret, secretStatus, setSecret } from './secrets'
import { AuthService, createSupabaseClient, type MinimalAuthClient, type SessionPersist } from './auth'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAnonKey, supabaseConfigured, supabaseUrl } from './supabase-config'
import { BibleSyncService, createSupabaseBibleSync } from './bibleSync'
import { readBibleBundle } from './artifacts'
import { OpenRouterAdapter } from './provider'
import { BridgeClient, type BridgeStatus } from './bridge'
import { JobCancelled, JobManager, type JobContext, type JobRepo } from './jobs'
import { ProjectService } from './projects'
import { insertChat } from './chat'
import { createMainWindow } from './window'
import { registerIpcHandlers } from './ipc'
import { registerStudioProtocol } from './studio-protocol'
import { ScoutBrowser } from './browser/scoutBrowser'
import { ChatClient } from './agent/chat'
import { ScoutRunner } from './agent/scout'
import { DirectorRunner } from './agent/director'
import { ProducerPipeline, type ProduceResult } from './producer/pipeline'
import { ShowrunnerRunner, showrunnerPhases, workflowExists } from './showrunner'
import { buildProviderEngines } from './net/providerFetch'
import { gateKey, insertApproval, latestApprovalStatus, setApprovalStatus } from './approvals'
import { endAgentRun, startAgentRun } from './audit'
import { EVENTS, type BibleBundle, type ScoutActivity, type ProducerActivity, type JobRecord as JobRecordType, type JobStatus } from '@shared/ipc'

/**
 * App entry. Boot order: db → services → window → bridge → recover jobs.
 * VENDOTUBE_SMOKE=1 runs the M0 exit-criteria harness: hidden window,
 * bridge round-trip (sys.ping + dwk.init_project + dwk.validate_project),
 * then exit 0/1.
 */

const SMOKE = process.env.VENDOTUBE_SMOKE === '1'
const M3_SMOKE = process.env.VENDOTUBE_M3_SMOKE === '1'

// ----------------------------------------------------------- sqlite job repo

interface JobRowRaw {
  id: string
  project_id: string | null
  kind: string
  agent: string
  params: string | null
  status: string
  progress: string | null
  artifacts: string | null
  error: string | null
  resumable: number
  created_at: string
  updated_at: string
}

class SqliteJobRepo implements JobRepo {
  constructor(private readonly db: Db) {}

  private map(r: JobRowRaw): JobRecordType {
    const parse = (v: string | null): unknown => {
      if (!v) return null
      try {
        return JSON.parse(v)
      } catch {
        return null
      }
    }
    return {
      id: r.id,
      projectId: r.project_id,
      kind: r.kind,
      agent: r.agent,
      params: parse(r.params),
      status: r.status as JobStatus,
      progress: (parse(r.progress) ?? {}) as JobRecordType['progress'],
      artifacts: (parse(r.artifacts) ?? []) as unknown[],
      error: r.error,
      resumable: r.resumable === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }

  list(): JobRecordType[] {
    return this.db.prepare<[], JobRowRaw>('SELECT * FROM jobs ORDER BY created_at').all().map((r) => this.map(r))
  }

  get(id: string): JobRecordType | null {
    const r = this.db.prepare<[string], JobRowRaw>('SELECT * FROM jobs WHERE id = ?').get(id)
    return r ? this.map(r) : null
  }

  insert(job: JobRecordType): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, project_id, kind, agent, params, status, progress, artifacts, error, resumable, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        job.id,
        job.projectId,
        job.kind,
        job.agent,
        JSON.stringify(job.params ?? null),
        job.status,
        JSON.stringify(job.progress ?? {}),
        JSON.stringify(job.artifacts ?? []),
        job.error,
        job.resumable ? 1 : 0,
        job.createdAt,
        job.updatedAt
      )
  }

  update(id: string, patch: Partial<JobRecordType>): void {
    const sets: string[] = []
    const values: unknown[] = []
    const column = (k: string): string | null => {
      switch (k) {
        case 'status':
          return 'status'
        case 'progress':
          return 'progress'
        case 'artifacts':
          return 'artifacts'
        case 'error':
          return 'error'
        case 'updatedAt':
          return 'updated_at'
        default:
          return null
      }
    }
    for (const [k, v] of Object.entries(patch)) {
      const col = column(k)
      if (!col) continue
      sets.push(`${col} = ?`)
      if (k === 'progress' || k === 'artifacts') values.push(JSON.stringify(v ?? null))
      else values.push(v ?? null)
    }
    if (sets.length === 0) return
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  }
}

// ------------------------------------------------------- crew job runners
//
// The bodies of the scout/director/producer job handlers, extracted so the
// Showrunner orchestrator (M6) can chain them inside one job instead of the
// user typing /research → /direct → /produce by hand. Each function owns its
// agent_runs audit row and honest error mapping, exactly like before.

interface CrewJobDeps {
  db: Db
  settings: SettingsStore
  bridge: BridgeClient
  projects: ProjectService
  dwkRoot: string
  scoutBrowser: ScoutBrowser
  /** Cloud-save of the Bible result + research/asset links (best-effort). */
  bibleSync?: BibleSyncService
  emitScout: (projectId: string, activity: ScoutActivity) => void
  emitDirector: (projectId: string, activity: { type: string; tool?: string; summary?: string; at: string }) => void
  emitProducer: (projectId: string, activity: ProducerActivity) => void
}

async function runResearchJob(
  deps: CrewJobDeps,
  ctx: JobContext,
  params: { topic: string; projectId: string; projectPath: string }
): Promise<unknown> {
  const { db, settings, bridge, dwkRoot, scoutBrowser, emitScout } = deps
  const apiKey = getSecret(db, 'provider.api_key')
  if (!apiKey) throw new Error('No model provider key configured — add one in Settings (provider key), then rerun /research.')
  const model = settings.get('agent.scout_model', settings.get('provider.model', 'openrouter/auto'))
  const runId = startAgentRun(db, { projectId: params.projectId, agent: 'scout', stage: 'research', model })
  try {
    ctx.setProgress('waking Scout', 5)
    const chat = new ChatClient({
      baseUrl: settings.get('provider.base_url', 'https://openrouter.ai/api/v1'),
      apiKey,
      model,
      // Reasoning models (GLM-5.3-Flash class) burn the whole default 4096
      // output budget on reasoning_content and answer with finish_reason=
      // length + empty content — 16k gives reasoning + tool calls headroom.
      maxTokens: 16384,
      // Cap hidden reasoning: on long turns a free-reasoning model can consume
      // the entire budget and answer with nothing (2026-11-18 dogfood). The
      // ChatClient also escalates the budget on a length-truncated empty reply.
      reasoningEffort: 'low',
      // Dual engines: HTTP/1.1 (undici, patient connect) first, Chromium
      // stack as fallback — retries alternate engines (TAD §6).
      engines: buildProviderEngines(net.fetch as unknown as typeof fetch)
    })
    const runner = new ScoutRunner({
      chat,
      dwkRoot,
      throwIfCancelled: () => ctx.throwIfCancelled(),
      deps: {
        bridge,
        browser: scoutBrowser,
        projectPath: params.projectPath,
        tavilyKey: null, // Tavily adapter lands with the Settings pass in M2
        visited: [],
        emit: (activity) => emitScout(params.projectId, activity)
      }
    })
    ctx.setProgress('researching with Scout', 15)
    const result = await runner.run(params.topic)
    endAgentRun(db, runId, 'done')
    insertChat(db, params.projectId, 'assistant', `[Scout] ${result.summary}`)
    deps.projects.setStage(params.projectId, 'research_done')
    ctx.setProgress('done', 100)
    return result
  } catch (err) {
    endAgentRun(db, runId, err instanceof JobCancelled ? 'cancelled' : 'failed')
    throw err
  }
}

/**
 * Cloud-save the Bible result (text/JSON — bible, beats, script draft, notes)
 * plus the research/asset LINKS from the DWK ledger (websites, articles,
 * images, videos — URLs and metadata only, downloaded files never leave the
 * machine). Best-effort: bounded at 20s so a dead network can't park the job,
 * never throws into the run. Returns an activity summary (null = nothing to
 * disclose, e.g. no bible present).
 */
async function saveBibleToCloud(
  deps: CrewJobDeps,
  projectId: string,
  projectPath: string
): Promise<{ summary: string | null }> {
  const sync = deps.bibleSync
  if (!sync) return { summary: null }
  try {
    const bundle = readBibleBundle(projectPath)
    if (!bundle?.bible) return { summary: null }
    const project = deps.projects.byId(projectId)
    let sceneNotes: Record<string, string> = {}
    try {
      sceneNotes = JSON.parse(readFileSync(join(projectPath, 'studio', 'scene_edits.json'), 'utf-8')) as Record<string, string>
    } catch {
      sceneNotes = {}
    }
    const fullBundle: BibleBundle = {
      ...bundle,
      sceneNotes,
      validation: null,
      stage: project?.stage ?? 'bible_ready'
    }
    const [sourcesRes, assetsRes] = await Promise.all([
      deps.bridge.request('ledger.list', { project_path: projectPath, kind: 'sources' }),
      deps.bridge.request('ledger.list', { project_path: projectPath, kind: 'assets' })
    ])
    const res = await Promise.race([
      sync.sync({
        projectSlug: project?.slug ?? project?.id ?? projectId,
        projectTitle: project?.name ?? null,
        bundle: fullBundle,
        sourceRows: (sourcesRes as { rows?: Array<Record<string, unknown>> }).rows ?? [],
        assetRows: (assetsRes as { rows?: Array<Record<string, unknown>> }).rows ?? []
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out after 20s')), 20_000))
    ])
    if (!res.saved) {
      // Expected skips (not signed in / not configured) — disclose, don't fail.
      return { summary: `Cloud save skipped: ${res.reason ?? 'unknown reason'}` }
    }
    return {
      summary: `Bible saved to the vendoria cloud — ${res.sources} source link${res.sources === 1 ? '' : 's'} · ${res.assets} asset link${res.assets === 1 ? '' : 's'} (links only, no files)`
    }
  } catch (err) {
    return { summary: `Cloud save failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function runDirectorJob(
  deps: CrewJobDeps,
  ctx: JobContext,
  params: { projectId: string; projectPath: string; notes?: string | null; voice: string }
): Promise<unknown> {
  const { db, settings, bridge, dwkRoot } = deps
  deps.projects.setStage(params.projectId, 'directing')
  const apiKey = getSecret(db, 'provider.api_key')
  if (!apiKey) throw new Error('No model provider key configured — add one in Settings first.')
  const model = settings.get('agent.director_model', settings.get('provider.model', 'openrouter/auto'))
  const runId = startAgentRun(db, { projectId: params.projectId, agent: 'director', stage: 'bible', model })
  try {
    ctx.setProgress('waking the Director', 8)
    const chat = new ChatClient({
      baseUrl: settings.get('provider.base_url', 'https://openrouter.ai/api/v1'),
      apiKey,
      model,
      // Same reasoning-budget trap as the Scout client: GLM-class models emit
      // thousands of reasoning chars before the first tool call — the 4096
      // default ended runs with finish_reason=length and no answer. The
      // Director's turns are the longest in the app (bible/script/workflow
      // JSON), so cap reasoning effort to keep the answer inside the budget.
      maxTokens: 16384,
      reasoningEffort: 'low',
      engines: buildProviderEngines(net.fetch as unknown as typeof fetch)
    })
    const runner = new DirectorRunner({
      chat,
      dwkRoot,
      maxTurns: 26,
      throwIfCancelled: () => ctx.throwIfCancelled(),
      deps: {
        bridge,
        projectPath: params.projectPath,
        voice: params.voice,
        revisionNotes: params.notes ?? null,
        // User-set runtime from project.yml (null when auto — the Director
        // decides the length from the research).
        targetRuntimeSeconds: deps.projects.byId(params.projectId)?.runtimeSeconds ?? null,
        emit: (a) => deps.emitDirector(params.projectId, a)
      }
    })
    ctx.setProgress('designing the film', 20)
    const result = await runner.run()
    // Honest failure over a silent hand-off: without studio/workflow.json
    // the producer can only refuse (/produce would say "run /direct first").
    if (!existsSync(join(params.projectPath, 'studio', 'workflow.json'))) {
      deps.projects.setStage(params.projectId, 'direction_needs_fixes')
      throw new Error('Director stopped without writing studio/workflow.json — re-run /direct. The run summary names the cause (provider silence/errors are the usual one).')
    }
    ctx.setProgress('validating artifacts via DWK', 85)
    const report = await bridge.validateProject(params.projectPath)
    const stage = report.valid ? 'bible_ready' : 'direction_needs_fixes'
    deps.projects.setStage(params.projectId, stage)
    const validationLine = report.valid
      ? 'DWK validation: PASS ✓ — the project is ready for production (M3).'
      : `DWK validation flagged ${report.errors.length} issue(s): ${report.errors.slice(0, 3).join('; ')}`
    insertChat(db, params.projectId, 'assistant', `[Director] ${result.summary}\n${validationLine}`)
    // Cloud-save the Bible result + research/asset LINKS for the signed-in
    // account (no files leave the machine — URLs, titles, licenses only).
    // Best-effort: bounded, disclosed, never fails the Director run.
    if (deps.bibleSync && report.valid) {
      ctx.setProgress('saving the bible to the vendoria cloud', 92)
      const saved = await saveBibleToCloud(deps, params.projectId, params.projectPath)
      if (saved.summary) {
        deps.emitDirector(params.projectId, { type: 'message', summary: saved.summary, at: new Date().toISOString() })
      }
    }
    ctx.setProgress('done', 100)
    endAgentRun(db, runId, 'done')
    return { result, validation: { valid: report.valid, errors: report.errors, warnings: report.warnings } }
  } catch (err) {
    endAgentRun(db, runId, err instanceof JobCancelled ? 'cancelled' : 'failed')
    throw err
  }
}

async function runProduceJob(
  deps: CrewJobDeps,
  ctx: JobContext,
  params: { projectId: string; projectPath: string; quality?: string | null; autopilot?: boolean }
): Promise<ProduceResult> {
  const { db, settings, bridge } = deps
  deps.projects.setStage(params.projectId, 'producing')
  const runId = startAgentRun(db, {
    projectId: params.projectId,
    agent: 'producer',
    stage: `produce${params.quality ? `:${params.quality}` : ''}`,
    model: 'deterministic-pipeline'
  })
  // M7 Layer 1: the vision reviewer exists only when the user explicitly set
  // agent.visual_model (empty = vision review OFF — sending frames to a
  // provider is opt-in) and a provider key exists. Otherwise the visual QC
  // report discloses vision: false and makes zero provider calls (PRD R11).
  const visionModel = settings.get('agent.visual_model', '').trim()
  const visionKey = getSecret(db, 'provider.api_key')
  const visionDeps =
    visionKey && visionModel
      ? {
          chat: new ChatClient({
            baseUrl: settings.get('provider.base_url', 'https://openrouter.ai/api/v1'),
            apiKey: visionKey,
            model: visionModel,
            engines: buildProviderEngines(net.fetch as unknown as typeof fetch),
            timeoutMs: 180_000,
            // 12 images per batch invite long reasoning before the JSON — the
            // 4096 default would truncate mid-array (finish_reason=length).
            maxTokens: 16384
          }),
          model: visionModel
        }
      : undefined
  // Render CPU policy (Settings → Render performance): 'low' (default) renders
  // BELOW_NORMAL so the PC stays responsive; 'normal' = old all-cores behavior.
  const renderPriority = settings.get<'low' | 'normal'>('render.priority', 'low') === 'normal' ? 'normal' : 'low'
  try {
    const pipeline = new ProducerPipeline({
      bridge,
      projectPath: params.projectPath,
      defaultVoice: settings.get('tts_voice', 'en-US-AndrewMultilingualNeural'),
      qualityOverride: params.quality && ['draft', 'standard', 'high'].includes(params.quality) ? params.quality : undefined,
      renderPriority,
      setProgress: (phase, pct, eta) => ctx.setProgress(phase, pct, eta),
      emit: (a) => deps.emitProducer(params.projectId, a),
      throwIfCancelled: () => ctx.throwIfCancelled(),
      vision: visionDeps,
      visionRunStart: (model) => startAgentRun(db, { projectId: params.projectId, agent: 'producer', stage: 'visual_qc', model }),
      visionRunEnd: (id, status, counts) => {
        if (id) endAgentRun(db, id, status, counts)
      },
      gate: async (gate, summary, detail) => {
        const toolName = `${gateKey(gate)}:${String(detail.stamp ?? 'x')}`
        const status = latestApprovalStatus(db, params.projectId, toolName)
        if (status === 'approved') return true
        if (status === 'pending') {
          // Restarted/parked run reaching the same undecided gate again.
          ctx.setAwaitingApproval()
          return false
        }
        const rowId = insertApproval(db, params.projectId, toolName, { gate, summary, detail })
        // Showrunner autopilot (user decision 2026-11-15): the kickoff click is
        // the user's pre-authorization, so G-D/G-E/G-F pass without parking —
        // but they are STILL recorded as approved rows (audit parity, PRD §10
        // "agent actions 100% auditable"). G-M (research media rights) is never
        // auto-approved: the film parks once and waits for the user. G-V (M7
        // visual QC verdict) parks too — a visual defect verdict is a quality
        // decision that stays human, not a side effect to pre-authorize.
        if (params.autopilot && !['G-M', 'G-V'].includes(gate)) {
          setApprovalStatus(db, rowId, 'approved')
          deps.emitProducer(params.projectId, {
            type: 'message',
            tool: `gate:${gate}`,
            summary: `${summary} — auto-approved (Showrunner autopilot, recorded in the audit log)`,
            at: new Date().toISOString()
          })
          return true
        }
        ctx.setAwaitingApproval()
        deps.emitProducer(params.projectId, { type: 'gate', tool: `gate:${gate}`, summary, at: new Date().toISOString() })
        return false
      }
    })
    ctx.setProgress('reading the film plan', 2)
    const result = await pipeline.run()
    if (result.status === 'paused_at_gate') {
      // execute() preserves awaiting_approval; keep the stage honest too.
      endAgentRun(db, runId, 'done')
      return result
    }
    deps.projects.setStage(params.projectId, 'delivered')
    endAgentRun(db, runId, 'done')
    insertChat(db, params.projectId, 'assistant', `[Producer] ${result.summary}`)
    ctx.setProgress('done', 100)
    return result
  } catch (err) {
    endAgentRun(db, runId, err instanceof JobCancelled ? 'cancelled' : 'failed')
    throw err
  }
}

// ------------------------------------------------------------------- main

let mainWindow: BrowserWindow | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  // studio:// must be privileged BEFORE app ready: <video> playback and range
  // streaming need the stream/fetch/standard privileges (otherwise the preview
  // player stalls on the MP4 masters).
  protocol.registerSchemesAsPrivileged([
    { scheme: 'studio', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } }
  ])

  // Taskbar identity: must match electron-builder's appId so the installed
  // shortcut, taskbar grouping and toasts share one Windows AppUserModelID.
  app.setAppUserModelId('studio.vendotube.app')

  app.whenReady().then(async () => {
    const db = openDb(join(app.getPath('userData'), 'app.db'))
    const settings = new SettingsStore(db)
    const projects = new ProjectService(db, () =>
      settings.get('projects_root', join(app.getPath('documents'), 'VendoTube Studio'))
    )

    // ---- Supabase auth (vendoria.ai) ------------------------------------
    // Session persistence rides the safeStorage-encrypted secrets table: the
    // refresh token is DPAPI-encrypted at rest and autoRefreshToken keeps it
    // valid across app restarts. One client instance serves BOTH the sign-in
    // gate and the bible cloud-sync (single session, shared refresh).
    // Unconfigured (no URL/anon key yet) → the renderer's sign-in gate
    // explains what to paste and the sync discloses "not configured".
    const sessionPersist: SessionPersist = {
      getItem: (key) => getSecret(db, key),
      setItem: (key, value) => {
        setSecret(db, key, value)
      },
      removeItem: (key) => {
        deleteSecret(db, key)
      }
    }
    // Client creation is failure-tolerant on purpose: an unexpected Supabase
    // error must degrade to "not configured" (gate explains; sync skips), NOT
    // reject the whenReady chain — that used to kill the whole boot silently
    // (the realtime WebSocket requirement on Node 20 taught us this).
    let supabase: SupabaseClient | null = null
    if (supabaseConfigured()) {
      try {
        supabase = await createSupabaseClient(supabaseUrl(), supabaseAnonKey(), sessionPersist)
      } catch (err) {
        console.error('[supabase] client creation failed — running unconfigured:', err instanceof Error ? err.message : err)
      }
    }
    // Structural subset cast — auth.ts only calls the five GoTrue methods.
    const auth = new AuthService(supabase ? (supabase.auth as unknown as MinimalAuthClient) : null)
    const bibleSync = new BibleSyncService(supabase ? createSupabaseBibleSync(supabase) : null)

    // ---- bridge --------------------------------------------------------
    const scriptPath = app.isPackaged
      ? join(process.resourcesPath, 'bridge', 'server.py')
      : join(app.getAppPath(), 'bridge', 'server.py')
    const resolvePython = (): string => {
      const configured = settings.get<string | undefined>('bridge_python', undefined)
      if (configured) return configured
      const venv = join(app.getAppPath(), 'bridge', '.venv', 'Scripts', 'python.exe')
      if (existsSync(venv)) return venv
      return 'python'
    }
    const bridge = new BridgeClient(
      resolvePython,
      () => scriptPath,
      () => ({
        ...process.env,
        DWK_PATH: settings.get<string | undefined>(
          'dwk_path',
          join(app.getAppPath(), '..', 'documentary_workflow_kit', 'documentary_workflow_kit')
        )
      }),
      // Render performance setting: the bridge tree (ffmpeg loudness/QC/concat)
      // runs BELOW_NORMAL unless the user chose Full speed. Evaluated at spawn,
      // so a bridge restart (app restart) picks up a changed value.
      () => settings.get<'low' | 'normal'>('render.priority', 'low') !== 'normal'
    )
    bridge.on('status', (status: BridgeStatus, detail?: string) => {
      console.log(`[bridge] status=${status}${detail ? ` (${detail})` : ''}`)
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(EVENTS.BridgeStatus, { status, detail: detail ?? null })
      }
    })

    // ---- jobs ----------------------------------------------------------
    const jobRepo = new SqliteJobRepo(db)
    const jobs = new JobManager(jobRepo, (event, row) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(event, row)
      }
    })
    jobs.registerHandler('project.create', async (ctx) => {
      const input = (ctx.params ?? {}) as { title: string; fps?: number; runtimeSeconds?: number; language?: string; rootDir?: string }
      ctx.setProgress('initializing project folder (DWK)')
      const record = await projects.create(input, { initProject: (p) => bridge.initProject(p) })
      ctx.setProgress('registering project')
      return record
    })
    jobs.registerHandler('project.validate', async (ctx) => {
      const params = (ctx.params ?? {}) as { projectPath: string }
      ctx.setProgress('validating project via DWK')
      const report = await bridge.validateProject(params.projectPath)
      return report
    })

    // ---- M1: Scout + asset flows ----------------------------------------
    const dwkRoot = settings.get<string>(
      'dwk_path',
      join(app.getAppPath(), '..', 'documentary_workflow_kit', 'documentary_workflow_kit')
    )
    const scoutBrowser = new ScoutBrowser(settings.get<string | null>('scout_browser_channel', 'msedge'))
    const emitScout = (projectId: string, activity: ScoutActivity): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(EVENTS.ScoutActivity, { projectId, activity })
      }
    }
    const emitDirector = (projectId: string, activity: { type: string; tool?: string; summary?: string; at: string }): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(EVENTS.DirectorActivity, { projectId, activity })
      }
    }
    const emitProducer = (projectId: string, activity: ProducerActivity): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(EVENTS.ProducerActivity, { projectId, activity })
      }
    }
    const crewDeps: CrewJobDeps = { db, settings, bridge, projects, dwkRoot, scoutBrowser, bibleSync, emitScout, emitDirector, emitProducer }
    jobs.registerHandler('scout.research', async (ctx) => {
      const params = (ctx.params ?? {}) as { topic: string; projectId: string; projectPath: string }
      return runResearchJob(crewDeps, ctx, params)
    })
    jobs.registerHandler('assets.download', async (ctx) => {
      const params = (ctx.params ?? {}) as { projectPath: string; assetIds?: string[] | null }
      ctx.setProgress('splitting approved rows by license channel')
      const view = (await bridge.request('assets.list', { project_path: params.projectPath })) as {
        candidates: Array<Record<string, unknown>>
      }
      const inSelection = (row: Record<string, unknown>): boolean =>
        !params.assetIds || params.assetIds.length === 0 || params.assetIds.includes(String(row.asset_id))
      const approved = view.candidates.filter(
        (c) => String(c.rights_status ?? '').toLowerCase() === 'approved' && inSelection(c)
      )
      const unverifiedIds = approved
        .filter((c) => String(c.license ?? '').toLowerCase().startsWith('unverified'))
        .map((c) => String(c.asset_id))
      const licensedCount = approved.length - unverifiedIds.length
      let web: unknown = null
      if (unverifiedIds.length > 0) {
        ctx.setProgress(`downloading ${unverifiedIds.length} unverified web/video asset(s)`)
        web = await bridge.request('web.download_assets', { project_path: params.projectPath, asset_ids: unverifiedIds }, 3_600_000)
      }
      ctx.setProgress(`running DWK rights-gated downloader (${licensedCount} licensed row(s))`)
      const dwk = await bridge.request('dwk.download_assets', { project_path: params.projectPath }, 1_800_000)
      return { web, dwk }
    })

    // ---- M2: Director ---------------------------------------------------
    jobs.registerHandler('director.build', async (ctx) => {
      const params = (ctx.params ?? {}) as {
        projectId: string
        projectPath: string
        notes?: string | null
        voice: string
      }
      return runDirectorJob(crewDeps, ctx, params)
    })

    // ---- M3: Producer ----------------------------------------------------
    jobs.registerHandler('producer.produce', async (ctx) => {
      const params = (ctx.params ?? {}) as { projectId: string; projectPath: string; quality?: string | null; autopilot?: boolean }
      return runProduceJob(crewDeps, ctx, params)
    })

    // ---- M6: Showrunner autopilot ---------------------------------------
    // One idea → film: research → direction → draft render inside a single
    // resumable job. Gates G-D/G-E/G-F are pre-authorized by the kickoff click
    // (audited, see runProduceJob); G-M (research media rights) parks the job.
    // A park → resume re-enters this handler; showrunnerPhases() skips the
    // finished phases by project stage, and the Producer resumes from its
    // studio/producer_state.json ledger.
    const defaultVoice = (): string => settings.get('tts_voice', 'en-US-AndrewMultilingualNeural')

    jobs.registerHandler('showrunner.make', async (ctx) => {
      const params = (ctx.params ?? {}) as {
        idea: string
        projectId?: string
        projectPath?: string
        minutes?: number
        fps?: number
      }
      ctx.setProgress('waking the crew', 2)
      let projectId = params.projectId
      let projectPath = params.projectPath
      if (!projectId || !projectPath) {
        const record = await projects.create(
          {
            title: params.idea,
            fps: params.fps,
            runtimeSeconds: params.minutes ? Math.max(30, Math.round(params.minutes * 60)) : undefined
          },
          { initProject: (p) => bridge.initProject(p) }
        )
        projectId = record.id
        projectPath = record.path
      }
      const stage = projects.byId(projectId)?.stage ?? 'created'
      const phases = showrunnerPhases(stage, workflowExists(projectPath))
      const phaseLine = phases
        .map((p) => (p === 'research' ? 'research' : p === 'direct' ? 'film design' : 'draft render'))
        .join(' → ')
      const runId = startAgentRun(db, { projectId, agent: 'showrunner', stage: 'make', model: 'orchestrator' })
      try {
        insertChat(
          db,
          projectId,
          'assistant',
          `[Showrunner] Taking the brief: "${params.idea}". Running the crew: ${phaseLine}. Autopilot is on — narration, rendering and packaging are pre-approved (recorded in the audit log); I'll pause only once to ask before research media appears on screen. The draft preview opens when it's ready.`
        )
        const runner = new ShowrunnerRunner({
          phases,
          deps: {
            research: async () => {
              await runResearchJob(crewDeps, ctx, { topic: params.idea, projectId, projectPath })
            },
            direct: async () => {
              await runDirectorJob(crewDeps, ctx, { projectId, projectPath, notes: null, voice: defaultVoice() })
            },
            produce: (quality) => runProduceJob(crewDeps, ctx, { projectId, projectPath, quality, autopilot: true }),
            onAwaitingApproval: () => ctx.setAwaitingApproval(),
            throwIfCancelled: () => ctx.throwIfCancelled()
          }
        })
        const result = await runner.run()
        endAgentRun(db, runId, 'done')
        ctx.setProgress('done', 100)
        // Parked run: return the ProduceResult itself so the gate card in the
        // Jobs rail / Delivery reads artifacts[0].pausedAtGate as before.
        if (result.outcome?.status === 'paused_at_gate') return result.outcome
        return result
      } catch (err) {
        endAgentRun(db, runId, err instanceof JobCancelled ? 'cancelled' : 'failed')
        throw err
      }
    })

    jobs.registerHandler('showrunner.refine', async (ctx) => {
      const params = (ctx.params ?? {}) as { projectId: string; projectPath: string; notes: string }
      ctx.setProgress('directing the revision', 5)
      const runId = startAgentRun(db, { projectId: params.projectId, agent: 'showrunner', stage: 'refine', model: 'orchestrator' })
      try {
        const runner = new ShowrunnerRunner({
          phases: ['direct', 'produce'],
          deps: {
            research: async () => undefined,
            direct: async () => {
              await runDirectorJob(crewDeps, ctx, {
                projectId: params.projectId,
                projectPath: params.projectPath,
                notes: params.notes,
                voice: defaultVoice()
              })
            },
            produce: (quality) => runProduceJob(crewDeps, ctx, { projectId: params.projectId, projectPath: params.projectPath, quality, autopilot: true }),
            onAwaitingApproval: () => ctx.setAwaitingApproval(),
            throwIfCancelled: () => ctx.throwIfCancelled()
          }
        })
        const result = await runner.refine(params.notes)
        endAgentRun(db, runId, 'done')
        ctx.setProgress('done', 100)
        if (result.outcome?.status === 'paused_at_gate') return result.outcome
        return result
      } catch (err) {
        endAgentRun(db, runId, err instanceof JobCancelled ? 'cancelled' : 'failed')
        throw err
      }
    })

    registerStudioProtocol(() => projects.list().map((p) => p.path))

    // ---- window --------------------------------------------------------
    mainWindow = createMainWindow(settings, { smoke: SMOKE })

    // ---- ipc -----------------------------------------------------------
    const provider = new OpenRouterAdapter(() => getSecret(db, 'provider.api_key'))
    registerIpcHandlers({ db, settings, bridge, jobs, projects, provider, auth, getMainWindow: () => mainWindow })

    // ---- boot work -----------------------------------------------------
    const { requeued, failed } = jobs.recover()
    if (!SMOKE && (requeued > 0 || failed > 0)) {
      console.log(`[jobs] recovered on boot: requeued=${requeued} failed=${failed}`)
    }
    void jobs.drain()

    if (SMOKE) {
      await runSmoke(bridge, jobs)
    } else if (M3_SMOKE) {
      bridge.start()
      await runM3Smoke(db, bridge, settings)
    } else {
      bridge.start()
      void secretStatus(db, 'provider.api_key')
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

/**
 * M3 exit-criteria harness (VENDOTUBE_M3_SMOKE=1): drives the full Producer
 * pipeline — narration (edge-tts, SAPI fallback honest) → word-timed SRT →
 * HyperFrames compositions → draft render → DWK finalize → QC → retention →
 * youtube kit → package — against a synthetic two-scene project, with gates
 * auto-approved (this is a harness, the app UI gates for real). Exit 0 = a
 * finished documentary.mp4 + subtitles + QC pass + delivery ZIP.
 */
async function runM3Smoke(db: Db, bridge: BridgeClient, settings: SettingsStore): Promise<void> {
  const hardStop = setTimeout(() => {
    console.error('[m3-smoke] TIMEOUT after 10min')
    app.exit(1)
  }, 600_000)
  try {
    const pong = await bridge.ping(20_000)
    if (!pong.dwkLoaded) throw new Error(`DWK failed to load: ${pong.dwkError}`)
    console.log(`[m3-smoke] bridge ready (python ${pong.python})`)

    const { execFileSync } = await import('node:child_process')
    const { writeFileSync, mkdirSync, existsSync, statSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { ProducerPipeline } = await import('./producer/pipeline')

    const dir = join(tmpdir(), `vendotube-m3-${Date.now()}`)
    const projectPath = join(dir, 'm3-film')
    await bridge.initProject({ path: projectPath, title: 'M3 Smoke Film', fps: 30, runtime: 30, language: 'en' })

    // Synthetic still for the Ken Burns shot.
    const mediaDir = join(projectPath, 'media', 'images')
    mkdirSync(mediaDir, { recursive: true })
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:duration=1:rate=30', '-frames:v', '1', join(mediaDir, 'archival_still.jpg')])

    writeFileSync(
      join(projectPath, 'production', 'script.md'),
      [
        '---',
        'voice: en-US-AndrewMultilingualNeural',
        'sections:',
        '  - id: hook',
        '    pace: 1.0',
        '  - id: s01',
        '    pace: 1.0',
        '---',
        '## [hook] The Hook',
        '',
        'This is the M3 smoke film of the studio producer pipeline. (CLM-0001)',
        '',
        '## [s01] The Body',
        '',
        'It narrates these lines, renders a picture master, and packages a tiny documentary. (CLM-0002)'
      ].join('\n'),
      'utf-8'
    )

    const workflow = {
      version: 1,
      render: { resolution: [1920, 1080], fps: 30, quality: 'draft' },
      scenes: [
        {
          id: 'S01',
          beats: ['B01'],
          vo: { script_section: 'hook', voice: 'en-US-AndrewMultilingualNeural' },
          shots: [{ kind: 'composition', template: 'vox-explainer/title-01', text: 'M3 Smoke Film', dur_s: 4 }],
          transitions: { in: 'fade', out: 'crossfade' },
          sfx: [],
          claims: ['CLM-0001']
        },
        {
          id: 'S02',
          beats: ['B02'],
          vo: { script_section: 's01', voice: 'en-US-AndrewMultilingualNeural' },
          shots: [
            { kind: 'asset', asset: 'media/images/archival_still.jpg', motion: 'kenburns', zoom: 1.08, dur_s: 3 },
            { kind: 'composition', template: 'end-card', text: 'M3 Smoke Film', dur_s: 2 }
          ],
          transitions: { in: 'crossfade', out: 'crossfade' },
          sfx: [],
          claims: ['CLM-0002']
        }
      ],
      music: null
    }
    mkdirSync(join(projectPath, 'studio'), { recursive: true })
    writeFileSync(join(projectPath, 'studio', 'workflow.json'), JSON.stringify(workflow, null, 2), 'utf-8')

    const pipeline = new ProducerPipeline({
      bridge,
      projectPath,
      defaultVoice: settings.get('tts_voice', 'en-US-AndrewMultilingualNeural'),
      renderPriority: settings.get<'low' | 'normal'>('render.priority', 'low') === 'normal' ? 'normal' : 'low',
      setProgress: (phase, pct) => console.log(`[m3-smoke] ${phase}${pct !== undefined ? ` (${pct}%)` : ''}`),
      emit: (a) => console.log(`[m3-smoke] ${a.type}: ${a.summary ?? ''}`),
      throwIfCancelled: () => undefined,
      gate: async (gate, summary) => {
        console.log(`[m3-smoke] gate ${gate} auto-approved: ${summary}`)
        return true
      }
    })
    const result = await pipeline.run()
    if (result.status !== 'done') throw new Error(`pipeline paused at ${result.pausedAtGate}`)
    console.log(`[m3-smoke] ${result.summary}`)

    const checks: Array<[string, () => boolean]> = [
      // draft productions write picture-draft.mp4; standard/high write picture.mp4
      ['picture master', () => existsSync(join(projectPath, 'delivery', 'picture.mp4')) || existsSync(join(projectPath, 'delivery', 'picture-draft.mp4'))],
      ['final master', () => existsSync(join(projectPath, 'delivery', 'documentary.mp4'))],
      ['subtitles', () => existsSync(join(projectPath, 'production', 'subtitles.en.srt'))],
      ['qc report passed', () => {
        try {
          const rep = JSON.parse(readFileSync(join(projectPath, 'qc', 'qc_report.json'), 'utf-8')) as { passed?: boolean }
          return rep.passed === true
        } catch {
          return false
        }
      }],
      ['retention report', () => existsSync(join(projectPath, 'qc', 'retention_report.json'))],
      ['visual QC report (M7 layer 0)', () => {
        try {
          // The harness wires NO vision deps: the report must carry a real
          // verdict AND disclose vision:false — proving the disabled Layer 1
          // path makes zero provider calls (PRD R11).
          const rep = JSON.parse(readFileSync(join(projectPath, 'qc', 'visual_report.json'), 'utf-8')) as {
            verdict?: string
            coverage?: { vision?: boolean }
          }
          return (
            (rep.verdict === 'pass' || rep.verdict === 'warn' || rep.verdict === 'fail') && rep.coverage?.vision === false
          )
        } catch {
          return false
        }
      }],
      ['youtube kit', () => existsSync(join(projectPath, 'delivery', 'youtube_kit.md'))],
      ['delivery zip', () => existsSync(join(projectPath, 'delivery', 'project.zip'))]
    ]
    let failed = 0
    for (const [name, check] of checks) {
      const ok = check()
      console.log(`[m3-smoke] ${ok ? 'ok  ' : 'FAIL'} ${name}`)
      if (!ok) failed++
    }
    if (failed > 0) throw new Error(`${failed} artifact check(s) failed`)

    const masterBytes = statSync(join(projectPath, 'delivery', 'documentary.mp4')).size
    if (masterBytes < 100_000) throw new Error(`documentary.mp4 suspiciously small (${masterBytes} bytes)`)
    clearTimeout(hardStop)
    console.log(`[m3-smoke] OK — end-to-end film produced at ${projectPath} (${(masterBytes / 1e6).toFixed(1)} MB)`)
    app.exit(0)
  } catch (err) {
    clearTimeout(hardStop)
    console.error(`[m3-smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`)
    console.error(`[m3-smoke] bridge log tail:\n${bridge.logLines.slice(-12).join('\n') || '(empty)'}`)
    app.exit(1)
  }
}

async function runSmoke(bridge: BridgeClient, jobs: JobManager): Promise<void> {
  const hardStop = setTimeout(() => {
    console.error('[smoke] TIMEOUT after 60s')
    app.exit(1)
  }, 60_000)
  try {
    console.log('[smoke] boot ok — window created')
    bridge.start()
    const pong = await bridge.ping(20_000)
    console.log(`[smoke] sys.ping ok (python ${pong.python}, dwk_loaded=${pong.dwkLoaded})`)
    if (!pong.dwkLoaded) throw new Error(`DWK failed to load: ${pong.dwkError}`)

    const paths = await bridge.paths()
    console.log(`[smoke] sys.paths ok (ffmpeg=${paths.ffmpeg})`)

    // dwk round-trip: init a sample project, then validate it.
    const dir = mkdtempSync(join(tmpdir(), 'vendotube-smoke-'))
    const projectPath = join(dir, 'sample-project')
    await bridge.initProject({ path: projectPath, title: 'Smoke Test Film', fps: 30, runtime: 90, language: 'en' })
    if (!existsSync(join(projectPath, 'project.yml'))) throw new Error('init did not create the project folder')
    console.log(`[smoke] dwk.init_project ok -> ${projectPath}`)
    const expected = ['project.yml', 'research/sources.csv', 'production/shot_list.csv', 'production/script.md']
    for (const rel of expected) {
      if (!existsSync(join(projectPath, rel))) throw new Error(`init layout missing: ${rel}`)
    }
    console.log('[smoke] dwk layout ok')

    const report = await bridge.validateProject(projectPath)
    if (typeof report.valid !== 'boolean') throw new Error('validation report malformed')
    console.log(
      `[smoke] dwk.validate_project ok (valid=${report.valid}, errors=${report.errors.length}, warnings=${report.warnings.length})`
    )

    // Job pipeline round-trip through the queue.
    const job = await jobs.enqueue('project.validate', {
      resumable: true,
      params: { projectPath }
    })
    const done = await jobs.whenDone(job.id)
    if (done.status !== 'done') throw new Error(`job pipeline failed: ${done.status} ${done.error ?? ''}`)
    console.log('[smoke] job pipeline ok')

    clearTimeout(hardStop)
    console.log('[smoke] OK — all M0 exit criteria verified')
    app.exit(0)
  } catch (err) {
    clearTimeout(hardStop)
    console.error(`[smoke] FAIL: ${err instanceof Error ? err.message : String(err)}`)
    console.error(`[smoke] bridge log tail:\n${bridge.logLines.slice(-12).join('\n') || '(empty)'}`)
    app.exit(1)
  }
}
