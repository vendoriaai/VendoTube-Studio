import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as yamlParse } from 'yaml'
import type { SceneTiming } from './compositions'
import type { ChatClient } from '../agent/chat'

/**
 * Visual QC Layer 0 (M7, PRD F15): classification of raw ffmpeg detector
 * output into findings with severities, plus the qc/visual_report.json
 * builder (DATA-SCHEMA §7.1). Pure functions — the pipeline feeds them the
 * bridge scan (bridge/qc_scan.py, local-only per PRD R11) and the composition
 * timings; a mock provider never enters this layer.
 *
 * Severity model (documented in DATA-SCHEMA §7.1 and the ROADMAP M7 exit):
 * - black_frame: skips < 0.5 s; inside the 4 s fade window (film start/end) →
 *   warn (fades are legitimate); interior ≥ 2 s → fail (dead picture), else warn.
 * - frozen_frame: skips < 2 s; ≥ 8 s → fail, else warn.
 * - silence_gap: skips the 0.5 s lead-in / 1.0 s tail; interior ≥ 6 s → fail
 *   (dead air), ≥ 2 s → warn, else skip.
 * - cut_mismatch: expected HARD-CUT boundaries (overlapInS === 0) must show a
 *   detected scene change within ±0.6 s; detected cuts near crossfade
 *   boundaries are expected (the fade midpoint scores as a change) and are
 *   suppressed; anything else is an unexpected cut → warn. The cut assertion
 *   never fails the film on its own — threshold-sensitive by nature — but the
 *   fixture film (all hard cuts) must detect an off-by-one exactly.
 */

export type VisualQcSeverity = 'info' | 'warn' | 'fail'

/**
 * Finding classes (DATA-SCHEMA §7.1): Layer 0 emits the deterministic four;
 * Layer 1 vision review emits the semantic five; `dead_air` is reserved for a
 * future cross-detector confirmation.
 */
export type VisualQcClass =
  | 'black_frame'
  | 'frozen_frame'
  | 'silence_gap'
  | 'cut_mismatch'
  | 'visual_mismatch'
  | 'subtitle_clip'
  | 'caption_missing'
  | 'wrong_asset'
  | 'render_artifact'
  | 'dead_air'

export interface VisualQcFinding {
  id: string
  class: VisualQcClass
  severity: VisualQcSeverity
  t_s: number
  to_s?: number
  evidence: string
  suggestion?: string
  scene_id?: string
}

/** Raw bridge scan payload (snake_case — the bridge contract edge). */
export interface QcScanResult {
  sha256: string
  sha8: string
  duration_s: number
  black: Array<{ from_s: number; to_s: number }>
  freeze: Array<{ from_s: number; to_s: number }>
  silence: Array<{ from_s: number; to_s: number }>
  cuts: number[]
  detectors: { black_min_s: number; freeze_min_s: number; silence_min_s: number; scene_thresh: number }
}

export interface VisualQcReport {
  version: 1
  master_sha256: string
  generated_at: string
  coverage: {
    frames_sampled: number
    detectors: string[]
    vision: boolean
    model: string | null
  }
  findings: VisualQcFinding[]
  verdict: 'pass' | 'warn' | 'fail'
  notes: string[]
}

export interface VisualQcConfig {
  enabled: boolean
  samplesPerSecond: number
  vision: boolean
  blockOnFail: boolean
}

export function readVisualQcConfig(projectPath: string): VisualQcConfig {
  try {
    const cfg = yamlParse(readFileSync(join(projectPath, 'project.yml'), 'utf-8')) as {
      visual_qc?: { enabled?: boolean; samples_per_second?: number; vision?: boolean; block_on_fail?: boolean }
    } | null
    return {
      enabled: cfg?.visual_qc?.enabled !== false,
      samplesPerSecond: Number(cfg?.visual_qc?.samples_per_second ?? 1) || 1,
      vision: cfg?.visual_qc?.vision !== false,
      blockOnFail: cfg?.visual_qc?.block_on_fail !== false,
    }
  } catch {
    return { enabled: true, samplesPerSecond: 1, vision: true, blockOnFail: true }
  }
}

export interface ScanContext {
  /** Measured master duration (bridge ground truth) — fade windows key off this. */
  durationS: number
  /** Master-timeline scene timings (same math that drove the render). */
  timings: SceneTiming[]
  /** Tolerance for matching detected cuts to expected boundaries (±s). */
  cutToleranceS?: number
}

/** Scene boundaries the composition plan asserts as hard cuts (overlap 0, not the opening). */
export function expectedHardCuts(timings: SceneTiming[]): Array<{ t_s: number; sceneId: string }> {
  return timings
    .filter((t) => t.startS > 0.001 && t.overlapInS === 0)
    .map((t) => ({ t_s: t.startS, sceneId: t.id }))
}

/** Crossfade boundaries — a scene change signal there is the fade itself, not a defect. */
export function softBoundaries(timings: SceneTiming[]): number[] {
  return timings.filter((t) => t.startS > 0.001 && t.overlapInS > 0).map((t) => t.startS)
}

function sceneAt(timings: SceneTiming[], tS: number): string | undefined {
  const hit = timings.find((t) => tS >= t.startS - 0.25 && tS < t.startS + t.durS)
  return hit?.id
}

const round2 = (n: number): number => Math.round(n * 100) / 100

export function classifyScan(scan: QcScanResult, ctx: ScanContext): VisualQcFinding[] {
  const findings: VisualQcFinding[] = []
  const durationS = ctx.durationS > 0 ? ctx.durationS : scan.duration_s
  const fadeWindowS = 4.0
  const inFadeWindow = (t: number): boolean => t <= fadeWindowS || t >= durationS - fadeWindowS

  const push = (f: Omit<VisualQcFinding, 'id'>): void => {
    findings.push({ ...f, id: `F${String(findings.length + 1).padStart(3, '0')}` })
  }

  // --- black_frame: dead picture. Fades at the film's edges are legitimate.
  for (const b of scan.black ?? []) {
    const d = b.to_s - b.from_s
    if (d < 0.5) continue
    const mid = (b.from_s + b.to_s) / 2
    const fade = inFadeWindow(mid)
    const severity: VisualQcSeverity = fade ? 'warn' : d >= 2.0 ? 'fail' : 'warn'
    push({
      class: 'black_frame',
      severity,
      t_s: round2(b.from_s),
      to_s: round2(b.to_s),
      scene_id: sceneAt(ctx.timings, mid),
      evidence: fade
        ? `black ${round2(d)}s inside the fade window (film edge) — likely an intentional fade`
        : `black picture for ${round2(d)}s mid-film`,
      suggestion: fade ? undefined : 'check the shot/assets in this range; re-render the scene if the source went dark',
    })
  }

  // --- frozen_frame: no picture change for the whole range.
  for (const f of scan.freeze ?? []) {
    const d = f.to_s - f.from_s
    if (d < 2.0) continue
    push({
      class: 'frozen_frame',
      severity: d >= 8.0 ? 'fail' : 'warn',
      t_s: round2(f.from_s),
      to_s: round2(f.to_s),
      scene_id: sceneAt(ctx.timings, (f.from_s + f.to_s) / 2),
      evidence: `static picture for ${round2(d)}s`,
      suggestion: 'a motion-graphics film should never hold one frame this long — check the scene’s shots/motion',
    })
  }

  // --- silence_gap: full dead air on the muxed master (music would cover it).
  for (const s of scan.silence ?? []) {
    const d = s.to_s - s.from_s
    if (s.to_s <= 0.5 || s.from_s >= durationS - 1.0) continue // lead-in / tail are normal
    if (d < 2.0) continue
    push({
      class: 'silence_gap',
      severity: d >= 6.0 ? 'fail' : 'warn',
      t_s: round2(s.from_s),
      to_s: round2(s.to_s),
      scene_id: sceneAt(ctx.timings, (s.from_s + s.to_s) / 2),
      evidence: `no audio at all for ${round2(d)}s (master mux)`,
      suggestion: 'check the narration/VO concat and SFX for this range — dead air loses viewers',
    })
  }

  // --- cut_mismatch: rendered cut times vs the composition plan. Each
  // expected hard cut pairs with its NEAREST detected cut (one anomaly = one
  // finding): drift within tolerance matches; a paired cut beyond tolerance
  // is a shifted cut; unpaired expected cuts are missing; unpaired detected
  // cuts are unexpected. Cuts near crossfade boundaries are the fade itself.
  const tol = ctx.cutToleranceS ?? 0.6
  const pairWindowS = Math.max(tol * 2.5, 1.5)
  const expected = expectedHardCuts(ctx.timings)
  const soft = softBoundaries(ctx.timings)
  const detected = [...(scan.cuts ?? [])].sort((a, b) => a - b)
  const pairedDetected = new Set<number>()

  for (const exp of expected) {
    let bestIdx = -1
    let bestDist = Infinity
    detected.forEach((c, i) => {
      if (pairedDetected.has(i)) return
      const d = Math.abs(c - exp.t_s)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    })
    if (bestIdx >= 0 && bestDist <= pairWindowS) {
      pairedDetected.add(bestIdx)
      if (bestDist > tol) {
        push({
          class: 'cut_mismatch',
          severity: 'warn',
          t_s: round2(detected[bestIdx]),
          scene_id: exp.sceneId,
          evidence: `cut into ${exp.sceneId} drifted: boundary at ${round2(exp.t_s)}s, master cut at ${round2(detected[bestIdx])}s (${round2(bestDist)}s off)`,
          suggestion: 're-run /produce so compositions and render rebuild from the current plan',
        })
      }
    } else {
      push({
        class: 'cut_mismatch',
        severity: 'warn',
        t_s: round2(exp.t_s),
        scene_id: exp.sceneId,
        evidence: `expected hard cut into ${exp.sceneId} at ${round2(exp.t_s)}s not detected in the master`,
        suggestion: 'the rendered master may be stale — re-run /produce to rebuild the picture',
      })
    }
  }
  detected.forEach((c, i) => {
    if (pairedDetected.has(i)) return
    if (soft.some((b) => Math.abs(b - c) <= 1.2)) return // crossfade midpoint reads as a scene change
    push({
      class: 'cut_mismatch',
      severity: 'warn',
      t_s: round2(c),
      scene_id: sceneAt(ctx.timings, c),
      evidence: `unexpected cut at ${round2(c)}s — the composition plan has no boundary near it`,
      suggestion: 're-run /produce so compositions and render rebuild from the current plan',
    })
  })

  return findings
}

export function buildVisualReport(
  scan: QcScanResult,
  findings: VisualQcFinding[],
  meta: { vision: boolean; model?: string | null; framesSampled?: number; extraNotes?: string[] }
): VisualQcReport {
  const hasFail = findings.some((f) => f.severity === 'fail')
  const hasWarn = findings.some((f) => f.severity === 'warn')
  return {
    version: 1,
    master_sha256: scan.sha256,
    generated_at: new Date().toISOString(),
    coverage: {
      frames_sampled: meta.framesSampled ?? 0,
      detectors: ['blackdetect', 'freezedetect', 'silencedetect', 'cut_assert'],
      vision: meta.vision,
      model: meta.model ?? null,
    },
    findings,
    verdict: hasFail ? 'fail' : hasWarn ? 'warn' : 'pass',
    notes: [
      'visual_qc layer 0: local ffmpeg detectors (blackdetect/freezedetect/silencedetect) + exact cut assertion vs composition timings',
      meta.vision
        ? `layer 1 vision review: ${meta.framesSampled ?? 0} sampled frame(s) reviewed by ${meta.model ?? 'model'} (≤12/request — frames sent to the configured provider, PRD R11)`
        : 'layer 1 vision review skipped (no provider call — PRD R11)',
      'fade-window black ranges (film edges) are advisory; interior ranges ≥ 2 s fail',
      ...(meta.extraNotes ?? [])
    ],
  }
}

/** G-V parks the package only on a fail verdict with blocking enabled. */
export function gateShouldPark(report: VisualQcReport, cfg: VisualQcConfig): boolean {
  return cfg.blockOnFail && report.verdict === 'fail'
}

// ------------------------------------------------------------------ Layer 1
// Sampled visual review (M7): ≤12 frames per request, each batch carrying the
// scene's shot plan + narration so the model judges semantics, not pixels in
// isolation. Everything is injected — the pipeline hands in a ChatClient and
// frame data URLs; tests hand in a mock, and `vision=false` never constructs
// the caller side at all (zero provider calls, PRD R11).

export const VISION_CLASSES = ['visual_mismatch', 'subtitle_clip', 'caption_missing', 'wrong_asset', 'render_artifact'] as const

/** Classes a vision model may raise to `fail` — the rest clamp to warn. */
const FAIL_CAPABLE = new Set(['visual_mismatch', 'wrong_asset', 'subtitle_clip'])

export interface SamplePlan {
  times: number[]
  truncated: boolean
}

/**
 * Sampling plan (DATA-SCHEMA §7.2): `samples_per_second` uniform grid +
 * every scene boundary + transition midpoints, deduped, capped at the 600
 * frame budget (cut points and midpoints keep priority; truncation disclosed).
 */
export function planSampling(timings: SceneTiming[], durationS: number, cfg: { samplesPerSecond: number }, budget = 600): SamplePlan {
  const key = (t: number): number => Math.round(t * 1000)
  const priority = new Map<number, number>()
  const add = (t: number): void => {
    const v = Math.round(Math.min(Math.max(t, 0.05), Math.max(0.05, durationS - 0.05)) * 1000) / 1000
    priority.set(key(v), v)
  }
  for (const t of timings) {
    if (t.startS > 0.001) add(t.startS)
    if (t.overlapInS > 0) add(t.startS + t.overlapInS / 2)
  }
  const sps = Math.max(0.25, Number(cfg.samplesPerSecond) || 1)
  const uniform: number[] = []
  for (let t = 0.1; t < durationS - 0.05; t += 1 / sps) uniform.push(Math.round(t * 1000) / 1000)
  const merged = new Map<number, number>(priority)
  for (const t of uniform) if (!merged.has(key(t))) merged.set(key(t), t)
  let times = [...merged.values()].sort((a, b) => a - b)
  if (times.length <= budget) return { times, truncated: false }
  const priorityVals = [...priority.values()].sort((a, b) => a - b)
  const rest = times.filter((t) => !priority.has(key(t)))
  const keepRest = Math.max(0, budget - priorityVals.length)
  const stride = Math.ceil(rest.length / Math.max(1, keepRest))
  times = [...priorityVals, ...rest.filter((_, i) => i % stride === 0)].sort((a, b) => a - b).slice(0, budget)
  return { times, truncated: true }
}

export interface SceneContext {
  /** One-line shot plan ("title card 'X'; ken burns aerial_mound.jpg"). */
  intent: string
  /** Narration spoken across the scene (truncated by the caller). */
  vo: string
}

/** One-line shot plan for the vision prompt ("card title-01 \"X\"; kenburns aerial.jpg"). */
export function sceneIntent(
  scene:
    | {
        shots?: Array<{
          kind?: string
          template?: string
          text?: string
          asset?: string
          motion?: string
        }>
      }
    | undefined
): string {
  const shots = scene?.shots ?? []
  const parts: string[] = []
  for (const s of shots.slice(0, 6)) {
    if (s.asset) {
      const base = s.asset.split(/[\\/]/).pop() ?? s.asset
      parts.push(`${s.motion || 'still'} ${base}`)
    } else if (s.template || s.text) {
      parts.push(`card ${s.template || 'custom'}${s.text ? ` "${s.text.slice(0, 60)}"` : ''}`)
    }
  }
  return parts.join('; ').slice(0, 300)
}

export interface VisionFrame {
  t_s: number
  /** data:image/jpeg;base64,… */
  dataUrl: string
  scene_id?: string
  intent: string
  vo: string
}

export interface VisionBatch {
  frames: VisionFrame[]
}

/** Contiguous batches of ≤ batchSize frames in master-clock order. */
export function buildVisionBatches(frames: VisionFrame[], batchSize = 12): VisionBatch[] {
  const batches: VisionBatch[] = []
  for (let i = 0; i < frames.length; i += batchSize) batches.push({ frames: frames.slice(i, i + batchSize) })
  return batches
}

function visionSystemPrompt(): string {
  return [
    'You are the visual QC pass of a rendered motion-graphics documentary. You see sampled frames from the final render, each labeled with its master-clock timestamp, plus the scene’s shot plan and the narration spoken at that moment.',
    'Report ONLY defects you can actually see in the frames, using exactly these classes:',
    '- visual_mismatch: the picture clearly contradicts the shot plan or the narration',
    '- subtitle_clip: caption text is cut off or overflows the frame’s safe area',
    '- caption_missing: narration is clearly mid-sentence yet no caption is shown (skip when unsure whether this film styles captions)',
    '- wrong_asset: the frame shows content unrelated to the shot plan (off-topic image/footage)',
    '- render_artifact: broken layout, torn borders, garbled glyphs, glitch blocks',
    'Rules: judge only what is visible; copy timestamps from the frame labels — never invent one; be conservative — a deliberate design choice is not a defect.',
    'Answer with ONLY a JSON array (no prose, no code fence): [{"class":"…","t_s":<frame timestamp>,"severity":"fail"|"warn","evidence":"…","suggestion":"…"}]. Use [] when the batch is clean.'
  ].join('\n')
}

function batchPrompt(batch: VisionBatch): string {
  const frameLines = batch.frames.map((f) => `- t=${f.t_s}s${f.scene_id ? ` (${f.scene_id})` : ''}`).join('\n')
  const scenes = new Map<string, VisionFrame>()
  for (const f of batch.frames) if (f.scene_id && !scenes.has(f.scene_id)) scenes.set(f.scene_id, f)
  const context = [...scenes.values()]
    .map((f) => `[${f.scene_id}] shot plan: ${f.intent || '(unspecified)'} — narration: "${(f.vo || '').slice(0, 500)}"`)
    .join('\n')
  return `Review ${batch.frames.length} frame(s), attached in the same order:\n${frameLines}\n\nScene context:\n${context || '(none)'}`
}

export interface VisionReviewResult {
  findings: VisualQcFinding[]
  batches: number
  dropped: number
}

/**
 * One provider call per batch. Findings are clamped hard: class must be from
 * the enumerated set, severity clamps (only the listed classes can fail),
 * t_s snaps to the labeled frame timestamp (beyond ±2 s ⇒ dropped as a
 * hallucination), evidence/suggestion are length-capped, ≤10 per batch.
 */
export async function reviewBatch(chat: ChatClient, batch: VisionBatch): Promise<VisionReviewResult> {
  const res = await chat.complete(
    [
      { role: 'system', content: visionSystemPrompt() },
      {
        role: 'user',
        content: batchPrompt(batch),
        images: batch.frames.map((f) => ({ type: 'image_url' as const, image_url: { url: f.dataUrl } }))
      }
    ],
    [],
    { temperature: 0.1 }
  )
  const raw = res.content ?? ''
  const arrMatch = raw.match(/\[[\s\S]*\]/)
  if (!arrMatch) throw new Error('vision review returned no JSON array')
  let parsed: unknown
  try {
    parsed = JSON.parse(arrMatch[0])
  } catch {
    throw new Error('vision review JSON did not parse')
  }
  if (!Array.isArray(parsed)) throw new Error('vision review JSON is not an array')
  const findings: VisualQcFinding[] = []
  let dropped = 0
  for (const item of parsed.slice(0, 10)) {
    if (typeof item !== 'object' || item === null) continue
    const e = item as Record<string, unknown>
    const cls = String(e.class ?? '')
    if (!VISION_CLASSES.includes(cls as (typeof VISION_CLASSES)[number])) {
      dropped++
      continue
    }
    const t = Number(e.t_s)
    const labeled = batch.frames.map((f) => f.t_s)
    if (labeled.length === 0 || !Number.isFinite(t)) {
      dropped++
      continue
    }
    const nearest = labeled.reduce((best, f) => (Math.abs(f - t) < Math.abs(best - t) ? f : best), labeled[0])
    if (Math.abs(nearest - t) > 2.0) {
      dropped++
      continue
    }
    const sevRaw = String(e.severity ?? 'warn')
    const severity: VisualQcSeverity = sevRaw === 'fail' && FAIL_CAPABLE.has(cls) ? 'fail' : 'warn'
    const evidence = String(e.evidence ?? '').slice(0, 300)
    findings.push({
      id: '',
      class: cls as VisualQcClass,
      severity,
      t_s: nearest,
      evidence: evidence || `${cls} reported at ${nearest}s`,
      suggestion: String(e.suggestion ?? '').slice(0, 200) || undefined,
      scene_id: batch.frames.find((f) => f.t_s === nearest)?.scene_id
    })
  }
  return { findings, batches: 1, dropped }
}

/** Sequential ids (F001…) continuing after the Layer 0 findings. */
export function assignIds(findings: VisualQcFinding[], startIndex: number): VisualQcFinding[] {
  return findings.map((f, i) => ({ ...f, id: `F${String(startIndex + i + 1).padStart(3, '0')}` }))
}
