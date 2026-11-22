import { createHash } from 'node:crypto'
import { buildSrtCues } from './subs'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fitText, measureText } from './fit'
import { bakeVideoFrames, frameSequenceHtml, frameSequenceTweens, type BakedVideo } from './video-frames'
import { lookupPlace } from './gazetteer'
import { WORLD_MASK } from './world-mask'
import {
  imageFrame,
  imageSize,
  isPagePlate,
  screenshotFrame,
  screenshotHost,
  type MediaSize
} from './media-info'
import {
  DESIGN_BAR_LABEL,
  DESIGN_BAR_VALUE,
  DESIGN_DATA_BOX,
  DESIGN_EXHIBIT_CAP,
  DESIGN_KICKER,
  DESIGN_LIST_LABEL,
  DESIGN_LOWER_THIRD,
  DESIGN_STAT_NOTE,
  DESIGN_TYPE,
  GRAIN_SVG,
  applyStyleOverrides,
  cardContentWidth,
  dataContentWidth,
  designCss,
  designFurniture,
  duoGeometry,
  layoutHeadlinePx,
  quoteContentWidth,
  resolveStyle,
  type DesignKey,
  type FontFaceSpec,
  type StyleOverrides,
  type StyleTokens
} from './skins'

export type { FontFaceSpec, StyleOverrides, StyleTokens }
export { applyStyleOverrides, resolveStyle }

/**
 * Composition builder (TAD §9, M3 v1): deterministic templating from
 * workflow.json + VO timings into a HyperFrames project under
 * studio/compositions/ — root index.html, sub-compositions per scene,
 * copied assets, local GSAP. The model never authors HTML; this module
 * emits every file from structured input.
 *
 * Timeline authority is the narration: each scene's duration is its VO
 * section's rendered length (frame-aligned), so subtitles, shot cadence,
 * and the picture master all share one clock and dwk.finalize's mux is
 * gap-free by construction.
 */

// ------------------------------------------------------------------- types
// Style tokens + presets live in ./skins (the design-system layer).

// -------------------------------------------------- visual direction (2026-11-16)
// The Director plans the edit's look per film and per scene (AGENT-SPEC §2.3
// craft rule 7): a global identity via style.json + per-scene directives in
// workflow.json scene.visual. Everything here maps those validated inputs
// deterministically onto CSS/GSAP — the model never authors HTML.

/** workflow.json scene.visual — the Director's per-scene look (DATA-SCHEMA §5). */
export interface SceneVisual {
  /** Scene accent shift (#rrggbb) — act-based palette moves live here. */
  accent?: string
  mood?: string
  layout?: string
}

export const VISUAL_MOODS = ['neutral', 'warm', 'cool', 'sepia', 'noir', 'vivid'] as const
export const VISUAL_LAYOUTS = ['standard', 'full-bleed', 'split', 'centered', 'minimal'] as const
export const VISUAL_MOTIONS = ['kenburns', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'still'] as const
export const VISUAL_TRANSITIONS = ['cut', 'fade', 'crossfade', 'dip-to-black'] as const
export const TRANSITION_SETS = ['smooth', 'hard-cuts', 'cinematic', 'broadcast'] as const

export type VisualMood = (typeof VISUAL_MOODS)[number]
export type VisualLayout = (typeof VISUAL_LAYOUTS)[number]

export const isVisualMood = (v: string): v is VisualMood => (VISUAL_MOODS as readonly string[]).includes(v)
export const isVisualLayout = (v: string): v is VisualLayout => (VISUAL_LAYOUTS as readonly string[]).includes(v)
export const isVisualMotion = (v: string): boolean => (VISUAL_MOTIONS as readonly string[]).includes(v)
export const isVisualTransition = (v: string): boolean => (VISUAL_TRANSITIONS as readonly string[]).includes(v)

/** style.json transition_set → the film's default transition pair for scenes that author none. */
export function resolveTransitionSet(name: string | undefined): { in: string; out: string } {
  switch ((name || '').toLowerCase()) {
    case 'hard-cuts':
      return { in: 'cut', out: 'cut' }
    case 'cinematic':
      return { in: 'dip-to-black', out: 'crossfade' }
    case 'broadcast':
      return { in: 'cut', out: 'crossfade' }
    default:
      return { in: 'fade', out: 'crossfade' } // 'smooth' and unknown values → the historical defaults
  }
}

/** Effective transitions for a scene: authored values win, then the film's transition_set. */
export function resolveSceneTransitions(
  scene: Pick<CompositionScene, 'transitions'>,
  defaults?: { in?: string; out?: string }
): { in: string; out: string } {
  const d = defaults ?? { in: '', out: '' }
  return { in: scene.transitions?.in || d.in || 'fade', out: scene.transitions?.out || d.out || 'crossfade' }
}

export interface SceneGrade {
  /** Overlay paint (null = no overlay layer). */
  color: string | null
  opacity: number
  blend: string
  /** CSS filter for media layers (null = none) — footage is graded, text/cards stay crisp. */
  filter: string | null
}

/** Scene-resolved tokens: the film tokens with the scene's look applied. */
export interface SceneStyleTokens extends StyleTokens {
  grade: SceneGrade | null
}

/** Deterministic mood → grade table. Overlay + media filter only; text, panel
 *  and border colors are never touched, so light themes stay readable. Moods
 *  whose identity needs texture carry a grain floor (a noir grade on a
 *  zero-grain preset must still read as film, not as a clean slide). */
const MOOD_GRADES: Record<VisualMood, { color: string | null; opacity: number; blend: string; filter: string | null; grainMul: number; grainFloor?: number; vignette?: boolean } | null> = {
  neutral: null,
  warm: { color: '#c96a2b', opacity: 0.1, blend: 'soft-light', filter: 'saturate(1.08) sepia(0.06)', grainMul: 1 },
  cool: { color: '#2b6ac9', opacity: 0.1, blend: 'soft-light', filter: 'saturate(1.05)', grainMul: 1 },
  sepia: { color: '#b0722d', opacity: 0.14, blend: 'soft-light', filter: 'sepia(0.35) contrast(1.02)', grainMul: 1.6, grainFloor: 0.06 },
  noir: { color: '#05070a', opacity: 0.16, blend: 'multiply', filter: 'grayscale(1) contrast(1.18)', grainMul: 1.4, grainFloor: 0.07, vignette: true },
  vivid: { color: null, opacity: 0, blend: 'normal', filter: 'saturate(1.35) contrast(1.05)', grainMul: 1 }
}

/** The film's tokens resolved for ONE scene: accent shift + mood grade.
 *  No visual → identity (exactly the film's global look). */
export function resolveSceneStyle(base: StyleTokens, visual?: SceneVisual): SceneStyleTokens {
  const accent = visual?.accent && /^#[0-9a-fA-F]{6}$/.test(visual.accent) ? visual.accent : base.accent
  const mood = visual?.mood && isVisualMood(visual.mood) ? visual.mood : 'neutral'
  const g = MOOD_GRADES[mood]
  const grade: SceneGrade | null = g ? { color: g.color, opacity: g.opacity, blend: g.blend, filter: g.filter } : null
  return {
    ...base,
    accent,
    grain: g ? Math.min(0.2, Math.max(base.grain * g.grainMul, g.grainFloor ?? 0)) : base.grain,
    vignette: g?.vignette ? true : base.vignette,
    grade
  }
}

const FONTS_ROOT = join('assets', 'fonts')
/** Posix form for CSS urls — join() yields a Windows backslash on win32, which Chromium will not resolve. */
const FONTS_URL_ROOT = 'assets/fonts'

/** Structured data card (workflow.json shot field, DATA-SCHEMA §5): bars/stat/list. */
export interface DataCard {
  kind: 'bars' | 'stat' | 'list' | 'line' | 'timeline' | 'map' | 'article'
  title?: string
  unit?: string
  /** Source/chart note shown under the graphic. */
  note?: string
  items: Array<{ label: string; value?: number; note?: string }>
  /** data-line: x-axis labels and one to three value series. */
  labels?: string[]
  series?: Array<{ label?: string; values: number[] }>
  /** data-timeline: dated events (year optional → evenly spaced). */
  events?: Array<{ label: string; year?: number; note?: string; highlight?: boolean }>
  /** data-map: real locations; coords optional if the gazetteer knows the name. */
  markers?: Array<{ label: string; lat?: number; lon?: number; note?: string; highlight?: boolean }>
  /** Draw the animated route through the markers in order. */
  route?: boolean
  /** article: a reconstructed source clipping with a highlighted quote. */
  publication?: string
  date?: string
  headline?: string
  body?: string
  quote?: string
  attribution?: string
}

/** One panel of a duo (two-box) composition: an evidence image and/or a text
 *  block. Panel order is left → right. */
export interface DuoPanel {
  /** Project-relative media path (image or video). */
  asset?: string
  /** Small source/category label above the title. */
  kicker?: string
  /** The panel's headline (the only required text). */
  title?: string
  /** Small annotation under the title (source, date, detail). */
  note?: string
  /** Per-panel motion for the media (defaults to the shot's motion). */
  motion?: string
  zoom?: number
  /** Seconds into a video panel source where playback starts (default 0). */
  source_in?: number
}

export interface CompositionShot {
  kind: 'asset' | 'composition'
  /** Project-relative media path — workflow.json schema key (DATA-SCHEMA §5). */
  asset?: string
  motion?: string
  zoom?: number
  template?: string
  text?: string
  /** The narration phrase this shot illustrates (Producer aligns it to the
   *  generated voice-over's word timings). */
  cue?: string
  /** Data-card payload (data-bars / data-stat / data-list). */
  data?: DataCard
  /** Chunked card lines (list rendering when no data payload). */
  items?: string[]
  /** Two-panel composition (template duo): exactly two image+text boxes. */
  panels?: DuoPanel[]
  /** Seconds into a video source where this shot starts (default 0). */
  source_in?: number
  dur_s: number
}

export interface CompositionScene {
  id: string
  vo: { script_section: string; voice: string }
  shots: CompositionShot[]
  /** Authored transitions — omitted when the Director left them to the film's transition_set. */
  transitions?: { in: string; out: string }
  /** The Director's per-scene look (visual direction pass) — optional; absent = the film's global look. */
  visual?: SceneVisual
  claims?: string[]
}

export interface WorkflowJson {
  version: number
  render: { resolution: [number, number]; fps: number; quality: string }
  scenes: CompositionScene[]
  music?: { path: string; duck_under_vo: boolean } | null
}

export interface SceneTiming {
  id: string
  voSection: string
  startS: number
  durS: number
  frames: number
  startFrame: number
  trackIndex: number
  overlapInS: number
  entranceS: number
  /** Effective transitions (authored → transition_set fallback) — the renderer keys grade/dip overlays off these. */
  transitionIn?: string
  transitionOut?: string
  /** 'cut' entrances render no fade at all; absent = 'fade'. */
  entranceKind?: 'cut' | 'fade' | 'crossfade' | 'dip-to-black'
}

export interface RawWordTiming {
  word: string
  start_s: number
  dur_s: number
}

export interface BeatInfo {
  id: string
  scene: string
  label: string
  /** Global timeline seconds (beats.json). */
  startS: number
  rehook: boolean
  patternInterrupt: string | null
}

export interface BuildCompositionsInput {
  projectPath: string
  workflow: WorkflowJson
  /** Scene id → rendered VO duration in seconds (frame-agnostic; we align). */
  voDurations: Record<string, number>
  stylePreset: string
  projectTitle: string
  /** Scene VO section id → script.md heading (editorial kicker text). */
  sectionTitles?: Record<string, string>
  /** Scene VO section id → word timings (kinetic captions). */
  voWords?: Record<string, RawWordTiming[]>
  /** beats.json (beat-synced motion: re-hooks, pattern interrupts). */
  beats?: BeatInfo[]
  /** studio/style.json overrides (DATA-SCHEMA §6). */
  styleOverrides?: StyleOverrides
}

export interface CompositionBuildResult {
  dir: string
  /** 720p draft variant dir (always built — fast preview renders). */
  dirDraft: string | null
  totalDurationS: number
  totalFrames: number
  sceneTimings: SceneTiming[]
  sceneFiles: string[]
  assetCount: number
  /** Per-scene render stamps (master variant): timing/asset changes re-render. */
  stamps: Record<string, string>
  stampsDraft: Record<string, string> | null
  draftDims: [number, number]
  /** Deterministic layout audit: fitted-text fallbacks and geometry repairs. */
  layoutNotes: string[]
}

// ------------------------------------------------------------------- style
// resolveStyle / applyStyleOverrides live in ./skins.

// ------------------------------------------------------------- timeline math

export interface TransitionSpec {
  kind: 'cut' | 'fade' | 'crossfade' | 'dip-to-black'
  s: number
}

/** Transition semantics: kind + overlap seconds (a dip-to-black overlaps like
 *  a crossfade so the gapless VO math holds; unknown values cut honestly). */
export function transitionSpec(prevOut: string, nextIn: string): TransitionSpec {
  const out = (prevOut || '').toLowerCase()
  const inn = (nextIn || '').toLowerCase()
  if (inn === 'dip-to-black' || out === 'dip-to-black') return { kind: 'dip-to-black', s: 0.5 }
  if (inn.includes('crossfade') || out.includes('crossfade')) return { kind: 'crossfade', s: 0.5 }
  if (inn.includes('fade') || out.includes('fade')) return { kind: 'fade', s: 0.4 }
  return { kind: 'cut', s: 0 } // 'cut' and anything unrecognized
}

/** Overlap (seconds) produced by a transition pair on the master timeline. */
export function transitionOverlap(prevOut: string, nextIn: string): number {
  return transitionSpec(prevOut, nextIn).s
}

const MIN_SCENE_FRAMES = 24 // never shorter than ~0.8s at 30fps

/**
 * VO-driven master timeline: scene i starts where the previous scene's
 * audio ends minus the crossfade overlap (an L-cut — the incoming scene
 * fades in while the outgoing narration tail finishes). Because narration
 * is a gapless concat of section WAVs, the picture master must last EXACTLY
 * the narration total: the final scene absorbs the accumulated overlap so
 * dwk.finalize never truncates the last words.
 */
export function computeSceneTimings(
  scenes: CompositionScene[],
  voDurations: Record<string, number>,
  fps: number,
  transitionDefaults?: { in?: string; out?: string }
): { timings: SceneTiming[]; totalFrames: number; totalDurationS: number } {
  const timings: SceneTiming[] = []
  let cursorFrames = 0
  let overlapTotalFrames = 0
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i]
    const voDur = Math.max(0.5, Number(voDurations[scene.vo.script_section] ?? 0))
    const voFrames = Math.max(MIN_SCENE_FRAMES, Math.round(voDur * fps))
    const trans = resolveSceneTransitions(scene, transitionDefaults)
    let startFrames = cursorFrames
    let overlapInS = 0
    let entranceKind: SceneTiming['entranceKind']
    if (i > 0) {
      const prev = resolveSceneTransitions(scenes[i - 1], transitionDefaults)
      const spec = transitionSpec(prev.out, trans.in)
      overlapInS = spec.s
      entranceKind = spec.kind
      const overlapFrames = Math.min(
        Math.round(overlapInS * fps),
        Math.floor(voFrames / 2),
        Math.max(0, cursorFrames - timings[i - 1].startFrame - 1)
      )
      startFrames = cursorFrames - overlapFrames
      overlapTotalFrames += startFrames < cursorFrames ? cursorFrames - startFrames : 0
    } else {
      // First scene opens on nothing: its in-transition is a plain fade-in
      // (a dip-to-black on the very first scene still reads as a fade — the
      // master beneath is already black).
      entranceKind = trans.in === 'cut' ? 'cut' : 'fade'
    }
    const entranceS = overlapInS > 0 ? overlapInS : (trans.in === 'cut' ? 0.12 : 0.4)
    const isLast = i === scenes.length - 1
    const frames = isLast ? voFrames + overlapTotalFrames : voFrames
    timings.push({
      id: scene.id,
      voSection: scene.vo.script_section,
      startFrame: startFrames,
      frames,
      startS: round3(startFrames / fps),
      durS: round3(frames / fps),
      trackIndex: i % 2 === 0 ? 1 : 2,
      overlapInS: round3(overlapInS),
      entranceS: round3(entranceS),
      transitionIn: trans.in,
      transitionOut: trans.out,
      entranceKind
    })
    cursorFrames = startFrames + frames
  }
  return { timings, totalFrames: cursorFrames, totalDurationS: round3(cursorFrames / fps) }
}

/** Scale a scene's shots (durations) to fill the scene's VO duration on the frame grid. */
export function scaleShotsToDuration(
  shots: CompositionShot[],
  sceneDurS: number,
  fps: number
): Array<{ shot: CompositionShot; durS: number; frames: number }> {
  if (shots.length === 0) {
    // Degenerate workflow (no shots) → one title card for the scene.
    shots = [{ kind: 'composition', template: 'title-card', text: '', dur_s: sceneDurS }]
  }
  const sceneFrames = Math.max(shots.length, Math.round(sceneDurS * fps))
  const weightSum = shots.reduce((acc, s) => acc + Math.max(0.5, Number(s.dur_s) || 2), 0)
  const raw = shots.map((s) => Math.max(1, Math.round((sceneFrames * Math.max(0.5, Number(s.dur_s) || 2)) / weightSum)))
  let drift = sceneFrames - raw.reduce((a, b) => a + b, 0)
  // Absorb rounding drift on the largest shot (bounded ±2 frames at a time).
  while (drift !== 0) {
    const idx = drift < 0 ? raw.indexOf(Math.max(...raw)) : raw.indexOf(Math.min(...raw))
    if (idx < 0) break
    raw[idx] += drift > 0 ? 1 : -1
    if (raw[idx] < 1) raw[idx] = 1
    drift += drift > 0 ? -1 : 1
  }
  return shots.map((shot, i) => ({ shot, frames: raw[i], durS: round3(raw[i] / fps) }))
}

// ------------------------------------------------------------ html emission

export type TemplateKind =
  | 'title'
  | 'end'
  | 'lower'
  | 'quote'
  | 'source'
  | 'bars'
  | 'stat'
  | 'list'
  | 'line'
  | 'timeline'
  | 'map'
  | 'article'
  | 'duo'

export function templateKind(template: string | undefined): TemplateKind {
  const t = (template || 'title-card').toLowerCase()
  if (t.includes('timeline')) return 'timeline'
  if (t.includes('bars')) return 'bars'
  if (t.includes('stat')) return 'stat'
  if (t.includes('list')) return 'list'
  if (t.includes('data-line') || t.includes('line-chart') || t.includes('line-card') || t === 'line') return 'line'
  if (t.includes('map') || t.includes('geo')) return 'map'
  if (t.includes('article') || t.includes('clipping')) return 'article'
  if (t.includes('duo') || t.includes('pair') || t.includes('two-up')) return 'duo'
  if (t.includes('end')) return 'end'
  if (t.includes('lower')) return 'lower'
  if (t.includes('quote')) return 'quote'
  if (t.includes('source')) return 'source'
  return 'title'
}

/** The two panels of a duo shot, if the shot can render as a duo. Accepts the
 *  authored `panels` payload; falls back to two `items` lines (text-only boxes)
 *  so a model that writes `template: duo, items: [A, B]` still gets two boxes. */
export function duoPanelsOf(shot: CompositionShot): DuoPanel[] | null {
  const raw = Array.isArray(shot.panels) ? shot.panels : []
  const panels = raw
    .map((p) => ({
      asset: p.asset ? String(p.asset) : undefined,
      kicker: p.kicker ? String(p.kicker) : undefined,
      title: p.title ? String(p.title) : (p as { text?: string }).text ? String((p as { text?: string }).text) : undefined,
      note: p.note ? String(p.note) : undefined,
      motion: p.motion ? String(p.motion) : undefined,
      zoom: Number.isFinite(Number(p.zoom)) ? Number(p.zoom) : undefined
    }))
    .filter((p) => p.asset || p.title || p.note)
  if (panels.length >= 2) return panels.slice(0, 2)
  const items = Array.isArray(shot.items) ? shot.items.filter((s) => String(s ?? '').trim()) : []
  if (items.length >= 2) return items.slice(0, 2).map((t) => ({ title: String(t) }))
  return null
}

/** A stat card whose "note" is prose, not a figure: the note belongs in a
 *  pull-quote (fitted body copy), never in the 190-218px display slot. */
export function statIsQuote(card: DataCard): boolean {
  const it = card.items[0]
  if (!it) return false
  const hasFigure = it.value !== undefined && Number.isFinite(it.value)
  if (hasFigure) return false
  const note = String(it.note ?? '').trim()
  if (!note) return true
  // A bare number/range/year is still a figure ("1920", "12–15", "1,000+").
  const numericNote = isNumericNote(note) || /^[#]?\d[\d,.\s–-]*%?\+?$/.test(note)
  return !numericNote
}

/** The prose a quote-mode stat card should display (longest sensible string). */
export function statQuoteText(card: DataCard): string {
  const it = card.items[0]
  const note = String(it?.note ?? '').trim()
  if (note) return note
  const title = String(card.title ?? '').trim()
  if (title) return title
  return String(it?.label ?? '').trim()
}

/** Does a card title just repeat the figure ("1,000+" above "1000")? */
function titleRepeatsValue(title: string | undefined, value: string): boolean {
  const norm = (s: string | undefined): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const t = norm(title)
  const v = norm(value)
  return Boolean(t && v) && (t === v || t === `${v}plus` || v === `${t}plus`)
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ------------------------------------------------------------- text fitting
// Every text node that can carry authored copy goes through fitText before
// the HTML is written: the browser never gets a chance to clip a sentence.
// `fitted` returns the inline font-size override only when the nominal CSS
// size would not fit, so untouched cards keep their designed type scale.

interface FitNote {
  (message: string): void
}

interface FitContext {
  style: StyleTokens
  design: DesignKey
  designWidth: number
  layout: VisualLayout
  note?: FitNote
  sceneId: string
}

interface Fitted {
  /** Inline style attribute (` style="font-size:Npx"`) or ''. */
  attr: string
  sizePx: number
  overflow: boolean
}

function fitted(
  text: string,
  opts: {
    family: string
    weight?: number
    nominal: number
    maxWidth: number
    maxHeight?: number
    min?: number
    lineHeight?: number
    trackingEm?: number
    caps?: boolean
    maxLines?: number
  },
  ctx: FitContext,
  label: string
): Fitted {
  const fit = fitText(text, {
    family: opts.family,
    weight: opts.weight,
    nominal: opts.nominal,
    maxWidth: opts.maxWidth,
    maxHeight: opts.maxHeight,
    min: opts.min,
    lineHeight: opts.lineHeight,
    trackingEm: opts.trackingEm,
    caps: opts.caps,
    maxLines: opts.maxLines
  })
  if (fit.overflow) {
    ctx.note?.(
      `${ctx.sceneId}: ${label} does not fit at the readability floor (${fit.sizePx}px) — shorten the copy or move it to its own card`
    )
  }
  return {
    attr: fit.sizePx < Math.floor(opts.nominal) ? ` style="font-size:${fit.sizePx}px"` : '',
    sizePx: fit.sizePx,
    overflow: fit.overflow
  }
}

/** Split a quote's trailing attribution ("… — Vertov, 1923") into body + byline. */
function splitQuote(text: string): { body: string; attribution: string } {
  const t = String(text ?? '').trim()
  const m = t.match(/^(.*?)\s+[—–-]\s+([^—–]{2,70})$/)
  if (m && !/[.!?]$/.test(m[2].trim()) && m[1].trim().split(/\s+/).length >= 3) {
    return { body: m[1].trim(), attribution: m[2].trim() }
  }
  return { body: t, attribution: '' }
}

// ----------------------------------------------- motion-graphics card vocabulary
// 2026-11-16 pass: animated line charts, chronologies, location maps and
// reconstructed article clippings with a highlighter sweep. Every renderer is
// deterministic HTML/SVG + a GSAP tween set added by renderSceneHtml.

function wideCardGeometry(ctx: FitContext, maxWidth = 1560): { cardW: number; contentW: number } {
  const box = DESIGN_DATA_BOX[ctx.design]
  const cardW = Math.min(maxWidth, Math.max(520, ctx.designWidth - 240))
  return { cardW, contentW: Math.max(320, cardW - 2 * box.padX) }
}

function shortNumber(n: number): string {
  const abs = Math.abs(n)
  const trim = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ''))
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}m`
  if (abs >= 1000) return `${trim(n / 1000)}k`
  return trim(n)
}

function cardNoteHtml(note: string | undefined, ctx: FitContext, width: number): string {
  if (!note) return ''
  const fit = fitted(
    note,
    { family: ctx.style.fontBody, weight: 600, nominal: 16, maxWidth: width, min: 11, trackingEm: 0.04, maxLines: 1 },
    ctx,
    'card note'
  )
  return `<div class="chart-note"${fit.attr}>${esc(note)}</div>`
}

function wideCardShell(opts: {
  card: DataCard
  ctx: FitContext
  cardW: number
  contentW: number
  className: string
  kickerHtml: string
  titleHtml: string
  body: string
}): string {
  return `    <div class="shot shot-$IDX card-shot$LY" data-shot="$IDX">
      <div class="card data-card ${opts.className}" style="width:${opts.cardW}px;max-width:${opts.cardW}px">
        ${opts.kickerHtml}
        ${opts.titleHtml}
        ${opts.body}
        ${cardNoteHtml(opts.card.note, opts.ctx, opts.contentW)}
      </div>
    </div>`
}

/** Animated line/area chart (data-line). */
function lineCardHtml(card: DataCard, ctx: FitContext, kickerHtml: string, titleHtml: string): string | null {
  const labels = Array.isArray(card.labels) ? card.labels.map(String) : []
  const series = (Array.isArray(card.series) ? card.series : []).filter(
    (s) => Array.isArray(s.values) && s.values.length === labels.length && s.values.every((v) => Number.isFinite(v))
  )
  if (labels.length < 2 || series.length === 0) return null
  const wide = wideCardGeometry(ctx, 1560)
  const svgW = Math.round(wide.contentW - 16)
  const svgH = 410
  const left = 66
  const right = 18
  const top = 18
  const bottom = 48
  const plotW = svgW - left - right
  const plotH = svgH - top - bottom
  const all = series.flatMap((s) => s.values)
  let min = Math.min(0, ...all)
  let max = Math.max(...all)
  if (max === min) max = min + 1
  const xFor = (i: number): number => left + (labels.length <= 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW)
  const yFor = (v: number): number => top + (1 - (v - min) / (max - min)) * plotH

  const grid: string[] = []
  for (let k = 0; k <= 4; k++) {
    const v = max - (k / 4) * (max - min)
    const y = yFor(v)
    grid.push(`      <line class="chart-grid-line" x1="${left}" y1="${round3(y)}" x2="${svgW - right}" y2="${round3(y)}"/>`)
    grid.push(`      <text class="chart-axis-label" x="${left - 12}" y="${round3(y + 4)}" text-anchor="end">${esc(shortNumber(v))}</text>`)
  }
  const xLabels = labels
    .map((label, i) => {
      if (labels.length > 8 && i % 2 === 1) return ''
      return `<text class="chart-axis-label chart-x-label" x="${round3(xFor(i))}" y="${svgH - 16}" text-anchor="middle">${esc(label)}</text>`
    })
    .join('')

  const seriesSvg = series
    .map((s, si) => {
      const points = s.values.map((v, i) => `${round3(xFor(i))},${round3(yFor(v))}`)
      const line = `M${points.join(' L')}`
      const area = `${line} L${round3(xFor(labels.length - 1))},${round3(top + plotH)} L${round3(xFor(0))},${round3(top + plotH)} Z`
      const dots = s.values
        .map((v, i) => `<circle class="chart-dot chart-dot-${si}-${i}" cx="${round3(xFor(i))}" cy="${round3(yFor(v))}" r="5"/>`)
        .join('')
      return `      <path class="chart-area chart-area-${si}" d="${area}"/>
      <path class="chart-line chart-line-${si}" pathLength="1" d="${line}"/>
      <g class="chart-dots chart-dots-${si}">${dots}</g>`
    })
    .join('\n')

  const legend =
    series.some((s) => s.label) && series.length > 1
      ? `<div class="chart-legend">${series
          .map((s, si) => `<span class="chart-key chart-key-${si}"><i></i>${esc(s.label ?? `Series ${si + 1}`)}</span>`)
          .join('')}</div>`
      : ''
  const unit = card.unit ? `<div class="chart-unit">${esc(card.unit)}</div>` : ''

  return wideCardShell({
    card,
    ctx,
    cardW: wide.cardW,
    contentW: wide.contentW,
    className: 'chart-card line-card',
    kickerHtml,
    titleHtml,
    body: `${legend}${unit}
        <div class="chart-wrap">
          <svg class="chart-svg" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="xMidYMid meet" width="100%" height="${svgH}">
${grid.join('\n')}
${seriesSvg}
      <g class="chart-x">${xLabels}</g>
          </svg>
        </div>`
  })
}

/** Animated chronology (data-timeline). */
function timelineCardHtml(card: DataCard, ctx: FitContext, kickerHtml: string, titleHtml: string): string | null {
  const eventsIn = Array.isArray(card.events) ? card.events.filter((e) => String(e.label ?? '').trim()) : []
  if (eventsIn.length < 2) return null
  const wide = wideCardGeometry(ctx, 1560)
  const plotW = Math.round(wide.contentW - 20)
  const plotH = 516
  const axisY = 258
  const cardH = 104
  const allYears = eventsIn.every((e) => Number.isFinite(Number(e.year)))
  const events = allYears ? [...eventsIn].sort((a, b) => Number(a.year) - Number(b.year)) : eventsIn
  const years = events.map((e) => Number(e.year))
  const minY = Math.min(...years)
  const maxY = Math.max(...years)
  const pad = 40
  const eventW = Math.max(148, Math.min(230, Math.round(plotW / events.length) - 12))
  const xFor = (i: number): number => {
    if (allYears && maxY > minY) return pad + ((Number(events[i].year) - minY) / (maxY - minY)) * (plotW - pad * 2)
    return pad + (events.length <= 1 ? (plotW - pad * 2) / 2 : (i / (events.length - 1)) * (plotW - pad * 2))
  }

  // Four lanes: above/below the axis, each with a second tier for close years.
  // A lane only accepts a card when it is at least one card-width from every
  // card already in it, so 1922/1923/1926 can all coexist without clipping.
  const laneTops = [axisY - 30 - cardH, axisY + 30, axisY - 30 - cardH - 12 - cardH, axisY + 30 + cardH + 12]
  const laneSides: Array<'above' | 'below'> = ['above', 'below', 'above', 'below']
  const placedByLane: number[][] = [[], [], [], []]
  const lanes: number[] = []
  events.forEach((_e, i) => {
    const x = xFor(i)
    let lane = -1
    for (let l = 0; l < 4; l++) {
      if (placedByLane[l].every((px) => Math.abs(x - px) >= eventW + 14)) {
        lane = l
        break
      }
    }
    if (lane < 0) {
      let bestDist = -1
      for (let l = 0; l < 4; l++) {
        const d = placedByLane[l].length ? Math.min(...placedByLane[l].map((px) => Math.abs(x - px))) : Number.POSITIVE_INFINITY
        if (d > bestDist) {
          bestDist = d
          lane = l
        }
      }
    }
    placedByLane[lane].push(x)
    lanes.push(lane)
  })

  const eventHtml = events
    .map((e, i) => {
      const x = xFor(i)
      const lane = lanes[i]
      const above = laneSides[lane] === 'above'
      const wrapperLeft = Math.max(0, Math.min(plotW - eventW, Math.round(x - eventW / 2)))
      const nodeLeft = Math.round(x - wrapperLeft)
      const wrapperTop = laneTops[lane]
      const nodeTop = axisY - wrapperTop
      const stemTop = above ? cardH : nodeTop
      const stemHeight = above ? nodeTop - cardH : -nodeTop
      const labelFit = fitted(
        String(e.label),
        {
          family: ctx.style.fontBody,
          weight: 700,
          nominal: 22,
          maxWidth: eventW - 24,
          maxHeight: 50,
          min: 12,
          lineHeight: 1.15,
          maxLines: 2
        },
        ctx,
        `timeline event ${i + 1}`
      )
      const noteFit = e.note
        ? fitted(
            String(e.note),
            { family: ctx.style.fontBody, weight: 500, nominal: 13, maxWidth: eventW - 24, maxHeight: 16, min: 9, lineHeight: 1.2, maxLines: 1 },
            ctx,
            `timeline note ${i + 1}`
          )
        : null
      return `        <div class="tl-event tl-${above ? 'above' : 'below'} tl-lane-${lane} tl-${i}${e.highlight ? ' tl-on' : ''}" style="left:${wrapperLeft}px;top:${wrapperTop}px;width:${eventW}px">
          <div class="tl-card" style="height:${cardH}px">
            ${Number.isFinite(Number(e.year)) ? `<div class="tl-year-in">${esc(String(e.year))}</div>` : ''}
            <div class="tl-label"${labelFit.attr}>${esc(String(e.label))}</div>
            ${e.note ? `<div class="tl-note"${noteFit?.attr ?? ''}>${esc(String(e.note))}</div>` : ''}
          </div>
          <div class="tl-stem" style="left:${nodeLeft}px;top:${stemTop}px;height:${Math.max(4, stemHeight)}px"></div>
          <div class="tl-node" style="left:${nodeLeft}px;top:${nodeTop}px"></div>
        </div>`
    })
    .join('\n')

  return wideCardShell({
    card,
    ctx,
    cardW: wide.cardW,
    contentW: wide.contentW,
    className: 'timeline-card',
    kickerHtml,
    titleHtml,
    body: `        <div class="timeline-plot" style="width:${plotW}px;height:${plotH}px">
          <div class="tl-axis" style="top:${axisY}px"></div>
${eventHtml}
        </div>`
  })
}

/** Animated location map (data-map) on a Natural Earth dot mask. */
interface MapMarker {
  label: string
  lat?: number
  lon?: number
  note?: string
  highlight?: boolean
}

function mapCardHtml(card: DataCard, ctx: FitContext, kickerHtml: string, titleHtml: string): string | null {
  const markersIn: MapMarker[] = Array.isArray(card.markers)
    ? card.markers.filter((m) => String(m.label ?? '').trim()).map((m) => ({ ...m, label: String(m.label) }))
    : []
  if (markersIn.length === 0) return null
  const wide = wideCardGeometry(ctx, 1560)
  const W = Math.round(wide.contentW)
  const H = Math.min(560, Math.round(W * 0.4))
  const lon0 = WORLD_MASK.lon0
  const lon1 = WORLD_MASK.lon1
  const lat0 = WORLD_MASK.lat0
  const lat1 = WORLD_MASK.lat1
  const project = (lat: number, lon: number): { x: number; y: number } => ({
    x: ((lon - lon0) / (lon1 - lon0)) * W,
    y: ((lat0 - lat) / (lat0 - lat1)) * H
  })

  const dots: string[] = []
  for (let r = 0; r < WORLD_MASK.rows; r++) {
    const row = WORLD_MASK.data[r]
    for (let c = 0; c < WORLD_MASK.cols; c++) {
      if (row[c] !== '1') continue
      const x = ((c + 0.5) / WORLD_MASK.cols) * W
      const y = ((r + 0.5) / WORLD_MASK.rows) * H
      dots.push(`M${x.toFixed(1)} ${y.toFixed(1)}h0.01`)
    }
  }

  const mapped: Array<{ m: MapMarker; x: number; y: number; labelW: number; labelH: number; lx: number; ly: number; above: boolean }> = []
  const unmapped: string[] = []
  for (const m of markersIn) {
    const hasCoords = Number.isFinite(Number(m.lat)) && Number.isFinite(Number(m.lon))
    const pt = hasCoords ? { lat: Number(m.lat), lon: Number(m.lon) } : lookupPlace(String(m.label))
    if (!pt) {
      unmapped.push(String(m.label))
      continue
    }
    const lat = Math.max(lat1, Math.min(lat0, pt.lat))
    const lon = Math.max(lon0, Math.min(lon1, pt.lon))
    const { x, y } = project(lat, lon)
    const nameFit = fitted(
      String(m.label),
      { family: ctx.style.fontBody, weight: 700, nominal: 22, maxWidth: 220, min: 11, maxLines: 1 },
      ctx,
      'map label'
    )
    const noteFit = m.note
      ? fitted(String(m.note), { family: ctx.style.fontBody, weight: 500, nominal: 14, maxWidth: 220, min: 9, maxLines: 1 }, ctx, 'map note')
      : null
    const nameW = measureText(String(m.label), nameFit.sizePx, { family: ctx.style.fontBody, weight: 700 })
    const noteW = m.note ? measureText(String(m.note), noteFit?.sizePx ?? 14, { family: ctx.style.fontBody, weight: 500 }) : 0
    const labelW = Math.min(260, Math.max(120, Math.ceil(Math.max(nameW, noteW)) + 28))
    const labelH = m.note ? 58 : 38
    const above = y > labelH + 30
    const lx = Math.max(4, Math.min(W - labelW - 4, Math.round(x - labelW / 2)))
    const ly = above ? Math.round(y - labelH - 26) : Math.round(y + 26)
    mapped.push({ m, x, y, labelW, labelH, lx, ly, above })
  }

  // Simple label-collision avoidance: flip, then nudge vertically.
  const rects: Array<{ x: number; y: number; w: number; h: number }> = []
  for (const p of mapped) {
    const candidate = { x: p.lx, y: p.ly, w: p.labelW, h: p.labelH }
    const hits = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean =>
      a.x < b.x + b.w + 6 && a.x + a.w + 6 > b.x && a.y < b.y + b.h + 6 && a.y + a.h + 6 > b.y
    if (rects.some((r) => hits(candidate, r))) {
      const flippedY = p.above ? p.y + 26 : p.y - p.labelH - 26
      const flipped = { x: p.lx, y: Math.max(2, Math.min(H - p.labelH - 2, flippedY)), w: p.labelW, h: p.labelH }
      if (!rects.some((r) => hits(flipped, r))) {
        p.ly = flipped.y
        p.above = !p.above
      } else {
        p.ly = Math.max(2, Math.min(H - p.labelH - 2, p.ly + (p.above ? -(p.labelH + 8) : p.labelH + 8)))
      }
    }
    rects.push({ x: p.lx, y: p.ly, w: p.labelW, h: p.labelH })
  }

  const pins = mapped
    .map((p, i) => {
      const nameFit = fitted(
        String(p.m.label),
        { family: ctx.style.fontBody, weight: 700, nominal: 22, maxWidth: p.labelW - 24, min: 11, maxLines: 1 },
        ctx,
        'map label'
      )
      const noteFit = p.m.note
        ? fitted(String(p.m.note), { family: ctx.style.fontBody, weight: 500, nominal: 14, maxWidth: p.labelW - 24, min: 9, maxLines: 1 }, ctx, 'map note')
        : null
      const leaderY = p.above ? p.ly + p.labelH : p.ly
      return `        <g class="map-pin map-pin-${i}${p.m.highlight ? ' map-pin-on' : ''}">
          <circle class="map-pulse" cx="${round3(p.x)}" cy="${round3(p.y)}" r="10"/>
          <circle class="map-hit" cx="${round3(p.x)}" cy="${round3(p.y)}" r="7"/>
          <line class="map-leader" x1="${round3(p.x)}" y1="${round3(p.y)}" x2="${round3(p.x)}" y2="${round3(leaderY)}"/>
          <g class="map-label" transform="translate(${p.lx},${p.ly})">
            <rect class="map-label-bg" width="${p.labelW}" height="${p.labelH}" rx="3"/>
            <text class="map-label-name" x="12" y="23" font-size="${nameFit.sizePx}">${esc(String(p.m.label))}</text>
            ${p.m.note ? `<text class="map-label-note" x="12" y="44" font-size="${noteFit?.sizePx ?? 14}">${esc(String(p.m.note))}</text>` : ''}
          </g>
        </g>`
    })
    .join('\n')

  let route = ''
  if (card.route && mapped.length >= 2) {
    let d = `M${round3(mapped[0].x)} ${round3(mapped[0].y)}`
    for (let i = 1; i < mapped.length; i++) {
      const a = mapped[i - 1]
      const b = mapped[i]
      const mx = round3((a.x + b.x) / 2)
      const my = round3(Math.max(6, Math.min(a.y, b.y) - Math.min(70, Math.abs(b.x - a.x) * 0.12) - 10))
      d += ` Q${mx} ${my} ${round3(b.x)} ${round3(b.y)}`
    }
    route = `<path class="map-route" pathLength="1" d="${d}"/>`
  }

  const unmappedHtml = unmapped.length
    ? `<div class="map-unmapped">Not mapped (no coordinates): ${esc(unmapped.join(', '))}</div>`
    : ''
  return wideCardShell({
    card,
    ctx,
    cardW: wide.cardW,
    contentW: wide.contentW,
    className: 'map-card',
    kickerHtml,
    titleHtml,
    body: `        <div class="map-wrap" style="width:${W}px;height:${H}px">
          <svg class="map-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" width="100%" height="${H}">
            <path class="map-dots" d="${dots.join('')}"/>
${route}
${pins}
          </svg>
        </div>
        <div class="map-meta"><span>EQUIRECTANGULAR · NATURAL EARTH 110m</span></div>
        ${unmappedHtml}`
  })
}

/** Reconstructed article clipping with an animated highlighter (data-article). */
function articleCardHtml(card: DataCard, ctx: FitContext, kickerHtml: string, titleHtml: string): string | null {
  const headline = String(card.headline ?? card.title ?? '').trim()
  const quote = String(card.quote ?? '').trim()
  if (!headline && !quote) return null
  const wide = wideCardGeometry(ctx, 1120)
  const quoteText = quote ? (/^[“"']/.test(quote) ? quote : `“${quote}”`) : ''
  const bodyMax = Math.min(940, wide.contentW)
  const quoteMax = Math.min(1000, wide.contentW) - 44
  const headlineFit = headline
    ? fitted(
        headline,
        {
          family: ctx.style.fontHead,
          weight: ctx.style.headWeight,
          nominal: 64,
          maxWidth: wide.contentW,
          maxHeight: 230,
          min: 28,
          lineHeight: 1.04,
          caps: ctx.design === 'editorial',
          maxLines: 3
        },
        ctx,
        'article headline'
      )
    : null
  const bodyFit = card.body
    ? fitted(
        String(card.body),
        { family: ctx.style.fontBody, weight: 400, nominal: 26, maxWidth: bodyMax, maxHeight: 180, min: 15, lineHeight: 1.5, maxLines: 4 },
        ctx,
        'article body'
      )
    : null
  const quoteFit = quoteText
    ? fitted(
        quoteText,
        { family: ctx.style.fontHead, weight: 400, nominal: 46, maxWidth: quoteMax, maxHeight: 150, min: 20, lineHeight: 1.22, maxLines: 2 },
        ctx,
        'article quote'
      )
    : null
  const attrFit = card.attribution
    ? fitted(
        String(card.attribution),
        { family: ctx.style.fontBody, weight: 600, nominal: 20, maxWidth: wide.contentW, min: 11, trackingEm: 0.08, maxLines: 1 },
        ctx,
        'article attribution'
      )
    : null
  const pub = [card.publication, card.date].filter(Boolean).map(String).join(' · ')
  const tag = `FROM THE ARTICLE · RECONSTRUCTION${card.publication ? ` · ${String(card.publication).toUpperCase()}` : ''}`

  return wideCardShell({
    card,
    ctx,
    cardW: wide.cardW,
    contentW: wide.contentW,
    className: 'article-card',
    kickerHtml,
    titleHtml: '',
    body: `        <div class="article-tag">${esc(tag)}</div>
        ${pub ? `<div class="article-pub">${esc(pub)}</div>` : ''}
        ${headline ? `<div class="article-headline"${headlineFit?.attr ?? ''}>${esc(headline)}</div>` : ''}
        <div class="article-rule"></div>
        ${card.body ? `<div class="article-body"${bodyFit?.attr ?? ''}>${esc(String(card.body))}</div>` : ''}
        ${
          quoteText
            ? `<div class="article-quote-wrap"><span class="article-mark"></span><div class="article-quote"${quoteFit?.attr ?? ''}>${esc(quoteText)}</div></div>`
            : ''
        }
        ${card.attribution ? `<div class="article-attr"${attrFit?.attr ?? ''}>— ${esc(String(card.attribution))}</div>` : ''}`
  })
}

function grainCss(style: StyleTokens): string {
  return `background-image:url("${GRAIN_SVG}");opacity:${style.grain};mix-blend-mode:multiply;`
}

const VIDEO_EXT = /\.(mp4|webm|mov)$/i

/** A note that is itself a formatted number (money "$2,646", range "12–15%") may display as the value. */
function isNumericNote(note: string | undefined): boolean {
  if (!note) return false
  return /\d/.test(note) && /[%€$]/.test(note)
}

/** The big display text: the NUMBER first ("50%", "$2,646"); a prose note like
 *  "vs AlphaFold 2" is an annotation, never the headline figure. '%' is a
 *  suffix ("50%"); symbol units stay prefixes ("#30"); word units separate
 *  ("Score 78", never "Score78"). */
function displayValue(value: number | undefined, unit: string | undefined, note: string | undefined): string {
  if (value !== undefined && Number.isFinite(value)) {
    if (note && isNumericNote(note)) return note
    const u = unit ?? ''
    if (u === '%') return `${value}${u}`
    if (/^[A-Za-z]/.test(u)) return `${u} ${value}`
    return `${u}${value}`
  }
  return note ?? ''
}

/** Small annotation under a stat's label ("" when the note was consumed as the value). */
function annotationOf(value: number | undefined, note: string | undefined): string {
  return value !== undefined && Number.isFinite(value) && !isNumericNote(note) ? (note ?? '') : ''
}

/** Data-card HTML (bars / stat / list) — the data-visualization channel.
 *  Cards sit on a solid panel (style.panel) so numbers never fight footage.
 *  Every string is fitted to the panel's content box (2026-11-16 layout pass):
 *  a prose note becomes a pull-quote instead of a 200px "figure", and a card
 *  title that merely repeats the figure is suppressed. */
function dataCardHtml(shot: CompositionShot, ctx: FitContext, extra: { sceneLabel: string }): string | null {
  let card = shot.data
  if (!card && Array.isArray(shot.items) && shot.items.length > 0) {
    card = { kind: 'list', title: shot.text || undefined, items: shot.items.map((label) => ({ label })) }
  }
  if (!card) {
    const tk = templateKind(shot.template)
    if (tk === 'bars' || tk === 'stat' || tk === 'list' || tk === 'line' || tk === 'timeline' || tk === 'map' || tk === 'article') {
      card = { kind: tk, items: [] }
    }
  }
  if (!card) return null
  const wideKind = card.kind === 'line' || card.kind === 'timeline' || card.kind === 'map' || card.kind === 'article'
  if (!wideKind && card.items.length === 0) return null
  const wide = wideKind ? wideCardGeometry(ctx, card.kind === 'article' ? 1240 : 1560) : null

  const T = DESIGN_TYPE[ctx.design]
  const contentW = wide ? wide.contentW : dataContentWidth(ctx.design, ctx.designWidth)
  const kicker = DESIGN_KICKER[ctx.design]
  const kickerFit = extra.sceneLabel
    ? fitted(
        extra.sceneLabel,
        {
          family: kicker.mono ? ctx.style.mono : ctx.style.fontBody,
          weight: 600,
          nominal: kicker.px,
          maxWidth: contentW,
          min: 11,
          trackingEm: kicker.trackingEm,
          caps: true,
          maxLines: 1
        },
        ctx,
        'data-card kicker'
      )
    : null
  const kickerHtml = extra.sceneLabel ? `<div class="card-kicker"${kickerFit?.attr ?? ''}>${esc(extra.sceneLabel)}</div>` : ''
  const titleFit = card.title
    ? fitted(
        card.title,
        {
          family: ctx.style.fontHead,
          weight: ctx.style.headWeight,
          nominal: T.dataTitle,
          maxWidth: contentW,
          maxHeight: 220,
          min: 24,
          lineHeight: T.dataTitleLine,
          maxLines: 2
        },
        ctx,
        'data-card title'
      )
    : null
  const titleHtml = card.title ? `<div class="data-title"${titleFit?.attr ?? ''}>${esc(card.title)}</div>` : ''

  if (card.kind === 'line') return lineCardHtml(card, ctx, kickerHtml, titleHtml)
  if (card.kind === 'timeline') return timelineCardHtml(card, ctx, kickerHtml, titleHtml)
  if (card.kind === 'map') return mapCardHtml(card, ctx, kickerHtml, titleHtml)
  if (card.kind === 'article') return articleCardHtml(card, ctx, kickerHtml, titleHtml)

  if (card.kind === 'bars') {
    const values = card.items.map((it) => (Number.isFinite(it.value) ? (it.value as number) : 0))
    const max = Math.max(...values, 0.0001)
    const labelW = ctx.design === 'editorial' ? 320 : 340
    const valueW = ctx.design === 'editorial' ? 180 : 170
    const rows = card.items
      .map((it, bi) => {
        const w = Math.max(4, Math.round(((Number.isFinite(it.value) ? (it.value as number) : 0) / max) * 100))
        const labelFit = fitted(
          it.label,
          {
            family: DESIGN_KICKER[ctx.design].mono ? ctx.style.mono : ctx.style.fontBody,
            weight: 600,
            nominal: DESIGN_BAR_LABEL[ctx.design],
            maxWidth: labelW,
            min: 13,
            trackingEm: 0.06,
            caps: true,
            maxLines: 1
          },
          ctx,
          `bar ${bi + 1} label`
        )
        const valueText = displayValue(it.value, card!.unit, it.note)
        const valueFit = valueText
          ? fitted(
              valueText,
              {
                family: ctx.style.fontHead,
                weight: ctx.style.headWeight,
                nominal: DESIGN_BAR_VALUE[ctx.design],
                maxWidth: valueW,
                min: 15,
                maxLines: 1
              },
              ctx,
              `bar ${bi + 1} value`
            )
          : null
        return `      <div class="bar-row bar-row-${bi}">
        <div class="bar-label"${labelFit.attr}>${esc(it.label)}</div>
        <div class="bar-track"><div class="bar-fill bar-fill-${bi}" style="width:${w}%"></div></div>
        <div class="bar-value"${valueFit?.attr ?? ''}>${esc(valueText)}</div>
      </div>`
      })
      .join('\n')
    return `    <div class="shot shot-$IDX card-shot$LY" data-shot="$IDX">
      <div class="card data-card">
        ${kickerHtml}
        ${titleHtml}
        <div class="bars">
${rows}
        </div>
      </div>
    </div>`
  }

  if (card.kind === 'stat') {
    const it = card.items[0]
    const quoteMode = statIsQuote(card)
    const display = displayValue(it.value, card.unit, it.note)
    // A title that repeats the figure ("1,000+" over "1000") is noise, and a
    // title repeating a quote's own first phrase is redundant.
    const omitTitle = Boolean(card.title && titleRepeatsValue(card.title, quoteMode ? statQuoteText(card) : display))
    const effectiveTitle = omitTitle ? '' : titleHtml
    if (omitTitle) ctx.note?.(`${ctx.sceneId}: stat card title repeats the figure — suppressed`)

    if (quoteMode) {
      const quote = statQuoteText(card)
      const quoteFit = fitted(
        quote,
        {
          family: ctx.style.fontHead,
          weight: ctx.design === 'editorial' ? ctx.style.headWeight : 400,
          nominal: T.statQuote,
          maxWidth: contentW,
          maxHeight: 420,
          min: 24,
          lineHeight: T.statQuoteLine,
          trackingEm: -0.02,
          caps: ctx.design === 'editorial',
          maxLines: 4
        },
        ctx,
        'stat pull-quote'
      )
      const label = String(it.label ?? '').trim()
      const labelFit = label && label !== quote.trim()
        ? fitted(
            label,
            {
              family: DESIGN_KICKER[ctx.design].mono ? ctx.style.mono : ctx.style.fontBody,
              weight: 600,
              nominal: T.statLabel,
              maxWidth: contentW,
              min: 13,
              trackingEm: 0.16,
              caps: true,
              maxLines: 2
            },
            ctx,
            'stat label'
          )
        : null
      ctx.note?.(`${ctx.sceneId}: prose stat note rendered as a fitted pull-quote, not a display figure`)
      return `    <div class="shot shot-$IDX card-shot$LY" data-shot="$IDX">
      <div class="card data-card stat-card">
        ${kickerHtml}
        ${effectiveTitle}
        <div class="stat-quote"${quoteFit.attr}>${esc(quote)}</div>
        ${label && label !== quote.trim() ? `<div class="stat-label"${labelFit?.attr ?? ''}>${esc(label)}</div>` : ''}
      </div>
    </div>`
    }

    const note = annotationOf(it.value, it.note)
    const valueFit = fitted(
      display,
      {
        family: ctx.style.fontHead,
        weight: ctx.style.headWeight,
        nominal: T.statValue,
        maxWidth: contentW,
        maxHeight: 260,
        min: 64,
        lineHeight: 1,
        trackingEm: -0.02,
        maxLines: 1
      },
      ctx,
      'stat figure'
    )
    const labelFit = fitted(
      it.label,
      {
        family: DESIGN_KICKER[ctx.design].mono ? ctx.style.mono : ctx.style.fontBody,
        weight: 600,
        nominal: T.statLabel,
        maxWidth: contentW,
        min: 13,
        trackingEm: 0.16,
        caps: true,
        maxLines: 2
      },
      ctx,
      'stat label'
    )
    const noteFit = note
      ? fitted(
          note,
          {
            family: DESIGN_KICKER[ctx.design].mono ? ctx.style.mono : ctx.style.fontBody,
            weight: 600,
            nominal: DESIGN_STAT_NOTE[ctx.design],
            maxWidth: contentW,
            min: 13,
            trackingEm: 0.06,
            maxLines: 2
          },
          ctx,
          'stat note'
        )
      : null
    return `    <div class="shot shot-$IDX card-shot$LY" data-shot="$IDX">
      <div class="card data-card stat-card">
        ${kickerHtml}
        ${effectiveTitle}
        <div class="stat-value"${valueFit.attr}>${esc(display)}</div>
        <div class="stat-label"${labelFit.attr}>${esc(it.label)}</div>
        ${note ? `<div class="stat-note"${noteFit?.attr ?? ''}>${esc(note)}</div>` : ''}
      </div>
    </div>`
  }

  // list (ranked rows / enumerations). A value that just repeats the row's
  // own ordinal (1, 2, 3…) is redundant with the accent numeral — hide it.
  const listMaxLines = card.items.length > 4 ? 1 : 2
  const rows = card.items
    .map((it, li) => {
      const redundant = it.value !== undefined && Number.isFinite(it.value) && it.value === li + 1
      const valueText = it.value !== undefined && !redundant ? displayValue(it.value, card!.unit, it.note) : ''
      const labelFit = fitted(
        it.label,
        {
          family: ctx.design === 'newsprint' ? ctx.style.fontHead : ctx.style.fontBody,
          weight: ctx.design === 'editorial' || ctx.design === 'case-file' ? 600 : 400,
          nominal: DESIGN_LIST_LABEL[ctx.design],
          maxWidth: contentW - 70 - (valueText ? 150 : 0),
          min: 16,
          lineHeight: 1.15,
          maxLines: listMaxLines
        },
        ctx,
        `list row ${li + 1} label`
      )
      const valueFit = valueText
        ? fitted(
            valueText,
            { family: ctx.style.fontHead, weight: ctx.style.headWeight, nominal: 32, maxWidth: 150, min: 16, maxLines: 1 },
            ctx,
            `list row ${li + 1} value`
          )
        : null
      const value = valueText ? `<span class="list-value"${valueFit?.attr ?? ''}>${esc(valueText)}</span>` : ''
      return `      <div class="list-row list-row-${li}"><span class="list-num">${li + 1}</span><span class="list-label"${labelFit.attr}>${esc(it.label)}</span>${value}</div>`
    })
    .join('\n')
  return `    <div class="shot shot-$IDX card-shot$LY" data-shot="$IDX">
      <div class="card data-card list-card">
        ${kickerHtml}
        ${titleHtml}
        <div class="list-rows">
${rows}
        </div>
      </div>
    </div>`
}

/** Media file names for one shot: the single-asset layer and duo panel assets. */
export interface ShotAssets {
  main: string | null
  panels: Array<string | null>
  /** Intrinsic size of the main image (null for video/unknown). */
  mainSize?: MediaSize | null
  /** Intrinsic sizes of duo panel images. */
  panelSizes?: Array<MediaSize | null>
  /** Baked frame sequence for a video main asset (null = still plate). */
  mainSeq?: BakedVideo | null
  /** Baked frame sequences for duo panel video assets. */
  panelSeqs?: Array<BakedVideo | null>
}

/** One duo panel — media (optional) above a fitted text block. */
function duoPanelHtml(
  panel: DuoPanel,
  pi: number,
  shotIndex: number,
  asset: string | null,
  size: MediaSize | null,
  durS: number,
  ctx: FitContext,
  panelSeq?: BakedVideo | null
): string {
  const geo = duoGeometry(ctx.design, ctx.designWidth)
  const mediaH = Math.round(geo.panelWidth * 0.62)
  // Portrait sources fill the panel with a top-anchored crop (a head/shoulders
  // portrait crop reads better than a 290 px sliver between blur bars).
  const portraitCover = Boolean(size && size.height > size.width * 1.05 && asset && !VIDEO_EXT.test(asset))
  let media = ''
  if (asset) {
    if (VIDEO_EXT.test(asset)) {
      // Duo panel footage uses the same baked-sequence playback as the main
      // video shot (a live <video> captures black under screenshot fallback).
      const style = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'
      const inner = panelSeq
        ? frameSequenceHtml(panelSeq, style)
        : `<img src="assets/${esc(asset)}" alt="" style="${style}">`
      media = `<div class="duo-media" style="height:${mediaH}px">${inner}</div>`
    } else {
      media = `<div class="duo-media${portraitCover ? ' duo-media-cover' : ''}" style="height:${mediaH}px">
          <div class="kb kb-${shotIndex}-${pi}"><img class="kb-bg" src="assets/${esc(asset)}" alt="" aria-hidden="true"><img class="kb-fg" src="assets/${esc(asset)}" alt=""></div>
        </div>`
    }
  }
  const kickerFit = panel.kicker
    ? fitted(
        panel.kicker,
        {
          family: DESIGN_KICKER[ctx.design].mono ? ctx.style.mono : ctx.style.fontBody,
          weight: 600,
          nominal: 15,
          maxWidth: geo.textWidth,
          min: 10,
          trackingEm: 0.2,
          caps: true,
          maxLines: 1
        },
        ctx,
        `duo panel ${pi + 1} kicker`
      )
    : null
  const title = String(panel.title ?? '').trim()
  const titleFit = title
    ? fitted(
        title,
        {
          family: ctx.style.fontHead,
          weight: ctx.style.headWeight,
          nominal: 46,
          maxWidth: geo.textWidth,
          maxHeight: 210,
          min: 24,
          lineHeight: 1.08,
          maxLines: 3
        },
        ctx,
        `duo panel ${pi + 1} title`
      )
    : null
  const note = String(panel.note ?? '').trim()
  const noteFit = note
    ? fitted(
        note,
        {
          family: ctx.style.fontBody,
          weight: 500,
          nominal: 20,
          maxWidth: geo.textWidth,
          maxHeight: 96,
          min: 13,
          lineHeight: 1.3,
          maxLines: 3
        },
        ctx,
        `duo panel ${pi + 1} note`
      )
    : null
  return `      <div class="duo-panel duo-panel-${pi}${asset ? '' : ' duo-panel-text'}">
        ${media}
        <div class="duo-text">
          ${panel.kicker ? `<div class="duo-kicker"${kickerFit?.attr ?? ''}>${esc(panel.kicker)}</div>` : ''}
          ${title ? `<div class="duo-title"${titleFit?.attr ?? ''}>${esc(title)}</div>` : ''}
          ${note ? `<div class="duo-note"${noteFit?.attr ?? ''}>${esc(note)}</div>` : ''}
        </div>
      </div>`
}

/** Duo shot layer: two equal panels side by side (image + text together). */
function duoLayerHtml(
  shot: CompositionShot,
  panels: DuoPanel[],
  assets: ShotAssets,
  i: number,
  durS: number,
  ctx: FitContext
): string {
  const geo = duoGeometry(ctx.design, ctx.designWidth)
  const ly = ctx.layout !== 'standard' ? ` ly-${ctx.layout}` : ''
  const html = panels
    .map((p, pi) =>
      duoPanelHtml(p, pi, i, assets.panels[pi] ?? null, assets.panelSizes?.[pi] ?? null, durS, ctx, assets.panelSeqs?.[pi] ?? null)
    )
    .join('\n')
  return `    <div class="shot shot-${i} duo-shot${ly}" data-shot="${i}">
      <div class="duo" style="width:${geo.width}px; gap:${geo.gap}px">
${html}
      </div>
    </div>`
}

/** Shot layer HTML for one scene (layout-first: every layer positioned absolutely).
 *  Images render as framed “evidence exhibits” (Ken-Burns inside the frame, source
 *  caption beneath); videos stay full-bleed under a bottom scrim so captions read.
 *  A full-bleed scene layout swaps the exhibit frame for cover media + scrim + caption.
 *  Cards (title / stat / quote / list / duo) fit every authored string to its box. */
function shotLayerHtml(
  sceneId: string,
  item: { shot: CompositionShot; durS: number; frames: number },
  i: number,
  assets: ShotAssets,
  sceneLabel: string,
  ctx: FitContext
): string {
  const shot = item.shot
  const ly = ctx.layout !== 'standard' ? ` ly-${ctx.layout}` : ''
  if (shot.kind === 'asset' && assets.main) {
    const caption = String(shot.text ?? '').trim()
    const fitCaption = (maxWidth: number, maxLines = 1) =>
      caption
        ? fitted(
            caption,
            {
              family: ctx.style.fontBody,
              weight: 600,
              nominal: DESIGN_EXHIBIT_CAP[ctx.design],
              maxWidth,
              min: 13,
              trackingEm: 0.04,
              maxLines
            },
            ctx,
            'media caption'
          )
        : null

    // `mainSeq` is set for footage: `main` then holds a frame path
    // (`seq_.../f0001.jpg`), so the extension alone no longer identifies video.
    if (VIDEO_EXT.test(assets.main) || assets.mainSeq) {
      // Downloaded footage plays from a baked frame sequence, not a live
      // <video>: when HyperFrames' BeginFrame probe fails it captures with
      // screenshots, where a <video> paints black and the clip never reaches
      // the master (2026-11-18 dogfood). The frames are real pixels, and the
      // per-shot GSAP driver (see frameSequenceTweens) steps them.
      const mediaStyle = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover'
      const media = assets.mainSeq
        ? frameSequenceHtml(assets.mainSeq, mediaStyle)
        : `<img src="assets/${esc(assets.main)}" alt="" style="${mediaStyle}">`
      if (ctx.layout === 'full-bleed') {
        // Cinema: cover the frame, keep a strong bottom scrim for the caption.
        const capFit = caption
          ? fitted(
              caption,
              { family: ctx.style.fontBody, weight: 600, nominal: 26, maxWidth: Math.round(ctx.designWidth * 0.66), min: 16, lineHeight: 1.25, maxLines: 2 },
              ctx,
              'full-bleed caption'
            )
          : null
        return `    <div class="shot shot-${i} bleed-shot" data-shot="${i}">
      <div class="kb kb-${i}">${media}</div>
      <div class="scrim"></div>
      ${caption ? `<div class="bleed-cap"${capFit?.attr ?? ''}>${esc(caption)}</div>` : ''}
    </div>`
      }
      // Standard layouts: a framed video plate on the design canvas. Full-bleed
      // video over a light paper skin made the masthead/footer illegal to read;
      // the plate keeps the skin's furniture on paper and the footage crisp.
      const vw = Math.round(Math.min(1100, Math.max(520, ctx.designWidth - 400)))
      const vh = Math.round(vw * 0.5625)
      const capFit = fitCaption(vw, 2)
      return `    <div class="shot shot-${i} video-shot${ly}" data-shot="${i}">
      <div class="media-plate video-plate" style="width:${vw}px;height:${vh}px">
        ${media}
      </div>
      ${caption ? `<div class="exhibit-cap"${capFit?.attr ?? ''}>${esc(caption)}</div>` : ''}
    </div>`
    }

    // Page screenshots (and any extremely tall page scan) get a browser plate:
    // the top of the page is shown at full width (a 1200×3600 screenshot
    // inside a landscape exhibit used to shrink to a 200 px sliver), with a
    // chrome bar naming the source host. A full-bleed scene keeps its cinema
    // treatment (below).
    if (ctx.layout !== 'full-bleed' && isPagePlate(shot.asset ?? '', assets.mainSize ?? null)) {
      const frame = screenshotFrame(assets.mainSize ?? null, ctx.designWidth)
      const host = screenshotHost(shot.asset ?? '') || caption || 'EVIDENCE'
      const capFit = fitCaption(frame.width, 1)
      return `    <div class="shot shot-${i} screen-shot${ly}" data-shot="${i}">
      <div class="media-plate screen-plate" style="width:${frame.width}px;height:${frame.height}px">
        <div class="screen-bar">
          <span class="screen-dots"><span class="screen-dot"></span><span class="screen-dot"></span><span class="screen-dot"></span></span>
          <span class="screen-url">${esc(host)}</span>
        </div>
        <div class="screen-body${frame.fit === 'cover-top' ? ' screen-body-top' : ''}">
          <div class="kb kb-${i}"><img src="assets/${esc(assets.main)}" alt=""></div>
        </div>
      </div>
      ${caption ? `<div class="exhibit-cap"${capFit?.attr ?? ''}>${esc(caption)}</div>` : ''}
    </div>`
    }

    if (ctx.layout === 'full-bleed') {
      // Full-bleed exhibit: the image IS the frame — cover media under the
      // bottom scrim, caption over the scrim (no border, no contain letterbox).
      const capFit = caption
        ? fitted(
            caption,
            { family: ctx.style.fontBody, weight: 600, nominal: 26, maxWidth: Math.round(ctx.designWidth * 0.66), min: 16, lineHeight: 1.25, maxLines: 2 },
            ctx,
            'full-bleed caption'
          )
        : null
      return `    <div class="shot shot-${i} bleed-shot" data-shot="${i}">
      <div class="kb kb-${i}"><img src="assets/${esc(assets.main)}" alt=""></div>
      <div class="scrim"></div>
      ${caption ? `<div class="bleed-cap"${capFit?.attr ?? ''}>${esc(caption)}</div>` : ''}
    </div>`
    }
    // Two-layer exhibit: blurred cover backdrop + contain foreground. A small
    // source (a logo) under cover-zoom became giant blurry letters (“GEH”,
    // 2025-11-15) — contain keeps small sources honest, the backdrop fills.
    // Portrait/square sources get a plate whose aspect matches the picture;
    // a landscape source keeps the skin's own frame geometry.
    const frame = imageFrame(assets.mainSize ?? null, ctx.designWidth)
    const frameStyle = frame ? ` style="width:${frame.width}px;height:${frame.height}px"` : ''
    const capFit = fitCaption(frame?.width ?? Math.min(1240, ctx.designWidth - 380), 1)
    return `    <div class="shot shot-${i} exhibit-shot${ly}" data-shot="${i}">
      <div class="exhibit"${frameStyle}>
        <div class="kb kb-${i}"><img class="kb-bg" src="assets/${esc(assets.main)}" alt="" aria-hidden="true"><img class="kb-fg" src="assets/${esc(assets.main)}" alt=""></div>
      </div>
      ${caption ? `<div class="exhibit-cap"${capFit?.attr ?? ''}>${esc(caption)}</div>` : ''}
    </div>`
  }

  // Duo: two boxes of image + text together, authored as one shot.
  if (templateKind(shot.template) === 'duo') {
    const panels = duoPanelsOf(shot)
    if (panels) return duoLayerHtml(shot, panels, assets, i, item.durS, ctx)
    ctx.note?.(`${sceneId}: duo shot lacks two panels with content — rendered as a title card`)
  }

  const dataHtml = dataCardHtml(shot, ctx, { sceneLabel })
  if (dataHtml) return dataHtml.replaceAll('$IDX', String(i)).replaceAll('$LY', ly)
  const kind = templateKind(shot.template)
  // Anti-empty guard (2025-11-15 stock-market film): a data-* shot without a
  // payload used to fall through to a title-card with an EMPTY headline — the
  // viewer saw a blank frame with only the kicker for the shot's whole
  // duration. A data-card moment without data becomes a large animated
  // chapter card carrying the scene label — never blank.
  const rawText = String(shot.text ?? '').trim() || sceneLabel || sceneId
  const text = esc(rawText)
  const tier = rawText.length <= 40 ? 'lg' : rawText.length <= 70 ? 'md' : 'sm'
  const nominal = layoutHeadlinePx(ctx.design, ctx.layout, tier)
  const T = DESIGN_TYPE[ctx.design]
  const headlineFit = fitted(
    rawText,
    {
      family: ctx.style.fontHead,
      weight: ctx.style.headWeight,
      nominal,
      maxWidth: cardContentWidth(ctx.design, ctx.layout, ctx.designWidth),
      maxHeight: 620,
      min: Math.max(26, Math.round(nominal * 0.42)),
      lineHeight: T.headlineLine,
      trackingEm: T.headlineTrackingEm,
      caps: T.headlineCaps,
      maxLines: 5
    },
    ctx,
    'headline'
  )
  const headlineClass = tier === 'md' ? 'headline-md' : tier === 'sm' ? 'headline-sm' : 'headline-lg'
  if (kind === 'stat' || kind === 'bars' || kind === 'list' || kind === 'line' || kind === 'timeline' || kind === 'map' || kind === 'article') {
    return `    <div class="shot shot-${i} card-shot${ly}" data-shot="${i}">
      <div class="card title-card chapter-card">
        ${sceneLabel ? `<div class="card-kicker">${esc(sceneLabel)}</div>` : ''}
        <div class="card-headline ${headlineClass}"${headlineFit.attr}>${text}</div>
        <div class="headline-rule"></div>
      </div>
    </div>`
  }
  if (kind === 'title') {
    return `    <div class="shot shot-${i} card-shot${ly}" data-shot="${i}">
      <div class="card title-card">
        ${sceneLabel ? `<div class="card-kicker">${esc(sceneLabel)}</div>` : ''}
        <div class="card-headline ${headlineClass}"${headlineFit.attr}>${text}</div>
        <div class="headline-rule"></div>
      </div>
    </div>`
  }
  if (kind === 'end') {
    return `    <div class="shot shot-${i} card-shot${ly}" data-shot="${i}">
      <div class="card end-card">
        <div class="card-kicker">A documentary short</div>
        <div class="card-headline ${headlineClass}"${headlineFit.attr}>${text}</div>
        <div class="headline-rule"></div>
        <div class="card-note">Full sources, evidence, and credits in the description.</div>
      </div>
    </div>`
  }
  if (kind === 'lower') {
    const lowerFit = fitted(
      rawText,
      {
        family: ctx.design === 'glass' || ctx.design === 'vivid' ? ctx.style.fontHead : ctx.style.mono,
        weight: 600,
        nominal: DESIGN_LOWER_THIRD[ctx.design],
        maxWidth: Math.min(1400, ctx.designWidth - 300),
        min: 15,
        trackingEm: 0.12,
        caps: true,
        maxLines: 1
      },
      ctx,
      'lower third'
    )
    return `    <div class="shot shot-${i} card-shot overlay-shot${ly}" data-shot="${i}">
      <div class="lower-third">
        <div class="lower-bar"></div>
        <div class="lower-text"${lowerFit.attr}>${text}</div>
      </div>
    </div>`
  }
  if (kind === 'quote' || kind === 'source') {
    const quote = splitQuote(rawText)
    const quoteFit = fitted(
      quote.body,
      {
        family: ctx.style.fontHead,
        weight: 400,
        nominal: T.quoteText,
        maxWidth: quoteContentWidth(ctx.design, ctx.designWidth),
        maxHeight: 520,
        min: 28,
        lineHeight: T.quoteLine,
        caps: ctx.design === 'editorial',
        maxLines: 4
      },
      ctx,
      'quote text'
    )
    const attrFit = quote.attribution
      ? fitted(
          quote.attribution,
          { family: ctx.style.fontBody, weight: 500, nominal: 28, maxWidth: quoteContentWidth(ctx.design, ctx.designWidth), min: 16, trackingEm: 0.08, maxLines: 1 },
          ctx,
          'quote attribution'
        )
      : null
    return `    <div class="shot shot-${i} card-shot${ly}" data-shot="${i}">
      <div class="card quote-card">
        <div class="quote-mark">“</div>
        <div class="quote-text"${quoteFit.attr}>${esc(quote.body)}</div>
        ${quote.attribution ? `<div class="quote-attr"${attrFit?.attr ?? ''}>— ${esc(quote.attribution)}</div>` : ''}
      </div>
    </div>`
  }
  return `    <div class="shot shot-${i} card-shot${ly}" data-shot="${i}">
      <div class="card title-card">
        ${sceneLabel ? `<div class="card-kicker">${esc(sceneLabel)}</div>` : ''}
        <div class="card-headline ${headlineClass}"${headlineFit.attr}>${text}</div>
        <div class="headline-rule"></div>
      </div>
    </div>`
}

const KENBURNS_PATHS = [
  { from: { scale: 1.0, xPct: 0, yPct: 0 }, to: { scale: 1.1, xPct: -1.2, yPct: -0.8 } },
  { from: { scale: 1.12, xPct: -1.5, yPct: 0 }, to: { scale: 1.0, xPct: 0, yPct: 0.5 } },
  { from: { scale: 1.0, xPct: 1.0, yPct: -0.5 }, to: { scale: 1.08, xPct: 0, yPct: 0 } },
  { from: { scale: 1.06, xPct: 0, yPct: 0.8 }, to: { scale: 1.0, xPct: -0.8, yPct: 0 } }
]

/** Slowest Ken Burns zoom allowed: ~1.5 % scale change per second (research §4.1). */
const KENBURNS_MIN_RATE = 0.015

/** Per-shot motion (workflow shot.motion — live since the 2026-11-16 visual
 *  direction pass): kenburns keeps the four-path 1.5 %/s attention band
 *  (research §4.1 — eased in/out, authored zoom as the end-scale floor, long
 *  shots widen the travel so slow zooms never read as a dead still);
 *  push-in/pull-out are axial zooms on the same band; pans travel laterally
 *  with scale headroom (.kb bleeds 6 % per side); still locks the frame.
 *  Unknown values fall back to kenburns. Single absolute-tween writer per
 *  element (lint: no relative values, no overlapping writers). */
function assetMotionTweens(selector: string, motion: string | undefined, salt: number, dur: number, zoom: number, t: number): string[] {
  const m = (motion || 'kenburns').toLowerCase()
  const sel = `'${selector}'`
  if (m === 'still') return []
  if (m === 'push-in' || m === 'pull-out') {
    const end = round3(Math.min(1.35, Math.max(zoom, 1.0 + KENBURNS_MIN_RATE * dur)))
    return [
      m === 'push-in'
        ? `      tl.fromTo(${sel}, { scale: 1.0 }, { scale: ${end}, duration: ${dur}, ease: 'power1.inOut' }, ${t});`
        : `      tl.fromTo(${sel}, { scale: ${end} }, { scale: 1.0, duration: ${dur}, ease: 'power1.inOut' }, ${t});`
    ]
  }
  if (m === 'pan-left' || m === 'pan-right') {
    const head = 1.12
    const half = Math.min(5, Math.max(1.2, dur)) / 2
    const x0 = round3(m === 'pan-left' ? half : -half)
    const x1 = round3(m === 'pan-left' ? -half : half)
    return [`      tl.fromTo(${sel}, { scale: ${head}, xPercent: ${x0} }, { scale: ${head}, xPercent: ${x1}, duration: ${dur}, ease: 'power1.inOut' }, ${t});`]
  }
  const p = KENBURNS_PATHS[Math.abs(salt) % KENBURNS_PATHS.length]
  const travel = Math.min(1.35 - zoom, Math.max(zoom * 0.02, KENBURNS_MIN_RATE * dur))
  const to = { ...p.to, scale: Math.min(1.35, zoom + travel) }
  const from = { ...p.from, scale: Math.max(1.0, to.scale - travel) }
  return [
    `      tl.fromTo(${sel}, { scale: ${from.scale}, xPercent: ${from.xPct}, yPercent: ${from.yPct} }, { scale: ${to.scale}, xPercent: ${to.xPct}, yPercent: ${to.yPct}, duration: ${dur}, ease: 'power1.inOut' }, ${t});`
  ]
}

/**
 * Emit one scene sub-composition (HyperFrames <template> convention: paused
 * timeline in window.__timelines, entrance animations only, transitions own
 * the exits — incoming scene fades IN over the outgoing scene).
 *
 * Layout is authored in the DESIGN space (the master resolution); the whole
 * canvas is transform-scaled into the render frame, so the 720p draft variant
 * and any future aspect share identical scene HTML with pixel-identical framing.
 */
export function renderSceneHtml(opts: {
  scene: CompositionScene
  timing: SceneTiming
  scaledShots: Array<{ shot: CompositionShot; durS: number; frames: number }>
  /** Per-shot media files (main layer + duo panels). */
  assetFiles: ShotAssets[]
  /** Film or scene-resolved tokens (SceneStyleTokens carries the mood grade). */
  style: StyleTokens
  sceneLabel: string
  isFinalScene: boolean
  width: number
  height: number
  /** Design space the px values are authored against (defaults to width/height). */
  designWidth?: number
  designHeight?: number
  fps: number
  /** VO word timings for this scene's section (kinetic captions). */
  words?: RawWordTiming[]
  /** This scene's beat (re-hook card + pattern interrupt), local start already computed. */
  beat?: { label: string; rehook: boolean; patternInterrupt: string | null; localStartS: number } | null
  /** Effective transitions (authored → transition_set fallback). Defaults to the scene's authored pair. */
  transitionIn?: string
  transitionOut?: string
  /** The Director's scene layout (visual direction pass). Defaults to standard. */
  layout?: string
  /** 1-based scene index + total (design furniture: numerals, page numbers). */
  sceneIndex?: number
  sceneTotal?: number
  /** Film title (design furniture brand line). */
  projectTitle?: string
  /** Producer audit sink: fitted-text fallbacks and non-fatal layout repairs. */
  layoutNotes?: string[]
}): string {
  const { scene, timing, scaledShots, assetFiles, style, sceneLabel, isFinalScene, width, height, fps } = opts
  const designWidth = opts.designWidth ?? width
  const designHeight = opts.designHeight ?? height
  const canvasScale = Math.min(width / designWidth, height / designHeight)
  const compId = `scene-${scene.id}`
  const transIn = (opts.transitionIn ?? scene.transitions?.in ?? 'fade').toLowerCase()
  const transOut = (opts.transitionOut ?? scene.transitions?.out ?? 'crossfade').toLowerCase()
  const layout: VisualLayout = opts.layout && isVisualLayout(opts.layout) ? opts.layout : 'standard'
  const grade = (style as SceneStyleTokens).grade ?? null
  const fitCtx: FitContext = {
    style,
    design: style.design as DesignKey,
    designWidth,
    layout,
    sceneId: scene.id,
    note: opts.layoutNotes ? (message) => opts.layoutNotes!.push(message) : undefined
  }
  const seenNotes = new Set<string>()
  const note = fitCtx.note
  if (note) {
    fitCtx.note = (message) => {
      if (seenNotes.has(message)) return
      seenNotes.add(message)
      note(message)
    }
  }

  // Shot layer visibility + Ken Burns + card entrances, one tween set per shot.
  const tweens: string[] = []
  let localFrame = 0
  for (let i = 0; i < scaledShots.length; i++) {
    const item = scaledShots[i]
    const shot = item.shot
    const t = round3(localFrame / fps)
    const dur = round3(item.frames / fps)
    const isFirst = i === 0
    if (!isFirst) {
      // Graphics-to-graphics cuts must never stack text on text (the 2026-11-16
      // foundation film showed a ghost card bleeding through the next card for
      // 0.3s). Media keeps a soft crossfade; cards hide the outgoing layer at
      // the cut and fade in over the clean background.
      const prevShot = scaledShots[i - 1].shot
      const incomingMedia =
        shot.kind === 'asset' ||
        (templateKind(shot.template) === 'duo' && (duoPanelsOf(shot) ?? []).some((p) => Boolean(p.asset)))
      const outgoingMedia =
        prevShot.kind === 'asset' ||
        (templateKind(prevShot.template) === 'duo' && (duoPanelsOf(prevShot) ?? []).some((p) => Boolean(p.asset)))
      if (!incomingMedia && !outgoingMedia) {
        tweens.push(`      tl.set('.shot-${i - 1}', { opacity: 0 }, ${t});`)
        tweens.push(`      tl.fromTo('.shot-${i}', { opacity: 0 }, { opacity: 1, duration: 0.22, ease: 'power1.out' }, ${t});`)
      } else {
        // Cut: the incoming layer fades in fast while the outgoing layer fades
        // OUT — layers must never stack (full-bleed footage under cards made
        // every graphic collide with the previous shot's imagery).
        tweens.push(`      tl.fromTo('.shot-${i}', { opacity: 0 }, { opacity: 1, duration: 0.18, ease: 'power1.out' }, ${t});`)
        tweens.push(`      tl.to('.shot-${i - 1}', { opacity: 0, duration: 0.3, ease: 'power1.in' }, ${t});`)
      }
    } else if (timing.entranceS > 0 && (timing.entranceKind ?? 'fade') !== 'cut') {
      // Scene entrance = the transition (crossfade/fade-in over the outgoing
      // scene). A 'cut' entrance is a TRUE hard cut: no tween, the layer is
      // simply there from frame 0.
      tweens.push(`      tl.fromTo('.shot-0', { opacity: 0 }, { opacity: 1, duration: ${timing.entranceS}, ease: 'power1.inOut' }, 0);`)
    }
    const assets = assetFiles[i] ?? { main: null, panels: [] }
    // Baked footage: step the shot's frame images across its own time window.
    if (shot.kind === 'asset' && assets.main && assets.mainSeq) {
      tweens.push(frameSequenceTweens(assets.mainSeq, `.shot-${i}`, t, round3(t + dur)))
    }
    for (let pi = 0; pi < (assets.panelSeqs?.length ?? 0); pi++) {
      const seq = assets.panelSeqs?.[pi]
      if (seq) tweens.push(frameSequenceTweens(seq, `.shot-${i}`, t, round3(t + dur)))
    }
    if (shot.kind === 'asset' && assets.main) {
      // Footage carries its own motion; zooming a moving clip reads as a
      // mistake. Stills keep the authored Ken Burns/motion grammar. A page
      // screenshot in its browser plate gets ONE writer (a top-anchored
      // push-in), never the generic `.kb` motion on the same node.
      if (!VIDEO_EXT.test(assets.main) && !assets.mainSeq) {
        const screenPlate = isPagePlate(shot.asset ?? '', assets.mainSize ?? null) && fitCtx.layout !== 'full-bleed'
        if (!screenPlate) {
          const zoom = Math.max(1.0, Math.min(1.35, Number(shot.zoom) || 1.08))
          tweens.push(...assetMotionTweens(`.kb-${i}`, shot.motion, i, dur, zoom, t))
        } else {
          // Evidence page: a barely-there push-in from the top keeps the
          // headline anchored while the page feels alive.
          tweens.push(
            `      tl.fromTo('.shot-${i} .screen-body .kb', { scale: 1.0 }, { scale: 1.03, transformOrigin: 'top center', duration: ${dur}, ease: 'power1.inOut' }, ${t});`
          )
        }
      }
    } else if (templateKind(shot.template) === 'duo' && duoPanelsOf(shot)) {
      // Duo: each panel's media moves independently; the two text blocks
      // arrive in sequence so the eye reads left → right.
      const panels = duoPanelsOf(shot)!
      panels.forEach((panel, pi) => {
        const file = assets.panels[pi] ?? null
        const zoom = Math.max(1.0, Math.min(1.35, Number(panel.zoom) || 1.08))
        if (file && !VIDEO_EXT.test(file)) {
          tweens.push(...assetMotionTweens(`.kb-${i}-${pi}`, panel.motion ?? shot.motion, i * 3 + pi, dur, zoom, t))
        }
        tweens.push(
          `      tl.from('.shot-${i} .duo-panel-${pi}', { y: 30, opacity: 0, duration: 0.55, ease: '${style.ease}' }, ${round3(t + 0.12 + pi * 0.16)});`
        )
      })
    } else {
      const items = Array.isArray(shot.items) ? shot.items : []
      // Mirror the markup's anti-empty fallback: a data-* template without a
      // payload renders as a chapter card, so its timeline must use the card
      // tweens (stat/list tweens would target missing nodes and no-op).
      const tk = templateKind(shot.template)
      const d = shot.data
      const hasPayload =
        Boolean(
          d &&
            ((Array.isArray(d.items) && d.items.length > 0) ||
              (Array.isArray(d.labels) && d.labels.length > 0 && Array.isArray(d.series) && d.series.length > 0) ||
              (Array.isArray(d.events) && d.events.length > 0) ||
              (Array.isArray(d.markers) && d.markers.length > 0) ||
              String(d.headline ?? '').trim() ||
              String(d.quote ?? '').trim())
        ) ||
        items.length > 0 ||
        Boolean((shot.text ?? '').trim())
      const dataKind =
        tk === 'stat' || tk === 'bars' || tk === 'list' || tk === 'line' || tk === 'timeline' || tk === 'map' || tk === 'article'
      const kind = hasPayload || !dataKind ? (d?.kind ?? (items.length > 0 ? 'list' : tk)) : 'title'
      if (kind === 'bars') {
        const rows = (shot.data?.items ?? []).length
        for (let bi = 0; bi < rows; bi++) {
          tweens.push(
            `      tl.from('.shot-${i} .bar-row-${bi}', { opacity: 0, y: 18, duration: 0.35, ease: 'power2.out' }, ${round3(t + 0.2 + bi * 0.12)});`
          )
          tweens.push(
            `      tl.fromTo('.shot-${i} .bar-fill-${bi}', { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: 'power3.out', transformOrigin: 'left center' }, ${round3(t + 0.3 + bi * 0.12)});`
          )
        }
      } else if (kind === 'line') {
        const seriesCount = shot.data?.series?.length ?? 0
        tweens.push(`      tl.from('.shot-${i} .chart-axis-label', { opacity: 0, duration: 0.4, stagger: 0.015, ease: 'power1.out' }, ${round3(t + 0.1)});`)
        for (let si = 0; si < seriesCount; si++) {
          tweens.push(
            `      tl.fromTo('.shot-${i} .chart-line-${si}', { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.15, ease: 'power2.out' }, ${round3(t + 0.3 + si * 0.2)});`
          )
          tweens.push(`      tl.from('.shot-${i} .chart-area-${si}', { opacity: 0, duration: 0.9, ease: 'power1.out' }, ${round3(t + 0.35 + si * 0.2)});`)
          tweens.push(
            `      tl.from('.shot-${i} .chart-dots-${si} circle', { scale: 0, opacity: 0, transformOrigin: 'center center', duration: 0.3, stagger: 0.04, ease: 'power2.out' }, ${round3(t + 0.8 + si * 0.2)});`
          )
        }
      } else if (kind === 'timeline') {
        tweens.push(
          `      tl.fromTo('.shot-${i} .tl-axis', { scaleX: 0 }, { scaleX: 1, transformOrigin: 'left center', duration: 1.0, ease: 'power2.inOut' }, ${round3(t + 0.2)});`
        )
        tweens.push(`      tl.from('.shot-${i} .tl-event', { opacity: 0, y: 18, duration: 0.45, stagger: 0.12, ease: '${style.ease}' }, ${round3(t + 0.5)});`)
        tweens.push(
          `      tl.from('.shot-${i} .tl-node', { scale: 0, transformOrigin: 'center center', duration: 0.35, stagger: 0.12, ease: 'power2.out' }, ${round3(t + 0.65)});`
        )
        tweens.push(
          `      tl.fromTo('.shot-${i} .tl-on .tl-node', { scale: 1 }, { scale: 1.6, duration: 0.5, yoyo: true, repeat: 1, ease: 'power1.inOut' }, ${round3(t + 1.5)});`
        )
      } else if (kind === 'map') {
        tweens.push(`      tl.from('.shot-${i} .map-dots', { opacity: 0, duration: 1.0, ease: 'power1.out' }, ${round3(t + 0.15)});`)
        if (shot.data?.route) {
          tweens.push(
            `      tl.fromTo('.shot-${i} .map-route', { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.4, ease: 'power2.inOut' }, ${round3(t + 0.55)});`
          )
        }
        tweens.push(`      tl.from('.shot-${i} .map-pin', { opacity: 0, y: 10, duration: 0.4, stagger: 0.15, ease: '${style.ease}' }, ${round3(t + 0.45)});`)
        tweens.push(
          `      tl.fromTo('.shot-${i} .map-pin-on .map-pulse', { attr: { r: 9 }, opacity: 0.6 }, { attr: { r: 26 }, opacity: 0, duration: 1.5, ease: 'power1.out', repeat: 2 }, ${round3(t + 1.2)});`
        )
      } else if (kind === 'article') {
        tweens.push(`      tl.from('.shot-${i} .article-tag', { opacity: 0, y: 10, duration: 0.4, ease: 'power1.out' }, ${round3(t + 0.1)});`)
        tweens.push(`      tl.from('.shot-${i} .article-pub', { opacity: 0, duration: 0.4, ease: 'power1.out' }, ${round3(t + 0.2)});`)
        tweens.push(`      tl.from('.shot-${i} .article-headline', { opacity: 0, y: 24, duration: 0.6, ease: '${style.ease}' }, ${round3(t + 0.25)});`)
        tweens.push(
          `      tl.from('.shot-${i} .article-rule', { scaleX: 0, transformOrigin: 'left center', duration: 0.5, ease: 'power2.out' }, ${round3(t + 0.45)});`
        )
        tweens.push(`      tl.from('.shot-${i} .article-body', { opacity: 0, y: 14, duration: 0.5, ease: 'power1.out' }, ${round3(t + 0.55)});`)
        tweens.push(
          `      tl.fromTo('.shot-${i} .article-mark', { scaleX: 0 }, { scaleX: 1, transformOrigin: 'left center', duration: 0.7, ease: 'power2.inOut' }, ${round3(t + 0.8)});`
        )
        tweens.push(`      tl.from('.shot-${i} .article-quote', { opacity: 0, duration: 0.4, ease: 'power1.out' }, ${round3(t + 0.9)});`)
        tweens.push(`      tl.from('.shot-${i} .article-attr', { opacity: 0, y: 8, duration: 0.4, ease: 'power1.out' }, ${round3(t + 1.1)});`)
      } else if (kind === 'title' || kind === 'end') {
        tweens.push(`      tl.from('.shot-${i} .card-kicker', { y: 26, opacity: 0, duration: 0.5, ease: '${style.ease}' }, ${round3(t + 0.15)});`)
        tweens.push(`      tl.from('.shot-${i} .headline-rule', { scaleX: 0, transformOrigin: 'left center', duration: 0.55, ease: '${style.ease}' }, ${round3(t + 0.3)});`)
        tweens.push(`      tl.from('.shot-${i} .card-headline', { y: 34, opacity: 0, duration: 0.6, ease: '${style.ease}' }, ${round3(t + 0.4)});`)
        if (kind === 'end') {
          tweens.push(`      tl.from('.shot-${i} .card-note', { y: 18, opacity: 0, duration: 0.5, ease: '${style.ease}' }, ${round3(t + 0.75)});`)
        }
      } else if (kind === 'stat' && shot.data && statIsQuote(shot.data)) {
        // Prose stat: the pull-quote is the display element.
        tweens.push(`      tl.from('.shot-${i} .stat-quote', { y: 24, opacity: 0, duration: 0.6, ease: '${style.ease}' }, ${round3(t + 0.25)});`)
        const quoteLabel = String(shot.data.items[0]?.label ?? '').trim()
        if (quoteLabel && quoteLabel !== statQuoteText(shot.data).trim()) {
          tweens.push(`      tl.from('.shot-${i} .stat-label', { y: 16, opacity: 0, duration: 0.45, ease: '${style.ease}' }, ${round3(t + 0.5)});`)
        }
      } else if (kind === 'stat') {
        tweens.push(`      tl.from('.shot-${i} .stat-value', { scale: 0.7, opacity: 0, duration: 0.55, ease: '${style.ease}' }, ${round3(t + 0.25)});`)
        tweens.push(`      tl.from('.shot-${i} .stat-label', { y: 20, opacity: 0, duration: 0.45, ease: '${style.ease}' }, ${round3(t + 0.45)});`)
        const statItem = shot.data?.items[0]
        if (annotationOf(statItem?.value, statItem?.note)) {
          tweens.push(`      tl.from('.shot-${i} .stat-note', { y: 14, opacity: 0, duration: 0.45, ease: '${style.ease}' }, ${round3(t + 0.6)});`)
        }
      } else if (kind === 'list') {
        tweens.push(`      tl.from('.shot-${i} .list-row', { y: 26, opacity: 0, stagger: 0.14, duration: 0.4, ease: '${style.ease}' }, ${round3(t + 0.25)});`)
      } else if (kind === 'lower') {
        tweens.push(`      tl.from('.shot-${i} .lower-third', { x: -70, opacity: 0, duration: 0.45, ease: '${style.ease}' }, ${round3(t + 0.1)});`)
      } else {
        tweens.push(`      tl.from('.shot-${i} .quote-mark', { y: 30, opacity: 0, duration: 0.45, ease: '${style.ease}' }, ${round3(t + 0.1)});`)
        tweens.push(`      tl.from('.shot-${i} .quote-text', { y: 24, opacity: 0, duration: 0.6, ease: '${style.ease}' }, ${round3(t + 0.25)});`)
        if (splitQuote(shot.text ?? '').attribution) {
          tweens.push(`      tl.from('.shot-${i} .quote-attr', { y: 16, opacity: 0, duration: 0.5, ease: '${style.ease}' }, ${round3(t + 0.45)});`)
        }
      }
    }
    localFrame += item.frames
  }
  if (isFinalScene) {
    const fadeStart = round3(Math.max(0, timing.durS - 0.6))
    tweens.push(`      tl.to('.shot-${scaledShots.length - 1}', { opacity: 0, duration: 0.6, ease: 'power1.in' }, ${fadeStart}); // final scene may fade out`)
  }

  // ---- Dip-to-black (visual direction pass): the outgoing side fades UP a
  // black overlay before the cut; the incoming side opens FROM black. One
  // .dip layer serves both directions (disjoint tween windows, no overlap).
  let dipHtml = ''
  if (transIn === 'dip-to-black') {
    const d = round3(Math.max(0.2, Math.min(0.6, timing.entranceS || 0.5)))
    dipHtml = `    <div class="dip"></div>`
    tweens.push(`      tl.fromTo('.dip', { opacity: 1 }, { opacity: 0, duration: ${d}, ease: 'power1.out' }, 0);`)
  }
  if (transOut === 'dip-to-black') {
    const d = 0.35
    const start = round3(Math.max(0, timing.durS - d))
    if (!dipHtml) dipHtml = `    <div class="dip"></div>`
    tweens.push(`      tl.to('.dip', { opacity: 1, duration: ${d}, ease: 'power1.in' }, ${start});`)
  }

  // ---- Kinetic captions (M4): word-synced cue layer built from the VO words.
  // SAPI-fallback sections have no timings — the caption layer is skipped honestly.
  let captionHtml = ''
  if (style.captions !== 'off' && opts.words && opts.words.length > 0) {
    const cues = buildSrtCues(
      opts.words.map((w) => ({ word: w.word, startS: Number(w.start_s) || 0, durS: Number(w.dur_s) || 0 })),
      { minDurS: 0.5 }
    )
    const capRows: string[] = []
    let wordCursor = 0
    cues.forEach((cue, ci) => {
      const cueWordCount = cue.lines.join(' ').split(' ').filter(Boolean).length
      const words = opts.words!.slice(wordCursor, wordCursor + cueWordCount)
      wordCursor += cueWordCount
      capRows.push(
        `      <div class="cap cap-${ci}">${words
          .map((w) => `<span class="cw" data-t="${round3(Number(w.start_s) || 0)}">${esc(w.word)}</span>`)
          .join(' ')}</div>`
      )
      tweens.push(`      tl.fromTo('.cap-${ci}', { opacity: 0 }, { opacity: 1, duration: 0.12, ease: 'none' }, ${round3(cue.startS)});`)
      tweens.push(`      tl.set('.cap-${ci}', { opacity: 0 }, ${round3(Math.min(cue.endS, timing.durS - 0.05))});`)
      if (style.captions === 'kinetic') {
        words.forEach((_w, wi) => {
          const t = round3(Number(opts.words![wordCursor - cueWordCount + wi].start_s) || 0)
          if (t >= timing.durS) return
          tweens.push(
            `      tl.fromTo('.cap-${ci} .cw:nth-child(${wi + 1})', { scale: 1 }, { color: '${style.accent}', scale: 1.14, duration: 0.1, ease: 'power2.out', yoyo: true, repeat: 1 }, ${t});`
          )
        })
      }
    })
    if (capRows.length > 0) {
      captionHtml = `    <div class="capwrap">
${capRows.join('\n')}
    </div>`
    }
  }

  // ---- Beat-synced motion (M4). The beat's authored pattern-interrupt TEXT is
  // internal direction — it is never displayed; the interrupt is pure motion:
  // a fast accent flash + a zoom punch on the live shot. Re-hook beats add a
  // minimal chapter chip so the viewer always knows where they are.
  let beatHtml = ''
  if (opts.beat) {
    const b = opts.beat
    if (b.rehook && b.label) {
      const chipAt = round3(Math.max(0.35, Math.min(0.7, timing.durS - 1.6)))
      beatHtml += `    <div class="chapter"><span class="chapter-dot"></span><span class="chapter-label">${esc(b.label)}</span></div>`
      tweens.push(`      tl.fromTo('.chapter', { opacity: 0, y: -18 }, { opacity: 1, y: 0, duration: 0.4, ease: '${style.ease}' }, ${chipAt});`)
      tweens.push(`      tl.to('.chapter', { opacity: 0, duration: 0.4, ease: 'power1.in' }, ${round3(chipAt + 2.2)});`)
    }
    if (b.patternInterrupt) {
      const at = round3(Math.max(0.35, Math.min(0.7, timing.durS - 1.6)))
      beatHtml += `    <div class="flash"></div>`
      tweens.push(`      tl.fromTo('.flash', { opacity: 0 }, { opacity: 0.5, duration: 0.08, ease: 'power2.out' }, ${at});`)
      tweens.push(`      tl.to('.flash', { opacity: 0, duration: 0.26, ease: 'power1.in' }, ${round3(at + 0.08)});`)
      // Zoom punch on the shot live at the interrupt moment. Targets the shot
      // LAYER, not .kb-i: the media layer's Ken Burns tween writes scale for
      // the whole shot, and a second writer holding a RELATIVE value makes
      // seek paths diverge (lint: gsap_relative_value_second_writer +
      // overlapping_gsap_tweens). .shot-i has no other scale writer, so the
      // relative yoyo is single-writer-safe. Pick the shot whose window
      // contains the punch START, not the beat anchor.
      const punchAt = round3(at + 0.15)
      let acc = 0
      for (let i = 0; i < scaledShots.length; i++) {
        acc += scaledShots[i].frames
        if (acc / fps >= punchAt) {
          tweens.push(`      tl.to('.shot-${i}', { scale: '+=0.05', duration: 0.24, ease: 'power2.out', yoyo: true, repeat: 1 }, ${punchAt});`)
          break
        }
      }
    }
  }

  // ---- Ambient accents (M4): aurora bloom (kallaway family) + vignette.
  let accentHtml = ''
  if (style.accents === 'aurora') {
    accentHtml += `    <div class="aurora"></div>`
    tweens.push(
      `      tl.fromTo('.aurora', { opacity: 0.45 }, { opacity: 0.8, duration: 6, ease: 'sine.inOut', yoyo: true, repeat: ${Math.max(0, Math.ceil(timing.durS / 6) - 1)} }, 0);`
    )
  }
  if (style.vignette) {
    accentHtml += `    <div class="vignette"></div>`
  }
  // Mood grade (visual direction pass): footage-tint overlay under the
  // vignette + CSS filter on media layers only — text/cards stay crisp.
  if (grade?.color) accentHtml += `    <div class="grade"></div>`

  const hasMedia = scaledShots.some(
    (s) =>
      (s.shot.kind === 'asset' && Boolean(s.shot.asset)) ||
      (templateKind(s.shot.template) === 'duo' && (duoPanelsOf(s.shot) ?? []).some((p) => Boolean(p.asset)))
  )
  if (layout === 'split' && !hasMedia) {
    fitCtx.note?.(`${scene.id}: split layout has no media — the text panel stays centered instead of hugging the left edge`)
  }

  const layers = scaledShots
    .map((item, i) => shotLayerHtml(scene.id, item, i, assetFiles[i] ?? { main: null, panels: [] }, sceneLabel, fitCtx))
    .join('\n')

  // Design furniture (index numerals, case stamps, mastheads, letterbox):
  // the layer that makes a skin read as a system rather than a palette.
  // Full-bleed media is cinema: page furniture (masthead/footer) would sit on
// moving footage and become unreadable on light skins, so the media owns the
// frame and a strong bottom scrim carries the caption.
  const hasBleedMedia =
    layout === 'full-bleed' && scaledShots.some((s, idx) => s.shot.kind === 'asset' && Boolean(assetFiles[idx]?.main))
  const furnitureHtml = hasBleedMedia
    ? ''
    : designFurniture(style, {
        index: opts.sceneIndex ?? 0,
        total: opts.sceneTotal ?? 0,
        label: sceneLabel,
        title: opts.projectTitle ?? 'Vendotube'
      })

  // Scene-scoped extra CSS: mood grade, dip-to-black, layout variants. All
  // omitted for a standard, ungraded scene — default output stays identical.
  const s = `[data-composition-id="${compId}"]`
  let extraCss = ''
  if (grade?.color) {
    extraCss += `      ${s} .grade {
        position: absolute; inset: 0; z-index: 27; pointer-events: none;
        background: ${grade.color}; opacity: ${grade.opacity}; mix-blend-mode: ${grade.blend};
      }\n`
  }
  if (grade?.filter) {
    extraCss += `      ${s} .shot .kb { filter: ${grade.filter}; }\n`
  }
  if (dipHtml) {
    extraCss += `      ${s} .dip {
        position: absolute; inset: 0; z-index: 26; pointer-events: none; opacity: 0;
        background: #000;
      }\n`
  }
  if (layout === 'full-bleed') {
    extraCss += `      ${s} .bleed-cap {
        position: absolute; left: 56px; bottom: 96px; max-width: 70%; z-index: 24;
        font-family: ${style.fontBody}; font-weight: 600; font-size: 26px; letter-spacing: 0.04em;
        color: rgba(255,255,255,.92); text-shadow: 0 2px 14px rgba(0,0,0,.6);
      }
      ${s} .bleed-cap::before {
        content: ''; display: block; width: 56px; height: 3px; margin-bottom: 12px;
        background: ${style.accent};
      }
      /* Media needs a real scrim even on paper skins (their card/exhibit scrim
         is deliberately off); this keeps captions and chapter chips readable. */
      ${s} .bleed-shot .scrim {
        background: linear-gradient(180deg, rgba(0,0,0,.06) 0%, rgba(0,0,0,.14) 52%, rgba(0,0,0,.88) 100%);
      }
      ${s} .chapter-label { text-shadow: 0 2px 12px rgba(0,0,0,.75), 0 0 3px rgba(0,0,0,.6); }\n`
  }
  if (layout === 'centered') {
    extraCss += `      ${s} .card-shot { padding: 0 0 110px; justify-content: center; align-items: center; }
      ${s} .card:not(.data-card) { gap: 24px; text-align: center; align-items: center; margin: 0 auto; }
      ${s} .data-card { text-align: left; align-items: stretch; margin: 0 auto; }
      ${s} .data-card.stat-card { text-align: center; align-items: center; }
      ${s} .card-headline { font-size: 100px; }
      ${s} .headline-rule { width: 280px; }\n`
  }
  if (layout === 'split') {
    // A left-aligned text column, but the PANEL itself stays centered on the
    // canvas: an off-center box with empty space to its right read as a layout
    // bug in the 2026-11-16 foundation film.
    extraCss += `      ${s} .card-shot { justify-content: center; padding: 0 120px; }
      ${s} .card { text-align: left; align-items: flex-start; max-width: 1100px; margin: 0 auto; }
      ${s} .card-kicker { justify-content: flex-start; }\n`
  }
  if (layout === 'minimal') {
    extraCss += `      ${s} .card-shot { padding-bottom: 170px; align-items: flex-end; justify-content: center; }
      ${s} .card { width: 64%; margin: 0 auto; text-align: left; align-items: flex-start; gap: 18px; background: none; border: none; box-shadow: none; padding: 0; transform: none; }
      ${s} .card-headline { font-size: 58px; }
      ${s} .headline-rule { width: 140px; height: 5px; }\n`
  }

  return `<template id="${compId}-template">
  <div data-composition-id="${compId}" data-width="${width}" data-height="${height}" data-design="${style.design}">
    <div class="hf-canvas" style="width:${designWidth}px; height:${designHeight}px; transform: scale(${round4(canvasScale)}); transform-origin: top left; position: relative;">
    <style>
${style.fonts
  .map(
    (f) =>
      `      @font-face { font-family: '${f.family}'; src: url('../${FONTS_URL_ROOT}/${f.file}') format('woff2'); font-weight: ${f.weight}; font-style: ${f.fontStyle}; font-display: block; }`
  )
  .join('\n')}
      [data-composition-id="${compId}"] {
        position: relative;
        width: 100%;
        height: 100%;
        background: ${style.bg};
        overflow: hidden;
        font-family: ${style.fontBody};
      }
      [data-composition-id="${compId}"] .grain {
        position: absolute; inset: 0; z-index: 40; pointer-events: none;
        ${grainCss(style)}
      }
      [data-composition-id="${compId}"] .vignette {
        position: absolute; inset: 0; z-index: 28; pointer-events: none;
        background: radial-gradient(ellipse at center, transparent 52%, rgba(0,0,0,${style.glowHeadline ? '0.42' : '0.18'}) 100%);
      }
      [data-composition-id="${compId}"] .aurora {
        position: absolute; left: 10%; right: 10%; bottom: -18%; height: 62%; z-index: 5; pointer-events: none;
        background: radial-gradient(ellipse at 50% 100%, ${style.accent}38 0%, transparent 68%);
        filter: blur(2px);
      }
      [data-composition-id="${compId}"] .flash {
        position: absolute; inset: 0; z-index: 38; pointer-events: none; opacity: 0;
        background: ${style.accent}; mix-blend-mode: screen;
      }
      [data-composition-id="${compId}"] .chapter {
        position: absolute; left: 56px; top: 118px; z-index: 36; opacity: 0;
        display: flex; align-items: center; gap: 14px;
      }
      [data-composition-id="${compId}"] .chapter-dot {
        width: 12px; height: 12px; border-radius: 50%; background: ${style.accent};
        box-shadow: 0 0 18px ${style.accent};
      }
      [data-composition-id="${compId}"] .chapter-label {
        font-family: ${style.fontBody}; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.24em; font-size: 22px; color: ${style.textDim};
      }
      [data-composition-id="${compId}"] .capwrap {
        position: absolute; left: 8%; right: 8%; bottom: 7.5%; height: 120px; z-index: 30;
        display: flex; justify-content: center; align-items: flex-end; pointer-events: none;
      }
      [data-composition-id="${compId}"] .cap {
        /* Bottom-center: a bare bottom:0 shrink-wrapped the caption against the
           left edge, so narration sat off to one side (2026-11-18). */
        position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
        max-width: 92%;
        font-family: ${style.fontBody}; font-weight: 700; font-size: 44px; line-height: 1.25;
        text-align: center; opacity: 0;
        color: #ffffff;
        background: rgba(10, 13, 18, 0.8); border: 1px solid rgba(255,255,255,.08);
        padding: 10px 26px; border-radius: 14px;
        box-shadow: 0 14px 40px rgba(0,0,0,.35);
      }
      /* Kinetic word spans are animated with GSAP transforms; an outer
         translateX on the parent would be overwritten by a tween on .cap,
         so the centering offset lives on the parent only. */
      [data-composition-id="${compId}"] .cap .cw { display: inline-block; }
      [data-composition-id="${compId}"] .shot { position: absolute; inset: 0; z-index: 10; }
      [data-composition-id="${compId}"] .kb { position: absolute; inset: -6%; }
      [data-composition-id="${compId}"] .kb img, [data-composition-id="${compId}"] .kb video {
        width: 100%; height: 100%; object-fit: cover; display: block;
      }
      [data-composition-id="${compId}"] .scrim {
        position: absolute; inset: 0; pointer-events: none;
        background: linear-gradient(180deg, rgba(4,6,10,.20) 0%, rgba(4,6,10,.06) 42%, rgba(4,6,10,.80) 100%);
      }
      /* Exhibit mode: evidence screenshots become framed artifacts on the film's
         own canvas — the busy page is INSIDE a frame, never the frame itself. */
      [data-composition-id="${compId}"] .exhibit-shot {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 26px; padding-bottom: 90px; box-sizing: border-box;
      }
      [data-composition-id="${compId}"] .exhibit {
        position: relative; width: 1240px; height: 700px; overflow: hidden;
        border-radius: 16px; border: 1px solid ${style.exhibitBorder};
        background: ${style.bgDeep};
        box-shadow: 0 40px 90px rgba(0,0,0,.55), 0 8px 28px rgba(0,0,0,.35);
      }
      [data-composition-id="${compId}"] .exhibit .kb { position: absolute; inset: 0; }
      [data-composition-id="${compId}"] .exhibit .kb img.kb-bg {
        position: absolute; inset: -8%; width: 116%; height: 116%;
        object-fit: cover; filter: blur(26px) saturate(1.1) brightness(0.92);
      }
      [data-composition-id="${compId}"] .exhibit .kb img.kb-fg {
        position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
      }
      [data-composition-id="${compId}"] .exhibit-cap {
        max-width: 1240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: ${style.fontBody}; font-weight: 600; font-size: 26px;
        letter-spacing: 0.04em; color: ${style.textDim};
      }
      /* Video and page-screenshot plates (media-treatment pass, 2026-11-16). */
      [data-composition-id="${compId}"] .video-shot,
      [data-composition-id="${compId}"] .screen-shot {
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        gap: 26px; padding-bottom: 110px; box-sizing: border-box;
      }
      [data-composition-id="${compId}"] .media-plate {
        position: relative; overflow: hidden; box-sizing: border-box;
        border: 1px solid ${style.panelBorder}; border-radius: 10px;
        background: ${style.bgDeep};
        box-shadow: 0 30px 80px rgba(0,0,0,.45);
      }
      [data-composition-id="${compId}"] .video-plate { background: #000; }
      [data-composition-id="${compId}"] .video-plate video {
        width: 100%; height: 100%; object-fit: cover; display: block;
      }
      [data-composition-id="${compId}"] .screen-plate {
        display: flex; flex-direction: column; background: #fff;
      }
      [data-composition-id="${compId}"] .screen-bar {
        flex: 0 0 38px; height: 38px; display: flex; align-items: center; gap: 14px;
        padding: 0 16px; box-sizing: border-box;
        background: ${style.panel}; border-bottom: 1px solid ${style.panelBorder};
      }
      [data-composition-id="${compId}"] .screen-dots { display: flex; gap: 7px; flex: 0 0 auto; }
      [data-composition-id="${compId}"] .screen-dot {
        width: 9px; height: 9px; border-radius: 50%; background: ${style.textDim}; opacity: .45;
      }
      [data-composition-id="${compId}"] .screen-dot:first-child { background: ${style.accent}; opacity: .9; }
      [data-composition-id="${compId}"] .screen-url {
        font-family: ${style.mono}; font-weight: 600; font-size: 14px; letter-spacing: .08em;
        color: ${style.textDim}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      [data-composition-id="${compId}"] .screen-body {
        position: relative; flex: 1 1 auto; overflow: hidden; background: #fff;
      }
      [data-composition-id="${compId}"] .screen-body .kb { position: absolute; inset: 0; }
      [data-composition-id="${compId}"] .screen-body img {
        width: 100%; height: 100%; object-fit: contain; display: block;
      }
      [data-composition-id="${compId}"] .screen-body-top img {
        object-fit: cover; object-position: top center;
      }
      [data-composition-id="${compId}"] .card-shot { display: flex; align-items: center; justify-content: center; }
      [data-composition-id="${compId}"] .card-shot:not(.overlay-shot) { padding-bottom: 110px; box-sizing: border-box; }
      [data-composition-id="${compId}"] .card {
        width: 80%; max-width: 1400px; text-align: center;
        display: flex; flex-direction: column; align-items: center; gap: 30px;
      }
      [data-composition-id="${compId}"] .card-kicker {
        font-family: ${style.fontBody}; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.22em; font-size: 24px; color: ${style.accent};
      }
      [data-composition-id="${compId}"] .card-headline {
        font-family: ${style.fontHead}; font-weight: ${style.headWeight}; font-size: 92px; line-height: 1.08;
        letter-spacing: -0.02em; color: ${style.text}; max-width: 1300px;
        ${style.glowHeadline ? `text-shadow: 0 0 42px rgba(55,189,248,.35), 0 2px 26px rgba(255,255,255,.14);` : ''}
      }
      [data-composition-id="${compId}"] .card-headline.headline-md { font-size: 70px; }
      [data-composition-id="${compId}"] .card-headline.headline-sm { font-size: 54px; }
      [data-composition-id="${compId}"] .headline-rule {
        width: 220px; height: 8px; border-radius: 4px; background: ${style.accent};
        box-shadow: 0 0 26px ${style.accent}66;
      }
      [data-composition-id="${compId}"] .card-note {
        font-family: ${style.fontBody}; font-size: 28px; color: ${style.textDim};
      }
      /* Data cards sit on a solid panel — readable over any background. */
      [data-composition-id="${compId}"] .data-card {
        width: 82%; max-width: 1300px; text-align: left; align-items: stretch; gap: 26px;
        background: ${style.panel}; border: 1px solid ${style.panelBorder};
        border-radius: 20px; padding: 52px 62px; box-sizing: border-box;
        box-shadow: 0 30px 80px rgba(0,0,0,.5);
      }
      [data-composition-id="${compId}"] .data-card.stat-card { text-align: center; align-items: center; }
      [data-composition-id="${compId}"] .data-title {
        font-family: ${style.fontHead}; font-weight: ${style.headWeight}; font-size: 46px; color: ${style.text};
      }
      [data-composition-id="${compId}"] .bars { width: 100%; display: flex; flex-direction: column; gap: 20px; }
      [data-composition-id="${compId}"] .bar-row {
        display: grid; grid-template-columns: 340px 1fr 170px; align-items: center; gap: 26px;
      }
      [data-composition-id="${compId}"] .bar-label {
        font-family: ${style.fontBody}; font-weight: 700; font-size: 30px; color: ${style.text};
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      [data-composition-id="${compId}"] .bar-track {
        height: 40px; background: ${style.glowHeadline ? 'rgba(255,255,255,.07)' : 'rgba(23,19,14,.10)'};
        border-radius: 8px; overflow: hidden;
        border: ${style.glowHeadline ? 'none' : '2px solid rgba(23,19,14,.35)'};
      }
      [data-composition-id="${compId}"] .bar-fill {
        height: 100%; width: 100%; background: ${style.accent}; transform-origin: left center;
      }
      [data-composition-id="${compId}"] .bar-value {
        font-family: ${style.fontHead}; font-weight: ${style.headWeight}; font-size: 36px;
        color: ${style.text}; text-align: right;
      }
      [data-composition-id="${compId}"] .stat-value {
        font-family: ${style.fontHead}; font-weight: ${style.headWeight}; font-size: 190px; line-height: 1;
        color: ${style.accent}; letter-spacing: -0.02em;
        ${style.glowHeadline ? `text-shadow: 0 0 60px rgba(55,189,248,.4);` : ''}
      }
      [data-composition-id="${compId}"] .stat-label {
        font-family: ${style.fontBody}; font-weight: 700; font-size: 40px; color: ${style.text};
      }
      [data-composition-id="${compId}"] .stat-note {
        font-family: ${style.fontBody}; font-weight: 600; font-size: 26px;
        letter-spacing: 0.06em; color: ${style.textDim};
      }
      /* Prose stat notes render as a fitted pull-quote, never as a display figure. */
      [data-composition-id="${compId}"] .stat-quote {
        font-family: ${style.fontHead}; font-weight: ${style.headWeight}; font-size: 58px; line-height: 1.2;
        color: ${style.text}; max-width: 100%; overflow-wrap: break-word;
      }
      [data-composition-id="${compId}"] .stat-value,
      [data-composition-id="${compId}"] .stat-label,
      [data-composition-id="${compId}"] .stat-note,
      [data-composition-id="${compId}"] .data-title,
      [data-composition-id="${compId}"] .list-label,
      [data-composition-id="${compId}"] .card-headline { overflow-wrap: break-word; }
      [data-composition-id="${compId}"] .list-rows { width: 100%; display: flex; flex-direction: column; }
      [data-composition-id="${compId}"] .list-row {
        display: flex; align-items: baseline; gap: 26px;
        padding: 18px 10px;
      }
      [data-composition-id="${compId}"] .list-row + .list-row {
        border-top: ${style.glowHeadline ? '1px solid rgba(255,255,255,.09)' : '2px solid rgba(23,19,14,.22)'};
      }
      [data-composition-id="${compId}"] .list-num {
        font-family: ${style.fontHead}; font-weight: ${style.headWeight}; font-size: 30px; color: ${style.accent};
        min-width: 44px;
      }
      [data-composition-id="${compId}"] .list-label {
        font-family: ${style.fontBody}; font-weight: 700; font-size: 32px; color: ${style.text};
      }
      [data-composition-id="${compId}"] .list-value {
        margin-left: auto; font-family: ${style.fontHead}; font-weight: ${style.headWeight}; font-size: 32px;
        color: ${style.textDim};
      }
      /* -------------------------------------------------- motion-graphics cards
         Line chart / chronology / location map / article clipping. All copy is
         fitted by the emitter; only motion lives in the GSAP timeline. */
      [data-composition-id="${compId}"] .chart-note,
      [data-composition-id="${compId}"] .map-meta,
      [data-composition-id="${compId}"] .map-unmapped {
        font-family: ${style.mono}; font-weight: 500; font-size: 12px; letter-spacing: 0.14em;
        color: ${style.textDim}; opacity: 0.8;
      }
      [data-composition-id="${compId}"] .chart-wrap { width: 100%; }
      [data-composition-id="${compId}"] .chart-card { position: relative; }
      [data-composition-id="${compId}"] .chart-svg { display: block; width: 100%; overflow: visible; }
      [data-composition-id="${compId}"] .chart-grid-line { stroke: ${style.panelBorder}; stroke-width: 1; opacity: 0.4; }
      [data-composition-id="${compId}"] .chart-axis-label {
        fill: ${style.textDim}; font-family: ${style.mono}; font-size: 13px; letter-spacing: 0.06em;
      }
      [data-composition-id="${compId}"] .chart-line {
        fill: none; stroke-width: 3.2; stroke-linecap: round; stroke-linejoin: round;
        stroke-dasharray: 1; stroke-dashoffset: 1;
      }
      [data-composition-id="${compId}"] .chart-area { opacity: 0.14; }
      [data-composition-id="${compId}"] .chart-line-0 { stroke: ${style.accent}; }
      [data-composition-id="${compId}"] .chart-area-0 { fill: ${style.accent}; }
      [data-composition-id="${compId}"] .chart-dots-0 circle { fill: ${style.accent}; }
      [data-composition-id="${compId}"] .chart-line-1 { stroke: ${style.secondary}; }
      [data-composition-id="${compId}"] .chart-area-1 { fill: ${style.secondary}; }
      [data-composition-id="${compId}"] .chart-dots-1 circle { fill: ${style.secondary}; }
      [data-composition-id="${compId}"] .chart-line-2 { stroke: ${style.textDim}; }
      [data-composition-id="${compId}"] .chart-area-2 { fill: ${style.textDim}; }
      [data-composition-id="${compId}"] .chart-dots-2 circle { fill: ${style.textDim}; }
      [data-composition-id="${compId}"] .chart-dot { stroke: none; }
      [data-composition-id="${compId}"] .chart-legend {
        display: flex; gap: 24px; align-items: center; font-family: ${style.mono}; font-size: 13px;
        letter-spacing: 0.1em; color: ${style.textDim}; text-transform: uppercase;
      }
      [data-composition-id="${compId}"] .chart-key { display: inline-flex; align-items: center; gap: 8px; }
      [data-composition-id="${compId}"] .chart-key i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
      [data-composition-id="${compId}"] .chart-key-0 i { background: ${style.accent}; }
      [data-composition-id="${compId}"] .chart-key-1 i { background: ${style.secondary}; }
      [data-composition-id="${compId}"] .chart-key-2 i { background: ${style.textDim}; }
      [data-composition-id="${compId}"] .chart-unit {
        position: absolute; top: 54px; right: 54px; font-family: ${style.mono}; font-size: 12px;
        letter-spacing: 0.14em; color: ${style.textDim}; text-transform: uppercase;
      }
      [data-composition-id="${compId}"] .timeline-card { position: relative; }
      [data-composition-id="${compId}"] .timeline-plot { position: relative; margin: 6px auto 0; }
      [data-composition-id="${compId}"] .tl-axis {
        position: absolute; left: 0; right: 0; height: 2px; background: ${style.panelBorder};
        transform-origin: left center;
      }
      [data-composition-id="${compId}"] .tl-event { position: absolute; }
      [data-composition-id="${compId}"] .tl-card {
        display: flex; flex-direction: column; justify-content: center; gap: 3px;
        padding: 8px 12px; box-sizing: border-box;
        background: transparent; border: 1px solid ${style.panelBorder};
      }
      [data-composition-id="${compId}"] .tl-year-in {
        font-family: ${style.mono}; font-weight: 600; font-size: 12px; letter-spacing: 0.08em; color: ${style.accent};
      }
      [data-composition-id="${compId}"] .tl-label {
        font-family: ${style.fontBody}; font-weight: 700; font-size: 22px; line-height: 1.15; color: ${style.text};
      }
      [data-composition-id="${compId}"] .tl-note {
        font-family: ${style.mono}; font-weight: 500; font-size: 13px; line-height: 1.2; color: ${style.textDim};
      }
      [data-composition-id="${compId}"] .tl-stem { position: absolute; width: 1px; background: ${style.panelBorder}; }
      [data-composition-id="${compId}"] .tl-node {
        position: absolute; width: 10px; height: 10px; border-radius: 50%; background: ${style.accent};
        transform: translate(-50%, -50%); box-shadow: 0 0 16px ${style.accent}66;
      }
      [data-composition-id="${compId}"] .tl-on .tl-card { background: ${style.accent}; border-color: ${style.accent}; }
      [data-composition-id="${compId}"] .tl-on .tl-year-in { color: ${style.paper}; }
      [data-composition-id="${compId}"] .tl-on .tl-label,
      [data-composition-id="${compId}"] .tl-on .tl-note { color: ${style.paper}; }
      [data-composition-id="${compId}"] .tl-on .tl-node { width: 14px; height: 14px; border: 2px solid ${style.paper}; }
      [data-composition-id="${compId}"] .map-wrap { position: relative; margin: 0 auto; }
      [data-composition-id="${compId}"] .map-svg { display: block; overflow: visible; }
      [data-composition-id="${compId}"] .map-dots {
        fill: none; stroke: ${style.textDim}; stroke-width: 5.4; stroke-linecap: round; opacity: 0.5;
      }
      [data-composition-id="${compId}"] .map-route {
        fill: none; stroke: ${style.accent}; stroke-width: 2; stroke-linecap: round;
        stroke-dasharray: 1; stroke-dashoffset: 1; opacity: 0.65;
      }
      [data-composition-id="${compId}"] .map-leader { stroke: ${style.textDim}; stroke-width: 1; opacity: 0.55; }
      [data-composition-id="${compId}"] .map-pulse { fill: ${style.accent}; opacity: 0; }
      [data-composition-id="${compId}"] .map-hit { fill: ${style.accent}; stroke: ${style.panel}; stroke-width: 2; }
      [data-composition-id="${compId}"] .map-label-bg { fill: ${style.panel}; stroke: ${style.panelBorder}; stroke-width: 1; }
      [data-composition-id="${compId}"] .map-label-name {
        fill: ${style.text}; font-family: ${style.fontBody}; font-weight: 700;
      }
      [data-composition-id="${compId}"] .map-label-note { fill: ${style.textDim}; font-family: ${style.mono}; font-weight: 500; }
      [data-composition-id="${compId}"] .map-pin-on .map-label-bg { fill: ${style.accent}; stroke: ${style.accent}; }
      [data-composition-id="${compId}"] .map-pin-on .map-label-name { fill: ${style.paper}; }
      [data-composition-id="${compId}"] .map-pin-on .map-label-note { fill: ${style.paper}; opacity: 0.82; }
      [data-composition-id="${compId}"] .map-meta { display: flex; justify-content: space-between; margin-top: 2px; }
      [data-composition-id="${compId}"] .map-unmapped { margin-top: 2px; }
      [data-composition-id="${compId}"] .article-card { gap: 12px; }
      [data-composition-id="${compId}"] .article-tag {
        font-family: ${style.mono}; font-weight: 600; font-size: 11px; letter-spacing: 0.2em;
        color: ${style.accent}; text-transform: uppercase;
      }
      [data-composition-id="${compId}"] .article-pub {
        font-family: ${style.mono}; font-weight: 600; font-size: 18px; letter-spacing: 0.1em;
        color: ${style.textDim}; border-bottom: 1px solid ${style.panelBorder}; padding-bottom: 8px;
      }
      [data-composition-id="${compId}"] .article-headline {
        font-family: ${style.fontHead}; font-weight: ${style.headWeight}; font-size: 64px; line-height: 1.04;
        color: ${style.text}; overflow-wrap: break-word;
      }
      [data-composition-id="${compId}"] .article-rule { height: 2px; width: 100%; background: ${style.text}; opacity: 0.45; }
      [data-composition-id="${compId}"] .article-body {
        font-family: ${style.fontBody}; font-weight: 400; font-size: 26px; line-height: 1.5;
        color: ${style.text}; opacity: 0.88; overflow-wrap: break-word; max-width: 940px;
      }
      [data-composition-id="${compId}"] .article-quote-wrap { position: relative; padding: 8px 12px; margin-top: 4px; max-width: 1000px; }
      [data-composition-id="${compId}"] .article-mark {
        position: absolute; inset: 0; background: ${style.accent}; opacity: 0.24;
        transform: scaleX(0); transform-origin: left center;
      }
      [data-composition-id="${compId}"] .article-quote {
        position: relative; z-index: 1; font-family: ${style.fontHead}; font-weight: 400; font-style: italic;
        font-size: 46px; line-height: 1.22; color: ${style.text}; overflow-wrap: break-word;
      }
      [data-composition-id="${compId}"] .article-attr {
        font-family: ${style.mono}; font-weight: 600; font-size: 18px; letter-spacing: 0.08em; color: ${style.textDim};
      }
      [data-composition-id="${compId}"] .quote-card .quote-mark {
        font-family: ${style.fontHead}; font-size: 150px; line-height: 0.6; color: ${style.accent};
      }
      [data-composition-id="${compId}"] .quote-card .quote-text {
        font-family: ${style.fontHead}; font-style: italic; font-weight: 300; font-size: 64px;
        line-height: 1.25; color: ${style.text}; max-width: 1250px; overflow-wrap: break-word;
      }
      [data-composition-id="${compId}"] .quote-card .quote-attr {
        font-family: ${style.fontBody}; font-weight: 500; font-size: 28px; letter-spacing: 0.08em;
        color: ${style.textDim}; margin-top: 18px;
      }
      /* Duo: two equal image+text panels (the "two boxes" composition). */
      [data-composition-id="${compId}"] .duo-shot {
        display: flex; align-items: center; justify-content: center;
        padding-bottom: 110px; box-sizing: border-box;
      }
      [data-composition-id="${compId}"] .duo {
        display: grid; grid-template-columns: 1fr 1fr; align-items: stretch;
        box-sizing: border-box; margin: 0 auto;
      }
      [data-composition-id="${compId}"] .duo-panel {
        display: flex; flex-direction: column; min-width: 0; overflow: hidden;
        box-sizing: border-box;
      }
      [data-composition-id="${compId}"] .duo-media {
        position: relative; width: 100%; overflow: hidden; flex: 0 0 auto;
      }
      [data-composition-id="${compId}"] .duo-media .kb { position: absolute; inset: 0; }
      [data-composition-id="${compId}"] .duo-media .kb img.kb-bg {
        position: absolute; inset: -8%; width: 116%; height: 116%;
        object-fit: cover; filter: blur(22px) saturate(1.05); opacity: .9;
      }
      [data-composition-id="${compId}"] .duo-media .kb img.kb-fg {
        position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
      }
      [data-composition-id="${compId}"] .duo-media-cover .kb-bg { display: none; }
      [data-composition-id="${compId}"] .duo-media-cover .kb img.kb-fg {
        object-fit: cover; object-position: center top;
      }
      [data-composition-id="${compId}"] .duo-media video {
        width: 100%; height: 100%; object-fit: cover; display: block;
      }
      [data-composition-id="${compId}"] .duo-text {
        padding: 28px 46px 30px; box-sizing: border-box; display: flex; flex-direction: column; gap: 10px;
      }
      [data-composition-id="${compId}"] .duo-panel-text .duo-text { height: 100%; justify-content: center; }
      [data-composition-id="${compId}"] .duo-kicker {
        font-family: ${style.mono}; font-weight: 600; font-size: 15px; letter-spacing: 0.2em;
        text-transform: uppercase; color: ${style.accent};
      }
      [data-composition-id="${compId}"] .duo-title {
        font-family: ${style.fontHead}; font-weight: ${style.headWeight}; font-size: 46px; line-height: 1.08;
        color: ${style.text}; overflow-wrap: break-word;
      }
      [data-composition-id="${compId}"] .duo-note {
        font-family: ${style.fontBody}; font-weight: 500; font-size: 20px; line-height: 1.3;
        color: ${style.textDim}; overflow-wrap: break-word;
      }
      [data-composition-id="${compId}"] .card-claims { font-size: 22px; color: ${style.textDim}; letter-spacing: 0.08em; }
      [data-composition-id="${compId}"] .overlay-shot { align-items: flex-end; justify-content: flex-start; }
      [data-composition-id="${compId}"] .lower-third {
        margin: 0 0 90px 110px; display: flex; align-items: stretch; gap: 0;
        background: ${style.panel};
        border: 1px solid ${style.panelBorder};
        border-radius: 12px; overflow: hidden;
        box-shadow: 0 18px 50px rgba(0,0,0,.5);
      }
      [data-composition-id="${compId}"] .lower-bar { width: 14px; background: ${style.accent}; }
      [data-composition-id="${compId}"] .lower-text {
        font-family: ${style.fontBody}; font-weight: 700; font-size: 40px; letter-spacing: 0.02em;
        padding: 26px 44px; color: ${style.text};
      }
${designCss(compId, style)}${extraCss}    </style>
    <div class="grain"></div>
${furnitureHtml}
${accentHtml}
${layers}
${dipHtml}
${captionHtml}
${beatHtml}
    </div>
    <script src="../vendor/gsap.min.js"></script>
    <script>
      window.__timelines = window.__timelines || {};
      (function () {
        const tl = gsap.timeline({ paused: true });
${tweens.join('\n')}
        window.__timelines["${compId}"] = tl;
      })();
    </script>
  </div>
</template>
`
}

/** Root index.html: one sub-composition clip per scene on the master timeline. */
export function renderRootHtml(timings: SceneTiming[], width: number, height: number, srcPrefix = 'compositions/'): string {
  const totalS = timings.length ? round3(timings[timings.length - 1].startS + timings[timings.length - 1].durS) : 0
  const clips = timings
    .map(
      (t, i) =>
        `    <div id="clip-${t.id}" data-composition-id="scene-${t.id}" data-composition-src="${srcPrefix}scene-${t.id}.html" data-start="${t.startS}" data-duration="${t.durS}" data-track-index="${t.trackIndex}" style="z-index: ${i + 1}"></div>`
    )
    .join('\n')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>picture master</title>
  <style>html, body { margin: 0; padding: 0; background: #000; }</style>
</head>
<body>
  <div id="film-master" data-composition-id="film-master" data-width="${width}" data-height="${height}" data-duration="${totalS}" data-no-timeline>
${clips}
  </div>
</body>
</html>
`
}

// ------------------------------------------------------------------- build

/**
 * Remove staged assets the current build no longer references.
 *
 * Each build copies media into `assets/`, so switching a shot from a source
 * clip to baked frames (or editing the shot list) leaves the old files behind
 * — and a stale multi-GB source pushes the renderer's plan dir over its 2 GiB
 * ceiling (PLAN_TOO_LARGE, 2026-11-19). Only this build's own outputs are
 * candidates: fonts/vendor live elsewhere, and every referenced file and its
 * frame-sequence folder are kept.
 */
function pruneStaleAssets(assetDir: string, keep: string[]): void {
  const kept = new Set(keep)
  let entries: string[]
  try {
    entries = readdirSync(assetDir)
  } catch {
    return
  }
  for (const name of entries) {
    // `fonts` is written straight into assets/ (FONTS_ROOT is relative to the
    // project root, so it is './assets/fonts' from here); everything else in
    // assets/ is this build's own output and is stale unless referenced.
    if (name === 'fonts' || kept.has(name)) continue
    try {
      rmSync(join(assetDir, name), { recursive: true, force: true })
    } catch {
      /* locked or already gone — a stale file must never fail the build */
    }
  }
}

/** Longest staged file name (stem + extension) the compositions folder keeps. */
const MAX_ASSET_NAME = 70

/**
 * Make a staged asset name filesystem-safe and bounded. Truncation keeps the
 * HEAD of the stem plus a short hash of the full name and the extension
 * (2026-11-18: this used to be `.slice(-70)`, which kept the tail — a long
 * YouTube title lost its `S01_` scene prefix and a Wikipedia screenshot lost
 * its leading `e`. Two URLs that differ only late in the name also collapsed
 * onto one staged file, so the hash suffix keeps them distinct).
 */
export function safeName(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9._-]+/g, '_')
  if (clean.length <= MAX_ASSET_NAME) return clean
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 && clean.length - dot <= 12 ? clean.slice(dot) : ''
  const stem = ext ? clean.slice(0, dot) : clean
  const tag = createHash('sha256').update(clean).digest('hex').slice(0, 6)
  const keep = Math.max(1, MAX_ASSET_NAME - ext.length - tag.length - 1)
  return `${stem.slice(0, keep)}-${tag}${ext}`
}

/** Locate bundled app assets — walks up so CJS builds, vitest sources, and packaged ASAR all resolve. */
export function locateAppAsset(rel: string): string {
  let dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, rel)
    if (existsSync(candidate)) return candidate
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error(`${rel} not found — run npm install in the vendotube-studio folder`)
}

export function buildCompositions(input: BuildCompositionsInput): CompositionBuildResult {
  const { projectPath, workflow, voDurations, stylePreset, projectTitle } = input
  const fps = Number(workflow.render?.fps) || 30
  const [masterW, masterH] = Array.isArray(workflow.render?.resolution) ? workflow.render.resolution : [1920, 1080]
  const style = applyStyleOverrides(resolveStyle(stylePreset), input.styleOverrides)
  // The film's transition_set seeds scene transitions that the Director left unauthored.
  const transitionDefaults = resolveTransitionSet(input.styleOverrides?.transition_set)

  const { timings, totalFrames, totalDurationS } = computeSceneTimings(workflow.scenes, voDurations, fps, transitionDefaults)
  void projectTitle // end-card text comes from workflow shots; title reserved for M4 templates

  const buildVariant = (outDirName: string, width: number, height: number, notes?: string[]): { dir: string; sceneFiles: string[]; assetCount: number; stamps: Record<string, string> } => {
    const rootDir = join(projectPath, 'studio', outDirName)
    const subDir = join(rootDir, 'compositions')
    const assetDir = join(rootDir, 'assets')
    const fontDir = join(rootDir, FONTS_ROOT)
    const vendorDir = join(rootDir, 'vendor')
    for (const d of [rootDir, subDir, assetDir, fontDir, vendorDir]) mkdirSync(d, { recursive: true })

    // Local GSAP — deterministic render, no CDN.
    copyFileSync(locateAppAsset(join('node_modules', 'gsap', 'dist', 'gsap.min.js')), join(vendorDir, 'gsap.min.js'))
    // Vendored fonts: the render must never fetch webfonts online (lint enforces @font-face).
    for (const f of style.fonts) {
      copyFileSync(locateAppAsset(join('assets', 'fonts', f.file)), join(fontDir, f.file))
    }

    const sceneFiles: string[] = []
    let assetCount = 0
    const stamps: Record<string, string> = {}
    /** Concrete staged paths this build produced (files and seq folders). */
    const stagedPaths: string[] = []

    for (let i = 0; i < workflow.scenes.length; i++) {
      const scene = workflow.scenes[i]
      const timing = timings[i]
      const scaledShots = scaleShotsToDuration(scene.shots ?? [], timing.durS, fps)
      const shotAssets: ShotAssets[] = []
      const assetRefs: string[] = []
      for (let si = 0; si < scaledShots.length; si++) {
        const shot = scaledShots[si].shot
        const shotDurS = scaledShots[si].frames / fps
        const refs: ShotAssets = { main: null, panels: [], mainSize: null, panelSizes: [] }
        if (shot.kind === 'asset' && shot.asset) {
          const abs = join(projectPath, shot.asset)
          if (!existsSync(abs)) {
            throw new Error(`composition build: asset missing on disk: ${shot.asset} (scene ${scene.id})`)
          }
          const base = safeName(`${scene.id}_${shot.asset.replace(/\\/g, '/').split('/').pop()}`)
          const isVideo = VIDEO_EXT.test(shot.asset)
          if (isVideo) {
            // Bake the footage window this shot shows into still frames (the
            // capture cannot composite a live <video>; see video-frames.ts).
            // The full source is NOT copied: a 2.3 GB clip blew the renderer's
            // 2 GiB plan-dir ceiling (PLAN_TOO_LARGE, 2026-11-19) while the
            // baked frames are a few MB.
            const seqDir = `seq_${base.replace(/\.[^.]+$/, '')}`
            const frames = bakeVideoFrames(abs, join(assetDir, seqDir), Number(shot.source_in ?? 0), shotDurS)
            if (frames) {
              refs.mainSeq = { dir: seqDir, frames, offsetS: Number(shot.source_in ?? 0), windowS: shotDurS }
              refs.main = `${seqDir}/${frames[0]}`
              refs.mainSize = null
              stagedPaths.push(seqDir)
              assetRefs.push(base)
              assetCount++
            } else {
              // Could not decode: fall back to the source file so the shot
              // still has media rather than an empty plate.
              copyFileSync(abs, join(assetDir, base))
              refs.main = base
              refs.mainSize = null
              stagedPaths.push(base)
              assetRefs.push(base)
              assetCount++
            }
          } else {
            copyFileSync(abs, join(assetDir, base))
            refs.main = base
            refs.mainSize = imageSize(abs)
            stagedPaths.push(base)
            assetRefs.push(base)
            assetCount++
          }
        }
        const panels = duoPanelsOf(shot) ?? []
        for (let pi = 0; pi < panels.length; pi++) {
          const panelAsset = panels[pi].asset
          if (!panelAsset) {
            refs.panels.push(null)
            refs.panelSizes!.push(null)
            continue
          }
          const abs = join(projectPath, panelAsset)
          if (!existsSync(abs)) {
            throw new Error(`composition build: duo panel asset missing on disk: ${panelAsset} (scene ${scene.id}, shot ${si + 1})`)
          }
          const base = safeName(`${scene.id}_p${si}_${pi}_${panelAsset.replace(/\\/g, '/').split('/').pop()}`)
          refs.panelSeqs = refs.panelSeqs ?? []
          if (VIDEO_EXT.test(panelAsset)) {
            // Same rule as a main video shot: play baked frames and keep the
            // multi-GB source out of the plan dir (PLAN_TOO_LARGE).
            const seqDir = `seq_${base.replace(/\.[^.]+$/, '')}`
            const frames = bakeVideoFrames(abs, join(assetDir, seqDir), Number(panels[pi].source_in ?? 0), shotDurS)
            if (frames) {
              refs.panelSeqs[pi] = { dir: seqDir, frames, offsetS: Number(panels[pi].source_in ?? 0), windowS: shotDurS }
              refs.panels.push(`${seqDir}/${frames[0]}`)
              stagedPaths.push(seqDir)
            } else {
              copyFileSync(abs, join(assetDir, base))
              refs.panelSeqs[pi] = null
              refs.panels.push(base)
              stagedPaths.push(base)
            }
            refs.panelSizes!.push(null)
          } else {
            copyFileSync(abs, join(assetDir, base))
            refs.panels.push(base)
            stagedPaths.push(base)
            refs.panelSizes!.push(imageSize(abs))
          }
          assetRefs.push(base)
          assetCount++
        }
        shotAssets.push(refs)
      }
      const beat = beatForScene(input.beats, scene.id, timing)
      // Visual direction pass: the scene's look resolved from the film tokens.
      const sceneStyle = resolveSceneStyle(style, scene.visual)
      const html = renderSceneHtml({
        scene,
        timing,
        scaledShots,
        assetFiles: shotAssets,
        style: sceneStyle,
        // Kicker text = the script's section title (real editorial context);
        // beat label, then the scene id, are honest fallbacks.
        sceneLabel: input.sectionTitles?.[scene.vo.script_section] || beat?.label || scene.id,
        isFinalScene: i === workflow.scenes.length - 1,
        width,
        height,
        designWidth: masterW,
        designHeight: masterH,
        fps,
        words: input.voWords?.[scene.vo.script_section],
        beat,
        transitionIn: timing.transitionIn,
        transitionOut: timing.transitionOut,
        layout: scene.visual?.layout,
        sceneIndex: i + 1,
        sceneTotal: workflow.scenes.length,
        projectTitle,
        layoutNotes: notes
      })
      const file = join(subDir, `scene-${scene.id}.html`)
      writeFileSync(file, html, 'utf-8')
      sceneFiles.push(`compositions/scene-${scene.id}.html`)
      // Segment render stamp: any timing/asset/variant/LOOK change re-renders the scene.
      stamps[scene.id] = sha8(
        `${outDirName}|${width}x${height}|${timing.frames}|${scaledShots.map((s) => s.frames).join(',')}|${assetRefs.join(',')}|${shotAssets
          .map((a) => (a.mainSize ? `${a.mainSize.width}x${a.mainSize.height}` : '') + '/' + (a.panelSizes ?? []).map((p) => (p ? `${p.width}x${p.height}` : '')).join('.'))
          .join(',')}|${JSON.stringify(scene.visual ?? '')}`
      )
    }

    writeFileSync(join(rootDir, 'index.html'), renderRootHtml(timings, width, height), 'utf-8')
    pruneStaleAssets(assetDir, stagedPaths)
    return { dir: rootDir, sceneFiles, assetCount, stamps }
  }

  const layoutNotes: string[] = []
  const master = buildVariant('compositions', masterW, masterH, layoutNotes)
  // Draft variant (TAD §9: 720p fast preview) — same templates, canvas-scaled.
  const draftW = Math.round(masterW / 1.5 / 2) * 2
  const draftH = Math.round(masterH / 1.5 / 2) * 2
  const draft = buildVariant('compositions-draft', draftW, draftH)

  return {
    dir: master.dir,
    dirDraft: draft.dir,
    totalDurationS,
    totalFrames,
    sceneTimings: timings,
    sceneFiles: master.sceneFiles,
    assetCount: master.assetCount,
    stamps: master.stamps,
    stampsDraft: draft.stamps,
    draftDims: [draftW, draftH],
    layoutNotes: [...new Set(layoutNotes)]
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** This scene's beat, with the re-hook/interrupt anchor converted to scene-local time. */
function beatForScene(beats: BeatInfo[] | undefined, sceneId: string, timing: SceneTiming): { label: string; rehook: boolean; patternInterrupt: string | null; localStartS: number } | null {
  const b = beats?.find((x) => x.scene === sceneId)
  if (!b) return null
  const localStartS = Math.max(0, Math.min(b.startS - timing.startS, timing.durS))
  return { label: b.label, rehook: b.rehook === true, patternInterrupt: b.patternInterrupt || null, localStartS }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function sha8(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8)
}
