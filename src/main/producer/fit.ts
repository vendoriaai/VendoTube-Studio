/**
 * Deterministic text fitting (layout-fix pass, 2026-11-16).
 *
 * The composition emitter has no browser during authoring: it must decide,
 * before HyperFrames ever renders, whether a headline / stat / quote actually
 * fits its box. Sizes used to be picked from a tier table by character COUNT
 * alone, which is why a 78-character prose note in a `data-stat` rendered at
 * 210px and was clipped by the frame on every side.
 *
 * This module estimates glyph advances from per-character tables (Helvetica
 * proportions, scaled per font family and weight) and solves for the largest
 * font size that fits a box — width, optional height, and a hard line cap.
 * The estimate is intentionally conservative (a safety factor is applied), so
 * a fitted element never overflows; worst case it is a few percent small.
 *
 * Everything here is pure and offline: no canvas, no font parsing, no network.
 */

export interface FitTextOptions {
  /** CSS font stack as written in skins.ts (e.g. "'Fraunces', Georgia, serif"). */
  family: string
  /** CSS font-weight (100–900). */
  weight?: number
  /** Available line width in px. */
  maxWidth: number
  /** Available block height in px (omit for width-only fitting). */
  maxHeight?: number
  /** The size the stylesheet would apply if nothing shrank. */
  nominal: number
  /** Readability floor — never returns a smaller size (an overflow is reported instead). */
  min?: number
  /** line-height ratio from the stylesheet (unitless). */
  lineHeight?: number
  /** letter-spacing in em (may be negative). */
  trackingEm?: number
  /** True when CSS uppercases the text (uppercase glyphs are wider). */
  caps?: boolean
  /** Hard cap on the number of lines (captions: 2; stat figures: 1). */
  maxLines?: number
  /** Width safety factor — the browser may render wider than we estimate. */
  safety?: number
}

export interface TextFit {
  /** Chosen size (≤ nominal, ≥ min). */
  sizePx: number
  lines: string[]
  heightPx: number
  /** True when the nominal size already fits (no override needed). */
  fitsNominal: boolean
  /** True when the text still does not fit at `min` (caller should shorten it). */
  overflow: boolean
}

/** Helvetica-ish relative advance widths (fraction of the em). */
const BASE_ADVANCE: Record<string, number> = {
  ' ': 0.278,
  '!': 0.278,
  '"': 0.355,
  '#': 0.556,
  $: 0.556,
  '%': 0.889,
  '&': 0.667,
  "'": 0.191,
  '(': 0.333,
  ')': 0.333,
  '*': 0.389,
  '+': 0.584,
  ',': 0.278,
  '-': 0.333,
  '.': 0.278,
  '/': 0.278,
  ':': 0.278,
  ';': 0.278,
  '<': 0.584,
  '=': 0.584,
  '>': 0.584,
  '?': 0.556,
  '@': 1.015,
  '[': 0.278,
  '\\': 0.278,
  ']': 0.278,
  '^': 0.469,
  _: 0.556,
  '`': 0.333,
  '{': 0.334,
  '|': 0.26,
  '}': 0.334,
  '~': 0.584,
  // typography
  '\u2014': 1.0, // em dash
  '\u2013': 0.5, // en dash
  '\u2018': 0.222,
  '\u2019': 0.222,
  '\u201c': 0.333,
  '\u201d': 0.333,
  '\u2026': 1.0, // ellipsis
  '\u00b7': 0.278, // middle dot
  '\u2022': 0.35, // bullet
  '\u00b0': 0.4,
  '\u00d7': 0.584,
  '\u2192': 0.8 // arrow
}

const UPPER: Record<string, number> = {
  A: 0.667,
  B: 0.667,
  C: 0.722,
  D: 0.722,
  E: 0.667,
  F: 0.611,
  G: 0.778,
  H: 0.722,
  I: 0.278,
  J: 0.5,
  K: 0.667,
  L: 0.556,
  M: 0.833,
  N: 0.722,
  O: 0.778,
  P: 0.667,
  Q: 0.778,
  R: 0.722,
  S: 0.667,
  T: 0.611,
  U: 0.722,
  V: 0.667,
  W: 0.944,
  X: 0.667,
  Y: 0.667,
  Z: 0.611
}

const LOWER: Record<string, number> = {
  a: 0.556,
  b: 0.556,
  c: 0.5,
  d: 0.556,
  e: 0.556,
  f: 0.278,
  g: 0.556,
  h: 0.556,
  i: 0.222,
  j: 0.222,
  k: 0.5,
  l: 0.222,
  m: 0.833,
  n: 0.556,
  o: 0.556,
  p: 0.556,
  q: 0.556,
  r: 0.333,
  s: 0.5,
  t: 0.278,
  u: 0.556,
  v: 0.5,
  w: 0.722,
  x: 0.5,
  y: 0.5,
  z: 0.5
}

/** Advance of one character in em (before family/weight/safety factors). */
export function charEm(ch: string): number {
  if (ch >= '0' && ch <= '9') return 0.556
  const direct = BASE_ADVANCE[ch] ?? UPPER[ch] ?? LOWER[ch]
  if (direct !== undefined) return direct
  // Accented Latin (é, ü, ñ): measure the base letter, widen slightly for the mark.
  const base = ch.normalize('NFD')[0]
  if (base !== ch) {
    const b = UPPER[base] ?? LOWER[base] ?? BASE_ADVANCE[base]
    if (b !== undefined) return b + 0.04
  }
  return 0.6 // honest fallback: unmeasured glyph
}

/** Family width character: serif display faces run wide, mono is fixed-pitch. */
export function isMonoFamily(family: string): boolean {
  return /jetbrains\s*mono|monospace|mono\b/i.test(family)
}

export function familyFactor(family: string): number {
  const f = family.toLowerCase()
  if (isMonoFamily(family)) return 1 // every glyph is exactly 0.6em, handled below
  if (f.includes('fraunces') || f.includes('georgia') || f.includes('serif')) return 1.05
  if (f.includes('jakarta')) return 1.03
  if (f.includes('space grotesk')) return 0.97
  if (f.includes('archivo')) return 1.01
  if (f.includes('inter')) return 1.0
  return 1.02
}

/** Bold display cuts are wider than their nominal metrics. */
export function weightFactor(weight = 400): number {
  if (weight >= 900) return 1.07
  if (weight >= 800) return 1.045
  if (weight >= 700) return 1.02
  if (weight >= 600) return 1.01
  if (weight <= 300) return 0.97
  return 1
}

function normalizeText(text: string, caps: boolean | undefined): string {
  const t = String(text ?? '')
  return caps ? t.toUpperCase() : t
}

/** Estimated rendered width (px) of a single line of text. */
export function measureText(
  text: string,
  sizePx: number,
  opts: Pick<FitTextOptions, 'family' | 'weight' | 'trackingEm' | 'caps' | 'safety'>
): number {
  const t = normalizeText(text, opts.caps)
  if (!t) return 0
  const safety = opts.safety ?? 1.06
  const tracking = (opts.trackingEm ?? 0) * sizePx
  if (isMonoFamily(opts.family)) {
    // JetBrains Mono advance = 600/1000 em for every glyph, tracking included.
    return t.length * (0.6 * sizePx + tracking) * safety
  }
  let em = 0
  for (const ch of t) em += charEm(ch)
  return (em * sizePx * familyFactor(opts.family) * weightFactor(opts.weight) + tracking * t.length) * safety
}

/** Greedy word wrap; never splits a word unless the word alone exceeds the line. */
export function wrapText(
  text: string,
  maxWidthPx: number,
  sizePx: number,
  opts: Pick<FitTextOptions, 'family' | 'weight' | 'trackingEm' | 'caps' | 'safety'>
): string[] {
  const t = normalizeText(text, opts.caps).trim()
  if (!t) return ['']
  const words = t.split(/\s+/)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (line && measureText(candidate, sizePx, opts) > maxWidthPx) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
    // A single word wider than the line: hard-break it (URLs, compounds).
    while (measureText(line, sizePx, opts) > maxWidthPx && line.length > 1) {
      const hard = breakWord(line, maxWidthPx, sizePx, opts)
      if (!hard) break
      lines.push(hard.head)
      line = hard.tail
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function breakWord(
  word: string,
  maxWidthPx: number,
  sizePx: number,
  opts: Pick<FitTextOptions, 'family' | 'weight' | 'trackingEm' | 'caps' | 'safety'>
): { head: string; tail: string } | null {
  for (let i = word.length - 1; i > 0; i--) {
    const head = word.slice(0, i)
    if (measureText(head, sizePx, opts) <= maxWidthPx) return { head, tail: word.slice(i) }
  }
  return null
}

/**
 * Largest integer font size in [min, nominal] whose wrapped block fits the box.
 * Width is always enforced; height and maxLines when provided. When even `min`
 * does not fit the result reports `overflow: true` (the caller should shorten
 * the copy — the emitter never silently clips a sentence).
 */
export function fitText(text: string, opts: FitTextOptions): TextFit {
  const nominal = Math.max(1, opts.nominal)
  const min = Math.max(1, Math.min(nominal, opts.min ?? Math.max(12, Math.round(nominal * 0.38))))
  const lineHeight = opts.lineHeight ?? 1.15
  const maxWidth = Math.max(40, opts.maxWidth)

  const evaluate = (size: number): { lines: string[]; ok: boolean; height: number } => {
    const lines = wrapText(text, maxWidth, size, opts)
    const height = lines.length * size * lineHeight
    const withinLines = opts.maxLines === undefined || lines.length <= opts.maxLines
    const withinHeight = opts.maxHeight === undefined || height <= opts.maxHeight
    const widest = lines.reduce((m, l) => Math.max(m, measureText(l, size, opts)), 0)
    const withinWidth = widest <= maxWidth + 0.5
    return { lines, ok: withinLines && withinHeight && withinWidth, height }
  }

  // Feasibility is monotonic in size, so binary search the largest fitting size.
  let lo = Math.floor(min)
  let hi = Math.floor(nominal)
  let best: { size: number; lines: string[]; height: number } | null = null
  if (evaluate(hi).ok) {
    return { sizePx: hi, lines: evaluate(hi).lines, heightPx: evaluate(hi).height, fitsNominal: true, overflow: false }
  }
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const res = evaluate(mid)
    if (res.ok) {
      best = { size: mid, lines: res.lines, height: res.height }
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (best) return { sizePx: best.size, lines: best.lines, heightPx: best.height, fitsNominal: false, overflow: false }
  const floor = evaluate(min)
  return { sizePx: min, lines: floor.lines, heightPx: floor.height, fitsNominal: false, overflow: true }
}

/** Single-line variant (mastheads, stat figures): never wraps. */
export function fitOneLine(text: string, opts: FitTextOptions): TextFit {
  return fitText(text, { ...opts, maxLines: 1 })
}
