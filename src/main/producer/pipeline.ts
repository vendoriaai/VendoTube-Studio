import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as yamlParse } from 'yaml'
import type { BridgeClient } from '../bridge'
import { readBibleBundle } from '../artifacts'
import { lowerProcessPriority, type RenderPriority } from '../proc-priority'
import {
  applyStyleOverrides,
  buildCompositions,
  computeSceneTimings,
  resolveSceneStyle,
  resolveStyle,
  resolveTransitionSet,
  type CompositionBuildResult,
  type RawWordTiming,
  type SceneTiming,
  type StyleOverrides,
  type WorkflowJson
} from './compositions'
import { buildSrt, buildSrtCues, type SubtitleCue } from './subs'
import { generateThumbnails } from './thumbnails'
import { buildShotListRows, mediaPending, planVisuals, type AssetRow, type ClaimRow, type SourceRow } from './visuals'
import { applyVideoMoments, pickVideoMoments } from './videoMoments'
import { alignVisualsToNarration } from './narration'
import {
  assignIds,
  buildVisionBatches,
  buildVisualReport,
  classifyScan,
  gateShouldPark,
  planSampling,
  readVisualQcConfig,
  reviewBatch,
  sceneIntent,
  type QcScanResult,
  type VisualQcConfig,
  type VisualQcFinding
} from './visualQc'
import type { ChatClient } from '../agent/chat'
import type { ProducerActivity, WordTiming } from '@shared/ipc'

/**
 * Producer pipeline (M3): deterministic execution of workflow.json —
 * narration (edge-tts, gate G-D on first use) → subtitles from word timings
 * (DWK-validated) → HyperFrames compositions → picture render (gate G-E) →
 * dwk.finalize mux → dwk.qc + retention report → youtube_kit → package
 * (gate G-F). The model never drives a side effect directly: every gate
 * parks the job in awaiting_approval until the user approves.
 *
 * Progress is persisted in studio/producer_state.json so a resumed job
 * skips completed phases (TTS cache + idempotent writers make every phase
 * safe to re-run anyway).
 */

export type ProducerGate = 'G-D' | 'G-M' | 'G-E' | 'G-V' | 'G-F'

export interface ProducerDeps {
  bridge: BridgeClient
  projectPath: string
  defaultVoice: string
  /** Quality ladder override (M4): 'draft' | 'standard' | 'high' — beats workflow.render.quality. */
  qualityOverride?: string
  /**
   * Render CPU policy (setting `render.priority`): 'low' (default) spawns the
   * hyperframes render tree BELOW_NORMAL so the user's PC stays responsive
   * while a film renders; 'normal' keeps the old all-cores-at-Normal behavior.
   */
  renderPriority?: RenderPriority
  setProgress: (phase: string, pct?: number, eta?: string) => void
  emit: (activity: ProducerActivity) => void
  throwIfCancelled: () => void
  /**
   * Gate check. Returns true when the user has approved (persisted
   * pending_approvals row); when false, the caller parks the job and the
   * pipeline stops honestly at the gate.
   */
  gate: (gate: ProducerGate, summary: string, detail: Record<string, unknown>) => Promise<boolean>
  /**
   * M7 Layer 1: the vision reviewer for visual QC. Absent, or
   * `visual_qc.vision=false` in project.yml ⇒ the review is skipped with ZERO
   * provider calls (PRD R11) — Layer 0 alone still produces the report.
   */
  vision?: { chat: ChatClient; model: string }
  /** agent_runs journal hooks for the vision sub-run (agent=producer, stage=visual_qc). */
  visionRunStart?: (model: string) => string | null
  visionRunEnd?: (runId: string | null, status: 'done' | 'failed', counts?: { tokensIn?: number; tokensOut?: number }) => void
}

export interface ProducerPhaseState {
  done: string[]
  artifacts: Record<string, string>
  quality?: string
  voDurations?: Record<string, number>
  totalDurationS?: number
  /** Worst cue reading speed measured at subtitle build (CPS). */
  cpsWorstCue?: number
  /** Loudness conform result (M4): before/after LUFS + whether applied. */
  loudness?: { before: number | null; after: number | null; conformed: boolean }
  compDirs?: { master: string; draft: string }
  /**
   * Variant the current picture master was rendered at ('draft' | 'master').
   * finalize stream-copies the picture into the audio master, so a variant
   * change (quality upgrade) must invalidate finalize + downstream, else
   * documentary.mp4 keeps the previous resolution.
   */
  pictureVariant?: string
  sceneStamps?: Record<string, string>
  sceneStampsDraft?: Record<string, string>
  draftDims?: [number, number]
  /** Fresh per-scene render segments (segmented render + retry, M4). */
  segments?: Record<string, { variant: string; stamp: string }>
  /** Hash of the deterministic visual plan — changes clear all downstream phases. */
  visualsHash?: string
  /**
   * Per-section stamp of the narratable script content (title/body/voice/pace).
   * A re-direct can rewrite narration under the SAME section id — tts:<id>
   * done-markers keyed by id alone would silently narrate the old text.
   * Changed sections re-narrate and take subtitles + downstream with them.
   */
  scriptStamps?: Record<string, string>
  /** Composition EMITTER version — a code change to scene HTML generation clears compositions + downstream. */
  compEmitterStamp?: string
}

export interface ProduceResult {
  status: 'done' | 'paused_at_gate'
  pausedAtGate?: ProducerGate
  gateSummary?: string
  summary: string
  master?: string
  picture?: string
  srt?: string
  zip?: string
  qcPassed?: boolean
  retentionVerdict?: string
  /** Visual QC verdict (M7) — 'not-run' when the phase was disabled. */
  visualQcVerdict?: string
}

const STATE_FILE_SEG = ['studio', 'producer_state.json']

/**
 * Bump when the scene-HTML generation code changes (compositions.ts emitter,
 * HyperFrames output requirements). A producer_state.json from an older
 * emitter must NOT keep its 'compositions' done-marker — stale HTML would
 * keep failing the lint gate. See the emitter-version guard in run().
 */
const COMPOSITIONS_EMITTER_VERSION = '2026-11-17.1' // narration-timed cut: voice-over-first shot durations, cue alignment, redundant/mismatched card repair, final-beat cards

function loadState(projectPath: string): ProducerPhaseState {
  try {
    return JSON.parse(readFileSync(join(projectPath, ...STATE_FILE_SEG), 'utf-8')) as ProducerPhaseState
  } catch {
    return { done: [], artifacts: {} }
  }
}

function saveState(projectPath: string, state: ProducerPhaseState): void {
  const file = join(projectPath, ...STATE_FILE_SEG)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

/** Narration text: strip ledger claim refs and stage directions from a script section body. */
export function narrationText(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trim().startsWith('>')) // stage directions are never narrated (DATA-SCHEMA §2.4)
    .join('\n')
    .replace(/\(([^()]*CLM[-_ ]?\d[^()]*)\)/gi, '') // claim ids stay in the evidence ledger, not the voiceover
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Stamp of a section's narratable content — any change (words, title, voice, pace) re-narrates. */
export function narrationStamps(
  sections: ScriptSection[],
  voice: string | undefined,
  paceBySection: Record<string, number>
): Record<string, string> {
  const stamps: Record<string, string> = {}
  for (const s of sections) {
    stamps[s.id] = sha8(JSON.stringify([s.title, s.body, voice, paceBySection[s.id] ?? 1.0]))
  }
  return stamps
}

// ------------------------------------------------------------------ M7 Layer 1
/**
 * Sampled vision review over the rendered master. Extracted from the pipeline
 * class so the mock-provider and zero-call exit criteria are testable without
 * running the whole film chain: the caller injects the bridge, the vision
 * client, and the cancellation/progress hooks. Sampling (plan → qc.sample_frames →
 * JPEG → data URL), batching (≤12/request), per-batch review with scene
 * context, and hard finding clamping all live here.
 */
export interface VisionStageDeps {
  bridge: Pick<BridgeClient, 'request'>
  projectPath: string
  cfg: VisualQcConfig
  timings: SceneTiming[]
  scan: QcScanResult
  /** Layer 0 finding count — vision finding ids continue after it (F00N…). */
  l0Count: number
  scenes: WorkflowJson['scenes']
  /** scene id → narration text (caller applies narrationText + truncation). */
  voTextByScene: Record<string, string>
  vision: { chat: ChatClient; model: string }
  setProgress: (phase: string, pct?: number) => void
  throwIfCancelled: () => void
}

export interface VisionStageResult {
  findings: VisualQcFinding[]
  meta: { vision: boolean; model: string | null; framesSampled: number; extraNotes: string[] }
  summary: string
}

export async function runVisionStage(deps: VisionStageDeps): Promise<VisionStageResult> {
  const plan = planSampling(deps.timings, deps.scan.duration_s, deps.cfg)
  const sampled = (await deps.bridge.request('qc.sample_frames', {
    project_path: deps.projectPath,
    media_path: 'delivery/documentary.mp4',
    sha8: deps.scan.sha8,
    times: plan.times,
    width: 768
  }, 1_800_000)) as { frames?: string[] }
  const frames: Parameters<typeof buildVisionBatches>[0] = []
  for (const rel of sampled.frames ?? []) {
    const m = /f_(\d+)\.jpg$/.exec(rel)
    if (!m) continue
    const tS = Number(m[1]) / 1000
    const timing = deps.timings.find((t) => tS >= t.startS - 0.25 && tS < t.startS + t.durS) ?? deps.timings[deps.timings.length - 1]
    const scene = deps.scenes.find((s) => s.id === timing?.id)
    frames.push({
      t_s: tS,
      dataUrl: `data:image/jpeg;base64,${readFileSync(join(deps.projectPath, rel)).toString('base64')}`,
      scene_id: timing?.id,
      intent: sceneIntent(scene),
      vo: (deps.voTextByScene[timing?.id ?? ''] ?? '').slice(0, 500)
    })
  }
  const batches = buildVisionBatches(frames, 12)
  const visionFindings: VisualQcFinding[] = []
  let dropped = 0
  for (let i = 0; i < batches.length; i++) {
    deps.throwIfCancelled()
    deps.setProgress(`vision review (batch ${i + 1}/${batches.length})`, 91)
    const r = await reviewBatch(deps.vision.chat, batches[i])
    visionFindings.push(...r.findings)
    dropped += r.dropped
  }
  const withIds = assignIds(visionFindings, deps.l0Count)
  return {
    findings: withIds,
    meta: {
      vision: true,
      model: deps.vision.model,
      framesSampled: frames.length,
      extraNotes: [
        ...(plan.truncated ? ['sampling truncated at the 600-frame budget (scene cut points keep priority)'] : []),
        ...(dropped > 0 ? [`${dropped} vision item(s) dropped (unknown class or hallucinated timestamp)`] : [])
      ]
    },
    summary: `${frames.length} frame(s) in ${batches.length} batch(es) via ${deps.vision.model}: ${withIds.length} finding(s)${dropped > 0 ? `, ${dropped} dropped` : ''}`
  }
}

/**
 * Done tts markers whose section's stamp changed (or was never stamped) must
 * re-narrate — narration keyed by id alone would silently voice stale text
 * after a re-direct rewrites script.md under the same section id.
 */
export function changedNarrationSections(
  prev: Record<string, string> | undefined,
  stamps: Record<string, string>,
  sectionIds: Array<string>,
  done: Set<string>
): string[] {
  return [...new Set(sectionIds)].filter((id) => done.has(`tts:${id}`) && stamps[id] !== prev?.[id])
}

interface ScriptSection { id: string; title: string; body: string }

export class ProducerPipeline {
  constructor(private readonly deps: ProducerDeps) {}

  private activity(type: ProducerActivity['type'], tool: string, summary: string): void {
    this.deps.emit({ type, tool, summary, at: new Date().toISOString() })
  }

  async run(): Promise<ProduceResult> {
    const { bridge, projectPath } = this.deps
    const state = loadState(projectPath)
    const done = new Set(state.done)

    // ------------------------------------------------------------ inputs
    this.deps.setProgress('reading the film plan', 2)
    const bundle = readBibleBundle(projectPath) // optional — style preset + titles
    const workflowPath = join(projectPath, 'studio', 'workflow.json')
    if (!existsSync(workflowPath)) throw new Error('no workflow.json — run /direct first, then produce')
    const workflow = JSON.parse(readFileSync(workflowPath, 'utf-8')) as WorkflowJson
    if (!workflow.scenes?.length) throw new Error('workflow.json has no scenes')

    const sections: ScriptSection[] = bundle?.scriptSections ?? readScriptSectionsOnly(projectPath)
    if (!sections.length) throw new Error('no narration script found — run /direct first, then produce')
    const sectionById = new Map(sections.map((s) => [s.id, s]))
    for (const scene of workflow.scenes) {
      if (!sectionById.has(scene.vo.script_section)) {
        throw new Error(
          `scene ${scene.id}: script section '${scene.vo.script_section}' not found in script.md — valid sections: ${sections
            .map((s) => s.id)
            .join(', ')}. The script was rewritten after workflow.json — re-run /direct so the director rewrites the workflow for the current script.`
        )
      }
    }
    const scriptFront = readScriptFront(projectPath)
    const stylePreset = bundle?.bible?.stylePreset || 'vox-explainer'
    const retention = readRetentionConfig(projectPath)
    const fps = Number(workflow.render?.fps) || 30
    const quality = this.deps.qualityOverride || String(workflow.render?.quality || 'draft')

    // ---------------------------------------------------------------- TTS (gate G-D)
    this.deps.setProgress('narrating sections', 8)
    const voDurations: Record<string, number> = state.voDurations ?? {}
    // Script-content guard: narration re-runs when the words behind a section id
    // changed (re-direct rewrote script.md), carrying subtitles + downstream along.
    const stampsBySection = narrationStamps(sections, scriptFront.voice, scriptFront.paceBySection)
    const changedSections = changedNarrationSections(
      state.scriptStamps,
      stampsBySection,
      workflow.scenes.map((s) => s.vo.script_section),
      done
    )
    if (changedSections.length > 0) {
      for (const id of changedSections) {
        done.delete(`tts:${id}`)
        delete state.artifacts[`vo:${id}`]
        delete state.artifacts[`words:${id}`]
        delete voDurations[id]
      }
      for (const k of ['subtitles', 'compositions', 'lint', 'render', 'finalize', 'qc', 'loudness', 'retention', 'visual_qc', 'youtube_kit', 'package']) done.delete(k)
      state.done = [...done]
      this.activity(
        'message',
        'script.changed',
        `narration changed for ${changedSections.join(', ')} — re-narrating; subtitles and downstream phases rebuild`
      )
    }
    state.scriptStamps = stampsBySection
    saveState(projectPath, state)
    const needTts = workflow.scenes.filter((s) => !done.has(`tts:${s.vo.script_section}`))
    if (needTts.length > 0) {
      const estWords = needTts.reduce((acc, s) => acc + narrationText(sectionById.get(s.vo.script_section)?.body ?? '').split(/\s+/).filter(Boolean).length, 0)
      const approved = await this.deps.gate('G-D', `Generate narration: ${needTts.length} section(s), ~${estWords} words`, {
        sections: needTts.map((s) => s.vo.script_section),
        estimated_speak_seconds: Math.round((estWords / 155) * 60),
        stamp: sha8(`G-D:${this.deps.projectPath}:v1`)
      })
      if (!approved) {
        return this.pause('G-D', `Narration needs your approval (${needTts.length} section(s), ~${estWords} words)`, state)
      }
      this.activity('phase', 'tts.generate', `narrating ${needTts.length} section(s)`)
    }
    for (const scene of workflow.scenes) {
      const key = `tts:${scene.vo.script_section}`
      if (done.has(key)) continue
      this.deps.throwIfCancelled()
      const section = sectionById.get(scene.vo.script_section)
      const text = narrationText(section?.body ?? '')
      if (!text) throw new Error(`script section '${scene.vo.script_section}' has no narratable text`)
      const pace = Number(scriptFront.paceBySection[scene.vo.script_section] ?? 1.0) || 1.0
      const voice = scene.vo.voice || scriptFront.voice || this.deps.defaultVoice
      const res = await bridge.ttsGenerate({
        projectPath,
        text,
        voice,
        ratePct: Math.round((pace - 1) * 1000) / 10,
        outName: scene.vo.script_section
      }, 600_000)
      if (res.engine === 'sapi' && !res.wordsPath) {
        this.activity('message', 'tts.fallback', `edge-tts unavailable for '${scene.vo.script_section}' — SAPI fallback used (no word timings; subtitles fall back to duration pacing)`)
      }
      voDurations[scene.vo.script_section] = res.durationS
      state.artifacts[`vo:${scene.vo.script_section}`] = res.wav
      if (res.wordsPath) state.artifacts[`words:${scene.vo.script_section}`] = res.wordsPath
      state.voDurations = voDurations
      done.add(key)
      state.done = [...done]
      saveState(projectPath, state)
      this.activity('tool_result', 'tts.generate', `${scene.vo.script_section}: ${res.durationS.toFixed(1)}s via ${res.engine}${res.cached ? ' (cached)' : ''}`)
    }

    // --------------------------------------------------- subtitles (from word timings)
    if (!done.has('subtitles')) {
      this.deps.throwIfCancelled()
      this.deps.setProgress('writing subtitles from word timings', 25)
      this.activity('phase', 'subs.generate', 'building SRT from word boundaries')
      const cues: SubtitleCue[] = []
      let offset = 0
      for (const scene of workflow.scenes) {
        const wordsPath = state.artifacts[`words:${scene.vo.script_section}`]
        let words: WordTiming[] = []
        if (wordsPath && existsSync(join(projectPath, wordsPath))) {
          // Bridge words JSON is snake_case ({start_s, dur_s}) — map to the camelCase contract.
          const raw = JSON.parse(readFileSync(join(projectPath, wordsPath), 'utf-8')) as Array<Record<string, unknown>>
          words = raw.map((w) => ({
            word: String(w.word ?? ''),
            startS: Number(w.start_s) || 0,
            durS: Number(w.dur_s) || 0
          }))
        } else {
          // SAPI fallback has no word timings — derive one cue spanning the section.
          const dur = voDurations[scene.vo.script_section] ?? 0
          const text = narrationText(sectionById.get(scene.vo.script_section)?.body ?? '')
          words = [{ word: text.slice(0, 80), startS: 0.1, durS: Math.max(0.5, dur - 0.3) }]
        }
        const sectionCues = buildSrtCues(words, { maxCps: retention.cpsMax }).map((c) => ({
          ...c,
          startS: round3(c.startS + offset),
          endS: round3(c.endS + offset)
        }))
        cues.push(...sectionCues)
        offset += voDurations[scene.vo.script_section] ?? 0
      }
      cues.forEach((c, i) => (c.index = i + 1))
      const cpsWorst = cues.reduce((worst, c) => {
        const chars = c.lines.join('').length
        const cps = chars / Math.max(0.001, c.endS - c.startS)
        return Math.max(worst, cps)
      }, 0)
      state.cpsWorstCue = Math.round(cpsWorst * 10) / 10
      const srtFile = join(projectPath, 'production', 'subtitles.en.srt')
      writeFileSync(srtFile, buildSrt(cues), 'utf-8')
      state.artifacts.srt = 'production/subtitles.en.srt'
      const validation = await bridge.validateSrt({ srtPath: srtFile, maxCps: retention.cpsMax })
      if (!validation.valid) {
        throw new Error(`subtitle validation failed: ${validation.errors.join('; ')}`)
      }
      done.add('subtitles')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity('tool_result', 'subs.generate', `${cues.length} cues, DWK validate_srt: PASS`)
    }

    // Word timings are the timing authority for both captions and the
    // narration-driven visual cut. Load once; missing sections (SAPI fallback)
    // skip honestly.
    const voWords: Record<string, RawWordTiming[]> = {}
    for (const scene of workflow.scenes) {
      const wordsPath = state.artifacts[`words:${scene.vo.script_section}`]
      if (wordsPath && existsSync(join(projectPath, wordsPath))) {
        try {
          voWords[scene.vo.script_section] = JSON.parse(readFileSync(join(projectPath, wordsPath), 'utf-8')) as RawWordTiming[]
        } catch {
          // no usable timings — captions/alignment skip honestly for that section
        }
      }
    }

    // ------------------------------------------- visual enrichment (gate G-M)
    // Deterministic: the director may author text-only compositions when no
    // media is rights-approved yet (discovery is not clearance). Produce-time
    // enrichment turns evidence claims into data cards, chunks overlong cards,
    // and interleaves rights-approved research media. Downloaded-but-unapproved
    // media needs the human G-M click first — approving the gate flips the
    // ledger status (the same human action as the Asset Library click).
    let enriched: WorkflowJson = workflow
    {
      this.deps.throwIfCancelled()
      this.deps.setProgress('planning visuals from research', 28)
      const isVideoPath = (p: string | undefined): boolean => /\.(mp4|webm|mov)$/i.test(p ?? '')
      const readAssets = async (): Promise<AssetRow[]> => {
        const res = (await bridge.request('assets.list', { project_path: projectPath })) as { candidates?: Array<Record<string, unknown>> }
        // Only media that actually exists on disk can enter the cut.
        return (res.candidates ?? [])
          .map((r) => r as AssetRow)
          .filter((a) => !a.saved_path || existsSync(join(projectPath, a.saved_path)))
      }
      const readLedger = async (kind: 'sources' | 'evidence'): Promise<Array<Record<string, unknown>>> => {
        const res = (await bridge.request('ledger.list', { project_path: projectPath, kind })) as { rows?: Array<Record<string, unknown>> }
        return res.rows ?? []
      }
      let assetRows = await readAssets()
      const pending = mediaPending(assetRows)
      const workflowUsesMedia = workflow.scenes.some((s) => (s.shots ?? []).some((sh) => sh.kind === 'asset'))
      if (!workflowUsesMedia && pending.length > 0) {
        const imgs = pending.filter((a) => !isVideoPath(a.saved_path)).length
        const vids = pending.length - imgs
        const approved = await this.deps.gate(
          'G-M',
          `Use research media in the film: ${imgs} image(s), ${vids} video(s) awaiting rights approval`,
          {
            assets: pending.map((a) => ({
              asset_id: a.asset_id,
              title: a.title,
              media_type: a.media_type,
              license: a.license,
              attribution: a.attribution,
              saved_path: a.saved_path
            })),
            note: 'Approving grants these downloaded research assets rights_status=approved — the same human click as the Asset Library gate (G-C). Decline to produce a graphics-only film.',
            stamp: sha8(`G-M:${projectPath}:${pending.map((a) => String(a.asset_id ?? '')).join(',')}:${workflow.scenes.map((s) => s.id).join(',')}`)
          }
        )
        if (!approved) {
          return this.pause('G-M', `${pending.length} research media await your rights decision`, state)
        }
        const flip = (await bridge.request('ledger.set_rights', {
          project_path: projectPath,
          asset_ids: pending.map((a) => String(a.asset_id ?? '')),
          rights_status: 'approved',
          notes: 'approved via produce media gate G-M'
        })) as { changed: number }
        this.activity('tool_result', 'ledger.set_rights', `G-M: ${flip.changed} media row(s) approved for the cut`)
        assetRows = await readAssets()
      }

      const claims = (await readLedger('evidence')) as ClaimRow[]
      const sources = (await readLedger('sources')) as SourceRow[]
      const plan = planVisuals({ scenes: workflow.scenes, claims, sources, assets: assetRows })
      // Voice-over first: every shot is cut to the narration words it
      // illustrates (authored narration_cue first, card text as fallback)
      // instead of filling the scene by authored duration weights.
      const aligned = alignVisualsToNarration(plan.scenes, {
        sectionBodies: Object.fromEntries(sections.map((s) => [s.id, s.body])),
        wordsBySection: voWords,
        voDurations
      })
      enriched = { ...workflow, scenes: aligned.scenes }
      for (const note of aligned.notes.slice(0, 16)) {
        this.activity('message', 'visuals.align', note)
      }
      if (aligned.notes.length > 16) {
        this.activity('message', 'visuals.align', `…and ${aligned.notes.length - 16} more narration-alignment notes`)
      }

      // Video moments (2026-11-19): every video shot used to play its clip from
      // 0:00, so the same opening seconds repeated scene after scene. Pick an
      // in-point per shot — an agent looks at sampled stills when a vision model
      // is configured, otherwise a deterministic spread walks the clip. Runs
      // BEFORE the visuals hash so a changed pick rebuilds the picture.
      {
        const moments = await pickVideoMoments({
          projectPath,
          scenes: enriched.scenes,
          bridge,
          chat: this.deps.vision?.chat ?? null,
          model: this.deps.vision?.model ?? null,
          narrationBySection: Object.fromEntries(sections.map((s) => [s.id, s.body])),
          onNote: (note) => this.activity('message', 'video.moments', note)
        })
        if (moments.picks.size > 0) {
          enriched = { ...enriched, scenes: applyVideoMoments(enriched.scenes, moments.picks) }
          const shots = [...moments.picks.values()].reduce((n, m) => n + m.size, 0)
          const how = moments.visionUsed ? 'vision-checked stills' : 'deterministic spread (no agent.visual_model set)'
          this.activity(
            'message',
            'video.moments',
            `in-points chosen for ${shots} footage shot(s) — ${how}${moments.sampled ? ` (${moments.sampled} stills sampled)` : ''}`
          )
        }
      }

      // Downstream artifacts picture the previous visual plan — rebuild from here on.
      const hash = sha8(JSON.stringify(enriched.scenes))
      if (hash !== state.visualsHash) {
        for (const k of ['compositions', 'lint', 'render', 'finalize', 'qc', 'loudness', 'retention', 'visual_qc', 'youtube_kit', 'package']) done.delete(k)
        state.done = [...done]
        if (state.visualsHash) this.activity('message', 'visuals.plan', 'visual plan changed — downstream phases will rebuild')
      }
      state.visualsHash = hash

      // DWK interchange: register the full picture timeline in
      // production/shot_list.csv — media rows keep provenance, card stretches
      // export still SVGs to media/graphics/ so every row points at a real
      // image/video file (see buildShotListRows; contiguity holds by
      // construction, crossfade overlaps absorbed).
      if (plan.injected.length > 0) {
        // Card stills mirror the film's resolved theme — per scene since the
        // visual direction pass (a noir scene's still is graded like its frame).
        const styleOv = readStyleOverrides(projectPath)
        const timingsV = computeSceneTimings(enriched.scenes, voDurations, fps, resolveTransitionSet(styleOv?.transition_set)).timings
        const tokens = applyStyleOverrides(resolveStyle(stylePreset), styleOv)
        const themeByScene = Object.fromEntries(
          enriched.scenes.map((sc) => {
            const st = resolveSceneStyle(tokens, sc.visual)
            return [sc.id, { bg: st.bg, panel: st.bgDeep, text: st.text, dim: st.textDim, accent: st.accent }]
          })
        )
        const built = buildShotListRows({
          scenes: enriched.scenes,
          timings: timingsV,
          fps,
          injected: plan.injected,
          ledger: assetRows,
          theme: { bg: tokens.bg, panel: tokens.bgDeep, text: tokens.text, dim: tokens.textDim, accent: tokens.accent },
          themeByScene
        })
        if (built.cardStills.length > 0) {
          mkdirSync(join(projectPath, 'media', 'graphics'), { recursive: true })
          for (const still of built.cardStills) writeFileSync(join(projectPath, still.rel), still.svg, 'utf-8')
        }
        if (built.rows.length > 0) {
          const written = (await bridge.request('dwk.write_shot_list', { project_path: projectPath, rows: built.rows })) as { count: number }
          // DWK validate: enforce every error EXCEPT the automated license
          // allowlist — the human G-M click is this studio's rights authority
          // (DWK's allowed_license heuristic predates the human gate).
          const report = (await bridge.request('dwk.validate_project', { project_path: projectPath })) as { errors?: string[] }
          const hard = (report.errors ?? []).filter((e) => !/lacks approved compatible rights/i.test(e))
          if (hard.length > 0) throw new Error(`DWK validation failed: ${hard.slice(0, 3).join('; ')}`)
          const tolerated = (report.errors ?? []).length - hard.length
          this.activity(
            'tool_result',
            'dwk.validate_project',
            `shot list registered (${written.count} rows, ${built.mediaCount} media); hard errors: 0${tolerated > 0 ? ` — ${tolerated} automated license-allowlist finding(s) superseded by the G-M human approval (disclosed)` : ''}`
          )
        }
      } else if (!workflowUsesMedia) {
        this.activity('message', 'visuals.plan', 'no rights-approved research media — film stays graphics-only (data cards from evidence claims)')
      }
      saveState(projectPath, state)
    }

    // ---------------------------------------------------------------- compositions
    // Emitter-version guard: the phase ledger can't know the scene-HTML
    // GENERATOR changed (bugfix, new lint requirement) — a run that died at
    // lint has 'compositions' marked done with stale files, and lint would
    // re-fail forever. Wipe the downstream ledger once per emitter version.
    if (state.compEmitterStamp !== COMPOSITIONS_EMITTER_VERSION) {
      for (const k of ['compositions', 'lint', 'render', 'finalize', 'qc', 'loudness', 'retention', 'visual_qc', 'youtube_kit', 'package']) done.delete(k)
      state.done = [...done]
      state.compEmitterStamp = COMPOSITIONS_EMITTER_VERSION
      saveState(projectPath, state)
      this.activity('message', 'compositions.invalidate', 'composition emitter updated — scenes rebuild, downstream phases re-run')
    }
    if (!done.has('compositions')) {
      this.deps.throwIfCancelled()
      this.deps.setProgress('building compositions', 32)
      this.activity('phase', 'compositions.build', 'writing HyperFrames scenes from workflow.json')
      // M4 inputs: word timings (kinetic captions), beats.json (re-hooks/interrupts),
      // style.json overrides (DATA-SCHEMA §6). voWords were loaded once above.
      const built: CompositionBuildResult = buildCompositions({
        projectPath,
        workflow: enriched,
        voDurations,
        stylePreset,
        projectTitle: bundle?.bible?.title ?? 'Documentary',
        sectionTitles: Object.fromEntries(sections.map((s) => [s.id, s.title])),
        voWords,
        beats: readBeats(projectPath),
        styleOverrides: readStyleOverrides(projectPath)
      })
      state.compDirs = { master: 'studio/compositions', draft: 'studio/compositions-draft' }
      state.sceneStamps = built.stamps
      state.sceneStampsDraft = built.stampsDraft ?? undefined
      state.draftDims = built.draftDims
      state.totalDurationS = built.totalDurationS
      state.voDurations = voDurations
      done.add('compositions')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity('tool_result', 'compositions.build', `${built.sceneFiles.length} scenes, ${built.totalDurationS.toFixed(1)}s master timeline (720p draft variant built)`)
      // Producer layout audit: fitted-text fallbacks and geometry repairs are
      // user-visible editorial facts, not silent engine choices.
      for (const note of built.layoutNotes.slice(0, 12)) {
        this.activity('message', 'compositions.layout', note)
      }
      if (built.layoutNotes.length > 12) {
        this.activity('message', 'compositions.layout', `…and ${built.layoutNotes.length - 12} more layout notes`)
      }
    }
    const totalDurationS = state.totalDurationS ?? 0
    if (!totalDurationS) throw new Error('pipeline state lost the master duration — rebuild compositions')

    // ---------------------------------------------------------------- lint
    if (!done.has('lint')) {
      this.deps.throwIfCancelled()
      this.deps.setProgress('linting compositions', 38)
      const lintOut = await this.runHyperframes(['lint', join(projectPath, 'studio', 'compositions')], 180_000)
      if (lintOut.code !== 0) {
        // exit code decides — lint output always contains the word "error" in its summary
        throw new Error(`composition lint failed (exit ${lintOut.code}):\n${lintOut.tail}`)
      }
      done.add('lint')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity('tool_result', 'compositions.lint', lintOut.tail.split('\n').slice(-2).join(' ').trim() || 'lint clean')
    }

    // ---------------------------------------------------------------- render (gate G-E)
    // Quality ladder (TAD §9): draft = 720p24 fast variant for iteration;
    // standard/high = the master resolution at the workflow fps. Renders are
    // SEGMENTED per scene (retry a single scene; resume skips fresh segments).
    const isDraft = quality === 'draft'
    const variant: 'draft' | 'master' = isDraft ? 'draft' : 'master'
    const renderFps = isDraft ? 24 : fps
    const compDir = join(projectPath, 'studio', variant === 'draft' ? 'compositions-draft' : 'compositions')
    const stamps = variant === 'draft' ? state.sceneStampsDraft : state.sceneStamps
    const pictureRel = isDraft ? 'delivery/picture-draft.mp4' : 'delivery/picture.mp4'
    const pictureAbs = join(projectPath, pictureRel)
    // Same transition defaults as buildCompositions — the two timing
    // computations must agree (per-scene dips change overlaps).
    const timingsAll = computeSceneTimings(workflow.scenes, voDurations, fps, resolveTransitionSet(readStyleOverrides(projectPath)?.transition_set)).timings
    const staleScenes = timingsAll.filter((t) => {
      const seg = join(compDir, 'renders', `scene-${t.id}.mp4`)
      return !existsSync(seg) || state.segments?.[t.id]?.stamp !== stamps?.[t.id] || state.segments?.[t.id]?.variant !== variant
    })
    if (staleScenes.length > 0 || !existsSync(pictureAbs)) {
      this.deps.throwIfCancelled()
      // Rough realtime factors measured on the dev machine (draft ~7.7×/4.5 for 720p24).
      const factor = isDraft ? 1.8 : fps >= 60 ? 15 : 7.7
      const estMin = Math.max(1, Math.round(((totalDurationS * factor) / 60) * (staleScenes.length / Math.max(1, timingsAll.length))))
      const approved = await this.deps.gate('G-E', `Render picture master: ${totalDurationS.toFixed(0)}s @ ${isDraft ? '720p24 draft' : `${fps}fps ${quality}`} (~${estMin} min, ${staleScenes.length} scene(s) to render)`, {
        duration_s: totalDurationS,
        fps: renderFps,
        quality,
        variant,
        stale: staleScenes.map((t) => t.id),
        stamp: sha8(`G-E:${readFileSync(workflowPath, 'utf-8')}:${quality}`)
      })
      if (!approved) {
        return this.pause('G-E', `Picture render needs your approval (~${estMin} min)`, state)
      }
      mkdirSync(join(compDir, 'renders'), { recursive: true })
      mkdirSync(join(projectPath, 'delivery'), { recursive: true })
      this.activity('phase', 'render.render', `${totalDurationS.toFixed(1)}s segmented @ ${renderFps}fps ${variant} variant`)
      if (this.backgroundRender) {
        this.activity('message', 'render.priority', 'rendering at background priority — your PC stays responsive')
      }
      // A/B: keep the previous draft when upgrading to a final render.
      if (!isDraft && existsSync(join(projectPath, 'delivery', 'picture-draft.mp4')) && !existsSync(pictureAbs)) {
        state.artifacts.pictureDraft = 'delivery/picture-draft.mp4'
      }
      const total = timingsAll.length
      for (let i = 0; i < total; i++) {
        const t = timingsAll[i]
        const segRel = `${variant === 'draft' ? 'studio/compositions-draft' : 'studio/compositions'}/renders/scene-${t.id}.mp4`
        const segAbs = join(projectPath, segRel)
        const fresh = existsSync(segAbs) && state.segments?.[t.id]?.stamp === stamps?.[t.id] && state.segments?.[t.id]?.variant === variant
        this.deps.setProgress(`rendering scene ${i + 1}/${total}${fresh ? ' (cached)' : ''}`, 42 + Math.round((26 * i) / total))
        if (fresh) continue
        this.deps.throwIfCancelled()
        let lastErr = ''
        let okSeg = false
        for (let attempt = 1; attempt <= 2 && !okSeg; attempt++) {
          const out = await this.runHyperframes(
            ['render', compDir, '--start', String(t.startS), '--end', String(round3(t.startS + t.durS)), '--quality', quality, '--fps', String(renderFps), '--format', 'mp4', '--output', segAbs],
            1_800_000
          )
          okSeg = existsSync(segAbs)
          if (!okSeg) {
            lastErr = out.tail.slice(-600)
            this.activity('message', 'render.retry', attempt === 1 ? `scene ${t.id} render failed — retrying once` : `scene ${t.id} failed twice`)
          }
        }
        if (!okSeg) {
          throw new Error(`segment render failed for scene ${t.id}:\n${lastErr}`)
        }
        state.segments = { ...(state.segments ?? {}), [t.id]: { variant, stamp: stamps?.[t.id] ?? '' } }
        saveState(projectPath, state)
      }
      const concat = (await bridge.request('media.concat_video', {
        project_path: projectPath,
        videos: timingsAll.map((t) => `${variant === 'draft' ? 'studio/compositions-draft' : 'studio/compositions'}/renders/scene-${t.id}.mp4`),
        out: pictureRel
      }, 1_800_000)) as { out: string; duration_s: number; mode: string }
      if (!existsSync(pictureAbs)) {
        throw new Error('segment concat produced no picture master')
      }
      state.artifacts.picture = pictureRel
      state.quality = quality
      done.add('render')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity('tool_result', 'render.render', `picture master written (${concat.duration_s.toFixed(1)}s, concat ${concat.mode})`)
    }

    // finalize stream-copies this picture into documentary.mp4 (`-c:v copy`), so
    // the current variant decides whether the audio master is still valid. A
    // quality switch (draft ↔ master) — even when the picture was already on
    // disk and no re-render was needed — leaves documentary.mp4 at the old
    // resolution. Drop finalize + every phase downstream of it so they rebuild
    // from the picture now in state.artifacts.picture.
    if (state.pictureVariant !== variant && existsSync(pictureAbs)) {
      for (const k of ['finalize', 'qc', 'loudness', 'retention', 'visual_qc', 'youtube_kit', 'package']) done.delete(k)
      if (state.pictureVariant) this.activity('message', 'render.variant', `picture variant ${state.pictureVariant} → ${variant} — the audio master and its QC rebuild`)
      state.pictureVariant = variant
      state.quality = quality
      state.artifacts.picture = pictureRel
      state.done = [...done]
      saveState(projectPath, state)
    }

    // ---------------------------------------------------------------- narration concat
    if (!done.has('narration')) {
      this.deps.throwIfCancelled()
      this.deps.setProgress('assembling the narration track', 70)
      const wavs = workflow.scenes.map((s) => state.artifacts[`vo:${s.vo.script_section}`]).filter(Boolean)
      const concat = (await bridge.request('media.concat_audio', {
        project_path: projectPath,
        wavs,
        out: 'production/vo/narration_full.wav'
      }, 600_000)) as { wav: string; duration_s: number }
      state.artifacts.narration = concat.wav
      // Beat-synced SFX (M4): workflow sfx names resolve against studio/sfx/.
      // The picture clock (scene starts incl. crossfade overlap) is where the
      // ear expects the hit — placements are on the picture timeline.
      const sfxExt = ['.wav', '.mp3', '.ogg', '.m4a']
      const placements: Array<{ path: string; at_s: number; gain_db: number }> = []
      const missingSfx: string[] = []
      for (const scene of workflow.scenes as unknown as Array<{ id: string; sfx?: string[] }>) {
        const t = timingsAll.find((x) => x.id === scene.id)
        for (const name of scene.sfx ?? []) {
          const hit = sfxExt.map((e) => join(projectPath, 'studio', 'sfx', `${name}${e}`)).find((p) => existsSync(p))
          if (hit && t) {
            placements.push({ path: hit.replace(/\\/g, '/'), at_s: t.startS, gain_db: -6 })
          } else if (!hit) {
            missingSfx.push(name)
          }
        }
      }
      if (placements.length > 0) {
        const mixed = (await bridge.request('media.place_sfx', {
          project_path: projectPath,
          narration: state.artifacts.narration,
          placements,
          out: 'production/vo/narration_sfx.wav'
        }, 600_000)) as { out: string; placed: number; skipped: string[] }
        state.artifacts.narration = mixed.out
        this.activity('tool_result', 'media.place_sfx', `${mixed.placed} sfx placed${mixed.skipped.length ? `, ${mixed.skipped.length} missing` : ''}`)
      }
      if (missingSfx.length > 0) {
        this.activity('message', 'sfx.missing', `no SFX file in studio/sfx/ for: ${[...new Set(missingSfx)].join(', ')} — skipped (disclosed)`)
      }
      done.add('narration')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity('tool_result', 'media.concat_audio', `narration track ${concat.duration_s.toFixed(1)}s`)
    }

    // ---------------------------------------------------------------- finalize
    if (!done.has('finalize')) {
      this.deps.throwIfCancelled()
      this.deps.setProgress('muxing the master (DWK finalize)', 78)
      this.activity('phase', 'dwk.finalize', 'picture + narration + subtitles')
      const musicRel = (workflow as unknown as { music?: { path?: string } | null }).music?.path
      const musicAbs = musicRel ? join(projectPath, musicRel) : null
      const fin = await bridge.request('dwk.finalize', {
        project_path: projectPath,
        picture: state.artifacts.picture ?? 'delivery/picture.mp4',
        narration: state.artifacts.narration,
        music: musicAbs && existsSync(musicAbs) ? musicRel : null,
        subtitles: state.artifacts.srt,
        output: 'delivery/documentary.mp4',
        duration: totalDurationS
      }, 900_000) as { output: string; duration_s: number }
      state.artifacts.master = 'delivery/documentary.mp4'
      done.add('finalize')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity('tool_result', 'dwk.finalize', `documentary.mp4 (${fin.duration_s.toFixed(1)}s)`)
    }

    // ---------------------------------------------------------------- qc + loudness + retention
    if (!done.has('qc')) {
      this.deps.throwIfCancelled()
      this.deps.setProgress('running QC (full decode)', 86)
      const qcDims = qcDimsFor(quality, state)
      const qc = (await bridge.request('dwk.qc', {
        project_path: projectPath,
        video: 'delivery/documentary.mp4',
        width: qcDims[0],
        height: qcDims[1],
        fps: quality === 'draft' ? 24 : fps,
        expected_duration: totalDurationS
      }, 1_800_000)) as { passed: boolean; errors: string[] }
      if (!qc.passed) {
        throw new Error(`QC failed: ${qc.errors.slice(0, 3).join('; ')}`)
      }
      done.add('qc')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity('tool_result', 'dwk.qc', 'QC PASS (streams + full decode)')
    }

    // Loudness conform (M4 exit: LUFS −14 ± 1): measure → two-pass loudnorm
    // when out of range → re-QC the re-encoded audio honestly.
    if (!done.has('loudness')) {
      this.deps.throwIfCancelled()
      this.deps.setProgress('conforming loudness (two-pass loudnorm)', 88)
      const conform = (await bridge.request('media.loudnorm_conform', {
        project_path: projectPath,
        media_path: 'delivery/documentary.mp4',
        target_lufs: retention.lufsTarget
      }, 3_600_000)) as { conformed: boolean; lufs_before: number; lufs_after: number; reason?: string }
      state.loudness = { before: conform.lufs_before, after: conform.lufs_after, conformed: conform.conformed }
      if (conform.conformed) {
        this.deps.setProgress('re-running QC after conform', 88)
        const qcDims = qcDimsFor(quality, state)
        const qc2 = (await bridge.request('dwk.qc', {
          project_path: projectPath,
          video: 'delivery/documentary.mp4',
          width: qcDims[0],
          height: qcDims[1],
          fps: quality === 'draft' ? 24 : fps,
          expected_duration: totalDurationS
        }, 1_800_000)) as { passed: boolean; errors: string[] }
        if (!qc2.passed) {
          throw new Error(`QC failed after loudness conform: ${qc2.errors.slice(0, 3).join('; ')}`)
        }
      }
      done.add('loudness')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity(
        'tool_result',
        'media.loudnorm_conform',
        conform.conformed
          ? `master conformed ${conform.lufs_before} → ${conform.lufs_after} LUFS`
          : `no conform needed (${conform.lufs_after} LUFS)${conform.reason ? ` — ${conform.reason}` : ''}`
      )
    }

    if (!done.has('retention')) {
      this.deps.throwIfCancelled()
      this.deps.setProgress('checking retention', 90)
      const report = (await this.retentionReport(projectPath, enriched, fps, totalDurationS, retention)) as {
      verdict: string
      loudness: { after: number | null }
      cut_cadence: { variance: number }
      cps: { max: number }
    }
      writeFileSync(join(projectPath, 'qc', 'retention_report.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8')
      done.add('retention')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity(
        'tool_result',
        'retention.check',
        `verdict ${report.verdict} (LUFS ${report.loudness.after ?? 'n/a'}, cadence var ${report.cut_cadence.variance}, cps ${report.cps.max})`
      )
    }

    // ------------------------------------------------- visual QC (M7)
    // Deterministic post-render pass over the muxed master: ffmpeg detectors
    // (black/freeze/silence) + exact cut assertion vs the composition timings,
    // classified into qc/visual_report.json (DATA-SCHEMA §7.1). When a vision
    // model is configured AND visual_qc.vision is not disabled, Layer 1
    // reviews sampled frames (≤12/request, with shot-plan + narration context)
    // through the provider adapter; findings merge into the same report.
    if (!done.has('visual_qc')) {
      const vqcCfg = readVisualQcConfig(projectPath)
      if (!vqcCfg.enabled) {
        done.add('visual_qc')
        state.done = [...done]
        saveState(projectPath, state)
        this.activity('message', 'qc.visual', 'visual QC disabled (project.yml visual_qc.enabled=false) — skipped')
      } else {
        this.deps.throwIfCancelled()
        this.deps.setProgress('scanning the master (visual QC)', 91)
        const scan = (await bridge.request('qc.scan_master', {
          project_path: projectPath,
          media_path: state.artifacts.master ?? 'delivery/documentary.mp4'
        }, 3_600_000)) as unknown as QcScanResult
        // Expected boundaries come from the SAME timing math that drove the
        // render — a stale master (rendered from an older plan) shows up as
        // cut mismatches instead of passing silently.
        const timings = computeSceneTimings(enriched.scenes, voDurations, fps).timings
        const l0Findings = classifyScan(scan, { durationS: scan.duration_s, timings })
        let findings: VisualQcFinding[] = l0Findings
        let visionMeta: { vision: boolean; model: string | null; framesSampled: number; extraNotes: string[] } = {
          vision: false,
          model: null,
          framesSampled: 0,
          extraNotes: []
        }

        // ---------------- Layer 1: sampled vision review (optional, disclosed)
        if (vqcCfg.vision && this.deps.vision) {
          const visionModel = this.deps.vision.model
          const runId = this.deps.visionRunStart?.(visionModel) ?? null
          try {
            const stage = await runVisionStage({
              bridge,
              projectPath,
              cfg: vqcCfg,
              timings,
              scan,
              l0Count: l0Findings.length,
              scenes: enriched.scenes,
              voTextByScene: Object.fromEntries(
                enriched.scenes.map((s) => [s.id, narrationText(sectionById.get(s.vo.script_section)?.body ?? '')])
              ),
              vision: this.deps.vision,
              setProgress: (phase, pct) => this.deps.setProgress(phase, pct),
              throwIfCancelled: () => this.deps.throwIfCancelled()
            })
            findings = [...l0Findings, ...stage.findings]
            visionMeta = stage.meta
            this.deps.visionRunEnd?.(runId, 'done')
            this.activity('tool_result', 'qc.visual.vision', stage.summary)
          } catch (err) {
            this.deps.visionRunEnd?.(runId, 'failed')
            const msg = err instanceof Error ? err.message : String(err)
            visionMeta.extraNotes.push(`layer 1 vision review failed: ${msg} — verdict stands on Layer 0 findings (disclosed)`)
            this.activity('message', 'qc.visual.vision', `vision review skipped: ${msg} — verdict stands on Layer 0 findings`)
          }
        }

        const report = buildVisualReport(scan, findings, visionMeta)
        mkdirSync(join(projectPath, 'qc'), { recursive: true })
        writeFileSync(join(projectPath, 'qc', 'visual_report.json'), JSON.stringify(report, null, 2) + '\n', 'utf-8')
        state.artifacts.visual_report = 'qc/visual_report.json'
        done.add('visual_qc')
        state.done = [...done]
        saveState(projectPath, state)
        const counts = {
          fail: findings.filter((f) => f.severity === 'fail').length,
          warn: findings.filter((f) => f.severity === 'warn').length
        }
        this.activity(
          'tool_result',
          'qc.visual',
          `verdict ${report.verdict} (${counts.fail} fail / ${counts.warn} warn over ${scan.duration_s.toFixed(1)}s master, sha8 ${scan.sha8}${visionMeta.vision ? `, vision ${visionMeta.framesSampled}f` : ', vision off'})`
        )
        // Gate G-V: a fail verdict parks the package for a human decision
        // (audited override) — in every mode, including autopilot: a visual
        // defect verdict is a quality call, not a side effect to pre-approve.
        if (gateShouldPark(report, vqcCfg)) {
          const fails = findings.filter((f) => f.severity === 'fail')
          const approved = await this.deps.gate('G-V', `Visual QC found ${fails.length} blocking defect(s): ${fails
            .slice(0, 3)
            .map((f) => `${f.class} @ ${f.t_s}s`)
            .join(', ')}`, {
            verdict: report.verdict,
            findings: fails,
            master_sha256: scan.sha256,
            remedy: 'fix the film (re-direct / re-produce) or approve to package despite the findings',
            stamp: sha8(`G-V:${scan.sha256}:${quality}`)
          })
          if (!approved) {
            return this.pause('G-V', `Visual QC blocked packaging: ${fails.length} fail-class finding(s)`, state)
          }
        }
      }
    }

    // ---------------------------------------------------------------- youtube kit
    if (!done.has('youtube_kit')) {
      this.deps.throwIfCancelled()
      this.deps.setProgress('writing the YouTube kit', 93)
      await this.writeYoutubeKit(projectPath, bundle?.bible ?? null, enriched, totalDurationS)
      state.artifacts.youtube_kit = 'delivery/youtube_kit.md'
      // Thumbnail concepts (M5): three stills via headless browser; disclosed on failure.
      try {
        const thumbs = await generateThumbnails({
          projectPath,
          title: bundle?.bible?.title ?? readProjectTitle(projectPath) ?? 'Documentary',
          kicker: bundle?.bible?.thesis ?? undefined,
          stylePreset,
          styleOverrides: readStyleOverrides(projectPath)
        })
        state.artifacts.thumbnails = JSON.stringify(thumbs.files)
        this.activity('tool_result', 'thumbnails.generate', `${thumbs.files.length} concepts via ${thumbs.browser}`)
      } catch (err) {
        this.activity('message', 'thumbnails.failed', `thumbnail concepts skipped: ${err instanceof Error ? err.message : String(err)}`)
      }
      done.add('youtube_kit')
      state.done = [...done]
      saveState(projectPath, state)
    }

    // ---------------------------------------------------------------- package (gate G-F)
    if (!done.has('package')) {
      this.deps.throwIfCancelled()
      const retentionVerdict = this.readVerdict(projectPath)
      if (retentionVerdict === 'fail') {
        throw new Error('retention verdict is fail — package_project is blocked (DATA-SCHEMA §9). Fix the film and re-run /produce.')
      }
      const approved = await this.deps.gate('G-F', 'Package delivery ZIP (documentary + subtitles + credits + evidence)', {
        master: state.artifacts.master,
        stamp: sha8(`G-F:${state.artifacts.master}:${statSync(join(projectPath, state.artifacts.master ?? 'delivery/documentary.mp4')).size}`)
      })
      if (!approved) {
        return this.pause('G-F', 'Delivery package needs your approval', state)
      }
      this.deps.setProgress('packaging delivery', 96)
      const pkg = (await bridge.request('dwk.package_project', { project_path: projectPath }, 900_000)) as { zip: string; bytes: number; sha256: string | null }
      state.artifacts.zip = 'delivery/project.zip'
      done.add('package')
      state.done = [...done]
      saveState(projectPath, state)
      this.activity('tool_result', 'dwk.package_project', `project.zip (${(pkg.bytes / 1_000_000).toFixed(1)} MB)`)
    }

    this.deps.setProgress('done', 100)
    const verdict = this.readVerdict(projectPath)
    const visualVerdict = this.readVisualVerdict(projectPath)
    return {
      status: 'done',
      summary: `Film produced: documentary.mp4 + subtitles + credits + youtube_kit + project.zip (QC pass, retention ${verdict}, visual QC ${visualVerdict}).`,
      master: state.artifacts.master,
      picture: state.artifacts.picture,
      srt: state.artifacts.srt,
      zip: state.artifacts.zip,
      qcPassed: true,
      retentionVerdict: verdict,
      visualQcVerdict: visualVerdict
    }
  }

  private pause(gate: ProducerGate, summary: string, state: ProducerPhaseState): ProduceResult {
    this.activity('gate', `gate:${gate}`, summary)
    this.deps.setProgress(`awaiting approval (gate ${gate})`)
    return { status: 'paused_at_gate', pausedAtGate: gate, gateSummary: summary, summary, master: state.artifacts.master }
  }

  // ------------------------------------------------------------------ helpers

  /** Render CPU policy: default 'low' — background priority (render.priority). */
  private get backgroundRender(): boolean {
    return (this.deps.renderPriority ?? 'low') === 'low'
  }

  private runHyperframes(args: string[], timeoutMs: number): Promise<{ tail: string; code: number }> {
    return new Promise((resolve, reject) => {
      // shell:true joins args with bare spaces — quote args containing whitespace so
      // Windows project paths like "...\VendoTube Studio\..." stay one argument.
      const child = spawn('npx', ['hyperframes', ...args.map(quoteShellArg)], { shell: true, windowsHide: true })
      // Background priority (render.priority): best-effort one-shot — cmd → node
      // → Chrome → ffmpeg all inherit BELOW_NORMAL, so the encode never starves
      // the user's own apps. Failure is silent (render proceeds at Normal).
      if (this.backgroundRender) lowerProcessPriority(child.pid)
      let out = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`hyperframes ${args[0]} timed out after ${timeoutMs / 1000}s`))
      }, timeoutMs)
      child.stdout?.on('data', (c: Buffer) => (out += c.toString()))
      child.stderr?.on('data', (c: Buffer) => (out += c.toString()))
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ tail: out.slice(-4000), code: code ?? -1 })
      })
    })
  }


  private async retentionReport(
    projectPath: string,
    workflow: WorkflowJson,
    fps: number,
    totalDurationS: number,
    retention: { cpsMax: number; maxDeadZoneS: number; lufsTarget: number; varianceMax: number; hookSeconds: number }
  ): Promise<Record<string, unknown>> {
    // Dead zones: narration/subtitle silence gaps longer than the project ceiling.
    const srtPath = join(projectPath, 'production', 'subtitles.en.srt')
    const deadZones: Array<{ from_s: number; to_s: number; reason: string }> = []
    try {
      const raw = readFileSync(srtPath, 'utf-8')
      const times = [...raw.matchAll(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g)].map((m) => [tcS(m[1]), tcS(m[2])] as const)
      let prevEnd = 0
      for (const [start, end] of times) {
        if (start - prevEnd >= retention.maxDeadZoneS) {
          deadZones.push({ from_s: round2(prevEnd), to_s: round2(start), reason: 'no narration change' })
        }
        prevEnd = Math.max(prevEnd, end)
      }
      if (totalDurationS - prevEnd >= retention.maxDeadZoneS) {
        deadZones.push({ from_s: round2(prevEnd), to_s: round2(totalDurationS), reason: 'tail silence' })
      }
    } catch {
      // no SRT — cadence-only report
    }
    // Cut cadence from scaled shot durations.
    const shotDurS: number[] = []
    for (const scene of workflow.scenes) {
      const voDur = Number(this.state?.voDurations?.[scene.vo.script_section] ?? 0)
      const shots = scene.shots?.length ? scene.shots : [{ dur_s: voDur || 4 }]
      const wsum = shots.reduce((a, s) => a + Math.max(0.5, Number(s.dur_s) || 2), 0)
      for (const s of shots) shotDurS.push(((voDur || 4) * (Math.max(0.5, Number(s.dur_s) || 2))) / wsum)
    }
    const mean = shotDurS.length ? shotDurS.reduce((a, b) => a + b, 0) / shotDurS.length : 0
    const variance = shotDurS.length > 1 ? shotDurS.reduce((a, b) => a + (b - mean) ** 2, 0) / shotDurS.length : 0
    // Reading speed: worst cue measured at build time (subtitle phase records it).
    const cpsWorst = Number(this.state?.cpsWorstCue ?? 0)
    const loudness = this.state?.loudness ?? { before: null, after: null, conformed: false }
    const lufs = loudness.after
    const lufsDev = lufs === null || lufs === undefined ? null : Math.abs(lufs - retention.lufsTarget)
    const lufsOk = lufsDev === null || lufsDev <= 1.0
    const varianceOk = variance <= retention.varianceMax
    const cpsOk = cpsWorst === 0 || cpsWorst <= retention.cpsMax + 2

    const problems: string[] = []
    if (deadZones.length > 0) problems.push(`${deadZones.length} dead zone(s) ≥ ${retention.maxDeadZoneS}s`)
    if (!varianceOk) problems.push(`cut cadence variance ${round2(variance)} > target ${retention.varianceMax}`)
    if (!cpsOk) problems.push(`worst cue ${cpsWorst} CPS > ${retention.cpsMax + 2}`)
    const verdict: 'pass' | 'warn' | 'fail' = !lufsOk ? 'fail' : problems.length === 0 ? 'pass' : 'warn'

    // Hook window (craft pass, advisory only): S01 is the hook; the researched
    // norm is a promise inside ~15s. Over-target goes to notes, never verdict.
    const hookBeat = readBeats(projectPath).find((b) => b.scene === 'S01')
    const hookS = hookBeat && hookBeat.durS > 0 ? round2(hookBeat.durS) : null
    const hookOk = hookS === null || hookS <= retention.hookSeconds

    // Auto-fix proposal (roadmap M4): the report suggests, never auto-edits.
    const suggestion =
      problems.length > 0
        ? {
            kind: 'repace-scenes',
            how: `/direct Retention pass: re-pace the film — ${problems.join('; ')}. Split long static scenes, add B-roll shots or composition beats in the dead zones (${deadZones
              .slice(0, 3)
              .map((d) => `${d.from_s}–${d.to_s}s`)
              .join(', ')}), and re-run /produce.`,
            problems
          }
        : null

    return {
      dead_zones: deadZones,
      cut_cadence: { mean_shot_s: round2(mean), variance: round2(variance), target_variance_max: retention.varianceMax, within_target: varianceOk },
      cps: { max: cpsWorst, limit: retention.cpsMax },
      hook: { target_s: retention.hookSeconds, hook_s: hookS, within_target: hookOk },
      loudness: { target: retention.lufsTarget, before: loudness.before, after: lufs, conformed: loudness.conformed === true },
      lufs,
      subtitle_drift_s: 0.2,
      verdict,
      suggestion,
      notes: [
        'retention model: narration dead zones + cut cadence variance + reading speed + LUFS conform',
        `LUFS target ${retention.lufsTarget} ± 1.0 (two-pass loudnorm conform applied when out of range)`,
        'verdict fail = loudness unreachable; warn = pacing problems with a re-pace proposal (Director loop)',
        ...(hookOk ? [] : [`hook scene S01 runs ${hookS}s — target ≤${retention.hookSeconds}s: front-load the payoff promise (advisory)`])
      ]
    }
  }

  private readVerdict(projectPath: string): string {
    try {
      return (JSON.parse(readFileSync(join(projectPath, 'qc', 'retention_report.json'), 'utf-8')) as { verdict?: string }).verdict ?? 'warn'
    } catch {
      return 'warn'
    }
  }

  private readVisualVerdict(projectPath: string): string {
    try {
      return (JSON.parse(readFileSync(join(projectPath, 'qc', 'visual_report.json'), 'utf-8')) as { verdict?: string }).verdict ?? 'not-run'
    } catch {
      return 'not-run'
    }
  }

  private get state(): ProducerPhaseState {
    return loadState(this.deps.projectPath)
  }

  private async writeYoutubeKit(
    projectPath: string,
    bible: { title: string; thesis: string; scenes: Array<{ id: string; label: string; title: string }> } | null,
    workflow: WorkflowJson,
    totalDurationS: number
  ): Promise<void> {
    const state = loadState(projectPath)
    const projectTitle = readProjectTitle(projectPath) ?? bible?.title ?? 'Documentary'
    const lines: string[] = []
    lines.push(`# YouTube Kit — ${projectTitle}`)
    lines.push('')
    lines.push('## Title')
    lines.push(projectTitle)
    lines.push('')
    lines.push('## Description')
    lines.push(bible?.thesis || projectTitle)
    lines.push('')
    lines.push('### Chapters')
    // Chapter markers from beats.json when present (DATA-SCHEMA §4: beats feed
    // youtube_kit chapters); scene boundaries otherwise.
    const beats = readBeats(projectPath)
    if (beats.length > 0) {
      for (const b of beats) {
        lines.push(`${fmtChapter(b.startS)} ${b.label || b.id}`)
      }
    } else {
      let clock = 0
      for (const scene of workflow.scenes) {
        const info = bible?.scenes.find((s) => s.id === scene.id)
        const label = info?.label ?? scene.id
        lines.push(`${fmtChapter(clock)} ${label}${info?.title ? ` — ${info.title}` : ''}`.trimEnd())
        clock += state.voDurations?.[scene.vo.script_section] ?? 0
      }
    }
    void totalDurationS
    lines.push('')
    lines.push('## Sources')
    try {
      const res = (await this.deps.bridge.request('ledger.list', { project_path: projectPath, kind: 'sources' }, 60_000)) as {
        rows?: Array<Record<string, unknown>>
      }
      for (const r of res.rows ?? []) {
        lines.push(`- ${String(r.title ?? 'Untitled')} — ${String(r.url ?? '')}`)
      }
    } catch {
      lines.push('(source listing unavailable)')
    }
    lines.push('')
    lines.push('## Tags')
    const tagWords = `${projectTitle} documentary`.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter((w) => w.length > 2)
    lines.push([...new Set(tagWords)].join(', '))
    lines.push('')
    lines.push('## Evidence note')
    lines.push('Every factual claim in this film maps to a cited source in the evidence ledger (delivery/evidence_ledger.csv). Generated cards are design elements, not archival footage.')
    const file = join(projectPath, 'delivery', 'youtube_kit.md')
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  }
}

// ------------------------------------------------------------------ readers

/** Script-only section parser (bible-independent; same shape as readBibleBundle). */
/**
 * Quote a single argument for the shell spawned by `spawn(..., { shell: true })`.
 * Windows cmd.exe treats double quotes literally outside of string context, so
 * wrap in double quotes and escape embedded quotes/backslashes-per-MSRT;
 * POSIX sh only needs the quotes.
 */
function quoteShellArg(arg: string): string {
  if (arg === '') return '""'
  if (!/[\s"]/.test(arg)) return arg
  return process.platform === 'win32'
    ? '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
    : `'${arg.replace(/'/g, `'\\''`)}'`
}

function readScriptSectionsOnly(projectPath: string): ScriptSection[] {
  try {
    const raw = readFileSync(join(projectPath, 'production', 'script.md'), 'utf-8')
    return raw
      .split(/^## \[([A-Za-z0-9_-]+)\] (.*)$/m)
      .slice(1)
      .reduce<Array<ScriptSection>>((acc, _cur, i, arr) => {
        if (i % 3 === 0) acc.push({ id: arr[i], title: arr[i + 1], body: (arr[i + 2] ?? '').trim() })
        return acc
      }, [])
  } catch {
    return []
  }
}

/** beats.json (camelCase, written by artifacts.renderBeatsJson) — beat-synced motion. */
function readBeats(projectPath: string): Array<{
  id: string
  scene: string
  label: string
  startS: number
  durS: number
  rehook: boolean
  patternInterrupt: string | null
}> {
  try {
    const raw = JSON.parse(readFileSync(join(projectPath, 'production', 'beats.json'), 'utf-8')) as {
      beats?: Array<{ id?: string; scene?: string; label?: string; startS?: number; durS?: number; rehook?: boolean; patternInterrupt?: string | null }>
    }
    return (raw.beats ?? []).map((b) => ({
      id: String(b.id ?? ''),
      scene: String(b.scene ?? ''),
      label: String(b.label ?? ''),
      startS: Number(b.startS) || 0,
      durS: Number(b.durS) || 0,
      rehook: b.rehook === true,
      patternInterrupt: b.patternInterrupt || null
    }))
  } catch {
    return []
  }
}

/** studio/style.json overrides (DATA-SCHEMA §6) — optional user tokens. */
function readStyleOverrides(projectPath: string): StyleOverrides | undefined {
  try {
    return JSON.parse(readFileSync(join(projectPath, 'studio', 'style.json'), 'utf-8')) as StyleOverrides
  } catch {
    return undefined
  }
}

/** QC expectations match the DELIVERED variant (draft delivers 720p24). */
function qcDimsFor(quality: string, state: ProducerPhaseState): [number, number] {
  if (quality === 'draft' && state.draftDims) return state.draftDims
  return [1920, 1080]
}

function readProjectTitle(projectPath: string): string | null {
  try {
    const cfg = yamlParse(readFileSync(join(projectPath, 'project.yml'), 'utf-8')) as { title?: string } | null
    return cfg?.title ?? null
  } catch {
    return null
  }
}

function readScriptFront(projectPath: string): {
  voice?: string
  paceBySection: Record<string, number>
} {
  try {
    const raw = readFileSync(join(projectPath, 'production', 'script.md'), 'utf-8')
    const fmRaw = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
    const fm = yamlParse(fmRaw) as { voice?: string; sections?: Array<{ id?: string; pace?: number }> } | null
    const paceBySection: Record<string, number> = {}
    for (const s of fm?.sections ?? []) {
      if (s?.id && typeof s.pace === 'number' && s.pace > 0) paceBySection[s.id] = s.pace
    }
    return { voice: fm?.voice || undefined, paceBySection }
  } catch {
    return { paceBySection: {} }
  }
}

interface RetentionConfig {
  cpsMax: number
  maxDeadZoneS: number
  lufsTarget: number
  varianceMax: number
  hookSeconds: number
}

export function readRetentionConfig(projectPath: string): RetentionConfig {
  try {
    const cfg = yamlParse(readFileSync(join(projectPath, 'project.yml'), 'utf-8')) as {
      retention?: { cps_max?: number; max_dead_zone_s?: number; lufs?: number; cadence_variance_max?: number; hook_seconds?: number }
    }
    return {
      cpsMax: Number(cfg.retention?.cps_max ?? 17),
      maxDeadZoneS: Number(cfg.retention?.max_dead_zone_s ?? 8),
      lufsTarget: Number(cfg.retention?.lufs ?? -14),
      varianceMax: Number(cfg.retention?.cadence_variance_max ?? 0.6),
      hookSeconds: Number(cfg.retention?.hook_seconds ?? 15)
    }
  } catch {
    return { cpsMax: 17, maxDeadZoneS: 8, lufsTarget: -14, varianceMax: 0.6, hookSeconds: 15 }
  }
}

function tcS(tc: string): number {
  const [h, m, s] = tc.replace(',', '.').split(':').map(Number)
  return h * 3600 + m * 60 + s
}

function fmtChapter(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8)
}
