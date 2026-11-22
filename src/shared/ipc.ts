/**
 * Typed IPC contract between main and renderer. Channel names and payload
 * shapes live here so preload can whitelist and both sides stay in sync.
 */

export const IPC = {
  AppInfo: 'app:info',

  ThemeGet: 'theme:get',
  ThemeSet: 'theme:set',

  ProjectsList: 'projects:list',
  ProjectsRecent: 'projects:recent',
  ProjectsCreate: 'projects:create',
  ProjectsOpen: 'projects:open',

  SettingsGetAll: 'settings:getAll',
  SettingsSet: 'settings:set',

  ProviderKeySet: 'provider:keySet',
  ProviderKeyStatus: 'provider:keyStatus',
  ProviderKeyDelete: 'provider:keyDelete',
  ProviderHealth: 'provider:health',

  BridgePing: 'bridge:ping',
  BridgePaths: 'bridge:paths',
  BridgeStatusGet: 'bridge:statusGet',

  ProjectsDelete: 'projects:delete',

  JobsList: 'jobs:list',
  JobsCancel: 'jobs:cancel',
  JobsRetry: 'jobs:retry',
  JobsDismiss: 'jobs:dismiss',

  ChatList: 'chat:list',
  ChatSend: 'chat:send',

  ScoutRun: 'scout:run',
  AssetsList: 'assets:list',
  AssetsSetRights: 'assets:setRights',
  AssetsDownload: 'assets:download',
  AssetsThumb: 'assets:thumb',
  LedgerList: 'ledger:list',

  DirectorRun: 'director:run',
  BibleGet: 'bible:get',
  BibleSaveSceneNotes: 'bible:saveSceneNotes',

  ProducerRun: 'producer:run',
  ProducerGateResolve: 'producer:gateResolve',
  DeliveryGet: 'delivery:get',
  YoutubeKitGet: 'delivery:youtubeKit',
  TtsVoices: 'tts:voices',
  TtsPreviewVoice: 'tts:previewVoice',

  StyleGet: 'style:get',
  StyleSave: 'style:save',

  AgentRunsList: 'agentRuns:list',
  SampleProjectCreate: 'onboarding:sampleProject',

  ShowrunnerMake: 'showrunner:make',
  ShowrunnerRefine: 'showrunner:refine',

  AuthSignUp: 'auth:signUp',
  AuthSignIn: 'auth:signIn',
  AuthSignOut: 'auth:signOut',
  AuthStatus: 'auth:status'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Events pushed main → renderer (whitelisted in preload). */
export const EVENTS = {
  JobUpdated: 'job:updated',
  BridgeStatus: 'bridge:status',
  ProviderStatus: 'provider:status',
  ScoutActivity: 'scout:activity',
  DirectorActivity: 'director:activity',
  ProducerActivity: 'producer:activity',
  /** Main → renderer: release any open media handle for this project before a delete. */
  ProjectsRelease: 'projects:release',
  /** Renderer → main: the renderer's media handles are closed. */
  ProjectsReleased: 'projects:released'
} as const

export type AppEvent = (typeof EVENTS)[keyof typeof EVENTS]

// ---------------------------------------------------------------- payloads

export interface AppInfo {
  version: string
  platform: string
  projectsRoot: string
  appDataDir: string
  /** VENDOTUBE_SMOKE=1 — the renderer bypasses the sign-in gate in smoke runs. */
  smoke: boolean
}

export type ThemeMode = 'dark' | 'light' | 'system'

export interface ProjectRecord {
  id: string
  name: string
  path: string
  slug: string
  fps: number | null
  runtimeSeconds: number | null
  createdAt: string
  updatedAt: string
  lastOpenedAt: string | null
  status: 'active' | 'archived'
  /** Showrunner stage: created | researching | research_done | directing | bible_ready | direction_needs_fixes */
  stage: string
}

export interface CreateProjectInput {
  title: string
  fps?: number
  runtimeSeconds?: number
  language?: string
  rootDir?: string
}

export interface OpenProjectResult {
  project: ProjectRecord
  validation: JobRecord | null
}

export type JobStatus = 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled'

export interface JobProgress {
  phase?: string
  pct?: number
  eta?: string
}

export interface JobRecord {
  id: string
  projectId: string | null
  kind: string
  agent: string
  params: unknown
  status: JobStatus
  progress: JobProgress
  /** Task result payloads (e.g. the created ProjectRecord) or output paths. */
  artifacts: unknown[]
  error: string | null
  resumable: boolean
  createdAt: string
  updatedAt: string
}

export interface BridgePingResult {
  ok: boolean
  version: string
  python: string
  dwkRoot: string
  dwkLoaded: boolean
  dwkError: string | null
}

export interface BridgePathsResult {
  python: string
  dwkRoot: string
  ffmpeg: string | null
  ffprobe: string | null
}

export interface ProviderKeyStatus {
  configured: boolean
  last4: string | null
  secure: boolean
}

export interface ProviderHealth {
  ok: boolean
  label?: string
  error?: string
}

export interface ValidationSummary {
  project: string
  title?: string
  valid: boolean
  errors: string[]
  warnings: string[]
  shotCount: number
  sourceCount: number
  claimCount: number
}

export interface ChatMessageRecord {
  id: number
  projectId: string | null
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export interface ChatSendResult {
  user: ChatMessageRecord
  assistant: ChatMessageRecord
}

// ------------------------------------------------------------------- auth

/** Renderer-side view of a Supabase auth user. */
export interface AuthUserView {
  id: string
  email: string | null
}

/** auth:status — boot-time session state from the encrypted local cache. */
export interface AuthStatus {
  /** false = Supabase URL/anon key not configured (gate explains how). */
  configured: boolean
  user: AuthUserView | null
  /** Session exists but Supabase is unreachable — UI offers a retry. */
  offline: boolean
}

export interface AuthSignUpResult {
  user: AuthUserView | null
  /** True when the project still requires email confirmation before sign-in. */
  needsEmailConfirmation: boolean
}

export interface AuthCredentials {
  email: string
  password: string
}

// ---------------------------------------------------------------- M1: scout

export interface ScoutActivity {
  type: 'tool_call' | 'tool_result' | 'page' | 'message' | 'error' | 'done'
  tool?: string
  args?: unknown
  summary?: string
  imageBase64?: string | null
  at: string
}

export interface ScoutRunResult {
  summary: string
  turns: number
  toolCalls: number
  stoppedReason: 'finish' | 'message' | 'max_turns' | 'cancelled'
}

export interface AssetRecord {
  assetId: string
  sourceId: string
  provider: string
  title: string
  date: string
  assetPageUrl: string
  downloadUrl: string
  filename: string
  mediaType: string
  license: string
  licenseUrl: string
  creator: string
  attribution: string
  rightsStatement: string
  rightsStatus: 'review' | 'approved' | 'blocked' | string
  notes: string
  savedPath: string
  sha256: string
  bytes: number
  downloaded: boolean
}

export type LedgerKind = 'sources' | 'evidence' | 'assets' | 'downloaded'

export interface SourceRow {
  source_id: string
  source_type: string
  title: string
  creator_or_publisher: string
  published_date: string
  accessed_date: string
  url: string
  license: string
  rights_statement: string
  notes: string
}

export interface ClaimRow {
  claim_id: string
  claim_text: string
  source_id: string
  locator: string
  exact_support_or_quote: string
  source_type: string
  confidence: string
  caveat: string
  script_location: string
}

// ------------------------------------------------------------- M2: director

export interface DirectorActivity {
  type: 'tool_call' | 'tool_result' | 'message' | 'error' | 'done'
  tool?: string
  summary?: string
  at: string
}

export interface BibleScene {
  id: string
  label: string
  title: string
  shows: string
  feels: string
  motion: string
  /** One-line visual plan (visual direction pass) — the human-readable scene look. */
  look: string | null
  onScreenText: string
  durationTargetS: number
  claims: string[]
  assetIds: string[]
}

export interface BibleBundle {
  bible: {
    title: string
    thesis: string
    targetRuntimeSeconds: number
    /** Present when the Director (not the user) chose the runtime — the evidence-based why. */
    runtimeDecision: string | null
    stylePreset: string
    emotionalPromise: string
    arc: string
    scenes: BibleScene[]
  } | null
  beats: Array<{
    id: string
    scene: string
    label: string
    startS: number
    durS: number
    curiosity: number
    tension: number
    rehook: boolean
    /** Open-loop bookkeeping (craft pass): what this beat plants / pays off. */
    opensLoop: string | null
    closesLoop: string | null
  }>
  workflow: unknown
  scriptSections: Array<{ id: string; title: string; body: string }> | null
  sceneNotes: Record<string, string>
  validation: { valid: boolean; errors: string[]; warnings: string[] } | null
  stage: string
}

// ------------------------------------------------------------- M3: producer

export interface TtsVoice {
  shortName: string
  gender: string
  locale: string
  name: string
}

export interface TtsGenerateResult {
  /** "edge" (neural, word timings) or "sapi" (offline fallback, no timings). */
  engine: 'edge' | 'sapi' | string
  voice: string
  rate: string
  /** Project-relative WAV path (48 kHz stereo). */
  wav: string
  /** Project-relative words JSON path (null for the SAPI fallback). */
  wordsPath: string | null
  wordsCount: number
  durationS: number
  cacheKey: string
  cached: boolean
  bytes: number
}

export interface WordTiming {
  word: string
  startS: number
  durS: number
}

export interface SrtValidation {
  cueCount: number
  maxCps: number
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface ProducerActivity {
  type: 'phase' | 'tool_result' | 'message' | 'error' | 'gate' | 'done'
  tool?: string
  summary?: string
  at: string
}

export interface ProduceRunResult {
  status: 'done' | 'paused_at_gate'
  pausedAtGate?: 'G-D' | 'G-E' | 'G-F' | string
  gateSummary?: string
  summary: string
  master?: string
  picture?: string
  srt?: string
  zip?: string
  qcPassed?: boolean
  retentionVerdict?: string
}

// ---- Showrunner autopilot (M6): one idea → film ---------------------------

export interface ShowrunnerMakeInput {
  /** The user's idea — becomes the project title and the research brief. */
  idea: string
  minutes?: number
  fps?: number
  /** Route make on an EXISTING project (chat plain-text) instead of creating one. */
  projectId?: string
}

export interface ShowrunnerMakeResult {
  project: ProjectRecord
  jobId: string
}

export interface ShowrunnerRefineInput {
  projectId: string
  /** The user's revision note, handed to the Director verbatim. */
  notes: string
}

/** Visual QC finding, renderer-side view of qc/visual_report.json (M7, DATA-SCHEMA §7.1). */
export interface VisualQcFindingView {
  id: string
  class: string
  severity: 'info' | 'warn' | 'fail'
  t_s: number
  to_s?: number
  evidence: string
  suggestion?: string
  scene_id?: string
}

export interface DeliveryBundle {
  stage: string
  master: { path: string; abs: string; bytes: number } | null
  picture: { path: string; abs: string; bytes: number } | null
  pictureDraft: { path: string; abs: string; bytes: number } | null
  /** Quality the current picture master was rendered at. */
  pictureQuality: string | null
  thumbnails: string[]
  srt: { path: string; bytes: number } | null
  zip: { path: string; bytes: number; sha256: string | null } | null
  youtubeKit: string | null
  qcReport: { passed: boolean; errors: string[]; durationSeconds?: number | null } | null
  retentionReport: {
    verdict: string
    dead_zones: Array<{ from_s: number; to_s: number; reason?: string }>
    cut_cadence?: { mean_shot_s: number; variance: number; target_variance_max: number; within_target: boolean }
    cps?: { max: number; limit: number }
    loudness?: { target: number; before: number | null; after: number | null; conformed: boolean }
    suggestion?: { kind: string; how: string; problems: string[] } | null
    lufs: number | null
  } | null
  /** Visual QC report (M7) — null when the phase hasn't run or is disabled. */
  visualReport: {
    verdict: 'pass' | 'warn' | 'fail' | string
    findings: VisualQcFindingView[]
    coverage?: { frames_sampled?: number; detectors?: string[]; vision?: boolean }
    notes?: string[]
  } | null
  pendingGate: { job: JobRecord; gate: string; summary: string } | null
}

/** agent_runs audit row (DATA-SCHEMA §8). */
export interface AgentRunRow {
  id: string
  projectId: string | null
  agent: string
  stage: string | null
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  costEst: number | null
  status: string
  startedAt: string | null
  endedAt: string | null
}

/** studio/style.json (DATA-SCHEMA §6) — visual tokens, authored by the
 *  Director's style_write tool and overridable by the user (Style panel). */
export interface ProjectStyle {
  /** Switch the preset family before token overrides apply (DATA-SCHEMA §6). */
  preset?: string
  accent?: string
  caption_style?: 'kinetic' | 'boxed' | 'off' | string
  vignette?: boolean
  grain?: boolean
  /** The film's default transition pair for scenes that author none (visual direction pass). */
  transition_set?: string
  /** One-line visual identity note authored with the look. */
  look?: string
}
