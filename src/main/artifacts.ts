import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as yamlParse, stringify as yamlDump } from 'yaml'
import type { DataCard, SceneVisual } from './producer/compositions'

/**
 * Deterministic artifact writers (DATA-SCHEMA §3–§6).
 *
 * The Director LLM authors STRUCTURED JSON via tool calls; these serializers
 * shape the on-disk formats exactly — free-form markdown from a model never
 * touches bible.md / beats.json / script.md / workflow.json / style.json
 * directly.
 */

export interface BibleSceneInput {
  id: string // "S01"
  label: string // "Hook"
  title: string
  shows: string // visual description, asset references
  feels: string // intended emotion + why the viewer keeps watching
  motion: string
  /** One-line visual plan for the scene (visual direction pass) — the human-readable form of scene.visual. */
  look: string | null
  onScreenText: string
  durationTargetS: number
  claims: string[] // claim ids used
  assetIds: string[] // asset ids used
}

export interface BibleInput {
  title: string
  thesis: string
  targetRuntimeSeconds: number
  /** Set when the Director (not the user) chose the runtime — the evidence-based why. */
  runtimeDecision: string | null
  stylePreset: string
  emotionalPromise: string
  arc: string
  scenes: BibleSceneInput[]
}

export interface BeatInput {
  id: string
  scene: string
  label: string
  startS: number
  durS: number
  curiosity: number
  tension: number
  rehook: boolean
  patternInterrupt: string | null
  /** Open-loop bookkeeping (craft pass): the question this beat plants / pays off. */
  opensLoop: string | null
  closesLoop: string | null
  music: string
  sfx: string[]
}

function sceneBlock(s: BibleSceneInput): string {
  const claims = s.claims.length ? ` (${s.claims.join(', ')})` : ''
  const assets = s.assetIds.length ? ` assets: ${s.assetIds.join(', ')}` : ''
  return [
    `### ${s.id} — ${s.label}: ${s.title}${claims}`,
    `- shows: ${s.shows}${assets}`,
    `- feels: ${s.feels}`,
    `- motion: ${s.motion}`,
    ...(s.look ? [`- look: ${s.look}`] : []),
    `- on-screen text: ${s.onScreenText}`,
    `- duration_target_s: ${s.durationTargetS}`,
    ''
  ].join('\n')
}

export function renderBibleMd(b: BibleInput): string {
  const meta: Record<string, unknown> = {
    title: b.title,
    thesis: b.thesis,
    target_runtime_seconds: b.targetRuntimeSeconds,
    style_preset: b.stylePreset,
    emotional_promise: b.emotionalPromise
  }
  if (b.runtimeDecision) meta.runtime_decision = b.runtimeDecision
  const front = [
    '---',
    yamlDump(meta).trimEnd(),
    '---',
    ''
  ].join('\n')
  const scenes = b.scenes.map(sceneBlock).join('\n')
  return `${front}## Arc\n\n${b.arc}\n\n## Scenes\n\n${scenes}`
}

export function renderBeatsJson(beats: BeatInput[]): string {
  const rehooks = beats.filter((b) => b.rehook).map((b) => b.id)
  return JSON.stringify({ version: 1, beats, rehooks, chapter_markers: true }, null, 2) + '\n'
}

export interface ScriptSectionInput {
  id: string // "hook"
  title: string
  voice?: string
  pace?: number
  energy?: string
  body: string // spoken narration, claim ids inline as (CLM0001)
}

export interface ScriptInput {
  voice: string
  sections: ScriptSectionInput[]
}

export function renderScriptMd(s: ScriptInput): string {
  const front = [
    '---',
    yamlDump({
      voice: s.voice,
      sections: s.sections.map((sec) => ({
        id: sec.id,
        voice: sec.voice ?? s.voice,
        pace: sec.pace ?? 1.0,
        energy: sec.energy ?? 'neutral'
      }))
    }).trimEnd(),
    '---',
    ''
  ].join('\n')
  const body = s.sections
    .map((sec) => `## [${sec.id}] ${sec.title}\n\n${sec.body.trim()}\n`)
    .join('\n')
  return `${front}${body}`
}

export interface WorkflowDuoPanelInput {
  assetPath?: string
  kicker?: string
  title?: string
  note?: string
  motion?: string
  zoom?: number
  /** Seconds into a video panel source where playback starts (default 0). */
  sourceIn?: number
}

export interface WorkflowShotInput {
  kind: 'asset' | 'composition'
  assetPath?: string // media/... for kind=asset
  motion?: string
  zoom?: number
  /** Seconds into a video source where this shot starts (default 0). Chosen by
   *  the video-moment pass so a clip is not replayed from its first frames. */
  sourceIn?: number
  template?: string // composition template id for kind=composition
  text?: string
  /** Exact/paraphrased narration phrase this shot illustrates (Producer timing). */
  cue?: string
  /** Structured data card (data-bars / data-stat / data-list). */
  data?: DataCard
  /** Chunked card lines (list rendering when no data payload). */
  items?: string[]
  /** Two-panel (duo) composition: exactly two image+text boxes. */
  panels?: WorkflowDuoPanelInput[]
  durS: number
}

export interface WorkflowSceneInput {
  id: string
  beats: string[]
  vo: { scriptSection: string; voice: string }
  shots: WorkflowShotInput[]
  /** The Director's per-scene look (visual direction pass). */
  visual?: SceneVisual
  /** Authored transitions — undefined falls back to the film's transition_set (style.json). */
  transitionIn?: string
  transitionOut?: string
  sfx: string[]
  claims: string[]
}

export interface WorkflowInput {
  resolution: [number, number]
  fps: number
  quality: 'draft' | 'standard' | 'high'
  scenes: WorkflowSceneInput[]
  music?: { path: string; duckUnderVo: boolean } | null
}

export function renderWorkflowJson(w: WorkflowInput): string {
  return JSON.stringify(
    {
      version: 1,
      render: { resolution: w.resolution, fps: w.fps, quality: w.quality },
      scenes: w.scenes.map((s) => ({
        id: s.id,
        beats: s.beats,
        vo: { script_section: s.vo.scriptSection, voice: s.vo.voice },
        shots: s.shots.map((shot) =>
          shot.kind === 'asset'
            ? {
                asset: shot.assetPath,
                motion: shot.motion ?? 'kenburns',
                zoom: shot.zoom ?? 1.06,
                // In-point into the clip: the Producer's video-moment pass
                // overwrites this so shots never replay a clip from 0:00.
                ...(shot.sourceIn !== undefined && shot.sourceIn > 0 ? { source_in: shot.sourceIn } : {}),
                ...(shot.cue ? { cue: shot.cue } : {}),
                dur_s: shot.durS
              }
            : {
                composition: shot.template ?? 'title-card',
                template: shot.template ?? 'vox-explainer/title-01',
                text: shot.text ?? '',
                ...(shot.cue ? { cue: shot.cue } : {}),
                ...(shot.data ? { data: shot.data } : {}),
                ...(shot.items?.length ? { items: shot.items } : {}),
                ...(shot.panels?.length
                  ? {
                      panels: shot.panels.map((p) => ({
                        ...(p.assetPath ? { asset: p.assetPath } : {}),
                        ...(p.kicker ? { kicker: p.kicker } : {}),
                        ...(p.title ? { title: p.title } : {}),
                        ...(p.note ? { note: p.note } : {}),
                        ...(p.motion ? { motion: p.motion } : {}),
                        ...(p.zoom !== undefined ? { zoom: p.zoom } : {}),
                        ...(p.sourceIn !== undefined && p.sourceIn > 0 ? { source_in: p.sourceIn } : {})
                      }))
                    }
                  : {}),
                dur_s: shot.durS
              }
        ),
        ...(s.visual ? { visual: s.visual } : {}),
        // Transitions are authored only when the Director chose them —
        // otherwise the film's style.json transition_set seeds the pair.
        ...((s.transitionIn || s.transitionOut)
          ? { transitions: { in: s.transitionIn ?? 'fade', out: s.transitionOut ?? 'crossfade' } }
          : {}),
        sfx: s.sfx,
        claims: s.claims
      })),
      music: w.music ?? null
    },
    null,
    2
  ) + '\n'
}

// ------------------------------------------------------------- persistence

function write(file: string, content: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, content, 'utf-8')
}

export function writeBible(projectPath: string, b: BibleInput): string {
  const file = join(projectPath, 'production', 'bible.md')
  write(file, renderBibleMd(b))
  return file
}

export function writeBeats(projectPath: string, beats: BeatInput[]): string {
  const file = join(projectPath, 'production', 'beats.json')
  write(file, renderBeatsJson(beats))
  return file
}

export function writeScript(projectPath: string, s: ScriptInput): string {
  const file = join(projectPath, 'production', 'script.md')
  write(file, renderScriptMd(s))
  return file
}

/** Read back the sections of an existing production/script.md — the base for
 *  script_write's append mode, which merges a new call's sections into the
 *  script so far (2026-11-19: a weak model could not fit a whole 15-minute
 *  script into one tool call and burned every turn rewriting the same draft).
 *  Front-matter supplies voice/pace/energy; `## [id] Title` headings supply
 *  id/title/body. Returns [] when the file does not exist or does not parse. */
export function readScriptSections(projectPath: string): ScriptSectionInput[] {
  try {
    const raw = readFileSync(join(projectPath, 'production', 'script.md'), 'utf-8')
    const fmRaw = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
    const fm = fmRaw
      ? (yamlParse(fmRaw) as { voice?: string; sections?: Array<{ id?: string; voice?: string; pace?: number; energy?: string }> } | null)
      : null
    const metaById = new Map<string, { voice?: string; pace?: number; energy?: string }>()
    for (const s of fm?.sections ?? []) {
      if (s?.id) metaById.set(String(s.id), { voice: s.voice, pace: s.pace, energy: s.energy })
    }
    // "pre## [a] T1\nbody1\n## [b] T2\nbody2".split(re) → [pre, a, T1, body1, b, T2, body2]
    const parts = raw.split(/^## \[([A-Za-z0-9_-]+)\] (.*)$/m)
    const out: ScriptSectionInput[] = []
    for (let i = 1; i + 2 < parts.length; i += 3) {
      const meta = metaById.get(parts[i])
      out.push({
        id: parts[i],
        title: parts[i + 1].trim(),
        body: parts[i + 2].trim(),
        ...(meta?.voice ? { voice: meta.voice } : {}),
        ...(typeof meta?.pace === 'number' ? { pace: meta.pace } : {}),
        ...(meta?.energy ? { energy: meta.energy } : {})
      })
    }
    return out
  } catch {
    return []
  }
}

export function writeWorkflow(projectPath: string, w: WorkflowInput): string {
  const file = join(projectPath, 'studio', 'workflow.json')
  write(file, renderWorkflowJson(w))
  return file
}

/** studio/style.json content (DATA-SCHEMA §6) — written by the Director's
 *  style_write tool and by the user's Bible-stage Style panel (which wins:
 *  last writer). `look` is the film's one-line visual identity note. */
export interface ProjectStyleInput {
  preset?: string
  accent?: string
  caption_style?: string
  vignette?: boolean
  grain?: boolean
  transition_set?: string
  look?: string
}

export function writeStyle(projectPath: string, style: ProjectStyleInput): string {
  const file = join(projectPath, 'studio', 'style.json')
  write(file, JSON.stringify(style, null, 2) + '\n')
  return file
}

export function readBibleBundle(projectPath: string): {
  bible: BibleInput | null
  beats: BeatInput[]
  workflow: unknown
  scriptSections: Array<{ id: string; title: string; body: string }> | null
} | null {
  const bibleFile = join(projectPath, 'production', 'bible.md')
  if (!existsSync(bibleFile)) return null
  const raw = readFileSync(bibleFile, 'utf-8')
  // Parse front-matter + scenes back into the structured form
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const body = raw.slice(fmMatch ? fmMatch[0].length : 0).replace(/^\r?\n/, '')
  const yaml = (fmMatch ? fmMatch[1] : '') as string
  let fm: Record<string, string> = {}
  try {
    // minimal parse: the dump shape we wrote (flat keys)
    for (const line of yaml.split('\n')) {
      const m = line.match(/^([a-z_]+):\s*(.*)$/)
      if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    fm = {}
  }
  const scenes: BibleSceneInput[] = []
  const sceneSplit = body.split(/^### /m).slice(1)
  for (const block of sceneSplit) {
    const head = block.split('\n')[0] ?? ''
    const idm = head.match(/^(S\d+)\s+—\s+([^:]+):\s*(.*)$/)
    if (!idm) continue
    // claims live in the scene header ("### S01 — Hook: Title (CLM-001, CLM-002)")
    const claimIds = Array.from(idm[3].matchAll(/CLM-[0-9]+/g)).map((m) => m[0])
    const title = idm[3].replace(/\s*\((?:CLM-[0-9]+[^)]*)\)\s*$/, '').trim()
    const get = (key: string): string =>
      (block.match(new RegExp(`^- ${key}: (.*)$`, 'm'))?.[1] ?? '').replace(/ \(CLM[0-9]+[^)]*\)/, '')
    const showsLine = (block.match(/^- shows: (.*)$/m)?.[1] ?? '')
    // assets are appended to the shows line ("… assets: AS-01, AS-02"); /g required — matchAll throws on a non-global regex
    const assetIds = Array.from(showsLine.matchAll(/assets: ([A-Z0-9-, ]+)$/gm)).flatMap((m) =>
      m[1].split(',').map((s) => s.trim()).filter(Boolean)
    )
    scenes.push({
      id: idm[1],
      label: idm[2].trim(),
      title,
      shows: showsLine.replace(/\s*assets: [A-Z0-9-, ]+$/, '').trim(),
      feels: get('feels'),
      motion: get('motion'),
      look: get('look') || null,
      onScreenText: get('on-screen text'),
      durationTargetS: Number((block.match(/^- duration_target_s: (\d+)/m)?.[1] ?? 0)),
      claims: claimIds,
      assetIds
    })
  }
  const arc = body.match(/## Arc\n\n([\s\S]*?)\n## Scenes/)?.[1]?.trim() ?? ''
  let beats: BeatInput[] = []
  const beatsFile = join(projectPath, 'production', 'beats.json')
  if (existsSync(beatsFile)) {
    try {
      beats = (JSON.parse(readFileSync(beatsFile, 'utf-8')) as { beats: BeatInput[] }).beats ?? []
    } catch {
      beats = []
    }
  }
  let workflow: unknown = null
  const wfFile = join(projectPath, 'studio', 'workflow.json')
  if (existsSync(wfFile)) {
    try {
      workflow = JSON.parse(readFileSync(wfFile, 'utf-8'))
    } catch {
      workflow = null
    }
  }
  let scriptSections: Array<{ id: string; title: string; body: string }> | null = null
  const scriptFile = join(projectPath, 'production', 'script.md')
  if (existsSync(scriptFile)) {
    const scriptRaw = readFileSync(scriptFile, 'utf-8')
    scriptSections = scriptRaw
      .split(/^## \[([A-Za-z0-9_-]+)\] (.*)$/m)
      .slice(1)
      .reduce<Array<{ id: string; title: string; body: string }>>((acc, _cur, i, arr) => {
        if (i % 3 === 0) acc.push({ id: arr[i], title: arr[i + 1], body: (arr[i + 2] ?? '').trim() })
        return acc
      }, [])
  }
  return {
    bible: {
      title: fm.title ?? '',
      thesis: fm.thesis ?? '',
      targetRuntimeSeconds: Number(fm.target_runtime_seconds ?? 0),
      runtimeDecision: fm.runtime_decision ? fm.runtime_decision : null,
      stylePreset: fm.style_preset ?? 'vox-explainer',
      emotionalPromise: fm.emotional_promise ?? '',
      arc,
      scenes
    },
    beats,
    workflow,
    scriptSections
  }
}
