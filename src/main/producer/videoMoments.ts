import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ChatClient } from '../agent/chat'
import type { BridgeClient } from '../bridge'
import type { CompositionScene } from './compositions'

/**
 * Pick which seconds of a source clip each shot shows (2026-11-19).
 *
 * Every video shot used to play its clip from 0:00 (`source_in` was never
 * set), so the same opening seconds repeated in scene after scene. This pass
 * chooses an in-point per video shot, in two tiers:
 *
 *   vision  — sample stills across the clip and ask the vision model which
 *             moments match the scene's narration (opt-in: `agent.visual_model`)
 *   spread  — deterministic: walk the clip so consecutive shots never show
 *             the same seconds. Always available, no provider calls.
 *
 * A vision failure degrades to `spread` rather than failing the run.
 */

/** Still candidates sampled per clip (frames sent to the model in one call). */
export const MOMENT_SAMPLE_COUNT = 12

/** Never in-point closer than this to either edge of a clip. */
const EDGE_MARGIN_S = 1.0

/** How far a model's answer may sit from a sampled frame before it is dropped. */
const SNAP_TOLERANCE_S = 2.0

const VIDEO_EXT = /\.(mp4|webm|mov)$/i

export interface VideoMoment {
  /** Scene the shot belongs to (for the activity feed). */
  sceneId: string
  shotIndex: number
  /** Project-relative clip path. */
  asset: string
  /** Chosen in-point in seconds. */
  startS: number
  /** Shot length in seconds (the played window). */
  windowS: number
  source: 'vision' | 'spread'
  /** One-line why, from the model (vision tier only). */
  reason?: string
}

export interface PickVideoMomentsInput {
  projectPath: string
  scenes: CompositionScene[]
  bridge: Pick<BridgeClient, 'request'>
  /** Vision model client; omit to run the deterministic tier only. */
  chat?: ChatClient | null
  model?: string | null
  /** Scene id → narration body (what the scene says out loud). */
  narrationBySection?: Record<string, string>
  onNote?: (note: string) => void
}

export interface PickVideoMomentsResult {
  /** sceneId → shotIndex → in-point seconds. */
  picks: Map<string, Map<number, VideoMoment>>
  sampled: number
  visionUsed: boolean
  notes: string[]
}

/** A shot that plays footage, with the window it needs. */
interface VideoTarget {
  sceneId: string
  sectionId: string
  shotIndex: number
  asset: string
  windowS: number
  narration: string
}

/** Seconds of a clip that can host a `windowS` shot. */
export function usableRange(durationS: number, windowS: number): { from: number; to: number } | null {
  if (!(durationS > 0) || !(windowS > 0)) return null
  // The shot must fit inside the clip at all.
  const latest = durationS - windowS
  if (latest <= 0) return { from: 0, to: 0 }
  // Keep the EDGE_MARGIN_S away from both ends (title cards / fades live there),
  // but never shrink a short clip's range to nothing: fall back to the whole
  // available span when the margins do not fit.
  const from = Math.min(EDGE_MARGIN_S, latest / 2)
  const to = Math.max(from, latest - EDGE_MARGIN_S)
  return { from, to }
}

/** Evenly spaced sample times across [from, to] (inclusive). */
export function sampleTimes(from: number, to: number, count: number): number[] {
  if (count <= 0) return []
  if (count === 1 || to <= from) return [round3(from)]
  const step = (to - from) / (count - 1)
  return Array.from({ length: count }, (_, i) => round3(from + i * step))
}

/**
 * Deterministic in-point for the nth video shot of a clip.
 *
 * Shots are walked across the usable range in order, so consecutive shots on
 * the same clip show different material. A LONE shot (the common case — one
 * clip used once) does NOT start at the clip's opening: the first seconds of
 * a documentary upload are its title card/logo, which is exactly what the
 * film used to show everywhere (2026-11-19). It starts `lane`…
 * `filmFraction` into the clip instead, derived from where the shot sits in
 * the film so the choice is still stable across runs.
 */
export function spreadStartS(
  index: number,
  count: number,
  durationS: number,
  windowS: number,
  filmFraction = 0
): number {
  const range = usableRange(durationS, windowS)
  if (!range) return 0
  const span = range.to - range.from
  if (span <= 0) return round3(range.from)
  const lanes = Math.max(1, count)
  const lane = Math.max(0, Math.min(lanes - 1, index))
  // Reserve the opening AND the tail: uploads open on a title card and close on
  // end cards/credits, so neither is body content (2026-11-19 verification on
  // the real film showed lane 0 parked on the intro and the last lane on the
  // outro).
  const body = { from: range.from + span * 0.08, to: range.to - span * 0.08 }
  const bodySpan = Math.max(0, body.to - body.from)
  const base =
    lanes === 1
      ? body.from + bodySpan * (0.15 + 0.7 * Math.min(1, Math.max(0, filmFraction)))
      : body.from + (bodySpan * lane) / (lanes - 1)
  // Wrapped passes (more shots than lanes) reuse the range but never the exact
  // frame: nudge by a third of a lane inside what the shot can still show.
  const wraps = Math.floor(lane / lanes)
  const nudge = wraps > 0 ? (bodySpan / lanes) * ((wraps % 3) / 3) : 0
  return round3(Math.min(range.to, base + nudge))
}

/** Snap a model answer to the nearest sampled timestamp, or null if too far. */
export function snapToSample(t: number, samples: number[]): number | null {
  if (!Number.isFinite(t) || samples.length === 0) return null
  let best: number | null = null
  let bestDist = Infinity
  for (const s of samples) {
    const d = Math.abs(s - t)
    if (d < bestDist) {
      bestDist = d
      best = s
    }
  }
  return best !== null && bestDist <= SNAP_TOLERANCE_S ? best : null
}

function momentSystemPrompt(): string {
  return [
    'You are the editor of an evidence-led documentary. You see stills sampled from ONE source clip, each labelled with its timestamp inside that clip, plus the narration of a single scene.',
    'Choose the moment whose footage best illustrates that narration: the frames should show what the scene is talking about (a person, a machine, an event, an era) rather than a title card, logo, black frame or talking-head filler — unless the narration is about that person talking.',
    'The chosen moment must be far enough from the end that the whole shot can play: stay at or before the LAST still.',
    'Rules: use a timestamp copied exactly from a still label — never invent one. Judge only what is visible.',
    'Answer with ONLY a JSON object (no prose, no code fence): {"t_s":<timestamp of the chosen still>,"reason":"<≤120 chars>"}'
  ].join('\n')
}

function momentPrompt(target: VideoTarget, times: number[], durationS: number): string {
  return [
    `Clip length: ${Math.round(durationS)}s. This shot plays ${Math.round(target.windowS)}s starting at the chosen moment.`,
    `Stills, in clip order: ${times.map((t) => `${formatClock(t)}`).join(', ')}`,
    `Scene narration: ${target.narration ? `"${target.narration.slice(0, 700)}"` : '(no narration text available)'}`,
    'Which single still is the right moment to start this shot?'
  ].join('\n')
}

/** Extract {t_s} from a model reply; tolerates prose or a code fence. */
export function parseMomentAnswer(reply: string): { t_s: number; reason?: string } | null {
  const text = String(reply ?? '')
  const obj = /\{[\s\S]*\}/.exec(text)
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0]) as { t_s?: unknown; reason?: unknown }
      const t = Number(parsed.t_s)
      if (Number.isFinite(t)) {
        return { t_s: t, reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 160) : undefined }
      }
    } catch {
      /* fall through to a bare-number reply */
    }
  }
  const num = /(\d{1,3}):(\d{2})(?:\.(\d+))?/.exec(text)
  if (num) return { t_s: Number(num[1]) * 60 + Number(num[2]) + Number(`0.${num[3] ?? 0}`) }
  const plain = /(\d+(?:\.\d+)?)/.exec(text)
  return plain ? { t_s: Number(plain[1]) } : null
}

/** Collect every shot that plays a video, in film order. */
export function videoTargets(scenes: CompositionScene[], fps: number, narrationBySection: Record<string, string> = {}): VideoTarget[] {
  const out: VideoTarget[] = []
  scenes.forEach((scene, sceneIdx) => {
    const sectionId = scene.vo?.script_section ?? scene.id
    const narration = narrationBySection[sectionId] ?? ''
    ;(scene.shots ?? []).forEach((shot, shotIndex) => {
      const windowS = Math.max(0.1, Number(shot.dur_s) || 3)
      if (shot.kind === 'asset' && shot.asset && VIDEO_EXT.test(shot.asset)) {
        out.push({ sceneId: scene.id, sectionId, shotIndex, asset: shot.asset, windowS, narration })
      }
      for (const panel of shot.panels ?? []) {
        if (panel.asset && VIDEO_EXT.test(panel.asset)) {
          out.push({ sceneId: scene.id, sectionId, shotIndex, asset: panel.asset, windowS, narration })
        }
      }
    })
    void sceneIdx
    void fps
  })
  return out
}

function clipTag(asset: string, shotIndex: number): string {
  const base = asset.replace(/\\/g, '/').split('/').pop() ?? 'clip'
  const stem = base.replace(/\.[^.]+$/, '').slice(0, 60)
  const hash = createHash('sha256').update(asset).digest('hex').slice(0, 6)
  return `${stem}-${hash}-${shotIndex}`
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Choose an in-point for every video shot. Vision picks win; anything the
 * model declines (or all shots when no model is configured) falls back to the
 * deterministic spread, so the film never repeats a clip's first seconds.
 */
export async function pickVideoMoments(input: PickVideoMomentsInput): Promise<PickVideoMomentsResult> {
  const notes: string[] = []
  const picks = new Map<string, Map<number, VideoMoment>>()
  const targets = videoTargets(input.scenes, 30, input.narrationBySection)
  let sampled = 0
  let visionUsed = false
  if (targets.length === 0) return { picks, sampled, visionUsed, notes }

  // The spread cursor is per CLIP across the whole film: the 2nd shot using a
  // clip must not land on the 1st shot's seconds.
  const perClipCount = new Map<string, number>()
  for (const t of targets) perClipCount.set(t.asset, (perClipCount.get(t.asset) ?? 0) + 1)
  // Within one clip the window length can differ per shot; keep the largest so
  // lanes never overlap.
  const maxWindowByClip = new Map<string, number>()
  for (const t of targets) maxWindowByClip.set(t.asset, Math.max(maxWindowByClip.get(t.asset) ?? 0, t.windowS))
  const clipLane = new Map<string, number>()

  const durationByClip = new Map<string, number>()
  const probeDuration = async (asset: string): Promise<number> => {
    const cached = durationByClip.get(asset)
    if (cached !== undefined) return cached
    let d = 0
    try {
      const res = (await input.bridge.request('media.frames_at', {
        project_path: input.projectPath,
        media_path: asset,
        times: [0],
        tag: clipTag(asset, 0),
        width: 32
      })) as { duration_s?: number }
      d = Number(res?.duration_s ?? 0)
    } catch {
      d = 0
    }
    durationByClip.set(asset, d)
    return d
  }

  for (const target of targets) {
    const durationS = await probeDuration(target.asset)
    const lane = clipLane.get(target.asset) ?? 0
    clipLane.set(target.asset, lane + 1)
    const laneCount = perClipCount.get(target.asset) ?? 1
    const spreadWindow = maxWindowByClip.get(target.asset) ?? target.windowS
    // Where this shot sits in the FILM (0 = first, 1 = last): a lone shot uses
    // it to step past the clip's intro.
    const filmFraction = targets.length > 1 ? targets.indexOf(target) / (targets.length - 1) : 0.5
    const fallback = spreadStartS(lane, laneCount, durationS, spreadWindow, filmFraction)

    let chosen: VideoMoment | null = null
    if (input.chat && durationS > target.windowS + 0.5) {
      const range = usableRange(durationS, target.windowS)
      if (range) {
        const times = sampleTimes(range.from, range.to, MOMENT_SAMPLE_COUNT)
        try {
          const res = (await input.bridge.request('media.frames_at', {
            project_path: input.projectPath,
            media_path: target.asset,
            times,
            tag: clipTag(target.asset, target.shotIndex),
            width: 512
          })) as { frames?: Array<{ t_s: number; path: string }> }
          const frames = (res?.frames ?? []).filter((f) => Number.isFinite(f.t_s))
          sampled += frames.length
          if (frames.length >= 2) {
            visionUsed = true
            const images = frames.map((f) => ({
              type: 'image_url' as const,
              image_url: {
                url: `data:image/jpeg;base64,${readFileSync(join(input.projectPath, f.path)).toString('base64')}`
              }
            }))
            const reply = await input.chat.complete(
              [
                { role: 'system', content: momentSystemPrompt() },
                { role: 'user', content: momentPrompt(target, frames.map((f) => f.t_s), durationS), images }
              ],
              [],
              { temperature: 0.1 }
            )
            const answer = parseMomentAnswer(reply.content ?? '')
            const snapped = answer ? snapToSample(answer.t_s, frames.map((f) => f.t_s)) : null
            if (snapped !== null) {
              // Never start so late that the window runs past the clip.
              const start = Math.min(snapped, Math.max(0, durationS - target.windowS))
              chosen = {
                sceneId: target.sceneId,
                shotIndex: target.shotIndex,
                asset: target.asset,
                startS: round3(start),
                windowS: target.windowS,
                source: 'vision',
                ...(answer?.reason ? { reason: answer.reason } : {})
              }
            } else if (answer) {
              notes.push(`${target.sceneId}: the model answered ${answer.t_s}s, which matches no sampled still — used the spread instead`)
            }
          }
        } catch (err) {
          notes.push(`${target.sceneId}: vision moment pick failed (${err instanceof Error ? err.message : String(err)}) — used the spread instead`)
        }
      }
    }

    const pick: VideoMoment =
      chosen ?? {
        sceneId: target.sceneId,
        shotIndex: target.shotIndex,
        asset: target.asset,
        startS: fallback,
        windowS: target.windowS,
        source: 'spread'
      }
    if (!picks.has(pick.sceneId)) picks.set(pick.sceneId, new Map())
    picks.get(pick.sceneId)!.set(pick.shotIndex, pick)
  }

  for (const note of notes) input.onNote?.(note)
  return { picks, sampled, visionUsed, notes }
}

/** Write the chosen in-points onto the scene shots (in place, returns a copy). */
export function applyVideoMoments(scenes: CompositionScene[], picks: Map<string, Map<number, VideoMoment>>): CompositionScene[] {
  return scenes.map((scene) => {
    const byShot = picks.get(scene.id)
    if (!byShot) return scene
    return {
      ...scene,
      shots: (scene.shots ?? []).map((shot, shotIndex) => {
        const pick = byShot.get(shotIndex)
        if (!pick) return shot
        return { ...shot, source_in: pick.startS }
      })
    }
  })
}
